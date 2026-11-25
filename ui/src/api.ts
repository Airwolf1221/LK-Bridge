/**
 * The dashboard's only way to reach the bridge: same-origin JSON requests to `/api/admin`, authenticated by the owner's
 * session cookie. State-changing requests carry the CSRF token the bridge gave this session (`X-CSRF-Token`); the
 * browser adds `Origin` itself. A 401 means the session ended: the page goes to the sign-in page and comes back.
 * CR-2026-11-R4: what the dashboard sends by itself is marked (`BACKGROUND_HEADER`), so it is not a use of the session.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiConfig {
  /** Prefix for every request (tests point it at a local server). */
  base: string;
  csrfToken: string;
  onUnauthenticated: () => void;
  /**
   * ADR 0062: asks for the step-up (the dialog of `reauth.tsx`, set by its provider); resolves once confirmed, rejects
   * when cancelled. A change answered `403 REAUTH_REQUIRED` is then sent again, once.
   */
  onReauthRequired?: () => Promise<void>;
}

/** The sign-in page, told to bring the owner back to `path` afterwards (the bridge only accepts paths under `/ui`). */
export const signInUrl = (path: string, search: string): string =>
  `/oauth/login?return_to=${encodeURIComponent(`${path}${search}`)}`;

export const apiConfig: ApiConfig = {
  base: '',
  csrfToken: '',
  onUnauthenticated: () => {
    window.location.assign(signInUrl(window.location.pathname, window.location.search));
  },
};

// ------------------------------------------------------------------------------- the dashboard's own requests

/**
 * CR-2026-11-R4 (ADR 0062 decision 1: an idle open tab does not keep the session alive): every request the dashboard
 * sends without the owner's input carries this header, and the bridge then checks the session without counting the
 * request as a use (its end does not move). Those requests are a refresh on a timer, a reload for a live event or for
 * the stream starting afresh, and the session check after the stream drops. The owner's own actions and page loads are
 * uses, as before.
 */
export const BACKGROUND_HEADER = 'x-lkb-background';

/**
 * A request counts as the owner's only this long after the owner's last input (a key, a click or a touch on the page,
 * the browser's back or forward, the page's own load): anything else the dashboard sends is its own.
 */
export const OWNER_INPUT_MS = 60_000;

let backgroundDepth = 0;
let lastOwnerInput = Date.now();

/** Records the owner's input now (the page's listeners call it; so does the page's load, above). */
export function noteOwnerInput(): void {
  lastOwnerInput = Date.now();
}

if (typeof window !== 'undefined')
  for (const type of ['keydown', 'pointerdown', 'touchstart', 'popstate'])
    window.addEventListener(type, noteOwnerInput, { capture: true, passive: true });

/**
 * Runs `fn` as the dashboard's own work (a timer, a live event): every request it sends, and every reload of `useApi`
 * it asks for, is marked with `BACKGROUND_HEADER`.
 */
export function inBackground<T>(fn: () => T): T {
  backgroundDepth++;
  try {
    return fn();
  } finally {
    backgroundDepth--;
  }
}

/** `fn` as the dashboard's own work (`inBackground`), for a timer: `setInterval(background(list.reload), 15_000)`. */
export const background =
  (fn: () => void): (() => void) =>
  () =>
    inBackground(fn);

/** Whether the code running now is the dashboard's own work (inside `inBackground`). */
export const inBackgroundNow = (): boolean => backgroundDepth > 0;

/** Whether a request sent now is the dashboard's own: asked so, inside `inBackground`, or no recent input. */
const isOwn = (asked: boolean): boolean =>
  asked || backgroundDepth > 0 || Date.now() - lastOwnerInput > OWNER_INPUT_MS;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  binary?: Blob,
  own = false,
  signal?: AbortSignal,
): Promise<T> {
  // Decided when the request is made (a request sent from inside `inBackground` keeps its mark through the step-up).
  const mark = isOwn(own);
  try {
    return await send<T>(method, path, body, binary, mark, signal);
  } catch (e) {
    // ADR 0062: any change may need the step-up; ask once, then send it again (the owner has just confirmed it).
    if (!(e instanceof ApiError && e.code === 'REAUTH_REQUIRED') || !apiConfig.onReauthRequired) throw e;
    await apiConfig.onReauthRequired();
    return send<T>(method, path, body, binary, isOwn(false), signal);
  }
}

