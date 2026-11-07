/**
 * Typed errors of the job engine. `engine.run`, `engine.submit` and the controls throw only `JobsError`
 * subclasses, so callers (MCP tools, the admin API) can branch on `code`. Failures from LegendKeeper itself arrive
 * as `LkOperationError`, which carries the governor's `BridgeLkError` as `lk` (and as `cause`).
 */
import type { BridgeLkError } from '../lk/errors.js';
import type { TierId } from '../lk/registry-types.js';

export type JobsErrorCode =
  | 'UNKNOWN_OPERATION'
  | 'INVALID_PARAMS'
  | 'READ_ONLY'
  | 'MEMBER_ADMIN_DISABLED'
  | 'CASCADE_CONFIRM_REQUIRED'
  | 'DRAINING'
  | 'UNSUPPORTED_BLOCK_LOSS'
  | 'VERSION_CONFLICT'
  | 'UNCERTAIN_OUTCOME'
  | 'LK_ERROR'
  | 'BUDGET_EXHAUSTED'
  | 'JOB_NOT_FOUND'
  | 'INVALID_CONTROL'
  | 'CANCELLED'
  | 'BRIDGE_ERROR';

export interface JobRef {
  readonly jobId?: string | undefined;
  readonly stepNo?: number | undefined;
}

export class JobsError extends Error {
  override readonly name: string = 'JobsError';
  readonly code: JobsErrorCode;
  /** The job that recorded the work, when one exists (writes always; inline reads never). */
  readonly jobId: string | undefined;
  readonly stepNo: number | undefined;

  constructor(code: JobsErrorCode, message: string, ref: JobRef = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.jobId = ref.jobId;
    this.stepNo = ref.stepNo;
  }

  /** Plain JSON for the steps table, the error table and MCP results. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      jobId: this.jobId,
      stepNo: this.stepNo,
    };
  }
}

export class UnknownOperationError extends JobsError {
  override readonly name = 'UnknownOperationError';
  constructor(readonly opId: string) {
    super('UNKNOWN_OPERATION', `Unknown LegendKeeper operation: ${opId}`);
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId };
  }
}

export interface ParamIssue {
  readonly path: string;
  readonly message: string;
}

export class InvalidParamsError extends JobsError {
  override readonly name = 'InvalidParamsError';
  constructor(
    readonly opId: string,
    readonly issues: readonly ParamIssue[],
    message?: string,
  ) {
    super(
      'INVALID_PARAMS',
      message ??
        `Invalid params for ${opId}: ${issues
          .slice(0, 5)
          .map((i) => `${i.path || '(root)'}: ${i.message}`)
          .join('; ')}`,
    );
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId, issues: this.issues };
  }
}

export class ReadOnlyError extends JobsError {
  override readonly name = 'ReadOnlyError';
  constructor(readonly opId: string) {
    super('READ_ONLY', `The bridge is in read-only mode; ${opId} writes and was refused`);
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId };
  }
}

export class MemberAdminDisabledError extends JobsError {
  override readonly name = 'MemberAdminDisabledError';
  constructor(readonly opId: string) {
    super(
      'MEMBER_ADMIN_DISABLED',
      `${opId} changes project members or invites and is disabled (set LK_ALLOW_MEMBER_ADMIN=true to allow it)`,
    );
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId };
  }
}

export class CascadeConfirmationRequiredError extends JobsError {
  override readonly name = 'CascadeConfirmationRequiredError';
  constructor(readonly opId: string) {
    super(
      'CASCADE_CONFIRM_REQUIRED',
      `${opId} with cascade=true deletes every descendant; pass confirm: "cascade" to proceed`,
    );
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId };
  }
}

export class DrainingError extends JobsError {
  override readonly name = 'DrainingError';
  constructor() {
    super(
      'DRAINING',
      'The bridge is draining (finishing running jobs before a restart) and accepts no new jobs',
    );
  }
}

/** PLAN §4 rule 2: the write would delete `unsupported` blocks that the block model cannot express. */
export class UnsupportedBlockLossError extends JobsError {
  override readonly name = 'UnsupportedBlockLossError';
  constructor(
    readonly opId: string,
    readonly blockIds: readonly string[],
    ref: JobRef = {},
  ) {
    super(
      'UNSUPPORTED_BLOCK_LOSS',
      `${opId} would delete ${blockIds.length} unsupported block(s) (${blockIds.slice(0, 10).join(', ')}${
        blockIds.length > 10 ? ', …' : ''
      }). Echo them back by id ({ kind: "unsupported", id }), or pass allowUnsupportedLoss: true to delete them.`,
      ref,
    );
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId, blockIds: this.blockIds };
  }
}

