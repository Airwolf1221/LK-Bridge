/**
 * The job engine (PLAN §6): everything that talks to LegendKeeper runs as a persisted step, through the governor,
 * with writer slots, locks, guards and the write journal. See src/jobs/README.md for the interface.
 */
import { LABEL_SIZE_REFUSAL, LABEL_SIZE_UNSUPPORTED, LABEL_SIZE_WRITABLE } from '../maps/features.js';
import { randomBytes } from 'node:crypto';
import { WRITERS_LIMIT, WRITERS_MIN, type JobsSettings } from '../config/jobs.js';
import type { Db } from '../db/open.js';
import type { LkClient } from '../lk/client.js';
import type { ProjectsRuntime } from '../projects/registry.js';
import type { ProjectScope } from '../projects/types.js';
import { BridgeLkError, BudgetWaitError, RestartWaitError } from '../lk/errors.js';
import { sleep, systemClock, type Clock, type TimerHandle } from '../lk/governor/clock.js';
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
  isBridgeStep,
  isInternalStep,
  LMR_STEP,
  RECORD_STEP,
  VERIFY_STEP,
  type DocumentChecker,
  type Filler,
  type MapChecker,
  type RegisteredChecker,
} from './internal-steps.js';
import type { WriteGuard } from './write-guard.js';
import type { LmrPlan, LmrPlanInput, LmrPlanner } from './lmr-hook.js';
import {
  ALLOW_ALL_GATE,
  DENY_PROPOSALS_SINK,
  policyOpMeta,
  type PolicyDecision,
  type PolicyGate,
  type PolicyOpMeta,
  type ProposalJobOptions,
  type ProposalMeta,
  type ProposalExtras,
  type ProposalSink,
  type ProposedOp,
  type RailDecision,
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
import type { Rebaser } from './rebase.js';
import {
  SYSTEM_PRINCIPAL,
  TERMINAL_JOB_STATUSES,
  type BatchSubmit,
  type ControlsView,
  type InternalReadOptions,
  type ReadInfo,
  type WriteObserver,
  type SkippedItem,
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
  type ResumableShape,
  type StepOptions,
  type StepSpec,
  type StepView,
  type WaitForShape,
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

/**
 * CR-2026-11-R3 (fix A): waits for every promise to settle, or `ms` milliseconds at most (no bound when undefined).
 * Real time, on purpose: a shutdown's limits are wall-clock limits whatever clock the engine runs on.
 */
async function settleWithin(all: readonly Promise<unknown>[], ms: number | undefined): Promise<void> {
  const settled = Promise.allSettled(all);
  if (ms === undefined) {
    await settled;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
}

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
 * CR-2026-11-R3 (R3-62): the largest check (in estimated reads) that runs again whole when its job goes on after a wait
 * before its first write (R2-29); a larger one runs again light (`recheckOnRelock`).
 */
export const RELOCK_RECHECK_MAX = 300;
/** CR-2026-11-R3 (R3-64): a running job gives the event loop a turn at least this often (in steps). */
const YIELD_EVERY_STEPS = 10;
/**
 * v2 C2c: the further job-level locks (`BatchSubmit.holdDocument`, `holdAlso`), stored with `heldLock` as one list. A job
 * holding several takes them in sorted key order, so two such jobs can never wait on each other.
 */
const HELD_MORE = 'heldMore';
/** v2 C2c: the lifecycle marker (`BatchSubmit.lifecycle`), stored in the job's options for the guard inside the lock. */
export const LIFECYCLE_OPTION = 'lifecycle';
/** v3 F3d (ADR 0058): a job that can be resumed after it stops part-way (`BatchSubmit.resumable`), in its options. */
export const RESUMABLE_OPTION = 'resumable';
/** B6 (ADR 0061 part B decision 6): the verify steps a Resume read again (job option). */
const REVERIFIED_OPTION = 'reverified';

/** A verify step's recorded verification status (`verified`, `mismatch`, `not_checked`), or null. */
function verificationStatus(s: StepView): string | null {
  const v = (s.resultSummary as { verification?: { status?: unknown } } | null)?.verification;
  return typeof v?.status === 'string' ? v.status : null;
}
/** v3 F3d (ADR 0058): what a job waits for before its first step (`BatchSubmit.waitFor`), in its options. */
export const WAIT_FOR_OPTION = 'waitFor';

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
  /** v3 F3d amendment (ADR 0058, A): rebasers of an item's write on a conflict, by name (src/jobs/rebase.ts). */
  private readonly rebasers = new Map<string, Rebaser>();
  /** v2 C2a: the write guard (protected canonical facts), asked at entry and inside the lock. */
  private writeGuard: WriteGuard | undefined;
  /** v3 F3d (ADR 0058): judges a job's `waitFor` (`setWaitForCheck`). */
  private waitForCheck: ((w: WaitForShape) => string | null) | undefined;
  /** v3 F2: the Last Major Revision planner (src/lmr/), asked about every caller's write request. */
  private lmrPlanner: LmrPlanner | undefined;
  private assetDeleteKeeper: AssetDeleteKeeper | undefined;
  private continueGuard: ((projectId: string, jobId: string) => string | null) | undefined;
  /** v2 C2c: the lifecycle record's handler (`bridge.record` steps). */
  /** v2 C2c: the `bridge.record` handlers by store (`lifecycle`; v2 D1 `chronology`). */
  private readonly recordHandlers = new Map<string, RecordHandler>();
  /** v2 D1: the document checkers of `bridge.expect` (`kind: 'document'`), by name. */
  private readonly checkers = new Map<string, DocumentChecker>();
  /** v2 D2: the map checkers of `bridge.expect` (`kind: 'map'`) and `bridge.verify` (`kind: 'mapChecked'`), by name. */
  private readonly mapCheckers = new Map<string, MapChecker>();
  /** v3 F3a (ADR 0050): the asynchronous checkers of `bridge.expect` and `bridge.verify` (`kind: 'registered'`). */
  private readonly asyncCheckers = new Map<string, RegisteredChecker>();
  /** v3 F3a (ADR 0050): the fillers of `StepOptions.fill`, by name. */
  private readonly fillers = new Map<string, Filler>();
  private readonly etagVersions: ((projectId: string) => boolean) | undefined;
  private readOnlyOverride: boolean | null;
  private writesPaused: boolean;
  private draining = false;
  /**
   * CR-2026-11-R3 (fix A): the bridge is stopping for a restart (`stopForRestart`): no new work, every job parked at
   * its next step boundary, every wait ended.
   */
  private restarting = false;
  /** Ends every lock and writer-slot wait of every job when the bridge restarts (never a request in flight). */
  private readonly restartAbort = new AbortController();
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
      relockLight: (jobId, stepNo) => this.lightRechecks.has(`${jobId}:${stepNo}`),
      relockLightDone: (jobId, stepNo) => this.lightRechecks.delete(`${jobId}:${stepNo}`),
      isRelockCheck: (checker) => this.relockChecks.has(checker),
      customSteps: o.customSteps,
      planner: (name) => this.planners.get(name),
      rebaser: (name) => this.rebasers.get(name),
      sleep: (ms, signal) => sleep(this.clock, ms, signal),
      recordVerifyMismatch: (job, step, v) => this.recordVerifyMismatch(job, step, v),
      writeGuard: () => this.writeGuard,
      recordHandler: (store) => this.recordHandlers.get(store),
      checker: (name) => this.checkers.get(name),
      mapChecker: (name) => this.mapCheckers.get(name),
      asyncChecker: (name) => this.asyncCheckers.get(name),
      filler: (name) => this.fillers.get(name),
      ...(o.etagVersions ? { etagVersions: o.etagVersions } : {}),
      assetDeleteKeeper: () => this.assetDeleteKeeper,
      onRead: (info) => this.notifyRead(info),
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
   * unfinished job `queued` (or `waiting_budget`) for the next start. CR-2026-11-R3 (fix A): `waitMs` bounds the wait
   * for running steps (a request in flight is left to the start-up recovery, which verifies before re-sending).
   */
  async stop(waitMs?: number): Promise<void> {
    this.stopped = true;
    this.offProjects();
    for (const t of this.resumeTimers.values()) this.clock.clearTimeout(t);
    this.resumeTimers.clear();
    for (const a of this.active.values()) a.current.abort(new CancelledError());
    for (const release of [...this.jobWaiters]) release();
    await settleWithin(
      [...this.active.values()].map((a) => a.done),
      waitMs,
    );
    for (const release of [...this.jobWaiters]) release();
    this.started = false;
  }

  /**
   * CR-2026-11-R3 (fix A, the owner's clean shutdown): the first half of a stop for a restart (SIGTERM). From now on
   * nothing new is accepted (`BRIDGE_RESTARTING`); every running job stops at its next step boundary and is left
   * `queued`, with `waitReason.restart`, for the next start (where it continues by itself, its checks run again before
   * its first write as after any restart); lock and writer-slot waits end at once; a job parked for budget keeps its
   * time; a job waiting for an approval or a pack version stays queued. Requests in flight finish: a step is never cut
   * part-way by this. Resolves once no job runs, or after `graceMs` with the ids of the jobs still in a step (a request
   * still in flight); `stop()` follows. The governors' waits are ended by the runtime (`ProjectRegistry.stopWaits`).
   */
  async stopForRestart(
    graceMs: number,
  ): Promise<{ readonly parked: readonly string[]; readonly stillRunning: readonly string[] }> {
    const running = [...this.active.keys()];
    this.restarting = true;
    this.draining = true;
    for (const t of this.resumeTimers.values()) this.clock.clearTimeout(t);
    this.resumeTimers.clear();
    this.restartAbort.abort(new CancelledError());
    for (const release of [...this.jobWaiters]) release();
    this.controlsChanged();
    await settleWithin(
      [...this.active.values()].map((a) => a.done),
      graceMs,
    );
    const stillRunning = [...this.active.keys()];
    return { parked: running.filter((id) => !stillRunning.includes(id)), stillRunning };
  }

  /** CR-2026-11-R3 (fix A): a job stopped by a restart, left queued for the next start. */
  private parkForRestart(jobId: string, beforeStep: number | null): void {
    this.repo.updateJob(jobId, {
      status: 'queued',
      currentStep: null,
      waitReason: {
        restart: 'stopped at a step boundary by a restart; it continues when the bridge starts',
        ...(beforeStep !== null ? { beforeStep } : {}),
      },
    });
    this.emitJob(jobId, 'updated');
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
    // v3 F2 (ADR 0049 decision 2): a substantial edit also sets its page's Last Major Revision, in the same job.
    const lmr = isWriteOp(def)
      ? this.planLmr({
          project,
          origin,
          jobKind: 'single_op',
          steps: [{ op: def.operationId, params, options }],
          ...(opts.proposal?.prefetched ? { prefetched: opts.proposal.prefetched } : {}),
          ...(opts.lastMajorRevision ? { mode: opts.lastMajorRevision } : {}),
        })
      : null;
    const lmrSays = lmr ? { lastMajorRevision: lmr.note } : {};
    const lmrItems: AuthItem[] = (lmr?.steps ?? []).map((s) => {
      const p = s.params ?? {};
      const o = stepOptions(s);
      return isInternalStep(s.op)
        ? { opId: s.op, def: null, meta: internalPolicyMeta(s.op, o), params: p, options: o }
        : authItem(this.validate(s.op, p), p, o);
    });
    const proposal = await this.authorize(
      [authItem(def, params, options), ...lmrItems],
      origin,
      'single_op',
      project,
      {
        title,
        priority,
        ...(opts.proposal || lmr
          ? { extras: { ...opts.proposal, ...(lmr ? { lmrNote: lmr.note } : {}) } }
          : {}),
        ...(lmr && lmr.steps.length > 0 ? { jobOptions: { internal: true } } : {}),
      },
    );
    if (proposal) return proposal;
    checkSubmitGuards(def, params, options, this.guardContext(project));
    for (const it of lmrItems)
      if (it.def) checkSubmitGuards(it.def, it.params, it.options, this.guardContext(project));
    // v3 F3.4 (ADR 0055 decision E): a direct updateBlock whose Last Major Revision is measured when it runs reads its
    // block first (one read), so the rule has the "before" a typo fix is judged by.
    const readFirst = readBeforeSteps([
      { op: def.operationId, params, options },
      ...lmrItems.map((it) => ({ op: it.opId, params: it.params, options: it.options })),
    ]).has(0);
    const runOptions: StepOptions = readFirst ? { ...options, readBefore: true } : options;
    const estimate = this.estimateFor(
      project,
      [{ def, params }, ...lmrItems.flatMap((it) => (it.def ? [{ def: it.def, params: it.params }] : []))],
      priority,
    );
    const slow = estimate.wallClockMs > this.settings.inlineMaxEstimateMs;

    if (!isWriteOp(def) && !slow) {
      return this.runInlineRead(project, def, params, priority, origin, opts.signal);
    }
    if (this.draining) throw new DrainingError(this.restarting);

    const prepared = [
      this.prepare(def, params, runOptions),
      ...lmrItems.map((it) =>
        it.def
          ? this.prepare(it.def, it.params, it.options)
          : this.prepareInternal(it.opId, it.params, it.options),
      ),
    ];
    const hold = isWriteOp(def) ? this.writeHold(project) : null;
    // v3 F3.4 (ADR 0055): what the Review page shows of a direct write.
    const review = isWriteOp(def) ? reviewNote(origin, opts.proposal) : undefined;
    const reviewOptions = review ? { review } : undefined;
    if (slow || hold) {
      const job = this.createJob(
        project,
        'single_op',
        title,
        origin,
        priority,
        'stop',
        prepared,
        'queued',
        reviewOptions,
      );
      this.pump();
      return {
        status: 'queued',
        jobId: job.id,
        eta: hold ? null : this.clock.now() + estimate.wallClockMs,
        reason: hold ?? 'estimate',
        ...lmrSays,
      };
    }

    // Inline write: recorded as a one-step job and run now, through the same slots, locks and guards.
    const job = this.createJob(
      project,
      'single_op',
      title,
      origin,
      priority,
      'stop',
      prepared,
      'running',
      reviewOptions,
    );
    // The request that started it ended (its caller cancelled): its own principal's cancel (R3-54).
    const onAbort = () => this.cancelJob(job.id, job.principalId);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let result: RunnerResult;
    try {
      result = await this.launch(job.id).done;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const final = this.repo.job(job.id)!;
    const last = result.last;
    // v3 F2: with the Last Major Revision steps appended, the answer is the edit's own (step 1), and a follow-up of
    // theirs (a tolerated failure) never makes the edit fail.
    if (lmr && lmr.steps.length > 0 && final.status === 'succeeded' && (result.values?.length ?? 0) > 0) {
      const requestIds = this.repo.steps(job.id).flatMap((s) => s.requestIds);
      return {
        status: 'succeeded',
        jobId: job.id,
        result: result.values![0],
        requestIds,
        lastMajorRevision: this.lmrOutcome(job.id) ?? lmr.note,
      };
    }
    if (last?.kind === 'succeeded' && final.status === 'succeeded') {
      // A createManyResources recovered part-way ran a continuation step: return every resource it created.
      const values = result.values ?? [];
      const value =
        values.length > 1 && values.every((v) => Array.isArray((v as { resources?: unknown })?.resources))
          ? { resources: values.flatMap((v) => (v as { resources: unknown[] }).resources) }
          : last.value;
      const requestIds = this.repo.steps(job.id).flatMap((s) => s.requestIds);
      return { status: 'succeeded', jobId: job.id, result: value, requestIds, ...lmrSays };
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
   * v3 F3d amendment (ADR 0058, A): registers a rebaser (src/jobs/rebase.ts) under `name`, replacing any earlier one.
   * Write steps name it in `options.rebase`; a step whose rebaser is missing meets a conflict as before. Returns an
   * unregister.
   */
  registerRebaser(name: string, rebaser: Rebaser): () => void {
    this.rebasers.set(name, rebaser);
    return () => {
      if (this.rebasers.get(name) === rebaser) this.rebasers.delete(name);
    };
  }

  /** v3 F3d amendment (ADR 0058, A): the items a job skipped when it ran (changed meanwhile), in step order. */
  skippedItems(projectId: string, jobId: string): SkippedItem[] {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return [];
    return this.repo.skippedItems(jobId);
  }

  /**
   * v2 C2a: sets the write guard (src/jobs/write-guard.ts), asked about every request at entry and before every write
   * step inside its lock. Returns an unregister.
   */
  /**
   * v2 D3 (ADR 0041): sets the keeper every `deleteAsset` runs first (the bytes kept before a delete). Returns an
   * unregister.
   */
  /**
   * CR-2026-11-R3 (R3-45): asked before a stopped job is continued in place (a step Retry, a Resume): a reason refuses it
   * (a job reverted, being reverted, or whose revert stopped part-way: continuing it would write on top of the revert).
   * Returns an unregister.
   */
  setContinueGuard(guard: (projectId: string, jobId: string) => string | null): () => void {
    this.continueGuard = guard;
    return () => {
      if (this.continueGuard === guard) this.continueGuard = undefined;
    };
  }

  setAssetDeleteKeeper(keeper: AssetDeleteKeeper): () => void {
    this.assetDeleteKeeper = keeper;
    return () => {
      if (this.assetDeleteKeeper === keeper) this.assetDeleteKeeper = undefined;
    };
  }

  /** v3 F2 (ADR 0049 decision 2): sets the Last Major Revision planner (src/lmr/). Returns an unregister. */
  setLmrPlanner(planner: LmrPlanner): () => void {
    this.lmrPlanner = planner;
    return () => {
      if (this.lmrPlanner === planner) this.lmrPlanner = undefined;
    };
  }

  /**
   * v3 F2: the Last Major Revision steps to append to a caller's write request, or null. Never for approved work (its
   * token covers exactly the stored steps, which already hold them when they were planned), never twice, and never
   * fatal: a planner that throws plans nothing (the edit goes ahead; it is logged).
   */
  private planLmr(input: LmrPlanInput): LmrPlan | null {
    if (!this.lmrPlanner || input.origin.approval !== undefined) return null;
    if (input.steps.some((s) => s.op === LMR_STEP || s.options.decisionFrom !== undefined)) return null;
    try {
      const plan = this.lmrPlanner(input);
      return plan && (plan.steps.length > 0 || plan.note !== '') ? plan : null;
    } catch (e) {
      this.log.warn({ err: e, project: input.project }, 'the Last Major Revision planner failed');
      return null;
    }
  }

  /**
   * v3 F3c (ADR 0051): what the job's `bridge.lmr` decision said when it ran (the row set to a date, or skipped and why),
   * in words; undefined when it has not run.
   */
  private lmrOutcome(jobId: string): string | undefined {
    const step = this.repo.steps(jobId).find((s) => s.opId === LMR_STEP && s.status === 'succeeded');
    if (!step) return undefined;
    const r = (this.repo.stepResult(step) ?? {}) as { skip?: unknown; date?: unknown; why?: unknown };
    const why = typeof r.why === 'string' ? ` (${r.why})` : '';
    if (typeof r.skip === 'string') return `Last Major Revision not set: ${r.skip}${why}`;
    return typeof r.date === 'string' ? `Last Major Revision set to ${r.date}${why}` : undefined;
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

  /**
   * v3 F3a (ADR 0050): registers an asynchronous checker for `bridge.expect` checks and `bridge.verify` targets of kind
   * `registered` (a setting pack's), replacing any earlier one of that name. A job whose check names a missing checker
   * fails at that check, before its writes (a verify target is `not_checked`). Returns an unregister.
   */
  /**
   * v3 F3d (ADR 0058): judges a job's `waitFor` (null: it may start now; else what it still waits for, in words). The
   * setting packs register it; without it, a job with a `waitFor` waits. `poke` asks again.
   */
  setWaitForCheck(check: (w: WaitForShape) => string | null): () => void {
    this.waitForCheck = check;
    return () => {
      if (this.waitForCheck === check) this.waitForCheck = undefined;
    };
  }

  /** v3 F3d (ADR 0058): runs the scheduler now (something a waiting job waits for may have changed). */
  poke(): void {
    this.pump();
  }

  registerAsyncChecker(name: string, checker: RegisteredChecker): () => void {
    this.asyncCheckers.set(name, checker);
    return () => {
      if (this.asyncCheckers.get(name) === checker) this.asyncCheckers.delete(name);
    };
  }

  /**
   * v3 F3a (ADR 0050): registers a filler for `StepOptions.fill`, replacing any earlier one of that name. A write that
   * names a missing filler fails before anything is sent. Returns an unregister.
   */
  registerFiller(name: string, filler: Filler): () => void {
    this.fillers.set(name, filler);
    return () => {
      if (this.fillers.get(name) === filler) this.fillers.delete(name);
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
  observeWrites(observer: WriteObserver, o: { readonly first?: boolean } = {}): () => void {
    if (o.first) {
      // v2 E1a: told before the others (the snapshot service records a write before the tree re-reads what it changed,
      // so that re-read counts as a read of the write's result).
      const rest = [...this.writeObservers];
      this.writeObservers.clear();
      this.writeObservers.add(observer);
      for (const x of rest) this.writeObservers.add(x);
    } else this.writeObservers.add(observer);
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
      const value = await callOp(this.clientOf(project), def, params, {
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
      // v2 E1a: a read named with a job (the tree's re-read after the job's writes) goes to the read tap too.
      if (opts.jobId !== undefined)
        this.notifyRead({ projectId: project, jobId: opts.jobId, opId: def.operationId, params, value });
      return value;
    } catch (e) {
      if (opts.jobId !== undefined && isNotFound(e))
        this.notifyRead({
          projectId: project,
          jobId: opts.jobId,
          opId: def.operationId,
          params,
          value: undefined,
        });
      if (e instanceof BudgetWaitError)
        throw new BudgetExhaustedError(def.operationId, e.tier, e.retryAtMs, e);
      if (e instanceof BridgeLkError) throw new LkOperationError(e);
      if (e instanceof JobsError) throw e;
      throw new JobsError('BRIDGE_ERROR', e instanceof Error ? e.message : String(e), {}, { cause: e });
    }
  }

  /** v2 E1a (ADR 0042): a read a job made, to every observer that asks for reads. Listeners never break a job. */
  private notifyRead(info: ReadInfo): void {
    if (this.writeObservers.size === 0) return;
    for (const o of [...this.writeObservers]) {
      try {
        o.afterRead?.(info);
      } catch (e) {
        this.log.warn({ err: e, jobId: info.jobId }, 'a write observer failed');
      }
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
    if (this.repo.steps(job.id).some((s) => s.options.deferTreeReread === true)) {
      for (const o of [...this.writeObservers]) {
        try {
          await o.flushDeferred?.({
            projectId: job.projectId,
            jobId: job.id,
            priority: job.priority,
            signal,
          });
        } catch (e) {
          this.log.warn({ err: e, jobId: job.id }, 'a write observer failed');
        }
      }
    }
    // v2 E1a (ADR 0042): the job is ending (the change snapshot of what it wrote is taken now, inside the job).
    for (const o of [...this.writeObservers]) {
      try {
        await o.jobEnding?.({ projectId: job.projectId, jobId: job.id, priority: job.priority, signal });
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
    if (this.draining) throw new DrainingError(this.restarting);
    if (req.kind === 'batch_ops') return this.submitBatch(req);
    if (req.kind === 'upload_image') return this.submitUpload(req);
    return this.submitPaginate(req);
  }

  private async submitBatch(given: BatchSubmit): Promise<SubmitResult | ProposalCaptured> {
    const project = this.requireAdmission(this.requireProject(given.project));
    if (given.steps.length === 0)
      throw new InvalidParamsError('batch_ops', [{ path: 'steps', message: 'Empty' }]);
    const origin = normaliseOrigin(given.origin);
    // v3 F2 (ADR 0049 decision 2): a substantial edit also sets its page's Last Major Revision, in the same job and the
    // same proposal: the engine appends the planner's steps (the request's own internal-step rule still applies to the
    // request's own steps). A job that holds job-level locks also holds each such page's.
    const base = given.steps.length;
    const lmr = this.planLmr({
      project,
      origin,
      jobKind: 'batch_ops',
      steps: given.steps.map((s) => ({ op: s.op, params: s.params ?? {}, options: stepOptions(s) })),
      ...(given.lifecycle ? { lifecycle: given.lifecycle } : {}),
      ...(given.proposal?.prefetched ? { prefetched: given.proposal.prefetched } : {}),
      ...(given.lastMajorRevision ? { mode: given.lastMajorRevision } : {}),
    });
    const req: BatchSubmit = lmr ? withLmr(given, lmr) : given;
    const validated: AuthItem[] = req.steps.map((s: StepSpec, i) => {
      const params = s.params ?? {};
      const options = stepOptions(s);
      // v2 C2a: the bridge's own check and verify steps, only when bridge code asks for them (never lk_api_batch).
      // v3 F2: an image placement's upload steps too (isBridgeStep), only in a batch bridge code built.
      if (
        (given.internal === true && isBridgeStep(s.op)) ||
        (lmr !== null && i >= base && isInternalStep(s.op))
      ) {
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
          const issues = e.issues.map((x) => ({ path: `steps[${i}].${x.path}`, message: x.message }));
          // v2 E5.2: a write the bridge planned names what it writes (page, document, feature), not only its index.
          const what = describeStep(options.journalOperation);
          throw new InvalidParamsError(
            s.op,
            issues,
            what ? `${new InvalidParamsError(s.op, issues).message} (step ${i + 1}: ${what})` : undefined,
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
    // v3 F3.4 (ADR 0055): assets held for the whole job (a revert's image moves).
    const heldAssets = [...new Set(req.holdAssets ?? [])].map((a) => projectLockKey(project, `asset:${a}`)!);
    const heldKeys = [
      ...new Set([
        ...(heldPage ? [heldPage] : []),
        ...(req.holdDocument ? [projectLockKey(project, `doc:${req.holdDocument.documentId}`)!] : []),
        ...(req.holdAlso ? [projectLockKey(project, `res:${req.holdAlso.resourceId}`)!] : []),
        ...(req.holdMore?.resources ?? []).map((id) => projectLockKey(project, `res:${id}`)!),
        ...(req.holdMore?.documents ?? []).map((id) => projectLockKey(project, `doc:${id}`)!),
        ...heldDocs,
        ...heldAssets,
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
    const resumable = resumableOf(req.resumable);
    const waitFor = waitForOf(req.waitFor);
    const jobOptions: ProposalJobOptions | undefined =
      req.holdLock ||
      req.internal ||
      req.lifecycle ||
      req.pageScope ||
      heldDocs.length > 0 ||
      resumable ||
      waitFor ||
      heldAssets.length > 0
        ? {
            ...(req.holdLock ? { holdLock: { resourceId: req.holdLock.resourceId } } : {}),
            ...(heldDocs.length > 0 ? { holdDocuments: [...new Set(req.holdDocuments ?? [])] } : {}),
            ...(req.internal ? { internal: true } : {}),
            ...(req.holdDocument ? { holdDocument: { documentId: req.holdDocument.documentId } } : {}),
            ...(req.holdAlso ? { holdAlso: { resourceId: req.holdAlso.resourceId } } : {}),
            ...(req.holdMore ? { holdMore: req.holdMore } : {}),
            ...(req.lifecycle ? { lifecycle: req.lifecycle } : {}),
            ...(req.pageScope ? { pageScope: req.pageScope } : {}),
            // v3 F3d (ADR 0058): kept with a proposal, so its approved job can be resumed, waits as planned and holds
            // the assets it renames.
            ...(resumable ? { resumable } : {}),
            ...(waitFor ? { waitFor } : {}),
            ...(heldAssets.length > 0 ? { holdAssets: [...new Set(req.holdAssets ?? [])] } : {}),
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
      {
        ...(req.stagedPlacement === true ? { stagedPlacement: true } : {}),
        ...(req.forceProposal === true && req.proposedBecause ? { forcedBecause: req.proposedBecause } : {}),
      },
    );
    if (proposal) return proposal;
    if (this.draining) throw new DrainingError(this.restarting);
    const guard = this.guardContext(project);
    for (const v of validated) if (v.def) checkSubmitGuards(v.def, v.params, v.options, guard);
    // v3 F3.4 (ADR 0055 decision E): see readBeforeSteps.
    const readFirst = readBeforeSteps(
      validated.map((v) => ({ op: v.opId, params: v.params, options: v.options })),
    );
    const prepared = validated.map((v, i) =>
      v.def
        ? this.prepare(v.def, v.params, readFirst.has(i) ? { ...v.options, readBefore: true } : v.options)
        : this.prepareInternal(v.opId, v.params, v.options),
    );
    const review = reviewNote(origin, req.proposal);
    const job = this.createJob(
      project,
      'batch_ops',
      title,
      origin,
      priority,
      onError,
      prepared,
      'queued',
      heldLock || req.lifecycle || req.pageScope || review || resumable || waitFor
        ? {
            ...(heldLock ? { [HELD_LOCK]: heldLock } : {}),
            ...(heldMore.length > 0 ? { [HELD_MORE]: heldMore } : {}),
            ...(req.lifecycle ? { [LIFECYCLE_OPTION]: req.lifecycle } : {}),
            // C2d (ADR 0036 decision 5): read by the page-scope guard inside the lock.
            ...(req.pageScope ? { pageScope: req.pageScope } : {}),
            // v3 F3.4 (ADR 0055): what the Review page shows of a direct write.
            ...(review ? { review } : {}),
            // v3 F3d (ADR 0058): a job that can be resumed after it stops part-way, and one that waits to start.
            ...(resumable ? { [RESUMABLE_OPTION]: resumable } : {}),
            ...(waitFor ? { [WAIT_FOR_OPTION]: waitFor } : {}),
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
    return {
      jobId: job.id,
      status: job.status,
      eta: held ? null : this.clock.now() + estimate.wallClockMs,
      ...(lmr ? { lastMajorRevision: lmr.note } : {}),
    };
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
    if (this.draining) throw new DrainingError(this.restarting);
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
      // v3 F2 (ADR 0049 decision 9): found or created when the job runs, under the asset-folder lock.
      const options: StepOptions =
        i === 0 ? { findOrCreate: true } : { findOrCreate: true, bindFrom: { step: i, to: 'body.folderId' } };
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
    if (this.draining) throw new DrainingError(this.restarting);
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
    // v2 D3: folders may be created first, so the upload is the createImageUpload step before this one. v3 F3a (ADR
    // 0050): the NEAREST one before it, so a batch that uploads several images binds each asset to its own upload.
    const first = this.repo
      .steps(jobId)
      .filter((s) => s.opId === 'createImageUpload' && s.stepNo < step.stepNo)
      .sort((a, b) => b.stepNo - a.stepNo)[0];
    // v3 F2: outside an upload job, only a batch that made its own upload binds its key (a raw createImageAsset keeps
    // the key it was given).
    if (!first && this.repo.job(jobId)?.kind !== 'upload_image') return false;
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
  /**
   * v3 F2 (ADR 0049 decision 2): a step with `options.decisionFrom` takes its path and body from what the named
   * `bridge.lmr` step decided when it ran (`lmr: { path, body }`; its If-Match is bound by `ifMatchFrom`), or is not
   * sent at all: recorded as succeeded with `{ skipped }` when that step decided to skip it, did not succeed (its own
   * failure is already the follow-up) or gave no decision. Returns true when the step was skipped. A step that may
   * already have been sent keeps what it was sent with.
   */
  private bindDecision(job: JobView, step: StepView): boolean {
    const from = step.options.decisionFrom;
    if (!from || step.status === 'running' || step.maybeSent || step.firstSentAt !== null) return false;
    const source = from.step < step.stepNo ? this.repo.step(job.id, from.step) : undefined;
    const result =
      source?.status === 'succeeded'
        ? (this.repo.stepResult(source) as {
            skip?: unknown;
            lmr?: { path?: unknown; body?: unknown };
          } | null)
        : null;
    const path = result?.lmr?.path;
    const body = result?.lmr?.body;
    const skip =
      source?.status !== 'succeeded'
        ? 'the decision before it did not succeed (see its follow-up)'
        : typeof result?.skip === 'string'
          ? result.skip
          : !path || typeof path !== 'object' || !body || typeof body !== 'object'
            ? 'no decision was made'
            : null;
    if (skip !== null) {
      const now = this.clock.now();
      this.repo.updateStep(job.id, step.stepNo, {
        status: 'succeeded',
        resultSummary: { skipped: skip },
        startedAt: step.startedAt ?? now,
        finishedAt: now,
      });
      return true;
    }
    const params = this.repo.stepParams(step);
    const next: OpParams = { ...params, path: path as Record<string, string>, body };
    if (JSON.stringify(next) !== JSON.stringify(params)) this.repo.setStepParams(job.id, step.stepNo, next);
    return false;
  }

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
      source?.status === 'succeeded'
        ? (this.repo.stepResult(source) as { id?: unknown; documents?: unknown } | null)
        : null;
    // v2 E1a: the n-th document of a page the job created, or a created entity's own id. v3 F3a (ADR 0050): or its
    // main page document, by name and type (a template copy's documents come in an order LegendKeeper does not state).
    const docAt = from.from !== undefined ? /^documents\.([0-4])\.id$/.exec(from.from) : null;
    const id =
      from.from === 'documents.main.id'
        ? mainDocumentId(result?.documents)
        : docAt
          ? Array.isArray(result?.documents)
            ? (result.documents as { id?: unknown }[])[Number(docAt[1])]?.id
            : undefined
          : result?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return new JobsError(
        'BRIDGE_ERROR',
        `${step.opId}: step ${from.step} gave no id to use as ${from.to}; nothing was sent`,
        ref,
      );
    }
    const params = this.repo.stepParams(step);
    const next: OpParams =
      from.to === 'path.assetId'
        ? { ...params, path: { ...(params.path ?? {}), assetId: id } }
        : from.to === 'path.documentId'
          ? { ...params, path: { ...(params.path ?? {}), documentId: id } }
          : { ...params, body: { ...((params.body ?? {}) as Record<string, unknown>), folderId: id } };
    try {
      this.validate(step.opId, next);
    } catch (e) {
      if (e instanceof JobsError) return e;
      throw e;
    }
    if (JSON.stringify(next) !== JSON.stringify(params)) this.repo.setStepParams(job.id, step.stepNo, next);
    return null;
  }

  /**
   * v3 F3a (ADR 0050): replaces, in this step's body, every string equal to a placeholder of `options.bindAssetUrls` by
   * the `url` of the asset the named earlier step created (see `StepOptions.bindAssetUrls`). Stored before anything is
   * sent, checked against the schema; a step that may already have been sent keeps what it was sent with.
   */
  private bindAssetUrls(job: JobView, step: StepView): JobsError | null {
    const binds = step.options.bindAssetUrls;
    if (!binds || binds.length === 0) return null;
    if (step.status === 'running' || step.maybeSent || step.firstSentAt !== null) return null;
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const urls = new Map<string, string>();
    for (const b of binds) {
      const source = b.step < step.stepNo ? this.repo.step(job.id, b.step) : undefined;
      const made =
        source?.status === 'succeeded'
          ? (this.repo.stepResult(source) as { url?: unknown; id?: unknown } | null)
          : null;
      const value = b.field === 'id' ? made?.id : made?.url;
      if (typeof value !== 'string' || value.length === 0) {
        return new JobsError(
          'BRIDGE_ERROR',
          `${step.opId}: step ${b.step} gave no asset ${b.field === 'id' ? 'id' : 'address'} to put in place of ${b.placeholder}; nothing was sent`,
          ref,
        );
      }
      urls.set(b.placeholder, value);
    }
    const params = this.repo.stepParams(step);
    const swap = (v: unknown): unknown =>
      typeof v === 'string'
        ? (urls.get(v) ?? v)
        : Array.isArray(v)
          ? v.map(swap)
          : v !== null && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, swap(x)]))
            : v;
    const next: OpParams = { ...params, body: swap(params.body) };
    try {
      this.validate(step.opId, next);
    } catch (e) {
      if (e instanceof JobsError) return e;
      throw e;
    }
    if (JSON.stringify(next) !== JSON.stringify(params)) this.repo.setStepParams(job.id, step.stepNo, next);
    return null;
  }

  /**
   * v3 F3d amendment (ADR 0058, A): a step whose items were ALL skipped earlier in the job (what they edit changed
   * meanwhile) is not sent: it is recorded as succeeded with `{ skipped }`, passing on the version it would have
   * chained from, so a write chained after it still finds one (and rebases if the target moved on).
   */
  private skipForItems(job: JobView, step: StepView): boolean {
    const items = step.options.items ?? [];
    if (items.length === 0 || step.status === 'running' || step.maybeSent || step.firstSentAt !== null)
      return false;
    const earlier = this.repo.skippedItems(job.id, step.stepNo);
    const skipped = new Set(earlier.map((x) => x.item));
    if (skipped.size === 0 || !items.every((i) => skipped.has(i))) return false;
    const version = this.chainVersion(job, step);
    const now = this.clock.now();
    this.repo.updateStep(job.id, step.stepNo, {
      status: 'succeeded',
      resultSummary: {
        skipped: 'its items were skipped earlier in the job (changed meanwhile)',
        items: [...items],
        // CR-2026-11-R3 (R3-44): the step keeps its own record of the items it did not write (with why), so a Resume
        // whose first check runs again (and no longer skips them) still reports them: never neither applied nor listed.
        skippedItems: items.map((i) => earlier.find((x) => x.item === i)!),
        ...(typeof version === 'string' && version !== '' ? { version } : {}),
      },
      startedAt: step.startedAt ?? now,
      finishedAt: now,
    });
    return true;
  }

  /** The version a step's `ifMatchFrom` names (undefined when it names none, or the source gave none). */
  private chainVersion(job: JobView, step: StepView): unknown {
    const from = step.options.ifMatchFrom;
    if (!from) return undefined;
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
    const page = this.repo.stepParams(step).path?.resourceId;
    if (from.key !== undefined)
      return result?.versionsByPage && typeof page === 'string'
        ? result.versionsByPage[page]?.[from.key]
        : result?.versions?.[from.key];
    return result?.version ?? (this.etagVersions?.(job.projectId) === false ? undefined : result?.etag);
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
   * v2 E4 (ADR 0046): each step of a job of `projectId` as it was planned and as it ended (its operation, params,
   * status and whether it may have been sent), for the block-by-block undo (src/pages/undo.ts). Read-only. Undefined
   * for a job of another project or one that does not exist.
   */
  stepPlans(
    projectId: string,
    jobId: string,
  ):
    | readonly {
        readonly stepNo: number;
        readonly opId: string;
        readonly status: string;
        readonly maybeSent: boolean;
        readonly params: OpParams;
      }[]
    | undefined {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return undefined;
    return this.repo.steps(jobId).map((st) => ({
      stepNo: st.stepNo,
      opId: st.opId,
      status: st.status,
      maybeSent: st.maybeSent || st.firstSentAt !== null,
      params: this.repo.stepParams(st),
    }));
  }

  /**
   * v3 F3d (ADR 0058): the steps a resume runs again first (`resumable.recheck`, and CR-2026-11-R3 (R3-22) every
   * succeeded check step before the step it stopped at that holds a checker `resumable.recheckCheckers` names), in order.
   * Empty for a job that is not resumable in place, or of another project.
   */
  recheckSteps(projectId: string, jobId: string): number[] {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return [];
    const r = this.repo.jobOptions(jobId)[RESUMABLE_OPTION] as ResumableShape | undefined;
    if (!r || r.kind === 'recreate') return [];
    const steps = this.repo.steps(jobId);
    const stopped = steps.find((s) => s.status !== 'succeeded');
    if (!stopped) return [];
    const named = new Set(r.recheckCheckers ?? []);
    const out = new Set<number>();
    for (const s of steps) {
      if (s.stepNo >= stopped.stepNo || s.status !== 'succeeded' || !isInternalStep(s.opId)) continue;
      if ((r.recheck ?? []).includes(s.stepNo)) {
        out.add(s.stepNo);
        continue;
      }
      // CR-2026-11-R3 (ADR 0061 part B decision 6, the owner's (b)): a verification that read back a difference is read
      // again before the job continues; one that now reads back as planned counts as verified ("put right since").
      if (s.opId === VERIFY_STEP && verificationStatus(s) !== 'verified') {
        out.add(s.stepNo);
        continue;
      }
      if (named.size === 0 || s.opId !== EXPECT_STEP) continue;
      const body = (this.repo.stepParams(s) as { body?: { checks?: unknown } }).body;
      const checks = Array.isArray(body?.checks) ? (body.checks as { checker?: unknown }[]) : [];
      if (checks.some((c) => typeof c.checker === 'string' && named.has(c.checker))) out.add(s.stepNo);
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * CR-2026-11-R3 (ADR 0061 part B decision 6, the owner's (b)): before a stopped job is resumed, each page write before
   * the stop whose read-back differed from its plan (or could not be made) is read back again; one that now reads back as
   * planned has its verification replaced, marked "put right since" (`putRightSince`, the earlier difference kept as
   * `earlier`), so the job's result counts it as verified. Read only. Returns the steps put right since.
   */
  async reverifyStopped(projectId: string, jobId: string): Promise<number[]> {
    const job = this.requireJob(jobId, projectId);
    const steps = this.repo.steps(jobId);
    const stopped = steps.find((s) => s.status !== 'succeeded');
    if (!stopped) return [];
    const put: number[] = [];
    for (const s of steps) {
      if (s.stepNo >= stopped.stepNo || s.status !== 'succeeded') continue;
      if (s.options.verifyAfterWrite !== true || s.opId !== 'replaceDocumentBlocks') continue;
      const summary = (s.resultSummary ?? {}) as { verification?: { status?: unknown }; truncated?: unknown };
      const whole = (
        summary.verification === undefined && summary.truncated === true
          ? (this.repo.stepResult(s) ?? {})
          : summary
      ) as Record<string, unknown> & { verification?: { status?: unknown } };
      const before = whole.verification;
      if (!before || before.status === 'verified') continue;
      const again = await this.executor.reverifyWrite(job, s);
      if (again.status !== 'verified') continue;
      this.repo.updateStep(jobId, s.stepNo, {
        resultSummary: {
          ...whole,
          truncated: undefined,
          verification: {
            ...again,
            putRightSince: true,
            note: 'read back again at Resume: put right since the job stopped',
            earlier: { status: before.status },
          },
        },
      });
      put.push(s.stepNo);
    }
    if (put.length > 0) {
      const opts = this.repo.jobOptions(jobId) as { reverified?: number[] };
      this.repo.setJobOptions(jobId, {
        ...opts,
        [REVERIFIED_OPTION]: [...new Set([...(opts.reverified ?? []), ...put])],
      });
    }
    return put;
  }

  /**
   * CR-2026-11-R3, R3-55 (ADR 0061 part B decision 4): what a resume of a stopped job would run, as step specs with their
   * full parameters: the checks it runs again first (`recheckSteps`), then every step from the stop on that has not
   * succeeded, in order. Empty for a job that is not resumable in place, or of another project. Nothing is changed.
   */
  restOf(projectId: string, jobId: string): StepSpec[] {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return [];
    const r = this.repo.jobOptions(jobId)[RESUMABLE_OPTION] as ResumableShape | undefined;
    if (!r || r.kind === 'recreate') return [];
    const steps = this.repo.steps(jobId);
    const stopped = steps.find((s) => s.status !== 'succeeded');
    if (!stopped) return [];
    const recheck = new Set(this.recheckSteps(projectId, jobId));
    return steps
      .filter((s) => recheck.has(s.stepNo) || (s.stepNo >= stopped.stepNo && s.status !== 'succeeded'))
      .map((s) => ({ ...s.options, op: s.opId, params: this.repo.stepParams(s) }));
  }

  /**
   * v3 F3.4 (ADR 0055): every step of a job as the engine holds it (its params and its result in full, from their
   * artefacts when stored apart, and its options), for the review of direct writes and their revert. Undefined for a
   * job of another project. Read-only.
   */
  stepRecords(
    projectId: string,
    jobId: string,
  ):
    | readonly {
        readonly stepNo: number;
        readonly opId: string;
        readonly opKind: string;
        readonly status: string;
        readonly maybeSent: boolean;
        readonly params: OpParams;
        readonly options: StepOptions;
        readonly result: unknown;
      }[]
    | undefined {
    const job = this.repo.job(jobId);
    if (!job || job.projectId !== projectId) return undefined;
    return this.repo.steps(jobId).map((st) => ({
      stepNo: st.stepNo,
      opId: st.opId,
      opKind: st.opKind,
      status: st.status,
      maybeSent: st.maybeSent || st.firstSentAt !== null,
      params: this.repo.stepParams(st),
      options: st.options,
      result: st.status === 'succeeded' ? this.repo.stepResult(st) : null,
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
     * control names the project; a job of another project is not found (v2 A1). `by` is who asked (R3-54, ADR 0061 part
     * B decision 3): 'owner', 'system' (the default) or an agent's principal id; the first to ask is the one recorded.
     */
    cancel: (projectId: string, jobId: string, by: string = 'system'): JobView => {
      this.requireJob(jobId, projectId);
      return this.cancelJob(jobId, by);
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
      // CR-2026-11-R3 (R3-45): a job that has been reverted (or is being, or was partly) is never continued.
      const why = this.continueGuard?.(projectId, jobId) ?? null;
      if (why) throw new InvalidControlError(why, { jobId, stepNo });
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
    /**
     * v3 F3d (ADR 0058; the owner-approved design docs/design/F3d-renames.md, section 3): continues a job that stopped
     * part-way (failed, or cancelled) from where it stopped, in the same job, so every binding to what it already did
     * (a created page's ids, an If-Match chain) still holds. A step that succeeded is never run again, except the job's
     * own checks its options name (`resumable.recheck`): they run again first, inside the job, so its preconditions are
     * judged again (a refusal stops it again before anything is written). The step it stopped at is retried as
     * `retryStep` retries one: a definite failure as new work with a new key; one that may have applied keeps its key and
     * is verified before anything is sent again, so a create is never made twice. Every step after it is queued again.
     * Only a job whose options say it can be resumed here (a package or a rename; a recreate is finished by its own
     * restore, which plans only what is missing).
     */
    resumeStopped: (
      projectId: string,
      jobId: string,
    ): { readonly job: JobView; readonly from: number; readonly rechecked: readonly number[] } => {
      const job = this.requireJob(jobId, projectId);
      if (this.active.has(jobId) || (job.status !== 'failed' && job.status !== 'cancelled')) {
        throw new InvalidControlError(
          `Job ${jobId} has not stopped part-way (it is ${job.status}); only a failed or cancelled job is resumed`,
          { jobId },
        );
      }
      const why = this.continueGuard?.(projectId, jobId) ?? null;
      if (why) throw new InvalidControlError(why, { jobId });
      const r = this.repo.jobOptions(jobId)[RESUMABLE_OPTION] as ResumableShape | undefined;
      if (!r || r.kind === 'recreate') {
        throw new InvalidControlError(`Job ${jobId} cannot be resumed in place`, { jobId });
      }
      const steps = this.repo.steps(jobId);
      const stopped = steps.find((s) => s.status !== 'succeeded');
      if (!stopped) throw new InvalidControlError(`Job ${jobId} has nothing left to run`, { jobId });
      const rechecked: number[] = [];
      // B6: the verifications read again, so the job's result can say which were put right since it stopped.
      const reverified = steps
        .filter((x) => x.stepNo < stopped.stepNo && x.opId === VERIFY_STEP && x.status === 'succeeded')
        .filter((x) => verificationStatus(x) !== 'verified')
        .map((x) => x.stepNo);
      if (reverified.length > 0) {
        const opts = this.repo.jobOptions(jobId) as { reverified?: number[] };
        this.repo.setJobOptions(jobId, {
          ...opts,
          [REVERIFIED_OPTION]: [...new Set([...(opts.reverified ?? []), ...reverified])],
        });
      }
      for (const n of this.recheckSteps(projectId, jobId)) {
        const s = steps.find((x) => x.stepNo === n);
        if (!s || s.stepNo >= stopped.stepNo || s.status !== 'succeeded' || !isInternalStep(s.opId)) continue;
        this.repo.updateStep(jobId, n, {
          status: 'pending',
          error: null,
          finishedAt: null,
          firstSentAt: null,
          maybeSent: false,
        });
        rechecked.push(n);
      }
      for (const s of steps) {
        if (s.stepNo < stopped.stepNo || s.status === 'succeeded') continue;
        const def = getOperation(s.opId);
        const ambiguous = s.maybeSent || s.status === 'uncertain';
        if (ambiguous) {
          // It may have applied: its key, version and first-send time stay, so it is verified before any re-send.
          this.repo.updateStep(jobId, s.stepNo, {
            status: 'pending',
            maybeSent: true,
            error: null,
            finishedAt: null,
          });
        } else if (s.status === 'failed') {
          const attempt0 = s.attempt0 + 1;
          this.repo.updateStep(jobId, s.stepNo, {
            status: 'pending',
            attempt0,
            idempotencyKey: def?.method === 'POST' ? idempotencyKeyFor(jobId, s.stepNo, attempt0) : null,
            error: null,
            maybeSent: false,
            firstSentAt: null,
            ifMatch: null,
            finishedAt: null,
          });
        } else {
          // Cancelled (or never started): it never ran.
          this.repo.updateStep(jobId, s.stepNo, { status: 'pending', error: null, finishedAt: null });
        }
      }
      this.refreshProgress(jobId);
      const after = this.repo.steps(jobId);
      this.repo.updateJob(jobId, {
        status: 'queued',
        finishedAt: null,
        lastError: null,
        waitReason: null,
        cancelRequested: false,
        pauseRequested: false,
        uncertain: after.some((s) => s.status === 'uncertain'),
      });
      this.pump();
      return { job: this.emitJob(jobId, 'updated'), from: stopped.stepNo, rechecked };
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
      // v3 F3d (ADR 0058): a job that waits for something before it starts (a rename waiting for the owner to approve
      // the pack version holding its new token map). Asked again each time the scheduler runs (`poke` wakes it).
      const waiting = step ? this.waitingFor(job.id) : null;
      if (waiting) {
        if (job.waitReason?.held !== 'waiting_for' || job.waitReason.message !== waiting.message) {
          this.repo.updateJob(job.id, {
            waitReason: { held: 'waiting_for', message: waiting.message, waitFor: waiting.waitFor },
          });
          this.emitJob(job.id, 'updated');
        }
        continue;
      }
      if (job.waitReason?.held === 'waiting_for') this.repo.updateJob(job.id, { waitReason: null });
      this.launch(job.id);
      capacity--;
    }
  }

  /** v3 F3d (ADR 0058): what a queued job still waits for (its `waitFor`, judged by the registered check), or null. */
  private waitingFor(jobId: string): { message: string; waitFor: WaitForShape } | null {
    const w = this.repo.jobOptions(jobId)[WAIT_FOR_OPTION] as WaitForShape | undefined;
    if (!w) return null;
    let still: string | null;
    try {
      still = this.waitForCheck ? this.waitForCheck(w) : `waits for ${w.reason || w.kind}`;
    } catch (e) {
      still = `the wait could not be judged (${e instanceof Error ? e.message : String(e)})`;
    }
    return still === null ? null : { message: still, waitFor: w };
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
    if (!heldLock) {
      // CR-2026-11-R2 (R2-29): a job with no job-level lock (a setting pack's package, which also writes the documents of
      // pages it creates, so it cannot hold them from its start) checks again in the same case (see recheckOnRelock).
      this.recheckOnRelock(jobId);
      return this.runSteps(jobId, entry, null);
    }
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
    // CR-2026-11-R3 (fix A): a restart ends this wait too.
    const waitSignal = AbortSignal.any([entry.current.signal, this.restartAbort.signal]);
    try {
      for (const key of keys) {
        if (!this.locks.isFree(key)) this.setWaitingLock(jobId, 'lock', { lockKey: key, job: true });
        releases.push(
          await this.locks.acquire(key, { jobId, stepNo: 0, principalId: job.principalId }, waitSignal),
        );
      }
      this.setWaitingLock(jobId, null);
      this.recheckOnRelock(jobId);
    } catch (e) {
      release();
      this.setWaitingLock(jobId, null);
      if (!waitSignal.aborted) throw e;
      // Stopped, cancelled or paused while waiting for the lock: nothing ran.
      const now = this.requireJob(jobId);
      if (this.restarting && !this.stopped) this.parkForRestart(jobId, null);
      else if (this.stopped) this.repo.updateJob(jobId, { status: 'queued', currentStep: null });
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
   * check), as before. CR-2026-11-R2 (R2-29): a job with no job-level lock does the same each time it starts again.
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
      // CR-2026-11-R3 (R3-62): a check too large to run again whole (more reads than RELOCK_RECHECK_MAX) runs again
      // light: only its relock checks (the pack's governance, which R2-29 is about), keeping its earlier result. Run
      // again whole, a check that took most of an hour's budget used it again at every wait, and the job never wrote.
      // What it judged of each page is judged again inside each write's lock.
      if (internalReads(EXPECT_STEP, this.repo.stepParams(s)) > RELOCK_RECHECK_MAX) {
        this.repo.updateStep(jobId, s.stepNo, { status: 'pending', finishedAt: null });
        this.lightRechecks.add(`${jobId}:${s.stepNo}`);
        continue;
      }
      this.repo.updateStep(jobId, s.stepNo, {
        status: 'pending',
        resultSummary: null,
        resultArtifactId: null,
        finishedAt: null,
      });
    }
    this.refreshProgress(jobId);
  }

  /** CR-2026-11-R3 (R3-62): check steps put back for a light re-check (see `recheckOnRelock`), by job and step. */
  private readonly lightRechecks = new Set<string>();
  /** CR-2026-11-R3 (R3-62): the checkers a light re-check runs again (a pack's governance). */
  private readonly relockChecks = new Set<string>();

  /**
   * CR-2026-11-R3 (R3-62): names a registered checker a light re-check runs again (see `recheckOnRelock`): one whose
   * answer can change while a job waits without any page changing (a pack's approved version, its governance sources,
   * a tool's switch). Returns an unregister.
   */
  markRelockCheck(checker: string): () => void {
    this.relockChecks.add(checker);
    return () => {
      this.relockChecks.delete(checker);
    };
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
    let sinceYield = 0;
    for (;;) {
      // CR-2026-11-R3 (R3-64): steps that need no request (a Last Major Revision decided "no", a write it then skips)
      // complete without giving the event loop a turn: a 700-page rename ran 1,400 of them in one 10-second stretch,
      // and the bridge answered nothing meanwhile (its health check included). It yields every few steps.
      if (++sinceYield >= YIELD_EVERY_STEPS) {
        sinceYield = 0;
        await new Promise<void>((r) => setImmediate(r));
      }
      job = this.requireJob(jobId);
      let step = this.repo.nextStep(jobId);
      // v3 F2: a staged image's placement (a batch) uploads it too, so its createImageAsset takes the upload key as well.
      if (step && job.kind !== 'paginate_all' && this.bindUploadStep(jobId, step)) {
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
        // CR-2026-11-R3 (fix A): a restart stops every job here, between two steps, never part-way through one.
        if (this.restarting) {
          this.parkForRestart(jobId, step.stepNo);
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
      // v3 F3d amendment (ADR 0058, A): a step whose items were all skipped earlier in the job is not sent.
      if (this.skipForItems(job, step)) {
        this.emitStep(job, step.stepNo);
        this.refreshProgress(jobId);
        this.emitJob(jobId, 'updated');
        continue;
      }
      // v3 F2 (ADR 0049): a write an earlier `bridge.lmr` step decided: bound to its decision now, or skipped.
      if (this.bindDecision(job, step)) {
        this.emitStep(job, step.stepNo);
        this.refreshProgress(jobId);
        this.emitJob(jobId, 'updated');
        continue;
      }
      step = this.repo.step(jobId, step.stepNo) ?? step;
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
        bound = this.bindAssetUrls(job, step);
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
        // v3 F2: a step that can never fail the job (the Last Major Revision write) is a follow-up, not the job's error.
        if (step.options.followUp) {
          this.emitJob(jobId, 'updated');
          // v3 F3c (ADR 0051 decision 3): a restored image's relink that failed stops the job after the upload.
          if (step.options.followUp === 'image_relink_failed') {
            await this.flushDeferred(job, entry.current.signal);
            this.finish(jobId);
            return { last, values };
          }
          continue;
        }
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
      // CR-2026-11-R3 (fix A): a restart ends the step's lock and writer-slot waits (never its request in flight).
      const outcome = await this.executor.execute(
        job,
        step,
        AbortSignal.any([entry.current.signal, this.restartAbort.signal]),
        {
          storeResult: job.kind !== 'paginate_all',
          heldLock,
        },
      );
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
          // v3 F2: a follow-up (the Last Major Revision write failed after the edit was written): the job goes on, and
          // the edit stays written (nothing is rolled back).
          if (step.options.followUp) {
            this.emitJob(jobId, 'updated');
            // v3 F3c (ADR 0051 decision 3): a restored image's relink failed (the page changed since the proposal): the
            // job stops here, after the upload. The asset stays where it was put; nothing is retried.
            if (step.options.followUp === 'image_relink_failed') {
              await this.flushDeferred(job, entry.current.signal);
              this.finish(jobId);
              return { last, values };
            }
            continue;
          }
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
          // CR-2026-11-R3 (fix A): a call a restart did not let wait (`RestartWaitError`): parked for the next start, the
          // step pending again (one that may have reached LegendKeeper is verified first, as after any restart).
          if (outcome.error instanceof RestartWaitError || this.restarting) {
            this.parkForRestart(jobId, step.stepNo);
            return { last, values };
          }
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
          // CR-2026-11-R3 (fix A): a lock or writer-slot wait a restart ended (nothing was sent).
          if (this.restarting) {
            this.parkForRestart(jobId, step.stepNo);
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
    // v3 F2: steps that can never fail the job (the Last Major Revision write) are follow-ups when they fail.
    const allSteps = this.repo.steps(jobId);
    const followUps = allSteps.filter(
      (s) => s.options.followUp !== undefined && (s.status === 'failed' || s.status === 'uncertain'),
    );
    const failed = counts.failed + counts.uncertain - followUps.length;
    // v3 F3c (ADR 0051 decision 3): the relinks a failed one stopped are follow-ups too (never sent).
    const unsent = followUps.some((s) => s.options.followUp === 'image_relink_failed')
      ? allSteps.filter((s) => s.options.followUp === 'image_relink_failed' && s.status === 'pending')
      : [];
    const status: JobStatus = failed > 0 ? 'failed' : 'succeeded';
    let result = job.result ?? {};
    if (job.kind !== 'paginate_all') {
      result = { stepsSucceeded: counts.succeeded, stepsFailed: failed, stepsNotRun: counts.pending };
      if (followUps.length > 0)
        result = {
          ...result,
          followUps: followUps.map((s) => ({
            kind: s.options.followUp,
            stepNo: s.stepNo,
            ...(typeof s.params?.path?.resourceId === 'string'
              ? { pageId: s.params.path.resourceId }
              : typeof (s.params?.body as { resourceId?: unknown } | undefined)?.resourceId === 'string'
                ? { pageId: (s.params!.body as { resourceId: string }).resourceId }
                : {}),
            reason: s.error?.message ?? 'failed',
            ...(s.error?.code ? { code: s.error.code } : {}),
          })),
        };
      if (unsent.length > 0)
        result = {
          ...result,
          followUps: [
            ...((result as { followUps?: unknown[] }).followUps ?? []),
            ...unsent.map((s) => ({
              kind: s.options.followUp,
              stepNo: s.stepNo,
              ...(typeof s.params?.path?.resourceId === 'string' ? { pageId: s.params.path.resourceId } : {}),
              reason: 'not sent: the job stopped at an earlier relink that failed',
            })),
          ],
        };
      // v3 F3c (ADR 0051): what the Last Major Revision decision said when it ran.
      const lmrSaid = this.lmrOutcome(jobId);
      if (lmrSaid) result = { ...result, lastMajorRevision: lmrSaid };
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
      // v3 F2 (ADR 0049 decision 9): each planned folder, and whether the job found it or created it.
      const folderSteps = this.repo
        .steps(jobId)
        .filter((s) => s.options.findOrCreate === true && s.status === 'succeeded');
      if (folderSteps.length > 0)
        result = {
          ...result,
          foldersUsed: folderSteps.map((s) => {
            const r = (s.resultSummary ?? {}) as { id?: unknown; name?: unknown; found?: unknown };
            return {
              stepNo: s.stepNo,
              id: r.id ?? null,
              name: r.name ?? (s.params?.body as { name?: unknown } | undefined)?.name ?? null,
              outcome: r.found === true ? 'found existing folder' : 'created folder',
            };
          }),
        };
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
        // B6 (ADR 0061 part B decision 6): a verification read again at Resume that now reads back as planned says so.
        const again = new Set((this.repo.jobOptions(jobId)[REVERIFIED_OPTION] as number[] | undefined) ?? []);
        const marked = verifications.map((v) =>
          again.has(v.stepNo as number) && v.status === 'verified'
            ? {
                ...v,
                putRightSince: true,
                note: 'read back again at Resume: put right since the job stopped',
              }
            : v,
        );
        const putRight = marked.filter((v) => v.putRightSince === true).map((v) => v.stepNo as number);
        result = {
          ...result,
          verification: marked.length === 1 ? marked[0] : marked,
          verified: marked.every((v) => v.status === 'verified'),
          ...(putRight.length > 0 ? { putRightSince: putRight } : {}),
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

  private cancelJob(jobId: string, by: string): JobView {
    const job = this.requireJob(jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
    // R3-54: the first to ask is recorded (an agent's later cancel does not take over the owner's).
    this.repo.updateJob(jobId, {
      cancelRequested: true,
      ...(job.cancelRequested ? {} : { cancelledBy: by }),
    });
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
    // CR-2026-11-R3 (fix A): a restart keeps the job's time; the next start arms it again.
    if (this.stopped || this.restarting) return;
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
    // v2 E5.4: the backstop for LABEL_SIZE_WRITABLE: no feature write carries a label size, whoever built it (a written
    // label size makes the whole map unreadable through LegendKeeper's API). Refused here, so it is never sent.
    if (!LABEL_SIZE_WRITABLE && (opId === 'createFeature' || opId === 'updateFeature')) {
      const body = params.body as Record<string, unknown> | undefined;
      if (body && typeof body === 'object' && body.labelSize !== undefined)
        throw new InvalidParamsError(opId, [
          { path: 'body.labelSize', message: `${LABEL_SIZE_UNSUPPORTED}: ${LABEL_SIZE_REFUSAL}` },
        ]);
    }
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
    // v2 E5.5: the operations by id, so a learned operation limit paces the ones in its group.
    const ops: Record<string, number> = {};
    for (const { def, params, opId } of items) {
      const id = def?.operationId ?? opId;
      if (id) ops[id] = (ops[id] ?? 0) + 1;
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
    return this.clientOf(projectId).governor.estimate({ reads, writes, createManyItems, priority, ops });
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
      ...(this.restarting ? { restarting: true as const } : {}),
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
    extra: {
      readonly staging?: boolean;
      readonly stagedPlacement?: boolean;
      /** R3-55: a forced proposal's reason, from a rail the bridge judged itself (an agent's Resume). */
      readonly forcedBecause?: RailDecision;
    } = {},
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
          ...(extra.stagedPlacement === true ? { stagedPlacement: true } : {}),
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
    // v3 F2.1 (ADR 0048): so is a change the bridge only records (a chronology link the caller chose: no LegendKeeper
    // write, but it changes what the check reports).
    if (forceProposal && items.some((it) => it.meta.kind !== 'read' || it.opId === RECORD_STEP))
      propose = true;
    // v2 C2a (ADR 0032): the write guard sees the whole request, once the gate has let every operation through.
    let canonical: ProposalMeta['canonical'];
    // CR-2026-11-R4 (ADR 0065 amendment 2): an ordinary proposal the guard asked for (a page moved into or out of
    // Narratives), shown with its reason as the rails' proposals are.
    let guardRail: RailDecision | null = null;
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
      if (verdict.decision === 'propose') {
        propose = true;
        guardRail = {
          reason: `proposed because: ${verdict.reason}`,
          hits: [{ rail: 'narrative', text: verdict.reason }],
        };
      }
    }
    // v3 F3.4 (ADR 0055): a request that would run directly at scope `write` meets the agent profile's safety rails
    // (deletes, bulk changes, renames and moves, asset deletes and moves). A rail only ever ADDS a proposal: it is not
    // asked about a request already proposed, approved work or the bridge's own; a rail that cannot be judged fails
    // closed (a proposal).
    let rail: RailDecision | null = propose && extra.forcedBecause ? extra.forcedBecause : guardRail;
    if (
      !propose &&
      this.policyGate.rails &&
      origin.approval === undefined &&
      principal.principalId !== SYSTEM_PRINCIPAL.principalId &&
      (jobKind === 'single_op' || jobKind === 'batch_ops') &&
      items.some((it) => it.meta.kind !== 'read')
    ) {
      try {
        rail = await this.policyGate.rails(
          principal,
          items.map((it) => ({ opId: it.opId, kind: it.meta.kind, params: it.params, options: it.options })),
          {
            project,
            jobKind,
            ...(extra.stagedPlacement === true ? { stagedPlacement: true } : {}),
            ...(origin.tool !== undefined ? { tool: origin.tool } : {}),
          },
        );
      } catch (e) {
        rail = {
          reason: `proposed because: the safety rails could not be judged (${e instanceof Error ? e.message : String(e)})`,
          hits: [],
        };
      }
      if (rail) propose = true;
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
        ...(rail ? { rail } : {}),
      });
      return {
        status: 'proposal_captured',
        proposalId,
        ...(summary !== undefined ? { summary } : {}),
        ...(canonical ? { canonical } : {}),
        ...(rail ? { proposedBecause: rail.reason } : {}),
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

/**
 * v3 F3.4 (ADR 0055 decision A): what the Review page shows of a job an agent runs directly at scope `write`: the
 * summary its proposal would have shown (the tool's own, when it gives one) and the pages it names, briefly. Kept with
 * the job's options; undefined for anyone else's work (the bridge's own, approved proposals).
 */
function reviewNote(
  origin: JobOrigin,
  extras: ProposalExtras | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const who = origin.principal?.principalId;
  if (who === undefined || who === SYSTEM_PRINCIPAL.principalId) return undefined;
  if (origin.approval !== undefined || origin.approvedBy !== undefined) return undefined;
  const ops = extras?.operations ?? (extras?.operation ? [extras.operation] : []);
  const pages = ops
    .map((o) => {
      const page = o.page as { id?: unknown; name?: unknown } | undefined;
      if (!page || typeof page.id !== 'string') return null;
      const parts = Array.isArray(o.pageParts)
        ? (o.pageParts as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10)
        : [];
      return {
        id: page.id,
        ...(typeof page.name === 'string' ? { name: page.name.slice(0, 300) } : {}),
        ...(parts.length > 0 ? { parts } : {}),
      };
    })
    .filter((x) => x !== null)
    .slice(0, 50);
  return {
    ...(typeof extras?.summary === 'string' ? { summary: extras.summary.slice(0, 500) } : {}),
    ...(extras?.lmrNote ? { lmrNote: extras.lmrNote.slice(0, 500) } : {}),
    ...(pages.length > 0 ? { pages } : {}),
  };
}

/**
 * v3 F2: the request with the Last Major Revision steps appended, the note added to its proposal, and each such page's
 * lock added to the job-level locks when it holds any (a chronology job holds only documents: the page becomes its
 * page lock; a page job holds its page already).
 */
function withLmr(req: BatchSubmit, lmr: LmrPlan): BatchSubmit {
  // v3 F3c: the rule (or the caller) decided not to set the row: only the note is added.
  if (lmr.steps.length === 0) return { ...req, proposal: { ...req.proposal, lmrNote: lmr.note } };
  const holds = req.holdLock !== undefined || (req.holdDocuments?.length ?? 0) > 0;
  let holdLock = req.holdLock;
  let more = req.holdMore?.resources ?? [];
  if (holds) {
    for (const page of lmr.pages) {
      if (holdLock === undefined) holdLock = { resourceId: page };
      else if (holdLock.resourceId !== page && req.holdAlso?.resourceId !== page && !more.includes(page))
        more = [...more, page];
    }
  }
  return {
    ...req,
    steps: [...req.steps, ...lmr.steps],
    internal: true,
    proposal: { ...req.proposal, lmrNote: lmr.note },
    ...(holdLock ? { holdLock } : {}),
    ...(more.length > (req.holdMore?.resources?.length ?? 0)
      ? { holdMore: { ...req.holdMore, resources: more } }
      : {}),
  };
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

/** v3 F3d (ADR 0058): `BatchSubmit.resumable` as stored (bridge code only; anything malformed is left out). */
function resumableOf(r: BatchSubmit['resumable']): ResumableShape | undefined {
  if (
    !r ||
    (r.kind !== 'package' &&
      r.kind !== 'rename' &&
      r.kind !== 'recreate' &&
      r.kind !== 'split' &&
      r.kind !== 'retag')
  )
    return undefined;
  const recheck = (r.recheck ?? []).filter((n) => Number.isInteger(n) && n >= 1);
  const recheckCheckers = (Array.isArray(r.recheckCheckers) ? r.recheckCheckers : [])
    .filter((c): c is string => typeof c === 'string' && c !== '')
    .slice(0, 10);
  return {
    kind: r.kind,
    ...(recheck.length > 0 ? { recheck } : {}),
    ...(recheckCheckers.length > 0 ? { recheckCheckers } : {}),
    ...(typeof r.ref === 'string' && r.ref !== '' ? { ref: r.ref.slice(0, 100) } : {}),
  };
}

/** v3 F3d (ADR 0058): `BatchSubmit.waitFor` as stored (bridge code only). */
function waitForOf(w: BatchSubmit['waitFor']): WaitForShape | undefined {
  if (!w || w.kind !== 'pack_version' || typeof w.packId !== 'string' || !Number.isInteger(w.version))
    return undefined;
  return { kind: w.kind, packId: w.packId, version: w.version, reason: String(w.reason ?? '').slice(0, 500) };
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
    // v2 E1a: set by bridge code only.
    ...(Array.isArray(o.dropIfRefused) && o.dropIfRefused.every((k) => typeof k === 'string')
      ? { dropIfRefused: [...o.dropIfRefused] }
      : {}),
    // v3 F2: set by bridge code only.
    ...(o.decisionFrom && Number.isInteger(o.decisionFrom.step)
      ? { decisionFrom: { step: o.decisionFrom.step } }
      : {}),
    ...(o.followUp === 'lmr_failed' ||
    o.followUp === 'image_relink_failed' ||
    o.followUp === 'placement_failed'
      ? { followUp: o.followUp }
      : {}),
    ...(o.findOrCreate === true ? { findOrCreate: true } : {}),
    ...(o.onlyIfEmpty === true ? { onlyIfEmpty: true } : {}),
    // v2 D3: set by bridge code only.
    ...(o.bindFrom &&
    Number.isInteger(o.bindFrom.step) &&
    (o.bindFrom.to === 'body.folderId' ||
      o.bindFrom.to === 'path.assetId' ||
      o.bindFrom.to === 'path.documentId')
      ? {
          bindFrom: {
            step: o.bindFrom.step,
            to: o.bindFrom.to,
            ...(typeof o.bindFrom.from === 'string' &&
            (/^documents\.[0-4]\.id$/.test(o.bindFrom.from) || o.bindFrom.from === 'documents.main.id')
              ? { from: o.bindFrom.from }
              : {}),
          },
        }
      : {}),
    // v3 F3a (ADR 0050): set by bridge code only.
    ...(o.bindAssetUrls &&
    o.bindAssetUrls.length > 0 &&
    o.bindAssetUrls.every((b) => Number.isInteger(b.step) && typeof b.placeholder === 'string')
      ? {
          bindAssetUrls: o.bindAssetUrls.map((b) => ({
            step: b.step,
            placeholder: b.placeholder,
            ...(b.field === 'id' ? { field: 'id' as const } : {}),
          })),
        }
      : {}),
    ...(o.fill && typeof o.fill.filler === 'string'
      ? { fill: { filler: o.fill.filler, ...(o.fill.input !== undefined ? { input: o.fill.input } : {}) } }
      : {}),
    // v3 F3.4 (ADR 0055): set by the engine only (readBeforeSteps).
    ...(o.readBefore === true ? { readBefore: true } : {}),
    // v3 F3d (ADR 0058): a proposal's items (the owner's selection reads them; the engine runs the step the same).
    ...(Array.isArray(o.items) && o.items.length > 0 && o.items.every((x) => typeof x === 'string')
      ? { items: [...o.items] }
      : {}),
    ...itemPartsOf(o.itemParts),
    // v3 F3d amendment (ADR 0058, A): set by bridge code only.
    ...rebaseOf(o.rebase),
  };
}

/** v3 F3d amendment (ADR 0058, A): `StepOptions.rebase` as stored (bridge code only). */
export function rebaseOf(r: StepOptions['rebase']): Pick<StepOptions, 'rebase'> {
  if (!r || typeof r.rebaser !== 'string' || r.rebaser === '') return {};
  return {
    rebase: {
      rebaser: r.rebaser,
      input: r.input,
      ...(r.core === true ? { core: true } : {}),
      ...(r.always === true ? { always: true } : {}),
      ...(Array.isArray(r.with) && r.with.length > 0 && r.with.every((x) => typeof x === 'string')
        ? { with: [...r.with] }
        : {}),
    },
  };
}

/**
 * v3 F3.4 (ADR 0055 decision E): the steps (0-based) of a request about to run directly that must read their target
 * before they write: an `updateBlock` named by a Last Major Revision decision that measures the edit when it runs
 * (`measure`: the page has, or may have, the row and the mode is `auto`), and that keeps no pre-image of its own. Such
 * a write sends only the fields it changes, so without the read the rule had no "before" and counted every edit.
 */
function readBeforeSteps(
  steps: readonly { op: string; params?: OpParams; options?: StepOptions }[],
): Set<number> {
  const out = new Set<number>();
  for (const s of steps) {
    if (s.op !== LMR_STEP) continue;
    const b = (s.params?.body ?? {}) as { after?: unknown; measure?: unknown };
    if (b.measure === undefined || !Array.isArray(b.after)) continue;
    for (const n of b.after) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > steps.length) continue;
      const t = steps[n - 1]!;
      if (t.op === 'updateBlock' && t.options?.journalPreImage === undefined) out.add(n - 1);
    }
  }
  return out;
}

/**
 * v3 F3a (ADR 0050): the main page document among a created page's documents: the one named `Main` (any case) of type
 * page or blank, else the only page or blank document; undefined otherwise.
 */
export function mainDocumentId(documents: unknown): string | undefined {
  if (!Array.isArray(documents)) return undefined;
  const docs = (documents as { id?: unknown; name?: unknown; type?: unknown }[]).filter(
    (d) =>
      d &&
      typeof d.id === 'string' &&
      d.id.length > 0 &&
      (d.type === 'page' || d.type === 'blank' || d.type === undefined),
  );
  const named = docs.filter((d) => typeof d.name === 'string' && d.name.trim().toLowerCase() === 'main');
  if (named.length === 1) return named[0]!.id as string;
  if (named.length === 0 && docs.length === 1) return docs[0]!.id as string;
  return undefined;
}

export function createJobEngine(options: CreateJobEngineOptions): JobEngine {
  return new JobEngine(options);
}

/**
 * v2 E5.2: what a step planned by bridge code writes, from its journal operation, for an error the owner must act on:
 * `page “Arkona” (bwrldgeo), document “Arkona Map” (d1), feature “Old Port” (f1)`. Null when it names nothing.
 */
export function describeStep(op: Readonly<Record<string, unknown>> | undefined): string | null {
  if (!op) return null;
  const named = (kind: string, v: unknown): string | null => {
    if (v === null || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id !== '' ? o.id : null;
    const name = typeof o.name === 'string' && o.name !== '' ? o.name : null;
    if (!id && !name) return null;
    return `${kind} ${name ? `“${name}”` : ''}${name && id ? ' ' : ''}${id ? `(${id})` : ''}`;
  };
  const parts = [
    named('page', op.page),
    named('document', op.document),
    named('feature', op.feature),
    ...(typeof op.feature !== 'object' && typeof op.write === 'string' && op.write !== ''
      ? [`writing ${op.write}`]
      : []),
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** v3 F3d (ADR 0058): a step's item parts, as stored (each a path and, per element there, its items), or nothing. */
function itemPartsOf(v: unknown): { itemParts?: { path: string; items: string[][] }[] } {
  if (!Array.isArray(v) || v.length === 0) return {};
  const out: { path: string; items: string[][] }[] = [];
  for (const p of v as unknown[]) {
    if (typeof p !== 'object' || p === null) return {};
    const { path, items } = p as { path?: unknown; items?: unknown };
    if (typeof path !== 'string' || !Array.isArray(items)) return {};
    out.push({
      path,
      items: (items as unknown[]).map((x) =>
        Array.isArray(x) ? (x as unknown[]).filter((y): y is string => typeof y === 'string') : [],
      ),
    });
  }
  return { itemParts: out };
}
