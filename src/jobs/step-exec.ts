/**
 * Executes one persisted step: lock → writer slot → (one read) → guards → journal → send → record.
 * Also the verify-before-resend logic used after a restart and after an ambiguous failure (PLAN §5.3, §6.1).
 */
import type { LkClient } from '../lk/client.js';
import { BridgeLkError, BudgetWaitError } from '../lk/errors.js';
import type { VerifyResult } from '../lk/governor/types.js';
import { requireOperation } from '../lk/registry.js';
import type { OperationDef } from '../lk/registry-types.js';
import type { JobsSettings } from '../config/jobs.js';
import { matchesIntent } from './compare.js';
import type { CustomStepHandler, CustomStepHandlers } from './custom-steps.js';
import type { StepPlanner } from './planners.js';
import { compareStoredBlocks, VERIFY_IGNORED_FIELDS } from './verify-blocks.js';
import {
  JobsError,
  LkOperationError,
  UncertainOutcomeError,
  VersionConflictError,
  errorToJson,
  type JobRef,
} from './errors.js';
import { assertNoUnsupportedLoss } from './guards.js';
import type { WriteJournal } from './journal.js';
import { callOp, isNotFound, newCallStats, type CallStats } from './lk-call.js';
import type { LockManager } from './locks.js';
import { READERS, opMeta, type OpMeta, type ReaderDef } from './op-meta.js';
import type { JobsRepo } from './repo.js';
import type { JobView, OpParams, StepView } from './types.js';
import type { WriterPool } from './writers.js';

export type StepOutcome =
  | { readonly kind: 'succeeded'; readonly value: unknown; readonly requestIds: readonly string[] }
  | { readonly kind: 'failed'; readonly error: JobsError; readonly uncertain: boolean }
  | { readonly kind: 'budget'; readonly retryAtMs: number; readonly error: BudgetWaitError }
  | { readonly kind: 'aborted' }
  /**
   * Writes were paused (or read-only switched on, or the project taken out of service) while the step waited for its
   * lock or slot, or before it started; nothing was sent.
   */
  | { readonly kind: 'held'; readonly reason: WriteHold };

/** Why a write may not start now (v2 A1 adds `project_unavailable`). */
export type WriteHold = 'writes_paused' | 'read_only' | 'project_unavailable';

export interface StepExecDeps {
  /** The LK client of the job's project while it is served; undefined otherwise (v2 A1: one governor per project). */
  readonly lkFor: (projectId: string) => LkClient | undefined;
  readonly repo: JobsRepo;
  readonly journal: WriteJournal;
  readonly locks: LockManager;
  readonly writers: WriterPool;
  readonly settings: JobsSettings;
  readonly now: () => number;
  readonly recordLkError: (
    error: BridgeLkError,
    ref: {
      projectId: string;
      opId: string;
      jobId?: string;
      stepNo?: number;
      principalId?: string;
      profile?: string;
    },
  ) => void;
  readonly setJobWaiting: (jobId: string, waiting: 'lock' | null, detail?: Record<string, unknown>) => void;
  /** Null when a new write to this project may start now; otherwise why not. */
  readonly writeHold: (projectId: string) => WriteHold | null;
  /** Non-registry step types (the upload_image PUT), by step id. */
  readonly customSteps?: CustomStepHandlers | undefined;
  /** v2 C1: the in-lock planners, by name (src/jobs/planners.ts). */
  readonly planner?: (name: string) => StepPlanner | undefined;
  /** v2 C1: a page write that did not land as planned (recorded in the errors table, with the job). */
  readonly recordVerifyMismatch?: (job: JobView, step: StepView, verification: WriteVerification) => void;
}

/**
 * v2 C1: what the read after a verified page write found (ADR 0031). `verified`: the stored blocks equal the blocks
 * sent; `mismatch`: they differ (`differences`); `not_checked`: the read could not be made (`reason`). Never a retry.
 */
export interface WriteVerification {
  readonly status: 'verified' | 'mismatch' | 'not_checked';
  /** The version the verify read saw. */
  readonly version?: string | undefined;
  readonly differences?: readonly { path: string; expected: unknown; actual: unknown }[];
  readonly differenceCount?: number;
  readonly reason?: string;
  /** The write's journal entry, for recovery. */
  readonly journalId?: number | undefined;
  /** What LegendKeeper may change without it counting (listed explicitly). */
  readonly ignored: readonly string[];
}

/** The value of a verified page-write step (instead of LegendKeeper's whole answer, which the verify read repeats). */
export interface VerifiedWriteValue {
  readonly document: { readonly id: unknown; readonly version: unknown };
  readonly verification: WriteVerification;
  /** The step re-planned inside the lock: from which version to which. */
  readonly replanned?: Readonly<Record<string, unknown>>;
  /** The re-plan found nothing to change; nothing was sent. */
  readonly unchanged?: boolean;
}

