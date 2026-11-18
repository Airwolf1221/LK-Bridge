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
  LifecycleMarker,
  OnError,
  OpParams,
  PageScopeEntryShape,
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
  /**
   * v2 D3 (ADR 0041): an `upload_image` job that stages the image (hidden, in the project's staging folder) for a later
   * placement. Set by the engine from bridge code only (`UploadImageSubmit.staging`); never from an agent's input.
   */
  readonly staging?: boolean;
  /**
   * v3 F2 (ADR 0049 decision 10): a batch that places an image staged on the bridge's server (it uploads it into its
   * final folder). Set by the engine from bridge code only (`BatchSubmit.stagedPlacement`). v3 F3.4 (ADR 0055): also a
   * batch that places an image staged in the project's staging folder in LegendKeeper (a move out of it), which the
   * safety rails do not count as an asset move.
   */
  readonly stagedPlacement?: boolean;
}

export type PolicyDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }
  | { readonly decision: 'propose' };

/** v3 F3.4 (ADR 0055): one operation of a request, as the safety rails judge it. */
export interface RailRequestItem {
  readonly opId: string;
  readonly kind: string;
  readonly params: OpParams;
  readonly options: StepOptions;
}

/** v3 F3.4: the safety rails a request met, in words (`proposed because: bulk change (14 pages > 10)`). */
export interface RailDecision {
  readonly reason: string;
  readonly hits: readonly { readonly rail: string; readonly text: string }[];
}

export interface PolicyGate {
  authorize(
    principal: Principal,
    opMeta: PolicyOpMeta,
    params: OpParams,
    ctx: PolicyContext,
  ): PolicyDecision | Promise<PolicyDecision>;
  /**
   * v3 F3.4 (ADR 0055): asked once about a request that would otherwise run directly (the gate allowed every operation
   * and no guard made it a proposal), never about approved work or the bridge's own: the agent profile's safety rails
   * the request meets, or null. A verdict makes the request ONE proposal saying which rail sent it. A rail can only add
   * a proposal.
   */
  rails?(
    principal: Principal,
    items: readonly RailRequestItem[],
    ctx: {
      readonly project: string;
      readonly jobKind: JobKind;
      readonly stagedPlacement?: boolean;
      /** The tool the request came through (`origin.tool`): the low-level tools' removals meet the deletes rail. */
      readonly tool?: string;
    },
  ): RailDecision | null | Promise<RailDecision | null>;
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
  /**
   * v3 F3.4 (ADR 0055): the safety rail that made a direct write at scope `write` a proposal, shown to the owner and
   * returned to the agent.
   */
  readonly rail?: RailDecision;
}

/** v2 C2a: kept with a proposal and used again when the approved batch is submitted. */
export interface ProposalJobOptions {
  readonly holdLock?: { readonly resourceId: string };
  readonly internal?: boolean;
  /** v2 C2c: the second job-level lock (a document of the held page). */
  readonly holdDocument?: { readonly documentId: string };
  readonly holdAlso?: { readonly resourceId: string };
  /** v2 D1: the documents the job holds the locks of (a chronology event's table, timeline and Main table). */
  readonly holdDocuments?: readonly string[];
  /** v2 C2c: the lifecycle change the job makes (bridge code only). */
  readonly lifecycle?: LifecycleMarker;
  /** C2d: further job-level locks (a whole set's pages and documents). */
  readonly holdMore?: { readonly resources?: readonly string[]; readonly documents?: readonly string[] };
  /** C2d (ADR 0036 decision 5): the pages the request touches without naming them, as planned. */
  readonly pageScope?: { readonly subtrees: readonly PageScopeEntryShape[] };
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
   * v3 F2 (ADR 0049 decision 2): added to the summary when the engine appended the `Last Major Revision` steps
   * (`+ Last Major Revision → date of approval`).
   */
  readonly lmrNote?: string;
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
