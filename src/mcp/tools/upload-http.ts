/**
 * Outbound HTTPS for image uploads: the signed-URL PUT (which is NOT an LegendKeeper API call and goes to another
 * host) and the optional fetch of a public image URL.
 *
 * Both use the address policy of chunk 4 (`isPublicAddress`, src/auth/ip.ts) and the same technique as
 * `src/auth/safe-fetch.ts`: the check runs inside the connection's DNS lookup, so the socket connects to an address
 * that was checked and a second resolution cannot swap in a private one.
 *
 * - https only, no URL credentials; private, loopback, link-local, CGNAT and other non-public targets are refused.
 * - `createUploadTransport` is a governor `Transport`: calls to the LK host go to the platform transport, anything
 *   else goes through this guard. The PUT therefore still runs inside `governor.execute` (pacing, retries, upload
 *   tier). A 429 from the storage host is rewritten to `UPLOAD_RATE_EXCEEDED` so the governor applies the upload
 *   tier's reactive backoff (Retry-After honoured).
 * - Nothing here puts a signed URL in a message, an error or a log line.
 *
 * Uses `node:https` rather than `fetch`: `fetch` cannot pin the checked address, and the repository bans `fetch`
 * outside the governor (ADR 0003).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from '../../auth/ip.js';
import type { Transport } from '../../lk/index.js';
import { BridgeLkError } from '../../lk/index.js';

export type UploadHttpFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'bad_status'
  | 'bad_content_type'
  | 'too_large';

/** Never carries the URL. */
export class UploadHttpError extends Error {
  constructor(
    readonly reason: UploadHttpFailure,
    message: string,
  ) {
    super(message);
    this.name = 'UploadHttpError';
  }
}

export interface GuardOptions {
  /** Test seam: replaces DNS resolution. */
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  /** Test seam: extra trusted CA certificates (PEM). */
  readonly ca?: string;
  /** Test seam: accept addresses the public-address policy would refuse. Never set in production. */
  readonly allowAddress?: (address: string) => boolean;
}

function defaultResolve(hostname: string): Promise<readonly LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/** Parses and checks the URL's shape (https, no credentials, a public literal address if it is one). */
export function checkTargetUrl(raw: string, o: GuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UploadHttpError('invalid_url', 'The upload target is not a URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new UploadHttpError('invalid_url', 'Only credential-free https URLs are used');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !addressAllowed(host, o)) {
    throw new UploadHttpError('blocked_address', 'The URL names a private, loopback or link-local address');
  }
  return url;
}

function addressAllowed(address: string, o: GuardOptions): boolean {
  return isPublicAddress(address) || o.allowAddress?.(address) === true;
}

/** Resolves the host now and refuses a non-public answer (an early, advisory check; the connection re-checks). */
export async function assertPublicTarget(raw: string, o: GuardOptions = {}): Promise<URL> {
  const url = checkTargetUrl(raw, o);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return url;
  let addresses: readonly LookupAddress[];
  try {
    addresses = await (o.resolve ?? defaultResolve)(host);
  } catch {
    throw new UploadHttpError('dns', 'The upload host could not be resolved');
  }
  if (addresses.length === 0) throw new UploadHttpError('dns', 'The upload host has no addresses');
  if (!addresses.every((a) => addressAllowed(a.address, o))) {
    throw new UploadHttpError(
      'blocked_address',
      'The host resolves to a private, loopback or link-local address',
    );
  }
  return url;
}

function guardedLookup(o: GuardOptions): LookupFunction {
  const resolve = o.resolve ?? defaultResolve;
  return (hostname, lookupOptions, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new UploadHttpError('dns', 'Host has no addresses'), '', 4);
          return;
        }
        if (!addresses.every((a) => addressAllowed(a.address, o))) {
          callback(new UploadHttpError('blocked_address', 'Host resolves to a non-public address'), '', 4);
          return;
        }
        if (lookupOptions.all) {
          (callback as unknown as (e: null, a: readonly LookupAddress[]) => void)(null, addresses);
        } else {
          const first = addresses[0] as LookupAddress;
          callback(null, first.address, first.family);
        }
      },
      () => callback(new UploadHttpError('dns', 'DNS lookup failed'), '', 4),
    );
  };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export interface RawRequest extends GuardOptions {
  readonly url: URL;
  readonly method: 'GET' | 'PUT';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Deadline for the whole exchange (DNS, connect, TLS, send, body). */
  readonly timeoutMs: number;
  /** The response body is cut off with `too_large` above this many bytes. */
  readonly maxResponseBytes: number;
  /** When set, a response is refused before its body is read unless this accepts its status and headers. */
  readonly accept?: (
    status: number,
    headers: Readonly<Record<string, string | undefined>>,
  ) => UploadHttpError | null;
}

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'expect']);

