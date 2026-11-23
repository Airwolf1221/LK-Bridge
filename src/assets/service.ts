/**
 * The asset tree service (v2 A4, docs/assets.md, ADR 0027): the bridge's own model of each project's asset library.
 *
 * - **First build** (`prepareBuild` → `confirmBuild`): lists the library's root level and stops to show the estimate;
 *   after the owner confirms it walks every folder (listAssets returns one folder level at a time, paged), at P3.
 *   Progress is persisted; a restart continues where it stopped.
 * - **Regular refresh** (default every 6 hours, can be switched off per project) and **nightly check**: the same walk,
 *   at P3, so it paces itself and gives way to agents' work. What they correct is written to the correction log.
 * - **After the bridge's own asset writes** (a write observer on the job engine): createAssetFolder, createImageAsset,
 *   updateAsset and deleteAsset are each followed, in the same job, by a getAsset of what they changed; the model is
 *   updated from what LegendKeeper answers, never from the request.
 * - **Concurrency**: every change to a project's model goes through one queue per project, and an observation never
 *   replaces one made later (see store.ts), so a refresh never undoes a newer after-write update.
 *
 * All LegendKeeper requests go through the job engine's governed `internalRead` (the project's governor).
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import {
  BudgetExhaustedError,
  CancelledError,
  JobsError,
  LkOperationError,
  type JobEngine,
  type OpParams,
  type PriorityClass,
  type WriteStepInfo,
  type WriteStepResult,
} from '../jobs/index.js';
import type { Clock } from '../lk/index.js';
import type { ProjectsRuntime } from '../projects/registry.js';
import { ProjectStore } from '../projects/store.js';
import { FOLDER_TYPE, assetSettingsFrom, observationFromAsset, type AssetSettings } from './classify.js';
import { planAssetDestination, type PlanRequest, type PlanResult } from './plan.js';
import type { PlanDeps } from './plan.js';
import { AssetQueries } from './queries.js';
import { AssetStore, type ApplyContext, type MissingChild, type WalkRow } from './store.js';
import {
  ACTIVE_ASSET_PASS_STATUSES,
  type AssetBuildEstimate,
  type AssetMeta,
  type AssetObservation,
  type AssetPassKind,
  type AssetPassView,
  type AssetReadBy,
  type AssetTreeStatus,
} from './types.js';

export interface AssetLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AssetServiceOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly projects: ProjectsRuntime;
  readonly clock: Clock;
  readonly log?: AssetLogger;
  /** A model not confirmed by a completed pass for this long is `stale` (default 26 hours: the nightly check, plus slack). */
  readonly staleAfterMs?: number;
  /** listAssets page size (default 100, the API's maximum). */
  readonly pageSize?: number;
  /** The pause after each listing request of a pass (default 250 ms): the walk is paced, never a burst. */
  readonly paceMs?: number;
  /** The repository tree's queries, for placement planning (a character page's ancestry). */
  readonly tree?: PlanDeps['tree'];
  /**
   * The project's character type from the type registry (A3): its asset root folder, Characters index page, unknown-race
   * index and Core Reference Type. Without it (or without a character type) the old bridge's literals are used.
   */
  readonly characterType?: PlanDeps['characterType'];
}

/** The asset operations the model follows, and what each does. */
const ASSET_OPS: Readonly<Record<string, 'create' | 'update' | 'delete'>> = {
  createAssetFolder: 'create',
  createImageAsset: 'create',
  updateAsset: 'update',
  deleteAsset: 'delete',
};

/** The operations the model follows (documented in docs/assets.md; tests check each). */
export const ASSET_FOLLOWED_OPS: readonly string[] = Object.keys(ASSET_OPS);

interface RereadFlags {
  /** Creates: the folder the new asset was put in (null: the root), listed when the response gave no id. */
  parentId?: string | null;
  [k: string]: unknown;
}

/** A pass that cannot go on (the credentials, the plan, the root listing): ends the pass as failed. */
class PassError extends Error {}

const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;

export interface AssetPassOutcome {
  readonly summary: string;
  readonly changed?: boolean;
  readonly skipped?: boolean;
}

export type AssetErrorCode = 'PASS_RUNNING' | 'NOTHING_TO_CONFIRM' | 'NOTHING_TO_CANCEL';

export class AssetError extends Error {
  constructor(
    readonly code: AssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

interface ReadOptions {
  readonly priority: PriorityClass;
  readonly jobId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly passId?: string | undefined;
  /** Wait out an exhausted budget on the clock instead of failing. */
  readonly waitForBudget: boolean;
  /** Wait while the project is not served (builds only). */
  readonly waitForProject?: boolean | undefined;
}

interface ReadResult {
  readonly gone: boolean;
  readonly value: unknown;
  /** When the request was sent: the observation stamp. */
  readonly t: number;
}

export class AssetService {
  readonly store: AssetStore;
  readonly queries: AssetQueries;
  private readonly projectStore: ProjectStore;
  private readonly staleAfterMs: number;
  private readonly pageSize: number;
  private readonly paceMs: number;
  /** One queue per project: every change to its model runs in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Running passes, by pass id. */
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly background = new Set<Promise<unknown>>();
  private retryTimer: ReturnType<Clock['setTimeout']> | null = null;
  private stopAll = new AbortController();
  private started = false;
  private stopped = false;
  private detach: (() => void) | null = null;
  private lastStamp = 0;
  private offProjects: (() => void) | null = null;
  /** Owed re-reads being done right now (by their job, or by the retry loop). */
  private readonly rereading = new Set<number>();
  private processing = false;
  private retriesStopped = false;

  constructor(private readonly o: AssetServiceOptions) {
    const now = () => o.clock.now();
    this.store = new AssetStore(o.db, now);
    this.projectStore = new ProjectStore(o.db, now);
    this.staleAfterMs = o.staleAfterMs ?? 26 * 3_600_000;
    this.pageSize = o.pageSize ?? 100;
    this.paceMs = o.paceMs ?? 250;
    this.queries = new AssetQueries(this.store, (p) => this.meta(p));
  }

  // ============================================================================================ lifecycle

  /** Follows the engine's writes (the after-write updates). Returns a detach function. */
  attach(): () => void {
    this.detach?.();
    const off = this.o.engine.observeWrites({
      beforeWrite: (info) => this.beforeWrite(info),
      afterWrite: (r) => this.afterWrite(r),
    });
    this.detach = off;
    return () => {
      off();
      if (this.detach === off) this.detach = null;
    };
  }

  /**
   * Resumes builds a restart interrupted, marks interrupted refreshes and checks, and catches up re-reads owed by
   * writes that finished while the process was down.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.retriesStopped = false;
    this.stopAll = new AbortController();
    for (const p of this.store.activePasses()) {
      if (p.kind === 'build') {
        if (p.status !== 'awaiting_confirmation' && this.o.projects.client(p.projectId)) this.launch(p);
      } else {
        this.store.updatePass(p.id, {
          status: 'interrupted',
          error: 'The bridge stopped while this pass was running.',
          finishedAt: this.o.clock.now(),
        });
        this.store.clearListing(p.id);
      }
    }
    this.scheduleRetries(0);
    for (const id of this.o.projects.activeIds()) this.projectServed(id);
    this.offProjects = this.o.projects.onChange((v) => {
      if (v.status === 'active' && v.id) this.projectServed(v.id);
    });
  }

  /** A project is served (now, or once its key is verified): resume its build and its owed re-reads. */
  private projectServed(projectId: string): void {
    if (!this.started || this.stopped) return;
    const active = this.store.activePass(projectId);
    if (active?.kind === 'build' && active.status !== 'awaiting_confirmation') this.launch(active);
    this.scheduleRetries(0);
  }

  /**
   * The first half of a shutdown: stops passes (a build resumes at the next start), retries and background work, but
   * keeps following the engine's writes, so writes that finish while the engine drains are still re-read (or owed).
   */
  async stopPasses(): Promise<void> {
    this.retriesStopped = true;
    this.stopAll.abort(new CancelledError());
    for (const r of this.running.values()) r.abort.abort(new CancelledError());
    if (this.retryTimer) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await Promise.allSettled([...[...this.running.values()].map((r) => r.done), ...this.background]);
  }

  /** Stops passes, retries and background work, and stops following writes. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.offProjects?.();
    this.offProjects = null;
    this.stopAll.abort(new CancelledError());
    for (const r of this.running.values()) r.abort.abort(new CancelledError());
    if (this.retryTimer) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await Promise.allSettled([...[...this.running.values()].map((r) => r.done), ...this.background]);
    this.detach?.();
    this.detach = null;
  }

  /** Resolves when no pass, re-read or background task is running (tests). */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const all = [
        ...[...this.running.values()].map((r) => r.done),
        ...this.background,
        ...this.chains.values(),
      ];
      if (all.length === 0) return;
      await Promise.allSettled(all);
    }
  }

