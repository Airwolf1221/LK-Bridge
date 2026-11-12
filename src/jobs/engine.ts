/**
 * The job engine (PLAN §6): everything that talks to LegendKeeper runs as a persisted step, through the governor,
 * with writer slots, locks, guards and the write journal. See src/jobs/README.md for the interface.
 */
import { randomBytes } from 'node:crypto';
import { WRITERS_LIMIT, WRITERS_MIN, type JobsSettings } from '../config/jobs.js';
import type { Db } from '../db/open.js';
import type { LkClient } from '../lk/client.js';
import type { ProjectsRuntime } from '../projects/registry.js';
import type { ProjectScope } from '../projects/types.js';
import { BridgeLkError, BudgetWaitError } from '../lk/errors.js';
import { systemClock, type Clock, type TimerHandle } from '../lk/governor/clock.js';
import type { BudgetSnapshot } from '../lk/governor/types.js';
import { getOperation, operationInputSchema } from '../lk/registry.js';
import type { OperationDef } from '../lk/registry-types.js';
import {
  BudgetExhaustedError,
  CancelledError,
  DrainingError,
  InvalidControlError,
  InvalidParamsError,
  JobNotFoundError,
  JobsError,
  LkOperationError,
  PolicyDeniedError,
  ProjectUnavailableError,
  UncertainOutcomeError,
  UnknownProjectError,
  UnknownOperationError,
  UnsupportedBlockLossError,
  VersionConflictError,
  errorToJson,
} from './errors.js';
import { JobEventEmitter } from './events.js';
import { UPLOAD_PUT_STEP, UPLOAD_VERIFY_STEP, type CustomStepHandlers } from './custom-steps.js';
import { checkSubmitGuards, isWriteOp } from './guards.js';
import { isClientId, mintClientId, newJobId } from './ids.js';
import { WriteJournal, journalLookup, type JournalFilter } from './journal.js';
import { callOp, isNotFound, newCallStats } from './lk-call.js';
import { LockManager } from './locks.js';
import { opMeta } from './op-meta.js';
import {
  EXPECT_STEP,
  internalPolicyMeta,
  internalReads,
  internalStepIssues,
  isInternalStep,
  type DocumentChecker,
  type MapChecker,
} from './internal-steps.js';
import type { WriteGuard } from './write-guard.js';
import {
  ALLOW_ALL_GATE,
  DENY_PROPOSALS_SINK,
  policyOpMeta,
  type PolicyDecision,
  type PolicyGate,
  type PolicyOpMeta,
  type ProposalJobOptions,
  type ProposalMeta,
  type ProposalSink,
  type ProposedOp,
} from './policy.js';
import { createJobQueries, JobsRepo, type ErrorInput, type NewStep } from './repo.js';
import {
  StepExecutor,
  lockKeyFor,
  projectLockKey,
  type StepOutcome,
  type WriteHold,
  type WriteVerification,
  type RecordHandler,
  type AssetDeleteKeeper,
} from './step-exec.js';
import type { StepPlanner, StepPlanners } from './planners.js';
import {
  SYSTEM_PRINCIPAL,
  TERMINAL_JOB_STATUSES,
  type BatchSubmit,
  type ControlsView,
  type InternalReadOptions,
  type WriteObserver,
  type WriteStepInfo,
  type JobKind,
  type JobOrigin,
  type LifecycleMarker,
  type JobStatus,
  type JobView,
  type LockView,
  type OnError,
  type OpParams,
  type PaginateSubmit,
  type PriorityClass,
  type Principal,
  type ProposalCaptured,
  type RunOptions,
  type RunResult,
  type StepOptions,
  type StepSpec,
  type StepView,
  type SubmitRequest,
  type SubmitResult,
  type UploadImageSubmit,
  type WritersView,
} from './types.js';
import { WriterPool, clampWriters } from './writers.js';
import { idempotencyKeyFor } from '../lk/idempotency.js';

export interface EngineLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CreateJobEngineOptions {
  readonly db: Db;
  /**
   * The projects this engine serves (v2 A1): each has its own LK client and governor. Every operation names its
   * project; a project that is not served now refuses new work and holds its queued jobs until it is back.
   */
  readonly projects: ProjectsRuntime;
  readonly settings: JobsSettings;
  readonly clock?: Clock;
  readonly log?: EngineLogger;
  /** Start scheduling (and restart-resume) at once. Default true. */
  readonly autoStart?: boolean;
  /** Asked about every operation at entry (default: allow everything). See policy.ts. */
  readonly policyGate?: PolicyGate;
  /** Receives work the gate wants approved (default: treats "propose" as "deny"). */
  readonly proposalSink?: ProposalSink;
  /** Non-registry step types, by step id (`upload_image.put`, supplied by the MCP tools). */
  readonly customSteps?: CustomStepHandlers;
  /** v2 C1: in-lock planners by name (src/jobs/planners.ts); more can be added with `registerPlanner`. */
  readonly planners?: StepPlanners;
  /** v2 C2a: the write guard (the protected canonical facts); can also be set later with `setWriteGuard`. */
  readonly writeGuard?: WriteGuard;
  /**
   * v2 D1.1 (ADR 0039): whether a project uses a write's `ETag` as the write's new version for the next chained
   * If-Match (the project setting `useEtagVersions`, default on). Absent: on.
   */
  readonly etagVersions?: (projectId: string) => boolean;
}

const SETTING = {
  writersMax: 'jobs.writers_max',
  readOnly: 'jobs.read_only_override',
  writesPaused: 'jobs.writes_paused',
} as const;

const silentLog: EngineLogger = { warn: () => {}, error: () => {} };

interface Active {
  current: AbortController;
  readonly done: Promise<RunnerResult>;
}

interface RunnerResult {
  readonly last: StepOutcome | undefined;
  /** Values of every step that succeeded in this run, in order. */
  readonly values?: readonly unknown[];
}

interface PreparedStep {
  readonly def: OperationDef | null;
  readonly step: NewStep;
}

/** One operation put to the policy gate and the write guard (a registry operation, or one of the bridge's own steps). */
interface AuthItem {
  readonly opId: string;
  readonly def: OperationDef | null;
  readonly meta: PolicyOpMeta;
  readonly params: OpParams;
  readonly options: StepOptions;
}

const authItem = (def: OperationDef, params: OpParams, options: StepOptions): AuthItem => ({
  opId: def.operationId,
  def,
  meta: policyOpMeta(def, options),
  params,
  options,
});

/** A job-level lock (`BatchSubmit.holdLock`), stored in the job's options. */
const HELD_LOCK = 'heldLock';
/**
 * v2 C2c: the further job-level locks (`BatchSubmit.holdDocument`, `holdAlso`), stored with `heldLock` as one list. A job
 * holding several takes them in sorted key order, so two such jobs can never wait on each other.
 */
const HELD_MORE = 'heldMore';
/** v2 C2c: the lifecycle marker (`BatchSubmit.lifecycle`), stored in the job's options for the guard inside the lock. */
export const LIFECYCLE_OPTION = 'lifecycle';

export class JobEngine {
  readonly events = new JobEventEmitter();
  readonly locks: LockManager;
  readonly writers: WriterPool;
  readonly journal: WriteJournal;
  private readonly repo: JobsRepo;
  private readonly executor: StepExecutor;
  private readonly clock: Clock;
  private readonly log: EngineLogger;
  private readonly settings: JobsSettings;
  private readonly projects: ProjectsRuntime;
  private readonly db: Db;
  private readonly offProjects: () => void;
  private readonly policyGate: PolicyGate;
  private readonly proposalSink: ProposalSink;
  private readonly active = new Map<string, Active>();
  private readonly resumeTimers = new Map<string, TimerHandle>();
  private readonly waitingLock = new Set<string>();
  private readonly drainWaiters: (() => void)[] = [];
  /** Pending `wait` calls; `stop()` answers them at once (chunk 8, F-13), so a shutdown never waits for a long poll. */
  private readonly jobWaiters = new Set<() => void>();
  /** v2 A2: told about every write step (the repository tree). */
  private readonly writeObservers = new Set<WriteObserver>();
  /** v2 C1: in-lock planners (write_page's section re-plan), by name. */
  private readonly planners = new Map<string, StepPlanner>();
  /** v2 C2a: the write guard (protected canonical facts), asked at entry and inside the lock. */
  private writeGuard: WriteGuard | undefined;
  private assetDeleteKeeper: AssetDeleteKeeper | undefined;
  /** v2 C2c: the lifecycle record's handler (`bridge.record` steps). */
  /** v2 C2c: the `bridge.record` handlers by store (`lifecycle`; v2 D1 `chronology`). */
  private readonly recordHandlers = new Map<string, RecordHandler>();
  /** v2 D1: the document checkers of `bridge.expect` (`kind: 'document'`), by name. */
  private readonly checkers = new Map<string, DocumentChecker>();
  /** v2 D2: the map checkers of `bridge.expect` (`kind: 'map'`) and `bridge.verify` (`kind: 'mapChecked'`), by name. */
  private readonly mapCheckers = new Map<string, MapChecker>();
  private readonly etagVersions: ((projectId: string) => boolean) | undefined;
  private readOnlyOverride: boolean | null;
  private writesPaused: boolean;
  private draining = false;
  private started = false;
  private stopped = false;
  private pumpQueued = false;
  readonly queries;

  constructor(o: CreateJobEngineOptions) {
    this.db = o.db;
    this.projects = o.projects;
    this.settings = o.settings;
    this.clock = o.clock ?? systemClock;
    this.log = o.log ?? silentLog;
    this.policyGate = o.policyGate ?? ALLOW_ALL_GATE;
    this.proposalSink = o.proposalSink ?? DENY_PROPOSALS_SINK;
    const now = () => this.clock.now();
    this.repo = new JobsRepo(o.db, now, o.settings.largeParamsBytes);
    this.journal = new WriteJournal(o.db, now);
    this.readOnlyOverride = this.repo.getSetting<boolean>(SETTING.readOnly) ?? null;
    this.writesPaused = this.repo.getSetting<boolean>(SETTING.writesPaused) === true;
    const savedMax = this.repo.getSetting<number>(SETTING.writersMax);
    const max =
      typeof savedMax === 'number' && savedMax >= WRITERS_MIN && savedMax <= WRITERS_LIMIT
        ? savedMax
        : o.settings.writersMax;
    this.locks = new LockManager(now, (e) => this.events.emit('lock', e));
    this.writers = new WriterPool(max, now, (v) => this.events.emit('writers', v));
    this.executor = new StepExecutor({
      lkFor: (projectId) => this.projects.client(projectId),
      repo: this.repo,
      journal: this.journal,
      locks: this.locks,
      writers: this.writers,
      settings: o.settings,
      now,
      recordLkError: (err, ref) => this.recordLkError(err, ref),
      setJobWaiting: (jobId, waiting, detail) => this.setWaitingLock(jobId, waiting, detail),
      writeHold: (projectId) => this.writeHold(projectId),
      customSteps: o.customSteps,
      planner: (name) => this.planners.get(name),
      recordVerifyMismatch: (job, step, v) => this.recordVerifyMismatch(job, step, v),
      writeGuard: () => this.writeGuard,
      recordHandler: (store) => this.recordHandlers.get(store),
      checker: (name) => this.checkers.get(name),
      mapChecker: (name) => this.mapCheckers.get(name),
      ...(o.etagVersions ? { etagVersions: o.etagVersions } : {}),
      assetDeleteKeeper: () => this.assetDeleteKeeper,
    });
    this.etagVersions = o.etagVersions;
    for (const [name, fn] of Object.entries(o.planners ?? {})) this.planners.set(name, fn);
    this.writeGuard = o.writeGuard;
    const base = createJobQueries(o.db);
    this.queries = {
      ...base,
      resolveErrorGroup: (projectId: string, fingerprint: string) =>
        base.resolveErrorGroup(projectId, fingerprint, this.clock.now()),
      journalLookup: (scope: ProjectScope, filter: JournalFilter = {}) => journalLookup(o.db, scope, filter),
      writers: (): WritersView => this.writers.view(),
      locks: (): LockView[] => this.locks.state(),
      /** Bridge-wide controls; for one project, `readOnly` also counts that project's own flag. */
      controls: (projectId?: string): ControlsView => this.controlsView(projectId),
    };
    // A project coming back into service (or its read-only flag changing) releases its held jobs.
    this.offProjects = this.projects.onChange(() => {
      this.clearHolds();
      this.pump();
    });
    if (o.autoStart !== false) this.start();
  }

