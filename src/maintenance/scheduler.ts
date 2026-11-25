/**
 * The maintenance scheduler (docs/maintenance.md). State lives in SQLite (migration 0400), so enabled flags, edited
 * schedules, last runs and next runs survive a restart.
 *
 * - **No backlog.** A job's next run is always computed from "now", never from the slot it missed. After a restart a
 *   job that is overdue runs once (trigger `catch-up`), however many slots passed.
 * - **P3, system principal.** Whatever LegendKeeper work a job does goes through `engine.run` at priority P3 with the
 *   `system` principal and an origin naming the job, so the governor's P3 floor applies. A job that calls LegendKeeper
 *   also waits while P1 or P2 work is queued (the governor already puts P3 behind them; this keeps even the bookkeeping
 *   read-ahead quiet).
 * - **Skips are recorded.** A job that writes to LegendKeeper is skipped, with the reason, under read-only mode or a
 *   writes pause (or while draining); the run history shows it.
 * - **Every run is a P3 job on the Jobs page** when its record policy says so (see `MaintenanceJobDef.record`).
 */
import { loggedTask } from './task-log.js';
import type { Db } from '../db/open.js';
import { SYSTEM_PRINCIPAL, type JobEngine, type JobOrigin, type OpParams } from '../jobs/index.js';
import type { Clock } from '../lk/index.js';
import type { ProjectsRuntime } from '../projects/registry.js';
import type { TimerHandle } from '../lk/governor/clock.js';
import type { MaintenanceSettings } from '../config/maintenance.js';
import { describeSchedule, nextRun, parseSchedule, type Schedule } from './schedule.js';
import { BRIDGE_WIDE, MaintenanceStore, type JobState } from './store.js';
import type {
  MaintenanceContext,
  MaintenanceJobDef,
  MaintenanceJobView,
  RunOutcome,
  RunTrigger,
  ProjectRunLine,
  RunView,
} from './types.js';

export type MaintenanceErrorCode =
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'ALREADY_RUNNING'
  | 'INVALID_SCHEDULE'
  | 'NOT_OWNER'
  /** v2 E5.1: Run now for a project the bridge does not serve now. */
  | 'PROJECT_NOT_SERVED'
  /** v3 F3.5 (ADR 0056): the job's prerequisite for enabling it is missing (`MaintenanceJobDef.canEnable`). */
  | 'PREREQUISITE_MISSING';

export class MaintenanceError extends Error {
  constructor(
    readonly code: MaintenanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

export interface SchedulerOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  /** Every project's governor (P1/P2 queues) and which projects are served (per-project jobs run once for each). */
  readonly projects: ProjectsRuntime;
  readonly clock: Clock;
  readonly settings: MaintenanceSettings;
  readonly jobs: readonly MaintenanceJobDef[];
  /** CR-2026-11-R3 (R3-65): `info` logs each run's start and finish with the memory (task-log.ts). */
  readonly log?: {
    warn(o: Record<string, unknown>, m: string): void;
    info?(o: Record<string, unknown>, m: string): void;
  };
}

export class MaintenanceScheduler {
  private readonly store: MaintenanceStore;
  private readonly defs = new Map<string, MaintenanceJobDef>();
  private readonly running = new Set<string>();
  /**
   * v2 E5.1: the project each running job is working on now (its current target; null for a bridge-wide run). In memory
   * only: a per-project job runs its projects one after another, and the page shows which one is running.
   */
  private readonly runningTarget = new Map<string, string | null>();
  private readonly active = new Set<Promise<unknown>>();
  /** Jobs held back because P1/P2 work was queued: not before this time. */
  private readonly retryAt = new Map<string, number>();
  /** Overdue at start-up: their one run is labelled `catch-up`. */
  private readonly catchUp = new Set<string>();
  /** Background jobs (`def.background`) whose scheduled run is in flight. */
  private readonly inBackground = new Set<string>();
  /** Owner asked for a run now, but it had to wait for P1/P2 work to clear. */
  private readonly manualPending = new Set<string>();
  private timer: TimerHandle | undefined;
  private ticking = false;
  private again = false;
  private started = false;
  private stopped = false;

  constructor(private readonly o: SchedulerOptions) {
    this.store = new MaintenanceStore(o.db);
    for (const d of o.jobs) this.defs.set(d.id, d);
  }