  // ============================================================================================ status

  /** The asset settings of a project, read from the database each time (the CLI may change them while running). */
  settings(projectId: string): AssetSettings {
    return assetSettingsFrom(this.projectStore.byId(projectId)?.settings ?? {});
  }

  /** What every query states: the model's status and when it was last confirmed. */
  meta(projectId: string): AssetMeta {
    const state = this.store.state(projectId);
    const active = this.store.activePass(projectId);
    const staleRows = this.store.staleCount(projectId);
    const pendingRereads = this.store.pendingCount(projectId);
    const failed = this.store.failedPendingCount(projectId);
    const base = {
      projectId,
      confirmedAt: state?.confirmed_at ?? null,
      confirmedBy: state?.confirmed_by ?? null,
      staleRows,
      pendingRereads,
    };
    let status: AssetTreeStatus;
    let reason: string | null = null;
    if (active?.kind === 'build' && active.status !== 'awaiting_confirmation') {
      status = 'building';
      reason =
        active.status === 'preparing'
          ? 'Building: listing the library’s root level.'
          : `Building: ${active.foldersDone} of ${active.foldersFound} folders listed so far.`;
    } else if (!state?.built_at) {
      status = 'not_built';
      reason =
        active?.status === 'awaiting_confirmation'
          ? 'The first build has listed the root level and is waiting for you to confirm its estimate (Asset Tree page).'
          : 'The first build has not run yet: start it on the Asset Tree page.';
    } else if (staleRows > 0) {
      status = 'stale';
      reason = `${staleRows} ${staleRows === 1 ? 'row' : 'rows'} could not be confirmed (a read failed, or a folder could not be listed); the next refresh or check settles them.`;
    } else if (failed > 0) {
      status = 'stale';
      reason = `${failed} re-read${failed === 1 ? '' : 's'} after the bridge's own writes failed; retried, and settled by the next refresh.`;
    } else if (state.confirmed_at === null || state.confirmed_at < this.o.clock.now() - this.staleAfterMs) {
      status = 'stale';
      reason = `No refresh or check has confirmed the asset tree for ${Math.round(this.staleAfterMs / 3_600_000)} hours.`;
    } else {
      status = 'ready';
    }
    return { ...base, status, reason };
  }

  /**
   * Everything the dashboard's Asset Tree page shows for one project: status, counts, the running pass's progress,
   * the last build, refresh and check, stale rows, failed re-reads.
   */
  overview(projectId: string) {
    const meta = this.meta(projectId);
    const pending = this.store.pending(projectId);
    return {
      tree: meta,
      settings: this.settings(projectId),
      counts: this.store.counts(projectId),
      stale: this.queries.stale(projectId, 100).data,
      activePass: this.store.activePass(projectId) ?? null,
      lastBuild: this.store.lastPass(projectId, 'build') ?? null,
      lastRefresh: this.store.lastPass(projectId, 'refresh') ?? null,
      lastCheck: this.store.lastPass(projectId, 'check') ?? null,
      recentPasses: this.store.recentPasses(projectId, 10),
      rereads: {
        inFlight: pending.filter((p) => p.status === 'in_flight').length,
        failed: pending
          .filter((p) => p.status === 'retry')
          .map((p) => ({
            id: p.id,
            op: p.op,
            jobId: p.job_id,
            assetIds: parseIds(p.asset_ids),
            attempts: p.attempts,
            lastError: p.last_error,
            nextAt: p.next_at,
            createdAt: p.created_at,
          })),
      },
    };
  }

  // ============================================================================================ placement

  /**
   * Where an asset for a character (or a literal folder path) goes: a PURE PLAN from the stored models. Nothing is
   * written and nothing is requested from LegendKeeper. See `planAssetDestination`.
   */
  /** v2 D3: what the planner reads (the image pipeline plans with it too), or null without a repository tree. */
  planDeps(): PlanDeps | null {
    if (!this.o.tree) return null;
    return {
      assets: this.queries,
      tree: this.o.tree,
      charactersRootId: (p) => this.settings(p).charactersRootId,
      ...(this.o.characterType ? { characterType: this.o.characterType } : {}),
    };
  }

  plan(projectId: string, request: PlanRequest): PlanResult {
    if (!this.o.tree) {
      return {
        ok: false,
        error: {
          code: 'REPOSITORY_TREE_NOT_READY',
          message: 'The repository tree is not available to the planner.',
        },
      };
    }
    return planAssetDestination(projectId, request, {
      assets: this.queries,
      tree: this.o.tree,
      charactersRootId: (p) => this.settings(p).charactersRootId,
      ...(this.o.characterType ? { characterType: this.o.characterType } : {}),
    });
  }

  // ============================================================================================ passes

  /**
   * Starts a build: it lists the library's root level at P3 and then waits on `awaiting_confirmation` with the
   * estimate, unless `autoConfirm`. A build already running or waiting is returned as it is.
   */
  prepareBuild(projectId: string, o: { trigger?: string; autoConfirm?: boolean } = {}): AssetPassView {
    const active = this.store.activePass(projectId);
    if (active) {
      if (active.kind === 'build') return active;
      throw new AssetError('PASS_RUNNING', `A ${active.kind} is running; try again when it has finished.`);
    }
    const pass = this.store.createPass({
      id: newPassId('build'),
      projectId,
      kind: 'build',
      trigger: o.autoConfirm ? `${o.trigger ?? 'owner'}:confirmed` : (o.trigger ?? 'owner'),
      status: 'preparing',
    });
    this.launch(pass);
    return pass;
  }