  // ============================================================================================ lifecycle

  /**
   * Restart-resume: jobs left `running` / `waiting_lock` by a crash are re-queued (their in-flight step is verified
   * before anything is re-sent), `waiting_budget` jobs get their resume timers back, and scheduling starts.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    for (const job of this.repo.jobsWithStatus(['running', 'waiting_lock'])) {
      this.repo.updateJob(job.id, { status: 'queued', waitReason: { recovered: true } });
      this.emitJob(job.id, 'updated');
    }
    for (const job of this.repo.jobsWithStatus(['waiting_budget'])) this.scheduleResume(job.id, job.resumeAt);
    this.pump();
  }

  /**
   * Clean shutdown: stop starting steps, abort lock and slot waits, let in-flight calls finish, and leave every
   * unfinished job `queued` (or `waiting_budget`) for the next start.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.offProjects();
    for (const t of this.resumeTimers.values()) this.clock.clearTimeout(t);
    this.resumeTimers.clear();
    for (const a of this.active.values()) a.current.abort(new CancelledError());
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    for (const release of [...this.jobWaiters]) release();
    this.started = false;
  }

  // ============================================================================================ inline path

  /**
   * One registry operation (PLAN §6.1). Single reads run inline (not recorded as jobs); single writes run inline but
   * are recorded as one-step jobs. When the governor predicts more than `inlineMaxEstimateMs` (20 s), or writes are
   * paused, the call is queued and `{ jobId, status: 'queued', eta }` comes back instead.
   * Throws only `JobsError` subclasses.
   */
  async run(opId: string, params: OpParams = {}, opts: RunOptions): Promise<RunResult> {
    const project = this.requireAdmission(this.requireProject(opts.project));
    const def = this.validate(opId, params);
    const options = stepOptions(opts);
    const origin = normaliseOrigin(opts.origin);
    const title = opts.title ?? def.operationId;
    const priority = opts.priority ?? 'P1';
    const proposal = await this.authorize([authItem(def, params, options)], origin, 'single_op', project, {
      title,
      priority,
      ...(opts.proposal ? { extras: opts.proposal } : {}),
    });
    if (proposal) return proposal;
    checkSubmitGuards(def, params, options, this.guardContext(project));
    const estimate = this.estimateFor(project, [{ def, params }], priority);
    const slow = estimate.wallClockMs > this.settings.inlineMaxEstimateMs;

    if (!isWriteOp(def) && !slow) {
      return this.runInlineRead(project, def, params, priority, origin, opts.signal);
    }
    if (this.draining) throw new DrainingError();

    const prepared = this.prepare(def, params, options);
    const hold = isWriteOp(def) ? this.writeHold(project) : null;
    if (slow || hold) {
      const job = this.createJob(project, 'single_op', title, origin, priority, 'stop', [prepared], 'queued');
      this.pump();
      return {
        status: 'queued',
        jobId: job.id,
        eta: hold ? null : this.clock.now() + estimate.wallClockMs,
        reason: hold ?? 'estimate',
      };
    }

    // Inline write: recorded as a one-step job and run now, through the same slots, locks and guards.
    const job = this.createJob(project, 'single_op', title, origin, priority, 'stop', [prepared], 'running');
    const onAbort = () => this.cancelJob(job.id);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let result: RunnerResult;
    try {
      result = await this.launch(job.id).done;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const final = this.repo.job(job.id)!;
    const last = result.last;
    if (last?.kind === 'succeeded' && final.status === 'succeeded') {
      // A createManyResources recovered part-way ran a continuation step: return every resource it created.
      const values = result.values ?? [];
      const value =
        values.length > 1 && values.every((v) => Array.isArray((v as { resources?: unknown })?.resources))
          ? { resources: values.flatMap((v) => (v as { resources: unknown[] }).resources) }
          : last.value;
      const requestIds = this.repo.steps(job.id).flatMap((s) => s.requestIds);
      return { status: 'succeeded', jobId: job.id, result: value, requestIds };
    }
    if (final.status === 'waiting_budget') {
      return { status: 'waiting_budget', jobId: job.id, eta: final.resumeAt, reason: 'budget' };
    }
    if (final.status === 'queued') {
      const reason = (final.waitReason?.held as WriteHold | undefined) ?? 'writes_paused';
      return { status: 'queued', jobId: job.id, eta: null, reason };
    }
    if (final.status === 'cancelled') throw new CancelledError({ jobId: job.id, stepNo: 1 });
    if (last?.kind === 'failed') throw last.error;
    throw new JobsError('BRIDGE_ERROR', `Job ${job.id} ended ${final.status}`, { jobId: job.id });
  }

  private async runInlineRead(
    project: string,
    def: OperationDef,
    params: OpParams,
    priority: PriorityClass,
    origin: JobOrigin,
    signal: AbortSignal | undefined,
  ): Promise<RunResult> {
    const stats = newCallStats();
    const principal = origin.principal ?? SYSTEM_PRINCIPAL;
    try {
      const result = await callOp(this.clientOf(project), def, params, {
        priority,
        signal,
        requestIdPrefix: `lkb.r${randomBytes(6).toString('hex')}`,
        stats,
        onError: (err) =>
          this.recordLkError(err, {
            projectId: project,
            opId: def.operationId,
            principalId: principal.principalId,
            profile: principal.profile,
          }),
      });
      return { status: 'succeeded', jobId: null, result, requestIds: stats.requestIds };
    } catch (e) {
      if (e instanceof BudgetWaitError)
        throw new BudgetExhaustedError(def.operationId, e.tier, e.retryAtMs, e);
      if (e instanceof BridgeLkError) throw new LkOperationError(e);
      if (e instanceof JobsError) throw e;
      throw new JobsError('BRIDGE_ERROR', e instanceof Error ? e.message : String(e), {}, { cause: e });
    }
  }

  // ============================================================================================ v2 C1

  /**
   * Registers an in-lock planner (src/jobs/planners.ts) under `name`, replacing any earlier one. Write steps name it in
   * `options.replan`; a step whose planner is missing falls back to a plain version conflict. Returns an unregister.
   */
  registerPlanner(name: string, planner: StepPlanner): () => void {
    this.planners.set(name, planner);
    return () => {
      if (this.planners.get(name) === planner) this.planners.delete(name);
    };
  }

  /**
   * v2 C2a: sets the write guard (src/jobs/write-guard.ts), asked about every request at entry and before every write
   * step inside its lock. Returns an unregister.
   */
  /**
   * v2 D3 (ADR 0041): sets the keeper every `deleteAsset` runs first (the bytes kept before a delete). Returns an
   * unregister.
   */
  setAssetDeleteKeeper(keeper: AssetDeleteKeeper): () => void {
    this.assetDeleteKeeper = keeper;
    return () => {
      if (this.assetDeleteKeeper === keeper) this.assetDeleteKeeper = undefined;
    };
  }

  setWriteGuard(guard: WriteGuard): () => void {
    this.writeGuard = guard;
    return () => {
      if (this.writeGuard === guard) this.writeGuard = undefined;
    };
  }

  /**
   * v2 C2c (ADR 0035): sets the handler of `bridge.record` steps (the lifecycle record). A job that reaches such a step
   * with no handler fails there, before its writes. Returns an unregister.
   */
  registerRecordHandler(handler: RecordHandler, store = 'lifecycle'): () => void {
    this.recordHandlers.set(store, handler);
    return () => {
      if (this.recordHandlers.get(store) === handler) this.recordHandlers.delete(store);
    };
  }

  /**
   * v2 D1 (ADR 0038): registers a document checker for `bridge.expect` checks of kind `document` (src/jobs/internal-
   * steps.ts), replacing any earlier one of that name. A job whose check names a missing checker fails at that check,
   * before its writes. Returns an unregister.
   */
  registerChecker(name: string, checker: DocumentChecker): () => void {
    this.checkers.set(name, checker);
    return () => {
      if (this.checkers.get(name) === checker) this.checkers.delete(name);
    };
  }

  /**
   * v2 D2 (ADR 0040): registers a map checker for `bridge.expect` checks of kind `map` and `bridge.verify` targets of
   * kind `mapChecked` (src/jobs/internal-steps.ts). A job whose check names a missing checker fails at that check,
   * before its writes. Returns an unregister.
   */
  registerMapChecker(name: string, checker: MapChecker): () => void {
    this.mapCheckers.set(name, checker);
    return () => {
      if (this.mapCheckers.get(name) === checker) this.mapCheckers.delete(name);
    };
  }

  /** v2 C2c: the stored options of a job (its lifecycle marker), or empty. */
  jobOptions(projectId: string, jobId: string): Readonly<Record<string, unknown>> {
    const job = this.repo.job(jobId);
    return job && job.projectId === projectId ? this.repo.jobOptions(jobId) : {};
  }

  /** A page write that did not land as planned: an error row with the job, so it shows on the Errors page. */
  private recordVerifyMismatch(job: JobView, step: StepView, v: WriteVerification): void {
    const first = v.differences?.[0];
    this.recordError({
      projectId: job.projectId,
      opId: step.opId,
      jobId: job.id,
      stepNo: step.stepNo,
      code: 'VERIFY_MISMATCH',
      message:
        step.opId === 'replaceDocumentBlocks'
          ? `written but not as planned: the document read back after the write differs from what was sent ` +
            `(${v.differenceCount ?? v.differences?.length ?? 0} difference(s)${first ? `, first at blocks${first.path}` : ''}). ` +
            `The write was not retried. Its journal entry ${v.journalId ?? '(unknown)'} holds the page as it was before.`
          : `written but not as planned: what was read back after the job's writes differs from the plan ` +
            `(${v.differenceCount ?? v.differences?.length ?? 0} difference(s)${first ? `, first at ${first.path}` : ''}). ` +
            `Nothing was retried. The job's journal entries hold what each write changed.`,
      retryable: false,
      classification: 'conflict',
      detail: { ...v },
      principalId: job.principalId,
      profile: job.profile,
    });
  }

  // ============================================================================================ v2 A2

  /**
   * Registers a write observer (the repository tree): told before each write step is sent and after its final
   * outcome, inside the job. Returns an unsubscribe function.
   */
  observeWrites(observer: WriteObserver): () => void {
    this.writeObservers.add(observer);
    return () => this.writeObservers.delete(observer);
  }

  /**
   * One governed READ for the bridge's own bookkeeping (the repository tree's passes and its re-reads after writes),
   * through the project's governor at the given priority. It is the system's own work, not an agent's: not put to the
   * policy gate, not queued as a job when the budget is slow (a long wait throws `BudgetExhaustedError` with
   * `retryAtMs`, and the caller decides how to wait), and not recorded as a job. LegendKeeper errors are recorded in
   * the errors table (a 404 is not, with `notFoundIsAnswer`). Throws only `JobsError` subclasses.
   */
  async internalRead(
    projectId: string,
    opId: string,
    params: OpParams,
    opts: InternalReadOptions,
  ): Promise<unknown> {
    const project = this.requireProject(projectId);
    const def = this.validate(opId, params);
    if (isWriteOp(def)) {
      throw new InvalidParamsError(opId, [{ path: 'op', message: 'internalRead only reads' }]);
    }
    try {
      return await callOp(this.clientOf(project), def, params, {
        priority: opts.priority,
        jobId: opts.jobId,
        signal: opts.signal,
        requestIdPrefix: `lkb.t${randomBytes(6).toString('hex')}`,
        onError: (err) => {
          if (opts.notFoundIsAnswer && isNotFound(err)) return;
          this.recordLkError(err, {
            projectId: project,
            opId: def.operationId,
            ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
            ...(opts.stepNo !== undefined ? { stepNo: opts.stepNo } : {}),
            principalId: SYSTEM_PRINCIPAL.principalId,
            profile: SYSTEM_PRINCIPAL.profile,
          });
        },
      });
    } catch (e) {
      if (e instanceof BudgetWaitError)
        throw new BudgetExhaustedError(def.operationId, e.tier, e.retryAtMs, e);
      if (e instanceof BridgeLkError) throw new LkOperationError(e);
      if (e instanceof JobsError) throw e;
      throw new JobsError('BRIDGE_ERROR', e instanceof Error ? e.message : String(e), {}, { cause: e });
    }
  }

  private writeInfo(job: JobView, step: StepView): WriteStepInfo | null {
    if (this.writeObservers.size === 0 || step.opKind === 'read') return null;
    let params: OpParams;
    try {
      params = this.repo.stepParams(step);
    } catch {
      return null;
    }
    return {
      projectId: job.projectId,
      jobId: job.id,
      stepNo: step.stepNo,
      opId: step.opId,
      params,
      priority: job.priority,
      options: step.options,
    };
  }

  /** v2 C2a: the observers re-read now what the job's `deferTreeReread` steps changed (awaited, inside the job). */
  private async flushDeferred(job: JobView, signal: AbortSignal): Promise<void> {
    if (this.writeObservers.size === 0) return;
    if (!this.repo.steps(job.id).some((s) => s.options.deferTreeReread === true)) return;
    for (const o of [...this.writeObservers]) {
      try {
        await o.flushDeferred?.({ projectId: job.projectId, jobId: job.id, priority: job.priority, signal });
      } catch (e) {
        this.log.warn({ err: e, jobId: job.id }, 'a write observer failed');
      }
    }
  }

  private notifyBeforeWrite(info: WriteStepInfo | null): void {
    if (!info) return;
    for (const o of [...this.writeObservers]) {
      try {
        o.beforeWrite?.(info);
      } catch (e) {
        this.log.warn({ err: e, jobId: info.jobId, stepNo: info.stepNo }, 'a write observer failed');
      }
    }
  }

  private async notifyAfterWrite(
    info: WriteStepInfo | null,
    outcome: StepOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    if (!info || (outcome.kind !== 'succeeded' && outcome.kind !== 'failed')) return;
    const result = {
      ...info,
      outcome: outcome.kind,
      uncertain: outcome.kind === 'failed' && outcome.uncertain,
      value: outcome.kind === 'succeeded' ? outcome.value : undefined,
      signal,
    };
    for (const o of [...this.writeObservers]) {
      try {
        await o.afterWrite?.(result);
      } catch (e) {
        this.log.warn({ err: e, jobId: info.jobId, stepNo: info.stepNo }, 'a write observer failed');
      }
    }
  }

  // ============================================================================================ jobs

  /** Queues a multi-step job: `batch_ops` (ordered registry calls) or `paginate_all` (every page of a list). */
  async submit(req: SubmitRequest): Promise<SubmitResult | ProposalCaptured> {
    if (this.draining) throw new DrainingError();
    if (req.kind === 'batch_ops') return this.submitBatch(req);
    if (req.kind === 'upload_image') return this.submitUpload(req);
    return this.submitPaginate(req);
  }

  private async submitBatch(req: BatchSubmit): Promise<SubmitResult | ProposalCaptured> {
    const project = this.requireAdmission(this.requireProject(req.project));
    if (req.steps.length === 0)
      throw new InvalidParamsError('batch_ops', [{ path: 'steps', message: 'Empty' }]);
    const origin = normaliseOrigin(req.origin);
    const validated: AuthItem[] = req.steps.map((s: StepSpec, i) => {
      const params = s.params ?? {};
      const options = stepOptions(s);
      // v2 C2a: the bridge's own check and verify steps, only when bridge code asks for them (never lk_api_batch).
      if (req.internal === true && isInternalStep(s.op)) {
        const issues = internalStepIssues(s.op, params);
        if (issues.length > 0) {
          throw new InvalidParamsError(
            s.op,
            issues.map((x) => ({ path: `steps[${i}].${x.path}`, message: x.message })),
          );
        }
        return { opId: s.op, def: null, meta: internalPolicyMeta(s.op, options), params, options };
      }
      try {
        return authItem(this.validate(s.op, params), params, options);
      } catch (e) {
        if (e instanceof InvalidParamsError) {
          throw new InvalidParamsError(
            s.op,
            e.issues.map((x) => ({ path: `steps[${i}].${x.path}`, message: x.message })),
          );
        }
        throw e;
      }
    });
    // v2 C2a: a job-level lock covers every write step: each must take that same lock (or none). v2 C2c: a job may
    // hold more: a document of the page (`holdDocument`) and one more resource (`holdAlso`), all taken at its start.
    const heldPage = req.holdLock ? projectLockKey(project, `res:${req.holdLock.resourceId}`) : null;
    if ((req.holdDocument || req.holdAlso || req.holdMore) && !heldPage) {
      throw new InvalidParamsError('batch_ops', [
        {
          path: 'holdDocument',
          message: 'further job-level locks are held only with the page lock (holdLock)',
        },
      ]);
    }
    // C2d: a whole set's pages and documents (`holdMore`); v2 D1: documents held for the whole job with or without a page
    // lock (`holdDocuments`, a chronology event's table, timeline and Main). All the job-level locks are one sorted,
    // deduplicated list: the first is stored as `heldLock`, the rest as `heldMore`, and all are taken in that order.
    const heldDocs = [...new Set(req.holdDocuments ?? [])].map((d) => projectLockKey(project, `doc:${d}`)!);
    const heldKeys = [
      ...new Set([
        ...(heldPage ? [heldPage] : []),
        ...(req.holdDocument ? [projectLockKey(project, `doc:${req.holdDocument.documentId}`)!] : []),
        ...(req.holdAlso ? [projectLockKey(project, `res:${req.holdAlso.resourceId}`)!] : []),
        ...(req.holdMore?.resources ?? []).map((id) => projectLockKey(project, `res:${id}`)!),
        ...(req.holdMore?.documents ?? []).map((id) => projectLockKey(project, `doc:${id}`)!),
        ...heldDocs,
      ]),
    ].sort();
    const heldLock = heldKeys[0] ?? null;
    const heldMore = heldKeys.slice(1);
    if (heldLock) {
      validated.forEach((v, i) => {
        if (!v.def || v.def.kind === 'read') return;
        const key = projectLockKey(project, lockKeyFor(v.def, v.params));
        if (key !== null && !heldKeys.includes(key)) {
          throw new InvalidParamsError(v.opId, [
            {
              path: `steps[${i}]`,
              message: `takes lock ${key}, but the job holds ${heldKeys.join(' and ')}: a job-level lock must cover every write`,
            },
          ]);
        }
      });
    }
    const priority = req.priority ?? 'P2';
    const onError: OnError = req.onError ?? 'stop';
    const title = req.title ?? `batch of ${validated.length} operation(s)`;
    const jobOptions: ProposalJobOptions | undefined =
      req.holdLock || req.internal || req.lifecycle || req.pageScope || heldDocs.length > 0
        ? {
            ...(req.holdLock ? { holdLock: { resourceId: req.holdLock.resourceId } } : {}),
            ...(heldDocs.length > 0 ? { holdDocuments: [...new Set(req.holdDocuments ?? [])] } : {}),
            ...(req.internal ? { internal: true } : {}),
            ...(req.holdDocument ? { holdDocument: { documentId: req.holdDocument.documentId } } : {}),
            ...(req.holdAlso ? { holdAlso: { resourceId: req.holdAlso.resourceId } } : {}),
            ...(req.holdMore ? { holdMore: req.holdMore } : {}),
            ...(req.lifecycle ? { lifecycle: req.lifecycle } : {}),
            ...(req.pageScope ? { pageScope: req.pageScope } : {}),
          }
        : undefined;
    // Every step is put to the policy gate before anything is queued: one deny denies the batch, one propose
    // turns the whole batch into one proposal.
    const proposal = await this.authorize(
      validated,
      origin,
      'batch_ops',
      project,
      {
        title,
        priority,
        onError,
        ...(req.proposal ? { extras: req.proposal } : {}),
        ...(jobOptions ? { jobOptions } : {}),
      },
      req.lifecycle,
      req.forceProposal === true,
    );
    if (proposal) return proposal;
    if (this.draining) throw new DrainingError();
    const guard = this.guardContext(project);
    for (const v of validated) if (v.def) checkSubmitGuards(v.def, v.params, v.options, guard);
    const prepared = validated.map((v) =>
      v.def ? this.prepare(v.def, v.params, v.options) : this.prepareInternal(v.opId, v.params, v.options),
    );
    const job = this.createJob(
      project,
      'batch_ops',
      title,
      origin,
      priority,
      onError,
      prepared,
      'queued',
      heldLock || req.lifecycle || req.pageScope
        ? {
            ...(heldLock ? { [HELD_LOCK]: heldLock } : {}),
            ...(heldMore.length > 0 ? { [HELD_MORE]: heldMore } : {}),
            ...(req.lifecycle ? { [LIFECYCLE_OPTION]: req.lifecycle } : {}),
            // C2d (ADR 0036 decision 5): read by the page-scope guard inside the lock.
            ...(req.pageScope ? { pageScope: req.pageScope } : {}),
          }
        : undefined,
    );
    const estimate = this.estimateFor(
      project,
      prepared.map((p) => ({ def: p.def, params: p.step.params, opId: p.step.opId })),
      priority,
    );
    this.pump();
    const held = prepared.some((p) => p.def && isWriteOp(p.def)) && this.writeHold(project) !== null;
    return { jobId: job.id, status: job.status, eta: held ? null : this.clock.now() + estimate.wallClockMs };
  }

  /** v2 C2a: one of the bridge's own steps (a read; no client ids, no idempotency key). */
  private prepareInternal(opId: string, params: OpParams, options: StepOptions): PreparedStep {
    return { def: null, step: { opId, opKind: 'read', params, options, clientIds: [], post: false } };
  }

  private async submitPaginate(req: PaginateSubmit): Promise<SubmitResult | ProposalCaptured> {
    const project = this.requireAdmission(this.requireProject(req.project));
    const params = req.params ?? {};
    const def = this.validate(req.op, params);
    if (!def.paged || def.kind !== 'read') {
      throw new InvalidParamsError(req.op, [
        { path: 'op', message: 'paginate_all needs a paged read operation' },
      ]);
    }
    const origin = normaliseOrigin(req.origin);
    const title = req.title ?? `${def.operationId}: every page`;
    const proposal = await this.authorize([authItem(def, params, {})], origin, 'paginate_all', project, {
      title,
      priority: req.priority ?? 'P2',
      paginate: {
        ...(req.maxItems !== undefined ? { maxItems: req.maxItems } : {}),
        ...(req.maxPages !== undefined ? { maxPages: req.maxPages } : {}),
      },
    });
    if (proposal) return proposal;
    if (this.draining) throw new DrainingError();
    const caps = this.settings.paginate;
    const query = { ...params.query };
    if (query.limit === undefined) query.limit = caps.pageSize;
    const first: OpParams = { ...params, query };
    const priority = req.priority ?? 'P2';
    const job = this.createJob(
      project,
      'paginate_all',
      title,
      origin,
      priority,
      'stop',
      [this.prepare(def, first, {})],
      'queued',
      {
        maxItems: Math.min(req.maxItems ?? caps.maxItems, caps.maxItems),
        maxPages: Math.min(req.maxPages ?? caps.maxPages, caps.maxPages),
        maxBytes: caps.maxBytes,
      },
    );
    const artifactId = this.repo.createArtifact(job.id, null, 'items', null);
    this.repo.setJobOptions(job.id, { ...this.repo.jobOptions(job.id), artifactId });
    this.repo.updateJob(job.id, { result: { artifactId, items: 0, pages: 0, truncated: false } });
    this.emitJob(job.id, 'updated');
    this.pump();
    return {
      jobId: job.id,
      status: 'queued',
      eta: this.clock.now() + this.estimateFor(project, [{ def, params }], priority).wallClockMs,
    };
  }

  /**
   * `upload_image` (PLAN §4 rule 5): three steps. `createImageUpload` and `createImageAsset` are registry calls (so
   * policy, guards, keys and recovery apply as usual); the PUT between them is the custom `upload_image.put` step.
   * The upload key is bound into the last step when it is about to run (see `bindUploadStep`).
   */
  private async submitUpload(req: UploadImageSubmit): Promise<SubmitResult | ProposalCaptured> {
    const project = this.requireAdmission(this.requireProject(req.project));
    const origin = normaliseOrigin(req.origin);
    if (req.staging === true && (req.hide !== true || req.verifyStored !== true)) {
      throw new InvalidParamsError('upload_image', [
        { path: 'staging', message: 'a staged upload is hidden and verified' },
      ]);
    }
    const folders = req.createFolders ?? [];
    const uploadParams: OpParams = {
      body: {
        contentType: req.contentType,
        contentLength: req.contentLength,
        ...(req.contentHash ? { contentHash: req.contentHash } : {}),
      },
    };
    // v2 D3: the folders to create first, each inside the one before (its id bound when it runs).
    const folderItems = folders.map((name, i) => {
      const params: OpParams = {
        body: { name, ...(i === 0 && req.folderId !== undefined ? { folderId: req.folderId } : {}) },
      };
      const options: StepOptions = i === 0 ? {} : { bindFrom: { step: i, to: 'body.folderId' } };
      return { def: this.validate('createAssetFolder', params), params, options };
    });
    const assetBody = {
      name: req.name,
      ...(req.description !== undefined ? { description: req.description } : {}),
      ...(folders.length === 0 && req.folderId !== undefined ? { folderId: req.folderId } : {}),
    };
    // The upload key (and a new folder's id) do not exist yet; validate the rest with stand-ins.
    const upload = this.validate('createImageUpload', uploadParams);
    const asset = this.validate('createImageAsset', {
      body: { uploadKey: 'pending', ...assetBody, ...(folders.length > 0 ? { folderId: 'pending' } : {}) },
    });
    const assetStepNo = folders.length + 3;
    const assetOptions: StepOptions =
      folders.length > 0 ? { bindFrom: { step: folders.length, to: 'body.folderId' } } : {};
    const hideParams: OpParams = { path: { assetId: 'pending' }, body: { isHidden: true } };
    const hide = req.hide === true ? this.validate('updateAsset', hideParams) : null;
    const priority = req.priority ?? 'P2';
    const title = req.title ?? `upload image: ${req.name}`;
    const items = [
      ...folderItems.map((f) => authItem(f.def, f.params, {})),
      authItem(upload, uploadParams, {}),
      authItem(asset, { body: assetBody }, {}),
      ...(hide ? [authItem(hide, hideParams, {})] : []),
    ];
    const proposal = await this.authorize(
      items,
      origin,
      'upload_image',
      project,
      { title, priority },
      undefined,
      false,
      {
        staging: req.staging === true,
      },
    );
    if (proposal) return proposal;
    if (this.draining) throw new DrainingError();
    const guard = this.guardContext(project);
    for (const v of items) if (v.def) checkSubmitGuards(v.def, v.params, v.options, guard);
    const custom = (opId: string, params: OpParams): Pick<PreparedStep, 'step'> => ({
      step: { opId, opKind: 'upload', params, options: {}, clientIds: [], post: false },
    });
    const steps: Pick<PreparedStep, 'step'>[] = [
      ...folderItems.map((f) => this.prepare(f.def, f.params, f.options)),
      this.prepare(upload, uploadParams, {}),
      custom(UPLOAD_PUT_STEP, {
        body: {
          contentType: req.contentType,
          contentLength: req.contentLength,
          ...(req.contentHash ? { contentHash: req.contentHash } : {}),
          dataBase64: req.dataBase64,
        },
      }),
      this.prepare(asset, { body: assetBody }, assetOptions),
      ...(req.verifyStored === true
        ? [
            custom(UPLOAD_VERIFY_STEP, {
              body: {
                assetStep: assetStepNo,
                contentLength: req.contentLength,
                ...(req.contentHash ? { contentHash: req.contentHash } : {}),
              },
            }),
          ]
        : []),
      ...(hide
        ? [this.prepare(hide, hideParams, { bindFrom: { step: assetStepNo, to: 'path.assetId' } })]
        : []),
    ];
    const job = this.createJob(
      project,
      'upload_image',
      title,
      origin,
      priority,
      'stop',
      steps,
      'queued',
      req.staging === true ? { staging: true } : undefined,
    );
    const estimate = this.estimateFor(
      project,
      [
        ...folderItems.map((f) => ({ def: f.def, params: f.params })),
        { def: upload, params: uploadParams },
        { def: asset, params: { body: assetBody } },
        ...(hide ? [{ def: hide, params: hideParams }] : []),
      ],
      priority,
    );
    this.pump();
    return {
      jobId: job.id,
      status: job.status,
      eta: this.writeHold(project) !== null ? null : this.clock.now() + estimate.wallClockMs,
    };
  }

  /**
   * Binds the `uploadKey` from step 1's stored result into `createImageAsset`'s params just before it runs.
   * Idempotent, and safe across restarts: it works from the persisted result. Returns true when it changed the step.
   */
  private bindUploadStep(jobId: string, step: StepView): boolean {
    if (step.opId !== 'createImageAsset') return false;
    const params = this.repo.stepParams(step);
    const body = (params.body ?? {}) as Record<string, unknown>;
    if (typeof body.uploadKey === 'string' && body.uploadKey.length > 0 && body.uploadKey !== 'pending')
      return false;
    // v2 D3: folders may be created first, so the upload is the createImageUpload step before this one.
    const first = this.repo
      .steps(jobId)
      .find((s) => s.opId === 'createImageUpload' && s.stepNo < step.stepNo);
    const created = first ? (this.repo.stepResult(first) as { uploadKey?: unknown } | null) : null;
    if (typeof created?.uploadKey !== 'string' || created.uploadKey.length === 0) {
      throw new JobsError('BRIDGE_ERROR', 'createImageUpload returned no uploadKey', {
        jobId,
        stepNo: step.stepNo,
      });
    }
    this.repo.setStepParams(jobId, step.stepNo, {
      ...params,
      body: { ...body, uploadKey: created.uploadKey },
    });
    return true;
  }

  /**
   * v2 C2a: binds `params.ifMatch` of a step with `options.ifMatchFrom` from the stored result of the step it names (a
   * write's `version`, or the `bridge.expect` step's `versions[key]`), just before it runs. A step that may already have
   * been sent keeps the version it was sent with (recovery compares with it). Returns the refusal when the version is
   * missing (nothing is sent then), or null.
   */
  /**
   * v2 C2b: replaces the template ids in the params of a step with `options.bindIds` by the ids of the page this job
   * created from that template, from the `ids` map the named `bridge.expect` step returned (see `StepOptions.bindIds`).
   * Done once, before anything is sent, and stored; a step being recovered keeps what it was sent with.
   */
  private bindIds(job: JobView, step: StepView): JobsError | null {
    const from = step.options.bindIds;
    if (!from || step.status === 'running' || step.maybeSent || step.firstSentAt !== null) return null;
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const source = from.step < step.stepNo ? this.repo.step(job.id, from.step) : undefined;
    const result =
      source?.status === 'succeeded'
        ? (this.repo.stepResult(source) as {
            ids?: Record<string, unknown>;
            idsByPage?: Record<string, Record<string, unknown>>;
          } | null)
        : null;
    const params = this.repo.stepParams(step);
    // C2d (ADR 0037): the ids of the page this write names. Copies of one template share their ids, so a map keyed by
    // the template's ids alone could hand one copy's write another copy's ids; a write naming a page the check did not
    // map binds nothing and is refused. Results stored before C2d carry only the flat map.
    const page = typeof params.path?.resourceId === 'string' ? params.path.resourceId : undefined;
    const ids = result?.idsByPage ? (page !== undefined ? result.idsByPage[page] : undefined) : result?.ids;
    if (!ids || typeof ids !== 'object') {
      return new JobsError(
        'BRIDGE_ERROR',
        `${step.opId}: step ${from.step} gave no ids of the new page to bind; nothing was sent`,
        ref,
      );
    }
    const map = (v: unknown): unknown => (typeof v === 'string' && typeof ids[v] === 'string' ? ids[v] : v);
    const path = params.path
      ? Object.fromEntries(
          Object.entries(params.path).map(([k, v]) => [
            k,
            k === 'propertyId' || k === 'rowId' ? (map(v) as string) : v,
          ]),
        )
      : undefined;
    let body = params.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = { ...(body as Record<string, unknown>) };
      for (const k of ['after', 'before']) if (k in b) b[k] = map(b[k]);
      if (Array.isArray(b.items)) {
        b.items = (b.items as unknown[]).map((i) =>
          i && typeof i === 'object' && 'id' in i ? { ...(i as Record<string, unknown>), id: map(i.id) } : i,
        );
      }
      body = b;
    }
    const next: OpParams = { ...params, ...(path ? { path } : {}), ...(body !== undefined ? { body } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(params)) this.repo.setStepParams(job.id, step.stepNo, next);
    return null;
  }

  /**
   * v2 D1: replaces the `body` of a step with `options.bindBody` by the one the named `bridge.expect` step worked out
   * inside the lock (`bodies[key]`), checked against the registry's schema and stored before anything is sent. A step
   * that may already have been sent keeps what it was sent with.
   */
  private bindBody(job: JobView, step: StepView): JobsError | null {
    const from = step.options.bindBody;
    if (!from || step.status === 'running' || step.maybeSent || step.firstSentAt !== null) return null;
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const source = from.step < step.stepNo ? this.repo.step(job.id, from.step) : undefined;
    const result =
      source?.status === 'succeeded'
        ? (this.repo.stepResult(source) as { bodies?: Record<string, unknown> } | null)
        : null;
    const body = result?.bodies?.[from.key];
    if (body === undefined || body === null || typeof body !== 'object') {
      return new JobsError(
        'BRIDGE_ERROR',
        `${step.opId}: step ${from.step} worked out no ${from.key} to send; nothing was sent`,
        ref,
      );
    }
    const params = this.repo.stepParams(step);
    const next: OpParams = { ...params, body };
    if (isInternalStep(step.opId)) {
      const issues = internalStepIssues(step.opId, next);
      if (issues.length > 0) return new InvalidParamsError(step.opId, issues);
    } else {
      try {
        this.validate(step.opId, next);
      } catch (e) {
        if (e instanceof JobsError) return e;
        throw e;
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(params)) this.repo.setStepParams(job.id, step.stepNo, next);
    return null;
  }

  /**
   * v2 D3 (ADR 0041): puts the `id` an earlier step's create returned (a new folder, a new asset) into this step's
   * `body.folderId` or `path.assetId`, just before it runs (see `StepOptions.bindFrom`). Stored before anything is sent;
   * a step that may already have been sent keeps what it was sent with.
   */
  private bindFrom(job: JobView, step: StepView): JobsError | null {
    const from = step.options.bindFrom;
    if (!from || step.status === 'running' || step.maybeSent || step.firstSentAt !== null) return null;
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const source = from.step < step.stepNo ? this.repo.step(job.id, from.step) : undefined;
    const result =
      source?.status === 'succeeded' ? (this.repo.stepResult(source) as { id?: unknown } | null) : null;
    if (typeof result?.id !== 'string' || result.id.length === 0) {
      return new JobsError(
        'BRIDGE_ERROR',
        `${step.opId}: step ${from.step} gave no id to use as ${from.to}; nothing was sent`,
        ref,
      );
    }
    const params = this.repo.stepParams(step);
    const next: OpParams =
      from.to === 'path.assetId'
        ? { ...params, path: { ...(params.path ?? {}), assetId: result.id } }
        : { ...params, body: { ...((params.body ?? {}) as Record<string, unknown>), folderId: result.id } };
    try {
      this.validate(step.opId, next);
    } catch (e) {
      if (e instanceof JobsError) return e;
      throw e;
    }
    if (JSON.stringify(next) !== JSON.stringify(params)) this.repo.setStepParams(job.id, step.stepNo, next);
    return null;
  }

  private bindIfMatch(job: JobView, step: StepView): JobsError | null {
    const from = step.options.ifMatchFrom;
    if (!from || step.status === 'running' || step.maybeSent || step.firstSentAt !== null) return null;
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const source = from.step < step.stepNo ? this.repo.step(job.id, from.step) : undefined;
    const result =
      source?.status === 'succeeded'
        ? (this.repo.stepResult(source) as {
            version?: unknown;
            etag?: unknown;
            versions?: Record<string, unknown>;
            versionsByPage?: Record<string, Record<string, unknown>>;
          } | null)
        : null;
    // C2d (ADR 0037): a check's version is taken from the page this write names (labels are titles, which two copies
    // of one template share); results stored before C2d carry only the flat map.
    const page = this.repo.stepParams(step).path?.resourceId;
    const byPage =
      from.key !== undefined && result?.versionsByPage && typeof page === 'string'
        ? result.versionsByPage[page]
        : undefined;
    const version =
      from.key !== undefined
        ? result?.versionsByPage && typeof page === 'string'
          ? byPage?.[from.key]
          : result?.versions?.[from.key]
        : (result?.version ??
          // v2 D1.1 (ADR 0039): a write whose body carries no version (a row write, a delete answering 204) but sent an
          // ETag: that is its new version, unless the project switched `useEtagVersions` off.
          (this.etagVersions?.(job.projectId) === false ? undefined : result?.etag));
    if (typeof version !== 'string' || version === '') {
      // Nothing to chain from (a delete answers 204, without a version): a step with its own in-step check reads the
      // state inside the lock instead, compares it with the plan, and sends the version it read.
      if (step.options.expectCurrent) {
        const params = this.repo.stepParams(step);
        if (params.ifMatch !== undefined) {
          const { ifMatch: _drop, ...rest } = params;
          this.repo.setStepParams(job.id, step.stepNo, rest);
        }
        return null;
      }
      return new JobsError(
        'BRIDGE_ERROR',
        `${step.opId}: step ${from.step} gave no version${from.key ? ` for ${from.key}` : ''} to chain from; nothing was sent`,
        ref,
      );
    }
    const params = this.repo.stepParams(step);
    if (params.ifMatch !== version)
      this.repo.setStepParams(job.id, step.stepNo, { ...params, ifMatch: version });
    return null;
  }

  /**
   * Stores a result that was already produced (an oversized inline read) as a succeeded one-step job holding the
   * whole value in a `result` artefact, so MCP tools can return a handle and page it (PLAN §7). Reads are normally
   * not recorded as jobs; this is the exception, and it makes the stored result visible in the job list.
   */
  recordResult(args: {
    /** The project the value belongs to (v2 A1): it must be a project this bridge knows. */
    readonly project: string;
    /** What produced the value: a registry operation id, or a label such as `bridge_journal_lookup`. */
    readonly opId: string;
    readonly params: OpParams;
    readonly value: unknown;
    readonly origin: JobOrigin;
    readonly title?: string;
    readonly priority?: PriorityClass;
    /** Chunk 6: records the work as a FAILED job (a maintenance run that threw) instead of a succeeded one. */
    readonly failure?: { readonly code: string; readonly message: string };
  }): { readonly jobId: string; readonly artifactId: string; readonly bytes: number } {
    if (!this.projects.known(args.project)) throw new UnknownProjectError(args.project);
    const origin = normaliseOrigin(args.origin);
    const job = this.createJob(
      args.project,
      'single_op',
      args.title ?? `${args.opId} (stored result)`,
      origin,
      args.priority ?? 'P1',
      'stop',
      [
        {
          step: {
            opId: args.opId,
            opKind: 'read',
            params: args.params,
            options: {},
            clientIds: [],
            post: false,
          },
        },
      ],
      args.failure ? 'failed' : 'succeeded',
    );
    const text = JSON.stringify(args.value) ?? 'null';
    const artifactId = this.repo.createArtifact(job.id, 1, 'result', text);
    const bytes = Buffer.byteLength(text);
    const at = this.clock.now();
    const failure = args.failure
      ? { name: 'MaintenanceError', code: args.failure.code, message: args.failure.message.slice(0, 1000) }
      : undefined;
    this.repo.updateStep(job.id, 1, {
      status: failure ? 'failed' : 'succeeded',
      attempts: 1,
      resultSummary: { stored: true, bytes },
      resultArtifactId: artifactId,
      ...(failure ? { error: failure } : {}),
      startedAt: at,
      finishedAt: at,
    });
    this.refreshProgress(job.id);
    this.repo.updateJob(job.id, {
      result: {
        stepsSucceeded: failure ? 0 : 1,
        stepsFailed: failure ? 1 : 0,
        stepsNotRun: 0,
        resultArtifactId: artifactId,
      },
      ...(failure ? { lastError: failure } : {}),
      startedAt: at,
      finishedAt: at,
    });
    this.emitJob(job.id, 'updated');
    return { jobId: job.id, artifactId, bytes };
  }

  /**
   * v2 B2: the stored result of each step of a finished job of `projectId` (a read's value, or its error), in step
   * order. Undefined for a job of another project or one that does not exist.
   */
  stepResults(
    projectId: string,
    jobId: string,
  ):
    | readonly {
        readonly stepNo: number;
        readonly status: string;
        readonly value: unknown;
        readonly error: unknown;
      }[]
    | undefined {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return undefined;
    return this.repo.steps(jobId).map((st) => ({
      stepNo: st.stepNo,
      status: st.status,
      value: st.status === 'succeeded' ? this.repo.stepResult(st) : null,
      error: st.error,
    }));
  }

  /**
   * Bounded wait (at most `maxWaitMs`, 25 s) for a job of `projectId` to finish. Resolves with the job as it then
   * stands. A job of another project is not found.
   */
  wait(projectId: string, jobId: string, ms: number): Promise<JobView> {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return Promise.reject(new JobNotFoundError(jobId));
    if (TERMINAL_JOB_STATUSES.has(job.status)) return Promise.resolve(job);
    const bounded = Math.max(0, Math.min(ms, this.settings.maxWaitMs));
    return new Promise((resolve) => {
      let timer: TimerHandle | undefined = undefined;
      const off = this.events.on('job', (e) => {
        if (e.job.id === jobId && TERMINAL_JOB_STATUSES.has(e.job.status)) finish(e.job);
      });
      const release = () => finish(this.repo.job(jobId) ?? job);
      const finish = (v: JobView) => {
        off();
        this.jobWaiters.delete(release);
        if (timer) this.clock.clearTimeout(timer);
        resolve(v);
      };
      this.jobWaiters.add(release);
      timer = this.clock.setTimeout(release, bounded);
    });
  }

  // ============================================================================================ controls

  readonly controls = {
    /** Kill switch (PLAN §6.2): persisted. In-flight steps finish; no new write step starts. */
    pauseWrites: (by?: string): ControlsView => {
      this.writesPaused = true;
      this.repo.setSetting(SETTING.writesPaused, true, by);
      return this.controlsChanged();
    },
    resumeWrites: (by?: string): ControlsView => {
      this.writesPaused = false;
      this.repo.setSetting(SETTING.writesPaused, null, by);
      this.clearHolds();
      this.pump();
      return this.controlsChanged();
    },
    /**
     * Drain mode (PLAN §6.2): running jobs finish, no new job is accepted or started. Resolves once nothing runs.
     * Not persisted: a restart comes back accepting work.
     */
    drain: (): Promise<void> => {
      this.draining = true;
      this.controlsChanged();
      return this.whenIdle();
    },
    undrain: (): ControlsView => {
      this.draining = false;
      this.pump();
      return this.controlsChanged();
    },
    /** WRITERS_MAX, 1–8, persisted; takes effect at once. */
    setWritersMax: (n: number, by?: string): ControlsView => {
      const max = clampWriters(n);
      this.writers.setMax(max);
      this.repo.setSetting(SETTING.writersMax, max, by);
      return this.controlsChanged();
    },
    /** Read-only override, persisted. `null` falls back to LK_READ_ONLY. */
    setReadOnly: (value: boolean | null, by?: string): ControlsView => {
      this.readOnlyOverride = value;
      this.repo.setSetting(SETTING.readOnly, value, by);
      this.clearHolds();
      this.pump();
      return this.controlsChanged();
    },
    /**
     * Cancels a job of `projectId`: an in-flight step completes, then it stops; nothing further is sent. Every job
     * control names the project; a job of another project is not found (v2 A1).
     */
    cancel: (projectId: string, jobId: string): JobView => {
      this.requireJob(jobId, projectId);
      return this.cancelJob(jobId);
    },
    /** Pauses a job after its in-flight step. */
    pauseJob: (projectId: string, jobId: string): JobView => {
      const job = this.requireJob(jobId, projectId);
      if (TERMINAL_JOB_STATUSES.has(job.status))
        throw new InvalidControlError(`Job ${jobId} has finished`, { jobId });
      if (this.active.has(jobId)) {
        this.repo.updateJob(jobId, { pauseRequested: true });
        this.active.get(jobId)!.current.abort(new CancelledError({ jobId }));
      } else {
        this.clearResume(jobId);
        this.repo.updateJob(jobId, { status: 'paused', pauseRequested: false });
      }
      return this.emitJob(jobId, 'updated');
    },
    resumeJob: (projectId: string, jobId: string): JobView => {
      const job = this.requireJob(jobId, projectId);
      if (job.status !== 'paused' && !job.pauseRequested) {
        throw new InvalidControlError(`Job ${jobId} is not paused`, { jobId });
      }
      this.repo.updateJob(jobId, {
        pauseRequested: false,
        ...(job.status === 'paused' ? { status: 'queued' as const, waitReason: null } : {}),
      });
      this.pump();
      return this.emitJob(jobId, 'updated');
    },
    /**
     * Retries a failed (or uncertain) step; the job continues from it.
     * - A definite failure (LK refused it) is re-run as new work: `attempt0` goes up, so the idempotency key is new
     *   (LK stores some refusals, such as 409, under the old key). Client ids stay, so a create that did apply is
     *   recognised (DUPLICATE_ID, then verify).
     * - A failure that may have applied (`maybeSent`, or `uncertain`) keeps its key, version and first-send time, so
     *   it goes through verify-before-resend again and can never duplicate.
     * - `force: true` (a person checked LK and wants it sent again) re-runs even those as new work.
     */
    retryStep: (
      projectId: string,
      jobId: string,
      stepNo: number,
      opts: { readonly force?: boolean } = {},
    ): JobView => {
      const job = this.requireJob(jobId, projectId);
      if (this.active.has(jobId) || !TERMINAL_JOB_STATUSES.has(job.status) || job.status === 'cancelled') {
        throw new InvalidControlError(`Job ${jobId} must have failed to retry a step`, { jobId, stepNo });
      }
      const step = this.repo.step(jobId, stepNo);
      if (!step || (step.status !== 'failed' && step.status !== 'uncertain')) {
        throw new InvalidControlError(`Step ${stepNo} of ${jobId} has not failed`, { jobId, stepNo });
      }
      const def = getOperation(step.opId); // undefined for a custom step (the upload PUT): never a POST
      const ambiguous = step.maybeSent || step.status === 'uncertain';
      if (ambiguous && opts.force !== true) {
        this.repo.updateStep(jobId, stepNo, {
          status: 'pending',
          maybeSent: true,
          error: null,
          finishedAt: null,
        });
      } else {
        const attempt0 = step.attempt0 + 1;
        this.repo.updateStep(jobId, stepNo, {
          status: 'pending',
          attempt0,
          idempotencyKey: def?.method === 'POST' ? idempotencyKeyFor(jobId, stepNo, attempt0) : null,
          error: null,
          maybeSent: false,
          firstSentAt: null,
          ifMatch: null,
          finishedAt: null,
        });
      }
      this.refreshProgress(jobId);
      const steps = this.repo.steps(jobId);
      this.repo.updateJob(jobId, {
        status: 'queued',
        finishedAt: null,
        lastError: null,
        waitReason: null,
        uncertain: steps.some((s) => s.status === 'uncertain'),
      });
      this.pump();
      return this.emitJob(jobId, 'updated');
    },
  };

  /**
   * Records a budget snapshot of one project's governor for the Request Budgets sparklines (chunk 6 schedules this
   * every 10 s, for every project). Without `snapshot`, the project's governor is sampled now.
   */
  recordBudgetSample(projectId: string, snapshot?: BudgetSnapshot): void {
    const s = snapshot ?? this.projects.anyClient(projectId)?.governor.snapshot();
    if (!s) throw new UnknownProjectError(projectId);
    this.repo.recordBudgetSample(projectId, s);
  }

  /**
   * Journal retention (default 30 days or 2 GB), over every project's entries. The scheduled `journal-prune` job
   * (chunk 6) calls this.
   */
  pruneJournal() {
    return this.journal.prune(this.settings.journal);
  }

  // ============================================================================================ scheduling

  private pump(): void {
    if (!this.started || this.stopped || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      try {
        this.pumpNow();
      } catch (e) {
        this.log.error({ err: e }, 'job scheduler failed');
      }
    });
  }

  private pumpNow(): void {
    if (!this.started || this.stopped || this.draining) return;
    let capacity = this.settings.maxActiveJobs - this.active.size;
    if (capacity <= 0) return;
    // CR-2026-11 (CR-04): the whole queue, not only its first `capacity + 100` jobs: while writes are held, a long queue
    // of held writes must not keep a job that can run (its next step reads) from starting.
    for (const id of this.repo.queuedJobIds()) {
      if (capacity <= 0) break;
      if (this.active.has(id)) continue;
      const job = this.repo.job(id);
      if (!job || job.status !== 'queued') continue;
      const step = this.repo.nextStep(job.id);
      // A project that is not served now holds every step of its jobs; otherwise only writes can be held.
      // v2 C2a: the bridge's own check (`bridge.expect`) is the first step of a write and is held like one; otherwise
      // the job would start, the step would report itself held, and the scheduler would start it again at once.
      const hold: WriteHold | null = !this.projects.client(job.projectId)
        ? 'project_unavailable'
        : step && (step.opKind !== 'read' || step.opId === EXPECT_STEP)
          ? this.writeHold(job.projectId)
          : null;
      if (step && hold) {
        if (job.waitReason?.held !== hold) {
          this.repo.updateJob(job.id, { waitReason: { held: hold } });
          this.emitJob(job.id, 'updated');
        }
        continue;
      }
      this.launch(job.id);
      capacity--;
    }
  }

  private launch(jobId: string): Active {
    const entry: { current: AbortController; done: Promise<RunnerResult> } = {
      current: new AbortController(),
      done: Promise.resolve({ last: undefined }),
    };
    this.active.set(jobId, entry);
    entry.done = this.runJob(jobId, entry)
      .catch((e: unknown): RunnerResult => {
        this.log.error({ err: e, jobId }, 'job runner failed');
        try {
          this.repo.updateJob(jobId, {
            status: 'failed',
            lastError: errorToJson(e),
            finishedAt: this.clock.now(),
          });
          this.emitJob(jobId, 'updated');
        } catch {
          // The database may be gone (shutdown); the job is recovered on the next start.
        }
        return { last: undefined };
      })
      .finally(() => {
        this.active.delete(jobId);
        this.waitingLock.delete(jobId);
        if (this.active.size === 0) for (const w of this.drainWaiters.splice(0)) w();
        this.pump();
      });
    return entry;
  }

  /**
   * v2 C2a: a job with a job-level lock (`BatchSubmit.holdLock`) takes it before its first step and keeps it until it
   * stops (finished, or parked for budget, held, paused or cancelled); then runs its steps. Nothing runs without it.
   */
  private async runJob(jobId: string, entry: Active): Promise<RunnerResult> {
    const opts = this.repo.jobOptions(jobId);
    const heldLock = typeof opts[HELD_LOCK] === 'string' ? opts[HELD_LOCK] : null;
    if (!heldLock) return this.runSteps(jobId, entry, null);
    // v2 C2c: a second job-level lock (a document of the same page), always taken after the page's, so two jobs holding
    // both can never wait on each other (every job takes them in this one order; no other job holds a lock while it
    // waits for another).
    const more = Array.isArray(opts[HELD_MORE])
      ? (opts[HELD_MORE] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const keys = [heldLock, ...more].sort();
    const job = this.requireJob(jobId);
    const releases: (() => void)[] = [];
    const release = () => {
      for (const r of releases.splice(0).reverse()) r();
    };
    try {
      for (const key of keys) {
        if (!this.locks.isFree(key)) this.setWaitingLock(jobId, 'lock', { lockKey: key, job: true });
        releases.push(
          await this.locks.acquire(
            key,
            { jobId, stepNo: 0, principalId: job.principalId },
            entry.current.signal,
          ),
        );
      }
      this.setWaitingLock(jobId, null);
      this.recheckOnRelock(jobId);
    } catch (e) {
      release();
      this.setWaitingLock(jobId, null);
      if (!entry.current.signal.aborted) throw e;
      // Stopped, cancelled or paused while waiting for the lock: nothing ran.
      const now = this.requireJob(jobId);
      if (this.stopped) this.repo.updateJob(jobId, { status: 'queued', currentStep: null });
      else if (now.cancelRequested) this.finishCancelled(jobId);
      else if (now.pauseRequested) {
        this.repo.updateJob(jobId, { status: 'paused', pauseRequested: false, currentStep: null });
        this.emitJob(jobId, 'updated');
      } else this.repo.updateJob(jobId, { status: 'queued', currentStep: null });
      return { last: undefined };
    }
    try {
      return await this.runSteps(jobId, entry, keys.length > 1 ? keys : heldLock);
    } finally {
      release();
    }
  }

  /**
   * CR-2026-11 (CR-06): a job that took its job-level lock again (it was held for a writes pause or read-only, parked for
   * budget, paused, or the bridge restarted) after its `bridge.expect` check but before anything was sent checks again:
   * the page may have changed while the lock was free. Once a write has been sent the check is not repeated (the job's
   * own writes changed what it checked); the writes after it carry their own checks (a chained If-Match, an in-step
   * check), as before.
   */
  private recheckOnRelock(jobId: string): void {
    const steps = this.repo.steps(jobId);
    const checks = steps.filter((s) => s.opId === EXPECT_STEP && s.status === 'succeeded');
    if (checks.length === 0) return;
    const sent = steps.some(
      (s) => s.opKind !== 'read' && (s.status !== 'pending' || s.maybeSent || s.firstSentAt !== null),
    );
    if (sent) return;
    for (const s of checks) {
      this.repo.updateStep(jobId, s.stepNo, {
        status: 'pending',
        resultSummary: null,
        resultArtifactId: null,
        finishedAt: null,
      });
    }
    this.refreshProgress(jobId);
  }

  private async runSteps(
    jobId: string,
    entry: Active,
    heldLock: string | readonly string[] | null,
  ): Promise<RunnerResult> {
    let job = this.requireJob(jobId);
    this.repo.updateJob(jobId, {
      status: 'running',
      waitReason: null,
      resumeAt: null,
      startedAt: job.startedAt ?? this.clock.now(),
    });
    this.emitJob(jobId, 'updated');
    let last: StepOutcome | undefined;
    const values: unknown[] = [];
    for (;;) {
      job = this.requireJob(jobId);
      let step = this.repo.nextStep(jobId);
      if (step && job.kind === 'upload_image' && this.bindUploadStep(jobId, step)) {
        step = this.repo.nextStep(jobId);
      }
      if (!step) {
        await this.flushDeferred(job, entry.current.signal);
        this.finish(jobId);
        return { last, values };
      }
      const recovering = step.status === 'running';
      if (!recovering) {
        if (job.cancelRequested) {
          await this.flushDeferred(job, entry.current.signal);
          this.finishCancelled(jobId);
          return { last, values };
        }
        if (job.pauseRequested) {
          this.repo.updateJob(jobId, { status: 'paused', pauseRequested: false, currentStep: null });
          this.emitJob(jobId, 'updated');
          return { last, values };
        }
        if (this.stopped) {
          this.repo.updateJob(jobId, { status: 'queued', currentStep: null });
          return { last, values };
        }
        // Chunk 8 (F-02): the gate decided when the work was accepted; ask again before each new step, so a revoked
        // connection or a lowered scope also stops work already queued. A step being recovered is still finished.
        const denied = await this.recheckPolicy(job, step);
        if (denied) {
          last = { kind: 'failed', error: denied, uncertain: false };
          await this.flushDeferred(job, entry.current.signal);
          this.stopForPolicy(job, step, denied);
          return { last, values };
        }
      }
      entry.current = new AbortController();
      this.repo.updateJob(jobId, { currentStep: step.stepNo });
      // v2 C2b: a write to a page this job created from a template gets the copy's ids now; v2 C2a: a write that chains
      // its If-Match from an earlier step gets it now (both stored before anything is sent).
      let bound = this.bindIds(job, step);
      if (!bound) {
        step = this.repo.step(jobId, step.stepNo) ?? step; // the params as just bound
        bound = this.bindBody(job, step);
      }
      if (!bound) {
        step = this.repo.step(jobId, step.stepNo) ?? step;
        bound = this.bindFrom(job, step);
      }
      if (!bound) {
        step = this.repo.step(jobId, step.stepNo) ?? step;
        bound = this.bindIfMatch(job, step);
      }
      if (bound) {
        last = { kind: 'failed', error: bound, uncertain: false };
        this.repo.updateStep(jobId, step.stepNo, {
          status: 'failed',
          error: errorToJson(bound),
          finishedAt: this.clock.now(),
        });
        this.emitStep(job, step.stepNo);
        this.recordStepFailure(job, step.opId, step.stepNo, bound);
        this.refreshProgress(jobId);
        this.repo.updateJob(jobId, { lastError: errorToJson(bound) });
        this.emitJob(jobId, 'updated');
        if (job.onError === 'stop') {
          await this.flushDeferred(job, entry.current.signal);
          this.finish(jobId);
          return { last, values };
        }
        continue;
      }
      step = this.repo.step(jobId, step.stepNo) ?? step;
      const writeInfo = this.writeInfo(job, step);
      this.notifyBeforeWrite(writeInfo);
      const outcome = await this.executor.execute(job, step, entry.current.signal, {
        storeResult: job.kind !== 'paginate_all',
        heldLock,
      });
      // v2 A2: the repository tree re-reads what the write changed, in this job, before it moves on.
      await this.notifyAfterWrite(writeInfo, outcome, entry.current.signal);
      if (outcome.kind !== 'aborted' && outcome.kind !== 'held') last = outcome;
      if (outcome.kind === 'succeeded') values.push(outcome.value);
      switch (outcome.kind) {
        case 'succeeded':
          if (job.kind === 'paginate_all') this.handlePage(job, step.stepNo, outcome.value);
          this.emitStep(job, step.stepNo);
          this.refreshProgress(jobId);
          this.emitJob(jobId, 'updated');
          continue;
        case 'failed': {
          this.emitStep(job, step.stepNo);
          this.recordStepFailure(job, step.opId, step.stepNo, outcome.error);
          this.refreshProgress(jobId);
          this.repo.updateJob(jobId, {
            lastError: errorToJson(outcome.error),
            ...(outcome.uncertain ? { uncertain: true } : {}),
          });
          this.emitJob(jobId, 'updated');
          if (job.onError === 'stop') {
            await this.flushDeferred(job, entry.current.signal);
            this.finish(jobId);
            return { last, values };
          }
          continue;
        }
        case 'budget':
          this.repo.updateJob(jobId, {
            status: 'waiting_budget',
            resumeAt: outcome.retryAtMs,
            waitReason: { tier: outcome.error.tier, opId: step.opId, stepNo: step.stepNo },
            currentStep: null,
          });
          this.emitJob(jobId, 'updated');
          this.scheduleResume(jobId, outcome.retryAtMs);
          return { last, values };
        case 'held':
          this.repo.updateJob(jobId, {
            status: 'queued',
            waitReason: { held: outcome.reason },
            currentStep: null,
          });
          this.emitJob(jobId, 'updated');
          return { last, values };
        case 'aborted':
          if (this.stopped) {
            this.repo.updateJob(jobId, { status: 'queued', currentStep: null });
            return { last, values };
          }
          continue; // cancel or pause: the loop head decides
      }
    }
  }

  /** paginate_all: store the page's items within the caps, then queue the next page as a new step. */
  private handlePage(job: JobView, stepNo: number, value: unknown): void {
    const opts = this.repo.jobOptions(job.id) as {
      artifactId?: string;
      maxItems?: number;
      maxPages?: number;
      maxBytes?: number;
    };
    const artifactId = opts.artifactId!;
    const page = (value ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
    const data = Array.isArray(page.data) ? (page.data as unknown[]) : [];
    const art = this.repo.artifact(artifactId)!;
    const maxItems = opts.maxItems ?? this.settings.paginate.maxItems;
    const maxBytes = opts.maxBytes ?? this.settings.paginate.maxBytes;
    const maxPages = opts.maxPages ?? this.settings.paginate.maxPages;
    let bytes = art.bytes;
    let count = art.itemCount;
    const take: unknown[] = [];
    let truncated: string | null = null;
    for (const item of data) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (count + 1 > maxItems) {
        truncated = `item cap (${maxItems}) reached`;
        break;
      }
      if (bytes + size > maxBytes) {
        truncated = `size cap (${maxBytes} bytes) reached`;
        break;
      }
      take.push(item);
      bytes += size;
      count++;
    }
    const totals = this.repo.appendItems(artifactId, take);
    const more = page.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor.length > 0;
    if (!truncated && more && stepNo >= maxPages) truncated = `page cap (${maxPages}) reached`;
    if (truncated) this.repo.markTruncated(artifactId, truncated);
    else if (more) {
      const step = this.repo.step(job.id, stepNo)!;
      const params = this.repo.stepParams(step);
      const next: OpParams = { ...params, query: { ...params.query, cursor: page.nextCursor } };
      const def = getOperation(step.opId)!;
      this.repo.appendStep(job.id, this.prepare(def, next, {}).step);
    }
    this.repo.updateJob(job.id, {
      result: {
        artifactId,
        items: totals.itemCount,
        bytes: totals.bytes,
        pages: stepNo,
        truncated: truncated !== null,
        ...(truncated ? { truncatedReason: truncated } : {}),
      },
    });
  }

  private finish(jobId: string): void {
    const counts = this.repo.stepCounts(jobId);
    const job = this.requireJob(jobId);
    const failed = counts.failed + counts.uncertain;
    const status: JobStatus = failed > 0 ? 'failed' : 'succeeded';
    let result = job.result ?? {};
    if (job.kind !== 'paginate_all') {
      result = { stepsSucceeded: counts.succeeded, stepsFailed: failed, stepsNotRun: counts.pending };
      if (job.kind === 'single_op') {
        const s = this.repo.step(jobId, 1);
        if (s) result = { ...result, step: s.resultSummary, resultArtifactId: s.resultArtifactId };
      }
      if (job.kind === 'upload_image') {
        // v2 D3: folders may come first, and a verify and a hide step after.
        const all = this.repo.steps(jobId);
        const assetStep = all.find((s) => s.opId === 'createImageAsset');
        if (assetStep?.status === 'succeeded') result = { ...result, asset: assetStep.resultSummary };
        const folders = all
          .filter((s) => s.opId === 'createAssetFolder' && s.status === 'succeeded')
          .map((s) => s.resultSummary);
        if (folders.length > 0) result = { ...result, folders };
        const verify = all.find((s) => s.opId === UPLOAD_VERIFY_STEP);
        if (verify?.status === 'succeeded') result = { ...result, stored: verify.resultSummary };
        const hidden = all.find((s) => s.opId === 'updateAsset');
        if (hidden) result = { ...result, hidden: hidden.status === 'succeeded' };
      }
      // v2 C1: what the read after each verified page write found, on the job itself. v2 C2a: and what every generic
      // verify step found (`bridge.verify`), the same way.
      const verifications = this.repo
        .steps(jobId)
        .filter(
          (s) => s.status === 'succeeded' && (s.options.verifyAfterWrite === true || isInternalStep(s.opId)),
        )
        .map((s) => {
          // A long verification may have gone to the step's result artefact: read it whole then.
          const summary = (s.resultSummary ?? {}) as { verification?: unknown; truncated?: unknown };
          const whole =
            summary.verification === undefined && summary.truncated === true
              ? ((this.repo.stepResult(s) ?? {}) as { verification?: unknown })
              : summary;
          return { stepNo: s.stepNo, verification: whole.verification };
        })
        .filter((s) => s.verification !== undefined)
        .map((s): Record<string, unknown> => ({
          stepNo: s.stepNo,
          ...(s.verification as Record<string, unknown>),
        }));
      if (verifications.length > 0) {
        result = {
          ...result,
          verification: verifications.length === 1 ? verifications[0] : verifications,
          verified: verifications.every((v) => v.status === 'verified'),
        };
      }
    }
    this.refreshProgress(jobId);
    this.repo.updateJob(jobId, {
      status,
      result,
      currentStep: null,
      waitReason: null,
      uncertain: counts.uncertain > 0,
      finishedAt: this.clock.now(),
    });
    this.emitJob(jobId, 'updated');
  }

  private finishCancelled(jobId: string): void {
    this.repo.cancelOpenSteps(jobId);
    this.refreshProgress(jobId);
    this.repo.updateJob(jobId, {
      status: 'cancelled',
      currentStep: null,
      waitReason: null,
      cancelRequested: true,
      finishedAt: this.clock.now(),
    });
    this.emitJob(jobId, 'updated');
  }

  private cancelJob(jobId: string): JobView {
    const job = this.requireJob(jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    this.repo.updateJob(jobId, { cancelRequested: true });
    const active = this.active.get(jobId);
    if (active) {
      active.current.abort(new CancelledError({ jobId }));
      return this.emitJob(jobId, 'updated');
    }
    this.clearResume(jobId);
    this.finishCancelled(jobId);
    return this.requireJob(jobId);
  }

  private scheduleResume(jobId: string, at: number | null): void {
    this.clearResume(jobId);
    if (this.stopped) return;
    const delay = Math.max(0, (at ?? this.clock.now()) - this.clock.now());
    const t = this.clock.setTimeout(() => {
      this.resumeTimers.delete(jobId);
      try {
        const job = this.repo.job(jobId);
        if (job?.status === 'waiting_budget') {
          this.repo.updateJob(jobId, { status: 'queued', waitReason: { resumedAfterBudgetWait: true } });
          this.emitJob(jobId, 'updated');
          this.pump();
        }
      } catch (e) {
        this.log.warn({ err: e, jobId }, 'resume after budget wait failed');
      }
    }, delay);
    this.resumeTimers.set(jobId, t);
  }

  private clearResume(jobId: string): void {
    const t = this.resumeTimers.get(jobId);
    if (t) this.clock.clearTimeout(t);
    this.resumeTimers.delete(jobId);
  }

  private whenIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  // ============================================================================================ helpers

  private validate(opId: string, params: OpParams): OperationDef {
    const def = getOperation(opId);
    if (!def) throw new UnknownOperationError(opId);
    const parsed = operationInputSchema(opId).safeParse(params);
    if (!parsed.success) {
      throw new InvalidParamsError(
        opId,
        parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      );
    }
    return def;
  }

  /** Builds a step: mints client ids for creates that accept them (persisted with the step, before any send). */
  private prepare(def: OperationDef, params: OpParams, options: StepOptions): PreparedStep {
    const meta = opMeta(def.operationId);
    let p: OpParams = params;
    const clientIds: string[] = [];
    if (meta.clientId === 'body.id') {
      const body = { ...(params.body as Record<string, unknown> | undefined) };
      const supplied = body.id;
      if (supplied !== undefined && !isClientId(supplied)) {
        throw new InvalidParamsError(def.operationId, [
          { path: 'body.id', message: 'Must be a cuid2 id (8 or 24 chars)' },
        ]);
      }
      body.id = supplied ?? mintClientId();
      clientIds.push(body.id as string);
      p = { ...params, body };
    } else if (meta.clientId === 'body.resources[].id') {
      const body = { ...(params.body as { resources?: Record<string, unknown>[] } | undefined) };
      body.resources = (body.resources ?? []).map((r) => {
        const id = r.id ?? mintClientId();
        clientIds.push(id as string);
        return { ...r, id };
      });
      p = { ...params, body };
    }
    return {
      def,
      step: {
        opId: def.operationId,
        opKind: def.kind,
        params: p,
        options,
        clientIds,
        post: def.method === 'POST',
      },
    };
  }

  /** A project id that is known and served now; otherwise the typed refusal (nothing is queued or sent). */
  private requireProject(projectId: string | undefined): string {
    if (typeof projectId !== 'string' || projectId === '' || !this.projects.known(projectId)) {
      throw new UnknownProjectError(String(projectId));
    }
    const why = this.projects.unavailableReason(projectId);
    if (why !== null || !this.projects.client(projectId)) {
      throw new ProjectUnavailableError(
        this.projects.nameOf(projectId),
        why ?? `project "${this.projects.nameOf(projectId)}" is not available now`,
      );
    }
    return projectId;
  }

  /**
   * OPS2: a project paused and draining before its removal takes no new work (its queued and running jobs carry on).
   * Internal reads for work already admitted (the tree's re-reads after a write) are not affected.
   */
  private requireAdmission(projectId: string): string {
    const why = this.projects.admissionRefusal?.(projectId) ?? null;
    if (why !== null) throw new ProjectUnavailableError(this.projects.nameOf(projectId), why);
    return projectId;
  }

  private clientOf(projectId: string): LkClient {
    const lk = this.projects.client(projectId);
    if (!lk) {
      throw new ProjectUnavailableError(
        this.projects.nameOf(projectId),
        this.projects.unavailableReason(projectId) ?? 'not available now',
      );
    }
    return lk;
  }

  private createJob(
    projectId: string,
    kind: JobKind,
    title: string,
    origin: JobOrigin,
    priority: PriorityClass,
    onError: OnError,
    steps: readonly Pick<PreparedStep, 'step'>[],
    status: JobStatus,
    options?: Record<string, unknown>,
  ): JobView {
    const job = this.repo.insertJob({
      id: newJobId(),
      projectId,
      kind,
      title: title.slice(0, 500),
      origin,
      priority,
      status,
      onError,
      ...(options ? { options } : {}),
      steps: steps.map((s) => s.step),
    });
    this.events.emit('job', { type: 'created', job });
    return job;
  }

  private estimateFor(
    projectId: string,
    items: readonly { def: OperationDef | null; params: OpParams | undefined; opId?: string }[],
    priority: PriorityClass,
  ) {
    let reads = 0;
    let writes = 0;
    let createManyItems = 0;
    for (const { def, params, opId } of items) {
      if (!def) {
        reads += internalReads(opId ?? '', params); // the bridge's own check and verify steps read only
        continue;
      }
      if (def.kind === 'read') {
        reads++;
        continue;
      }
      const meta = opMeta(def.operationId);
      if (meta.reader && (def.versioned || meta.guard || meta.journal === 'pre-image')) reads++;
      if (def.itemsFrom) {
        const list = (params?.body as { resources?: unknown[] } | undefined)?.resources;
        createManyItems += Array.isArray(list) ? list.length : 0;
      } else writes++;
    }
    return this.clientOf(projectId).governor.estimate({ reads, writes, createManyItems, priority });
  }

  private guardContext(projectId: string) {
    const bridge = this.readOnly();
    const own = this.projects.readOnly(projectId);
    return {
      readOnly: bridge || own,
      allowMemberAdmin: this.settings.allowMemberAdmin,
      project: { name: this.projects.nameOf(projectId), projectOnly: own && !bridge },
    };
  }

  /** The bridge-wide read-only flag: the runtime override if set, else LK_READ_ONLY. */
  private readOnly(): boolean {
    return this.readOnlyOverride ?? this.settings.readOnly;
  }

  /** Why a new write to `projectId` may not start now: bridge-wide or project read-only, or a writes pause. */
  private writeHold(projectId: string): WriteHold | null {
    if (this.readOnly() || this.projects.readOnly(projectId)) return 'read_only';
    if (this.writesPaused) return 'writes_paused';
    return null;
  }

  /** Drops stale "held" reasons once a job's work may run again. */
  private clearHolds(): void {
    for (const job of this.repo.jobsWithStatus(['queued'])) {
      const held = job.waitReason?.held;
      if (!held) continue;
      const still =
        held === 'project_unavailable'
          ? !this.projects.client(job.projectId)
          : this.writeHold(job.projectId) !== null;
      if (!still) {
        this.repo.updateJob(job.id, { waitReason: null });
        this.emitJob(job.id, 'updated');
      }
    }
  }

  private setWaitingLock(jobId: string, waiting: 'lock' | null, detail?: Record<string, unknown>): void {
    if (waiting) {
      this.waitingLock.add(jobId);
      this.repo.updateJob(jobId, { status: 'waiting_lock', waitReason: { ...detail } });
      this.emitJob(jobId, 'updated');
    } else if (this.waitingLock.delete(jobId)) {
      this.repo.updateJob(jobId, { status: 'running', waitReason: null });
      this.emitJob(jobId, 'updated');
    }
  }

  private refreshProgress(jobId: string): void {
    const c = this.repo.stepCounts(jobId);
    this.repo.updateJob(jobId, {
      stepsDone: c.succeeded,
      stepsFailed: c.failed + c.uncertain,
      stepsTotal: c.pending + c.running + c.succeeded + c.failed + c.uncertain + c.cancelled,
    });
  }

  /** The job, or JobNotFoundError; with `projectId`, a job of another project is not found either. */
  private requireJob(jobId: string, projectId?: string): JobView {
    const job = this.repo.job(jobId);
    if (!job || (projectId !== undefined && job.projectId !== projectId)) throw new JobNotFoundError(jobId);
    return job;
  }

  private emitJob(jobId: string, type: 'created' | 'updated'): JobView {
    const job = this.requireJob(jobId);
    this.events.emit('job', { type, job });
    return job;
  }

  private emitStep(job: JobView, stepNo: number): void {
    const step = this.repo.step(job.id, stepNo);
    if (step) {
      this.events.emit('step', {
        projectId: job.projectId,
        jobId: job.id,
        principalId: job.principalId,
        profile: job.profile,
        step,
      });
    }
  }

  private controlsView(projectId?: string): ControlsView {
    const base = {
      writesPaused: this.writesPaused,
      draining: this.draining,
      readOnly: this.readOnly(),
      readOnlyOverride: this.readOnlyOverride,
      writersMax: this.writers.max,
      allowMemberAdmin: this.settings.allowMemberAdmin,
    };
    if (projectId === undefined) return base;
    const own = this.projects.readOnly(projectId);
    return {
      ...base,
      readOnly: base.readOnly || own,
      project: {
        id: projectId,
        name: this.projects.nameOf(projectId),
        readOnly: own,
        available: this.projects.client(projectId) !== undefined,
      },
    };
  }

  private controlsChanged(): ControlsView {
    const v = this.controlsView();
    this.events.emit('controls', v);
    return v;
  }

  private recordLkError(
    err: BridgeLkError,
    ref: {
      projectId: string;
      opId: string;
      jobId?: string;
      stepNo?: number;
      principalId?: string;
      profile?: string;
    },
  ): void {
    this.recordError({
      projectId: ref.projectId,
      opId: ref.opId,
      jobId: ref.jobId,
      stepNo: ref.stepNo,
      principalId: ref.principalId,
      profile: ref.profile,
      status: err.status,
      code: err.code,
      message: err.message,
      issues: err.errors,
      requestId: err.requestId,
      retryable: err.retryable,
      classification: err.classification,
      detail: err.toJSON(),
    });
  }

  /** Step failures that are not LK errors (those were recorded per call): refusals, conflicts, uncertainty. */
  private recordStepFailure(job: JobView, opId: string, stepNo: number, error: JobsError): void {
    const jobId = job.id;
    if (error instanceof LkOperationError) return;
    if (error instanceof VersionConflictError && error.cause instanceof BridgeLkError) return;
    const classification =
      error instanceof UnsupportedBlockLossError
        ? 'user_fixable'
        : error instanceof VersionConflictError
          ? 'conflict'
          : error instanceof UncertainOutcomeError
            ? 'upstream'
            : 'bridge';
    this.recordError({
      projectId: job.projectId,
      opId,
      jobId,
      stepNo,
      code: error.code,
      message: error.message,
      retryable: false,
      classification,
      detail: error.toJSON(),
      principalId: job.principalId,
      profile: job.profile,
    });
  }

  // ============================================================================================ policy

  /**
   * Puts every operation to the policy gate before anything is queued. Throws `PolicyDeniedError` (recorded with
   * classification `policy`) on any deny; on any propose, hands the whole request to the proposal sink and returns
   * its result; otherwise returns null. A gate that throws counts as a deny (fail closed).
   */
  private async authorize(
    items: readonly AuthItem[],
    origin: JobOrigin,
    jobKind: JobKind,
    project: string,
    meta: Omit<ProposalMeta, 'kind' | 'origin' | 'project'>,
    lifecycle?: LifecycleMarker,
    forceProposal = false,
    extra: { readonly staging?: boolean } = {},
  ): Promise<ProposalCaptured | null> {
    const principal = origin.principal ?? SYSTEM_PRINCIPAL;
    const batch = jobKind === 'batch_ops';
    let propose = false;
    for (let i = 0; i < items.length; i++) {
      const { opId, meta: opMetaForGate, params } = items[i]!;
      let decision: PolicyDecision;
      try {
        decision = await this.policyGate.authorize(principal, opMetaForGate, params, {
          origin,
          project,
          jobKind,
          phase: 'entry',
          ...(batch ? { stepIndex: i } : {}),
          ...(extra.staging === true ? { staging: true } : {}),
        });
      } catch (e) {
        decision = {
          decision: 'deny',
          reason: `the policy gate failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (decision.decision === 'deny') {
        throw this.policyDenied(
          new PolicyDeniedError(opId, decision.reason, principal.principalId, batch ? i : undefined),
          principal,
          project,
        );
      }
      if (decision.decision === 'propose') propose = true;
    }
    // v2 D1.1 (ADR 0039): bridge code asked for a proposal whatever the gate said (the dashboard's "Propose a fix").
    if (forceProposal && items.some((it) => it.meta.kind !== 'read')) propose = true;
    // v2 C2a (ADR 0032): the write guard sees the whole request, once the gate has let every operation through.
    let canonical: ProposalMeta['canonical'];
    if (this.writeGuard && items.some((it) => it.meta.kind !== 'read')) {
      let verdict: Awaited<ReturnType<WriteGuard['entry']>>;
      try {
        verdict = await this.writeGuard.entry({
          project,
          principal,
          origin,
          jobKind,
          items: items.map((it) => ({ op: it.opId, params: it.params, options: it.options })),
          ...(meta.extras?.prefetched ? { prefetched: meta.extras.prefetched } : {}),
          gate: propose ? 'propose' : 'allow',
          ...(lifecycle ? { lifecycle } : {}),
          ...(meta.onError ? { onError: meta.onError } : {}),
        });
      } catch (e) {
        verdict = {
          decision: 'deny',
          opId: items[0]?.opId ?? 'operation',
          reason: `the write guard failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (verdict.decision === 'deny') {
        throw this.policyDenied(
          new PolicyDeniedError(
            verdict.opId,
            verdict.reason,
            principal.principalId,
            batch ? verdict.stepIndex : undefined,
          ),
          principal,
          project,
        );
      }
      if (verdict.decision === 'propose_canonical') {
        propose = true;
        canonical = { reason: verdict.reason, changes: verdict.changes };
      }
    }
    if (!propose) return null;
    const ops: ProposedOp[] = items.map(({ opId, params, options }) => ({
      op: opId,
      params,
      ...options,
    }));
    try {
      const { proposalId, summary } = await this.proposalSink.capture(principal, ops, {
        ...meta,
        kind: jobKind,
        origin,
        project,
        ...(canonical ? { canonical } : {}),
      });
      return {
        status: 'proposal_captured',
        proposalId,
        ...(summary !== undefined ? { summary } : {}),
        ...(canonical ? { canonical } : {}),
      };
    } catch (e) {
      if (e instanceof PolicyDeniedError) throw this.policyDenied(e, principal, project);
      // A sink that refuses with a typed reason (a guard, invalid params, a failed read) keeps it.
      if (e instanceof JobsError) throw e;
      throw new JobsError(
        'BRIDGE_ERROR',
        `The proposal sink failed: ${e instanceof Error ? e.message : String(e)}`,
        {},
        {
          cause: e,
        },
      );
    }
  }

  /**
   * Chunk 8 (F-02): the live policy decision for the next step of a job that acts for an agent. Internal work (the
   * `system` principal) and work the owner approved (`approvedBy`; the owner's approval wins over the proposer's scope,
   * docs/policy.md) are not asked again. Anything but `allow` stops the job: `propose` too, because the work was
   * accepted to run directly. A gate that throws counts as a deny.
   */
  private async recheckPolicy(job: JobView, step: StepView): Promise<PolicyDeniedError | null> {
    if (job.principalId === SYSTEM_PRINCIPAL.principalId || job.approvedBy !== null) return null;
    const def = getOperation(step.opId);
    if (!def) return null; // a custom step (the upload PUT): the registry steps around it are checked
    const principal: Principal = {
      principalId: job.principalId,
      profile: job.profile,
      label: job.origin.principal?.label ?? job.principalId,
    };
    // The stored origin never carries a live approval token (it serialises to `{ proposalId }`): drop it.
    const { approval: _approval, ...origin } = job.origin;
    let decision: PolicyDecision;
    try {
      decision = await this.policyGate.authorize(
        principal,
        policyOpMeta(def, step.options),
        this.repo.stepParams(step),
        {
          origin,
          project: job.projectId,
          jobKind: job.kind,
          phase: 'execute',
          ...(job.kind === 'batch_ops' ? { stepIndex: step.stepNo - 1 } : {}),
          ...(job.kind === 'upload_image' && this.repo.jobOptions(job.id).staging === true
            ? { staging: true }
            : {}),
        },
      );
    } catch (e) {
      decision = {
        decision: 'deny',
        reason: `the policy gate failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (decision.decision === 'allow') return null;
    const reason =
      decision.decision === 'deny'
        ? `${decision.reason} (checked again before step ${step.stepNo}; the rest of the job was not run)`
        : `the connection's scope changed to "propose" after this job was accepted, so the rest of it was not run; ` +
          'submit the remaining work again to make a proposal';
    return new PolicyDeniedError(step.opId, reason, job.principalId);
  }

  /** Fails `step` with the policy refusal, cancels the steps after it, and finishes the job (failed). */
  private stopForPolicy(job: JobView, step: StepView, error: PolicyDeniedError): void {
    this.repo.updateStep(job.id, step.stepNo, {
      status: 'failed',
      error: errorToJson(error),
      finishedAt: this.clock.now(),
    });
    this.recordError({
      projectId: job.projectId,
      opId: step.opId,
      jobId: job.id,
      stepNo: step.stepNo,
      code: error.code,
      message: error.message,
      retryable: false,
      classification: 'policy',
      detail: error.toJSON(),
      principalId: job.principalId,
      profile: job.profile,
    });
    this.repo.cancelOpenSteps(job.id);
    this.repo.updateJob(job.id, { lastError: errorToJson(error) });
    this.emitStep(job, step.stepNo);
    this.finish(job.id);
  }

  private policyDenied(error: PolicyDeniedError, principal: Principal, project: string): PolicyDeniedError {
    this.recordError({
      projectId: project,
      opId: error.opId,
      code: error.code,
      message: error.message,
      retryable: false,
      classification: 'policy',
      detail: error.toJSON(),
      principalId: principal.principalId,
      profile: principal.profile,
    });
    return error;
  }

  private recordError(input: ErrorInput): void {
    try {
      const rec = this.repo.recordError(input);
      this.events.emit('error', rec);
    } catch (e) {
      this.log.warn({ err: e }, 'could not record an error');
    }
  }

  /** For tests and the admin API: the underlying database handle. */
  get database(): Db {
    return this.db;
  }
}

/** Fills in the default principal (`system`) and checks a supplied one is usable. */
function normaliseOrigin(origin: JobOrigin): JobOrigin {
  const p = origin.principal;
  if (p === undefined) return { ...origin, principal: SYSTEM_PRINCIPAL };
  for (const k of ['principalId', 'profile', 'label'] as const) {
    if (typeof p[k] !== 'string' || p[k].length === 0) {
      throw new InvalidParamsError('origin', [{ path: `origin.principal.${k}`, message: 'Required' }]);
    }
  }
  return origin;
}

function stepOptions(o: StepOptions): StepOptions {
  return {
    ...(o.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
    ...(o.confirm === 'cascade' ? { confirm: 'cascade' as const } : {}),
    // v2 C1: set by bridge code only (the tools never pass these from an agent's input).
    ...(o.verifyAfterWrite === true ? { verifyAfterWrite: true } : {}),
    ...(o.journalOperation ? { journalOperation: o.journalOperation } : {}),
    ...(o.replan && typeof o.replan.planner === 'string'
      ? { replan: { planner: o.replan.planner, input: o.replan.input } }
      : {}),
    // v2 C2a: set by bridge code only.
    ...(o.ifMatchFrom && Number.isInteger(o.ifMatchFrom.step)
      ? {
          ifMatchFrom: {
            step: o.ifMatchFrom.step,
            ...(typeof o.ifMatchFrom.key === 'string' ? { key: o.ifMatchFrom.key } : {}),
          },
        }
      : {}),
    ...(o.expectCurrent && typeof o.expectCurrent.hash === 'string'
      ? {
          expectCurrent: {
            state: o.expectCurrent.state,
            hash: o.expectCurrent.hash,
            ...(o.expectCurrent.label ? { label: o.expectCurrent.label } : {}),
          },
        }
      : {}),
    ...(o.deferTreeReread === true ? { deferTreeReread: true } : {}),
    ...(o.journalPreImage !== undefined ? { journalPreImage: o.journalPreImage } : {}),
    // v2 D2: a folder's cascade delete keeps what it removes in its own journal entry.
    ...(o.journalPreImageWith !== undefined ? { journalPreImageWith: o.journalPreImageWith } : {}),
    // v2 C2b: set by bridge code only.
    ...(o.bindIds && Number.isInteger(o.bindIds.step) ? { bindIds: { step: o.bindIds.step } } : {}),
    // v2 D1: set by bridge code only.
    ...(o.bindBody && Number.isInteger(o.bindBody.step) && typeof o.bindBody.key === 'string'
      ? { bindBody: { step: o.bindBody.step, key: o.bindBody.key } }
      : {}),
    ...(o.judgedInLock === true ? { judgedInLock: true } : {}),
    // v2 D3: set by bridge code only.
    ...(o.bindFrom &&
    Number.isInteger(o.bindFrom.step) &&
    (o.bindFrom.to === 'body.folderId' || o.bindFrom.to === 'path.assetId')
      ? { bindFrom: { step: o.bindFrom.step, to: o.bindFrom.to } }
      : {}),
  };
}

export function createJobEngine(options: CreateJobEngineOptions): JobEngine {
  return new JobEngine(options);
}