interface Current {
  readonly exists: boolean;
  readonly body: unknown;
  /** The targeted entity (list readers select it; otherwise the body). */
  readonly entity: unknown;
  readonly version: string | undefined;
}

type Recovery =
  | { readonly kind: 'applied'; readonly value: unknown }
  /** Safe to send (again). `ambiguous`: it may still have applied, but the key or version makes a re-send safe. */
  | { readonly kind: 'not-applied'; readonly ifMatch?: string | undefined; readonly ambiguous?: boolean }
  | { readonly kind: 'uncertain'; readonly reason: string }
  /** createManyResources only: some minted ids exist at LK, the rest (`missing`) do not. */
  | { readonly kind: 'partial'; readonly found: readonly unknown[]; readonly missing: readonly string[] };

const RESOURCE_CREATES = new Set(['createResource', 'createManyResources', 'createResourceFromTemplate']);
/** Operations that add an entity (journal target: the new entity, not its container). */
const CREATES = /^(create|insert|invite|saveResourceAsTemplate)/;

/**
 * The lock a write step must hold, within its project (see locks.ts for the key scheme and ordering rules). The engine
 * prefixes it with the project id (`projectLockKey`): entity ids are only unique within a LegendKeeper project.
 */
export function lockKeyFor(op: OperationDef, params: OpParams): string | null {
  if (op.kind === 'read') return null;
  const path = params.path ?? {};
  if (RESOURCE_CREATES.has(op.operationId)) {
    const parent = createParent(op, params);
    return parent === null ? null : `res:${parent}`;
  }
  if (op.concurrency === 'document' && path.documentId) return `doc:${path.documentId}`;
  if (op.concurrency === 'resource' && path.resourceId) return `res:${path.resourceId}`;
  if (path.calendarId) return `cal:${path.calendarId}`;
  if (path.assetId) return `asset:${path.assetId}`;
  return null;
}

/** The lock key as the lock manager sees it: `<projectId>:<key>` (v2 A1). */
export function projectLockKey(projectId: string, key: string | null): string | null {
  return key === null ? null : `${projectId}:${key}`;
}

/** Parent of a resource create: `@root` when none; for a batch, the one outside parent (null if several). */
function createParent(op: OperationDef, params: OpParams): string | null {
  const body = (params.body ?? {}) as { parentId?: unknown; resources?: unknown };
  if (op.operationId !== 'createManyResources') {
    return typeof body.parentId === 'string' && body.parentId ? body.parentId : '@root';
  }
  const items = Array.isArray(body.resources)
    ? (body.resources as { id?: unknown; parentId?: unknown }[])
    : [];
  const own = new Set(items.map((i) => i.id).filter((x): x is string => typeof x === 'string'));
  const outside = new Set(
    items
      .map((i) => (typeof i.parentId === 'string' && i.parentId ? i.parentId : '@root'))
      .filter((p) => !own.has(p)),
  );
  return outside.size === 1 ? [...outside][0]! : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isDeleted(entity: unknown): boolean {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    typeof (entity as { deletedAt?: unknown }).deletedAt === 'string'
  );
}

export class StepExecutor {
  constructor(private readonly d: StepExecDeps) {}

  /** The job's project client, or a typed refusal when the project is not served now (the step is not sent). */
  private lk(job: JobView): LkClient {
    const lk = this.d.lkFor(job.projectId);
    if (!lk) {
      throw new JobsError('PROJECT_UNAVAILABLE', `Project ${job.projectId} is not available now`, {
        jobId: job.id,
      });
    }
    return lk;
  }