  /** False when MAINTENANCE_ENABLED=false: the registry and pages work, but nothing runs by itself. */
  get enabled(): boolean {
    return this.o.settings.enabled;
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /** Reconciles stored state with the registry, accounts for runs a crash interrupted, and arms the timer. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const now = this.o.clock.now();
    for (const def of this.defs.values()) {
      const wantEnabled = def.implemented && def.defaultEnabled;
      let state = this.store.get(def.id);
      if (!state) {
        this.store.insert(def.id, wantEnabled, wantEnabled ? nextRun(def.defaultSchedule, now) : null, now);
        state = this.store.get(def.id)!;
      }
      // v3 F10 (ADR 0078): a job on its default schedule whose default now comes round sooner (the chronology check,
      // weekly until F10, nightly since) takes the new one at once, not after its old next run.
      if (
        state.enabled &&
        state.schedule === null &&
        state.nextRunAt !== null &&
        state.runningSince === null
      ) {
        const sooner = nextRun(def.defaultSchedule, now);
        if (sooner < state.nextRunAt) {
          this.store.update(def.id, { nextRunAt: sooner }, now);
          state = this.store.get(def.id)!;
        }
      }
      if (state.runningSince !== null) {
        // The process died during a run. Say so; do not run it again as if nothing happened.
        this.store.recordRun(
          {
            projectId: BRIDGE_WIDE,
            jobId: def.id,
            trigger: 'schedule',
            startedAt: state.runningSince,
            finishedAt: now,
            outcome: 'interrupted',
            durationMs: Math.max(0, now - state.runningSince),
            engineJobId: null,
            detail: 'The bridge stopped while this was running.',
          },
          this.o.settings.historyPerJob,
        );
        state = this.store.get(def.id)!;
      }
      if (state.enabled && !def.implemented) {
        this.store.update(def.id, { enabled: false, nextRunAt: null }, now);
        continue;
      }
      if (state.enabled && state.nextRunAt === null) {
        this.store.update(def.id, { nextRunAt: nextRun(this.scheduleOf(def, state), now) }, now);
      } else if (state.enabled && state.nextRunAt !== null && state.nextRunAt <= now) {
        this.catchUp.add(def.id); // overdue: one run, then the schedule carries on from now
      }
    }
    this.arm();
  }

  /**
   * Stops the timer and waits for runs in flight. CR-2026-11-R3 (fix A): `waitMs` bounds the wait (a restart must end
   * within systemd's stop timeout). A run still going then is left as it is: its record keeps `runningSince`, so the
   * next start records it as interrupted ("The bridge stopped while this was running"), as after a crash; the engine
   * jobs it started are parked and continue by themselves.
   */
  async stop(waitMs?: number): Promise<void> {
    this.stopped = true;
    if (this.timer) this.o.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    const all = Promise.allSettled([...this.active]);
    if (waitMs === undefined) {
      await all;
      return;
    }
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((r) => (t = setTimeout(r, Math.max(0, waitMs))))]);
    clearTimeout(t);
  }

  /** Resolves when no run is in flight (tests). */
  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  // ------------------------------------------------------------------------------------------------ reads

  list(): MaintenanceJobView[] {
    return [...this.defs.values()].map((d) => this.view(d));
  }

  get(id: string): MaintenanceJobView {
    return this.view(this.def(id));
  }

  history(id: string, limit = 20, projectId?: string) {
    this.def(id);
    return this.store.history(id, limit, projectId);
  }

  // ---------------------------------------------------------------------------------------------- changes

  setEnabled(id: string, enabled: boolean): MaintenanceJobView {
    const def = this.def(id);
    if (!def.implemented && enabled) throw new MaintenanceError('NOT_IMPLEMENTED', 'Not implemented yet');
    // v3 F3.5 (ADR 0056): a job with a prerequisite (the block-id sweep's sandbox PASS or override) is refused without it.
    const missing = enabled ? (def.canEnable?.() ?? null) : null;
    if (missing !== null) throw new MaintenanceError('PREREQUISITE_MISSING', missing);
    this.ensureRow(def);
    const now = this.o.clock.now();
    const state = this.store.get(id)!;
    this.store.update(
      id,
      {
        enabled,
        nextRunAt: enabled ? nextRun(this.scheduleOf(def, state), now) : null,
      },
      now,
    );
    this.catchUp.delete(id);
    this.retryAt.delete(id);
    this.arm();
    if (enabled) def.onEnabled?.();
    return this.view(def);
  }

