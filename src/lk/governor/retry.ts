/**
 * The retry matrix (PLAN §5.3) as a pure function, so every row is unit-testable without timers or I/O.
 *
 * | Situation                                              | Decision                                           |
 * |--------------------------------------------------------|----------------------------------------------------|
 * | 429 (RATE_LIMITED), wait <= maxShortWaitMs             | retry after the wait, same idempotency key          |
 * | 429, longer wait (or too many short waits)             | budget-wait (caller parks: `BudgetWaitError`)       |
 * | 429 UPLOAD_RATE_EXCEEDED                               | as above; no Retry-After -> reactive doubling backoff |
 * | 502/503/504, timeout, connection on GET/PUT/PATCH/DELETE| exponential backoff, jittered, `maxTransientRetries` |
 * | same on POST                                           | retry only with an Idempotency-Key, else fail (ambiguous) |
 * | 409 IN_PROGRESS                                        | short backoff, same key                             |
 * | 412 after an ambiguous earlier attempt                 | verify (re-read; success if already applied)        |
 * | 404 / 409 ALREADY_DELETED after an ambiguous DELETE    | verify (default: success, it is gone)               |
 * | 409 DUPLICATE_ID after an ambiguous POST               | verify                                              |
 * | 500 INTERNAL, any other 4xx                            | never retry                                         |
 */
import type { RetrySettings } from '../../config/lk.js';
import type { BridgeLkError } from '../errors.js';

export type WireMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RetryState {
  readonly rateLimitRetries: number;
  readonly transientRetries: number;
  readonly inProgressRetries: number;
  readonly uploadBackoffs: number;
  /** An earlier attempt failed in a way that may have applied the write (connection, timeout, 502-504). */
  readonly ambiguousPrior: boolean;
}

export const INITIAL_RETRY_STATE: RetryState = {
  rateLimitRetries: 0,
  transientRetries: 0,
  inProgressRetries: 0,
  uploadBackoffs: 0,
  ambiguousPrior: false,
};

export interface RetryInput {
  readonly error: BridgeLkError;
  /** HTTP method actually sent, if a request went out. */
  readonly method: WireMethod | undefined;
  readonly hasIdempotencyKey: boolean;
  readonly state: RetryState;
  readonly settings: RetrySettings;
  readonly nowMs: number;
  /** Server wait hint: Retry-After, else time to X-RateLimit-Reset (429 only). */
  readonly waitHintMs: number | undefined;
  readonly random?: () => number;
}

export type RetryReason = 'rate-limited' | 'upload-backoff' | 'transient' | 'in-progress';

export type RetryDecision =
  | {
      readonly action: 'retry';
      readonly delayMs: number;
      readonly reason: RetryReason;
      readonly state: RetryState;
    }
  | { readonly action: 'budget-wait'; readonly retryAtMs: number }
  | { readonly action: 'verify' }
  | { readonly action: 'fail'; readonly error: BridgeLkError };

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** Equal-jitter exponential backoff: `exp/2 + random * exp/2`, with `exp = min(cap, base * 2^n)`. */
export function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(exp / 2 + random() * (exp / 2));
}

export function isTransient(error: BridgeLkError): boolean {
  if (error.code === 'CONNECTION_ERROR' || error.code === 'TIMEOUT') return true;
  return error.status !== undefined && TRANSIENT_STATUSES.has(error.status);
}

export function decideRetry(input: RetryInput): RetryDecision {
  const { error, method, state, settings: s, nowMs } = input;
  const random = input.random ?? Math.random;

  if (error.code === 'ABORTED' || error.classification === 'bridge') return { action: 'fail', error };

  // 429: the request was refused, not run, so a retry is safe for every method (PLAN keeps the same key).
  if (error.status === 429 || error.code === 'RATE_LIMITED' || error.code === 'UPLOAD_RATE_EXCEEDED') {
    const upload = error.code === 'UPLOAD_RATE_EXCEEDED';
    const n = upload ? state.uploadBackoffs : state.rateLimitRetries;
    const waitMs = input.waitHintMs ?? Math.min(s.uploadBackoffCapMs, s.uploadBackoffBaseMs * 2 ** n);
    if (waitMs <= s.maxShortWaitMs && state.rateLimitRetries < s.maxRateLimitRetries) {
      return {
        action: 'retry',
        delayMs: waitMs,
        reason: upload ? 'upload-backoff' : 'rate-limited',
        state: {
          ...state,
          rateLimitRetries: state.rateLimitRetries + 1,
          uploadBackoffs: upload ? state.uploadBackoffs + 1 : state.uploadBackoffs,
        },
      };
    }
    return { action: 'budget-wait', retryAtMs: nowMs + waitMs };
  }

  if (error.code === 'IN_PROGRESS') {
    if (state.inProgressRetries < s.maxInProgressRetries) {
      return {
        action: 'retry',
        delayMs: backoffMs(state.inProgressRetries, s.inProgressBaseMs, s.backoffCapMs, random),
        reason: 'in-progress',
        state: { ...state, inProgressRetries: state.inProgressRetries + 1 },
      };
    }
    return { action: 'fail', error };
  }

  if (isTransient(error)) {
    const mayHaveApplied = method !== undefined && method !== 'GET';
    if (method === 'POST' && !input.hasIdempotencyKey) {
      return { action: 'fail', error: error.with({ retryable: false, ambiguous: true }) };
    }
    if (state.transientRetries < s.maxTransientRetries) {
      const hinted =
        input.waitHintMs !== undefined && input.waitHintMs <= s.backoffCapMs ? input.waitHintMs : undefined;
      return {
        action: 'retry',
        delayMs: hinted ?? backoffMs(state.transientRetries, s.backoffBaseMs, s.backoffCapMs, random),
        reason: 'transient',
        state: {
          ...state,
          transientRetries: state.transientRetries + 1,
          ambiguousPrior: state.ambiguousPrior || mayHaveApplied,
        },
      };
    }
    return { action: 'fail', error: mayHaveApplied ? error.with({ ambiguous: true }) : error };
  }

  if (state.ambiguousPrior) {
    if (error.code === 'VERSION_MISMATCH' || error.status === 412) return { action: 'verify' };
    if (method === 'DELETE' && (error.code === 'NOT_FOUND' || error.code === 'ALREADY_DELETED')) {
      return { action: 'verify' };
    }
    if (method === 'POST' && error.code === 'DUPLICATE_ID') return { action: 'verify' };
  }

  return { action: 'fail', error: error.retryable ? error.with({ retryable: false }) : error };
}