  /** Confirms a build waiting on its estimate: it walks every folder. */
  confirmBuild(projectId: string): AssetPassView {
    const active = this.store.activePass(projectId);
    if (!active || active.kind !== 'build' || active.status !== 'awaiting_confirmation') {
      throw new AssetError('NOTHING_TO_CONFIRM', 'No build is waiting for confirmation.');
    }
    this.store.updatePass(active.id, { status: 'walking' });
    const p = this.store.pass(active.id)!;
    this.launch(p);
    return p;
  }

  /** Cancels a build (preparing, waiting or walking). What it has stored stays; the model is `not_built` or `stale`. */
  cancelBuild(projectId: string): AssetPassView {
    const active = this.store.activePass(projectId);
    if (!active || active.kind !== 'build') throw new AssetError('NOTHING_TO_CANCEL', 'No build is running.');
    this.running.get(active.id)?.abort.abort(new CancelledError());
    this.store.updatePass(active.id, {
      status: 'cancelled',
      error: 'Cancelled by the owner.',
      finishedAt: this.o.clock.now(),
    });
    this.store.clearListing(active.id);
    return this.store.pass(active.id)!;
  }

  /** The regular refresh of one project (a maintenance job). Can be switched off per project. */
  async refresh(projectId: string, trigger = 'schedule'): Promise<AssetPassOutcome> {
    if (!this.settings(projectId).refreshEnabled && trigger !== 'manual' && trigger !== 'owner') {
      return { skipped: true, summary: 'Skipped: the regular refresh is switched off for this project.' };
    }
    return this.runMaintenancePass(projectId, 'refresh', trigger);
  }

  /** The nightly check of one project (a maintenance job). Runs even when the regular refresh is switched off. */
  async check(projectId: string, trigger = 'schedule'): Promise<AssetPassOutcome> {
    return this.runMaintenancePass(projectId, 'check', trigger);
  }

  private async runMaintenancePass(
    projectId: string,
    kind: 'refresh' | 'check',
    trigger: string,
  ): Promise<AssetPassOutcome> {
    const meta = this.meta(projectId);
    if (meta.status === 'not_built' || meta.status === 'building') {
      return {
        skipped: true,
        summary: `Skipped: the asset tree is ${meta.status === 'building' ? 'being built' : 'not built yet'}.`,
      };
    }
    const active = this.store.activePass(projectId);
    if (active) return { skipped: true, summary: `Skipped: a ${active.kind} is running.` };
    let pass: AssetPassView;
    try {
      pass = this.store.createPass({ id: newPassId(kind), projectId, kind, trigger, status: 'walking' });
    } catch {
      return { skipped: true, summary: 'Skipped: another pass started at the same moment.' };
    }
    await this.launch(pass).done;
    const done = this.store.pass(pass.id)!;
    if (done.status === 'failed') throw new Error(done.error ?? `The ${kind} failed.`);
    if (done.status !== 'succeeded') {
      return { skipped: true, summary: done.error ?? `The ${kind} did not complete (${done.status}).` };
    }
    return {
      summary: done.summary ?? `The ${kind} completed.`,
      changed: done.added + done.removed + done.corrected > 0,
    };
  }

  private launch(pass: AssetPassView): { done: Promise<void> } {
    const existing = this.running.get(pass.id);
    if (existing) return existing;
    if (this.retriesStopped || this.stopped) return { done: Promise.resolve() }; // shutting down: resumes at start
    const abort = new AbortController();
    const onStop = () => abort.abort(new CancelledError());
    this.stopAll.signal.addEventListener('abort', onStop, { once: true });
    const done = this.runPass(pass.id, abort.signal)
      .catch((e: unknown) => {
        this.o.log?.warn({ err: e, passId: pass.id }, 'an asset tree pass failed');
      })
      .finally(() => {
        this.stopAll.signal.removeEventListener('abort', onStop);
        this.running.delete(pass.id);
      });
    const entry = { abort, done };
    this.running.set(pass.id, entry);
    return entry;
  }

  private stillActive(passId: string, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    const p = this.store.pass(passId);
    return p !== undefined && ACTIVE_ASSET_PASS_STATUSES.has(p.status);
  }

  private async runPass(passId: string, signal: AbortSignal): Promise<void> {
    let pass = this.store.pass(passId)!;
    const projectId = pass.projectId;
    try {
      if (pass.snapshotAt === null) this.store.updatePass(passId, { snapshotAt: this.stamp() });
      this.store.enqueueWalk(passId, projectId, ''); // the library's root: a no-op when resuming
      for (;;) {
        if (!this.stillActive(passId, signal)) return;
        pass = this.store.pass(passId)!;
        let row: WalkRow | undefined;
        if (pass.status === 'preparing') {
          // The root level only; then the estimate.
          const root = this.store.walkRow(passId, '');
          if (root?.status === 'pending') row = root;
          else {
            this.endPreparing(pass);
            if (this.store.pass(passId)!.status === 'awaiting_confirmation') return;
            continue;
          }
        } else {
          row = this.store.nextWalk(passId);
        }
        if (!row) break;
        await this.walkFolder(pass, row, signal);
        if (this.paceMs > 0 && this.stillActive(passId, signal))
          await sleep(this.o.clock, this.paceMs, signal);
      }
      if (!this.stillActive(passId, signal)) return;
      await this.finishPass(this.store.pass(passId)!);
    } catch (e) {
      if (signal.aborted || e instanceof CancelledError) return; // stopping: see finally
      const message = errorText(e);
      this.store.updatePass(passId, { status: 'failed', error: message, finishedAt: this.o.clock.now() });
      this.store.clearListing(passId);
      if (pass.kind === 'build') this.recordPassJob(this.store.pass(passId)!);
      if (!(e instanceof PassError)) {
        this.o.log?.warn({ err: e, passId, projectId }, 'an asset tree pass failed');
      }
    } finally {
      // Stopping: a build resumes at the next start; a refresh or check ends as interrupted (the next one starts afresh).
      const now = this.store.pass(passId);
      if (signal.aborted && now && now.kind !== 'build' && ACTIVE_ASSET_PASS_STATUSES.has(now.status)) {
        this.store.updatePass(passId, {
          status: 'interrupted',
          error: 'The bridge stopped while this pass was running.',
          finishedAt: this.o.clock.now(),
        });
        this.store.clearListing(passId);
      }
    }
  }

  /** The root level is listed: show the estimate and wait for the owner (or go straight on when confirmed in advance). */
  private endPreparing(pass: AssetPassView): void {
    if (pass.trigger.endsWith(':confirmed')) {
      this.store.updatePass(pass.id, { status: 'walking' });
      return;
    }
    this.store.updatePass(pass.id, { status: 'awaiting_confirmation', estimate: this.estimate(pass) });
  }