  /** Runs a step to an outcome and persists it. `signal` aborts only lock/slot waits, never an in-flight call. */
  async execute(
    job: JobView,
    step: StepView,
    signal: AbortSignal,
    opts: { readonly storeResult?: boolean } = {},
  ): Promise<StepOutcome> {
    // A project taken out of service (its key failed a check) runs nothing more until it is back: the job is held. A
    // step being recovered waits too: verifying it needs the project's client.
    if (!this.d.lkFor(job.projectId)) {
      return { kind: 'held', reason: 'project_unavailable' };
    }
    const custom = this.d.customSteps?.[step.opId];
    if (custom) return this.runCustom(job, step, custom);
    const op = requireOperation(step.opId);
    const params = this.d.repo.stepParams(step);
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const store = opts.storeResult !== false;
    if (op.kind === 'read') return this.runRead(job, step, op, params, store);

    const lockKey = projectLockKey(job.projectId, lockKeyFor(op, params));
    let releaseLock: (() => void) | undefined;
    let releaseSlot: () => void;
    try {
      if (lockKey) {
        if (!this.d.locks.isFree(lockKey)) this.d.setJobWaiting(job.id, 'lock', { lockKey });
        releaseLock = await this.d.locks.acquire(
          lockKey,
          { jobId: job.id, stepNo: step.stepNo, principalId: job.principalId },
          signal,
        );
        this.d.setJobWaiting(job.id, null);
      }
      releaseSlot = await this.d.writers.acquire(
        {
          projectId: job.projectId,
          jobId: job.id,
          stepNo: step.stepNo,
          opId: op.operationId,
          principalId: job.principalId,
          profile: job.profile,
          lockKey,
          resourceId: params.path?.resourceId ?? null,
          documentId: params.path?.documentId ?? null,
        },
        signal,
      );
    } catch (e) {
      releaseLock?.();
      this.d.setJobWaiting(job.id, null);
      if (signal.aborted) return { kind: 'aborted' };
      throw e;
    }
    try {
      const hold = step.status === 'running' ? null : this.d.writeHold(job.projectId);
      if (hold) return { kind: 'held', reason: hold };
      return await this.runWrite(job, step, op, params, ref, store);
    } finally {
      releaseSlot();
      releaseLock?.();
    }
  }

  // ------------------------------------------------------------------------------------------ custom steps

  /**
   * A non-registry step (the upload_image PUT). Not an LK write, so it takes no lock or writer slot, but it is held
   * while writes are paused or read-only is on, like the LK steps around it. The handler's own network calls go
   * through the governor; a failure it throws is recorded like any LK failure. Nothing here can have changed LK, so
   * the step is never "maybe sent": a restart simply runs it again.
   */
  private async runCustom(job: JobView, step: StepView, handler: CustomStepHandler): Promise<StepOutcome> {
    const hold = step.status === 'running' ? null : this.d.writeHold(job.projectId);
    if (hold) return { kind: 'held', reason: hold };
    const stats = newCallStats();
    const now = this.d.now();
    this.d.repo.updateStep(job.id, step.stepNo, {
      status: 'running',
      startedAt: step.startedAt ?? now,
      firstSentAt: step.firstSentAt ?? now,
    });
    try {
      const value = await handler({
        jobId: job.id,
        stepNo: step.stepNo,
        priority: job.priority,
        lk: this.lk(job),
        params: this.d.repo.stepParams(step),
        resultOf: (n) => {
          const s = this.d.repo.step(job.id, n);
          return s ? this.d.repo.stepResult(s) : null;
        },
        replaceParams: (p) => this.d.repo.setStepParams(job.id, step.stepNo, p),
      });
      return this.succeed(job, step, stats, value);
    } catch (e) {
      if (e instanceof BridgeLkError && !(e instanceof BudgetWaitError && e.status === undefined)) {
        this.d.recordLkError(e, {
          projectId: job.projectId,
          opId: step.opId,
          jobId: job.id,
          stepNo: step.stepNo,
          principalId: job.principalId,
          profile: job.profile,
        });
      }
      return this.fail(job, step, stats, e);
    }
  }

  // ------------------------------------------------------------------------------------------ reads

  private async runRead(
    job: JobView,
    step: StepView,
    op: OperationDef,
    params: OpParams,
    store: boolean,
  ): Promise<StepOutcome> {
    const stats = newCallStats();
    this.d.repo.updateStep(job.id, step.stepNo, {
      status: 'running',
      startedAt: step.startedAt ?? this.d.now(),
    });
    try {
      const value = await callOp(this.lk(job), op, params, this.callOptions(job, step, stats));
      return this.succeed(job, step, stats, value, false, store);
    } catch (e) {
      return this.fail(job, step, stats, e);
    }
  }

  // ------------------------------------------------------------------------------------------ writes

