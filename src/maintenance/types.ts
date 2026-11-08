/** Shared types of the maintenance framework (docs/maintenance.md). */
import type { Db } from '../db/open.js';
import type { JobEngine, OpParams, RunResult } from '../jobs/index.js';
import type { LkClient } from '../lk/index.js';
import type { Schedule } from './schedule.js';

export type RunOutcome = 'succeeded' | 'failed' | 'skipped' | 'interrupted';
export type RunTrigger = 'schedule' | 'manual' | 'catch-up';

/** What a job hands back: a one-line summary for the page, and whether it changed anything worth a job record. */
export interface MaintenanceResult {
  readonly summary: string;
  readonly changed?: boolean;
}

/** What a running job can use. LegendKeeper is reachable only through `run`, which is the engine at P3. */
export interface MaintenanceContext {
  readonly jobId: string;
  readonly trigger: RunTrigger;
  readonly now: number;
  readonly db: Db;
  /** One registry operation through the job engine: priority P3, the `system` principal, an origin naming this job. */
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
  readonly record: RecordPolicy;
  readonly run?: (ctx: MaintenanceContext) => Promise<MaintenanceResult> | MaintenanceResult;
}

export interface MaintenanceDeps {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly lk: LkClient;
}

export interface RunView {
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
  readonly enabled: boolean;
  readonly schedule: Schedule;
  readonly scheduleText: string;
  readonly defaultSchedule: Schedule;
  readonly scheduleOverridden: boolean;
  readonly priority: 'P3';
  readonly running: boolean;
  readonly lastRun: RunView | null;
  readonly nextRunAt: number | null;
  /** Why a not-implemented job cannot be switched on. */
  readonly note: string | null;
}