  /**
   * The estimate shown after the root level was listed. Folders are only found by listing their parent, so the total
   * is not known in advance: the walk makes one request per folder (plus one for every further 100 items in a folder).
   * What is known is a minimum (one request per folder found so far); a rebuild also knows the last inventory.
   */
  private estimate(pass: AssetPassView): AssetBuildEstimate {
    const root = this.store.rootLevel(pass.projectId);
    const hadInventory = this.store.state(pass.projectId)?.built_at != null;
    const folders = this.store.countFolders(pass.projectId);
    const assets = this.store.countItems(pass.projectId);
    const min = root.folders;
    // A rebuild knows the last inventory: one request per folder, one more per further 100 assets, less what is done.
    const likely = hadInventory
      ? Math.max(min, folders + Math.ceil(assets / this.pageSize) - pass.requests)
      : min;
    const gov = this.o.projects.anyClient(pass.projectId)?.governor;
    const e = gov?.estimate({ reads: likely, writes: 0, createManyItems: 0, priority: 'P3' });
    return {
      rootFolders: root.folders,
      rootAssets: root.assets,
      requestsSoFar: pass.requests,
      minRequestsRemaining: min,
      likelyRequestsRemaining: likely,
      basis: hadInventory ? 'the previous inventory' : 'root level only',
      previousFolders: hadInventory ? folders : null,
      previousAssets: hadInventory ? assets : null,
      wallClockMs: e?.wallClockMs ?? 0,
      fitsInDailyBudget: e?.fitsToday ?? true,
      tightestTier: e?.tightestTier ?? null,
      at: this.o.clock.now(),
    };
  }

