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
  SIDEBAR_IGNORED_FIELDS,
  VERIFY_STEP,
  isInternalStep,
  type BlockCheck,
  type ChildrenCheck,
  type ExpectCheck,
  type ResourceCheck,
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
  /** v2 C2a: the write guard (protected canonical facts), asked before each write is sent, inside its lock. */
  readonly writeGuard?: () => WriteGuard | undefined;
  /** v2 C2c: the lifecycle record's handler (`bridge.record`), registered by the lifecycle module. */
  readonly recordHandler?: () => RecordHandler | undefined;
}

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

    const lockKey = projectLockKey(job.projectId, lockKeyFor(op, params));
    // v2 C2a: the job already holds this lock for its whole run (BatchSubmit.holdLock); it is not taken again. v2 C2c:
    // a job may hold two (the page's and one of its documents').
    const held: readonly string[] =
      opts.heldLock === undefined || opts.heldLock === null
        ? []
        : typeof opts.heldLock === 'string'
          ? [opts.heldLock]
          : opts.heldLock;
    const ownLock = lockKey !== null && !held.includes(lockKey);
    if (ownLock && held.length > 0) {
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
        const handler = this.d.recordHandler?.();
        if (!handler)
          throw new JobsError('BRIDGE_ERROR', 'The lifecycle record is not available; nothing was written.');
        return this.succeed(job, step, stats, await handler(job, step, params));
      }
      if (step.opId !== VERIFY_STEP) throw new JobsError('BRIDGE_ERROR', `Unknown bridge step ${step.opId}`);
      const verification = await this.runVerify(job, step, params, stats);
      if (verification.status === 'mismatch') this.d.recordVerifyMismatch?.(job, step, verification);
      return this.succeed(job, step, stats, { verification });
    } catch (e) {
      return this.fail(job, step, stats, e);
    }
  }

  /** `bridge.expect`: each property as the plan saw it, or a conflict. Returns the version each read gave. */
  private async runExpect(
    job: JobView,
    step: StepView,
    params: OpParams,
    stats: CallStats,
  ): Promise<{ checked: string[]; versions: Record<string, string | null>; ids?: Record<string, string> }> {
    const checks = ((params.body ?? {}) as { checks?: ExpectCheck[] }).checks ?? [];
    const ref = { jobId: job.id, stepNo: step.stepNo };
    const versions: Record<string, string | null> = {};
    const ids: Record<string, string> = {};
    for (const c of checks) {
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
        } else {
          const now = sidebarState(r.body);
          const diffs = compareSidebarStates(c.properties, now);
          const version = factsVersionOf(now);
          if (diffs.length === 0 && version !== c.factsVersion) {
            diffs.push({ path: `${c.label} factsVersion`, expected: c.factsVersion, actual: version });
          }
          if (diffs.length > 0) {
            throw new StateConflictError(EXPECT_STEP, c.label, diffs, c.factsVersion, version, ref);
          }
        }
        versions[c.label] = null;
        continue;
      }
      // v2 C2c: a page's own fields, the pages under it, or one block of a document, as the plan saw them.
      if (c.kind === 'resource' || c.kind === 'children' || c.kind === 'block') {
        const diffs = await this.expectStructure(job, step, c, stats);
        if (diffs.length > 0) throw new StateConflictError(EXPECT_STEP, c.label, diffs, null, null, ref);
        versions[c.label] = null;
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
      versions[c.label] = version;
    }
    return {
      checked: checks.map((c) => c.label),
      versions,
      ...(Object.keys(ids).length > 0 ? { ids } : {}),
    };
  }

  /** v2 C2c: the differences between a page's fields, children or one block and what the plan saw. */
  private async expectStructure(
    job: JobView,
    step: StepView,
    c: ResourceCheck | ChildrenCheck | BlockCheck,
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
            factsVersion = factsVersionOf(sidebarState(res));
          } else if (t.kind === 'sidebar') {
            factsVersion = factsVersionOf(sidebarState(res));
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
      return { exists: true, body };
    } catch (e) {
      if (isNotFound(e)) return { exists: false, body: undefined };
      throw e;
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
        const now =
          expect.state === 'rows'
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
            ? { preImage: current.entity ?? current.body }
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
