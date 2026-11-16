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

/**
 * v3 F3c (ADR 0051 decision 1): a caller's override of the rule, on every tool that can set the row. `auto` (the
 * default): the rule decides (a major revision sets it); `set`: set it although the rule would not; `skip`: leave it
 * although the rule would set it.
 */
export type LmrMode = 'auto' | 'set' | 'skip';
export const LMR_MODES: readonly LmrMode[] = ['auto', 'set', 'skip'];

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
  /** v3 F3c: the caller's override (absent: `auto`). */
  readonly mode?: LmrMode;
}

export interface LmrPlan {
  /**
   * Appended after the request's own steps; their step numbers continue from them. Empty when the rule (or the caller)
   * decided not to set the row: the plan then only says why (`note`), for the proposal and the answer.
   */
  readonly steps: readonly StepSpec[];
  /** The pages whose `Last Major Revision` is set (their locks are added when the job holds job-level locks). */
  readonly pages: readonly string[];
  /**
   * For the proposal's summary and the answer: `+ Last Major Revision → date of approval (auto: 12 words of page text
   * changed)`, or `Last Major Revision skipped: a trimmed value, not a major revision`.
   */
  readonly note: string;
}

export type LmrPlanner = (input: LmrPlanInput) => LmrPlan | null;