  /**
   * Lists one folder level (paged) into the pass's staging area, then applies it at once. Resumable from the stored
   * cursor. Folders it finds are queued for the walk. Stored children the listing did not show are verified one by one
   * (getAsset): absence from a listing is not proof of deletion.
   */
  private async walkFolder(pass: AssetPassView, row: WalkRow, signal: AbortSignal): Promise<void> {
    const projectId = pass.projectId;
    const folderId = row.folder_id;
    // A folder removed from the model since it was queued (the bridge deleted it) has nothing to list.
    if (folderId !== '' && !this.store.folder(projectId, folderId)) {
      this.store.clearStaged(pass.id, folderId);
      this.store.updateWalk(pass.id, folderId, { status: 'done' });
      return;
    }
    let T = row.stamp;
    if (T === null) {
      T = this.stamp();
      this.store.updateWalk(pass.id, folderId, { stamp: T });
    }
    let cursor = row.cursor;
    let pages = row.pages;
    for (;;) {
      if (!this.stillActive(pass.id, signal)) return;
      const query: Record<string, unknown> = {
        limit: this.pageSize,
        ...(folderId !== '' ? { folderId } : {}),
        ...(cursor ? { cursor } : {}),
      };
      let result: ReadResult;
      try {
        result = await this.read(
          projectId,
          'listAssets',
          { query },
          {
            priority: 'P3',
            jobId: pass.id,
            signal,
            passId: pass.id,
            waitForBudget: true,
            waitForProject: pass.kind === 'build',
          },
        );
      } catch (e) {
        if (signal.aborted || e instanceof CancelledError) throw e;
        if (cursor && e instanceof LkOperationError && e.status === 400) {
          // The stored cursor no longer works (a long pause): list this folder again from the start.
          T = this.stamp();
          this.store.clearStaged(pass.id, folderId);
          this.store.updateWalk(pass.id, folderId, { cursor: null, pages: 0, stamp: T });
          cursor = null;
          pages = 0;
          continue;
        }
        if (isFatalForPass(e) || folderId === '') {
          throw new PassError(
            folderId === ''
              ? `The library’s root could not be listed: ${errorText(e)}`
              : `The walk cannot go on: ${errorText(e)}`,
          );
        }
        await this.folderFailed(pass, folderId, e);
        return;
      }
      if (result.gone) {
        await this.folderGone(pass, folderId, signal);
        return;
      }
      const page = (result.value ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      const items = (Array.isArray(page.data) ? page.data : [])
        .map(observationFromAsset)
        .filter((x): x is AssetObservation => x !== null);
      const next =
        page.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor !== ''
          ? page.nextCursor
          : null;
      pages++;
      this.o.db.transaction(() => {
        this.store.stageItems(pass.id, projectId, folderId, items);
        this.store.updateWalk(pass.id, folderId, { cursor: next, pages });
        this.store.bumpPass(pass.id, { pages: 1, listed: items.length });
      })();
      if (!next) break;
      cursor = next;
      if (this.paceMs > 0) await sleep(this.o.clock, this.paceMs, signal);
    }
    if (!this.stillActive(pass.id, signal)) return;
    const stamp = T;
    const applied = await this.serial(projectId, () => {
      const r = this.store.applyListing(this.ctx(projectId, pass.kind, pass), pass.id, folderId, stamp);
      this.store.updateWalk(pass.id, folderId, { status: 'done', cursor: null });
      if (r.applied) this.store.bumpPass(pass.id, { foldersDone: folderId === '' ? 0 : 1, added: r.added });
      return r;
    });
    for (const m of applied.missing) {
      if (!this.stillActive(pass.id, signal)) return;
      await this.verifyMissing(pass, m, signal);
    }
  }

  /** A folder's listing failed (not for the credentials or the plan): the folder is marked stale and the walk goes on. */
  private async folderFailed(pass: AssetPassView, folderId: string, e: unknown): Promise<void> {
    const projectId = pass.projectId;
    const message = errorText(e);
    await this.serial(projectId, () => {
      this.store.markStale(projectId, [folderId], `the ${pass.kind} could not list it: ${message}`);
      this.store.clearStaged(pass.id, folderId);
      this.store.updateWalk(pass.id, folderId, { status: 'failed', cursor: null });
      this.store.bumpPass(pass.id, { foldersFailed: 1 });
      this.store.insertLog({
        projectId,
        source: pass.kind,
        passId: pass.id,
        itemId: folderId,
        itemName: this.store.folder(projectId, folderId)?.name ?? null,
        itemKind: 'folder',
        change: 'reread_failed',
        field: null,
        oldValue: null,
        newValue: null,
        detail: `listing failed: ${message}`,
      });
    });
  }

  /** Listing a folder answered 404: read the folder itself, and remove it only if that is a 404 too. */
  private async folderGone(pass: AssetPassView, folderId: string, signal: AbortSignal): Promise<void> {
    const projectId = pass.projectId;
    this.store.clearStaged(pass.id, folderId);
    try {
      await this.verifyMissing(pass, { id: folderId, isFolder: true }, signal);
    } finally {
      this.store.updateWalk(pass.id, folderId, { status: 'done', cursor: null });
    }
    if (this.store.folder(projectId, folderId)) {
      // It exists but cannot be listed: not confirmed.
      await this.folderFailed(pass, folderId, new Error('listing it answered 404, but reading it did not'));
    }
  }

  /** Confirms with a getAsset something a listing did not show: a 404 removes it, an answer is applied. */
  private async verifyMissing(pass: AssetPassView, m: MissingChild, signal: AbortSignal): Promise<void> {
    const projectId = pass.projectId;
    const ro: ReadOptions = {
      priority: 'P3',
      jobId: pass.id,
      signal,
      passId: pass.id,
      waitForBudget: true,
      waitForProject: pass.kind === 'build',
    };
    let r: ReadResult;
    try {
      r = await this.read(projectId, 'getAsset', { path: { assetId: m.id } }, ro);
    } catch (e) {
      if (signal.aborted || e instanceof CancelledError) throw e;
      if (isFatalForPass(e)) throw new PassError(`The walk cannot go on: ${errorText(e)}`);
      const message = errorText(e);
      await this.serial(projectId, () => {
        this.store.markStale(projectId, [m.id], `the ${pass.kind} could not confirm it: ${message}`);
        this.store.insertLog({
          projectId,
          source: pass.kind,
          passId: pass.id,
          itemId: m.id,
          itemName: this.nameOf(projectId, m.id),
          itemKind: m.isFolder ? 'folder' : 'asset',
          change: 'reread_failed',
          field: null,
          oldValue: null,
          newValue: null,
          detail: `confirming it failed: ${message}`,
        });
      });
      return;
    }
    this.store.bumpPass(pass.id, { verified: 1 });
    if (r.gone) {
      const removed = await this.serial(projectId, () =>
        this.store.applyGone(this.ctx(projectId, pass.kind, pass), m.id, r.t, 'not found when confirmed'),
      );
      if (removed > 0) this.store.bumpPass(pass.id, { removed });
      return;
    }
    const obs = observationFromAsset(r.value);
    if (!obs) return;
    let chain: { obs: AssetObservation; t: number }[] = [];
    try {
      if (obs.folderId !== null && !this.store.folder(projectId, obs.folderId)) {
        const a = await this.ancestry(projectId, obs, ro);
        chain = a.ancestors;
        if (a.verdict === 'unknown') {
          await this.serial(projectId, () =>
            this.store.markStale(projectId, [m.id], 'its folder could not be found'),
          );
          return;
        }
      }
    } catch (e) {
      if (signal.aborted || e instanceof CancelledError) throw e;
      await this.serial(projectId, () =>
        this.store.markStale(projectId, [m.id], `its folder could not be read: ${errorText(e)}`),
      );
      return;
    }
    await this.serial(projectId, () => {
      const ctx = this.ctx(projectId, pass.kind, pass);
      for (const a of chain) {
        if (this.store.applyObservation(ctx, a.obs, a.t) === 'added')
          this.store.bumpPass(pass.id, { added: 1 });
      }
      const out = this.store.applyObservation(ctx, obs, r.t);
      if (out === 'added') this.store.bumpPass(pass.id, { added: 1 });
      if (obs.type === FOLDER_TYPE && this.store.folder(projectId, obs.id)) {
        // Found elsewhere than expected: its contents are listed too.
        this.store.enqueueWalk(pass.id, projectId, obs.id);
      }
    });
  }

  /**
   * The folders above an observation that the model does not hold, read one by one (getAsset) until a stored folder or
   * the root is reached; top first. `unknown` when the chain is too deep or a folder cannot be found.
   */
  private async ancestry(
    projectId: string,
    obs: AssetObservation,
    o: ReadOptions,
  ): Promise<{ verdict: 'known' | 'unknown'; ancestors: { obs: AssetObservation; t: number }[] }> {
    const chain: { obs: AssetObservation; t: number }[] = [];
    let parent = obs.folderId;
    const seen = new Set<string>([obs.id]);
    for (let i = 0; i < 64; i++) {
      if (parent === null || this.store.folder(projectId, parent)) {
        return { verdict: 'known', ancestors: chain.reverse() };
      }
      if (seen.has(parent)) break;
      seen.add(parent);
      const r = await this.read(projectId, 'getAsset', { path: { assetId: parent } }, o);
      const p = r.gone ? null : observationFromAsset(r.value);
      if (!p || p.type !== FOLDER_TYPE) break;
      chain.push({ obs: p, t: r.t });
      parent = p.folderId;
    }
    return { verdict: 'unknown', ancestors: [] };
  }

  private nameOf(projectId: string, id: string): string | null {
    return this.store.folder(projectId, id)?.name ?? this.store.item(projectId, id)?.name ?? null;
  }

  private async finishPass(pass: AssetPassView): Promise<void> {
    const projectId = pass.projectId;
    const T = pass.snapshotAt ?? this.o.clock.now();
    let audited = '';
    await this.serial(projectId, () => {
      this.store.setConfirmed(projectId, T, pass.kind);
      // Failed re-reads last tried before T are settled: the pass observed everything they would have.
      for (const row of this.store.pending(projectId)) {
        if (row.status === 'retry' && row.attempted_at !== null && row.attempted_at < T) {
          this.store.deletePending(row.id);
        }
      }
      if (pass.kind === 'check') {
        // The check also audits the model itself: cached paths agree with the parent links.
        const a = this.store.audit(projectId);
        for (const id of a.fixedPaths) {
          this.store.insertLog({
            projectId,
            source: 'check',
            passId: pass.id,
            itemId: id,
            itemName: this.store.folder(projectId, id)?.name ?? null,
            itemKind: 'folder',
            change: 'updated',
            field: 'path',
            oldValue: null,
            newValue: null,
            detail: 'the cached path disagreed with the parent links and was recomputed',
          });
        }
        if (a.fixedPaths.length > 0)
          audited += `${a.fixedPaths.length} cached path${a.fixedPaths.length === 1 ? '' : 's'} recomputed`;
        if (a.unreachable.length > 0) {
          audited += `${audited ? '; ' : ''}${a.unreachable.length} folder${a.unreachable.length === 1 ? ' is' : 's are'} not reachable from the root`;
        }
      }
    });
    if (pass.kind !== 'build')
      this.store.updatePass(pass.id, { corrected: this.store.correctedRows(pass.id) });
    const done = this.store.pass(pass.id)!;
    const counts = this.store.counts(projectId);
    const failedNote = done.foldersFailed
      ? `, ${done.foldersFailed} folder${done.foldersFailed === 1 ? '' : 's'} could not be listed (stale)`
      : '';
    const summary =
      pass.kind === 'build'
        ? `Built the asset tree: ${counts.folders} folders and ${counts.assets} assets${failedNote}; ${done.requests} requests.`
        : `${pass.kind === 'refresh' ? 'Refresh' : 'Check'}: ${done.added} added, ${done.removed} removed, ${done.corrected} corrected` +
          `${failedNote}${audited ? `; ${audited}` : ''}; ${done.requests} requests.`;
    this.store.updatePass(pass.id, { status: 'succeeded', summary, finishedAt: this.o.clock.now() });
    this.store.clearListing(pass.id);
    this.store.prune(projectId);
    if (pass.kind === 'build') this.recordPassJob(this.store.pass(pass.id)!);
    this.scheduleRetries(0);
  }

  /** A finished build is recorded as a job of its project (the Jobs page); refreshes and checks are maintenance runs. */
  private recordPassJob(pass: AssetPassView): void {
    try {
      const r = this.o.engine.recordResult({
        project: pass.projectId,
        opId: 'assets:build',
        params: {},
        value: {
          pass: pass.id,
          status: pass.status,
          summary: pass.summary,
          error: pass.error,
          requests: pass.requests,
        },
        origin: { kind: 'system', client: 'assets', tool: 'asset-build', detail: 'Asset tree build' },
        title: 'Asset tree: build',
        priority: 'P3',
        ...(pass.status === 'failed'
          ? { failure: { code: 'ASSET_BUILD_FAILED', message: pass.error ?? 'The build failed.' } }
          : {}),
      });
      this.store.updatePass(pass.id, { jobId: r.jobId });
    } catch (e) {
      this.o.log?.warn({ err: e, passId: pass.id }, 'could not record an asset tree build as a job');
    }
  }

  // ============================================================================================ after writes

  /** Whether the model is being kept for a project: it has been built, or a build is under way. */
  private following(projectId: string): boolean {
    return this.store.state(projectId)?.built_at != null || this.store.activePass(projectId) !== undefined;
  }

  private beforeWrite(info: WriteStepInfo): void {
    if (!ASSET_OPS[info.opId]) return;
    if (!this.following(info.projectId)) return;
    if (this.store.pendingForStep(info.projectId, info.jobId, info.stepNo)) return; // recovering after a restart
    this.store.insertPending({
      projectId: info.projectId,
      jobId: info.jobId,
      stepNo: info.stepNo,
      op: info.opId,
      assetIds: targetIds(info.opId, info.params, undefined),
      flags: flagsOf(info.opId, info.params),
    });
  }

  private async afterWrite(r: WriteStepResult): Promise<void> {
    if (!ASSET_OPS[r.opId]) return;
    const pending = this.store.pendingForStep(r.projectId, r.jobId, r.stepNo);
    if (r.outcome === 'failed' && !r.uncertain) {
      // Nothing changed at LegendKeeper: nothing to re-read.
      if (pending) this.store.deletePending(pending.id);
      return;
    }
    const ids = targetIds(r.opId, r.params, r.value);
    // While the job re-reads, the retry loop leaves this step's row alone (it would re-read the same thing).
    if (pending) this.rereading.add(pending.id);
    try {
      const ok = await this.reread(r.projectId, r.opId, ids, flagsOf(r.opId, r.params), {
        priority: r.priority,
        jobId: r.jobId,
        signal: r.signal,
        waitForBudget: false,
        pendingId: pending?.id ?? null,
      });
      if (ok && pending) {
        for (const p of this.store.pending(r.projectId)) {
          if (p.job_id === r.jobId && p.step_no === r.stepNo) this.store.deletePending(p.id);
        }
      }
    } finally {
      if (pending) {
        this.rereading.delete(pending.id);
        this.scheduleRetries(RETRY_FIRST_MS); // a failed re-read is now the retry loop's
      }
    }
  }

  /**
   * Re-reads what a write affected and updates the model from what LegendKeeper answers (never from the request).
   * A create whose response gave no id (an uncertain outcome) lists the folder it was put in instead. Returns false
   * when a read failed (or was interrupted): the rows concerned are marked stale, the failure is logged and the
   * pending row is kept for a retry.
   */
  private async reread(
    projectId: string,
    op: string,
    ids: readonly string[],
    flags: RereadFlags,
    o: {
      priority: PriorityClass;
      jobId?: string;
      signal?: AbortSignal;
      waitForBudget: boolean;
      pendingId: number | null;
    },
  ): Promise<boolean> {
    if (!this.following(projectId)) return true; // nothing stored to keep current
    const kind = ASSET_OPS[op] ?? 'update';
    const attemptedAt = this.stamp();
    const ctx = this.ctx(projectId, 'write');
    const ro: ReadOptions = { ...o, waitForProject: false };
    const failures: { id: string; error: string }[] = [];
    const fail = (id: string, e: unknown, what = '') =>
      failures.push({
        id,
        error: o.signal?.aborted ? 'the re-read was interrupted' : `${what}${errorText(e)}`,
      });
    try {
      for (const id of ids) {
        let r: ReadResult;
        let chain: { obs: AssetObservation; t: number }[] = [];
        let obs: AssetObservation | null = null;
        try {
          r = await this.read(projectId, 'getAsset', { path: { assetId: id } }, ro);
          obs = r.gone ? null : observationFromAsset(r.value);
          if (obs && obs.folderId !== null && !this.store.folder(projectId, obs.folderId)) {
            const a = await this.ancestry(projectId, obs, ro);
            if (a.verdict === 'unknown') {
              fail(id, new Error('its folder could not be found'));
              continue;
            }
            chain = a.ancestors;
          }
        } catch (e) {
          fail(id, e);
          continue;
        }
        await this.serial(projectId, () => {
          if (r.gone) {
            this.store.applyGone(ctx, id, r.t, kind === 'delete' ? 'deleted' : 'not found when re-read');
            return;
          }
          if (!obs) return;
          for (const a of chain) this.store.applyObservation(ctx, a.obs, a.t);
          this.store.applyObservation(ctx, obs, r.t);
        });
      }
      if (ids.length === 0 && kind === 'create' && flags.parentId !== undefined) {
        // An uncertain create: the response gave no id, so the folder it was put in is listed and applied.
        const parent = flags.parentId;
        try {
          await this.listLevel(projectId, parent, ro, ctx);
        } catch (e) {
          fail(parent ?? 'root', e, 'the folder it was put in could not be listed: ');
        }
      }
    } catch (e) {
      // Anything unexpected is a failed re-read too: never silently wrong.
      fail(ids[0] ?? 'unknown', e);
    }
    if (failures.length === 0) return true;
    await this.serial(projectId, () => {
      const reason = `a re-read after ${op} failed: ${failures[0]!.error}`;
      this.store.markStale(
        projectId,
        failures.map((f) => f.id),
        reason,
      );
      for (const f of failures) {
        this.store.insertLog({
          projectId,
          source: 'write',
          passId: null,
          itemId: f.id,
          itemName: this.nameOf(projectId, f.id),
          itemKind: this.store.has(projectId, f.id) === 'asset' ? 'asset' : 'folder',
          change: 'reread_failed',
          field: null,
          oldValue: null,
          newValue: null,
          detail: `after ${op}${o.jobId ? ` (job ${o.jobId})` : ''}: ${f.error}`,
        });
      }
      const row =
        o.pendingId !== null
          ? o.pendingId
          : this.store.insertPending({
              projectId,
              jobId: o.jobId ?? null,
              stepNo: null,
              op,
              assetIds: ids,
              flags: { ...flags },
            });
      const attempts = this.store.pending(projectId).find((p) => p.id === row)?.attempts ?? 0;
      this.store.failPending(
        row,
        reason,
        this.o.clock.now() + Math.min(RETRY_FIRST_MS * 2 ** attempts, RETRY_MAX_MS),
        attemptedAt,
      );
    });
    this.scheduleRetries(RETRY_FIRST_MS);
    return false;
  }

  /** Lists one folder level (paged) and applies every item found; nothing is removed. */
  private async listLevel(
    projectId: string,
    folderId: string | null,
    ro: ReadOptions,
    ctx: ApplyContext,
  ): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const r = await this.read(
        projectId,
        'listAssets',
        {
          query: {
            limit: this.pageSize,
            ...(folderId !== null ? { folderId } : {}),
            ...(cursor ? { cursor } : {}),
          },
        },
        ro,
      );
      if (r.gone) return;
      const page = (r.value ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      const items = (Array.isArray(page.data) ? page.data : [])
        .map(observationFromAsset)
        .filter((x): x is AssetObservation => x !== null);
      await this.serial(projectId, () => {
        for (const o of items) this.store.applyObservation(ctx, { ...o, folderId }, r.t);
      });
      if (page.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor !== '') {
        cursor = page.nextCursor;
      } else return;
    }
  }

