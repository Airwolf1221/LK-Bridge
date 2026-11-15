/**
 * Typed errors for everything that can go wrong talking to LegendKeeper (PLAN §6.3). Every failure leaving
 * `src/lk` is a `BridgeLkError`. Classification branches on LK's `code`, never on `message`; the HTTP status is
 * only a fallback for codes this bridge does not know.
 */
import { ConnectionError, LegendKeeperError } from '@legendkeeper/sdk';
import type { TierId } from './registry-types.js';

export type ErrorClassification = 'user_fixable' | 'conflict' | 'auth' | 'budget' | 'upstream' | 'bridge';

export interface LkErrorIssue {
  readonly path: string;
  readonly message: string;
}

/** Bridge-side codes for failures that have no LK `code`. */
export type BridgeErrorCode =
  | 'CONNECTION_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'GOVERNOR_BYPASS'
  | 'ONE_REQUEST_PER_CALL'
  | 'IF_MATCH_REQUIRED'
  | 'INVALID_REQUEST'
  | 'OPERATION_NOT_ALLOWED'
  | 'BUDGET_WAIT'
  | 'UNEXPECTED';

export interface BridgeLkErrorInit {
  readonly message: string;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
  readonly errors?: readonly LkErrorIssue[] | undefined;
  readonly retryable: boolean;
  readonly classification: ErrorClassification;
  readonly opId?: string | undefined;
  /** Set when a POST failed in a way that leaves it unknown whether LK applied it. */
  readonly ambiguous?: boolean | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly attempts?: number | undefined;
  readonly cause?: unknown;
}

export class BridgeLkError extends Error {
  override readonly name: string = 'BridgeLkError';
  readonly status: number | undefined;
  /** LK's error `code` (see `LK_ERROR_CODES`), or a `BridgeErrorCode`. */
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly errors: readonly LkErrorIssue[];
  readonly retryable: boolean;
  readonly classification: ErrorClassification;
  readonly opId: string | undefined;
  readonly ambiguous: boolean;
  readonly retryAfterMs: number | undefined;
  readonly attempts: number | undefined;

  constructor(init: BridgeLkErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.errors = init.errors ?? [];
    this.retryable = init.retryable;
    this.classification = init.classification;
    this.opId = init.opId;
    this.ambiguous = init.ambiguous ?? false;
    this.retryAfterMs = init.retryAfterMs;
    this.attempts = init.attempts;
  }

  /** A copy with some fields replaced (errors are immutable once thrown). */
  with(patch: Partial<BridgeLkErrorInit>): BridgeLkError {
    return new BridgeLkError({ ...this.toInit(), ...patch });
  }

  toInit(): BridgeLkErrorInit {
    return {
      message: this.message,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      errors: this.errors,
      retryable: this.retryable,
      classification: this.classification,
      opId: this.opId,
      ambiguous: this.ambiguous,
      retryAfterMs: this.retryAfterMs,
      attempts: this.attempts,
      cause: this.cause,
    };
  }

  /** Plain JSON for logs, the error table and MCP results. Never includes request bodies or credentials. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      errors: this.errors,
      retryable: this.retryable,
      classification: this.classification,
      opId: this.opId,
      ambiguous: this.ambiguous,
      retryAfterMs: this.retryAfterMs,
      attempts: this.attempts,
    };
  }
}

/**
 * The budget does not allow this call before `retryAtMs`. The job engine parks the step (`waiting_budget`) and
 * resumes it then; MCP shapes it into "budget exhausted, retry at T" for interactive callers.
 */
export class BudgetWaitError extends BridgeLkError {
  override readonly name = 'BudgetWaitError';
  readonly tier: TierId;
  readonly retryAtMs: number;