  /** `null` restores the default schedule. */
  setSchedule(id: string, schedule: unknown): MaintenanceJobView {
    const def = this.def(id);
    if (!def.implemented) throw new MaintenanceError('NOT_IMPLEMENTED', 'Not implemented yet');
    let parsed: Schedule | null = null;
    if (schedule !== null) {
      try {
        parsed = parseSchedule(schedule);
      } catch (e) {
        throw new MaintenanceError(
          'INVALID_SCHEDULE',
          e instanceof Error ? e.message.replace(/\s+/g, ' ') : 'Invalid schedule',
        );
      }
    }
    this.ensureRow(def);
    const now = this.o.clock.now();
    const state = this.store.get(id)!;
    const effective = parsed ?? def.defaultSchedule;
    this.store.update(
      id,
      { schedule: parsed, ...(state.enabled ? { nextRunAt: nextRun(effective, now) } : {}) },
      now,
    );
    this.catchUp.delete(id);
    this.arm();
    return this.view(def);
  }

  /**
   * Starts a run now. Validates at once (unknown, not implemented, already running, a project not served) and returns;
   * `done` resolves with the run when it finishes (or null if it had to wait for P1/P2 work to clear first).
   *
   * v2 E5.1: `projectId` runs a per-project job for that project only (the dashboard sends the selected project); the
   * job's schedule is left as it was, so the scheduled run still covers every project. A bridge-wide job ignores it.
   * Without it, a per-project job runs for every served project, as before.
   */
  runNow(id: string, projectId?: string): { done: Promise<RunView | null>; projectId: string | null } {
    const def = this.def(id);
    if (!def.implemented || !def.run) throw new MaintenanceError('NOT_IMPLEMENTED', 'Not implemented yet');
    if (this.running.has(id) || this.inBackground.has(id) || this.waitingOne.has(id)) {
      throw new MaintenanceError('ALREADY_RUNNING', `${def.name} is already running`);
    }
    const only = (def.scope ?? 'bridge') === 'project' && projectId !== undefined ? projectId : null;
    if (only !== null && !this.o.projects.activeIds().includes(only)) {
      throw new MaintenanceError(
        'PROJECT_NOT_SERVED',
        `Project ${this.o.projects.nameOf(only)} is not served now, so ${def.name} cannot run for it.`,
      );
    }
    this.ensureRow(def);
    const done = this.track(only !== null ? this.executeFor(def, only) : this.execute(def, 'manual'));
    return { done, projectId: only };
  }

  /** v2 E5.1: per-project jobs waiting to run now for one project (P1/P2 work of that project was queued). */
  private readonly waitingOne = new Set<string>();
  /** Wakes those waits at once when the scheduler stops. */
  private readonly waiters = new Set<() => void>();

  /**
   * A manual run of a per-project job for one project only. P3 yields to that project's P1/P2 work: it waits here
   * (looking again every `deferMs`) rather than through the schedule, so the job's next scheduled run, which covers
   * every project, is not moved.
   */
  private async executeFor(def: MaintenanceJobDef, projectId: string): Promise<RunView | null> {
    this.waitingOne.add(def.id);
    try {
      while (this.busy(def, projectId)) {
        if (this.stopped) return null;
        await new Promise<void>((res) => {
          const wake = () => {
            this.waiters.delete(wake);
            this.o.clock.clearTimeout(t);
            res();
          };
          const t = this.o.clock.setTimeout(wake, this.o.settings.deferMs);
          this.waiters.add(wake);
        });
      }
    } finally {
      this.waitingOne.delete(def.id);
    }
    if (this.stopped) return null;
    return this.executeOne(def, 'manual', { id: projectId, name: this.o.projects.nameOf(projectId) }, false);
  }

  // --------------------------------------------------------------------------------------------- internals

  private def(id: string): MaintenanceJobDef {
    const d = this.defs.get(id);
    if (!d) throw new MaintenanceError('NOT_FOUND', `No maintenance job ${id}`);
    return d;
  }