  private async runWrite(
    job: JobView,
    step: StepView,
    op: OperationDef,
    plannedParams: OpParams,
    ref: JobRef,
    store: boolean,
  ): Promise<StepOutcome> {
    let params = plannedParams;
    let replanned: Readonly<Record<string, unknown>> | undefined;
    const meta = opMeta(op.operationId);
    const stats = newCallStats();
    let forcedIfMatch: string | undefined;
    let ambiguous = false;

    // A step that may already have reached LK is verified before anything is re-sent.
    if (step.status === 'running' || step.maybeSent) {
      const r = await this.safeRecover(job, step, op, meta, params);
      const settled = this.settle(job, step, op, meta, params, stats, r, ref);
      if (settled) return settled;
      if (r.kind === 'not-applied') {
        forcedIfMatch = r.ifMatch;
        ambiguous = r.ambiguous === true;
      }
    }

    try {
      let callerVersion = str(params.ifMatch);
      const journalled = this.d.journal.hasEntry(job.id, step.stepNo);
      const resend = forcedIfMatch !== undefined;
      const needRead =
        !resend &&
        meta.reader !== undefined &&
        ((op.versioned && !callerVersion) ||
          meta.guard !== undefined ||
          (meta.journal === 'pre-image' && !journalled));

      // ONE read serves the If-Match version, the unsupported-block guard and the journal pre-image.
      const current = needRead
        ? await this.readCurrent(job, step, op, meta, params, step.clientIds)
        : undefined;

      let ifMatch: string | undefined;
      if (op.versioned) {
        ifMatch = forcedIfMatch ?? callerVersion ?? current?.version;
        if (!ifMatch) {
          throw new JobsError('BRIDGE_ERROR', `${op.operationId}: could not read the current version`, ref);
        }
        if (callerVersion && current?.version && current.version !== callerVersion) {
          // v2 C1 (PLAN-v2 10.6): the bridge's own compare-and-swap, inside the lock. A step that names a planner may be
          // re-planned on the current document (section edits whose section is unchanged); anything else is a conflict.
          const planner = step.options.replan ? this.d.planner?.(step.options.replan.planner) : undefined;
          if (!planner || !step.options.replan) {
            throw new VersionConflictError(op.operationId, callerVersion, current.version, ref);
          }
          const r = planner({
            projectId: job.projectId,
            jobId: job.id,
            stepNo: step.stepNo,
            opId: op.operationId,
            params,
            input: step.options.replan.input,
            plannedVersion: callerVersion,
            current: { version: current.version, body: current.body },
          });
          if (r.kind === 'unchanged') {
            // The document already holds the result: nothing is sent, nothing is journalled.
            const value: VerifiedWriteValue = {
              document: { id: params.path?.documentId ?? null, version: current.version },
              verification: {
                status: 'not_checked',
                version: current.version,
                reason: 'nothing was written: the document already holds this change',
                ignored: VERIFY_IGNORED_FIELDS,
              },
              unchanged: true,
              replanned: { from: callerVersion, to: current.version, ...r.note },
            };
            return this.succeed(job, step, stats, value, false, store);
          }
          if (str(r.params.ifMatch) !== current.version) {
            throw new JobsError(
              'BRIDGE_ERROR',
              `${op.operationId}: a re-plan must be built on the current version`,
              ref,
            );
          }
          replanned = { from: callerVersion, to: current.version, ...r.note };
          params = r.params;
          this.d.repo.setStepParams(job.id, step.stepNo, params);
          callerVersion = current.version;
          ifMatch = current.version;
        }
      }

      if (meta.guard && current) {
        const incoming =
          meta.guard === 'document' ? (params.body as { blocks?: unknown })?.blocks : params.body;
        const existing =
          meta.guard === 'document' ? (current.body as { blocks?: unknown })?.blocks : current.body;
        assertNoUnsupportedLoss(op.operationId, existing, incoming, step.options, ref);
      }

      // Chunk 8 (required change A): EVERY write gets a journal entry before it is sent (outcome `pending`, settled
      // below), so agents can see each other's edits. Only destructive writes (`meta.journal`) keep a pre-image or ids.
      let journalId: number | undefined;
      if (!journalled) {
        const created = meta.verify === 'client-id' ? step.clientIds : [];
        journalId = this.d.journal.record({
          projectId: job.projectId,
          jobId: job.id,
          stepNo: step.stepNo,
          opId: op.operationId,
          principalId: job.principalId,
          profile: job.profile,
          approvedBy: job.approvedBy,
          risk: op.risk,
          targetKind: meta.reader ?? op.tag,
          // A create's target is the new entity: its client-chosen id, or (set after success) the id LK gives it.
          // The container stays visible in resourceId / documentId.
          targetId: created[0] ?? (CREATES.test(op.operationId) ? null : targetIdOf(op, params)),
          resourceId:
            params.path?.resourceId ?? (RESOURCE_CREATES.has(op.operationId) ? (created[0] ?? null) : null),
          documentId: params.path?.documentId ?? null,
          version: ifMatch ?? current?.version ?? null,
          params,
          ...(step.options.journalOperation
            ? {
                operation: {
                  ...step.options.journalOperation,
                  ...(replanned ? { replannedInLock: replanned } : {}),
                },
              }
            : {}),
          ...(created.length > 1 ? { targets: created } : {}),
          ...(meta.journal === 'pre-image' && current ? { preImage: current.entity ?? current.body } : {}),
        });
      }

      // Durable "running" marker before the request leaves: a restart from here verifies before re-sending.
      const now = this.d.now();
      this.d.repo.updateStep(job.id, step.stepNo, {
        status: 'running',
        ifMatch: ifMatch ?? null,
        startedAt: step.startedAt ?? now,
        firstSentAt: step.firstSentAt ?? now,
      });

      try {
        const value = await callOp(this.lk(job), op, params, {
          ...this.callOptions(job, step, stats),
          ifMatch,
          verify: (ctx) => this.verifyHook(job, step, op, meta, params, ctx.error),
        });
        if (journalId !== undefined) {
          this.d.journal.setOutcome(journalId, 'applied');
          // An insert or create without a client-chosen id: note the id LegendKeeper gave it.
          const createdId = op.method === 'POST' ? (value as { id?: unknown } | null)?.id : undefined;
          if (typeof createdId === 'string' && createdId !== '')
            this.d.journal.setCreatedTarget(journalId, createdId);
        } else this.d.journal.setOutcomeForStep(job.id, step.stepNo, 'applied');
        if (step.options.verifyAfterWrite === true && op.operationId === 'replaceDocumentBlocks') {
          const verification = await this.verifyWrite(job, step, op, meta, params, journalId);
          if (verification.status === 'mismatch') this.d.recordVerifyMismatch?.(job, step, verification);
          const sent = (value ?? {}) as { id?: unknown; version?: unknown };
          const out: VerifiedWriteValue = {
            document: { id: sent.id ?? params.path?.documentId ?? null, version: sent.version ?? null },
            verification,
            ...(replanned ? { replanned } : {}),
          };
          return this.succeed(job, step, stats, out, false, store);
        }
        return this.succeed(job, step, stats, value, false, store);
      } catch (e) {
        const outcome = stats.maybeSent && !(e instanceof BudgetWaitError) ? 'unknown' : 'not_applied';
        this.d.journal.setOutcomeForStep(job.id, step.stepNo, outcome);
        if (e instanceof BridgeLkError && (e.status === 412 || e.code === 'VERSION_MISMATCH')) {
          // PLAN §4 rule 1: re-read, and return a clear conflict with the current version. Never retried.
          const now = meta.reader
            ? await this.readCurrent(job, step, op, meta, params, step.clientIds).catch(() => undefined)
            : undefined;
          throw new VersionConflictError(op.operationId, ifMatch ?? null, now?.version ?? null, ref, e);
        }
        // A failure after the write may have applied: find out now rather than leave it ambiguous. A batch create is
        // not atomic (LK's guide): a failure part-way, or DUPLICATE_ID on a retry, leaves some items created.
        const batch = meta.clientId === 'body.resources[].id';
        const mayHaveApplied =
          e instanceof BridgeLkError &&
          !(e instanceof BudgetWaitError) &&
          ((stats.maybeSent && (e.classification === 'upstream' || batch)) ||
            (batch && e.code === 'DUPLICATE_ID'));
        if (mayHaveApplied) {
          const latest = this.d.repo.step(job.id, step.stepNo) ?? step;
          const r = await this.safeRecover(job, { ...latest, maybeSent: true }, op, meta, params);
          const settled = this.settle(job, step, op, meta, params, stats, r, ref);
          if (settled) return settled;
        }
        throw e;
      }
    } catch (e) {
      return this.fail(job, step, stats, e, ambiguous);
    }
  }

