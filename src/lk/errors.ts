/**
 * Typed errors for everything that can go wrong talking to LegendKeeper (PLAN §6.3). Every failure leaving
 * `src/lk` is a `BridgeLkError`. Classification branches on LK's `code`, never on `message`; the HTTP status is
 * only a fallback for codes this bridge does not know.
 */
import { ConnectionError, LegendKeeperError } from '@legendkeeper/sdk';
import type { BudgetTierId } from './governor/groups.js';

/**
 * v3 F5a (ADR 0067, H11): `client` is a call the client cancelled (its own abort): not the bridge's fault, recorded as
 * "cancelled by the caller" and left out of the error totals.
 */
export type ErrorClassification =
  | 'user_fixable'
  | 'conflict'
  | 'auth'
  | 'budget'
  | 'upstream'
  | 'bridge'
  | 'client';

/**
 * v3 F5a (ADR 0067, H10): whether the request left the bridge. `no`: refused before anything was sent (validation, the
 * allow-list, a budget wait, a connection that was never made); `yes`: LegendKeeper received it (a response, or a
 * connection that broke after the request was written); `maybe`: the transport was called and failed in a way that does
 * not say. Only `no` may be shown as "refused before it was sent".
 */
export type SentState = 'no' | 'yes' | 'maybe';

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
  /** v3 F5a (H10): the response's headers arrived, then the connection broke or timed out while its body was read. */
  | 'RESPONSE_INTERRUPTED'
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
  /** v3 F5a (H10): whether the request left the bridge (absent: not known, an older error). */
  readonly sent?: SentState | undefined;
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
  readonly sent: SentState | undefined;

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
    this.sent = init.sent;
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
      sent: this.sent,
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
      ...(this.sent !== undefined ? { sent: this.sent } : {}),
    };
  }
}

/**
 * The budget does not allow this call before `retryAtMs`. The job engine parks the step (`waiting_budget`) and
 * resumes it then; MCP shapes it into "budget exhausted, retry at T" for interactive callers.
 */
export class BudgetWaitError extends BridgeLkError {
  override readonly name: string = 'BudgetWaitError';
  /** The documented tier, or a learned operation tier (`group:<name>`, v2 E5.5) that must wait. */
  readonly tier: BudgetTierId;
  readonly retryAtMs: number;

  constructor(init: {
    tier: BudgetTierId;
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

/** CR-2026-11-R3 (fix A): the tier a call refused by a restart names (no real tier: nothing was spent). */
export const RESTART_TIER: BudgetTierId = 'group:restart';

/**
 * CR-2026-11-R3 (fix A, a clean shutdown): a call the bridge did not send because it is restarting (SIGTERM). It would
 * have had to wait (for budget, pacing or a free in-flight slot), and a restart ends every wait at once
 * (`Governor.stopWaits`). It is a `BudgetWaitError` on purpose: every caller already treats one as "parked, nothing
 * lost": a job's step goes back to pending (a write that may have reached LegendKeeper keeps `maybeSent`, so it is
 * verified before anything is re-sent), a check that reads rethrows it rather than judging a page it could not read,
 * and an agent's direct call is answered "not sent, try again". The engine parks the job for the next start
 * (`JobEngine.stopForRestart`).
 */
export class RestartWaitError extends BudgetWaitError {
  override readonly name = 'RestartWaitError';
  constructor(opId: string | undefined, nowMs: number) {
    super({
      tier: RESTART_TIER,
      retryAtMs: nowMs,
      opId,
      message:
        'The bridge is restarting: this LegendKeeper call was not sent (it would have had to wait). Work in progress ' +
        'continues when the bridge is back, in about a minute; a direct call can be made again then.',
    });
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
      {
        // A path given as a list (Zod's own form) is joined, so `["labelSize"]` reads as `labelSize` (v2 E5.4).
        path: typeof path === 'string' ? path : Array.isArray(path) ? path.map(String).join('.') : '',
        message: typeof message === 'string' ? message : '',
      },
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
  /** v3 F5a (H10): the transport was called for this attempt (the request may have left). */
  readonly fetched?: boolean | undefined;
  /** v3 F5a (H10): a response's status and headers arrived (the request certainly left). */
  readonly responded?: boolean | undefined;
}

/** Network codes that mean the connection was never made, so nothing was sent (v3 F5a, H10). */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
]);

/** The error's own code and every cause's, and the names, as far down as they go. */
function causeChain(e: unknown): { codes: string[]; names: string[]; messages: string[] } {
  const codes: string[] = [];
  const names: string[] = [];
  const messages: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === 'object') {
      const o = cur as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
      if (typeof o.code === 'string') codes.push(o.code);
      if (typeof o.name === 'string') names.push(o.name);
      if (typeof o.message === 'string') messages.push(o.message);
      cur = o.cause;
    } else break;
  }
  return { codes, names, messages };
}