  // ============================================================================================ v3 F7: live reads

  /**
   * v3 F7 (ADR 0070, G9): a folder and its subfolders (to `depth` levels; default 3) read LIVE, at the caller's priority
   * (P1 by default: an agent's own request), before anything is decided from them. Every item listed is applied; an item
   * the model holds under a listed folder that the listing no longer shows is confirmed with a getAsset (a 404 removes
   * it; an answer is applied where it now is). A folder whose listing answers 404 is confirmed the same way. Returns the
   * requests made, and `ok: false` with the error when a read failed (the model is then left as it was for that folder).
   */
  async refreshFolder(
    projectId: string,
    folderId: string,
    o: { depth?: number; priority?: PriorityClass; jobId?: string } = {},
  ): Promise<{ ok: boolean; requests: number; error?: string }> {
    const ro: ReadOptions = {
      priority: o.priority ?? 'P1',
      waitForBudget: false,
      waitForProject: false,
      ...(o.jobId !== undefined ? { jobId: o.jobId } : {}),
    };
    const ctx = this.ctx(projectId, 'refresh');
    let requests = 0;
    const queue: { id: string; depth: number }[] = [{ id: folderId, depth: 0 }];
    const maxDepth = o.depth ?? 3;
    try {
      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        const seen: AssetObservation[] = [];
        let cursor: string | null = null;
        let gone = false;
        for (;;) {
          const r = await this.read(
            projectId,
            'listAssets',
            { query: { limit: this.pageSize, folderId: id, ...(cursor ? { cursor } : {}) } },
            ro,
          );
          requests++;
          if (r.gone) {
            gone = true;
            break;
          }
          const page = (r.value ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
          const items = (Array.isArray(page.data) ? page.data : [])
            .map(observationFromAsset)
            .filter((x): x is AssetObservation => x !== null)
            .map((x) => ({ ...x, folderId: id }));
          seen.push(...items);
          await this.serial(projectId, () => {
            for (const it of items) this.store.applyObservation(ctx, it, r.t);
          });
          if (page.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor !== '')
            cursor = page.nextCursor;
          else break;
        }
        const listed = new Set(seen.map((x) => x.id));
        const held = this.store.children(projectId, id);
        const missing = gone
          ? [id]
          : [...held.folders.map((f) => f.id), ...held.items.map((i) => i.id)].filter((x) => !listed.has(x));
        for (const m of missing) {
          const r = await this.read(projectId, 'getAsset', { path: { assetId: m } }, ro);
          requests++;
          await this.serial(projectId, () => {
            if (r.gone) {
              this.store.applyGone(ctx, m, r.t, 'not found when read live');
              return;
            }
            const obs = observationFromAsset(r.value);
            if (obs && (obs.folderId === null || this.store.folder(projectId, obs.folderId)))
              this.store.applyObservation(ctx, obs, r.t);
          });
        }
        if (gone) continue;
        if (depth + 1 < maxDepth)
          for (const f of seen) if (f.type === FOLDER_TYPE) queue.push({ id: f.id, depth: depth + 1 });
      }
      return { ok: true, requests };
    } catch (e) {
      return { ok: false, requests, error: errorText(e) };
    }
  }