  /**
   * v2 C1: the read after a page write, still inside the lock and the writer slot, so only an edit from outside the
   * bridge can come between the write and this read. Compares the stored blocks with the blocks sent. Never throws and
   * never retries: a read that cannot be made (budget, LegendKeeper) leaves the write unverified, and says why.
   */
  private async verifyWrite(
    job: JobView,
    step: StepView,
    op: OperationDef,
    meta: OpMeta,
    params: OpParams,
    journalId: number | undefined,
  ): Promise<WriteVerification> {
    const entry = journalId ?? this.d.journal.entryIdForStep(job.id, step.stepNo);
    const planned = (params.body as { blocks?: unknown } | undefined)?.blocks;
    try {
      const after = await this.readCurrent(job, step, op, meta, params, step.clientIds);
      const stored = (after.body as { blocks?: unknown } | undefined)?.blocks;
      const cmp = compareStoredBlocks(planned, stored);
      return cmp.ok
        ? { status: 'verified', version: after.version, journalId: entry, ignored: VERIFY_IGNORED_FIELDS }
        : {
            status: 'mismatch',
            version: after.version,
            differences: cmp.differences,
            differenceCount: cmp.count,
            journalId: entry,
            ignored: VERIFY_IGNORED_FIELDS,
          };
    } catch (e) {
      return {
        status: 'not_checked',
        reason: `the document could not be read back: ${e instanceof Error ? e.message : String(e)}`,
        journalId: entry,
        ignored: VERIFY_IGNORED_FIELDS,
      };
    }
  }

  // ------------------------------------------------------------------------------------------ verify

