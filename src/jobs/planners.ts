/**
 * Step planners (v2 C1, ADR 0031): code that re-plans a versioned document write INSIDE the document lock, when the
 * bridge's own compare-and-swap finds that the document changed since the write was planned (PLAN-v2 10.6).
 *
 * A write step names its planner in its options (`replan: { planner, input }`); the engine calls the planner with the
 * document as it is now (the read it makes inside the lock anyway), and the planner either returns the step's new
 * params (built on the current version) or refuses with a `JobsError` (a conflict), in which case nothing is sent. Only
 * bridge code sets `replan`: agents cannot pass step options other than `allowUnsupportedLoss` and `confirm`.
 *
 * Planners are registered by name (`engine.registerPlanner`), because the services they need (the converter's name
 * resolution over the repository tree) are built after the engine. A step whose planner is not registered falls back to
 * the plain conflict. Planners are synchronous: they work on data already read.
 */
import type { OpParams } from './types.js';

export interface ReplanContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly opId: string;
  /** The step's params as planned (with the stale `ifMatch`). */
  readonly params: OpParams;
  /** What the step stored for its planner (`options.replan.input`). */
  readonly input: unknown;
  /** The version the plan was built on (the stale one). */
  readonly plannedVersion: string;
  /** The document as it is now: its version and the read's body. */
  readonly current: { readonly version: string; readonly body: unknown };
}

export type ReplanResult =
  /** Send these params instead (their `ifMatch` must be the current version). */
  | {
      readonly kind: 'replanned';
      readonly params: OpParams;
      /** Recorded in the journal's operation and the step result. */
      readonly note?: Readonly<Record<string, unknown>>;
    }
  /** The re-plan changes nothing: the document already holds the result. Nothing is sent. */
  | { readonly kind: 'unchanged'; readonly note?: Readonly<Record<string, unknown>> };

/** Throws a `JobsError` (normally a `VersionConflictError`) to refuse; nothing is sent then. */
export type StepPlanner = (ctx: ReplanContext) => ReplanResult;

export type StepPlanners = Readonly<Record<string, StepPlanner>>;
