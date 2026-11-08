/**
 * Policy hooks (prepared for a later chunk; the policy store and the proposal workflow are not built here).
 *
 * The engine asks the `PolicyGate` about EVERY operation, reads included, at entry (`run` and `submit`) and before
 * anything is queued:
 * - `allow`: carry on (the other guards still apply);
 * - `deny`: `PolicyDeniedError`, recorded in the errors table with classification `policy`; nothing is queued;
 * - `propose`: the work is handed to the `ProposalSink` and the caller gets `{ status: 'proposal_captured', proposalId }`.
 * For `batch_ops` every step is evaluated up front: any deny denies the whole batch; otherwise any propose turns the
 * whole batch into one proposal.
 */
import type { OperationDef } from '../lk/registry-types.js';
import { PolicyDeniedError } from './errors.js';
import type {
  JobKind,
  JobOrigin,
  OnError,
  OpParams,
  Principal,
  PriorityClass,
  StepOptions,
} from './types.js';

/** What the gate knows about an operation: the registry metadata plus the step options. */
export interface PolicyOpMeta {
  readonly operationId: string;
  readonly kind: OperationDef['kind'];
  readonly method: OperationDef['method'];
  readonly tag: string;
  readonly risk: OperationDef['risk'];
  readonly concurrency: OperationDef['concurrency'];
  readonly versioned: boolean;
  readonly paged: boolean;
  readonly options: StepOptions;
}

/** Extra context, for gates that care (the origin carries `approvedBy` when the work was approved). */
export interface PolicyContext {
  readonly origin: JobOrigin;
  readonly jobKind: JobKind;
  /** Position of the step in a batch, from 0. */
  readonly stepIndex?: number;
  /**
   * `entry` (default): the work is being accepted (`run` / `submit`). `execute` (chunk 8): a queued job is about to run
   * its next step, and the engine asks again so that a revoked connection or a lowered scope stops it; anything but
   * `allow` then stops the job.
   */
  readonly phase?: 'entry' | 'execute';
}

export type PolicyDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }
  | { readonly decision: 'propose' };

export interface PolicyGate {
  authorize(
    principal: Principal,
    opMeta: PolicyOpMeta,
    params: OpParams,
    ctx: PolicyContext,
  ): PolicyDecision | Promise<PolicyDecision>;
}

export interface ProposedOp extends StepOptions {
  readonly op: string;
  readonly params: OpParams;
}

export interface ProposalMeta {
  readonly kind: JobKind;
  readonly title: string;
  readonly origin: JobOrigin;
  readonly priority: PriorityClass;
  readonly onError?: OnError;
  /** paginate_all caps, when the proposal is a paginate_all job. */
  readonly paginate?: { readonly maxItems?: number; readonly maxPages?: number };
}

export interface ProposalSink {
  capture(
    principal: Principal,
    ops: readonly ProposedOp[],
    meta: ProposalMeta,
  ): Promise<{ proposalId: string; summary?: string }>;
}

/** The default gate: allows everything. */
export const ALLOW_ALL_GATE: PolicyGate = Object.freeze({
  authorize: (): PolicyDecision => ({ decision: 'allow' }),
});

/** The default sink: there is no proposal workflow yet, so "propose" is treated as "deny". */
export const DENY_PROPOSALS_SINK: ProposalSink = Object.freeze({
  capture: (principal: Principal, ops: readonly ProposedOp[]): Promise<{ proposalId: string }> =>
    Promise.reject(
      new PolicyDeniedError(
        ops[0]?.op ?? 'operation',
        'approval is required and no proposal workflow is configured',
        principal.principalId,
      ),
    ),
});

export function policyOpMeta(def: OperationDef, options: StepOptions): PolicyOpMeta {
  return {
    operationId: def.operationId,
    kind: def.kind,
    method: def.method,
    tag: def.tag,
    risk: def.risk,
    concurrency: def.concurrency,
    versioned: def.versioned,
    paged: def.paged,
    options,
  };
}