  /** Governor `verify` for 412 / DUPLICATE_ID / NOT_FOUND after an ambiguous retry inside one execute. */
  private async verifyHook(
    job: JobView,
    step: StepView,
    op: OperationDef,
    meta: OpMeta,
    params: OpParams,
    error: BridgeLkError,
  ): Promise<VerifyResult<unknown>> {
    if (!meta.reader) return { ok: false };
    if (error.code === 'DUPLICATE_ID' && meta.verify === 'client-id') {
      // A partial batch is not "ok" here: the step handles it (re-submits the missing items) once this returns.
      const r = await this.recoverClientId(job, step, op, meta, params);
      return r.kind === 'applied' ? { ok: true, value: r.value } : { ok: false };
    }
    if ((error.code === 'NOT_FOUND' || error.code === 'ALREADY_DELETED') && meta.verify === 'gone') {
      const cur = await this.readCurrent(job, step, op, meta, params, step.clientIds);
      return this.isGone(cur, meta, params) ? { ok: true, value: undefined } : { ok: false };
    }
    if ((error.status === 412 || error.code === 'VERSION_MISMATCH') && meta.verify === 'state') {
      const cur = await this.readCurrent(job, step, op, meta, params, step.clientIds);
      return cur.exists && this.matches(meta, params, cur)
        ? { ok: true, value: cur.entity ?? cur.body }
        : { ok: false };
    }
    return { ok: false };
  }

  /** Decides, from LK's current state, whether a step that may have been sent already applied. */
  private async recover(
    job: JobView,
    step: StepView,
    op: OperationDef,
    meta: OpMeta,
    params: OpParams,
  ): Promise<Recovery> {
    if (step.firstSentAt === null && !step.maybeSent) return { kind: 'not-applied' };
    const withinWindow =
      step.firstSentAt !== null && this.d.now() - step.firstSentAt <= this.d.settings.idempotencyWindowMs;
    const ifMatch = step.ifMatch ?? undefined;
    switch (meta.verify) {
      case 'read':
      case 'idempotent':
        return { kind: 'not-applied', ifMatch: op.versioned ? ifMatch : undefined };
      case 'client-id':
        if (step.clientIds.length > 0) return this.recoverClientId(job, step, op, meta, params);
        return withinWindow
          ? { kind: 'not-applied', ambiguous: true }
          : { kind: 'uncertain', reason: 'no client id and the idempotency window has passed' };
      case 'gone': {
        const cur = await this.readCurrent(job, step, op, meta, params, step.clientIds);
        if (this.isGone(cur, meta, params)) return { kind: 'applied', value: undefined };
        return { kind: 'not-applied', ifMatch: op.versioned ? ifMatch : undefined };
      }
      case 'state': {
        const cur = await this.readCurrent(job, step, op, meta, params, step.clientIds);
        if (cur.exists && this.matches(meta, params, cur))
          return { kind: 'applied', value: cur.entity ?? cur.body };
        if (!op.versioned) return { kind: 'not-applied' };
        if (ifMatch && cur.version === ifMatch) return { kind: 'not-applied', ifMatch };
        if (op.method === 'POST' && withinWindow) return { kind: 'not-applied', ifMatch, ambiguous: true };
        return {
          kind: 'uncertain',
          reason: `the entity changed since version ${ifMatch ?? '(unknown)'} and does not match the intended state`,
        };
      }
      case 'key': {
        if (op.versioned && meta.reader && ifMatch) {
          const cur = await this.readCurrent(job, step, op, meta, params, step.clientIds);
          if (cur.version === ifMatch) return { kind: 'not-applied', ifMatch };
        }
        if (withinWindow) {
          return { kind: 'not-applied', ifMatch: op.versioned ? ifMatch : undefined, ambiguous: true };
        }
        return {
          kind: 'uncertain',
          reason: 'the idempotency window has passed and LK offers no other way to tell whether it applied',
        };
      }
    }
  }

  private async recoverClientId(
    job: JobView,
    step: StepView,
    op: OperationDef,
    meta: OpMeta,
    params: OpParams,
  ): Promise<Recovery> {
    const ids = step.clientIds;
    if (meta.clientId !== 'body.resources[].id') {
      const one = await this.readCurrent(job, step, op, meta, params, [ids[0]!]);
      return one.exists ? { kind: 'applied', value: one.body } : { kind: 'not-applied' };
    }
    // createManyResources is not atomic: check EVERY minted id (at most 100 reads, each through the governor).
    const found: unknown[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const cur = await this.readCurrent(job, step, op, meta, params, [id]);
      if (cur.exists) found.push(cur.body);
      else missing.push(id);
    }
    if (missing.length === 0) return { kind: 'applied', value: { resources: found } };
    if (found.length === 0) return { kind: 'not-applied' };
    return { kind: 'partial', found, missing };
  }