  /**
   * v3 F7 (ADR 0070, G11): image URLs checked against the model, with ONE live refresh for those it does not hold: the
   * re-reads owed after the bridge's own writes are made now, then each missing URL's asset is read by the id its file
   * name gives (`<projectId>_<uuid>.webp` or the older `<uuid>.webp`: the uuid, and the whole name) and kept only when
   * LegendKeeper answers with exactly that `url`. Returns the URLs that are assets of this project.
   */
  async checkUrls(
    projectId: string,
    urls: readonly string[],
    o: { priority?: PriorityClass } = {},
  ): Promise<{ known: Set<string>; refreshed: boolean; requests: number }> {
    const known = new Set<string>();
    const misses: string[] = [];
    for (const u of new Set(urls)) {
      if (this.queries.assetByUrl(projectId, u).data) known.add(u);
      else misses.push(u);
    }
    if (misses.length === 0) return { known, refreshed: false, requests: 0 };
    const ro: ReadOptions = { priority: o.priority ?? 'P1', waitForBudget: false, waitForProject: false };
    const ctx = this.ctx(projectId, 'refresh');
    let requests = 0;
    try {
      await this.processPending();
    } catch {
      // owed re-reads are retried by their own loop; the reads below still run
    }
    for (const u of misses) {
      if (this.queries.assetByUrl(projectId, u).data) {
        known.add(u);
        continue;
      }
      for (const id of assetIdsFromUrl(u)) {
        let r: ReadResult;
        try {
          r = await this.read(projectId, 'getAsset', { path: { assetId: id } }, ro);
        } catch {
          break;
        }
        requests++;
        if (r.gone) continue;
        const obs = observationFromAsset(r.value);
        if (!obs || obs.url !== u) continue;
        await this.serial(projectId, () => {
          if (obs.folderId === null || this.store.folder(projectId, obs.folderId))
            this.store.applyObservation(ctx, obs, r.t);
        });
        known.add(u);
        break;
      }
    }
    return { known, refreshed: true, requests };
  }

  // ============================================================================================ retries

  /**
   * Arms one timer for the re-reads that are owed (failed ones at their retry time; leftovers from a crash now). Rows
   * of a project that is not served now are left until it is (`projectServed` arms the timer again).
   */
  private scheduleRetries(delayMs: number): void {
    if (!this.started || this.stopped || this.retriesStopped) return;
    if (this.retryTimer) this.o.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const now = this.o.clock.now();
    let at = Number.POSITIVE_INFINITY;
    for (const r of this.store.pending()) {
      if (!this.o.projects.client(r.project_id) || this.rereading.has(r.id)) continue;
      at = Math.min(at, r.status === 'retry' ? Math.max(r.next_at ?? now, now + 1000) : now + delayMs);
    }
    if (!Number.isFinite(at)) return;
    this.retryTimer = this.o.clock.setTimeout(
      () => {
        this.retryTimer = null;
        this.track(this.processPending());
      },
      Math.max(0, at - now),
    );
  }