/** One guarded https exchange. Redirects are returned, never followed. */
export function guardedRequest(r: RawRequest): Promise<RawResponse> {
  return new Promise<RawResponse>((resolvePromise, reject) => {
    if (r.signal?.aborted) {
      reject(r.signal.reason instanceof Error ? r.signal.reason : new UploadHttpError('network', 'Aborted'));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined; // eslint-disable-line prefer-const
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (err: unknown) =>
      done(() => {
        req.destroy();
        reject(err instanceof Error ? err : new UploadHttpError('network', 'The request failed'));
      });
    const onAbort = () => fail(r.signal?.reason ?? new UploadHttpError('network', 'Aborted'));

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers['accept-encoding'] = 'identity';
    if (r.body !== undefined) headers['content-length'] = String(r.body.byteLength);

    const req = request(r.url, {
      method: r.method,
      headers,
      lookup: guardedLookup(r),
      agent: false,
      maxHeaderSize: 16 * 1024,
      ...(r.ca ? { ca: r.ca } : {}),
    });
    timer = setTimeout(
      () => fail(new UploadHttpError('timeout', `No complete response within ${r.timeoutMs} ms`)),
      r.timeoutMs,
    );
    r.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) =>
      fail(err instanceof UploadHttpError ? err : new UploadHttpError('network', 'The request failed')),
    );
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const pick = (name: string): string | undefined => {
        const v = res.headers[name];
        return Array.isArray(v) ? v.join(', ') : v;
      };
      const seen: Record<string, string | undefined> = {};
      for (const name of Object.keys(res.headers)) seen[name] = pick(name);
      const refusal = r.accept?.(status, seen);
      if (refusal) {
        fail(refusal);
        return;
      }
      const declared = Number(res.headers['content-length'] ?? '0');
      if (declared > r.maxResponseBytes) {
        fail(new UploadHttpError('too_large', `The response is larger than ${r.maxResponseBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > r.maxResponseBytes) {
          fail(new UploadHttpError('too_large', `The response is larger than ${r.maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => fail(new UploadHttpError('network', 'The response failed')));
      res.on('end', () => done(() => resolvePromise({ status, headers: seen, body: Buffer.concat(chunks) })));
    });
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });
}

// ------------------------------------------------------------------------------------------------ transport

const NO_BODY = new Set([101, 204, 205, 304]);

function toBytes(body: RequestInit['body']): Uint8Array | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new UploadHttpError('invalid_url', 'Unsupported upload body');
}

export interface UploadTransportOptions extends GuardOptions {
  /** Origin of the LegendKeeper API (e.g. `https://www.legendkeeper.com`): its calls go to `lk`. */
  readonly lkOrigin: string;
  /** The transport for the LegendKeeper host (the governor's default, or a test transport). */
  readonly lk: Transport;
  /** Deadline for one exchange with the storage host. */
  readonly timeoutMs?: number;
}

/**
 * A governor `Transport` that sends the LegendKeeper host through `lk` and every other host (the signed storage
 * URL) through the SSRF guard. A refused target is a non-retryable bridge error that never names the URL.
 */
export function createUploadTransport(o: UploadTransportOptions): Transport {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : input.toString();
    let origin: string | undefined;
    try {
      origin = new URL(raw).origin;
    } catch {
      origin = undefined;
    }
    if (origin !== undefined && origin === o.lkOrigin) return o.lk(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'PUT') {
      throw refused('Only PUT is sent to an upload host');
    }
    let url: URL;
    try {
      url = checkTargetUrl(raw, o);
    } catch (e) {
      throw refused(e instanceof UploadHttpError ? e.message : 'The upload target is not allowed');
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    try {
      const res = await guardedRequest({
        ...o,
        url,
        method: 'PUT',
        headers,
        body: toBytes(init?.body),
        signal: init?.signal ?? undefined,
        timeoutMs: o.timeoutMs ?? 120_000,
        maxResponseBytes: 64 * 1024,
      });
      return toResponse(res);
    } catch (e) {
      if (e instanceof UploadHttpError) {
        if (e.reason === 'blocked_address' || e.reason === 'invalid_url') throw refused(e.message);
        throw e; // a connection or timeout failure: the governor retries it with backoff
      }
      throw e;
    }
  };
}