  /**
   * `recover`, except that verification which cannot complete becomes `uncertain`, and a budget wait during it is
   * passed on (the step parks and stays ambiguous, so it is verified again on resume).
   */
  private async safeRecover(
    job: JobView,
    step: StepView,
    op: OperationDef,
    meta: OpMeta,
    params: OpParams,
  ): Promise<Recovery | { readonly kind: 'park'; readonly error: BudgetWaitError }> {
    try {
      return await this.recover(job, step, op, meta, params);
    } catch (e) {
      if (e instanceof BudgetWaitError) return { kind: 'park', error: e };
      const why = e instanceof Error ? e.message : String(e);
      return {
        kind: 'uncertain',
        reason: `the write may have applied and verification could not complete (${why})`,
      };
    }
  }

  /** Turns a recovery result into the step's outcome; null means "not applied: go on and send". */
  private settle(
    job: JobView,
    step: StepView,
    op: OperationDef,
    meta: OpMeta,
    params: OpParams,
    stats: CallStats,
    r: Recovery | { readonly kind: 'park'; readonly error: BudgetWaitError },
    ref: JobRef,
  ): StepOutcome | null {
    switch (r.kind) {
      case 'not-applied':
        return null;
      case 'park':
        return this.fail(job, step, stats, r.error, true);
      case 'applied':
        this.d.journal.setOutcomeForStep(job.id, step.stepNo, 'applied');
        return this.succeed(job, step, stats, r.value, true);
      case 'uncertain':
        this.d.journal.setOutcomeForStep(job.id, step.stepNo, 'unknown');
        return this.fail(job, step, stats, new UncertainOutcomeError(op.operationId, r.reason, ref));
      case 'partial': {
        // Some items were created: this step's journal entry is `applied`; the continuation gets its own entry.
        this.d.journal.setOutcomeForStep(job.id, step.stepNo, 'applied');
        // Re-submit only the missing items, with their same ids, as a new step that runs next.
        const body = (params.body ?? {}) as { resources?: Record<string, unknown>[] };
        const missing = new Set(r.missing);
        const items = (body.resources ?? []).filter((i) => typeof i.id === 'string' && missing.has(i.id));
        const next = this.d.repo.insertStepAfter(job.id, step.stepNo, {
          opId: op.operationId,
          opKind: op.kind,
          params: { ...params, body: { ...body, resources: items } },
          options: step.options,
          clientIds: [...r.missing],
          post: true,
        });
        return this.succeed(
          job,
          step,
          stats,
          { resources: r.found, partial: true, missing: r.missing, continuedInStep: next },
          true,
        );
      }
    }
  }

  private isGone(cur: Current, meta: OpMeta, params: OpParams): boolean {
    if (meta.gone) return cur.exists ? meta.gone(cur.body, params) : true;
    return !cur.exists || isDeleted(cur.entity);
  }

  private matches(meta: OpMeta, params: OpParams, cur: Current): boolean {
    const intent = meta.intent ? meta.intent(params) : params.body;
    const actual = meta.actual ? meta.actual(cur.body, cur.entity) : (cur.entity ?? cur.body);
    return matchesIntent(intent, actual, meta.compare ?? 'patch');
  }

  /** The reader op for a write: the entity's current state (and version). 404 means it does not exist. */
  private async readCurrent(
    job: JobView,
    step: StepView,
    _op: OperationDef,
    meta: OpMeta,
    params: OpParams,
    clientIds: readonly string[],
  ): Promise<Current> {
    const reader: ReaderDef = READERS[meta.reader!];
    const readOp = requireOperation(reader.op);
    const path: Record<string, string> = {};
    for (const m of readOp.pathTemplate.matchAll(/\{(\w+)\}/g)) {
      const name = m[1]!;
      if (name === 'projectId') continue;
      const v = name === reader.idParam && clientIds[0] ? clientIds[0] : params.path?.[name];
      if (v !== undefined) path[name] = v;
    }
    let body: unknown;
    const opts = this.callOptions(job, step, newCallStats(), 'r');
    try {
      // A 404 here is an answer ("not there"), not a failure: it is not recorded in the errors table.
      body = await callOp(
        this.lk(job),
        readOp,
        { path },
        {
          ...opts,
          onError: (err: BridgeLkError) => {
            if (!isNotFound(err)) opts.onError(err);
          },
        },
      );
    } catch (e) {
      if (isNotFound(e)) return { exists: false, body: undefined, entity: undefined, version: undefined };
      throw e;
    }
    let entity: unknown = body;
    if (reader.list) {
      const data = (body as { data?: unknown } | undefined)?.data;
      const want = reader.selectBy ? params.path?.[reader.selectBy] : undefined;
      entity =
        want !== undefined && Array.isArray(data)
          ? (data as { id?: unknown }[]).find((x) => x?.id === want)
          : reader.selectBy
            ? undefined
            : body;
    }
    const version = reader.version?.(body, entity);
    return { exists: entity !== undefined, body, entity, version };
  }