  private ensureRow(def: MaintenanceJobDef): void {
    if (!this.store.get(def.id)) this.store.insert(def.id, false, null, this.o.clock.now());
  }

  private scheduleOf(def: MaintenanceJobDef, state?: JobState): Schedule {
    return (state ?? this.store.get(def.id))?.schedule ?? def.defaultSchedule;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.active.add(p);
    const done = () => this.active.delete(p);
    p.then(done, done);
    return p;
  }

  private view(def: MaintenanceJobDef): MaintenanceJobView {
    const s = this.store.get(def.id);
    const lastProjectId = s?.lastRunAt != null ? this.store.history(def.id, 1)[0]?.projectId : undefined;
    const schedule = s?.schedule ?? def.defaultSchedule;
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      implemented: def.implemented,
      writes: def.writes,
      scope: def.scope ?? 'bridge',
      enabled: def.implemented && (s?.enabled ?? false),
      schedule,
      scheduleText: describeSchedule(schedule),
      defaultSchedule: def.defaultSchedule,
      scheduleOverridden: s?.schedule != null,
      priority: def.budgetClass ?? 'P3',
      running: this.running.has(def.id) || this.inBackground.has(def.id) || this.waitingOne.has(def.id),
      runningProjectId: this.running.has(def.id) ? (this.runningTarget.get(def.id) ?? null) : null,
      ...((def.scope ?? 'bridge') === 'project' ? { projects: this.projectLines(def) } : {}),
      lastRun:
        s && s.lastRunAt !== null && s.lastOutcome
          ? {
              at: s.lastRunAt,
              outcome: s.lastOutcome,
              durationMs: s.lastDurationMs ?? 0,
              jobId: s.lastJobId,
              detail: s.lastDetail,
              // v2 E5.1: whose run it was (a per-project job's last run is one project's).
              ...(lastProjectId !== undefined ? { projectId: lastProjectId } : {}),
            }
          : null,
      nextRunAt: def.implemented && s?.enabled ? s.nextRunAt : null,
      note: def.implemented ? null : 'Not implemented yet',
    };
  }

  /**
   * v2 E5.1: one line per served project of a per-project job (and any project it last ran for that is no longer
   * served): its own last run, and whether it is the project being run now.
   */
  private projectLines(def: MaintenanceJobDef): ProjectRunLine[] {
    const last = this.store.lastRunsByProject(def.id);
    const ids = [...new Set([...this.o.projects.activeIds(), ...last.keys()])].filter(
      (x) => x !== BRIDGE_WIDE,
    );
    const running = this.running.has(def.id) ? (this.runningTarget.get(def.id) ?? null) : null;
    return ids.map((id) => {
      const r = last.get(id);
      return {
        projectId: id,
        project: this.o.projects.nameOf(id),
        running: running === id,
        lastRun: r
          ? {
              projectId: id,
              at: r.startedAt,
              outcome: r.outcome,
              durationMs: r.durationMs,
              jobId: r.engineJobId,
              detail: r.detail,
              trigger: r.trigger,
            }
          : null,
      };
    });
  }

  /** Sets one timer for the earliest thing due. */
  private arm(): void {
    if (this.timer) this.o.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.stopped || !this.o.settings.enabled) return;
    const now = this.o.clock.now();
    let at = Number.POSITIVE_INFINITY;
    for (const def of this.defs.values()) {
      const s = this.store.get(def.id);
      if (!def.implemented || !s?.enabled || s.nextRunAt === null) continue;
      if (this.inBackground.has(def.id)) continue; // re-armed when it finishes
      at = Math.min(at, Math.max(s.nextRunAt, this.retryAt.get(def.id) ?? 0));
    }
    if (!Number.isFinite(at)) return;
    this.timer = this.o.clock.setTimeout(
      () => {
        this.timer = undefined;
        void this.track(this.tick());
      },
      Math.max(0, at - now),
    );
  }

  /** Runs every job that is due, one after another, then re-arms. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.stopped || !this.o.settings.enabled) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        const now = this.o.clock.now();
        for (const def of this.defs.values()) {
          if (this.stopped) break;
          const s = this.store.get(def.id);
          if (!def.implemented || !s?.enabled || s.nextRunAt === null || s.nextRunAt > now) continue;
          if (this.running.has(def.id) || this.inBackground.has(def.id)) continue;
          if ((this.retryAt.get(def.id) ?? 0) > now) continue;
          const trigger: RunTrigger = this.catchUp.delete(def.id) ? 'catch-up' : 'schedule';
          if (def.background) {
            // v2 A2: a long job (a full pass over a repository tree) runs alongside the others, so the 10-second
            // sampler and the expiry sweep are never held up behind it.
            this.inBackground.add(def.id);
            void this.track(
              this.execute(def, trigger).finally(() => {
                this.inBackground.delete(def.id);
                this.arm();
              }),
            );
            continue;
          }
          await this.execute(def, trigger);
        }
      } while (this.again && !this.stopped);
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  private origin(def: MaintenanceJobDef): JobOrigin {
    return {
      kind: 'maintenance',
      client: 'maintenance',
      tool: def.id,
      detail: def.name,
      principal: SYSTEM_PRINCIPAL,
    };
  }

  /** Why a job that writes (or calls LegendKeeper) must not run now in `projectId` (or bridge-wide), or null. */
  private blockedReason(def: MaintenanceJobDef, projectId: string | null): string | null {
    if (!def.writes && !def.usesLk) return null;
    const c = this.o.engine.queries.controls(projectId ?? undefined);
    if (def.writes) {
      if (c.readOnly) {
        return c.project?.readOnly ? 'Skipped: the project is read-only.' : 'Skipped: read-only mode is on.';
      }
      if (c.writesPaused) return 'Skipped: writes are paused.';
    }
    if (c.draining) return 'Skipped: the bridge is draining.';
    return null;
  }

  /** P3 yields to P1 and P2 work: of its own project, or (bridge-wide) of any project. */
  private busy(def: MaintenanceJobDef, projectId: string | null): boolean {
    if (!def.usesLk) return false;
    const ids = projectId !== null ? [projectId] : this.o.projects.activeIds();
    return ids.some((id) => {
      const q = this.o.projects.anyClient(id)?.governor.snapshot().queues;
      return q !== undefined && q.P1 + q.P2 > 0;
    });
  }

  /** The projects a run covers: every served project for a per-project job, or one bridge-wide run (null). */
  private targets(def: MaintenanceJobDef): ({ id: string; name: string } | null)[] {
    if ((def.scope ?? 'bridge') === 'bridge') return [null];
    return this.o.projects.activeIds().map((id) => ({ id, name: this.o.projects.nameOf(id) }));
  }

  /**
   * One scheduled (or manual) run: bridge-wide, or once per served project for a per-project job (each recorded under
   * its project). Returns the last run's view, or null when it had to wait for P1/P2 work first.
   */
  private async execute(def: MaintenanceJobDef, trigger: RunTrigger): Promise<RunView | null> {
    const targets = this.targets(def);
    if (targets.some((t) => this.busy(def, t?.id ?? null))) return this.defer(def, trigger);
    const trig = this.manualPending.delete(def.id) ? 'manual' : trigger;
    this.retryAt.delete(def.id);
    if (targets.length === 0) {
      return this.finish(
        def,
        trig,
        this.o.clock.now(),
        'skipped',
        'Skipped: no project is served now.',
        null,
        null,
      );
    }
    let last: RunView | null = null;
    for (const t of targets) last = await this.executeOne(def, trig, t);
    return last;
  }

  private defer(def: MaintenanceJobDef, trigger: RunTrigger): null {
    const started = this.o.clock.now();
    // P3 yields to P1 and P2: look again shortly. Not a skip; nothing is recorded until it really runs.
    this.retryAt.set(def.id, started + this.o.settings.deferMs);
    if (trigger === 'manual') {
      this.manualPending.add(def.id);
      this.store.update(def.id, { nextRunAt: started }, started);
    }
    this.arm();
    return null;
  }

  private async executeOne(
    def: MaintenanceJobDef,
    trig: RunTrigger,
    project: { id: string; name: string } | null,
    reschedule = true,
  ): Promise<RunView | null> {
    const { clock } = this.o;
    const id = def.id;
    const started = clock.now();
    const projectId = project?.id ?? null;

    const blocked = this.blockedReason(def, projectId);
    if (blocked) {
      return this.finish(def, trig, started, 'skipped', blocked, null, projectId, reschedule);
    }
    this.running.add(id);
    this.runningTarget.set(id, projectId);
    this.store.update(id, { runningSince: started }, started);
    let outcome: RunOutcome = 'succeeded';
    let detail: string;
    let changed = false;
    try {
      const ctx: MaintenanceContext = {
        jobId: id,
        trigger: trig,
        now: started,
        db: this.o.db,
        project,
        run: (op: string, params: OpParams = {}) => {
          if (project === null) {
            return Promise.reject(
              new Error(`${def.name} is bridge-wide (scope "bridge") and cannot call LegendKeeper`),
            );
          }
          return this.o.engine.run(op, params, {
            project: project.id,
            origin: this.origin(def),
            priority: 'P3',
            title: `Maintenance: ${def.name}`,
          });
        },
      };
      // CR-2026-11-R3 (R3-65): every run's start and finish in the log, with the memory; a job that runs more often than
      // once a minute (the budget sampler) only when memory moved or it failed.
      const sched = this.scheduleOf(def);
      const log = this.o.log;
      const result = await loggedTask(
        log?.info ? { info: (obj, msg) => log.info?.(obj, msg) } : undefined,
        `maintenance:${id}`,
        { trigger: trig, ...(projectId !== null ? { project: projectId } : {}) },
        () => def.run!(ctx),
        { quiet: sched.kind === 'interval' && sched.everySeconds < 60 },
      );
      detail = result.summary;
      changed = result.changed === true;
      if (result.skipped === true) outcome = 'skipped';
    } catch (e) {
      outcome = 'failed';
      detail = e instanceof Error ? e.message : String(e);
    } finally {
      this.running.delete(id);
      this.runningTarget.delete(id);
    }

    let engineJobId: string | null = null;
    // v2 A1: a per-project run is recorded as a job of its project. A bridge-wide run belongs to no project's job list:
    // its record is the run history on the Maintenance page.
    if (
      project !== null &&
      outcome !== 'skipped' &&
      (def.record === 'always' || outcome === 'failed' || changed)
    ) {
      try {
        engineJobId = this.o.engine.recordResult({
          project: project.id,
          opId: `maintenance:${id}`,
          params: {},
          value: { job: id, outcome, summary: detail, trigger: trig },
          origin: this.origin(def),
          title: `Maintenance: ${def.name}`,
          priority: 'P3',
          ...(outcome === 'failed'
            ? { failure: { code: 'MAINTENANCE_FAILED', message: detail ?? 'failed' } }
            : {}),
        }).jobId;
      } catch (e) {
        this.o.log?.warn({ err: e, job: id }, 'could not record a maintenance run as a job');
      }
    }
    return this.finish(def, trig, started, outcome, detail, engineJobId, projectId, reschedule);
  }

  /** Records the run and schedules the next one from now (never from a missed slot). */
  private finish(
    def: MaintenanceJobDef,
    trigger: RunTrigger,
    started: number,
    outcome: RunOutcome,
    detail: string | null,
    engineJobId: string | null,
    projectId: string | null,
    /** False for a manual run of one project (v2 E5.1): the schedule, which covers every project, is left as it was. */
    reschedule = true,
  ): RunView {
    const finished = this.o.clock.now();
    const durationMs = Math.max(0, finished - started);
    this.store.recordRun(
      {
        projectId: projectId ?? BRIDGE_WIDE,
        jobId: def.id,
        trigger,
        startedAt: started,
        finishedAt: finished,
        outcome,
        durationMs,
        engineJobId,
        detail,
      },
      this.o.settings.historyPerJob,
    );
    const state = this.store.get(def.id)!;
    if (state.enabled && reschedule) {
      const sched = this.scheduleOf(def, state);
      let next = nextRun(sched, started);
      if (next <= finished) next = nextRun(sched, finished);
      this.store.update(def.id, { nextRunAt: next }, finished);
    }
    this.arm();
    return {
      projectId: projectId ?? BRIDGE_WIDE,
      at: started,
      outcome,
      durationMs,
      jobId: engineJobId,
      detail,
      trigger,
    };
  }
}
