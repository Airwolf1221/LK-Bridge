/**
 * v3 F2 (ADR 0049 decision 2): the hook through which a substantial edit also sets its page's `Last Major Revision`.
 *
 * The engine asks the registered planner (src/lmr/) about every write request it accepts from a caller (never about
 * approved work, whose token covers exactly the steps the owner saw, and never twice). The planner decides from the
 * request alone (the operations, the origin's tool, the project's switches and the repository tree's sidebar summary:
 * no read) whether the request edits a page's text, and if so returns the steps to append: a `bridge.lmr` decision and
 * the row write it binds. The engine appends them, so the date is set in the same job and the same proposal as the edit.
 */
import type { ProposalExtras } from './policy.js';
import type { JobOrigin, LifecycleMarker, OpParams, StepOptions, StepSpec } from './types.js';

export interface LmrPlanInput {
  readonly project: string;
  readonly origin: JobOrigin;
  readonly jobKind: 'single_op' | 'batch_ops';
  /** The request's own steps, in order (step numbers start at 1). */
  readonly steps: readonly {
    readonly op: string;
    readonly params: OpParams;
    readonly options: StepOptions;
  }[];
  readonly lifecycle?: LifecycleMarker;
  readonly prefetched?: ProposalExtras['prefetched'];
}

export interface LmrPlan {
  /** Appended after the request's own steps; their step numbers continue from them. */
  readonly steps: readonly StepSpec[];
  /** The pages whose `Last Major Revision` is set (their locks are added when the job holds job-level locks). */
  readonly pages: readonly string[];
  /** For the proposal's summary: `+ Last Major Revision → date of approval`. */
  readonly note: string;
}

export type LmrPlanner = (input: LmrPlanInput) => LmrPlan | null;
