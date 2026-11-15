/** Shared types of the maintenance framework (docs/maintenance.md). */
import type { Db } from '../db/open.js';
import type { JobEngine, OpParams, RunResult } from '../jobs/index.js';
import type { ProjectsRuntime } from '../projects/registry.js';
import type { Schedule } from './schedule.js';

export type RunOutcome = 'succeeded' | 'failed' | 'skipped' | 'interrupted';
export type RunTrigger = 'schedule' | 'manual' | 'catch-up';

/** What a job hands back: a one-line summary for the page, and whether it changed anything worth a job record. */
export interface MaintenanceResult {
  readonly summary: string;
  readonly changed?: boolean;
  /** v2 A2: the run decided not to do its work (for example the project's tree is not configured): recorded as skipped. */
  readonly skipped?: boolean;
}

/** What a running job can use. LegendKeeper is reachable only through `run`, which is the engine at P3. */
export interface MaintenanceContext {
  readonly jobId: string;
  readonly trigger: RunTrigger;
  readonly now: number;
  readonly db: Db;
  /**
   * The project this run works on (v2 A1): a per-project job (`scope: 'project'`) runs once per served project; a
   * bridge-wide job (`scope: 'bridge'`) runs once and gets null.
   */
  readonly project: { readonly id: string; readonly name: string } | null;
  /**
   * One registry operation, in `project`, through the job engine: priority P3, the `system` principal, an origin
   * naming this job. A bridge-wide run has no project and cannot call LegendKeeper (it throws).
   */
  run(op: string, params?: OpParams): Promise<RunResult>;
}

export type RecordPolicy =
  /** Every run is recorded as an engine job (visible on the Jobs page). */
  | 'always'
  /** Only runs that failed or that report `changed` (a job that runs every few seconds or minutes). */
  | 'on-change';

export interface MaintenanceJobDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly defaultSchedule: Schedule;
  readonly defaultEnabled: boolean;
  /** False: a placeholder. It cannot be enabled or run, and its toggle says "Not implemented yet". */
  readonly implemented: boolean;
  /** Writes to LegendKeeper: skipped (and the skip recorded) under read-only mode or a writes pause. */
  readonly writes: boolean;
  /** Calls LegendKeeper: held back while P1 or P2 work is queued, and subject to the governor's P3 floor. */
  readonly usesLk: boolean;
  /**
   * v2 A1. `project`: runs once per served project (anything that touches LegendKeeper or one project's data), each
   * run recorded under its project. `bridge` (the default): one run for the whole bridge (pruning, the budget sampler,
   * SQLite upkeep), recorded as bridge-wide.
   */
  readonly scope?: 'project' | 'bridge';
  readonly record: RecordPolicy;
  /**
   * v2 A2: a long job (minutes: a full pass over a repository tree). Its scheduled runs go alongside the other jobs
   * instead of holding up the scheduler's loop (default false: jobs run one after another).
   */
  readonly background?: boolean;
  readonly run?: (ctx: MaintenanceContext) => Promise<MaintenanceResult> | MaintenanceResult;
}

export interface MaintenanceDeps {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly projects: ProjectsRuntime;
}

export interface RunView {
  /** The project's LegendKeeper id, or `*` for a bridge-wide run (v2 A1). */
  readonly projectId?: string;
  readonly at: number;
  readonly outcome: RunOutcome;
  readonly durationMs: number;
  readonly jobId: string | null;
  readonly detail: string | null;
  readonly trigger?: RunTrigger;
}

export interface MaintenanceJobView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly implemented: boolean;
  readonly writes: boolean;
  /** `project`: one run per served project; `bridge`: one run for the bridge (v2 A1). */
  readonly scope: 'project' | 'bridge';
  readonly enabled: boolean;
  readonly schedule: Schedule;
  readonly scheduleText: string;
  readonly defaultSchedule: Schedule;
  readonly scheduleOverridden: boolean;
  readonly priority: 'P3';
  readonly running: boolean;
  /**
   * v2 E5.1: the project a per-project job is running for now (its current target), or null (not running, waiting, or
   * a bridge-wide run). In memory: the bridge's own record of what it is doing.
   */
  readonly runningProjectId: string | null;
  /** v2 E5.1: a per-project job's state for each project (absent for a bridge-wide job). */
  readonly projects?: readonly ProjectRunLine[];
  /** The newest run of any project (`projectId` says whose). */
  readonly lastRun: RunView | null;
  readonly nextRunAt: number | null;
  /** Why a not-implemented job cannot be switched on. */
  readonly note: string | null;
}

/** v2 E5.1: one project's line of a per-project job on the Maintenance page. */
export interface ProjectRunLine {
  readonly projectId: string;
  /** The project's name. */
  readonly project: string;
  /** This project's pass is the one running now. */
  readonly running: boolean;
  /** This project's newest run, or null. */
  readonly lastRun: RunView | null;
}