/** The code of a request its caller aborted (`useApi` on a new path, or the page left): never shown as an error. */
export const ABORTED = 'ABORTED';

const aborted = (): ApiError => new ApiError(0, ABORTED, 'The request was cancelled.');

/**
 * The 25 November 2026 freeze (ADR 0061 amendment 2): at most ONE request in flight per GET endpoint. A GET for a path
 * already being fetched joins that request instead of sending another; each caller may abort its own interest
 * (`signal`), and the request itself is aborted once every caller has. Before, a page polling every few seconds sent a
 * new request each time whatever was still pending, so on 25 November nine `GET /snapshots` piled up, each waiting.
 */
interface Shared {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  callers: number;
}
const inflight = new Map<string, Shared>();

/** How many GETs are in flight now, by path (tests). */
export const inflightPaths = (): string[] => [...inflight.keys()];

function sharedGet<T>(path: string, own: boolean, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted());
  let entry = inflight.get(path);
  if (!entry) {
    const controller = new AbortController();
    const promise = request<T>('GET', path, undefined, undefined, own, controller.signal).finally(() => {
      if (inflight.get(path) === entry) inflight.delete(path);
    });
    // Nobody may be left listening when it settles: never an unhandled rejection.
    promise.catch(() => undefined);
    entry = { promise, controller, callers: 0 };
    inflight.set(path, entry);
  }
  const e = entry;
  e.callers++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      reject(aborted());
      if (--e.callers === 0) {
        if (inflight.get(path) === e) inflight.delete(path);
        e.controller.abort();
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    e.promise.then(
      (v) => {
        if (done) return;
        done = true;
        e.callers--;
        signal?.removeEventListener('abort', onAbort);
        resolve(v as T);
      },
      (err: unknown) => {
        if (done) return;
        done = true;
        e.callers--;
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** The 401 answers of a check the signed-in owner failed: not a signed-out session. */
const OWNER_CHECK_FAILED: ReadonlySet<string> = new Set(['REAUTH_FAILED', 'WRONG_PASSWORD']);

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
  binary?: Blob,
  own = false,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (own) headers[BACKGROUND_HEADER] = '1';
  if (method !== 'GET') {
    // v2 D3: a file is sent as it is (the Staging page's upload), everything else as JSON.
    headers['content-type'] = binary ? 'application/octet-stream' : 'application/json';
    headers['x-csrf-token'] = apiConfig.csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(`${apiConfig.base}/api/admin${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(method !== 'GET' ? { body: binary ?? JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    if (signal?.aborted) throw aborted();
    throw new ApiError(0, 'NETWORK', 'The bridge could not be reached. Check your connection.');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  // A 401 means the session has ended, except a check the signed-in owner failed (a wrong code or password in the
  // step-up, a wrong current password): that stays on the page, with its message (ADR 0062).
  const code401 = (json as { error?: { code?: string } } | undefined)?.error?.code;
  if (res.status === 401 && !(code401 !== undefined && OWNER_CHECK_FAILED.has(code401))) {
    apiConfig.onUnauthenticated();
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    const { code, message, ...extra } = (e ?? {}) as { code?: string; message?: string } & Record<
      string,
      unknown
    >;
    throw new ApiError(res.status, code ?? 'ERROR', message ?? `The request failed (${res.status}).`, extra);
  }
  return json as T;
}

export const api = {
  /**
   * `own`: the dashboard's own request (`BACKGROUND_HEADER`), whatever runs now (`useApi`'s refreshes say so).
   * `signal`: the caller's interest ends (ADR 0061 amendment 2). A GET of a path already in flight joins it.
   */
  get: <T>(path: string, o: { readonly own?: boolean; readonly signal?: AbortSignal } = {}) =>
    sharedGet<T>(path, o.own === true, o.signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  /** v2 D3: POSTs a file as the raw body (`application/octet-stream`), with the CSRF token. */
  upload: <T>(path: string, file: Blob) => request<T>('POST', path, undefined, file),
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** A text field of a submitted form ('' when absent): never `[object File]`. */
export const formText = (f: FormData, name: string): string => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};