  /**
   * Re-reads owed: failed ones whose time has come, and rows left `in_flight` whose step has finished (a crash or a
   * stop between the write and its re-read). Rows whose step has not finished, or whose job is re-reading them now,
   * are left to the engine. One run at a time.
   */
  async processPending(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = this.o.clock.now();
      for (const row of this.store.pending()) {
        if (this.stopped || this.retriesStopped) return;
        if (!this.o.projects.client(row.project_id) || this.rereading.has(row.id)) continue;
        if (row.status === 'retry' && (row.next_at ?? 0) > now) continue;
        if (row.status === 'in_flight') {
          const state = this.stepState(row.project_id, row.job_id, row.step_no);
          if (state === 'open') continue;
          if (state === 'not_applied') {
            this.store.deletePending(row.id);
            continue;
          }
        }
        const ids = parseIds(row.asset_ids);
        const flags = parseFlags(row.flags);
        this.rereading.add(row.id);
        try {
          const ok = await this.reread(row.project_id, row.op, ids, flags, {
            priority: 'P3',
            signal: this.stopAll.signal,
            waitForBudget: true,
            pendingId: row.id,
            ...(row.job_id ? { jobId: row.job_id } : {}),
          });
          if (ok) this.store.deletePending(row.id);
        } catch (e) {
          this.o.log?.warn({ err: e, pending: row.id }, 'an asset tree re-read failed');
        } finally {
          this.rereading.delete(row.id);
        }
      }
    } finally {
      this.processing = false;
    }
    this.scheduleRetries(RETRY_FIRST_MS);
  }

  /** Whether a write step has finished: `open` (the engine will report it), `not_applied`, or `done`. */
  private stepState(
    projectId: string,
    jobId: string | null,
    stepNo: number | null,
  ): 'open' | 'not_applied' | 'done' {
    if (!jobId || stepNo === null) return 'done';
    let step: { status: string } | undefined;
    try {
      step = this.o.engine.queries.getJob(projectId, jobId)?.steps.find((s) => s.stepNo === stepNo);
    } catch {
      return 'done';
    }
    if (!step) return 'done';
    if (step.status === 'pending' || step.status === 'running') return 'open';
    if (step.status === 'cancelled' || step.status === 'failed') return 'not_applied';
    return 'done'; // succeeded or uncertain
  }

  // ============================================================================================ helpers

  /**
   * An observation stamp: the clock in milliseconds, made strictly increasing (a stamp is never handed out twice, and
   * never goes back, even across a restart: it starts above every stamp already stored). Every read is stamped just
   * before it is sent, and a folder listing's likewise, so "observed later" is a strict order with no ties.
   */
  private stamp(): number {
    if (this.lastStamp === 0) this.lastStamp = this.store.maxStamp();
    this.lastStamp = Math.max(this.o.clock.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  private ctx(projectId: string, by: AssetReadBy, pass?: AssetPassView): ApplyContext {
    return {
      projectId,
      by,
      ...(pass && pass.kind !== 'build' ? { log: { source: pass.kind, passId: pass.id } } : {}),
    };
  }

  /** Runs `fn` after every earlier change to the same project's model. */
  private serial<T>(projectId: string, fn: () => T): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(projectId, tail);
    void tail.then(() => {
      if (this.chains.get(projectId) === tail) this.chains.delete(projectId);
    });
    return next;
  }

  private track(p: Promise<unknown>): void {
    this.background.add(p);
    const done = () => this.background.delete(p);
    p.then(done, done);
  }

  /**
   * One governed read (the engine's `internalRead`, the project's governor). A 404 is an answer (`gone`). With
   * `waitForBudget`, an exhausted budget is waited out on the clock instead of failing.
   */
  private async read(projectId: string, op: string, params: OpParams, o: ReadOptions): Promise<ReadResult> {
    for (;;) {
      if (o.signal?.aborted) throw new CancelledError();
      const t = this.stamp(); // the observation stamp: unique and increasing
      try {
        const value = await this.o.engine.internalRead(projectId, op, params, {
          priority: o.priority,
          notFoundIsAnswer: true,
          ...(o.jobId !== undefined ? { jobId: o.jobId } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
        });
        if (o.passId) this.store.bumpPass(o.passId, { requests: 1 });
        return { gone: false, value, t };
      } catch (e) {
        if (e instanceof LkOperationError) {
          if (o.passId) this.store.bumpPass(o.passId, { requests: 1 });
          if (e.status === 404 || e.lkCode === 'NOT_FOUND') return { gone: true, value: undefined, t };
        }
        if (e instanceof BudgetExhaustedError && o.waitForBudget) {
          await sleep(this.o.clock, Math.max(1000, e.retryAtMs - this.o.clock.now()), o.signal);
          continue;
        }
        if (e instanceof JobsError && e.code === 'PROJECT_UNAVAILABLE' && o.waitForProject === true) {
          // The project is not served for now (its key is being checked again): a build waits for it. A refresh,
          // check or retry fails instead, so nothing stays stuck behind it.
          await sleep(this.o.clock, 15_000, o.signal);
          continue;
        }
        throw e;
      }
    }
  }
}

/**
 * v3 F7 (G11): the asset ids an image URL may name: its file name without the extension, and the part after the project
 * prefix (`<projectId>_<uuid>.webp`); none for a URL off LegendKeeper's asset hosts' pattern.
 */
export function assetIdsFromUrl(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (u.protocol !== 'https:') return [];
  const file = decodeURIComponent(u.pathname.split('/').pop() ?? '');
  const stem = file.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  if (!stem || !/^[A-Za-z0-9_-]{1,200}$/.test(stem)) return [];
  const out = new Set<string>();
  const us = stem.lastIndexOf('_');
  if (us > 0 && us < stem.length - 1) out.add(stem.slice(us + 1));
  out.add(stem);
  return [...out];
}

function newPassId(kind: AssetPassKind): string {
  return `ap_${kind}_${randomBytes(8).toString('hex')}`;
}

function errorText(e: unknown): string {
  if (e instanceof JobsError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** A failure that every further request would repeat (credentials, plan, the project): the pass fails at once. */
function isFatalForPass(e: unknown): boolean {
  if (e instanceof LkOperationError) return e.status === 401 || e.status === 402 || e.status === 403;
  return e instanceof JobsError && (e.code === 'PROJECT_UNAVAILABLE' || e.code === 'UNKNOWN_PROJECT');
}

/** The assets a write affects: its path's asset, or (a create) the id LegendKeeper's response gave. */
function targetIds(op: string, params: OpParams, value: unknown): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v !== '') out.add(v);
  };
  if (ASSET_OPS[op] === 'create') add((value as Record<string, unknown> | undefined)?.id);
  else add((params.path as Record<string, unknown> | undefined)?.assetId);
  return [...out];
}

function flagsOf(op: string, params: OpParams): RereadFlags {
  if (ASSET_OPS[op] !== 'create') return {};
  const body = (params.body ?? {}) as Record<string, unknown>;
  return { parentId: typeof body.folderId === 'string' && body.folderId !== '' ? body.folderId : null };
}

function parseIds(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseFlags(text: string): RereadFlags {
  try {
    const v = JSON.parse(text) as RereadFlags;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clock.clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAssets(o: AssetServiceOptions): AssetService {
  return new AssetService(o);
}