function refused(message: string): BridgeLkError {
  return new BridgeLkError({
    message: `Upload target refused: ${message}`,
    code: 'UPLOAD_TARGET_REFUSED',
    retryable: false,
    classification: 'bridge',
  });
}

function toResponse(res: RawResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined && !['content-length', 'content-encoding', 'transfer-encoding'].includes(k)) {
      headers.set(k, v);
    }
  }
  if (res.status >= 200 && res.status < 300) {
    return new Response(NO_BODY.has(res.status) ? null : new Uint8Array(res.body), {
      status: res.status,
      headers,
    });
  }
  // A refusal from the storage host: its body (often XML naming the signature, key id and string to sign) is
  // replaced, so nothing derived from the signed URL reaches an error message, the errors table or a tool result.
  headers.set('content-type', 'application/json');
  const requestId = res.headers['x-request-id'] ?? res.headers['x-amz-request-id'] ?? 'upload-host';
  const body =
    res.status === 429
      ? // The storage host is throttling uploads: the upload tier's reactive backoff (Retry-After kept).
        { message: 'The upload host is rate limiting uploads', code: 'UPLOAD_RATE_EXCEEDED', requestId }
      : { message: `The upload host answered HTTP ${res.status}`, requestId };
  return new Response(JSON.stringify(body), { status: res.status, headers });
}

// ------------------------------------------------------------------------------------------------ image source

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** The image type named by the first bytes, or null. LK accepts jpeg, png, gif and webp. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export interface FetchImageOptions extends GuardOptions {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Redirects followed (each hop is checked like the first). Default 3. */
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal | undefined;
}

const IMAGE_CONTENT_TYPE = /^image\/(?:png|jpe?g|gif|webp)$/;

/**
 * Fetches a public https image: every hop passes the address policy, the declared content type must be an image
 * type LK accepts, the size is capped while streaming, and the first bytes must really be that kind of image.
 */
export async function fetchImage(
  rawUrl: string,
  o: FetchImageOptions,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: ImageType }> {
  let url = checkTargetUrl(rawUrl, o);
  const deadline = Date.now() + o.timeoutMs;
  for (let hop = 0; ; hop++) {
    const res = await guardedRequest({
      ...o,
      url,
      method: 'GET',
      headers: {
        accept: 'image/png,image/jpeg,image/gif,image/webp',
        'user-agent': 'LK-Bridge image fetcher',
      },
      timeoutMs: Math.max(1, deadline - Date.now()),
      maxResponseBytes: o.maxBytes,
      signal: o.signal,
      accept: (status, headers) => {
        if (status >= 300 && status < 400) return null; // handled below
        if (status !== 200)
          return new UploadHttpError('bad_status', `The image host answered HTTP ${status}`);
        const type = (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!IMAGE_CONTENT_TYPE.test(type)) {
          return new UploadHttpError(
            'bad_content_type',
            'The URL did not answer with a PNG, JPEG, GIF or WebP image',
          );
        }
        return null;
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location || hop >= (o.maxRedirects ?? 3)) {
        throw new UploadHttpError('redirect', 'Too many redirects, or a redirect without a location');
      }
      try {
        url = checkTargetUrl(new URL(location, url).toString(), o);
      } catch (e) {
        throw e instanceof UploadHttpError
          ? e
          : new UploadHttpError('redirect', 'A redirect led to a bad URL');
      }
      continue;
    }
    const sniffed = sniffImageType(res.body);
    if (!sniffed)
      throw new UploadHttpError(
        'bad_content_type',
        'The downloaded bytes are not a PNG, JPEG, GIF or WebP image',
      );
    return { bytes: new Uint8Array(res.body), contentType: sniffed };
  }
}