  constructor(init: {
    tier: TierId;
    retryAtMs: number;
    opId?: string | undefined;
    message?: string;
    cause?: BridgeLkError;
  }) {
    const at = Number.isFinite(init.retryAtMs) ? new Date(init.retryAtMs).toISOString() : 'never';
    super({
      message: init.message ?? `Rate budget for tier ${init.tier} is exhausted; retry at ${at}`,
      status: init.cause?.status,
      code: init.cause?.code ?? 'BUDGET_WAIT',
      requestId: init.cause?.requestId,
      retryable: Number.isFinite(init.retryAtMs),
      classification: 'budget',
      opId: init.opId,
      cause: init.cause,
    });
    this.tier = init.tier;
    this.retryAtMs = init.retryAtMs;
  }
}

/** Every code in LK's closed error catalogue (spec `ErrorCode`), with its classification. */
export const LK_ERROR_CODES = {
  VALIDATION_ERROR: 'user_fixable',
  INVALID_CONTENT: 'user_fixable',
  UNSUPPORTED_KIND: 'user_fixable',
  KIND_MISMATCH: 'user_fixable',
  UNAUTHENTICATED: 'auth',
  SUBSCRIPTION_LAPSED: 'auth',
  PAID_PLAN_REQUIRED: 'auth',
  FORBIDDEN: 'auth',
  WRONG_PROJECT: 'auth',
  INSUFFICIENT_SCOPE: 'auth',
  FEATURE_UNAVAILABLE: 'auth',
  NOT_FOUND: 'user_fixable',
  METHOD_NOT_ALLOWED: 'user_fixable',
  DUPLICATE_ID: 'conflict',
  AMBIGUOUS: 'conflict',
  ALREADY_DELETED: 'conflict',
  HAS_CHILDREN: 'conflict',
  NOT_DELETED: 'conflict',
  PARENT_DELETED: 'conflict',
  IN_PROGRESS: 'conflict',
  IDEMPOTENCY_KEY_REUSED: 'conflict',
  TOO_MANY_PENDING_INVITES: 'conflict',
  VERSION_MISMATCH: 'conflict',
  DOCUMENT_TOO_LARGE: 'user_fixable',
  PAYLOAD_TOO_LARGE: 'user_fixable',
  STORAGE_QUOTA_EXCEEDED: 'user_fixable',
  RATE_LIMITED: 'budget',
  UPLOAD_RATE_EXCEEDED: 'budget',
  INTERNAL: 'upstream',
} as const satisfies Record<string, ErrorClassification>;

export type LkErrorCode = keyof typeof LK_ERROR_CODES;

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

function isKnownCode(code: string | undefined): code is LkErrorCode {
  return code !== undefined && Object.hasOwn(LK_ERROR_CODES, code);
}

/** Classification for a status with no recognised code (PLAN §6.3 grouping). */
export function classifyStatus(status: number | undefined): ErrorClassification {
  if (status === undefined) return 'upstream';
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 429) return 'budget';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'user_fixable';
  return 'bridge';
}

export function classify(code: string | undefined, status: number | undefined): ErrorClassification {
  return isKnownCode(code) ? LK_ERROR_CODES[code] : classifyStatus(status);
}

/**
 * Whether the retry matrix (PLAN §5.3) would retry this failure in principle. The governor can still refuse
 * (e.g. a POST without an idempotency key), and then reports `retryable: false`.
 */
export function isRetryableFailure(code: string | undefined, status: number | undefined): boolean {
  if (code === 'RATE_LIMITED' || code === 'UPLOAD_RATE_EXCEEDED' || status === 429) return true;
  if (code === 'IN_PROGRESS') return true;
  if (code === 'CONNECTION_ERROR' || code === 'TIMEOUT') return true;
  // 502/503/504 are transient whatever the body says (gateways send none); 500 INTERNAL never is.
  return status !== undefined && TRANSIENT_STATUSES.has(status);
}

