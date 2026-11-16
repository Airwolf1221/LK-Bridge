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
  StateConflictError,
  UncertainOutcomeError,
  VersionConflictError,
  errorToJson,
  type JobRef,
} from './errors.js';
import {
  EXPECT_STEP,
  RECORD_STEP,
  LMR_STEP,
  londonDate,
  type LmrParams,
  SIDEBAR_IGNORED_FIELDS,
  VERIFY_STEP,
  isInternalStep,
  type BlockCheck,
  type ChildrenCheck,
  type DocumentChecker,
  type ExpectCheck,
  type MapChecker,
  type ResourceCheck,
  type SubtreeCheck,
  type TargetVerification,
  type VerifyTarget,
} from './internal-steps.js';
import {
  collectionState,
  compareCollection,
  compareRows,
  rowsContentHash,
  compareSidebarStates,
  factsVersionOf,
  normaliseContent,
  rowsState,
  sidebarState,
  stableJson,
  stateHash,
  type RowState,
  type StateDifference,
} from './sidebar-state.js';
import { inRankOrder } from '../lk/row-order.js';
import type { WriteGuard } from './write-guard.js';
import { assertNoUnsupportedLoss, unsupportedGuardSides } from './guards.js';
import type { WriteJournal } from './journal.js';
import { callOp, isNotFound, newCallStats, type CallStats } from './lk-call.js';
import type { LockManager } from './locks.js';
import { READERS, opMeta, type OpMeta, type ReaderDef } from './op-meta.js';
import type { JobsRepo } from './repo.js';
import type { JobView, OpParams, ReadInfo, StepView } from './types.js';
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
  /** v2 C2a: the write guard (protected canonical facts), asked before each write is sent, inside its lock. */
  readonly writeGuard?: () => WriteGuard | undefined;
  /** v2 C2c: the lifecycle record's handler (`bridge.record`), registered by the lifecycle module. */
  readonly recordHandler?: (store: string) => RecordHandler | undefined;
  /** v2 D1: the document checkers of `bridge.expect`, by name. */
  readonly checker?: (name: string) => DocumentChecker | undefined;
  /** v2 D2: the map checkers of `bridge.expect` (`kind: 'map'`) and `bridge.verify` (`kind: 'mapChecked'`), by name. */
  readonly mapChecker?: (name: string) => MapChecker | undefined;
  /** v2 D1.1 (ADR 0039): whether a project uses a write's `ETag` as its new version (`useEtagVersions`, default on). */
  readonly etagVersions?: (projectId: string) => boolean;
  /** v2 D3 (ADR 0041): keeps an asset's bytes before any `deleteAsset` (see `AssetDeleteKeeper`). */
  readonly assetDeleteKeeper?: () => AssetDeleteKeeper | undefined;
  /** v2 E1a (ADR 0042): told about every read a job makes for its own checks (the snapshot service's read tap). */
  readonly onRead?: (info: ReadInfo) => void;
}

/**
 * v2 D3 (ADR 0041, the CR open item): called inside the read that gives a `deleteAsset` its journal pre-image, on EVERY
 * route (the tools, `lk_api_write`, `lk_api_batch`, `lk_op_*`). It downloads and stores the asset's bytes (and, for a
 * folder, lists its children and keeps theirs) and returns what the pre-image records about them. It throws (a
 * `JobsError` with code `ASSET_BYTES_NOT_KEPT`) to refuse the delete: nothing is then sent.
 */
export type AssetDeleteKeeper = (ctx: {
  readonly job: JobView;
  readonly step: StepView;
  readonly lk: LkClient;
  /** The asset as `getAsset` gave it. */
  readonly asset: Record<string, unknown>;
  /** A governed read in the job's name (listAssets for a folder's children). */
  readonly read: (opId: string, params: OpParams) => Promise<unknown>;
}) => Promise<Record<string, unknown>>;

/**
 * v2 C2c (ADR 0035): writes the lifecycle record for a `bridge.record` step (the bridge's own database only) and returns
 * what the step stores as its result. Throwing fails the step (and stops the job before its writes).
 */
export type RecordHandler = (job: JobView, step: StepView, params: OpParams) => unknown;

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
  /** v2 C2a (the generic verify step): each target's own result. */
  readonly targets?: readonly TargetVerification[];
  /** v2 C2a: the job's journal entries (what each write changed), for recovery. */
  readonly journalIds?: readonly number[];
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
  /** v2 E1a: the read made (its operation and path), for the read tap. */
  readonly read?: { readonly op: string; readonly path: Record<string, string> };
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

