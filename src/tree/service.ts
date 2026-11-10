/**
 * The repository tree service (v2 A2, docs/tree.md, ADR 0025): the bridge's own model of each project's AI REPOSITORY.
 *
 * - **First build** (`prepareBuild` → `confirmBuild`): lists every resource (paged), shows an estimate, then reads each
 *   node under the root with getResource, at P3. Progress is persisted; a restart continues where it stopped.
 * - **After the bridge's own writes** (a write observer on the job engine): every operation that can change what the
 *   tree holds is followed, in the same job, by a getResource of the affected resource(s); the tree is updated from
 *   what LegendKeeper answers, never from the request. A re-read that fails leaves the node stale and is retried.
 * - **Structural sweep** (hourly maintenance job) and **daily consistency check** (nightly maintenance job): a listing
 *   reconciles structure; the sweep reads properties only of new and stale nodes, the check of every node. What they
 *   correct is written to the correction log.
 * - **Concurrency**: every change to a project's tree goes through one queue per project, and an observation never
 *   replaces one made later (see store.ts), so a sweep never undoes a newer after-write update.
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
import {
  catalogueSettingsKey,
  observationFromListItem,
  observationFromResource,
  treeSettingsFrom,
  type TreeSettings,
} from './classify.js';
import { TreeStore, type ApplyContext, type PendingRow } from './store.js';
import { TreeQueries } from './queries.js';
import {
  ACTIVE_PASS_STATUSES,
  type BuildEstimate,
  type Observation,
  type PassKind,
  type PassView,
  type ReadBy,
  type RootSuggestion,
  type TreeMeta,
  type TreeStatus,
} from './types.js';

export interface TreeLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TreeServiceOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly projects: ProjectsRuntime;
  readonly clock: Clock;
  readonly log?: TreeLogger;
  /** A tree not confirmed by a completed pass for this long is `stale` (default 26 hours: the daily check, plus slack). */
  readonly staleAfterMs?: number;
  /** listResources page size (default 100, the API's maximum). */
  readonly pageSize?: number;
  /** getResource reads a pass keeps in flight at once (default 4; the governor still paces them). */
  readonly readConcurrency?: number;
  /**
   * Look for an unconfigured project's AI REPOSITORY root by itself the first time the owner opens its Repository Tree
   * page (one listing, P3). Default true.
   */
  readonly autoSuggestRoot?: boolean;
}

/** Operations whose success can change what the tree holds, and what the tree does after each. */
const TREE_OPS: Readonly<Record<string, 'create' | 'update' | 'move' | 'delete' | 'restore'>> = {
  createResource: 'create',
  createManyResources: 'create',
  createResourceFromTemplate: 'create',
  updateResource: 'update',
  moveResource: 'move',
  deleteResource: 'delete',
  restoreResource: 'restore',
  createProperty: 'update',
  updateProperty: 'update',
  deleteProperty: 'update',
  createPropertyRow: 'update',
  updatePropertyRow: 'update',
  deletePropertyRow: 'update',
  createDocument: 'update',
  updateDocument: 'update',
  deleteDocument: 'update',
  restoreDocument: 'update',
};

/** The operations the tree follows (documented in docs/tree.md; tests check each). */
export const TREE_FOLLOWED_OPS: readonly string[] = Object.keys(TREE_OPS);

interface RereadFlags {
  includeChildren?: boolean;
  [k: string]: unknown;
}

/** A pass that cannot go on (the root vanished, the project is gone): ends the pass as failed. */
class PassError extends Error {}

const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
const READ_BATCH = 25;

export class TreeService {
  readonly store: TreeStore;
  readonly queries: TreeQueries;
  private readonly projectStore: ProjectStore;
  private readonly staleAfterMs: number;
  private readonly pageSize: number;
  private readonly concurrency: number;
  /** One queue per project: every change to its tree runs in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Running passes, by pass id. */
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly catalogueKeys = new Map<string, string>();
  private retryTimer: ReturnType<Clock['setTimeout']> | null = null;
  private stopAll = new AbortController();
  private started = false;
  private stopped = false;
  private detach: (() => void) | null = null;
  /** The last observation stamp handed out (see `stamp`). */
  private lastStamp = 0;
  private offProjects: (() => void) | null = null;
  private readonly suggesting = new Set<string>();
  /** Owed re-reads being done right now (by their job, or by the retry loop). */
  private readonly rereading = new Set<number>();
  private processing = false;
  /** Set by `stopPasses` during shutdown: no new retries or passes; writes are still followed. */
  private retriesStopped = false;
  /** v2 A3: told when a pass completes (the registry's taxonomy drift report follows the daily check). */
  private readonly passListeners = new Set<(pass: PassView) => void>();

  constructor(private readonly o: TreeServiceOptions) {
    const now = () => o.clock.now();
    this.store = new TreeStore(o.db, now);
    this.projectStore = new ProjectStore(o.db, now);
    this.staleAfterMs = o.staleAfterMs ?? 26 * 3_600_000;
    this.pageSize = o.pageSize ?? 100;
    this.concurrency = Math.max(1, o.readConcurrency ?? 4);
    this.queries = new TreeQueries(this.store, (p) => this.meta(p));
  }

  // ============================================================================================ lifecycle

  /** Follows the engine's writes (the after-write updates). Returns a detach function. */
  attach(): () => void {
    this.detach?.();
    const off = this.o.engine.observeWrites({
      beforeWrite: (info) => this.beforeWrite(info),
      afterWrite: (r) => this.afterWrite(r),
      flushDeferred: (info) => this.flushDeferred(info),
    });
    this.detach = off;
    return () => {
      off();
      if (this.detach === off) this.detach = null;
    };
  }