  // ------------------------------------------------------------------------------------------ bookkeeping

  private callOptions(job: JobView, step: StepView, stats: CallStats, suffix = '') {
    return {
      priority: job.priority,
      jobId: job.id,
      idempotencyKey: suffix ? null : step.idempotencyKey,
      requestIdPrefix: `lkb.${job.id}.${step.stepNo}.${step.attempt0}${suffix ? `.${suffix}${this.seq++}` : ''}`,
      stats,
      onError: (err: BridgeLkError) =>
        this.d.recordLkError(err, {
          projectId: job.projectId,
          opId: err.opId ?? step.opId,
          jobId: job.id,
          stepNo: step.stepNo,
          principalId: job.principalId,
          profile: job.profile,
        }),
    };
  }

  private seq = 1;

  private succeed(
    job: JobView,
    step: StepView,
    stats: CallStats,
    value: unknown,
    verified = false,
    store = true,
  ): StepOutcome {
    const requestIds = [...step.requestIds, ...stats.requestIds];
    const { summary, artifactId } = store
      ? this.summarise(job.id, step.stepNo, value, verified)
      : { summary: pageSummary(value), artifactId: null };
    this.d.repo.updateStep(job.id, step.stepNo, {
      status: 'succeeded',
      attempts: step.attempts + stats.attempts,
      requestIds,
      resultSummary: summary,
      resultArtifactId: artifactId,
      error: null,
      maybeSent: false,
      finishedAt: this.d.now(),
    });
    return { kind: 'succeeded', value, requestIds };
  }

  private fail(job: JobView, step: StepView, stats: CallStats, e: unknown, ambiguous = false): StepOutcome {
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const latest = this.d.repo.step(job.id, step.stepNo) ?? step;
    const requestIds = [
      ...latest.requestIds,
      ...stats.requestIds.filter((r) => !latest.requestIds.includes(r)),
    ];
    const attempts = step.attempts + stats.attempts;
    if (e instanceof BudgetWaitError) {
      // Not failed: parked. Keep the key; remember whether the write may have reached LK.
      this.d.repo.updateStep(job.id, step.stepNo, {
        status: 'pending',
        attempts,
        requestIds,
        maybeSent: stats.maybeSent || ambiguous,
      });
      return { kind: 'budget', retryAtMs: e.retryAtMs, error: e };
    }
    const error: JobsError =
      e instanceof JobsError
        ? e
        : e instanceof BridgeLkError
          ? new LkOperationError(e, ref)
          : new JobsError('BRIDGE_ERROR', e instanceof Error ? e.message : String(e), ref, { cause: e });
    const uncertain = error instanceof UncertainOutcomeError;
    this.d.repo.updateStep(job.id, step.stepNo, {
      status: uncertain ? 'uncertain' : 'failed',
      attempts,
      requestIds,
      error: errorToJson(error),
      maybeSent: stats.maybeSent || ambiguous,
      finishedAt: this.d.now(),
    });
    return { kind: 'failed', error, uncertain };
  }

  private summarise(
    jobId: string,
    stepNo: number,
    value: unknown,
    verified: boolean,
  ): { summary: unknown; artifactId: string | null } {
    if (value === undefined) return { summary: verified ? { verified: true } : null, artifactId: null };
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) <= this.d.settings.resultSummaryBytes) {
      return { summary: verified ? { verified: true, value } : value, artifactId: null };
    }
    const artifactId = this.d.repo.createArtifact(jobId, stepNo, 'result', text);
    const v = value as { id?: unknown; version?: unknown; data?: unknown; blocks?: unknown };
    return {
      summary: {
        ...(verified ? { verified: true } : {}),
        truncated: true,
        bytes: Buffer.byteLength(text),
        ...(typeof v.id === 'string' ? { id: v.id } : {}),
        ...(typeof v.version === 'string' ? { version: v.version } : {}),
        ...(Array.isArray(v.data) ? { items: v.data.length } : {}),
        ...(Array.isArray(v.blocks) ? { blocks: v.blocks.length } : {}),
      },
      artifactId,
    };
  }
}

/** A list page's summary (the items themselves go to the job's `items` artefact). */
function pageSummary(value: unknown): unknown {
  const v = (value ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
  return {
    items: Array.isArray(v.data) ? v.data.length : 0,
    hasMore: v.hasMore === true,
    nextCursor: typeof v.nextCursor === 'string' ? v.nextCursor : null,
  };
}

function targetIdOf(op: OperationDef, params: OpParams): string | null {
  const names = [...op.pathTemplate.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1]!)
    .filter((n) => n !== 'projectId');
  const last = names[names.length - 1];
  return last ? (params.path?.[last] ?? null) : null;
}

export { errorToJson };
