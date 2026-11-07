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
  };
}

/** Statuses LK refuses before counting the request; they carry no rate headers (PLAN §1.2). */
export const UNCOUNTED_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 405]);
