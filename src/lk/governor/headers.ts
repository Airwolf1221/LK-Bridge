/** Parsing of LK's rate headers (PLAN §1.2). */

export interface RateHeaders {
  readonly limit: number;
  readonly remaining: number;
  /** `X-RateLimit-Reset` (Unix seconds) converted to ms. */
  readonly resetAtMs: number;
}

export interface CapturedResponse {
  readonly status: number;
  readonly rate: RateHeaders | null;
  /** `Retry-After` in ms, if present. */
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;
  readonly idempotentReplay: boolean;
  /**
   * The response's `ETag`, unquoted (v2 D1.1, ADR 0039). LegendKeeper sends it on a row write and on a delete that
   * answers 204, where the body carries no version; it is the version for the next chained `If-Match`.
   */
  readonly etag: string | undefined;
}

/** An `ETag` header value as the bare version: weak marker and quotes removed (`"6f78abcf9e74a430"` → `6f78abcf9e74a430`). */
export function parseEtag(headers: Headers): string | undefined {
  const raw = headers.get('etag');
  if (raw === null) return undefined;
  const t = raw
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"(.*)"$/s, '$1')
    .trim();
  return t === '' ? undefined : t;
}

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRateHeaders(headers: Headers): RateHeaders | null {
  const limit = intHeader(headers, 'x-ratelimit-limit');
  const remaining = intHeader(headers, 'x-ratelimit-remaining');
  const reset = intHeader(headers, 'x-ratelimit-reset');
  if (limit === undefined || remaining === undefined || reset === undefined) return null;
  return { limit, remaining: Math.max(0, remaining), resetAtMs: reset * 1000 };
}

/** `Retry-After` as delay-seconds or an HTTP date. */
export function parseRetryAfter(headers: Headers, nowMs: number): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

export function captureResponse(response: Response, nowMs: number): CapturedResponse {
  return {
    status: response.status,
    rate: parseRateHeaders(response.headers),
    retryAfterMs: parseRetryAfter(response.headers, nowMs),
    requestId: response.headers.get('x-request-id') ?? undefined,
    idempotentReplay: response.headers.get('idempotent-replay') === 'true',
    etag: parseEtag(response.headers),
  };
}

/** Statuses LK refuses before counting the request; they carry no rate headers (PLAN §1.2). */
export const UNCOUNTED_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 405]);
