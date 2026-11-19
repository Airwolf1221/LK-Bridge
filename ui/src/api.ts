/**
 * The dashboard's only way to reach the bridge: same-origin JSON requests to `/api/admin`, authenticated by the owner's
 * session cookie. State-changing requests carry the CSRF token the bridge gave this session (`X-CSRF-Token`); the
 * browser adds `Origin` itself. A 401 means the session ended: the page goes to the sign-in page and comes back.
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

async function request<T>(method: string, path: string, body?: unknown, binary?: Blob): Promise<T> {
  try {
    return await send<T>(method, path, body, binary);
  } catch (e) {
    // ADR 0062: any change may need the step-up; ask once, then send it again.
    if (!(e instanceof ApiError && e.code === 'REAUTH_REQUIRED') || !apiConfig.onReauthRequired) throw e;
    await apiConfig.onReauthRequired();
    return send<T>(method, path, body, binary);
  }
}

/** The 401 answers of a check the signed-in owner failed: not a signed-out session. */
const OWNER_CHECK_FAILED: ReadonlySet<string> = new Set(['REAUTH_FAILED', 'WRONG_PASSWORD']);

async function send<T>(method: string, path: string, body?: unknown, binary?: Blob): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
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
      ...(method !== 'GET' ? { body: binary ?? JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
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
  get: <T>(path: string) => request<T>('GET', path),
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