  /**
   * Resumes builds a restart interrupted, marks interrupted sweeps and checks, and catches up re-reads owed by writes
   * that finished while the process was down.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.retriesStopped = false;
    this.stopAll = new AbortController();
    for (const p of this.store.activePasses()) {
      if (p.kind === 'build') {
        // A build resumes once its project is served (at start-up the keys are still being checked).
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
   * The root suggestion, made by itself the first time the owner looks at an unconfigured project's tree (one listing
   * at P3, in the background; never at start-up, so nothing is read before anyone asks). Stored, and never applied.
   */
  private maybeSuggest(projectId: string): void {
    if (
      this.o.autoSuggestRoot === false ||
      !this.started ||
      this.stopped ||
      this.suggesting.has(projectId) ||
      this.settings(projectId).rootId ||
      this.store.suggestion(projectId) ||
      !this.o.projects.client(projectId)
    ) {
      return;
    }
    this.track(this.suggestRoot(projectId).catch(() => undefined));
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

  /** Stops passes (a build resumes at the next start), retries and background work, and stops following writes. */
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

  /**
   * v2 A3: calls `fn` with each pass that completes successfully (build, sweep or check), after the tree is updated
   * and the pass recorded. A listener that throws is logged and never fails the pass. Returns an unsubscribe function.
   */
  onPassFinished(fn: (pass: PassView) => void): () => void {
    this.passListeners.add(fn);
    return () => this.passListeners.delete(fn);
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

  /** The tree settings of a project, read from the database each time (the CLI may change them while running). */
  settings(projectId: string): TreeSettings {
    return treeSettingsFrom(this.projectStore.byId(projectId)?.settings ?? {});
  }

  /**
   * What every query states: the tree's status and when it was last confirmed. Brings the stored tree in line with
   * the root setting first (a changed root discards the old tree).
   */
  meta(projectId: string): TreeMeta {
    const s = this.settings(projectId);
    const base = {
      projectId,
      rootId: s.rootId,
      confirmedAt: null,
      confirmedBy: null,
      staleNodes: 0,
      pendingRereads: 0,
    };
    if (!s.rootId) {
      return {
        ...base,
        status: 'not_configured',
        reason: 'No AI REPOSITORY root is set for this project, so the tree does nothing.',
      };
    }
    this.syncSettings(projectId, s);
    const state = this.store.state(projectId);
    const active = this.store.activePass(projectId);
    const staleNodes = this.store.staleCount(projectId);
    const pendingRereads = this.store.pendingCount(projectId);
    const failed = this.store.failedPendingCount(projectId);
    const filled = {
      ...base,
      confirmedAt: state?.confirmed_at ?? null,
      confirmedBy: state?.confirmed_by ?? null,
      staleNodes,
      pendingRereads,
    };
    let status: TreeStatus;
    let reason: string | null = null;
    if (active?.kind === 'build' && active.status !== 'awaiting_confirmation') {
      status = 'building';
      reason =
        active.status === 'listing'
          ? `Building: listing the project's resources (${active.listed} so far).`
          : `Building: reading each page's properties (${active.readOk + active.readFailed} of ${active.toRead ?? '?'}).`;
    } else if (!state?.built_at) {
      status = 'not_built';
      reason =
        active?.status === 'awaiting_confirmation'
          ? 'The first build is listed and waiting for you to confirm its estimate (Repository Tree page).'
          : 'The first build has not run yet: start it on the Repository Tree page.';
    } else if (staleNodes > 0) {
      status = 'stale';
      reason = `${staleNodes} ${staleNodes === 1 ? 'node' : 'nodes'} could not be confirmed (a re-read failed, or its place is unknown); the next sweep or check settles them.`;
    } else if (failed > 0) {
      status = 'stale';
      reason = `${failed} re-read${failed === 1 ? '' : 's'} after the bridge's own writes failed; retried, and settled by the next sweep.`;
    } else if (state.confirmed_at === null || state.confirmed_at < this.o.clock.now() - this.staleAfterMs) {
      status = 'stale';
      reason = `No sweep or check has confirmed the tree for ${Math.round(this.staleAfterMs / 3_600_000)} hours.`;
    } else {
      status = 'ready';
    }
    return { ...filled, status, reason };
  }

  /** A changed root discards the tree; changed property or row names re-derive the catalogue fields (no reads). */
  private syncSettings(projectId: string, s: TreeSettings): void {
    if (this.store.ensureRoot(projectId, s.rootId)) {
      this.o.log?.info?.(
        { projectId, rootId: s.rootId },
        'the AI REPOSITORY root changed: the tree was discarded',
      );
    }
    // The names the catalogue fields were derived with are stored with the tree, so a change made while the bridge
    // was stopped (the CLI) is caught too.
    const key = catalogueSettingsKey(s);
    if (this.catalogueKeys.get(projectId) === key) return;
    const stored = this.store.state(projectId)?.catalogue_key ?? null;
    if (stored !== key) {
      if (stored !== null || this.store.count(projectId) > 0) this.store.recomputeCatalogue(projectId, s);
      this.store.setCatalogueKey(projectId, key);
    }
    this.catalogueKeys.set(projectId, key);
  }

  /** Called after an owner changed a project setting (dashboard or CLI picked up on the next query). */
  onSettingsChanged(projectId: string): void {
    this.meta(projectId);
  }

  /**
   * Everything the dashboard's Repository Tree page shows for one project: status, counts by kind, depth, the
   * unclassified and stale nodes, the running pass's progress, the last build, sweep and check, failed re-reads, and
   * the root suggestion.
   */
  overview(projectId: string) {
    const meta = this.meta(projectId);
    if (meta.status === 'not_configured') this.maybeSuggest(projectId);
    const settings = this.settings(projectId);
    const counts = this.queries.counts(projectId).data;
    const configured = meta.status !== 'not_configured';
    const pending = this.store.pending(projectId);
    return {
      tree: meta,
      settings,
      counts,
      unclassified: configured ? this.queries.unclassified(projectId, { limit: 200 }).data : [],
      staleNodes: configured ? this.queries.stale(projectId, 100).data : [],
      activePass: this.store.activePass(projectId) ?? null,
      lastBuild: this.store.lastPass(projectId, 'build') ?? null,
      lastSweep: this.store.lastPass(projectId, 'sweep') ?? null,
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
            resourceIds: parseIds(p.resource_ids),
            attempts: p.attempts,
            lastError: p.last_error,
            nextAt: p.next_at,
            createdAt: p.created_at,
          })),
      },
      suggestion: this.store.suggestion(projectId),
      suggesting: this.suggesting.has(projectId),
    };
  }

  // ============================================================================================ passes

  /**
   * Starts a build: it lists every resource at P3 and then waits on `awaiting_confirmation` with the estimate, unless
   * `autoConfirm`. A build already running or waiting is returned as it is.
   */
  prepareBuild(projectId: string, o: { trigger?: string; autoConfirm?: boolean } = {}): PassView {
    const meta = this.meta(projectId);
    if (meta.status === 'not_configured') {
      throw new TreeError('NOT_CONFIGURED', 'Set the AI REPOSITORY root of this project first.');
    }
    const active = this.store.activePass(projectId);
    if (active) {
      if (active.kind === 'build') return active;
      throw new TreeError('PASS_RUNNING', `A ${active.kind} is running; try again when it has finished.`);
    }
    const pass = this.store.createPass({
      id: newPassId('build'),
      projectId,
      kind: 'build',
      trigger: o.autoConfirm ? `${o.trigger ?? 'owner'}:confirmed` : (o.trigger ?? 'owner'),
      rootId: meta.rootId!,
    });
    this.launch(pass);
    return pass;
  }

  /** Confirms a build waiting on its estimate: it starts reading every node's properties. */
  confirmBuild(projectId: string): PassView {
    const active = this.store.activePass(projectId);
    if (!active || active.kind !== 'build' || active.status !== 'awaiting_confirmation') {
      throw new TreeError('NOTHING_TO_CONFIRM', 'No build is waiting for confirmation.');
    }
    this.store.updatePass(active.id, { status: 'reading' });
    const p = this.store.pass(active.id)!;
    this.launch(p, { reconcileFirst: true });
    return p;
  }

  /** Cancels a build (listing, waiting or reading). What it has stored stays; the tree is `not_built` or `stale`. */
  cancelBuild(projectId: string): PassView {
    const active = this.store.activePass(projectId);
    if (!active || active.kind !== 'build') throw new TreeError('NOTHING_TO_CANCEL', 'No build is running.');
    this.running.get(active.id)?.abort.abort(new CancelledError());
    this.store.updatePass(active.id, {
      status: 'cancelled',
      error: 'Cancelled by the owner.',
      finishedAt: this.o.clock.now(),
    });
    this.store.clearListing(active.id);
    return this.store.pass(active.id)!;
  }

  /** The hourly structural sweep of one project (a maintenance job). */
  async sweep(projectId: string, trigger = 'schedule'): Promise<PassOutcome> {
    if (!this.settings(projectId).sweepEnabled) {
      return { skipped: true, summary: 'Skipped: the hourly sweep is switched off for this project.' };
    }
    return this.runMaintenancePass(projectId, 'sweep', trigger);
  }

  /** The daily consistency check of one project (a maintenance job). */
  async check(projectId: string, trigger = 'schedule'): Promise<PassOutcome> {
    return this.runMaintenancePass(projectId, 'check', trigger);
  }

  private async runMaintenancePass(
    projectId: string,
    kind: 'sweep' | 'check',
    trigger: string,
  ): Promise<PassOutcome> {
    const meta = this.meta(projectId);
    if (meta.status === 'not_configured') {
      return { skipped: true, summary: 'Skipped: no AI REPOSITORY root is set for this project.' };
    }
    if (meta.status === 'not_built' || meta.status === 'building') {
      return {
        skipped: true,
        summary: `Skipped: the tree is ${meta.status === 'building' ? 'being built' : 'not built yet'}.`,
      };
    }
    const active = this.store.activePass(projectId);
    if (active) return { skipped: true, summary: `Skipped: a ${active.kind} is running.` };
    let pass: PassView;
    try {
      pass = this.store.createPass({ id: newPassId(kind), projectId, kind, trigger, rootId: meta.rootId! });
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

  private launch(pass: PassView, o: { reconcileFirst?: boolean } = {}): { done: Promise<void> } {
    const existing = this.running.get(pass.id);
    if (existing) return existing;
    if (this.retriesStopped || this.stopped) return { done: Promise.resolve() }; // shutting down: resumes at start
    const abort = new AbortController();
    const onStop = () => abort.abort(new CancelledError());
    this.stopAll.signal.addEventListener('abort', onStop, { once: true });
    const done = this.runPass(pass.id, abort.signal, o.reconcileFirst === true)
      .catch((e: unknown) => {
        this.o.log?.warn({ err: e, passId: pass.id }, 'a repository tree pass failed');
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
    return p !== undefined && ACTIVE_PASS_STATUSES.has(p.status);
  }

  private async runPass(passId: string, signal: AbortSignal, reconcileFirst: boolean): Promise<void> {
    let pass = this.store.pass(passId)!;
    const projectId = pass.projectId;
    try {
      if (pass.status === 'listing') {
        await this.listPhase(pass, signal);
        if (!this.stillActive(passId, signal)) return;
        pass = this.store.pass(passId)!;
        if (pass.kind === 'build' && !pass.trigger.endsWith(':confirmed')) {
          const estimate = this.estimate(pass);
          this.store.updatePass(passId, {
            status: 'awaiting_confirmation',
            estimate,
            subtree: estimate.subtree,
          });
          return;
        }
        reconcileFirst = true;
        this.store.updatePass(passId, { status: 'reading' });
      }
      // A listing still staged means its reconciliation has not completed (a restart can come between the two).
      if (reconcileFirst || this.hasListing(passId))
        await this.reconcilePhase(this.store.pass(passId)!, signal);
      if (!this.stillActive(passId, signal)) return;
      await this.readPhase(this.store.pass(passId)!, signal);
      if (!this.stillActive(passId, signal)) return;
      await this.finishPass(this.store.pass(passId)!);
    } catch (e) {
      if (signal.aborted || e instanceof CancelledError) return; // stopping: see finally
      // falls through to record the failure
      const message = e instanceof Error ? e.message : String(e);
      this.store.updatePass(passId, { status: 'failed', error: message, finishedAt: this.o.clock.now() });
      this.store.clearListing(passId);
      if (pass.kind === 'build') this.recordPassJob(this.store.pass(passId)!);
      if (!(e instanceof PassError)) {
        this.o.log?.warn({ err: e, passId, projectId }, 'a repository tree pass failed');
      }
    } finally {
      // Stopping: a build resumes at the next start; a sweep or check ends as interrupted (the next one starts afresh).
      const now = this.store.pass(passId);
      if (signal.aborted && now && now.kind !== 'build' && ACTIVE_PASS_STATUSES.has(now.status)) {
        this.store.updatePass(passId, {
          status: 'interrupted',
          error: 'The bridge stopped while this pass was running.',
          finishedAt: this.o.clock.now(),
        });
        this.store.clearListing(passId);
      }
    }
  }

  /** Lists every resource of the project (paged), into the pass's listing. Resumable from the stored cursor. */
  private async listPhase(pass: PassView, signal: AbortSignal): Promise<void> {
    const projectId = pass.projectId;
    let T = pass.snapshotAt;
    if (T === null) {
      T = this.stamp();
      this.store.updatePass(pass.id, { snapshotAt: T });
    }
    let cursor = this.store.passCursor(pass.id);
    let pages = pass.pages;
    let listed = pass.listed;
    for (;;) {
      if (!this.stillActive(pass.id, signal)) return;
      const query: Record<string, unknown> = { limit: this.pageSize, ...(cursor ? { cursor } : {}) };
      let page: unknown;
      try {
        page = (
          await this.read(
            projectId,
            'listResources',
            { query },
            {
              priority: 'P3',
              jobId: pass.id,
              signal,
              passId: pass.id,
              waitForBudget: true,
              waitForProject: pass.kind === 'build',
            },
          )
        ).value;
      } catch (e) {
        if (cursor && e instanceof LkOperationError && e.status === 400) {
          // The stored cursor no longer works (a long pause): list again from the start, with a new snapshot.
          T = this.stamp();
          this.store.clearListing(pass.id);
          this.store.updatePass(pass.id, { cursor: null, pages: 0, listed: 0, snapshotAt: T });
          cursor = null;
          pages = 0;
          listed = 0;
          continue;
        }
        throw e;
      }
      const p = (page ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      const items = (Array.isArray(p.data) ? p.data : [])
        .map(observationFromListItem)
        .filter((x): x is Observation => x !== null);
      const next =
        p.hasMore === true && typeof p.nextCursor === 'string' && p.nextCursor !== '' ? p.nextCursor : null;
      pages++;
      listed += items.length;
      const snapshot = T;
      this.o.db.transaction(() => {
        this.store.stage(pass.id, projectId, items, snapshot);
        this.store.updatePass(pass.id, { cursor: next, pages, listed });
      })();
      if (!next) return;
      cursor = next;
    }
  }

  /** The estimate shown before a build reads (bridge_estimate's arithmetic, at P3). */
  private estimate(pass: PassView): BuildEstimate {
    const subtree = this.listedSubtreeSize(pass);
    const gov = this.o.projects.anyClient(pass.projectId)?.governor;
    const e = gov?.estimate({ reads: subtree, writes: 0, createManyItems: 0, priority: 'P3' });
    return {
      listed: pass.listed,
      subtree,
      reads: subtree,
      listingRequests: pass.pages,
      wallClockMs: e?.wallClockMs ?? 0,
      fitsInDailyBudget: e?.fitsToday ?? true,
      tightestTier: e?.tightestTier ?? null,
      at: this.o.clock.now(),
    };
  }

  /** How many listed resources are under the root (the root included). */
  private listedSubtreeSize(pass: PassView): number {
    const rows = this.o.db
      .prepare('SELECT id, parent_id FROM tree_listing WHERE pass_id = ?')
      .all(pass.id) as { id: string; parent_id: string | null }[];
    const children = new Map<string, string[]>();
    let rootSeen = false;
    for (const r of rows) {
      if (r.id === pass.rootId) rootSeen = true;
      if (r.parent_id === null) continue;
      const l = children.get(r.parent_id) ?? [];
      l.push(r.id);
      children.set(r.parent_id, l);
    }
    if (!rootSeen) return 0;
    let n = 0;
    const seen = new Set<string>();
    const q = [pass.rootId];
    while (q.length > 0) {
      const id = q.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      n++;
      for (const c of children.get(id) ?? []) q.push(c);
    }
    return n;
  }

  /** Brings the stored tree in line with the listing (snapshot T); newer after-write updates are kept. */
  private async reconcilePhase(pass: PassView, signal: AbortSignal): Promise<void> {
    const ctx = this.ctx(pass.projectId, pass.rootId, pass.kind, pass);
    // The root must be there. A listing that does not show it is checked with a read: a 404 fails the pass, and
    // nothing changes (the owner decides what the root is now).
    if (!this.inListing(pass.id, pass.rootId)) {
      const r = await this.read(
        pass.projectId,
        'getResource',
        { path: { resourceId: pass.rootId } },
        {
          priority: 'P3',
          jobId: pass.id,
          passId: pass.id,
          signal,
          waitForBudget: true,
          waitForProject: pass.kind === 'build',
        },
      );
      const obs = r.gone ? null : observationFromResource(r.value);
      if (!obs) {
        throw new PassError(
          `The AI REPOSITORY root ${pass.rootId} is gone (deleted, or the key cannot see it). Nothing was changed.`,
        );
      }
      this.store.stage(pass.id, pass.projectId, [obs], r.t);
    }
    const r = await this.serial(pass.projectId, () =>
      this.store.reconcile(ctx, pass.id, pass.snapshotAt ?? 0),
    );
    if (!r.ok) throw new PassError(r.error);
    const toRead = this.store.countToRead(pass.projectId, pass.id, pass.kind, pass.snapshotAt ?? 0);
    this.store.updatePass(pass.id, { subtree: r.subtree, toRead, added: r.added.length, removed: r.removed });
    this.store.clearListing(pass.id);
  }

  /** Reads the properties of every node the pass has to read (getResource each, P3). Resumable. */
  private async readPhase(pass: PassView, signal: AbortSignal): Promise<void> {
    const projectId = pass.projectId;
    const T = pass.snapshotAt ?? 0;
    const ctx = this.ctx(projectId, pass.rootId, pass.kind, pass);
    for (;;) {
      if (!this.stillActive(pass.id, signal)) return;
      const ids = this.store.idsToRead(projectId, pass.id, pass.kind, T, READ_BATCH);
      if (ids.length === 0) return;
      for (let i = 0; i < ids.length; i += this.concurrency) {
        const chunk = ids.slice(i, i + this.concurrency);
        await Promise.all(chunk.map((id) => this.passRead(pass, ctx, id, signal)));
        if (!this.stillActive(pass.id, signal)) return;
      }
    }
  }

  private async passRead(pass: PassView, ctx: ApplyContext, id: string, signal: AbortSignal): Promise<void> {
    const projectId = pass.projectId;
    let r: ReadResult;
    let ancestors: { obs: Observation; t: number }[] = [];
    let placeUnknown = false;
    try {
      const ro: ReadOptions = {
        priority: 'P3',
        jobId: pass.id,
        signal,
        passId: pass.id,
        waitForBudget: true,
        waitForProject: pass.kind === 'build',
      };
      r = await this.read(projectId, 'getResource', { path: { resourceId: id } }, ro);
      const seen = r.gone ? null : observationFromResource(r.value);
      if (seen && this.parentUnknown(projectId, pass.rootId, seen)) {
        // Moved under a parent the tree does not hold: find out where that is before deciding.
        const a = await this.ancestry(projectId, pass.rootId, seen, ro);
        ancestors = a.ancestors;
        placeUnknown = a.verdict === 'unknown';
      }
    } catch (e) {
      if (signal.aborted || e instanceof CancelledError) throw e;
      const message = errorText(e);
      await this.serial(projectId, () => {
        this.store.markStale(projectId, [id], `the ${pass.kind} could not read it: ${message}`);
        this.store.markPassed(projectId, id, pass.id);
        this.store.insertLog({
          projectId,
          source: pass.kind,
          passId: pass.id,
          nodeId: id,
          nodeName: this.store.node(projectId, id)?.raw_name ?? null,
          change: 'reread_failed',
          field: null,
          oldValue: null,
          newValue: null,
          detail: message,
        });
      });
      this.store.bumpPass(pass.id, { readFailed: 1 });
      return;
    }
    await this.serial(projectId, () => {
      const node = this.store.node(projectId, id);
      let structural = false;
      if (r.gone && id === pass.rootId) {
        throw new PassError(
          `The AI REPOSITORY root ${pass.rootId} is gone (deleted, or the key cannot see it). The tree was kept as it was.`,
        );
      }
      if (r.gone) {
        const removed = this.store.applyGone(ctx, id, r.t, 'deleted');
        if (removed > 0) this.store.bumpPass(pass.id, { removed });
        structural = removed > 0;
      } else if (placeUnknown) {
        this.store.markStale(projectId, [id], 'its place under the root could not be established');
      } else {
        const obs = observationFromResource(r.value);
        for (const a of ancestors) {
          if (this.store.applyObservation(ctx, a.obs, a.t) === 'added') {
            this.store.bumpPass(pass.id, { added: 1 });
            structural = true;
          }
        }
        if (obs) {
          const size = node ? this.store.subtreeIds(projectId, id).length : 0;
          const outcome = this.store.applyObservation(ctx, obs, r.t);
          const after = this.store.node(projectId, id);
          structural =
            outcome === 'removed' ||
            (after !== undefined &&
              node !== undefined &&
              (after.parent_id !== node.parent_id || after.display_name !== node.display_name));
          if (outcome === 'removed') this.store.bumpPass(pass.id, { removed: size });
        }
      }
      if (this.store.has(projectId, id)) this.store.markPassed(projectId, id, pass.id);
      if (structural) this.store.recomputePaths(projectId, pass.rootId);
    });
    this.store.bumpPass(pass.id, { readOk: 1 });
  }

  /** Nodes a pass corrected (each counted once, however many of its values changed). */
  private correctedNodes(passId: string): number {
    return (
      this.o.db
        .prepare(`SELECT COUNT(DISTINCT node_id) AS n FROM tree_log WHERE pass_id = ? AND change = 'updated'`)
        .get(passId) as { n: number }
    ).n;
  }

  private async finishPass(pass: PassView): Promise<void> {
    const projectId = pass.projectId;
    const T = pass.snapshotAt ?? this.o.clock.now();
    await this.serial(projectId, () => {
      if (!this.store.has(projectId, pass.rootId)) {
        throw new PassError(
          `The AI REPOSITORY root ${pass.rootId} is not in the tree at the end of the ${pass.kind}; it was not completed.`,
        );
      }
      this.store.recomputePaths(projectId, pass.rootId);
      this.store.setConfirmed(projectId, T, pass.kind);
      // Failed re-reads last tried before T are settled: the pass observed everything they would have.
      for (const row of this.store.pending(projectId)) {
        if (row.status === 'retry' && row.attempted_at !== null && row.attempted_at < T) {
          this.store.deletePending(row.id);
        }
      }
    });
    if (pass.kind !== 'build') this.store.updatePass(pass.id, { corrected: this.correctedNodes(pass.id) });
    const done = this.store.pass(pass.id)!;
    const n = this.store.count(projectId);
    const summary =
      pass.kind === 'build'
        ? `Built the tree: ${n} nodes, ${done.readOk} read with getResource${done.readFailed ? `, ${done.readFailed} could not be read (stale)` : ''}; ${done.requests} requests.`
        : `${pass.kind === 'sweep' ? 'Sweep' : 'Check'}: ${done.added} added, ${done.removed} removed, ${done.corrected} corrected` +
          `${done.readFailed ? `, ${done.readFailed} could not be read` : ''}; ${done.requests} requests.`;
    this.store.updatePass(pass.id, {
      status: 'succeeded',
      summary,
      finishedAt: this.o.clock.now(),
      cursor: null,
    });
    this.store.prune(projectId);
    if (pass.kind === 'build') this.recordPassJob(this.store.pass(pass.id)!);
    this.scheduleRetries(0);
    const finished = this.store.pass(pass.id)!;
    for (const fn of this.passListeners) {
      try {
        fn(finished);
      } catch (e) {
        this.o.log?.warn({ err: e, passId: pass.id, projectId }, 'a tree pass listener failed');
      }
    }
  }

  /** A finished build is recorded as a job of its project (the Jobs page); sweeps and checks are maintenance runs. */
  private recordPassJob(pass: PassView): void {
    try {
      const r = this.o.engine.recordResult({
        project: pass.projectId,
        opId: 'tree:build',
        params: {},
        value: {
          pass: pass.id,
          status: pass.status,
          summary: pass.summary,
          error: pass.error,
          requests: pass.requests,
        },
        origin: { kind: 'system', client: 'tree', tool: 'tree-build', detail: 'Repository tree build' },
        title: 'Repository tree: build',
        priority: 'P3',
        ...(pass.status === 'failed'
          ? { failure: { code: 'TREE_BUILD_FAILED', message: pass.error ?? 'The build failed.' } }
          : {}),
      });
      this.store.updatePass(pass.id, { jobId: r.jobId });
    } catch (e) {
      this.o.log?.warn({ err: e, passId: pass.id }, 'could not record a tree build as a job');
    }
  }

  // ============================================================================================ root suggestion

  /**
   * Lists the project's resources (P3) and suggests the root when exactly one top-level resource is named
   * "AI REPOSITORY" (case and surrounding spaces ignored). The result is stored and shown on the dashboard; it is
   * never applied by itself.
   */
  async suggestRoot(projectId: string): Promise<RootSuggestion> {
    this.suggesting.add(projectId);
    try {
      return await this.findRoot(projectId);
    } finally {
      this.suggesting.delete(projectId);
    }
  }

  private async findRoot(projectId: string): Promise<RootSuggestion> {
    const candidates: { id: string; name: string }[] = [];
    let listed = 0;
    let cursor: string | null = null;
    let error: string | null = null;
    try {
      for (;;) {
        const page = (
          await this.read(
            projectId,
            'listResources',
            { query: { limit: this.pageSize, ...(cursor ? { cursor } : {}) } },
            { priority: 'P3', signal: this.stopAll.signal, waitForBudget: true },
          )
        ).value as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
        for (const item of Array.isArray(page?.data) ? page.data : []) {
          const o = observationFromListItem(item);
          if (!o) continue;
          listed++;
          if (o.parentId === null && o.name.trim().toLowerCase() === 'ai repository') {
            candidates.push({ id: o.id, name: o.name });
          }
        }
        if (page?.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor !== '') {
          cursor = page.nextCursor;
        } else break;
      }
    } catch (e) {
      error = errorText(e);
    }
    const s: RootSuggestion = {
      at: this.o.clock.now(),
      candidates,
      suggested: error === null && candidates.length === 1 ? candidates[0]!.id : null,
      listed,
      error,
    };
    this.store.setSuggestion(projectId, s);
    return s;
  }

  // ============================================================================================ after writes

  private beforeWrite(info: WriteStepInfo): void {
    if (!TREE_OPS[info.opId]) return;
    if (!this.settings(info.projectId).rootId) return;
    if (this.store.pendingForStep(info.projectId, info.jobId, info.stepNo)) return; // recovering after a restart
    this.store.insertPending({
      projectId: info.projectId,
      jobId: info.jobId,
      stepNo: info.stepNo,
      op: info.opId,
      resourceIds: targetIds(info.opId, info.params, undefined),
      flags: flagsOf(info.opId, info.params),
    });
  }

  private async afterWrite(r: WriteStepResult): Promise<void> {
    if (!TREE_OPS[r.opId]) return;
    const pending = this.store.pendingForStep(r.projectId, r.jobId, r.stepNo);
    if (r.outcome === 'failed' && !r.uncertain) {
      // Nothing changed at LegendKeeper: nothing to re-read.
      if (pending) this.store.deletePending(pending.id);
      return;
    }
    // v2 C2a: a step marked `deferTreeReread` (one of several writes to one page in a job) is re-read once, when its job
    // finishes (`flushDeferred`). Its row stays owed meanwhile, so a crash or a job that never finishes is still caught
    // by the retry loop.
    if (r.options?.deferTreeReread === true && pending) {
      this.scheduleRetries(RETRY_FIRST_MS);
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
        // Every row of the step (a recovered step may have written one per attempt).
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
   * v2 C2a: the re-reads a job's `deferTreeReread` steps left owed, made now, in the job: one re-read per distinct set of
   * pages (a set_facts job's writes all name the same page, so one getResource). A failure is handled as any re-read's
   * (the node is marked stale, the row retried).
   */
  private async flushDeferred(info: {
    readonly projectId: string;
    readonly jobId: string;
    readonly priority: PriorityClass;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const rows = this.store
      .pending(info.projectId)
      .filter((p) => p.job_id === info.jobId && p.status === 'in_flight' && !this.rereading.has(p.id));
    if (rows.length === 0) return;
    const groups = new Map<string, PendingRow[]>();
    for (const r of rows) {
      const key = `${r.resource_ids}|${r.flags}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      for (const g of group) this.rereading.add(g.id);
      try {
        const ok = await this.reread(
          info.projectId,
          first.op,
          parseIds(first.resource_ids),
          parseFlags(first.flags),
          {
            priority: info.priority,
            jobId: info.jobId,
            signal: info.signal,
            waitForBudget: false,
            pendingId: first.id,
          },
        );
        if (ok) for (const g of group) this.store.deletePending(g.id);
      } finally {
        for (const g of group) this.rereading.delete(g.id);
      }
    }
    this.scheduleRetries(RETRY_FIRST_MS);
  }

  /**
   * Where a resource whose parent the tree does not know really is: its ancestors are read one by one (getResource)
   * until one is the root or a stored node (`inside`, with the ancestors to add, top first), or a top-level resource
   * (`outside`). A parent the listing skipped, or a new folder under the root, is never mistaken for "outside".
   * `unknown` when the walk is too deep or an ancestor cannot be found.
   */
  private async ancestry(
    projectId: string,
    rootId: string,
    obs: Observation,
    o: ReadOptions,
  ): Promise<{ verdict: 'inside' | 'outside' | 'unknown'; ancestors: { obs: Observation; t: number }[] }> {
    const chain: { obs: Observation; t: number }[] = [];
    let parent = obs.parentId;
    const seen = new Set<string>([obs.id]);
    for (let i = 0; i < 32; i++) {
      if (parent === null) return { verdict: 'outside', ancestors: [] };
      if (parent === rootId || this.store.has(projectId, parent)) {
        return { verdict: 'inside', ancestors: chain.reverse() };
      }
      if (seen.has(parent)) break;
      seen.add(parent);
      const r = await this.read(projectId, 'getResource', { path: { resourceId: parent } }, o);
      const p = r.gone ? null : observationFromResource(r.value);
      if (!p) break;
      chain.push({ obs: p, t: r.t });
      parent = p.parentId;
    }
    return { verdict: 'unknown', ancestors: [] };
  }

  /** Whether a read resource's place needs `ancestry` (its parent is neither the root nor a stored node). */
  private parentUnknown(projectId: string, rootId: string, obs: Observation): boolean {
    return (
      obs.id !== rootId &&
      obs.parentId !== null &&
      obs.parentId !== rootId &&
      !this.store.has(projectId, obs.parentId)
    );
  }

  /**
   * Re-reads the resources a write affected and updates the tree from what LegendKeeper answers. Returns false when a
   * read failed (or was interrupted): the nodes concerned are marked stale, the failure is logged and the pending row
   * is kept for a retry.
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
    const s = this.settings(projectId);
    if (!s.rootId) return true;
    const rootId = s.rootId;
    const meta = this.meta(projectId);
    const listing = this.store.activePass(projectId);
    const listingNow = listing !== undefined && listing.status !== 'reading';
    if (meta.status === 'not_built' && !listingNow) return true; // nothing stored to keep current
    const kind = TREE_OPS[op] ?? 'update';
    const relevant =
      kind === 'create' || kind === 'move' || kind === 'restore'
        ? ids
        : ids.filter((id) => this.store.has(projectId, id) || (listingNow && this.inListing(listing.id, id)));
    if (relevant.length === 0) return true;
    const attemptedAt = this.stamp();
    const ctx = this.ctx(projectId, rootId, 'write');
    const ro: ReadOptions = { ...o, waitForProject: false };
    const failures: { id: string; error: string }[] = [];
    let discover: string[] = [];
    let structural = false;
    const fail = (id: string, e: unknown, what = '') =>
      failures.push({
        id,
        error: o.signal?.aborted ? 'the re-read was interrupted' : `${what}${errorText(e)}`,
      });
    try {
      const results: {
        id: string;
        r: ReadResult;
        ancestors: { obs: Observation; t: number }[];
        skip: boolean;
      }[] = [];
      for (const id of relevant) {
        try {
          const r = await this.read(projectId, 'getResource', { path: { resourceId: id } }, ro);
          const obs = r.gone ? null : observationFromResource(r.value);
          let ancestors: { obs: Observation; t: number }[] = [];
          let skip = false;
          if (obs && listingNow && !this.store.has(projectId, rootId)) {
            // The first build's listing is still running: the listing places it.
          } else if (obs && this.parentUnknown(projectId, rootId, obs)) {
            const a = await this.ancestry(projectId, rootId, obs, ro);
            if (a.verdict === 'unknown') {
              failures.push({ id, error: 'its place under the root could not be established' });
              skip = true;
            }
            ancestors = a.ancestors;
          }
          results.push({ id, r, ancestors, skip });
        } catch (e) {
          fail(id, e);
        }
      }
      await this.serial(projectId, () => {
        for (const { id, r, ancestors, skip } of results) {
          if (skip) continue;
          const before = this.store.node(projectId, id);
          if (r.gone) {
            if (id === rootId) {
              // Never wipe the tree on one read: the root is marked stale and the next pass decides (it fails, so the
              // owner sees it).
              this.store.markStale(projectId, [id], 'the AI REPOSITORY root was not found when re-read');
              continue;
            }
            if (
              this.store.applyGone(ctx, id, r.t, kind === 'delete' ? 'deleted' : 'not found when re-read') > 0
            ) {
              structural = true;
            }
            continue;
          }
          const obs = observationFromResource(r.value);
          if (!obs) continue;
          for (const a of ancestors) {
            if (this.store.applyObservation(ctx, a.obs, a.t) === 'added') structural = true;
            if (listingNow) this.store.stageIfListing(projectId, a.obs, a.t);
          }
          const outcome = this.store.applyObservation(ctx, obs, r.t);
          if (listingNow) this.store.stageIfListing(projectId, obs, r.t);
          const after = this.store.node(projectId, id);
          if (
            outcome === 'added' ||
            outcome === 'removed' ||
            (before &&
              after &&
              (before.parent_id !== after.parent_id || before.display_name !== after.display_name))
          ) {
            structural = true;
          }
          // Descendants the tree cannot know yet: a template copy with its children, a restored subtree, or a
          // resource moved in from outside the root.
          if (
            after &&
            (flags.includeChildren === true ||
              kind === 'restore' ||
              (kind === 'move' && before === undefined))
          ) {
            discover.push(id);
          }
        }
        if (structural) this.store.recomputePaths(projectId, rootId);
      });
      // Descendants: list each level's children, then read each one.
      while (discover.length > 0 && failures.length === 0) {
        const next: string[] = [];
        for (const parent of discover) {
          let children: Observation[];
          try {
            children = await this.listChildren(projectId, parent, ro);
          } catch (e) {
            fail(parent, e, 'its children could not be listed: ');
            break;
          }
          for (const c of children) {
            let r: ReadResult;
            try {
              r = await this.read(projectId, 'getResource', { path: { resourceId: c.id } }, ro);
            } catch (e) {
              fail(c.id, e);
              continue;
            }
            await this.serial(projectId, () => {
              if (r.gone) return;
              const obs = observationFromResource(r.value);
              if (!obs) return;
              if (this.store.applyObservation(ctx, obs, r.t) === 'added') structural = true;
              if (listingNow) this.store.stageIfListing(projectId, obs, r.t);
              if (this.store.has(projectId, obs.id)) next.push(obs.id);
            });
          }
        }
        discover = next;
      }
      if (discover.length === 0 && structural) {
        await this.serial(projectId, () => this.store.recomputePaths(projectId, rootId));
      }
    } catch (e) {
      // Anything unexpected is a failed re-read too: never silently wrong.
      fail(relevant[0]!, e);
    }
    if (failures.length === 0) return true;
    await this.serial(projectId, () => {
      if (structural) this.store.recomputePaths(projectId, rootId);
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
          nodeId: f.id,
          nodeName: this.store.node(projectId, f.id)?.raw_name ?? null,
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
              resourceIds: ids,
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

  private hasListing(passId: string): boolean {
    return (
      this.o.db.prepare('SELECT 1 FROM tree_listing WHERE pass_id = ? LIMIT 1').get(passId) !== undefined
    );
  }

  private inListing(passId: string, id: string): boolean {
    return (
      this.o.db.prepare('SELECT 1 FROM tree_listing WHERE pass_id = ? AND id = ?').get(passId, id) !==
      undefined
    );
  }

  private async listChildren(projectId: string, parentId: string, o: ReadOptions): Promise<Observation[]> {
    const out: Observation[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = (
        await this.read(
          projectId,
          'listResources',
          { query: { parentId, limit: this.pageSize, ...(cursor ? { cursor } : {}) } },
          o,
        )
      ).value as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
      for (const item of Array.isArray(page?.data) ? page.data : []) {
        const obs = observationFromListItem(item);
        if (obs && obs.parentId === parentId) out.push(obs);
      }
      if (page?.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor !== '') {
        cursor = page.nextCursor;
      } else return out;
    }
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
        const ids = parseIds(row.resource_ids);
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
          this.o.log?.warn({ err: e, pending: row.id }, 'a repository tree re-read failed');
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
    if (step.status === 'cancelled') return 'not_applied';
    if (step.status === 'failed') return 'not_applied';
    return 'done'; // succeeded or uncertain
  }

  // ============================================================================================ helpers

  /**
   * An observation stamp: the clock in milliseconds, made strictly increasing (a stamp is never handed out twice, and
   * never goes back, even across a restart: it starts above every stamp already stored). Every read is stamped just
   * before it is sent, and a pass's snapshot T likewise, so "observed later" is a strict order with no ties: the
   * read sent later wins, whatever the clock's resolution.
   */
  private stamp(): number {
    if (this.lastStamp === 0) {
      const r = this.o.db
        .prepare(
          `SELECT MAX(m) AS m FROM (
             SELECT MAX(MAX(struct_observed_at, COALESCE(props_observed_at, 0))) AS m FROM tree_nodes
             UNION ALL SELECT MAX(observed_at) FROM tree_tombstones
             UNION ALL SELECT MAX(snapshot_at) FROM tree_passes)`,
        )
        .get() as { m: number | null };
      this.lastStamp = r.m ?? 0;
    }
    this.lastStamp = Math.max(this.o.clock.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  private ctx(projectId: string, rootId: string, by: ReadBy, pass?: PassView): ApplyContext {
    return {
      projectId,
      rootId,
      settings: this.settings(projectId),
      by,
      ...(pass ? { passId: pass.id } : {}),
      ...(pass && pass.kind !== 'build' ? { log: { source: pass.kind, passId: pass.id } } : {}),
    };
  }

  /** Runs `fn` after every earlier change to the same project's tree. */
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

  /** Runs background work, kept so `stop` and `whenIdle` can wait for it. Its failures are its own to handle. */
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
      const t = this.stamp(); // the observation time: unique and increasing
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
          // The project is not served for now (its key is being checked again): a build waits for it (until stopped
          // or cancelled). A sweep, check or retry fails instead, so nothing stays stuck behind it.
          await sleep(this.o.clock, 15_000, o.signal);
          continue;
        }
        throw e;
      }
    }
  }
}

export interface PassOutcome {
  readonly summary: string;
  readonly changed?: boolean;
  readonly skipped?: boolean;
}

interface ReadOptions {
  readonly priority: PriorityClass;
  readonly jobId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly passId?: string;
  /** Wait out an exhausted budget on the clock instead of failing. */
  readonly waitForBudget: boolean;
  /** Wait while the project is not served (builds only). */
  readonly waitForProject?: boolean;
}

interface ReadResult {
  readonly gone: boolean;
  readonly value: unknown;
  /** When the request was sent: the observation time. */
  readonly t: number;
}

export type TreeErrorCode = 'NOT_CONFIGURED' | 'PASS_RUNNING' | 'NOTHING_TO_CONFIRM' | 'NOTHING_TO_CANCEL';

export class TreeError extends Error {
  constructor(
    readonly code: TreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TreeError';
  }
}

function newPassId(kind: PassKind): string {
  return `tp_${kind}_${randomBytes(8).toString('hex')}`;
}

function errorText(e: unknown): string {
  if (e instanceof JobsError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** The resources a write affects: its path's resource, the ids it created (from the request's minted ids and the response). */
function targetIds(op: string, params: OpParams, value: unknown): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v !== '') ids.add(v);
  };
  const body = (params.body ?? {}) as Record<string, unknown>;
  const v = (value ?? {}) as Record<string, unknown>;
  if (op === 'createManyResources') {
    for (const r of Array.isArray(body.resources) ? body.resources : [])
      add((r as Record<string, unknown>)?.id);
    for (const r of Array.isArray(v.resources) ? v.resources : []) add((r as Record<string, unknown>)?.id);
  } else if (op === 'createResource' || op === 'createResourceFromTemplate') {
    add(body.id);
    add(v.id);
  } else {
    add(params.path?.resourceId);
  }
  return [...ids];
}

function flagsOf(op: string, params: OpParams): RereadFlags {
  const body = (params.body ?? {}) as Record<string, unknown>;
  return op === 'createResourceFromTemplate' && body.includeChildren === true
    ? { includeChildren: true }
    : {};
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

export function createTree(o: TreeServiceOptions): TreeService {
  return new TreeService(o);
}
