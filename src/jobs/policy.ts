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
  /** v2 A1: the LegendKeeper id of the project the work is for. An approval is valid for its own project only. */
  readonly project: string;
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
  /** v2 A1: the project the work is for; the proposal records it and approval executes against it only. */
  readonly project: string;
  readonly title: string;
  readonly origin: JobOrigin;
  readonly priority: PriorityClass;
  readonly onError?: OnError;
  /** paginate_all caps, when the proposal is a paginate_all job. */
  readonly paginate?: { readonly maxItems?: number; readonly maxPages?: number };
  /** v2 C1: what a high-level tool adds (its operation, a summary, the reads it already made). */
  readonly extras?: ProposalExtras;
  /** v2 C2a: how the approved work is submitted besides its steps (the job-level lock, the bridge's own steps). */
  readonly jobOptions?: ProposalJobOptions;
  /**
   * v2 C2a: the write guard found a protected canonical change: the proposal can only be approved with "Approve and
   * accept as canon". `reason` and `changes` are shown to the owner and returned to the agent.
   */
  readonly canonical?: { readonly reason: string; readonly changes: readonly unknown[] };
}

/** v2 C2a: kept with a proposal and used again when the approved batch is submitted. */
export interface ProposalJobOptions {
  readonly holdLock?: { readonly resourceId: string };
  readonly internal?: boolean;
}

/**
 * v2 C1 (PLAN-v2 10.2): what a high-level tool adds to a proposal, besides the operations it expands to. Set by bridge
 * code only (the tools build it; nothing an agent sends reaches it unchecked).
 */
export interface ProposalExtras {
  /** The high-level operation (for write_page: page, document, mode, section, the Markdown, the page before and after). */
  readonly operation?: Readonly<Record<string, unknown>>;
  /**
   * v2 C2a (PLAN-v2 10.2): the LIST of high-level operations the expansion carries out (for one tool call, normally
   * one; a multi-page tool, several). Each names the `page` it affects (`{ id, name }`) and may give `pageParts`, the
   * plain words of the proposal's page-level summary ("sidebar", "3 facts changed").
   */
  readonly operations?: readonly Readonly<Record<string, unknown>>[];
  /** A one-line summary to show instead of the generic one. */
  readonly summary?: string;
  /**
   * Reads the tool made in this same call, so capture does not repeat them: the target read's operation, path and the
   * body it returned. Used only when the target matches exactly.
   */
  readonly prefetched?: readonly {
    readonly op: string;
    readonly path: Readonly<Record<string, string>>;
    readonly body: unknown;
  }[];
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