/** v3 F2 (ADR 0049 decision 9): the per-project lock every bridge-planned asset folder is found or created under. */
export const ASSET_FOLDER_LOCK = 'asset-folders';

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
    opts: { readonly storeResult?: boolean; readonly heldLock?: string | readonly string[] | null } = {},
  ): Promise<StepOutcome> {
    // A project taken out of service (its key failed a check) runs nothing more until it is back: the job is held. A
    // step being recovered waits too: verifying it needs the project's client.
    if (!this.d.lkFor(job.projectId)) {
      return { kind: 'held', reason: 'project_unavailable' };
    }
    const custom = this.d.customSteps?.[step.opId];
    if (custom) return this.runCustom(job, step, custom);
    if (isInternalStep(step.opId)) return this.runInternal(job, step);
    const op = requireOperation(step.opId);
    const params = this.d.repo.stepParams(step);
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const store = opts.storeResult !== false;
    if (op.kind === 'read') return this.runRead(job, step, op, params, store);

    // v3 F2 (ADR 0049 decision 9): a folder the bridge planned is found or created when the job runs, under the
    // project's asset-folder lock (held for this step only), so two jobs placing into one missing chain make one chain.
    const findOrCreate = op.operationId === 'createAssetFolder' && step.options.findOrCreate === true;
    const emptyOnly = op.operationId === 'deleteAsset' && step.options.onlyIfEmpty === true;
    const lockKey =
      findOrCreate || emptyOnly
        ? projectLockKey(job.projectId, ASSET_FOLDER_LOCK)
        : projectLockKey(job.projectId, lockKeyFor(op, params));
    // v2 C2a: the job already holds this lock for its whole run (BatchSubmit.holdLock); it is not taken again. v2 C2c:
    // a job may hold two (the page's and one of its documents').
    const held: readonly string[] =
      opts.heldLock === undefined || opts.heldLock === null
        ? []
        : typeof opts.heldLock === 'string'
          ? [opts.heldLock]
          : opts.heldLock;
    const ownLock = lockKey !== null && !held.includes(lockKey);
    if (ownLock && held.length > 0 && !findOrCreate && !emptyOnly) {
      return this.fail(
        job,
        step,
        newCallStats(),
        new JobsError(
          'BRIDGE_ERROR',
          `${op.operationId} takes lock ${lockKey}, but the job holds ${held.join(' and ')}; nothing was sent`,
          { jobId: job.id, stepNo: step.stepNo },
        ),
      );
    }
    let releaseLock: (() => void) | undefined;
    let releaseSlot: () => void;
    try {
      if (lockKey && ownLock) {
        if (!this.d.locks.isFree(lockKey)) this.d.setJobWaiting(job.id, 'lock', { lockKey });
        releaseLock = await this.d.locks.acquire(
          lockKey,
          { jobId: job.id, stepNo: step.stepNo, principalId: job.principalId },
          signal,
        );
        this.d.setJobWaiting(job.id, null);
      }
      if (findOrCreate && step.status !== 'running' && !step.maybeSent && step.firstSentAt === null) {
        const found = await this.findFolder(job, step, params);
        if (found) {
          releaseLock?.();
          return found;
        }
      }
      if (emptyOnly && step.status !== 'running' && !step.maybeSent && step.firstSentAt === null) {
        const kept = await this.folderNotEmpty(job, step, params);
        if (kept) {
          releaseLock?.();
          return kept;
        }
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
      const out = await this.runWrite(job, step, op, params, ref, store);
      if (findOrCreate && out.kind === 'succeeded') {
        const entry = this.d.journal.entryIdForStep(job.id, step.stepNo);
        if (entry !== undefined && entry !== null)
          this.d.journal.annotate(entry, { folder: 'created folder' });
      }
      return out;
    } finally {
      releaseSlot();
      releaseLock?.();
    }
  }

  /**
   * v3 F2 (ADR 0049 decision 9): a folder delete planned "only if empty": its contents read now, inside the asset-folder
   * lock. Anything in it: the delete is not sent, and the step succeeds with `{ skipped }`; empty (or not readable as a
   * folder): null, and the delete goes ahead as planned (LegendKeeper answers for a folder that is gone).
   */
  private async folderNotEmpty(job: JobView, step: StepView, params: OpParams): Promise<StepOutcome | null> {
    const id = params.path?.assetId;
    if (typeof id !== 'string') return null;
    const stats = newCallStats();
    const r = await this.readOp(job, step, 'listAssets', { query: { limit: 1, folderId: id } }, stats);
    const b = (r.body ?? {}) as { data?: unknown };
    const n = Array.isArray(b.data) ? b.data.length : 0;
    if (!r.exists || n === 0) return null;
    return this.succeed(job, step, stats, {
      skipped: 'the folder is not empty when the job runs: it was not deleted',
      folderId: id,
    });
  }

  /**
   * v3 F2 (ADR 0049 decision 9): the parent's children read fresh, inside the asset-folder lock; a folder whose name is
   * exactly the planned one (byte for byte, as LegendKeeper stores names: sandbox A9) is used instead of creating one.
   * The step then succeeds with that folder (`found: true`; the steps after it bind its id as they would a new one's),
   * and the journal says so (`not_applied`: nothing was sent). Null when there is none, or the parent cannot be listed
   * (the create then answers for itself, as before: a parent deleted since the plan fails it with LegendKeeper's error).
   */
  private async findFolder(job: JobView, step: StepView, params: OpParams): Promise<StepOutcome | null> {
    const body = (params.body ?? {}) as { name?: unknown; folderId?: unknown };
    if (typeof body.name !== 'string') return null;
    const parent = typeof body.folderId === 'string' && body.folderId !== '' ? body.folderId : null;
    const stats = newCallStats();
    let match: Record<string, unknown> | undefined;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 100 && !match; page++) {
        const r = await this.readOp(
          job,
          step,
          'listAssets',
          { query: { limit: 100, ...(parent ? { folderId: parent } : {}), ...(cursor ? { cursor } : {}) } },
          stats,
        );
        if (!r.exists) return null;
        const b = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
        const items = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : [];
        match = items.find(
          (x) =>
            x?.type === 'FOLDER' &&
            x.name === body.name &&
            (x.folderId ?? null) === parent &&
            typeof x.id === 'string',
        );
        if (b.hasMore !== true || typeof b.nextCursor !== 'string') break;
        cursor = b.nextCursor;
      }
    } catch (e) {
      if (e instanceof BudgetWaitError) throw e;
      return null;
    }
    if (!match) return null;
    const journalId = this.d.journal.record({
      projectId: job.projectId,
      jobId: job.id,
      stepNo: step.stepNo,
      opId: step.opId,
      principalId: job.principalId,
      profile: job.profile,
      approvedBy: job.approvedBy,
      risk: 'safe',
      targetKind: 'Assets',
      targetId: String(match.id),
      resourceId: null,
      documentId: null,
      version: null,
      params,
      operation: {
        ...(step.options.journalOperation ?? {}),
        folder: 'found existing folder',
        folderId: String(match.id),
      },
    });
    this.d.journal.setOutcome(journalId, 'not_applied');
    return this.succeed(job, step, stats, {
      id: match.id,
      name: match.name,
      folderId: match.folderId ?? null,
      type: 'FOLDER',
      found: true,
    });
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

  // ------------------------------------------------------------------------------------------ v2 C2a: internal steps

  /**
   * The bridge's own steps (src/jobs/internal-steps.ts). Both only read, through the governor, inside the job's lock
   * when it holds one. `bridge.expect` is held while writes are paused (it is the first step of a write); a difference
   * fails it with `StateConflictError` and the job stops before any write. `bridge.verify` never fails: what it could
   * not read is `not_checked`, a difference is `mismatch` (and an error row), and nothing is retried.
   */
  private async runInternal(job: JobView, step: StepView): Promise<StepOutcome> {
    if (step.opId === EXPECT_STEP && step.status !== 'running') {
      const hold = this.d.writeHold(job.projectId);
      if (hold) return { kind: 'held', reason: hold };
    }
    const stats = newCallStats();
    this.d.repo.updateStep(job.id, step.stepNo, {
      status: 'running',
      startedAt: step.startedAt ?? this.d.now(),
    });
    const params = this.d.repo.stepParams(step);
    try {
      if (step.opId === EXPECT_STEP) {
        return this.succeed(job, step, stats, await this.runExpect(job, step, params, stats));
      }
      if (step.opId === RECORD_STEP) {
        // v2 C2c: the lifecycle record (the bridge's own database only; nothing is read or sent).
        const store = ((params.body ?? {}) as { store?: unknown }).store;
        const name = typeof store === 'string' ? store : 'lifecycle';
        const handler = this.d.recordHandler?.(name);
        if (!handler)
          throw new JobsError('BRIDGE_ERROR', `The ${name} record is not available; nothing was written.`);
        return this.succeed(job, step, stats, await handler(job, step, params));
      }
      if (step.opId === LMR_STEP) {
        // v3 F2 (ADR 0049 decision 2): the Last Major Revision decision (reads only).
        return this.succeed(job, step, stats, await this.runLmr(job, step, params, stats));
      }
      if (step.opId !== VERIFY_STEP) throw new JobsError('BRIDGE_ERROR', `Unknown bridge step ${step.opId}`);
      const verification = await this.runVerify(job, step, params, stats);
      if (verification.status === 'mismatch') this.d.recordVerifyMismatch?.(job, step, verification);
      return this.succeed(job, step, stats, { verification });
    } catch (e) {
      return this.fail(job, step, stats, e);
    }
  }

  /**
   * v3 F2 (ADR 0049 decision 2): `bridge.lmr`. Today on the bridge's clock (Europe/London) is worked out NOW, when the
   * job runs (an approved proposal: the day it is applied). Skipped when none of the edit's writes wrote anything (an
   * unchanged write), when the page has no such row, or when the row already says today. The If-Match is the new
   * version of an earlier row write of the same property in this job (its ETag, when `useEtagVersions` is on), or the
   * version one read of the rows gives, inside the job (and its locks).
   */
  private async runLmr(
    job: JobView,
    step: StepView,
    params: OpParams,
    stats: CallStats,
  ): Promise<Record<string, unknown>> {
    const b = (params.body ?? {}) as unknown as LmrParams;
    const today = londonDate(this.d.now());
    const ref = { jobId: job.id, stepNo: step.stepNo };
    // The edit itself: a write that found nothing to change (an unchanged page) is not an edit.
    const wrote = b.after.some((n) => {
      const s = this.d.repo.step(job.id, n);
      if (s?.status !== 'succeeded') return false;
      const r = (s.resultSummary ?? {}) as { unchanged?: unknown; skipped?: unknown };
      return r.unchanged !== true && r.skipped === undefined;
    });
    if (!wrote) return { skip: 'the edit wrote nothing', date: today };
    let rowId = b.rowId;
    let value = b.value;
    let version: string | undefined;
    if (b.chainFrom !== undefined && rowId !== undefined) {
      const s = this.d.repo.step(job.id, b.chainFrom);
      const r =
        s?.status === 'succeeded'
          ? ((this.d.repo.stepResult(s) ?? {}) as { version?: unknown; etag?: unknown })
          : {};
      version = str(r.version) ?? (this.d.etagVersions?.(job.projectId) === false ? undefined : str(r.etag));
    }
    const chained = version !== undefined;
    let propertyId = b.propertyId;
    if (!chained && propertyId === undefined) {
      // The plan did not know the page's sidebar (the tree had not read it): find the key-value property with the row.
      const r = await this.readOp(job, step, 'listProperties', { path: { resourceId: b.resourceId } }, stats);
      if (!r.exists) return { skip: 'the page is gone', date: today };
      const body = (r.body ?? {}) as { data?: unknown; properties?: unknown };
      const props = (
        Array.isArray(body.data) ? body.data : Array.isArray(body.properties) ? body.properties : []
      ) as Record<string, unknown>[];
      const k = b.key.normalize('NFKC').trim().toLowerCase();
      const holder = props.find(
        (p) =>
          p?.kind === 'keyValue' &&
          Array.isArray(p.rows) &&
          (p.rows as Record<string, unknown>[]).some(
            (x) => typeof x?.key === 'string' && x.key.normalize('NFKC').trim().toLowerCase() === k,
          ),
      );
      if (!holder || typeof holder.id !== 'string')
        return { skip: `the page has no ${b.key} row`, date: today };
      propertyId = holder.id;
    }
    if (!chained) {
      const r = await this.readOp(
        job,
        step,
        'listPropertyRows',
        { path: { resourceId: b.resourceId, propertyId: propertyId! } },
        stats,
      );
      if (!r.exists) return { skip: 'the sidebar property is gone', date: today };
      const body = (r.body ?? {}) as { data?: unknown; version?: unknown };
      const key = b.key.normalize('NFKC').trim().toLowerCase();
      const row = (Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []).find(
        (x) => typeof x?.key === 'string' && x.key.normalize('NFKC').trim().toLowerCase() === key,
      );
      if (!row || typeof row.id !== 'string') return { skip: `the page has no ${b.key} row`, date: today };
      rowId = row.id;
      value = runsText(row.content) ?? (typeof row.text === 'string' ? row.text : '');
      version = str(body.version);
    }
    if ((value ?? '').trim() === today) return { skip: `${b.key} already says ${today}`, date: today };
    if (version === undefined)
      throw new JobsError(
        'BRIDGE_ERROR',
        `No version to set ${b.key} with (If-Match); nothing was sent.`,
        ref,
      );
    return {
      date: today,
      chained,
      versions: { lmr: version },
      lmr: {
        path: { resourceId: b.resourceId, propertyId: propertyId!, rowId: rowId! },
        body: { content: [{ text: today }] },
      },
    };
  }

  /** `bridge.expect`: each property as the plan saw it, or a conflict. Returns the version each read gave. */
  private async runExpect(
    job: JobView,
    step: StepView,
    params: OpParams,
    stats: CallStats,
  ): Promise<{
    checked: string[];
    versions: Record<string, string | null>;
    versionsByPage: Record<string, Record<string, string | null>>;
    ids?: Record<string, string>;
    idsByPage?: Record<string, Record<string, string>>;
    bodies?: Record<string, unknown>;
    observed?: Record<string, unknown>;
  }> {
    const checks = ((params.body ?? {}) as { checks?: ExpectCheck[] }).checks ?? [];
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const versions: Record<string, string | null> = {};
    const ids: Record<string, string> = {};
    // C2d (ADR 0037): property, row and item ids are unique only within a page (copies of one template share them),
    // so the versions a check read and the ids a copy check mapped are also kept per page; `bindIfMatch` and
    // `bindIds` take them from the page the bound write names (the flat maps stay for jobs stored before).
    const versionsByPage: Record<string, Record<string, string | null>> = {};
    const idsByPage: Record<string, Record<string, string>> = {};
    const keep = (resourceId: string, label: string, v: string | null) => {
      versions[label] = v;
      (versionsByPage[resourceId] ??= {})[label] = v;
    };
    const bodies: Record<string, unknown> = {};
    const observed: Record<string, unknown> = {};
    for (const c of checks) {
      // v2 D1: a whole document judged by a registered checker (the chronology's tables), one event, one lane.
      if (c.kind === 'document') {
        const checker = this.d.checker?.(c.checker);
        if (!checker)
          throw new JobsError(
            'BRIDGE_ERROR',
            `The check ${c.checker} is not available; nothing was written.`,
            ref,
          );
        const r = await this.readOp(
          job,
          step,
          'getDocumentBlocks',
          { path: { resourceId: c.resourceId, documentId: c.documentId } },
          stats,
        );
        if (!r.exists) {
          throw new StateConflictError(
            EXPECT_STEP,
            c.label,
            [{ path: c.label, expected: 'present', actual: '(gone)' }],
            null,
            null,
            ref,
          );
        }
        const b = (r.body ?? {}) as { version?: unknown; blocks?: unknown };
        const version = str(b.version) ?? null;
        const out = runChecker(checker, {
          projectId: job.projectId,
          jobId: job.id,
          stepNo: step.stepNo,
          label: c.label,
          input: c.input,
          document: { version, blocks: Array.isArray(b.blocks) ? (b.blocks as unknown[]) : [] },
        });
        if (out.differences.length > 0)
          throw new StateConflictError(EXPECT_STEP, c.label, [...out.differences], null, version, ref);
        Object.assign(bodies, out.bodies ?? {});
        if (out.observed !== undefined) observed[c.label] = out.observed;
        keep(c.resourceId, c.label, version);
        continue;
      }
      // v2 D2: a map's settings and features judged by a registered map checker.
      if (c.kind === 'map') {
        const checker = this.d.mapChecker?.(c.checker);
        if (!checker)
          throw new JobsError(
            'BRIDGE_ERROR',
            `The check ${c.checker} is not available; nothing was written.`,
            ref,
          );
        const m = await this.readMap(job, step, c.resourceId, c.documentId, true, stats);
        if (!m.exists) {
          throw new StateConflictError(
            EXPECT_STEP,
            c.label,
            [{ path: c.label, expected: 'present', actual: '(gone)' }],
            null,
            null,
            ref,
          );
        }
        const out = runMapChecker(checker, {
          projectId: job.projectId,
          jobId: job.id,
          stepNo: step.stepNo,
          label: c.label,
          input: c.input,
          document: m.document,
          features: m.features,
        });
        if (out.differences.length > 0)
          throw new StateConflictError(EXPECT_STEP, c.label, [...out.differences], null, null, ref);
        Object.assign(bodies, out.bodies ?? {});
        if (out.observed !== undefined) observed[c.label] = out.observed;
        keep(c.resourceId, c.label, null);
        continue;
      }
      if (c.kind === 'event' || c.kind === 'lane') {
        const diffs = await this.timelineDiffs(job, step, c, stats);
        if (diffs.length > 0) throw new StateConflictError(EXPECT_STEP, c.label, diffs, null, null, ref);
        keep(c.resourceId, c.label, null);
        continue;
      }
      // v2 C2b: a page this job created from a template (its ids mapped for `bindIds`), or the whole sidebar.
      if (c.kind === 'copy' || c.kind === 'sidebar') {
        const r = await this.readOp(
          job,
          step,
          'listProperties',
          { path: { resourceId: c.resourceId } },
          stats,
        );
        if (!r.exists) {
          throw new StateConflictError(
            EXPECT_STEP,
            c.label,
            [{ path: c.label, expected: 'present', actual: '(gone)' }],
            c.kind === 'sidebar' ? c.factsVersion : null,
            null,
            ref,
          );
        }
        if (c.kind === 'copy') {
          const m = matchCopy(c.label, c.properties, r.body);
          if (m.differences.length > 0) {
            throw new StateConflictError(EXPECT_STEP, c.label, m.differences, null, null, ref);
          }
          Object.assign(ids, m.ids);
          Object.assign((idsByPage[c.resourceId] ??= {}), m.ids);
        } else {
          const now = sidebarState(r.body);
          const diffs = compareSidebarStates(c.properties, now);
          const version = factsVersionOf(c.resourceId, now);
          if (diffs.length === 0 && version !== c.factsVersion) {
            diffs.push({ path: `${c.label} factsVersion`, expected: c.factsVersion, actual: version });
          }
          if (diffs.length > 0) {
            throw new StateConflictError(EXPECT_STEP, c.label, diffs, c.factsVersion, version, ref);
          }
        }
        keep(c.resourceId, c.label, null);
        continue;
      }
      // v2 C2c: a page's own fields, the pages under it, or one block of a document, as the plan saw them.
      if (c.kind === 'resource' || c.kind === 'children' || c.kind === 'subtree' || c.kind === 'block') {
        const diffs = await this.expectStructure(job, step, c, stats);
        if (diffs.length > 0) throw new StateConflictError(EXPECT_STEP, c.label, diffs, null, null, ref);
        keep(c.resourceId, c.label, null);
        continue;
      }
      const path = { resourceId: c.resourceId, propertyId: c.propertyId };
      const r = await this.readOp(
        job,
        step,
        c.kind === 'propertyRows' ? 'listPropertyRows' : 'getProperty',
        { path },
        stats,
      );
      if (!r.exists) {
        throw new StateConflictError(
          EXPECT_STEP,
          c.label,
          [{ path: c.label, expected: 'present', actual: '(gone)' }],
          c.version ?? null,
          null,
          ref,
        );
      }
      const body = (r.body ?? {}) as { data?: unknown; version?: unknown };
      const version = str(body.version) ?? null;
      // listPropertyRows gives rows by rank, the plan's listProperties in stored order: compareRows puts both in rank
      // order and matches rows by id (sidebar-state.ts), never by position.
      const diffs: StateDifference[] =
        c.kind === 'propertyRows'
          ? compareRows(c.label, c.rows ?? [], rowsState(body.data))
          : compareCollection(c.label, c.collection ?? { items: [], filter: null }, collectionState(r.body));
      if (c.version !== undefined && version !== null && c.version !== version) {
        diffs.push({ path: `${c.label} version`, expected: c.version, actual: version });
      }
      if (diffs.length > 0) {
        throw new StateConflictError(EXPECT_STEP, c.label, diffs, c.version ?? null, version, ref);
      }
      keep(c.resourceId, c.label, version);
    }
    return {
      checked: checks.map((c) => c.label),
      versions,
      versionsByPage,
      ...(Object.keys(ids).length > 0 ? { ids, idsByPage } : {}),
      ...(Object.keys(bodies).length > 0 ? { bodies } : {}),
      ...(Object.keys(observed).length > 0 ? { observed } : {}),
    };
  }

  /**
   * v2 D2: a map's settings (`getDocument`, for its type and `mapImage`; only when asked) and every feature
   * (`listFeatures`, not paged). A deleted or missing document is `exists: false`.
   */
  private async readMap(
    job: JobView,
    step: StepView,
    resourceId: string,
    documentId: string,
    withDocument: boolean,
    stats: CallStats,
  ): Promise<{
    exists: boolean;
    document: Record<string, unknown> | null;
    features: Record<string, unknown>[];
  }> {
    let document: Record<string, unknown> | null = null;
    if (withDocument) {
      const d = await this.readOp(job, step, 'getDocument', { path: { resourceId, documentId } }, stats);
      if (!d.exists) return { exists: false, document: null, features: [] };
      document = (d.body ?? {}) as Record<string, unknown>;
      if (typeof document.deletedAt === 'string') return { exists: false, document: null, features: [] };
    }
    const f = await this.readOp(job, step, 'listFeatures', { path: { resourceId, documentId } }, stats);
    if (!f.exists) return { exists: false, document: null, features: [] };
    const data = (f.body as { data?: unknown } | undefined)?.data;
    return {
      exists: true,
      document,
      features: Array.isArray(data) ? (data as Record<string, unknown>[]) : [],
    };
  }

  /**
   * v2 D1: an event (present with these fields, or absent) or a lane (present, with this name) as the plan expects.
   * One read each (getEvent, getLane); a 404 is an answer.
   */
  private async timelineDiffs(
    job: JobView,
    step: StepView,
    c:
      | {
          label: string;
          kind: 'event';
          resourceId: string;
          documentId: string;
          eventId: string;
          present: boolean;
          fields?: Readonly<Record<string, unknown>>;
        }
      | {
          label: string;
          kind: 'lane';
          resourceId: string;
          documentId: string;
          laneId: string;
          name?: string;
        },
    stats: CallStats,
  ): Promise<StateDifference[]> {
    const path = { resourceId: c.resourceId, documentId: c.documentId };
    if (c.kind === 'lane') {
      const r = await this.readOp(job, step, 'getLane', { path: { ...path, laneId: c.laneId } }, stats);
      if (!r.exists) return [{ path: `${c.label}`, expected: 'present', actual: '(gone)' }];
      const name = (r.body as { name?: unknown } | undefined)?.name;
      return c.name !== undefined && name !== c.name
        ? [{ path: `${c.label} name`, expected: c.name, actual: name ?? null }]
        : [];
    }
    const r = await this.readOp(job, step, 'getEvent', { path: { ...path, eventId: c.eventId } }, stats);
    if (!c.present) return r.exists ? [{ path: c.label, expected: 'absent', actual: 'present' }] : [];
    if (!r.exists) return [{ path: c.label, expected: 'present', actual: '(gone)' }];
    const ev = (r.body ?? {}) as Record<string, unknown>;
    const diffs: StateDifference[] = [];
    for (const [k, v] of Object.entries(c.fields ?? {})) {
      if (stableJson(ev[k] ?? null) !== stableJson(v ?? null))
        diffs.push({ path: `${c.label} ${k}`, expected: v ?? null, actual: ev[k] ?? null });
    }
    return diffs;
  }

  /** v2 C2c: the differences between a page's fields, children or one block and what the plan saw. */
  private async expectStructure(
    job: JobView,
    step: StepView,
    c: ResourceCheck | ChildrenCheck | SubtreeCheck | BlockCheck,
    stats: CallStats,
  ): Promise<StateDifference[]> {
    const diffs: StateDifference[] = [];
    if (c.kind === 'resource') {
      const r = await this.readOp(job, step, 'getResource', { path: { resourceId: c.resourceId } }, stats);
      if (!r.exists) return [{ path: c.label, expected: 'present', actual: '(gone)' }];
      const b = (r.body ?? {}) as { name?: unknown; parentId?: unknown; tags?: unknown };
      if (c.name !== undefined && b.name !== c.name)
        diffs.push({ path: `${c.label} name`, expected: c.name, actual: b.name ?? null });
      if (c.parentId !== undefined && (b.parentId ?? null) !== c.parentId)
        diffs.push({ path: `${c.label} parent`, expected: c.parentId, actual: b.parentId ?? null });
      if (c.tags !== undefined) {
        const now = Array.isArray(b.tags) ? (b.tags as string[]) : [];
        if (JSON.stringify(now) !== JSON.stringify(c.tags))
          diffs.push({ path: `${c.label} tags`, expected: c.tags, actual: now });
      }
      return diffs;
    }
    if (c.kind === 'subtree') {
      // C2d: every page under the set's root, level by level, with its parent, name and tags as LegendKeeper holds them.
      const seen = new Map<string, { parentId: string; name: unknown; tags: unknown }>();
      let level = [c.resourceId];
      for (let depth = 0; depth < 64 && level.length > 0 && seen.size <= c.pages.length + 100; depth++) {
        const next: string[] = [];
        for (const parentId of level) {
          let cursor: string | undefined;
          for (let page = 0; page < 50; page++) {
            const r = await this.readOp(
              job,
              step,
              'listResources',
              { query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) } },
              stats,
            );
            const body = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
            for (const x of Array.isArray(body.data)
              ? (body.data as { id?: unknown; name?: unknown; tags?: unknown }[])
              : []) {
              if (typeof x.id !== 'string' || x.id === c.resourceId || seen.has(x.id)) continue;
              seen.set(x.id, { parentId, name: x.name, tags: x.tags });
              next.push(x.id);
            }
            if (body.hasMore !== true || typeof body.nextCursor !== 'string') break;
            cursor = body.nextCursor;
          }
        }
        level = next;
      }
      const want = new Map(c.pages.map((p) => [p.id, p]));
      for (const [id, now] of seen) {
        const was = want.get(id);
        if (!was) {
          diffs.push({
            path: `${c.label}: page ${typeof now.name === 'string' ? now.name : id}`,
            expected: '(not in the set as approved)',
            actual: `added under ${now.parentId}`,
          });
          continue;
        }
        if ((was.parentId ?? null) !== now.parentId)
          diffs.push({
            path: `${c.label}: ${was.name ?? id} parent`,
            expected: was.parentId,
            actual: now.parentId,
          });
        if (was.name !== undefined && now.name !== was.name)
          diffs.push({ path: `${c.label}: ${was.name} name`, expected: was.name, actual: now.name ?? null });
        if (was.tags !== undefined && JSON.stringify(now.tags ?? []) !== JSON.stringify(was.tags))
          diffs.push({
            path: `${c.label}: ${was.name ?? id} tags`,
            expected: was.tags,
            actual: now.tags ?? null,
          });
      }
      for (const [id, was] of want)
        if (!seen.has(id))
          diffs.push({ path: `${c.label}: page ${was.name ?? id}`, expected: id, actual: '(gone)' });
      return diffs;
    }
    if (c.kind === 'children') {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const r = await this.readOp(
          job,
          step,
          'listResources',
          { query: { parentId: c.resourceId, limit: 100, ...(cursor ? { cursor } : {}) } },
          stats,
        );
        const body = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
        for (const x of Array.isArray(body.data) ? (body.data as { id?: unknown }[]) : [])
          if (typeof x.id === 'string') ids.push(x.id);
        if (body.hasMore !== true || typeof body.nextCursor !== 'string') break;
        cursor = body.nextCursor;
      }
      const want = [...c.ids].sort();
      const have = [...ids].sort();
      if (JSON.stringify(want) !== JSON.stringify(have))
        diffs.push({ path: `${c.label} pages under it`, expected: want, actual: have });
      return diffs;
    }
    const r = await this.readOp(
      job,
      step,
      'getDocumentBlocks',
      { path: { resourceId: c.resourceId, documentId: c.documentId } },
      stats,
    );
    if (!r.exists) return [{ path: c.label, expected: 'present', actual: '(gone)' }];
    const blocks = ((r.body as { blocks?: unknown } | undefined)?.blocks ?? []) as { id?: unknown }[];
    if (c.empty === true) {
      if (blocks.length > 0)
        diffs.push({ path: `${c.label} blocks`, expected: 'none', actual: `${blocks.length} block(s)` });
      return diffs;
    }
    const at = blocks.findIndex((b) => b.id === c.blockId);
    if (c.absent === true) {
      if (at >= 0)
        diffs.push({ path: `${c.label} block ${c.blockId}`, expected: 'absent', actual: 'present' });
      return diffs;
    }
    if (at < 0) return [{ path: `${c.label} block ${c.blockId}`, expected: 'present', actual: '(gone)' }];
    if (c.first === true && at !== 0)
      diffs.push({ path: `${c.label} first block`, expected: c.blockId, actual: blocks[0]?.id ?? null });
    if (c.content !== undefined) {
      const cmp = compareStoredBlocks([c.content], [blocks[at]], 5);
      for (const d of cmp.differences)
        diffs.push({
          path: `${c.label} block ${c.blockId}${d.path}`,
          expected: d.expected,
          actual: d.actual,
        });
    }
    return diffs;
  }

  /** `bridge.verify`: each target read back and compared with the plan (see internal-steps.ts). Never throws. */
  private async runVerify(
    job: JobView,
    step: StepView,
    params: OpParams,
    stats: CallStats,
  ): Promise<WriteVerification> {
    const targets = ((params.body ?? {}) as { targets?: VerifyTarget[] }).targets ?? [];
    const results: TargetVerification[] = [];
    const all: StateDifference[] = [];
    let count = 0;
    const resources = new Map<string, { exists: boolean; body: unknown }>();
    const siblings = new Map<string, SiblingItem[] | null>();
    const resource = async (id: string) => {
      let r = resources.get(id);
      if (!r) {
        r = await this.readOp(job, step, 'getResource', { path: { resourceId: id } }, stats);
        resources.set(id, r);
      }
      return r;
    };
    for (const t of targets) {
      try {
        const diffs: StateDifference[] = [];
        let n = 0;
        let factsVersion: string | undefined;
        if (t.kind === 'blocks') {
          const r = await this.readOp(
            job,
            step,
            'getDocumentBlocks',
            { path: { resourceId: t.resourceId, documentId: t.documentId } },
            stats,
          );
          if (!r.exists) diffs.push({ path: `${t.label}`, expected: 'present', actual: '(gone)' });
          else {
            const cmp = compareStoredBlocks(
              t.blocks,
              (r.body as { blocks?: unknown } | undefined)?.blocks,
              20,
            );
            for (const d of cmp.differences)
              diffs.push({ path: `${t.label} blocks${d.path}`, expected: d.expected, actual: d.actual });
            n = cmp.count;
          }
        } else if (t.kind === 'block') {
          // v2 C2c: one block, present (with its content, first when asked) or absent: the lifecycle note.
          diffs.push(
            ...(await this.expectStructure(
              job,
              step,
              {
                label: t.label,
                kind: 'block',
                resourceId: t.resourceId,
                documentId: t.documentId,
                blockId: t.blockId,
                ...(t.present ? {} : { absent: true }),
                ...(t.present && t.first ? { first: true } : {}),
                ...(t.present && t.content ? { content: t.content } : {}),
              },
              stats,
            )),
          );
          n = diffs.length;
        } else if (t.kind === 'asset') {
          // v2 D3 (ADR 0041): an asset read back with getAsset: its folder (or the folder an earlier step of the job
          // created), hidden flag and name.
          let assetId = t.assetId;
          if (t.assetFrom) {
            const src = this.d.repo.step(job.id, t.assetFrom.step);
            const made = src ? (this.d.repo.stepResult(src) as { id?: unknown } | null) : null;
            assetId = typeof made?.id === 'string' ? made.id : undefined;
          }
          const r = assetId
            ? await this.readOp(job, step, 'getAsset', { path: { assetId } }, stats)
            : { exists: false, body: undefined };
          if (!r.exists) diffs.push({ path: t.label, expected: 'present', actual: '(gone)' });
          else {
            const a = (r.body ?? {}) as Record<string, unknown>;
            const want: Record<string, unknown> = { ...t.fields };
            if (t.folderFrom) {
              const src = this.d.repo.step(job.id, t.folderFrom.step);
              const made = src ? (this.d.repo.stepResult(src) as { id?: unknown } | null) : null;
              want.folderId = typeof made?.id === 'string' ? made.id : '(the folder the job created)';
            }
            for (const [k, v] of Object.entries(want)) {
              const actual = k === 'folderId' ? (a.folderId ?? null) : a[k];
              if (JSON.stringify(actual ?? null) !== JSON.stringify(v ?? null))
                diffs.push({ path: `${t.label} ${k}`, expected: v, actual: actual ?? null });
            }
          }
          n = diffs.length;
        } else if (t.kind === 'checked') {
          // v2 D1: a document read back and judged by a registered checker.
          const checker = this.d.checker?.(t.checker);
          if (!checker) throw new Error(`the check ${t.checker} is not available`);
          const r = await this.readOp(
            job,
            step,
            'getDocumentBlocks',
            { path: { resourceId: t.resourceId, documentId: t.documentId } },
            stats,
          );
          if (!r.exists) diffs.push({ path: t.label, expected: 'present', actual: '(gone)' });
          else {
            const b = (r.body ?? {}) as { version?: unknown; blocks?: unknown };
            let input = t.input;
            if (t.inputFrom && t.inputFrom.step < step.stepNo) {
              const src = this.d.repo.step(job.id, t.inputFrom.step);
              const res =
                src?.status === 'succeeded'
                  ? (this.d.repo.stepResult(src) as { bodies?: Record<string, unknown> } | null)
                  : null;
              input = res?.bodies?.[t.inputFrom.key] ?? null;
            }
            const out = runChecker(checker, {
              projectId: job.projectId,
              jobId: job.id,
              stepNo: step.stepNo,
              label: t.label,
              input,
              document: {
                version: str(b.version) ?? null,
                blocks: Array.isArray(b.blocks) ? (b.blocks as unknown[]) : [],
              },
            });
            diffs.push(...out.differences);
          }
          n = diffs.length;
        } else if (t.kind === 'mapChecked') {
          // v2 D2: a map's features read back and judged by a registered map checker.
          const checker = this.d.mapChecker?.(t.checker);
          if (!checker) throw new Error(`the check ${t.checker} is not available`);
          const m = await this.readMap(job, step, t.resourceId, t.documentId, t.withDocument === true, stats);
          if (!m.exists) diffs.push({ path: t.label, expected: 'present', actual: '(gone)' });
          else {
            let input = t.input;
            if (t.inputFrom && t.inputFrom.step < step.stepNo) {
              const src = this.d.repo.step(job.id, t.inputFrom.step);
              const res =
                src?.status === 'succeeded'
                  ? (this.d.repo.stepResult(src) as { bodies?: Record<string, unknown> } | null)
                  : null;
              input = res?.bodies?.[t.inputFrom.key] ?? null;
            }
            const out = runMapChecker(checker, {
              projectId: job.projectId,
              jobId: job.id,
              stepNo: step.stepNo,
              label: t.label,
              input,
              document: m.document,
              features: m.features,
            });
            diffs.push(...out.differences);
          }
          n = diffs.length;
        } else if (t.kind === 'lane') {
          // v2 D1: a lane, present with its name.
          diffs.push(
            ...(await this.timelineDiffs(
              job,
              step,
              {
                label: t.label,
                kind: 'lane',
                resourceId: t.resourceId,
                documentId: t.documentId,
                laneId: t.laneId,
                ...(t.name !== undefined ? { name: t.name } : {}),
              },
              stats,
            )),
          );
          n = diffs.length;
        } else if (t.kind === 'event') {
          // v2 D1: a timeline event, present with these fields, or gone.
          diffs.push(
            ...(await this.timelineDiffs(
              job,
              step,
              {
                label: t.label,
                kind: 'event',
                resourceId: t.resourceId,
                documentId: t.documentId,
                eventId: t.eventId,
                present: t.present,
                ...(t.fields ? { fields: t.fields } : {}),
              },
              stats,
            )),
          );
          n = diffs.length;
        } else if (t.kind === 'document') {
          const r = await this.readOp(
            job,
            step,
            'listDocuments',
            { path: { resourceId: t.resourceId } },
            stats,
          );
          const docs = (
            Array.isArray((r.body as { data?: unknown } | undefined)?.data)
              ? ((r.body as { data: unknown[] }).data as Record<string, unknown>[])
              : []
          ).filter((d) => d && typeof d === 'object' && !d.deletedAt);
          const hits = t.documentId
            ? docs.filter((d) => d.id === t.documentId)
            : docs.filter((d) => d.name === t.match?.name && d.type === t.match?.type);
          if (t.gone) {
            if (r.exists && hits.length > 0)
              diffs.push({ path: t.label, expected: '(deleted)', actual: 'still there' });
          } else if (!r.exists || hits.length === 0) {
            diffs.push({ path: t.label, expected: 'present', actual: '(not found)' });
          } else if (hits.length > 1) {
            diffs.push({ path: t.label, expected: 'one document', actual: `${hits.length} documents` });
          } else {
            for (const [k, v] of Object.entries(t.fields ?? {})) {
              if (stableJson(hits[0]![k] ?? null) !== stableJson(v ?? null))
                diffs.push({ path: `${t.label} ${k}`, expected: v ?? null, actual: hits[0]![k] ?? null });
            }
          }
          n = diffs.length;
        } else if (
          t.kind === 'resource' &&
          t.placement &&
          Object.keys(t.fields).every((k) => LISTING_FIELDS.has(k))
        ) {
          // v2 C2b: a page with a place to check, and only fields a listing shows: checked from its parent's listing
          // (one read per 100 siblings, shared by every page under that parent), not one getResource per page.
          const list = await this.siblingList(job, step, t.placement.parentId, siblings, stats);
          const item = list?.find((x) => x.id === t.resourceId);
          if (list === null) {
            diffs.push({
              path: `${t.label} place`,
              expected: 'checked',
              actual: '(too many siblings to list)',
            });
          } else if (!item) {
            // Not among the parent's children: gone, or somewhere else.
            const r = await resource(t.resourceId);
            const res = (r.body ?? {}) as Record<string, unknown>;
            diffs.push(
              r.exists
                ? {
                    path: `${t.label} parentId`,
                    expected: t.placement.parentId,
                    actual: res.parentId ?? null,
                  }
                : { path: t.label, expected: 'present', actual: '(gone)' },
            );
          } else {
            compareFields(t.label, t.fields, item.raw, diffs);
            placementDiffs(t, list, diffs);
          }
          n = diffs.length;
        } else {
          const r = await resource(t.resourceId);
          const res = (r.body ?? {}) as Record<string, unknown>;
          if (t.kind === 'gone') {
            if (r.exists && typeof res.deletedAt !== 'string')
              diffs.push({ path: t.label, expected: '(deleted)', actual: 'still there' });
          } else if (!r.exists) diffs.push({ path: t.label, expected: 'present', actual: '(gone)' });
          else if (t.kind === 'facts') {
            compareFacts(t, res, diffs);
            factsVersion = factsVersionOf(t.resourceId, sidebarState(res));
          } else if (t.kind === 'sidebar') {
            factsVersion = factsVersionOf(t.resourceId, sidebarState(res));
            const props = Array.isArray(res.properties) ? (res.properties as Record<string, unknown>[]) : [];
            for (const p of t.properties) {
              const actual = props.find((x) => x && x.id === p.id);
              const label = `${t.label} ${p.title}`;
              if (!actual) {
                diffs.push({ path: label, expected: 'present', actual: '(gone)' });
                continue;
              }
              // getResource gives rows in stored order: compared in rank order, by id (sidebar-state.ts).
              if (p.rows) compareRows(label, p.rows, rowsState(actual.rows), diffs);
              if (p.collection) compareCollection(label, p.collection, collectionState(actual), diffs);
            }
          } else {
            compareFields(t.label, t.fields, res, diffs);
            if (t.placement) {
              const list = await this.siblingList(job, step, t.placement.parentId, siblings, stats);
              if (list === null)
                diffs.push({
                  path: `${t.label} place`,
                  expected: 'checked',
                  actual: '(too many siblings to list)',
                });
              else placementDiffs(t, list, diffs);
            }
          }
          n = diffs.length;
        }
        count += Math.max(n, diffs.length);
        for (const d of diffs) if (all.length < 20) all.push(d);
        results.push({
          label: t.label,
          kind: t.kind,
          status: diffs.length > 0 ? 'mismatch' : 'verified',
          ...(factsVersion ? { factsVersion } : {}),
          ...(diffs.length > 0
            ? { differences: diffs.slice(0, 10), differenceCount: Math.max(n, diffs.length) }
            : {}),
        });
      } catch (e) {
        results.push({
          label: t.label,
          kind: t.kind,
          status: 'not_checked',
          reason: `it could not be read back: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    const journalIds = this.d.repo
      .steps(job.id)
      .filter((s) => s.stepNo < step.stepNo && s.opKind !== 'read' && !isInternalStep(s.opId))
      .map((s) => this.d.journal.entryIdForStep(job.id, s.stepNo))
      .filter((x): x is number => typeof x === 'number');
    const status = results.some((r) => r.status === 'mismatch')
      ? 'mismatch'
      : results.some((r) => r.status === 'not_checked')
        ? 'not_checked'
        : 'verified';
    const notChecked = results.filter((r) => r.status === 'not_checked');
    return {
      status,
      ...(status === 'mismatch' ? { differences: all, differenceCount: count } : {}),
      ...(status === 'not_checked' && notChecked[0]?.reason
        ? { reason: `${notChecked[0].label}: ${notChecked[0].reason}` }
        : {}),
      targets: results,
      ...(journalIds.length > 0 ? { journalId: journalIds[journalIds.length - 1], journalIds } : {}),
      ignored: targets.some((t) => t.kind === 'blocks')
        ? [...VERIFY_IGNORED_FIELDS, ...SIDEBAR_IGNORED_FIELDS]
        : SIDEBAR_IGNORED_FIELDS,
    };
  }

  /**
   * v2 C2b: a parent's children, listed (100 a page, at most 20 pages) and put in rank order, once per parent per verify
   * step. Null when there are too many to list.
   */
  private async siblingList(
    job: JobView,
    step: StepView,
    parentId: string,
    siblings: Map<string, SiblingItem[] | null>,
    stats: CallStats,
  ): Promise<SiblingItem[] | null> {
    const had = siblings.get(parentId);
    if (had !== undefined) return had;
    const all: SiblingItem[] = [];
    let cursor: string | undefined;
    let list: SiblingItem[] | null = [];
    for (let page = 0; page < 20; page++) {
      const r = await this.readOp(
        job,
        step,
        'listResources',
        { query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) } },
        stats,
      );
      const body = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      for (const x of Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []) {
        if (x && typeof x.id === 'string')
          all.push({ id: x.id, rank: typeof x.rank === 'string' ? x.rank : '', raw: x });
      }
      if (body.hasMore !== true || typeof body.nextCursor !== 'string') break;
      cursor = body.nextCursor;
      if (page === 19) list = null;
    }
    if (list !== null) list = inRankOrder(all);
    siblings.set(parentId, list);
    return list;
  }

  /** One governed read for the job's own work (a 404 is an answer, not an error row). */
  private async readOp(
    job: JobView,
    step: StepView,
    opId: string,
    params: OpParams,
    stats?: CallStats,
  ): Promise<{ exists: boolean; body: unknown }> {
    const readOp = requireOperation(opId);
    const opts = this.callOptions(job, step, stats ?? newCallStats(), 'r');
    try {
      const body = await callOp(this.lk(job), readOp, params, {
        ...opts,
        onError: (err: BridgeLkError) => {
          if (!isNotFound(err)) opts.onError(err);
        },
      });
      this.tapRead(job, opId, params, body);
      return { exists: true, body };
    } catch (e) {
      if (isNotFound(e)) {
        this.tapRead(job, opId, params, undefined);
        return { exists: false, body: undefined };
      }
      throw e;
    }
  }

  /**
   * v2 E1a: hands a read to the read tap (never fails the step). `afterOwnWriteOf`: the step whose own write this read
   * shows (the in-step verify), so the tap counts it as made after that write.
   */
  private tapRead(
    job: JobView,
    opId: string,
    params: OpParams,
    value: unknown,
    afterOwnWriteOf?: number,
  ): void {
    try {
      this.d.onRead?.({
        projectId: job.projectId,
        jobId: job.id,
        opId,
        params,
        value,
        ...(afterOwnWriteOf !== undefined ? { afterOwnWriteOf } : {}),
      });
    } catch {
      /* a listener can never break a job */
    }
  }

  /** The write guard's extra read inside the lock (undefined when the entity is not there). */
  private async guardRead(job: JobView, step: StepView, opId: string, params: OpParams): Promise<unknown> {
    const r = await this.readOp(job, step, opId, params);
    return r.exists ? r.body : undefined;
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
          (step.options.expectCurrent !== undefined && !callerVersion) ||
          // v2 E4: a step whose pre-image the tool supplied needs no read for it.
          (meta.journal === 'pre-image' && !journalled && step.options.journalPreImage === undefined));

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

      if (meta.guard && current?.exists) {
        const sides = unsupportedGuardSides(meta.guard, op.operationId, params, current);
        if (sides) assertNoUnsupportedLoss(op.operationId, sides.existing, sides.incoming, step.options, ref);
      }

      // v2 C2a: the bridge's own compare-and-swap for a write LegendKeeper does not version (a link collection's
      // updateProperty): the read just made inside the lock must show the state the plan was built on.
      const expect = step.options.expectCurrent;
      if (expect && !resend && needRead) {
        if (!current || (expect.state === 'collection' && !current.exists)) {
          throw new StateConflictError(
            op.operationId,
            expect.label ?? op.operationId,
            [{ path: expect.label ?? 'target', expected: 'present', actual: 'gone' }],
            null,
            null,
            ref,
          );
        }
        const ent = (current.entity ?? current.body) as { name?: unknown; tags?: unknown } | undefined;
        const now =
          expect.state === 'resource'
            ? { name: ent?.name ?? null, tags: Array.isArray(ent?.tags) ? ent.tags : [] }
            : expect.state === 'rows'
              ? rowsState(
                  (current.body as { data?: unknown } | undefined)?.data ??
                    (current.entity as { rows?: unknown } | undefined)?.rows,
                )
              : collectionState(current.entity ?? current.body);
        // Rows in rank order on both sides (rowsState and rowsContentHash sort them), whichever endpoint gave them.
        const hash = expect.state === 'rows' ? rowsContentHash(now as RowState[]) : stateHash(now);
        if (hash !== expect.hash) {
          throw new StateConflictError(
            op.operationId,
            expect.label ?? op.operationId,
            [{ path: expect.label ?? 'state', expected: `state ${expect.hash.slice(0, 12)}…`, actual: now }],
            null,
            current.version ?? null,
            ref,
          );
        }
      }

      // v2 C2a (ADR 0032): the write guard, inside the lock, on what is there now (protected canonical facts).
      const guard = this.d.writeGuard?.();
      if (guard?.inLock && !resend) {
        await guard.inLock({
          job,
          step,
          opId: op.operationId,
          params,
          jobOptions: this.d.repo.jobOptions(job.id),
          current: current ? { body: current.body, entity: current.entity } : undefined,
          read: (opId, p) => this.guardRead(job, step, opId, p),
        });
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
          ...(meta.journal === 'pre-image' && current
            ? {
                preImage:
                  step.options.journalPreImageWith !== undefined &&
                  current.entity !== null &&
                  typeof current.entity === 'object'
                    ? {
                        ...(current.entity as Record<string, unknown>),
                        with: step.options.journalPreImageWith,
                      }
                    : (current.entity ?? current.body),
              }
            : step.options.journalPreImage !== undefined
              ? { preImage: step.options.journalPreImage }
              : {}),
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
        const send = (p: OpParams) =>
          callOp(this.lk(job), op, p, {
            ...this.callOptions(job, step, stats),
            ifMatch,
            verify: (ctx) => this.verifyHook(job, step, op, meta, p, ctx.error),
          });
        let value: unknown;
        try {
          value = await send(params);
        } catch (first) {
          // v2 E1a (ADR 0042 decision 9): a field LegendKeeper refuses although the rest is sound (an icon name) is dropped
          // and the write sent once more; the result says what was dropped. Any other refusal fails the step as before.
          const refused = refusedFields(step.options.dropIfRefused, params, first);
          if (!refused) throw first;
          const body = { ...(params.body as Record<string, unknown>) };
          const droppedFields: Record<string, unknown> = {};
          const write = step.options.journalOperation?.write;
          const droppedWhere = typeof write === 'string' ? write : op.operationId;
          for (const k of refused) {
            droppedFields[k] = body[k];
            delete body[k];
          }
          params = { ...params, body };
          this.d.repo.setStepParams(job.id, step.stepNo, params);
          const retried = await send(params);
          value =
            retried !== null && typeof retried === 'object' && !Array.isArray(retried)
              ? { ...(retried as Record<string, unknown>), droppedFields, droppedWhere }
              : { droppedFields, droppedWhere };
        }
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
        return this.succeed(job, step, stats, value, false, store, this.etagOf(job, op, stats));
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
   * v2 D1.1 (ADR 0039): the `ETag` a write answered with, when it can serve as the next chained If-Match: the project's
   * `useEtagVersions` setting is on (default) and the write is one LegendKeeper versions (a row write, a document
   * write), never one it does not (`updateProperty`), whose ETag, if any, would be of another kind.
   */
  private etagOf(job: JobView, op: OperationDef, stats: CallStats): string | undefined {
    if (stats.etag === undefined || !op.versioned) return undefined;
    return this.d.etagVersions?.(job.projectId) === false ? undefined : stats.etag;
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
      // v2 E1a: this read shows the step's own write: the snapshot service may use it for the change snapshot.
      if (after.read) this.tapRead(job, after.read.op, { path: after.read.path }, after.body, step.stepNo);
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
    // v2 E1a: the in-step verify of a page write reads here; the snapshot service reuses what it read.
    this.tapRead(job, readOp.operationId, { path }, body);
    const read = { op: readOp.operationId, path };
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
    // v2 D1 (the CR-2026-11 note on lanes): a lane's delete takes its events with it, and LegendKeeper has no restore
    // for either, so the read that gives the journal its pre-image also lists the lane's events (every page of them):
    // the pre-image is the lane with its `events`. This holds on every route (the timeline tools, lk_api_*, lk_op_*).
    if (
      _op.operationId === 'deleteLane' &&
      entity !== undefined &&
      params.path?.documentId &&
      params.path.laneId
    ) {
      const events = await this.laneEvents(
        job,
        step,
        params.path.resourceId!,
        params.path.documentId,
        params.path.laneId,
      );
      const withEvents = { ...(entity as Record<string, unknown>), events };
      return { exists: true, body: withEvents, entity: withEvents, version };
    }
    // v2 D3 (ADR 0041): an asset's bytes (and a folder's children's) are kept before it is deleted, on every route; the
    // pre-image records where. A keeper that cannot keep them refuses the delete (nothing is sent).
    if (
      _op.operationId === 'deleteAsset' &&
      entity !== undefined &&
      entity !== null &&
      typeof entity === 'object'
    ) {
      const keeper = this.d.assetDeleteKeeper?.();
      if (keeper) {
        const kept = await keeper({
          job,
          step,
          lk: this.lk(job),
          asset: entity as Record<string, unknown>,
          read: async (opId, p) => (await this.readOp(job, step, opId, p)).body,
        });
        const withBytes = { ...(entity as Record<string, unknown>), ...kept };
        return { exists: true, body: withBytes, entity: withBytes, version };
      }
    }
    return { exists: entity !== undefined, body, entity, version, read };
  }

  /** Every event of one lane of a timeline (listEvents, paged, filtered by lane). */
  private async laneEvents(
    job: JobView,
    step: StepView,
    resourceId: string,
    documentId: string,
    laneId: string,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = await this.readOp(job, step, 'listEvents', {
        path: { resourceId, documentId },
        query: { limit: 100, ...(cursor ? { cursor } : {}) },
      });
      const b = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      for (const e of Array.isArray(b.data) ? (b.data as { laneId?: unknown }[]) : [])
        if (e && e.laneId === laneId) out.push(e);
      if (b.hasMore !== true || typeof b.nextCursor !== 'string') break;
      cursor = b.nextCursor;
    }
    return out;
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
    /** v2 D1.1 (ADR 0039): the write's `ETag`, kept beside the result as the version for the next chained If-Match. */
    etag?: string,
  ): StepOutcome {
    const requestIds = [...step.requestIds, ...stats.requestIds];
    const stored =
      etag === undefined
        ? value
        : value !== null && typeof value === 'object' && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), etag }
          : { etag };
    const { summary, artifactId } = store
      ? this.summarise(job.id, step.stepNo, stored, verified)
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

// ============================================================================================ v2 C2b helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const titleKey = (t: unknown) => (typeof t === 'string' ? t.trim().toLocaleLowerCase('en-GB') : '');

/**
 * A page created from a template, matched to the template's layout: each template property to the copy's property of
 * the same kind and title (in order, when several share both), its rows by key and value in rank order, its items in
 * order. Returns the template id → copy id map, or every difference (then nothing is bound or written).
 */
export function matchCopy(
  label: string,
  expected: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly rows?: readonly {
      readonly id: string;
      readonly key: string;
      readonly content: readonly Obj[];
    }[];
    readonly items?: readonly string[];
  }[],
  body: unknown,
): { ids: Record<string, string>; differences: StateDifference[] } {
  const props = (
    isObj(body) && Array.isArray(body.data)
      ? body.data
      : isObj(body) && Array.isArray(body.properties)
        ? body.properties
        : []
  ).filter(isObj);
  const used = new Set<Obj>();
  const ids: Record<string, string> = {};
  const differences: StateDifference[] = [];
  for (const e of expected) {
    const a = props.find((p) => !used.has(p) && p.kind === e.kind && titleKey(p.title) === titleKey(e.title));
    const where = `${label} ${e.title || e.kind}`;
    if (!a || typeof a.id !== 'string') {
      differences.push({ path: where, expected: `a ${e.kind} property`, actual: '(not in the copy)' });
      continue;
    }
    used.add(a);
    ids[e.id] = a.id;
    if (e.rows) {
      const got = rowsState(a.rows);
      const want = e.rows.map((r) => ({ key: r.key, content: normaliseContent(r.content) }));
      if (got.length !== want.length) {
        differences.push({ path: `${where} rows`, expected: want.length, actual: got.length });
        continue;
      }
      want.forEach((w, i) => {
        const g = got[i]!;
        if (g.key !== w.key || stableJson(g.content) !== stableJson(w.content)) {
          differences.push({
            path: `${where} rows[${i}]`,
            expected: w,
            actual: { key: g.key, content: g.content },
          });
        } else if (g.id) ids[e.rows![i]!.id] = g.id;
      });
    }
    if (e.items) {
      const got = collectionState(a).items;
      if (got.length !== e.items.length) {
        differences.push({ path: `${where} items`, expected: e.items.length, actual: got.length });
        continue;
      }
      e.items.forEach((tid, i) => {
        const g = got[i]!;
        if (g.id) ids[tid] = g.id;
      });
    }
  }
  return { ids, differences };
}

/** A `facts` verify target: the key-value property's rows by key and value in rank order, and collections' pages. */
function compareFacts(t: Extract<VerifyTarget, { kind: 'facts' }>, res: Obj, diffs: StateDifference[]): void {
  const props = Array.isArray(res.properties) ? res.properties.filter(isObj) : [];
  if (t.property) {
    const hits = props.filter(
      (p) => p.kind === 'keyValue' && titleKey(p.title) === titleKey(t.property!.title),
    );
    if (hits.length !== 1) {
      diffs.push({
        path: `${t.label} ${t.property.title}`,
        expected: 'one property',
        actual: `${hits.length}`,
      });
    } else {
      const got = rowsState(hits[0]!.rows).map((r) => ({ key: r.key, content: r.content }));
      const want = t.property.rows.map((r) => ({ key: r.key, content: normaliseContent(r.content) }));
      const n = Math.max(got.length, want.length);
      for (let i = 0; i < n; i++) {
        const g = got[i];
        const w = want[i];
        if (!g || !w || g.key !== w.key || stableJson(g.content) !== stableJson(w.content)) {
          diffs.push({
            path: `${t.label} ${t.property.title} rows[${i}]${w ? ` “${w.key}”` : ''}`,
            expected: w ?? '(no row)',
            actual: g ?? '(no row)',
          });
        }
      }
    }
  }
  for (const c of t.collections ?? []) {
    const hits = props.filter(
      (p) =>
        (p.kind === 'resourceCollection' || p.kind === 'resourceLink') &&
        titleKey(p.title) === titleKey(c.title),
    );
    if (hits.length !== 1) {
      diffs.push({ path: `${t.label} ${c.title}`, expected: 'one collection', actual: `${hits.length}` });
      continue;
    }
    const got = collectionState(hits[0]).items.map((i) => ({
      resourceId: i.resourceId,
      documentId: i.documentId,
    }));
    if (stableJson(got) !== stableJson(c.items))
      diffs.push({ path: `${t.label} ${c.title} items`, expected: c.items, actual: got });
  }
}

/** A child as a parent's listing shows it (v2 C2b's placement check). */
interface SiblingItem {
  readonly id: string;
  readonly rank: string;
  readonly raw: Record<string, unknown>;
}

/** The fields a `listResources` item carries, so a resource target with only these is checked from the listing. */
const LISTING_FIELDS: ReadonlySet<string> = new Set(['name', 'parentId', 'tags', 'aliases', 'isHidden']);

/** A resource's fields as planned (tags and aliases compared as sets: LegendKeeper may keep another order). */
function compareFields(
  label: string,
  fields: Readonly<Record<string, unknown>>,
  actual: Record<string, unknown>,
  diffs: StateDifference[],
): void {
  for (const [k, v] of Object.entries(fields)) {
    const norm = (x: unknown) =>
      (k === 'tags' || k === 'aliases') && Array.isArray(x) ? [...(x as string[])].sort() : (x ?? null);
    if (stableJson(norm(actual[k])) !== stableJson(norm(v)))
      diffs.push({ path: `${label} ${k}`, expected: v ?? null, actual: actual[k] ?? null });
  }
}

/** Where a page stands among its siblings (by rank): its neighbours must be the planned ones (null: none). */
function placementDiffs(
  t: Extract<VerifyTarget, { kind: 'resource' }>,
  list: readonly SiblingItem[],
  diffs: StateDifference[],
): void {
  const pl = t.placement!;
  const i = list.findIndex((x) => x.id === t.resourceId);
  if (i < 0) {
    diffs.push({ path: `${t.label} parent`, expected: pl.parentId, actual: '(not among its children)' });
    return;
  }
  const prev = list[i - 1]?.id ?? null;
  const next = list[i + 1]?.id ?? null;
  if (pl.after !== undefined && pl.after !== prev)
    diffs.push({ path: `${t.label} place (after)`, expected: pl.after ?? 'first', actual: prev ?? 'first' });
  if (pl.before !== undefined && pl.before !== next)
    diffs.push({ path: `${t.label} place (before)`, expected: pl.before ?? 'last', actual: next ?? 'last' });
}

/** v2 D1: runs a document checker; a checker that throws is a conflict with its message (nothing is written). */
function runChecker(
  checker: DocumentChecker,
  ctx: Parameters<DocumentChecker>[0],
): ReturnType<DocumentChecker> {
  try {
    return checker(ctx);
  } catch (e) {
    return {
      differences: [
        { path: ctx.label, expected: 'the plan’s state', actual: e instanceof Error ? e.message : String(e) },
      ],
    };
  }
}

/** v2 D2: runs a map checker; one that throws is a conflict with its message (nothing is written). */
function runMapChecker(checker: MapChecker, ctx: Parameters<MapChecker>[0]): ReturnType<MapChecker> {
  try {
    return checker(ctx);
  } catch (e) {
    return {
      differences: [
        { path: ctx.label, expected: 'the plan’s state', actual: e instanceof Error ? e.message : String(e) },
      ],
    };
  }
}

/**
 * v2 E1a (ADR 0042 decision 9): the body fields of a write LegendKeeper refused, when the step allows dropping them
 * (`dropIfRefused`): a 400 VALIDATION_ERROR that names the field (its path, or its message: "Invalid icon name" for an
 * `icon…` field). Nothing otherwise.
 */
export function refusedFields(
  allowed: readonly string[] | undefined,
  params: OpParams,
  e: unknown,
): string[] | undefined {
  if (!allowed || allowed.length === 0) return undefined;
  if (!(e instanceof BridgeLkError) || e.status !== 400 || (e.code && e.code !== 'VALIDATION_ERROR'))
    return undefined;
  const body = params.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const text = [e.message, ...e.errors.map((i) => `${i.path} ${i.message}`)].join(' ');
  const hit = allowed.filter((k) => {
    if (!(k in (body as Record<string, unknown>))) return false;
    if (e.errors.some((i) => i.path.split(/[.[\]]+/).includes(k))) return true;
    return text.includes(k) || (/^icon/i.test(k) && /\bicon\b/i.test(text));
  });
  return hit.length > 0 ? hit : undefined;
}

/** v3 F2: a row value's plain text from its runs (null when it has none). */
function runsText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  return (content as unknown[])
    .map((r) =>
      r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string'
        ? (r as { text: string }).text
        : '',
    )
    .join('');
}
