/**
 * The job engine (PLAN §6): everything that talks to LegendKeeper runs as a persisted step, through the governor,
 * with writer slots, locks, guards and the write journal. See src/jobs/README.md for the interface.
 */
import { randomBytes } from 'node:crypto';
import { WRITERS_LIMIT, WRITERS_MIN, type JobsSettings } from '../config/jobs.js';
import type { Db } from '../db/open.js';
import type { LkClient } from '../lk/client.js';
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
  UncertainOutcomeError,
  UnknownOperationError,
  UnsupportedBlockLossError,
  VersionConflictError,
  errorToJson,
} from './errors.js';
import { JobEventEmitter } from './events.js';
import { checkSubmitGuards, isWriteOp } from './guards.js';
import { isClientId, mintClientId, newJobId } from './ids.js';
import { WriteJournal, journalLookup, type JournalFilter } from './journal.js';
import { callOp, newCallStats } from './lk-call.js';
import { LockManager } from './locks.js';
import { opMeta } from './op-meta.js';
import {
  ALLOW_ALL_GATE,
  DENY_PROPOSALS_SINK,
  policyOpMeta,
  type PolicyDecision,
  type PolicyGate,
  type ProposalMeta,
  type ProposalSink,
  type ProposedOp,
} from './policy.js';
import { createJobQueries, JobsRepo, type ErrorInput, type NewStep } from './repo.js';
import { StepExecutor, type StepOutcome } from './step-exec.js';
import {
  SYSTEM_PRINCIPAL,
  TERMINAL_JOB_STATUSES,
  type BatchSubmit,
  type ControlsView,
  type JobKind,
  type JobOrigin,
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
  type SubmitRequest,
  type SubmitResult,
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
  readonly lk: LkClient;
  readonly settings: JobsSettings;
  readonly clock?: Clock;
  readonly log?: EngineLogger;
  /** Start scheduling (and restart-resume) at once. Default true. */
  readonly autoStart?: boolean;
  /** Asked about every operation at entry (default: allow everything). See policy.ts. */
  readonly policyGate?: PolicyGate;
  /** Receives work the gate wants approved (default: treats "propose" as "deny"). */
  readonly proposalSink?: ProposalSink;
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
  readonly def: OperationDef;
  readonly step: NewStep;
}

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
  private readonly lk: LkClient;
  private readonly db: Db;
  private readonly policyGate: PolicyGate;
  private readonly proposalSink: ProposalSink;
  private readonly active = new Map<string, Active>();
  private readonly resumeTimers = new Map<string, TimerHandle>();
  private readonly waitingLock = new Set<string>();
  private readonly drainWaiters: (() => void)[] = [];
  private readOnlyOverride: boolean | null;
  private writesPaused: boolean;
  private draining = false;
  private started = false;
  private stopped = false;
  private pumpQueued = false;
  readonly queries;

  constructor(o: CreateJobEngineOptions) {
    this.db = o.db;
    this.lk = o.lk;
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
      lk: o.lk,
      repo: this.repo,
      journal: this.journal,
      locks: this.locks,
      writers: this.writers,
      settings: o.settings,
      now,
      recordLkError: (err, ref) => this.recordLkError(err, ref),
      setJobWaiting: (jobId, waiting, detail) => this.setWaitingLock(jobId, waiting, detail),
      writeHold: () => this.writeHold(),
    });
    const base = createJobQueries(o.db);
    this.queries = {
      ...base,
      resolveErrorGroup: (fingerprint: string) => base.resolveErrorGroup(fingerprint, this.clock.now()),
      journalLookup: (filter: JournalFilter = {}) => journalLookup(o.db, filter),
      writers: (): WritersView => this.writers.view(),
      locks: (): LockView[] => this.locks.state(),
      controls: (): ControlsView => this.controlsView(),
    };
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
    for (const t of this.resumeTimers.values()) this.clock.clearTimeout(t);
    this.resumeTimers.clear();
    for (const a of this.active.values()) a.current.abort(new CancelledError());
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
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
    const def = this.validate(opId, params);
    const options = stepOptions(opts);
    const origin = normaliseOrigin(opts.origin);
    const title = opts.title ?? def.operationId;
    const priority = opts.priority ?? 'P1';
    const proposal = await this.authorize([{ def, params, options }], origin, 'single_op', {
      title,
      priority,
    });
    if (proposal) return proposal;
    checkSubmitGuards(def, params, options, this.guardContext());
    const estimate = this.estimateFor([{ def, params }], priority);
    const slow = estimate.wallClockMs > this.settings.inlineMaxEstimateMs;

    if (!isWriteOp(def) && !slow) return this.runInlineRead(def, params, priority, origin, opts.signal);
    if (this.draining) throw new DrainingError();

    const prepared = this.prepare(def, params, options);
    const hold = isWriteOp(def) ? this.writeHold() : null;
    if (slow || hold) {
      const job = this.createJob('single_op', title, origin, priority, 'stop', [prepared], 'queued');
      this.pump();
      return {
        status: 'queued',
        jobId: job.id,
        eta: hold ? null : this.clock.now() + estimate.wallClockMs,
        reason: hold ?? 'estimate',
      };
    }

    // Inline write: recorded as a one-step job and run now, through the same slots, locks and guards.
    const job = this.createJob('single_op', title, origin, priority, 'stop', [prepared], 'running');
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
      const reason = (final.waitReason?.held as 'writes_paused' | 'read_only' | undefined) ?? 'writes_paused';
      return { status: 'queued', jobId: job.id, eta: null, reason };
    }
    if (final.status === 'cancelled') throw new CancelledError({ jobId: job.id, stepNo: 1 });
    if (last?.kind === 'failed') throw last.error;
    throw new JobsError('BRIDGE_ERROR', `Job ${job.id} ended ${final.status}`, { jobId: job.id });
  }

  private async runInlineRead(
    def: OperationDef,
    params: OpParams,
    priority: PriorityClass,
    origin: JobOrigin,
    signal: AbortSignal | undefined,
  ): Promise<RunResult> {
    const stats = newCallStats();
    const principal = origin.principal ?? SYSTEM_PRINCIPAL;
    try {
      const result = await callOp(this.lk, def, params, {
        priority,
        signal,
        requestIdPrefix: `lkb.r${randomBytes(6).toString('hex')}`,
        stats,
        onError: (err) =>
          this.recordLkError(err, {
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

  // ============================================================================================ jobs

  /** Queues a multi-step job: `batch_ops` (ordered registry calls) or `paginate_all` (every page of a list). */
  async submit(req: SubmitRequest): Promise<SubmitResult | ProposalCaptured> {
    if (this.draining) throw new DrainingError();
    return req.kind === 'batch_ops' ? this.submitBatch(req) : this.submitPaginate(req);
  }

  private async submitBatch(req: BatchSubmit): Promise<SubmitResult | ProposalCaptured> {
    if (req.steps.length === 0)
      throw new InvalidParamsError('batch_ops', [{ path: 'steps', message: 'Empty' }]);
    const origin = normaliseOrigin(req.origin);
    const validated = req.steps.map((s: StepSpec, i) => {
      const params = s.params ?? {};
      try {
        return { def: this.validate(s.op, params), params, options: stepOptions(s) };
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
    const priority = req.priority ?? 'P2';
    const onError: OnError = req.onError ?? 'stop';
    const title = req.title ?? `batch of ${validated.length} operation(s)`;
    // Every step is put to the policy gate before anything is queued: one deny denies the batch, one propose
    // turns the whole batch into one proposal.
    const proposal = await this.authorize(validated, origin, 'batch_ops', { title, priority, onError });
    if (proposal) return proposal;
    if (this.draining) throw new DrainingError();
    const guard = this.guardContext();
    for (const v of validated) checkSubmitGuards(v.def, v.params, v.options, guard);
    const prepared = validated.map((v) => this.prepare(v.def, v.params, v.options));
    const job = this.createJob('batch_ops', title, origin, priority, onError, prepared, 'queued');
    const estimate = this.estimateFor(
      prepared.map((p) => ({ def: p.def, params: p.step.params })),
      priority,
    );
    this.pump();
    const held = prepared.some((p) => isWriteOp(p.def)) && this.writeHold() !== null;
    return { jobId: job.id, status: job.status, eta: held ? null : this.clock.now() + estimate.wallClockMs };
  }

  private async submitPaginate(req: PaginateSubmit): Promise<SubmitResult | ProposalCaptured> {
    const params = req.params ?? {};
    const def = this.validate(req.op, params);
    if (!def.paged || def.kind !== 'read') {
      throw new InvalidParamsError(req.op, [
        { path: 'op', message: 'paginate_all needs a paged read operation' },
      ]);
    }
    const origin = normaliseOrigin(req.origin);
    const title = req.title ?? `${def.operationId}: every page`;
    const proposal = await this.authorize([{ def, params, options: {} }], origin, 'paginate_all', {
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
      eta: this.clock.now() + this.estimateFor([{ def, params }], priority).wallClockMs,
    };
  }

  /** Bounded wait (at most `maxWaitMs`, 25 s) for a job to finish. Resolves with the job as it then stands. */
  wait(jobId: string, ms: number): Promise<JobView> {
    const job = this.repo.job(jobId);
    if (!job) return Promise.reject(new JobNotFoundError(jobId));
    if (TERMINAL_JOB_STATUSES.has(job.status)) return Promise.resolve(job);
    const bounded = Math.max(0, Math.min(ms, this.settings.maxWaitMs));
    return new Promise((resolve) => {
      let timer: TimerHandle | undefined = undefined;
      const off = this.events.on('job', (e) => {
        if (e.job.id === jobId && TERMINAL_JOB_STATUSES.has(e.job.status)) finish(e.job);
      });
      const finish = (v: JobView) => {
        off();
        if (timer) this.clock.clearTimeout(timer);
        resolve(v);
      };
      timer = this.clock.setTimeout(() => finish(this.repo.job(jobId) ?? job), bounded);
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
    /** Cancels a job: an in-flight step completes, then it stops; nothing further is sent. */
    cancel: (jobId: string): JobView => this.cancelJob(jobId),
    /** Pauses a job after its in-flight step. */
    pauseJob: (jobId: string): JobView => {
      const job = this.requireJob(jobId);
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
    resumeJob: (jobId: string): JobView => {
      const job = this.requireJob(jobId);
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
    retryStep: (jobId: string, stepNo: number, opts: { readonly force?: boolean } = {}): JobView => {
      const job = this.requireJob(jobId);
      if (this.active.has(jobId) || !TERMINAL_JOB_STATUSES.has(job.status) || job.status === 'cancelled') {
        throw new InvalidControlError(`Job ${jobId} must have failed to retry a step`, { jobId, stepNo });
      }
      const step = this.repo.step(jobId, stepNo);
      if (!step || (step.status !== 'failed' && step.status !== 'uncertain')) {
        throw new InvalidControlError(`Step ${stepNo} of ${jobId} has not failed`, { jobId, stepNo });
      }
      const def = getOperation(step.opId)!;
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
          idempotencyKey: def.method === 'POST' ? idempotencyKeyFor(jobId, stepNo, attempt0) : null,
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

  /** Records a budget snapshot for the Request Budgets sparklines (chunk 6 schedules this every 10 s). */
  recordBudgetSample(snapshot: BudgetSnapshot = this.lk.governor.snapshot()): void {
    this.repo.recordBudgetSample(snapshot);
  }

  /** Journal retention (default 30 days or 2 GB). The scheduled `journal-prune` job (chunk 6) calls this. */
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
    const hold = this.writeHold();
    for (const job of this.repo.queuedJobs(capacity + 100)) {
      if (capacity <= 0) break;
      if (this.active.has(job.id)) continue;
      const step = this.repo.nextStep(job.id);
      if (step && hold && step.opKind !== 'read') {
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

  private async runJob(jobId: string, entry: Active): Promise<RunnerResult> {
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
      const step = this.repo.nextStep(jobId);
      if (!step) {
        this.finish(jobId);
        return { last, values };
      }
      const recovering = step.status === 'running';
      if (!recovering) {
        if (job.cancelRequested) {
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
      }
      entry.current = new AbortController();
      this.repo.updateJob(jobId, { currentStep: step.stepNo });
      const outcome = await this.executor.execute(job, step, entry.current.signal, {
        storeResult: job.kind !== 'paginate_all',
      });
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

  private createJob(
    kind: JobKind,
    title: string,
    origin: JobOrigin,
    priority: PriorityClass,
    onError: OnError,
    steps: readonly PreparedStep[],
    status: JobStatus,
    options?: Record<string, unknown>,
  ): JobView {
    const job = this.repo.insertJob({
      id: newJobId(),
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
    items: readonly { def: OperationDef; params: OpParams | undefined }[],
    priority: PriorityClass,
  ) {
    let reads = 0;
    let writes = 0;
    let createManyItems = 0;
    for (const { def, params } of items) {
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
    return this.lk.governor.estimate({ reads, writes, createManyItems, priority });
  }

  private guardContext() {
    return { readOnly: this.readOnly(), allowMemberAdmin: this.settings.allowMemberAdmin };
  }

  private readOnly(): boolean {
    return this.readOnlyOverride ?? this.settings.readOnly;
  }

  private writeHold(): 'writes_paused' | 'read_only' | null {
    if (this.readOnly()) return 'read_only';
    if (this.writesPaused) return 'writes_paused';
    return null;
  }

  /** Drops stale "held" reasons once writes may run again. */
  private clearHolds(): void {
    if (this.writeHold() !== null) return;
    for (const job of this.repo.jobsWithStatus(['queued'])) {
      if (job.waitReason?.held) {
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

  private requireJob(jobId: string): JobView {
    const job = this.repo.job(jobId);
    if (!job) throw new JobNotFoundError(jobId);
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
      this.events.emit('step', { jobId: job.id, principalId: job.principalId, profile: job.profile, step });
    }
  }

  private controlsView(): ControlsView {
    return {
      writesPaused: this.writesPaused,
      draining: this.draining,
      readOnly: this.readOnly(),
      readOnlyOverride: this.readOnlyOverride,
      writersMax: this.writers.max,
      allowMemberAdmin: this.settings.allowMemberAdmin,
    };
  }

  private controlsChanged(): ControlsView {
    const v = this.controlsView();
    this.events.emit('controls', v);
    return v;
  }

  private recordLkError(
    err: BridgeLkError,
    ref: { opId: string; jobId?: string; stepNo?: number; principalId?: string; profile?: string },
  ): void {
    this.recordError({
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
    items: readonly { def: OperationDef; params: OpParams; options: StepOptions }[],
    origin: JobOrigin,
    jobKind: JobKind,
    meta: Omit<ProposalMeta, 'kind' | 'origin'>,
  ): Promise<ProposalCaptured | null> {
    const principal = origin.principal ?? SYSTEM_PRINCIPAL;
    const batch = jobKind === 'batch_ops';
    let propose = false;
    for (let i = 0; i < items.length; i++) {
      const { def, params, options } = items[i]!;
      let decision: PolicyDecision;
      try {
        decision = await this.policyGate.authorize(principal, policyOpMeta(def, options), params, {
          origin,
          jobKind,
          ...(batch ? { stepIndex: i } : {}),
        });
      } catch (e) {
        decision = {
          decision: 'deny',
          reason: `the policy gate failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (decision.decision === 'deny') {
        throw this.policyDenied(
          new PolicyDeniedError(
            def.operationId,
            decision.reason,
            principal.principalId,
            batch ? i : undefined,
          ),
          principal,
        );
      }
      if (decision.decision === 'propose') propose = true;
    }
    if (!propose) return null;
    const ops: ProposedOp[] = items.map(({ def, params, options }) => ({
      op: def.operationId,
      params,
      ...options,
    }));
    try {
      const { proposalId } = await this.proposalSink.capture(principal, ops, {
        ...meta,
        kind: jobKind,
        origin,
      });
      return { status: 'proposal_captured', proposalId };
    } catch (e) {
      if (e instanceof PolicyDeniedError) throw this.policyDenied(e, principal);
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

  private policyDenied(error: PolicyDeniedError, principal: Principal): PolicyDeniedError {
    this.recordError({
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
  };
}

export function createJobEngine(options: CreateJobEngineOptions): JobEngine {
  return new JobEngine(options);
}
