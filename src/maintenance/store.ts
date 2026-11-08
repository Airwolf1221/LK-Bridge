/** SQLite state of the maintenance scheduler (migration 0400). */
import type { Db } from '../db/open.js';
import { parseSchedule, type Schedule } from './schedule.js';
import type { RunOutcome, RunTrigger } from './types.js';

export interface JobState {
  readonly id: string;
  readonly enabled: boolean;
  readonly schedule: Schedule | null;
  readonly nextRunAt: number | null;
  readonly runningSince: number | null;
  readonly lastRunAt: number | null;
  readonly lastOutcome: RunOutcome | null;
  readonly lastDurationMs: number | null;
  readonly lastJobId: string | null;
  readonly lastDetail: string | null;
}

type Row = Record<string, unknown>;

const toState = (r: Row): JobState => {
  let schedule: Schedule | null = null;
  if (typeof r.schedule === 'string') {
    try {
      schedule = parseSchedule(JSON.parse(r.schedule));
    } catch {
      schedule = null; // a stored schedule that no longer validates falls back to the default
    }
  }
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id as string,
    enabled: r.enabled === 1,
    schedule,
    nextRunAt: num(r.next_run_at),
    runningSince: num(r.running_since),
    lastRunAt: num(r.last_run_at),
    lastOutcome: (r.last_outcome as RunOutcome | null) ?? null,
    lastDurationMs: num(r.last_duration_ms),
    lastJobId: (r.last_job_id as string | null) ?? null,
    lastDetail: (r.last_detail as string | null) ?? null,
  };
};

export interface RunRecord {
  readonly id: number;
  readonly jobId: string;
  readonly trigger: RunTrigger;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly outcome: RunOutcome;
  readonly durationMs: number;
  readonly engineJobId: string | null;
  readonly detail: string | null;
}

export class MaintenanceStore {
  constructor(readonly db: Db) {}

  get(id: string): JobState | undefined {
    const r = this.db.prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? toState(r) : undefined;
  }

  all(): JobState[] {
    return (this.db.prepare('SELECT * FROM maintenance_jobs').all() as Row[]).map(toState);
  }

  insert(id: string, enabled: boolean, nextRunAt: number | null, now: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO maintenance_jobs (id, enabled, next_run_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, enabled ? 1 : 0, nextRunAt, now);
  }

  update(
    id: string,
    patch: {
      enabled?: boolean;
      schedule?: Schedule | null;
      nextRunAt?: number | null;
      runningSince?: number | null;
    },
    now: number,
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now];
    if (patch.enabled !== undefined) (sets.push('enabled = ?'), vals.push(patch.enabled ? 1 : 0));
    if (patch.schedule !== undefined)
      (sets.push('schedule = ?'), vals.push(patch.schedule === null ? null : JSON.stringify(patch.schedule)));
    if (patch.nextRunAt !== undefined) (sets.push('next_run_at = ?'), vals.push(patch.nextRunAt));
    if (patch.runningSince !== undefined) (sets.push('running_since = ?'), vals.push(patch.runningSince));
    this.db.prepare(`UPDATE maintenance_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  /** Records a finished (or skipped, or interrupted) run and makes it the job's last run. */
  recordRun(r: Omit<RunRecord, 'id'>, keep: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO maintenance_runs (job_id, trigger, started_at, finished_at, outcome, duration_ms, engine_job_id, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.jobId, r.trigger, r.startedAt, r.finishedAt, r.outcome, r.durationMs, r.engineJobId, r.detail);
      this.db
        .prepare(
          `UPDATE maintenance_jobs SET last_run_at = ?, last_outcome = ?, last_duration_ms = ?, last_job_id = ?,
             last_detail = ?, running_since = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(r.startedAt, r.outcome, r.durationMs, r.engineJobId, r.detail, r.finishedAt, r.jobId);
      this.db
        .prepare(
          `DELETE FROM maintenance_runs WHERE job_id = ? AND id NOT IN
             (SELECT id FROM maintenance_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?)`,
        )
        .run(r.jobId, r.jobId, keep);
    })();
  }

  history(jobId: string, limit = 20): RunRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM maintenance_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?')
        .all(jobId, limit) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      jobId: r.job_id as string,
      trigger: r.trigger as RunTrigger,
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      outcome: r.outcome as RunOutcome,
      durationMs: Number(r.duration_ms),
      engineJobId: (r.engine_job_id as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
    }));
  }
}