/** PLAN §4 rule 1: the entity changed since the version the write was based on. Never retried blindly. */
export class VersionConflictError extends JobsError {
  override readonly name = 'VersionConflictError';
  constructor(
    readonly opId: string,
    readonly sentVersion: string | null,
    readonly currentVersion: string | null,
    ref: JobRef = {},
    cause?: unknown,
  ) {
    super(
      'VERSION_CONFLICT',
      `${opId}: the entity changed since version ${sentVersion ?? '(unknown)'}${
        currentVersion ? ` (now ${currentVersion})` : ''
      }. Re-read it, reapply your change and send the new version.`,
      ref,
      cause === undefined ? undefined : { cause },
    );
  }
  override toJSON() {
    return {
      ...super.toJSON(),
      opId: this.opId,
      sentVersion: this.sentVersion,
      currentVersion: this.currentVersion,
    };
  }
}

/** The outcome of a sent write could not be established without risking a duplicate. */
export class UncertainOutcomeError extends JobsError {
  override readonly name = 'UncertainOutcomeError';
  constructor(
    readonly opId: string,
    readonly reason: string,
    ref: JobRef = {},
  ) {
    super('UNCERTAIN_OUTCOME', `${opId}: outcome uncertain: ${reason}`, ref);
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId, reason: this.reason, uncertain: true };
  }
}

/** LegendKeeper (or the governor) refused or failed the call. `lk` is the governor's error. */
export class LkOperationError extends JobsError {
  override readonly name = 'LkOperationError';
  readonly lk: BridgeLkError;
  constructor(lk: BridgeLkError, ref: JobRef = {}) {
    super('LK_ERROR', lk.message, ref, { cause: lk });
    this.lk = lk;
  }
  get status() {
    return this.lk.status;
  }
  get lkCode() {
    return this.lk.code;
  }
  get requestId() {
    return this.lk.requestId;
  }
  get classification() {
    return this.lk.classification;
  }
  get retryable() {
    return this.lk.retryable;
  }
  override toJSON() {
    return { ...super.toJSON(), lk: this.lk.toJSON() };
  }
}

/** An inline read could not run before `retryAtMs` (writes park as `waiting_budget` jobs instead). */
export class BudgetExhaustedError extends JobsError {
  override readonly name = 'BudgetExhaustedError';
  constructor(
    readonly opId: string,
    readonly tier: TierId,
    readonly retryAtMs: number,
    cause?: unknown,
  ) {
    super(
      'BUDGET_EXHAUSTED',
      `Rate budget exhausted (${tier}); retry at ${new Date(retryAtMs).toISOString()}`,
      {},
      cause === undefined ? undefined : { cause },
    );
  }
  override toJSON() {
    return { ...super.toJSON(), opId: this.opId, tier: this.tier, retryAtMs: this.retryAtMs };
  }
}

export class JobNotFoundError extends JobsError {
  override readonly name = 'JobNotFoundError';
  constructor(jobId: string) {
    super('JOB_NOT_FOUND', `No job ${jobId}`, { jobId });
  }
}

export class InvalidControlError extends JobsError {
  override readonly name = 'InvalidControlError';
  constructor(message: string, ref: JobRef = {}) {
    super('INVALID_CONTROL', message, ref);
  }
}

export class CancelledError extends JobsError {
  override readonly name = 'CancelledError';
  constructor(ref: JobRef = {}) {
    super('CANCELLED', 'Cancelled', ref);
  }
}

/** Serialises any error for storage (steps.error, jobs.last_error). */
export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof JobsError) return error.toJSON();
  if (error && typeof error === 'object' && 'toJSON' in error && typeof error.toJSON === 'function') {
    return (error as { toJSON(): Record<string, unknown> }).toJSON();
  }
  if (error instanceof Error) return { name: error.name, code: 'BRIDGE_ERROR', message: error.message };
  return { name: 'Error', code: 'BRIDGE_ERROR', message: String(error) };
}