function asIssues(value: unknown): LkErrorIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v: unknown) => {
    if (typeof v !== 'object' || v === null) return [];
    const { path, message } = v as { path?: unknown; message?: unknown };
    return [
      { path: typeof path === 'string' ? path : '', message: typeof message === 'string' ? message : '' },
    ];
  });
}

export interface LkErrorBody {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly requestId?: unknown;
  readonly errors?: unknown;
}

/** Maps an LK HTTP error (status + parsed body + headers) to a `BridgeLkError`. */
export function fromLkResponse(init: {
  status: number;
  body?: LkErrorBody | undefined;
  requestId?: string | undefined;
  retryAfterMs?: number | undefined;
  opId?: string | undefined;
  cause?: unknown;
}): BridgeLkError {
  const body = init.body ?? {};
  const code = typeof body.code === 'string' ? body.code : undefined;
  const bodyRequestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  const message =
    typeof body.message === 'string' && body.message
      ? body.message
      : `LegendKeeper request failed with status ${init.status}`;
  return new BridgeLkError({
    message,
    status: init.status,
    code,
    requestId: init.requestId ?? bodyRequestId,
    errors: asIssues(body.errors),
    retryable: isRetryableFailure(code, init.status),
    classification: classify(code, init.status),
    opId: init.opId,
    retryAfterMs: init.retryAfterMs,
    cause: init.cause,
  });
}

/** Extra facts the governor captured on the wire, which the SDK error alone may lack. */
export interface WireFacts {
  readonly status?: number | undefined;
  readonly body?: LkErrorBody | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly timedOut?: boolean | undefined;
  readonly aborted?: boolean | undefined;
  readonly transportError?: unknown;
}

/**
 * Converts anything thrown while calling LK into a `BridgeLkError`. Prefers the raw body the governor captured
 * (so unknown codes survive), then the SDK error's fields.
 */
export function toBridgeLkError(error: unknown, opId?: string, wire: WireFacts = {}): BridgeLkError {
  if (error instanceof BridgeLkError) return error.opId || !opId ? error : error.with({ opId });
  // The SDK wraps anything its fetch throws (including the governor's own guards) in ConnectionError.
  if (error instanceof Error && error.cause instanceof BridgeLkError)
    return toBridgeLkError(error.cause, opId);
  if (wire.aborted) {
    return new BridgeLkError({
      message: 'LegendKeeper call aborted by the caller',
      code: 'ABORTED',
      retryable: false,
      classification: 'bridge',
      opId,
      cause: error,
    });
  }
  if (wire.timedOut) {
    return new BridgeLkError({
      message: 'LegendKeeper request timed out',
      code: 'TIMEOUT',
      retryable: true,
      classification: 'upstream',
      opId,
      cause: error,
    });
  }
  if (error instanceof LegendKeeperError) {
    const body: LkErrorBody = wire.body ?? {
      message: error.message,
      code: error.code,
      requestId: error.requestId,
      errors: error.errors,
    };
    return fromLkResponse({
      status: error.status,
      body,
      requestId: wire.requestId ?? error.requestId,
      retryAfterMs:
        wire.retryAfterMs ?? ('retryAfterMs' in error ? (error.retryAfterMs as number) : undefined),
      opId,
      cause: error,
    });
  }
  if (wire.status !== undefined && wire.status >= 400) {
    return fromLkResponse({ ...wire, status: wire.status, opId, cause: error });
  }
  if (error instanceof ConnectionError || wire.transportError !== undefined) {
    return new BridgeLkError({
      message: `Could not reach LegendKeeper: ${error instanceof Error ? error.message : String(error)}`,
      code: 'CONNECTION_ERROR',
      retryable: true,
      classification: 'upstream',
      opId,
      cause: error,
    });
  }
  return new BridgeLkError({
    message: `Unexpected error in LegendKeeper call: ${error instanceof Error ? error.message : String(error)}`,
    code: 'UNEXPECTED',
    retryable: false,
    classification: 'bridge',
    opId,
    cause: error,
  });
}