/**
 * v3 F5a (ADR 0067, H10): whether a failed attempt's request left the bridge. Never sent when the transport was not
 * called, or the connection was refused or never made; sent when a response arrived; otherwise maybe.
 */
export function sentStateOf(error: unknown, wire: WireFacts): SentState {
  if (wire.fetched !== true) return 'no';
  if (wire.responded === true) return 'yes';
  const chain = causeChain(wire.transportError ?? error);
  if (chain.codes.some((c) => NEVER_CONNECTED.has(c))) return 'no';
  // "terminated", a socket reset, a timeout once connected: the request was written, the reply did not come.
  if (
    chain.codes.some((c) => c === 'ECONNRESET' || c === 'EPIPE' || c.startsWith('UND_ERR_SOCKET')) ||
    chain.messages.some((m) => /\bterminated\b|other side closed|socket hang up/i.test(m))
  )
    return 'yes';
  return 'maybe';
}

/** Whether an error (or its cause) is a timeout's abort (`AbortSignal.timeout`, the governor's own timer). */
function isTimeoutError(e: unknown): boolean {
  const c = causeChain(e);
  return c.names.includes('TimeoutError') || c.messages.some((m) => /aborted due to timeout/i.test(m));
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
  if (wire.aborted) return callerAbortError(opId, error);
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
  // v3 F5a (ADR 0067, H10, H11): the response's headers arrived and reading its body failed: the SDK's own request timer
  // (a body that never finished) or the connection breaking ("terminated", a socket reset). The request was sent, so a
  // write's outcome is unknown; never "unexpected", never the bridge's fault.
  if (wire.responded === true && !(error instanceof ConnectionError)) {
    if (isTimeoutError(error))
      return new BridgeLkError({
        message: 'LegendKeeper request timed out (while its reply was being read)',
        code: 'TIMEOUT',
        retryable: true,
        classification: 'upstream',
        opId,
        cause: error,
      });
    return new BridgeLkError({
      message: `The connection to LegendKeeper broke after the request was sent, while its reply was being read: ${error instanceof Error ? error.message : String(error)}`,
      code: 'RESPONSE_INTERRUPTED',
      retryable: true,
      classification: 'upstream',
      opId,
      cause: error,
    });
  }
  if (isTimeoutError(error))
    return new BridgeLkError({
      message: 'LegendKeeper request timed out',
      code: 'TIMEOUT',
      retryable: true,
      classification: 'upstream',
      opId,
      cause: error,
    });
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

/**
 * v3 F5a (ADR 0067, H11): a call the client cancelled (its own AbortSignal): "cancelled by the caller", classification
 * `client`. Not a bridge error: left out of the error totals.
 */
export function callerAbortError(opId: string | undefined, cause?: unknown): BridgeLkError {
  return new BridgeLkError({
    message: 'Cancelled by the caller: the client ended the call before LegendKeeper answered',
    code: 'ABORTED',
    retryable: false,
    classification: 'client',
    opId,
    cause,
  });
}
