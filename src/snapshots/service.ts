/**
 * Snapshots (v2 E1a, ADR 0042; PLAN-v2 4.11): the store, the full and change snapshots, retention and the
 * garbage collector, the verify routine and the dashboard's view. Restores (restore.ts) and the rehearsal
 * (rehearsal.ts) build on it.
 *
 * - **Full** (`full`): every page under the AI REPOSITORY (the root and the lifecycle indexes included) and the whole
 *   asset library, at P4 (bulk, v3 F9, ADR 0074) through the governor: below routine maintenance (P3), giving way
 *   while agents' P1 or P2 work is queued (as the link sweep does). Each page done is recorded, so an interrupted run continues where it stopped (at start-up, or the next run);
 *   the manifest is written only when the run completes. Refused, with a dashboard notice, when the disk would be left
 *   with less than the minimum free space.
 * - **Change**: after every write step a bridge job makes to a page (any tool, `lk_api_*` included), the page's changed
 *   pieces are owed (a row written while the job runs); when the job ends they are taken, using the reads the job's own
 *   verify step (or the tree's re-read) made after its last write instead of reading again.
 * - There is no pass for edits made in the app: LegendKeeper's `updatedAt` does not move when content changes (the
 *   owner's sandbox run, 13 November 2026), so the full snapshot is nightly and catches them within a day (ADR 0042).
 */
import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Db } from '../db/open.js';
import { downloadAsset } from '../images/download.js';
import {
  BudgetExhaustedError,
  LkOperationError,
  type JobEngine,
  type OpParams,
  type ReadInfo,
  type WriteObserver,
  type WriteStepInfo,
  type WriteStepResult,
} from '../jobs/index.js';
import type { PriorityClass } from '../lk/governor/index.js';

/** v3 F9 (ADR 0074): the class of a full snapshot's reads (and its image downloads): bulk. */
export const FULL_SNAPSHOT_PRIORITY = 'P4' satisfies PriorityClass;
import type { ProjectsRuntime } from '../projects/registry.js';
import type { TreeNode } from '../tree/types.js';
import type { SnapshotStoreSettings } from '../config/tools.js';
import { libraryPiece, type LibraryAsset, type LibraryFolder } from './canonical.js';
import {
  EVERYTHING,
  captureLibrary,
  capturePage,
  isStop,
  newCounters,
  readKey,
  type CaptureDeps,
  type Counters,
  type ImageResult,
  type PageNode,
  type PieceSelection,
  type Reader,
} from './capture.js';
import { SnapshotDb, type OwedRow, type RunRow, type SnapshotRow } from './db.js';
import {
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  newSnapshotId,
  type LibraryEntry,
  type Manifest,
  type PageEntry,
  type SnapshotKind,
} from './manifest.js';
import { KeptBytes, SnapshotStore } from './store.js';
import { loggedTask, type TaskLogger } from '../maintenance/task-log.js';
import { canonicalBytes } from './canonical.js';

type Obj = Record<string, unknown>;

/** Thrown inside a run when the bridge is stopping: the run stays `running` and continues later. */
export class StopError extends Error {
  override readonly name = 'StopError';
  constructor() {
    super('the bridge is stopping');
  }
}

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** What the tree gives the snapshots (src/tree): its status, root, subtree and nodes. */
export interface SnapshotTree {
  readonly queries: {
    status(projectId: string): { readonly status: string; readonly reason?: string | null };
    root(projectId: string): { readonly data: TreeNode | null };
    subtree(
      projectId: string,
      id: string,
      o: { readonly limit?: number },
    ): { readonly data: { readonly entries: readonly { readonly node: TreeNode }[] } };
    node(projectId: string, id: string): { readonly data: TreeNode | null };
  };
}

export interface SnapshotServiceOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly projects: Pick<ProjectsRuntime, 'client' | 'activeIds'> & { nameOf(id: string): string | null };
  readonly tree: SnapshotTree;
  readonly settings: SnapshotStoreSettings;
  readonly assetHosts: readonly string[];
  /** The database file the runtime was GIVEN (its directory holds `snapshots/` and `backups/` by default). */
  readonly dbPath: string;
  /** D3's image directory: an old `kept-bytes/` there is moved into the store at start-up. */
  readonly imageDir?: string;
  /** Each project's settings (the daily pass switches), read live. */
  readonly projectSettings: (projectId: string) => Readonly<Record<string, unknown>>;
  /** Whether agents' work (P1 or P2) is queued for the project: full and daily runs give way. */
  readonly busy?: (projectId: string) => boolean;
  readonly now: () => number;
  readonly log?: {
    info?(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  /** Test seams: the wait between yields, and no background work at start (runs resumed on demand). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly background?: boolean;
  /** Called after each page of a run is recorded (tests interrupt a run here). */
  readonly afterPage?: (runId: string, pageId: string) => void | Promise<void>;
  /**
   * v2 E1b (ADR 0043): called when a full snapshot's manifest is written (the run succeeded). The off-site copy asks its
   * runner for a copy here, so the nightly full snapshot reaches Drive within the hour. Never throws into the run.
   */
  readonly afterFull?: (projectId: string, snapshotId: string) => void | Promise<void>;
}

/** A run's or a change's outcome, for the maintenance job and the dashboard. */
export interface RunOutcome {
  readonly summary: string;
  readonly changed: boolean;
  readonly skipped?: boolean;
  readonly snapshotId?: string;
  readonly runId?: string;
}

/** The pieces a write step changes (see `piecesOf`). */
interface Owed {
  readonly pageId: string;
  readonly piece: 'page' | 'resource' | 'sidebar' | 'document' | 'deleted' | 'library';
  readonly ref: string;
}

/** What the read tap keeps of one job: its last write and the reads made since. */
interface JobTap {
  readonly projectId: string;
  lastWrite: number;
  readonly reads: Map<string, { readonly seq: number; readonly value: unknown }>;
  /** Reads a step made after its own write (the in-step verify), counted once that write is recorded. */
  readonly afterOwn: { readonly stepNo: number; readonly key: string; readonly value: unknown }[];
  /** Pages a cascade delete took with it (listed from the tree before the write). */
  readonly deleted: Map<string, PageNode>;
}

const PROPERTY_OPS = new Set([
  'createProperty',
  'updateProperty',
  'deleteProperty',
  'createPropertyRow',
  'updatePropertyRow',
  'deletePropertyRow',
]);
const ASSET_OPS = new Set(['createAssetFolder', 'createImageAsset', 'updateAsset', 'deleteAsset']);
const WHOLE_PAGE_OPS = new Set(['createResource', 'createResourceFromTemplate', 'restoreResource']);
const RESOURCE_OPS = new Set(['updateResource', 'moveResource']);

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_TAP_READS = 400;
const MAX_TAP_VALUE_CHARS = 8_000_000;
const DAY = 86_400_000;

/**
 * The pieces one write step changed. `value` is LegendKeeper's answer (a create's new id). A step outside a page (a
 * template, the asset library) is the library's or nothing.
 */
export function piecesOf(opId: string, params: OpParams, value: unknown): Owed[] {
  const path = params.path ?? {};
  const body = (params.body ?? {}) as Obj;
  const v = (value ?? {}) as Obj;
  const rid = typeof path.resourceId === 'string' ? path.resourceId : null;
  if (ASSET_OPS.has(opId)) return [{ pageId: '*', piece: 'library', ref: '' }];
  if (opId === 'createManyResources') {
    const created = Array.isArray(v.resources) ? (v.resources as Obj[]) : [];
    return created
      .map((r) => (typeof r.id === 'string' ? r.id : null))
      .filter((x): x is string => x !== null)
      .map((id) => ({ pageId: id, piece: 'page' as const, ref: '' }));
  }
  if (opId === 'createResource' || opId === 'createResourceFromTemplate') {
    const id = typeof v.id === 'string' ? v.id : typeof body.id === 'string' ? body.id : null;
    return id ? [{ pageId: id, piece: 'page', ref: '' }] : [];
  }
  if (!rid) return [];
  if (WHOLE_PAGE_OPS.has(opId)) return [{ pageId: rid, piece: 'page', ref: '' }];
  if (opId === 'deleteResource') return [{ pageId: rid, piece: 'deleted', ref: '' }];
  if (RESOURCE_OPS.has(opId)) return [{ pageId: rid, piece: 'resource', ref: '' }];
  if (PROPERTY_OPS.has(opId)) return [{ pageId: rid, piece: 'sidebar', ref: '' }];
  if (opId === 'createDocument') {
    const id = typeof v.id === 'string' ? v.id : null;
    return id ? [{ pageId: rid, piece: 'document', ref: id }] : [{ pageId: rid, piece: 'page', ref: '' }];
  }
  if (typeof path.documentId === 'string') return [{ pageId: rid, piece: 'document', ref: path.documentId }];
  if (opId === 'saveResourceAsTemplate') return [];
  return [{ pageId: rid, piece: 'resource', ref: '' }];
}

export class SnapshotService {
  readonly store: SnapshotStore;
  readonly index: SnapshotDb;
  /** D3's kept bytes, over this store (one store, not two). */
  readonly keptBytes: KeptBytes;
  private readonly stopper = new AbortController();
  private readonly taps = new Map<string, JobTap>();
  private seq = 0;
  private changes: Promise<void> = Promise.resolve();
  private readonly running = new Set<string>();
  /** v3 F9: projects whose full snapshot has finished and whose after-snapshot hooks are running now. */
  private readonly afterFullRunning = new Set<string>();
  private detach: (() => void)[] = [];
  private started: Promise<void> | null = null;

  constructor(readonly o: SnapshotServiceOptions) {
    this.store = new SnapshotStore(snapshotDir(o.settings, o.dbPath));
    this.index = new SnapshotDb(o.db, o.now);
    this.keptBytes = new KeptBytes(this.store);
  }

  get settings(): SnapshotStoreSettings {
    return this.o.settings;
  }

  // ============================================================================================ life cycle

  /** Follows the engine's writes and jobs; tidies the store and resumes what a restart interrupted (in the background). */
  start(): Promise<void> {
    if (this.started) return this.started;
    const offWrites = this.o.engine.observeWrites(this.observer(), { first: true });
    const offJobs = this.o.engine.events.on('job', (e) => {
      if (TERMINAL.has(e.job.status)) this.queueChange(e.job.projectId, e.job.id);
    });
    this.detach.push(offWrites, offJobs);
    this.started = loggedTask(this.taskLog(), 'snapshot store start', {}, async () => {
      try {
        if (await this.store.exists()) await this.store.cleanTmp();
        if (this.o.imageDir) {
          const r = await this.store.adoptKeptBytes(join(this.o.imageDir, 'kept-bytes'));
          if (r.adopted > 0 || r.damaged.length > 0)
            this.o.log?.info?.(
              { adopted: r.adopted, damaged: r.damaged.length },
              'kept bytes moved into the snapshot store',
            );
        }
        await this.reindex();
        // Change snapshots owed when the process stopped: their jobs have ended (or will be resumed and end again).
        for (const j of this.index.owedJobs()) this.queueChange(j.projectId, j.jobId);
      } catch (e) {
        this.o.log?.warn({ err: e }, 'the snapshot store could not be prepared');
      }
    });
    return this.started;
  }

  /** Runs interrupted by a restart, continued in the background (call once the projects are served). */
  resumeInterrupted(): void {
    for (const pid of this.o.projects.activeIds()) {
      const r = this.index.runningRun(pid, 'full');
      if (r)
        void loggedTask(this.taskLog(), 'snapshot run resumed', { project: pid, run: r.id }, () =>
          this.runPages(pid, r, 'resume'),
        ).catch((e: unknown) =>
          this.o.log?.warn({ err: e, runId: r.id }, 'a snapshot run could not continue'),
        );
    }
  }

  stop(): void {
    this.stopper.abort();
    for (const d of this.detach.splice(0)) d();
  }

  /** Waits for the change snapshots queued so far (tests, shutdown). */
  async settled(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const p = this.changes;
      await p;
      if (p === this.changes) return;
    }
  }

  /** Indexes every manifest file the database does not know (a crash after the write, or a database restored from a copy). */
  async reindex(): Promise<number> {
    let n = 0;
    for (const m of await this.store.manifests()) {
      const id = m.rel
        .split('/')
        .pop()!
        .replace(/\.json\.gz$/, '');
      if (this.index.hasSnapshot(id)) continue;
      const man = await this.store.readManifest(m.rel);
      if (!man) continue;
      this.index.indexManifest(man, m.rel, summaryOf(man));
      n++;
    }
    return n;
  }

  // ============================================================================================ reading

  private sleep(ms: number): Promise<void> {
    if (this.o.sleep) return this.o.sleep(ms);
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      this.stopper.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** A governed read at `priority`: a 404 is undefined; an exhausted budget is waited out; stopping throws StopError. */
  reader(
    projectId: string,
    priority: PriorityClass,
    o: {
      readonly wait?: boolean;
      readonly signal?: AbortSignal;
      /** v3 F9: the governor's fair-share lane (a full run's id, so bulk passes take turns). */
      readonly lane?: string;
      /** v3 F9 review: first claim within its class (a full run's reads go before the other bulk passes). */
      readonly firstClaim?: boolean;
    } = {},
  ): Reader {
    return async (op, params) => {
      for (;;) {
        if (this.stopper.signal.aborted || o.signal?.aborted) throw new StopError();
        try {
          return await this.o.engine.internalRead(projectId, op, params, {
            priority,
            notFoundIsAnswer: true,
            signal: o.signal ?? this.stopper.signal,
            ...(o.lane !== undefined ? { lane: o.lane } : {}),
            ...(o.firstClaim === true ? { firstClaim: true } : {}),
          });
        } catch (e) {
          if (e instanceof LkOperationError && (e.lk.status === 404 || e.lkCode === 'NOT_FOUND'))
            return undefined;
          if (e instanceof BudgetExhaustedError) {
            if (o.wait === false) throw e;
            await this.sleep(Math.max(1000, e.retryAtMs - this.o.now()));
            continue;
          }
          if (this.stopper.signal.aborted) throw new StopError();
          throw e;
        }
      }
    };
  }

  /** The bytes of an image URL, stored; downloaded (asset host, no API budget) only when the store lacks them. */
  imageFetcher(projectId: string, priority: PriorityClass): (url: string) => Promise<ImageResult> {
    const memo = new Map<string, { sha256: string; size: number }>();
    return async (url) => {
      const hit = memo.get(url);
      if (hit) return { ...hit, downloaded: false, created: false, stored: 0 };
      const known = this.knownImage(projectId, url);
      // Bytes the store holds are reused, unless an open verify finding says they are damaged: they are then fetched again
      // and written again (the repair).
      if (known && !this.isDamaged(known.sha256) && (await this.store.has(known.sha256))) {
        memo.set(url, known);
        return { ...known, downloaded: false, created: false, stored: 0 };
      }
      const lk = this.o.projects.client(projectId);
      if (!lk) throw new SnapshotError('PROJECT_UNAVAILABLE', 'The project is not served now.');
      const got = await downloadAsset(lk, url, {
        hosts: this.o.assetHosts,
        priority,
        opId: 'snapshot.image',
        signal: this.stopper.signal,
      });
      const put = await this.store.lock.shared(() =>
        this.store.putBytes(got.bytes, { compress: 'binary', repair: true }),
      );
      this.recordAssetHash(projectId, url, put.sha256, put.size);
      memo.set(url, { sha256: put.sha256, size: put.size });
      return {
        sha256: put.sha256,
        size: put.size,
        downloaded: true,
        created: put.created,
        stored: put.stored,
      };
    };
  }

  /** Whether a stored object has an open verify finding (it is then written again when the same content comes). */
  isDamaged(sha256: string): boolean {
    return (
      this.o.db
        .prepare(
          `SELECT 1 FROM snapshot_findings WHERE sha256 = ? AND resolved_at IS NULL AND problem <> 'manifest' LIMIT 1`,
        )
        .get(sha256) !== undefined
    );
  }

  /**
   * The image a job uploaded, by its new URL: the upload's record (the bytes handed to the store as it started) and the
   * job's `createImageAsset` answer. Empty for any other job, or when the stored file was found to differ.
   */
  private uploadedBy(projectId: string, jobId: string): Map<string, { sha256: string; size: number }> {
    const out = new Map<string, { sha256: string; size: number }>();
    try {
      const rows = this.o.db
        .prepare(
          `SELECT webp_sha256 AS sha256, webp_bytes AS size FROM image_uploads
           WHERE project_id = ? AND job_id = ? AND (stored_verified IS NULL OR stored_verified = 1)`,
        )
        .all(projectId, jobId) as { sha256: string; size: number }[];
      if (rows.length !== 1) return out;
      const job = this.o.engine.queries.getJob(projectId, jobId);
      const asset = (job?.result as { asset?: { url?: unknown } } | null | undefined)?.asset;
      const urls = new Set<string>();
      if (typeof asset?.url === 'string') urls.add(asset.url);
      for (const r of this.o.engine.stepResults(projectId, jobId) ?? []) {
        const v = r.value as { url?: unknown } | null | undefined;
        if (typeof v?.url === 'string' && /^https:\/\//.test(v.url)) urls.add(v.url);
      }
      if (urls.size === 1) out.set([...urls][0]!, rows[0]!);
    } catch {
      /* no image pipeline tables */
    }
    return out;
  }

  /**
   * Stores bytes the bridge itself has in hand (an upload's converted image), so a change snapshot can name that image
   * with its hash without downloading it. Unreferenced, they go with the collector after its grace period.
   */
  async rememberBytes(bytes: Buffer): Promise<string> {
    await this.start();
    const put = await this.store.lock.shared(() => this.store.putBytes(bytes, { compress: 'binary' }));
    return put.sha256;
  }

  /** An image URL's hash, when a snapshot, the asset tree or the bridge's own upload already knows it. */
  knownImage(projectId: string, url: string): { sha256: string; size: number } | null {
    const r = this.o.db
      .prepare(
        `SELECT sha256, size FROM snapshot_pieces WHERE project_id = ? AND sha256 IS NOT NULL
           AND ((piece = 'image' AND ref = ?) OR (piece = 'asset' AND name = ?))
         ORDER BY taken_at DESC LIMIT 1`,
      )
      .get(projectId, url, url) as { sha256: string; size: number } | undefined;
    if (r) return r;
    try {
      const a = this.o.db
        .prepare(
          `SELECT sha256, size FROM asset_items WHERE project_id = ? AND url = ? AND sha256 IS NOT NULL LIMIT 1`,
        )
        .get(projectId, url) as { sha256: string; size: number | null } | undefined;
      if (a) return { sha256: a.sha256, size: a.size ?? 0 };
    } catch {
      /* no asset tree */
    }
    try {
      // An image the bridge uploaded (its bytes were handed to the store as the upload started), unless the stored
      // file was found to differ.
      const u = this.o.db
        .prepare(
          `SELECT u.webp_sha256 AS sha256, u.webp_bytes AS size FROM image_uploads u
             JOIN asset_items a ON a.project_id = u.project_id AND a.id = u.asset_id
           WHERE u.project_id = ? AND a.url = ? AND (u.stored_verified IS NULL OR u.stored_verified = 1)
           ORDER BY u.created_at DESC LIMIT 1`,
        )
        .get(projectId, url) as { sha256: string; size: number } | undefined;
      if (u) return u;
    } catch {
      /* no image pipeline tables */
    }
    return null;
  }

  private recordAssetHash(projectId: string, url: string, sha256: string, size: number): void {
    try {
      this.o.db
        .prepare(
          `UPDATE asset_items SET sha256 = ?, sha256_at = ?, size = COALESCE(size, ?) WHERE project_id = ? AND url = ?`,
        )
        .run(sha256, this.o.now(), size, projectId, url);
    } catch {
      /* no asset tree */
    }
  }

  /**
   * What a capture uses. `download: false` (change snapshots): an image the store already holds is named with its hash;
   * any other is named by URL only (deferred to the full snapshot), so a bridge write never waits for the asset host.
   */
  captureDeps(
    projectId: string,
    priority: PriorityClass,
    cached?: CaptureDeps['cached'],
    o: {
      readonly download?: boolean;
      /** Images this capture already knows by URL (the job's own upload). */
      readonly known?: ReadonlyMap<string, { sha256: string; size: number }>;
    } = {},
  ): CaptureDeps {
    const fetch = this.imageFetcher(projectId, priority);
    return {
      store: this.store,
      assetHosts: this.o.assetHosts,
      image:
        o.download === false
          ? async (url) => {
              const known = o.known?.get(url) ?? this.knownImage(projectId, url);
              return known && (await this.store.has(known.sha256))
                ? { ...known, downloaded: false, created: false, stored: 0 }
                : null;
            }
          : fetch,
      ...(cached ? { cached } : {}),
      damaged: (sha) => this.isDamaged(sha),
      priorAsset: (assetId, url) => this.priorAsset(projectId, assetId, url),
    };
  }

  /** A library image as the latest snapshot that stored it recorded it: this asset id, this URL (ADR 0042 decision 4). */
  priorAsset(projectId: string, assetId: string, url: string): { sha256: string; size: number } | null {
    const r = this.o.db
      .prepare(
        `SELECT sha256, size FROM snapshot_pieces
          WHERE project_id = ? AND piece = 'asset' AND ref = ? AND name = ? AND sha256 IS NOT NULL
          ORDER BY taken_at DESC LIMIT 1`,
      )
      .get(projectId, assetId, url) as { sha256: string; size: number } | undefined;
    return r ?? null;
  }

  // ============================================================================================ disk

  /** The disk check before a full snapshot: an estimate of what it adds, against the free space and the minimum. */
  async diskCheck(
    projectId: string,
    pages: number,
  ): Promise<{
    ok: boolean;
    free: number | null;
    total: number | null;
    estimate: number;
    minFree: number;
    message: string;
  }> {
    const disk = await this.store.disk();
    const estimate = this.estimateFull(projectId, pages);
    const minFree = this.o.settings.minFreeBytes;
    if (!disk) {
      return {
        ok: true,
        free: null,
        total: null,
        estimate,
        minFree,
        message: 'The free space could not be read; going ahead.',
      };
    }
    const after = disk.free - estimate;
    const ok = after >= minFree;
    return {
      ok,
      free: disk.free,
      total: disk.total,
      estimate,
      minFree,
      message: ok
        ? `${fmtBytes(disk.free)} free; this snapshot adds at most about ${fmtBytes(estimate)}, leaving ${fmtBytes(after)} (minimum ${fmtBytes(minFree)}).`
        : `Refused: ${fmtBytes(disk.free)} free, and this snapshot may add about ${fmtBytes(estimate)}, which would leave ${fmtBytes(Math.max(0, after))}, under the minimum of ${fmtBytes(minFree)} (SNAPSHOT_MIN_FREE_GB). Free some space or lower the minimum, then run it again.`,
    };
  }

  /**
   * At most what a full snapshot adds: every page's pieces as if none were stored yet (the previous full snapshot's
   * compressed bytes per page, or 12 KiB a page before there is one), plus the library's images the store lacks at their
   * average stored size (512 KiB before any is stored). An upper bound: a later full snapshot adds only what changed.
   */
  estimateFull(projectId: string, pages: number): number {
    const prev = this.index.snapshots(projectId, { kind: 'full', limit: 5 }).find((s) => s.pages > 0);
    const perPage = prev
      ? Math.max(4096, Math.ceil((prev.logicalBytes / Math.max(1, prev.pages)) * 0.4))
      : 12 * 1024;
    let images = 0;
    let avg = 512 * 1024;
    try {
      const st = this.o.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(AVG(size), 0) AS avg FROM snapshot_pieces WHERE project_id = ? AND piece = 'asset' AND sha256 IS NOT NULL`,
        )
        .get(projectId) as { n: number; avg: number };
      if (st.n > 0 && st.avg > 0) avg = st.avg;
      const unknown = this.o.db
        .prepare(
          `SELECT COUNT(*) AS n FROM asset_items WHERE project_id = ? AND type = 'IMAGE' AND sha256 IS NULL`,
        )
        .get(projectId) as { n: number };
      images = unknown.n;
    } catch {
      /* no asset tree */
    }
    return Math.ceil(pages * perPage + images * avg);
  }

  // ============================================================================================ full and daily runs

  private pagesOf(projectId: string): { nodes: TreeNode[]; rootId: string } | { skip: string } {
    let status: string;
    try {
      status = this.o.tree.queries.status(projectId).status;
    } catch (e) {
      return { skip: e instanceof Error ? e.message : String(e) };
    }
    if (status !== 'ready' && status !== 'stale')
      return { skip: `the repository tree is ${status.replace('_', ' ')}` };
    const root = this.o.tree.queries.root(projectId).data;
    if (!root) return { skip: 'the project has no AI REPOSITORY root' };
    const nodes = this.o.tree.queries
      .subtree(projectId, root.id, { limit: 100_000 })
      .data.entries.map((e) => e.node);
    if (!nodes.some((n) => n.id === root.id)) nodes.unshift(root);
    return { nodes, rootId: root.id };
  }

  /**
   * A full snapshot of the project: continues a run an interruption left, else checks the disk and starts one. Every
   * page of the AI REPOSITORY (the root and the lifecycle indexes included), then the asset library.
   */
  async full(projectId: string, trigger: string): Promise<RunOutcome> {
    const key = `${projectId}:full`;
    if (this.running.has(key))
      return {
        skipped: true,
        changed: false,
        summary: 'Skipped: a full snapshot of this project is already running.',
      };
    this.running.add(key);
    try {
      await this.start();
      let run = this.index.runningRun(projectId, 'full');
      if (!run) {
        const found = this.pagesOf(projectId);
        if ('skip' in found) return { skipped: true, changed: false, summary: `Skipped: ${found.skip}.` };
        const check = await this.diskCheck(projectId, found.nodes.length);
        const id = `run_${randomBytes(8).toString('hex')}`;
        const estimate = { ...check, pages: found.nodes.length };
        if (!check.ok) {
          this.index.refusedRun({ id, projectId, kind: 'full', trigger, error: check.message, estimate });
          this.index.notice({ projectId, level: 'error', code: 'SNAPSHOT_DISK', message: check.message });
          return { skipped: true, changed: false, summary: check.message, runId: id };
        }
        this.index.createRun({
          id,
          projectId,
          kind: 'full',
          trigger,
          rootId: found.rootId,
          pages: [...found.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((n) => n.id),
          estimate,
        });
        run = this.index.run(id)!;
      }
      return await this.runPages(projectId, run, trigger);
    } finally {
      this.running.delete(key);
    }
  }

  /** Takes a run's pending pages one at a time (each recorded when done), then its library, then writes the manifest. */
  private async runPages(projectId: string, run: RunRow, _trigger: string): Promise<RunOutcome> {
    const resumed = run.done > 0;
    // v3 F9 (ADR 0074): a full run reads every page and the whole library: bulk (P4), below routine maintenance, in
    // its own fair-share lane. Each read is patient in the governor (a long wait is waited, never a refusal).
    // First claim within P4 (the owner's review): when ready, it goes before the other bulk passes.
    const read = this.reader(projectId, FULL_SNAPSHOT_PRIORITY, {
      lane: `snapshot:${run.id}`,
      firstClaim: true,
    });
    const deps = this.captureDeps(projectId, FULL_SNAPSHOT_PRIORITY);
    const abandoned = (): RunOutcome | null =>
      this.index.run(run.id)?.state === 'running'
        ? null
        : {
            skipped: true,
            changed: false,
            runId: run.id,
            summary: 'The run was abandoned; nothing was written.',
          };
    try {
      for (const pageId of this.index.pendingPages(run.id)) {
        const gone = abandoned();
        if (gone) return gone;
        // Agents' work first: wait while P1 or P2 work is queued for the project (at most a minute a page).
        for (let i = 0; i < 240 && this.o.busy?.(projectId); i++) await this.sleep(250);
        if (this.stopper.signal.aborted) throw new StopError();
        const n = this.nodeOf(projectId, pageId);
        const c = newCounters();
        const captured = await capturePage(deps, read, n, EVERYTHING, c);
        const entry = { ...captured, capturedAt: new Date(this.o.now()).toISOString() };
        this.index.savePage(run.id, pageId, entry.deleted ? null : entry, {
          reads: c.reads,
          downloads: c.downloads,
          newObjects: c.newObjects,
          newBytes: c.newBytes,
        });
        await this.o.afterPage?.(run.id, pageId);
      }
      let library: LibraryEntry | null = null;
      let templates: PageEntry[] | undefined;
      if (run.kind === 'full') {
        const stored = this.index.run(run.id)?.library as
          (LibraryEntry & { templates?: PageEntry[] }) | null | undefined;
        if (stored) {
          const { templates: t, ...lib } = stored;
          library = lib;
          if (t) templates = t;
        } else {
          const c = newCounters();
          library = await captureLibrary(deps, read, c);
          // v2 E2 (ADR 0044): the project's templates, for the audits' template checks (a failure is not the run's).
          templates = await this.captureTemplates(projectId, deps, read, c);
          this.index.setRunLibrary(run.id, templates ? { ...library, templates } : library);
          this.index.addRunCounts(run.id, {
            reads: c.reads,
            downloads: c.downloads,
            newObjects: c.newObjects,
            newBytes: c.newBytes,
          });
        }
      }
      const gone = abandoned();
      if (gone) return gone;
      const done = this.index.run(run.id)!;
      const pages = this.index.runEntries(run.id);
      const manifest = this.buildManifest({
        projectId,
        kind: run.kind,
        startedAt: run.startedAt,
        rootId: run.rootId,
        trigger: { run: run.id, trigger: run.trigger, ...(resumed ? { resumed: true } : {}) },
        pages,
        library,
        ...(templates ? { templates } : {}),
        counts: {
          reads: done.reads,
          downloads: done.downloads,
          newObjects: done.newObjects,
          newBytes: done.newBytes,
        },
      });
      await this.writeSnapshot(manifest);
      this.index.finishRun(run.id, 'succeeded', { snapshotId: manifest.id });
      if (run.kind === 'full' && this.o.afterFull) {
        this.afterFullRunning.add(projectId);
        try {
          await this.o.afterFull(projectId, manifest.id);
        } catch (e) {
          this.o.log?.warn({ err: e }, 'the off-site copy could not be requested after the full snapshot');
        } finally {
          this.afterFullRunning.delete(projectId);
        }
      }
      return {
        changed: true,
        runId: run.id,
        snapshotId: manifest.id,
        summary: `${resumed ? 'Resumed and finished' : 'Took'} a ${run.kind} snapshot (${manifest.id}): ${summaryOf(manifest)}.`,
      };
    } catch (e) {
      if (e instanceof StopError || isStop(e)) {
        this.index.noteRunError(run.id, 'stopped part-way; it continues where it stopped');
        throw e;
      }
      this.index.noteRunError(run.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
   * v2 E2 (ADR 0044): every template of the project (`listTemplates`, then each template as a page: its settings, sidebar
   * and documents), so a full snapshot lets the audits compare a page's sidebar and tabs with its template's. Templates
   * sit outside the AI REPOSITORY, so they are no page of the tree. About 2 to 3 reads a template at P4 (bulk). A failure
   * (other than a stop) is logged and leaves the manifest without templates; it never fails the snapshot.
   */
  private async captureTemplates(
    projectId: string,
    deps: ReturnType<SnapshotService['captureDeps']>,
    read: Reader,
    c: Counters,
  ): Promise<PageEntry[] | undefined> {
    try {
      const list: { id: string; name: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        c.reads++;
        const r = (await read('listTemplates', {
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
        })) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
        for (const t of Array.isArray(r?.data) ? (r.data as unknown[]) : []) {
          const o = (t ?? {}) as Record<string, unknown>;
          if (typeof o.id === 'string' && typeof o.name === 'string') list.push({ id: o.id, name: o.name });
        }
        if (r?.hasMore !== true || typeof r.nextCursor !== 'string') break;
        cursor = r.nextCursor;
      }
      const out: PageEntry[] = [];
      for (const t of list.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (this.stopper.signal.aborted) throw new StopError();
        const entry = await capturePage(
          deps,
          read,
          { id: t.id, parentId: 'templates', rank: null, name: t.name, kind: 'template' },
          EVERYTHING,
          c,
        );
        if (!entry.deleted) out.push({ ...entry, parentId: 'templates', kind: 'template' });
      }
      return out;
    } catch (e) {
      if (e instanceof StopError || isStop(e)) throw e;
      this.o.log?.warn({ err: e, projectId }, 'the templates could not be taken with the full snapshot');
      return undefined;
    }
  }

  private nodeOf(projectId: string, pageId: string): PageNode {
    let n: TreeNode | null;
    try {
      n = this.o.tree.queries.node(projectId, pageId).data;
    } catch {
      n = null;
    }
    return n
      ? { id: n.id, parentId: n.parentId, rank: n.rank, name: n.rawName, kind: n.kind }
      : { id: pageId, parentId: null, rank: null, name: pageId, kind: 'unclassified' };
  }

  /**
   * v3 F9 (ADR 0074, B5): whether a full snapshot of the project is under way: a run not yet finished (taking pages,
   * or left by a restart to be continued), or its after-snapshot hooks (the off-site copy request, the audit's start).
   * The night's scheduled block-id sweep and automation run wait while it is.
   */
  fullInProgress(projectId: string): boolean {
    return this.afterFullRunning.has(projectId) || this.index.runningRun(projectId, 'full') !== null;
  }

  /** Stops a run for good (the owner's "Abandon" on the dashboard): it will not be continued. */
  abandonRun(runId: string): boolean {
    const r = this.index.run(runId);
    if (!r || r.state !== 'running') return false;
    this.index.finishRun(runId, 'stopped', { error: 'abandoned by the owner' });
    return true;
  }

  // ============================================================================================ manifests

  buildManifest(o: {
    projectId: string;
    kind: SnapshotKind;
    startedAt: number;
    rootId: string | null;
    trigger: Record<string, unknown>;
    pages: readonly PageEntry[];
    library: LibraryEntry | null;
    templates?: readonly PageEntry[];
    counts: { reads: number; downloads: number; newObjects: number; newBytes: number };
  }): Manifest {
    const now = this.o.now();
    let pieces = 0;
    let logical = 0;
    let missing = 0;
    for (const p of o.pages) {
      if (p.resource) {
        pieces++;
        logical += p.resource.size;
      }
      if (p.sidebar) {
        pieces++;
        logical += p.sidebar.size;
      }
      for (const d of p.documents ?? []) {
        pieces++;
        logical += d.size;
      }
      for (const i of p.images ?? []) logical += i.size;
      missing += p.missing?.length ?? 0;
    }
    if (o.library) {
      if (o.library.piece) {
        pieces++;
        logical += o.library.piece.size;
      }
      for (const i of o.library.images) logical += i.size;
      missing += o.library.missing?.length ?? 0;
    }
    return {
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      id: newSnapshotId(o.kind, now, randomBytes(3).toString('hex')),
      project: { id: o.projectId, name: this.o.projects.nameOf(o.projectId) ?? o.projectId },
      kind: o.kind,
      takenAt: new Date(now).toISOString(),
      startedAt: new Date(o.startedAt).toISOString(),
      rootId: o.rootId,
      complete: missing === 0,
      trigger: o.trigger,
      pages: o.pages,
      ...(o.templates ? { templates: o.templates } : {}),
      library: o.library,
      counts: { pages: o.pages.length, pieces, logicalBytes: logical, missing, ...o.counts },
    };
  }

  /** Writes a manifest (objects first, then the manifest: E1b's order too) and indexes it. */
  async writeSnapshot(m: Manifest): Promise<SnapshotRow> {
    const rel = await this.store.lock.shared(() => this.store.writeManifest(m));
    this.index.indexManifest(m, rel, summaryOf(m));
    return this.index.snapshot(m.id)!;
  }

  async manifest(snapshotId: string): Promise<Manifest | null> {
    const row = this.index.snapshot(snapshotId);
    return row ? this.store.readManifest(row.path) : null;
  }

  // ============================================================================================ change snapshots

  /** The engine observer: owed pieces after each write; the job's reads after its last write (the read tap). */
  observer(): WriteObserver {
    return {
      beforeWrite: (info: WriteStepInfo) => {
        // A cascade delete takes the page's subtree with it: list it from the tree before it goes.
        if (info.opId !== 'deleteResource') return;
        const rid = info.params.path?.resourceId;
        if (!rid) return;
        const tap = this.tapOf(info.projectId, info.jobId);
        try {
          const sub = this.o.tree.queries
            .subtree(info.projectId, rid, { limit: 100_000 })
            .data.entries.map((e) => e.node);
          const self = this.o.tree.queries.node(info.projectId, rid).data;
          for (const n of self ? [self, ...sub] : sub)
            tap.deleted.set(n.id, {
              id: n.id,
              parentId: n.parentId,
              rank: n.rank,
              name: n.rawName,
              kind: n.kind,
            });
        } catch {
          /* outside the repository, or the tree is not built */
        }
      },
      afterWrite: (r: WriteStepResult) => {
        if (r.outcome !== 'succeeded' && !r.uncertain) return;
        const owed = piecesOf(r.opId, r.params, r.value);
        const tap = this.tapOf(r.projectId, r.jobId);
        tap.lastWrite = ++this.seq;
        // The step's own verify read (made inside the step, after its write) shows this write's result.
        for (const a of tap.afterOwn.splice(0))
          if (a.stepNo === r.stepNo) tap.reads.set(a.key, { seq: ++this.seq, value: a.value });
        const rows: Omit<OwedRow, 'id' | 'createdAt'>[] = [];
        for (const o of owed) {
          rows.push({
            projectId: r.projectId,
            jobId: r.jobId,
            pageId: o.pageId,
            piece: o.piece,
            ref: o.ref,
            opId: r.opId,
            tool: null,
          });
          if (o.piece === 'deleted')
            for (const id of tap.deleted.keys())
              if (id !== o.pageId)
                rows.push({
                  projectId: r.projectId,
                  jobId: r.jobId,
                  pageId: id,
                  piece: 'deleted',
                  ref: '',
                  opId: r.opId,
                  tool: null,
                });
        }
        try {
          this.index.addOwed(rows);
        } catch (e) {
          this.o.log?.warn({ err: e, jobId: r.jobId }, 'a change snapshot could not be recorded as owed');
        }
      },
      jobEnding: async (info) => {
        if (!this.taps.has(info.jobId)) return;
        // Inside the job: never wait for budget here (a short budget leaves the pieces owed for the queue after the job).
        try {
          await this.takeChange(info.projectId, info.jobId, {
            priority: info.priority === 'P0' || info.priority === 'P1' ? info.priority : 'P2',
            wait: false,
            signal: info.signal,
          });
        } catch (e) {
          if (!(e instanceof BudgetExhaustedError) && !(e instanceof StopError))
            this.o.log?.warn(
              { err: e, jobId: info.jobId },
              'a change snapshot failed; it is taken again after the job',
            );
        }
      },
      afterRead: (info: ReadInfo) => {
        if (info.afterOwnWriteOf !== undefined) {
          try {
            if (JSON.stringify(info.value ?? null).length > MAX_TAP_VALUE_CHARS) return;
          } catch {
            return;
          }
          this.tapOf(info.projectId, info.jobId).afterOwn.push({
            stepNo: info.afterOwnWriteOf,
            key: readKey(info.opId, info.params),
            value: info.value,
          });
          return;
        }
        const tap = this.taps.get(info.jobId);
        if (!tap || tap.lastWrite === 0) return; // reads before the job's first write never describe its result
        if (tap.reads.size >= MAX_TAP_READS) return;
        try {
          if (JSON.stringify(info.value ?? null).length > MAX_TAP_VALUE_CHARS) return;
        } catch {
          return;
        }
        tap.reads.set(readKey(info.opId, info.params), { seq: ++this.seq, value: info.value });
      },
    };
  }

  private tapOf(projectId: string, jobId: string): JobTap {
    let t = this.taps.get(jobId);
    if (!t) {
      t = { projectId, lastWrite: 0, reads: new Map(), afterOwn: [], deleted: new Map() };
      this.taps.set(jobId, t);
    }
    return t;
  }

  private queueChange(projectId: string, jobId: string): void {
    this.changes = this.changes
      .then(async () => {
        await this.takeChange(projectId, jobId);
      })
      .catch((e: unknown) => {
        if (!(e instanceof StopError)) this.o.log?.warn({ err: e, jobId }, 'a change snapshot failed');
      });
  }

  /**
   * The change snapshot of one ended job: the owed pieces of each page, read after the job (or taken from the reads the
   * job made after its last write), as one `change` manifest. Pages outside the AI REPOSITORY are left out.
   */
  async takeChange(
    projectId: string,
    jobId: string,
    o: { readonly priority?: PriorityClass; readonly wait?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<RunOutcome> {
    const owed = this.index.owedFor(projectId, jobId);
    const tap = this.taps.get(jobId);
    if (owed.length === 0) {
      this.taps.delete(jobId);
      return { changed: false, skipped: true, summary: 'Nothing was owed.' };
    }
    // CR-2026-11-R3 (R3-65): a change snapshot is background work: its start and finish in the log, with the memory.
    return loggedTask(
      this.taskLog(),
      'change snapshot',
      { project: projectId, job: jobId, pieces: owed.length },
      () => this.takeOwed(projectId, jobId, owed, tap, o),
    );
  }

  /**
   * R4.1: a change snapshot of the given pages (every piece of each, read now), tied to no job: how a sandbox check
   * snapshots only the pages it made (consistency-f4b's probe; the owner's run of 21 November 2026 hung on a full
   * snapshot of the whole test world, about 1,500 pages at the governor's rate). A page the repository tree does not hold
   * (outside the AI REPOSITORY) is left out, as a job's change snapshot leaves it.
   */
  async capturePages(
    projectId: string,
    pageIds: readonly string[],
    o: {
      readonly trigger: Record<string, unknown>;
      readonly priority?: PriorityClass;
      readonly signal?: AbortSignal;
    },
  ): Promise<RunOutcome> {
    const startedAt = this.o.now();
    const priority = o.priority ?? 'P1';
    const deps = this.captureDeps(projectId, priority, undefined, { download: false });
    const read = this.reader(projectId, priority, o.signal ? { signal: o.signal } : {});
    const c = newCounters();
    const pages: PageEntry[] = [];
    for (const id of [...new Set(pageIds)]) {
      let node: TreeNode | null;
      try {
        node = this.o.tree.queries.node(projectId, id).data;
      } catch {
        node = null;
      }
      if (!node) continue;
      const n: PageNode = {
        id: node.id,
        parentId: node.parentId,
        rank: node.rank,
        name: node.rawName,
        kind: node.kind,
      };
      pages.push(await capturePage(deps, read, n, EVERYTHING, c));
    }
    if (pages.length === 0)
      return { changed: false, skipped: true, summary: 'None of the pages is in the tree.' };
    let rootId: string | null;
    try {
      rootId = this.o.tree.queries.root(projectId).data?.id ?? null;
    } catch {
      rootId = null;
    }
    const manifest = this.buildManifest({
      projectId,
      kind: 'change',
      startedAt,
      rootId,
      trigger: o.trigger,
      pages,
      library: null,
      counts: { reads: c.reads, downloads: c.downloads, newObjects: c.newObjects, newBytes: c.newBytes },
    });
    await this.writeSnapshot(manifest);
    return {
      changed: true,
      snapshotId: manifest.id,
      summary: `Took change snapshot ${manifest.id}: ${summaryOf(manifest)}.`,
    };
  }

  /** The info logger for background tasks (task-log.ts), when the runtime gave one. */
  private taskLog(): TaskLogger | undefined {
    const log = this.o.log;
    return log?.info ? { info: (obj, msg) => log.info!(obj, msg) } : undefined;
  }

  private async takeOwed(
    projectId: string,
    jobId: string,
    owed: ReturnType<SnapshotDb['owedFor']>,
    tap: JobTap | undefined,
    o: { readonly priority?: PriorityClass; readonly wait?: boolean; readonly signal?: AbortSignal },
  ): Promise<RunOutcome> {
    if (this.stopper.signal.aborted) throw new StopError();
    const disk = await this.store.disk();
    if (disk && disk.free < this.o.settings.minFreeBytes) {
      this.index.clearOwed(owed.map((x) => x.id));
      this.taps.delete(jobId);
      const msg = `A change snapshot after job ${jobId} was skipped: ${fmtBytes(disk.free)} free, under the minimum of ${fmtBytes(this.o.settings.minFreeBytes)}.`;
      this.index.notice({ projectId, level: 'warning', code: 'SNAPSHOT_DISK', message: msg });
      return { changed: false, skipped: true, summary: msg };
    }
    const job = this.o.engine.queries.getJob(projectId, jobId);
    const cached = tap
      ? (op: string, params: OpParams): unknown => {
          const hit = tap.reads.get(readKey(op, params));
          if (!hit || hit.seq < tap.lastWrite) return undefined;
          // A list's later pages are not kept: only a whole answer is reused.
          if (params.query && Object.keys(params.query).some((k) => k === 'cursor')) return undefined;
          return hit.value === undefined ? undefined : hit.value;
        }
      : undefined;
    const priority = o.priority ?? 'P2';
    const deps = this.captureDeps(projectId, priority, cached, {
      download: false,
      known: this.uploadedBy(projectId, jobId),
    });
    const read = this.reader(projectId, priority, {
      ...(o.wait === false ? { wait: false } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const c = newCounters();
    const byPage = new Map<string, typeof owed>();
    for (const x of owed) byPage.set(x.pageId, [...(byPage.get(x.pageId) ?? []), x]);
    const pages: PageEntry[] = [];
    let library: LibraryEntry | null = null;
    let rootId: string | null;
    try {
      rootId = this.o.tree.queries.root(projectId).data?.id ?? null;
    } catch {
      rootId = null;
    }
    for (const [pageId, list] of byPage) {
      if (pageId === '*') {
        library = await this.libraryFromTree(projectId, deps, c);
        continue;
      }
      let node: TreeNode | null;
      try {
        node = this.o.tree.queries.node(projectId, pageId).data;
      } catch {
        node = null;
      }
      if (list.some((x) => x.piece === 'deleted')) {
        const gone =
          tap?.deleted.get(pageId) ??
          (node
            ? { id: node.id, parentId: node.parentId, rank: node.rank, name: node.rawName, kind: node.kind }
            : null);
        if (gone) pages.push({ ...gone, deleted: true });
        continue;
      }
      if (!node) continue; // outside the AI REPOSITORY (a template, a page elsewhere): not snapshotted
      const select: PieceSelection = list.some((x) => x.piece === 'page')
        ? EVERYTHING
        : {
            resource: list.some((x) => x.piece === 'resource'),
            sidebar: list.some((x) => x.piece === 'sidebar'),
            documents: [...new Set(list.filter((x) => x.piece === 'document').map((x) => x.ref))],
          };
      const n: PageNode = {
        id: node.id,
        parentId: node.parentId,
        rank: node.rank,
        name: node.rawName,
        kind: node.kind,
      };
      pages.push(await capturePage(deps, read, n, select, c));
    }
    if (pages.length === 0 && !library) {
      this.index.clearOwed(owed.map((x) => x.id));
      this.taps.delete(jobId);
      return { changed: false, skipped: true, summary: 'The job changed nothing under the AI REPOSITORY.' };
    }
    const manifest = this.buildManifest({
      projectId,
      kind: 'change',
      startedAt: this.o.now(),
      rootId,
      trigger: {
        jobId,
        ...(job
          ? {
              tool: job.origin.tool ?? null,
              principalId: job.principalId,
              approvedBy: job.approvedBy,
              title: job.title,
            }
          : {}),
        ops: [...new Set(owed.map((x) => x.opId))],
      },
      pages,
      library,
      counts: { reads: c.reads, downloads: c.downloads, newObjects: c.newObjects, newBytes: c.newBytes },
    });
    await this.writeSnapshot(manifest);
    this.index.clearOwed(owed.map((x) => x.id));
    this.taps.delete(jobId);
    return {
      changed: true,
      snapshotId: manifest.id,
      summary: `Took change snapshot ${manifest.id}: ${summaryOf(manifest)}.`,
    };
  }

  /** The asset library from the bridge's asset tree (no API request), each image's bytes stored (asset host). */
  private async libraryFromTree(projectId: string, deps: CaptureDeps, c: Counters): Promise<LibraryEntry> {
    let folders: LibraryFolder[] = [];
    let items: Omit<LibraryAsset, 'sha256'>[] = [];
    try {
      folders = (
        this.o.db
          .prepare('SELECT id, name, parent_id FROM asset_folders WHERE project_id = ?')
          .all(projectId) as {
          id: string;
          name: string;
          parent_id: string | null;
        }[]
      ).map((f) => ({ id: f.id, name: f.name, folderId: f.parent_id }));
      items = (
        this.o.db
          .prepare(
            'SELECT id, name, folder_id, type, url, width, height, is_hidden FROM asset_items WHERE project_id = ?',
          )
          .all(projectId) as {
          id: string;
          name: string;
          folder_id: string | null;
          type: string;
          url: string | null;
          width: number | null;
          height: number | null;
          is_hidden: number;
        }[]
      ).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        folderId: a.folder_id,
        isHidden: a.is_hidden === 1,
        description: null,
        url: a.url,
        width: a.width,
        height: a.height,
      }));
    } catch {
      /* no asset tree */
    }
    const images: LibraryEntry['images'][number][] = [];
    const withHashes: LibraryAsset[] = [];
    const missing: { piece: string; ref?: string; reason: string }[] = [];
    for (const a of items) {
      let sha: string | null = null;
      if (a.url) {
        try {
          const got = await deps.image(a.url);
          if (got === null) {
            // A change snapshot names a new asset without its bytes: the next full snapshot takes them.
            images.push({ assetId: a.id, url: a.url, sha256: null, size: 0, deferred: true });
            withHashes.push({ ...a, sha256: null });
            continue;
          }
          if (got.downloaded) c.downloads++;
          if (got.created) {
            c.newObjects++;
            c.newBytes += got.stored;
          }
          sha = got.sha256;
          images.push({ assetId: a.id, url: a.url, sha256: sha, size: got.size });
        } catch (e) {
          if (isStop(e)) throw e;
          images.push({ assetId: a.id, url: a.url, sha256: null, size: 0 });
          missing.push({ piece: 'asset', ref: a.id, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      withHashes.push({ ...a, sha256: sha });
    }
    const bytes = canonicalBytes(libraryPiece(folders, withHashes));
    const put = await this.store.lock.shared(() => this.store.putBytes(bytes, { compress: 'text' }));
    c.pieces++;
    c.logicalBytes += put.size;
    if (put.created) {
      c.newObjects++;
      c.newBytes += put.stored;
    }
    c.missing += missing.length;
    return {
      piece: { sha256: put.sha256, size: put.size },
      folders: folders.length,
      images,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }

  // ============================================================================================ retention and the collector

  /**
   * Retention (ADR 0042 decision 4), per project:
   * - **full snapshots:** every one for `keepFullDays` (30) days; then, for `keepWeekly` (8) more weeks, one per ISO week:
   *   the latest complete full snapshot of that week (the week of London time, as the schedule is). Older ones go. A
   *   partial full snapshot is kept for the first window only. The newest complete full snapshot is never removed.
   * - **change snapshots:** `keepDays` (30) days.
   * Then the collector removes what no manifest refers to any more.
   */
  async prune(): Promise<{ removed: number; gc: Awaited<ReturnType<SnapshotService['gc']>> }> {
    const now = this.o.now();
    let removed = 0;
    const projects = (
      this.o.db.prepare('SELECT DISTINCT project_id FROM snapshots').all() as { project_id: string }[]
    ).map((r) => r.project_id);
    for (const pid of projects) {
      const fulls = this.index.snapshots(pid, { kind: 'full', limit: 100_000 });
      const drop = fullsToDrop(fulls, now, this.o.settings);
      const cutoff = now - this.o.settings.keepDays * DAY;
      drop.push(...this.index.snapshots(pid, { kind: 'change', before: cutoff, limit: 100_000 }));
      for (const s of drop) {
        await this.store.removeManifest(s.path);
        this.index.removeSnapshot(s.id);
        removed++;
      }
    }
    return { removed, gc: await this.gc() };
  }

  /**
   * Removes the objects nothing refers to: no snapshot's manifest, no run in progress, no kept bytes in their retention
   * window. Objects written in the last hour are left alone (a writer may be about to refer to them).
   */
  async gc(o: { readonly graceMs?: number } = {}): Promise<{ removed: number; freed: number; kept: number }> {
    const grace = o.graceMs ?? 3_600_000;
    if (!(await this.store.exists())) return { removed: 0, freed: 0, kept: 0 };
    return this.store.lock.exclusive(async () => {
      const now = this.o.now();
      const refs = new Set<string>([
        ...this.index.referencedBySnapshots(),
        ...this.index.referencedByRuns(),
        ...this.index.referencedByKeptBytes(now),
      ]);
      let removed = 0;
      let freed = 0;
      let kept = 0;
      const wall = Date.now();
      for (const obj of await this.store.objects()) {
        if (
          refs.has(obj.sha256) ||
          this.store.recentlyPut(obj.sha256, grace, wall) ||
          wall - obj.mtimeMs < grace
        ) {
          kept++;
          continue;
        }
        await this.store.remove(obj.sha256);
        removed++;
        freed += obj.stored;
      }
      return { removed, freed, kept };
    });
  }

  // ============================================================================================ verify

  /**
   * Re-hashes every piece the snapshots (and the kept bytes) refer to. A missing or corrupt one is a finding, and every
   * snapshot that uses it becomes partial; a piece found whole again resolves its finding. Every manifest is read too.
   */
  async verify(): Promise<{
    checked: number;
    missing: number;
    corrupt: number;
    manifests: number;
    badManifests: number;
    summary: string;
  }> {
    const shas = [
      ...new Set([...this.index.referencedBySnapshots(), ...this.index.referencedByKeptBytes(this.o.now())]),
    ].sort();
    let missing = 0;
    let corrupt = 0;
    for (const sha of shas) {
      if (this.stopper.signal.aborted) throw new StopError();
      const r = await this.store.check(sha);
      if (r === 'ok') {
        this.index.resolveFindings(sha);
        continue;
      }
      if (r === 'missing') missing++;
      else corrupt++;
      const using = this.index.snapshotsUsing(sha);
      this.index.addFinding({
        sha256: sha,
        problem: r,
        detail: `${r === 'missing' ? 'Missing from' : 'Damaged in'} the store (objects/${sha.slice(0, 2)}/${sha}.gz)`,
        snapshots: using,
      });
      this.index.markDamaged(using, `piece ${sha.slice(0, 12)}… is ${r}`);
    }
    this.index.clearRepaired();
    let bad = 0;
    const rows = this.index.snapshots(null, { limit: 1_000_000 });
    for (const s of rows) {
      const m = await this.store.readManifest(s.path);
      if (m && m.id === s.id) continue;
      bad++;
      this.index.addFinding({
        sha256: s.id,
        problem: 'manifest',
        detail: `The manifest ${s.path} is missing or unreadable`,
        snapshots: [s.id],
      });
      this.index.markDamaged([s.id], 'its manifest is missing or unreadable');
    }
    const summary =
      missing + corrupt + bad === 0
        ? `Every piece checked out: ${shas.length} pieces, ${rows.length} manifests.`
        : `${missing} missing and ${corrupt} damaged pieces, ${bad} unreadable manifests (of ${shas.length} pieces and ${rows.length} manifests); the snapshots that use them are marked partial.`;
    return { checked: shas.length, missing, corrupt, manifests: rows.length, badManifests: bad, summary };
  }

  // ============================================================================================ the dashboard's view

  async overview(projectId: string | null): Promise<Record<string, unknown>> {
    const exists = await this.store.exists();
    const usage = exists
      ? await this.store.usage()
      : { objects: 0, objectBytes: 0, manifests: 0, manifestBytes: 0 };
    const disk = await this.store.disk();
    const totals = this.index.logicalTotals(projectId ?? undefined);
    const storeBytes = usage.objectBytes + usage.manifestBytes;
    const s = this.o.settings;
    const pages = projectId ? this.pagesOf(projectId) : null;
    const estimate =
      projectId && pages && !('skip' in pages) ? this.estimateFull(projectId, pages.nodes.length) : null;
    return {
      dir: this.store.dir,
      exists,
      store: { ...usage, bytes: storeBytes },
      disk,
      minFreeBytes: s.minFreeBytes,
      headroom: disk ? disk.free - s.minFreeBytes : null,
      logical: totals,
      // What all the snapshots would take without deduplication (their pieces, uncompressed), over what the unique pieces do.
      dedupRatio: totals.unique > 0 ? totals.referenced / totals.unique : null,
      compressionRatio: usage.objectBytes > 0 ? totals.unique / usage.objectBytes : null,
      retention: {
        keepFullDays: s.keepFullDays,
        keepWeekly: s.keepWeekly,
        keepDays: s.keepDays,
        softDeleteDays: s.softDeleteDays,
      },
      ...(projectId
        ? {
            counts: this.index.countsByKind(projectId),
            nextFullEstimate: estimate,
            runs: this.index.runs(projectId, 20),
            owed: this.index.owedCount(projectId),
          }
        : {}),
      findings: this.index.openFindings(100),
      notices: this.index.notices(projectId, 30),
    };
  }

  /**
   * The nightly database copies (`deploy/backup.sh`): `nightly-*.db.gz` and `pre-deploy-*.db.gz` in the backup
   * directory next to the database (BACKUP_DIR), newest first, with their size and age.
   */
  async databaseBackups(): Promise<{
    dir: string;
    files: { name: string; label: string; size: number; at: number }[];
    error?: string;
  }> {
    const dir = process.env.BACKUP_DIR ?? join(dirname(this.o.dbPath), 'backups');
    try {
      const files: { name: string; label: string; size: number; at: number }[] = [];
      for (const f of await readdir(dir)) {
        const m = /^(nightly|pre-deploy|offsite)-(\d{8}T\d{6}Z)\.db\.gz$/.exec(f);
        if (!m) continue;
        const st = await stat(join(dir, f));
        const t = m[2]!;
        const at = Date.parse(
          `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`,
        );
        files.push({ name: f, label: m[1]!, size: st.size, at: Number.isFinite(at) ? at : st.mtimeMs });
      }
      files.sort((a, b) => b.at - a.at);
      return { dir, files };
    } catch (e) {
      return {
        dir,
        files: [],
        error:
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'no backup directory yet'
            : String((e as Error).message),
      };
    }
  }
}

/** The store's directory: SNAPSHOT_DIR, else `snapshots/` next to the database the runtime was given. */
export function snapshotDir(settings: SnapshotStoreSettings, dbPath: string): string {
  if (settings.dataDir) return settings.dataDir;
  // An in-memory or temporary database has no directory: a private one under the system's temporary directory, never
  // a working-directory relative default (ADR 0041's lesson: that wrote into the read-only app folder).
  if (dbPath === ':memory:' || dbPath === '')
    return join(tmpdir(), `lkb-snapshots-${process.pid}-${randomBytes(4).toString('hex')}`);
  return join(dirname(dbPath), 'snapshots');
}

export function summaryOf(m: Manifest): string {
  const parts = [
    `${m.counts.pages} ${m.counts.pages === 1 ? 'page' : 'pages'}`,
    `${m.counts.pieces} pieces`,
    ...(m.library ? [`the asset library (${m.library.images.length} images)`] : []),
    `${m.counts.reads} reads`,
    ...(m.counts.downloads ? [`${m.counts.downloads} downloads`] : []),
    `${m.counts.newObjects} new objects (${fmtBytes(m.counts.newBytes)})`,
    ...(m.counts.missing ? [`${m.counts.missing} pieces MISSING (partial)`] : []),
  ];
  return parts.join(', ');
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** The ISO week (`2026-W46`) of an instant, by the calendar of London time (the schedule's). */
export function isoWeekKey(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const d = new Date(Date.UTC(n('year'), n('month') - 1, n('day')));
  const monday0 = (d.getUTCDay() + 6) % 7; // Monday is 0
  d.setUTCDate(d.getUTCDate() - monday0 + 3); // the Thursday of this week decides the ISO year
  const year = d.getUTCFullYear();
  // The Thursday of week 1 (the week holding 4 January); this week's Thursday is `weeks` whole weeks after it.
  const week1 = new Date(Date.UTC(year, 0, 4));
  week1.setUTCDate(4 - ((week1.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d.getTime() - week1.getTime()) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The full snapshots retention removes: all are kept for `keepFullDays`; older ones, within `keepWeekly` further weeks,
 * only the latest complete one of each ISO week; the rest go. The newest complete one always stays.
 */
export function fullsToDrop(
  fulls: readonly SnapshotRow[],
  now: number,
  s: { readonly keepFullDays: number; readonly keepWeekly: number },
): SnapshotRow[] {
  const allCut = now - s.keepFullDays * DAY;
  const weeklyCut = allCut - s.keepWeekly * 7 * DAY;
  const newestComplete =
    fulls.filter((x) => x.state === 'complete').sort((a, b) => b.takenAt - a.takenAt)[0] ??
    // No complete one (verify marked them all partial): the newest of any state stays.
    [...fulls].sort((a, b) => b.takenAt - a.takenAt)[0];
  // The latest complete full snapshot of each ISO week (of all of them: a week that straddles the 30 days is kept by its
  // latest, which is then inside the first window).
  const latestOfWeek = new Map<string, SnapshotRow>();
  for (const f of fulls) {
    if (f.state !== 'complete') continue;
    const k = isoWeekKey(f.takenAt);
    const cur = latestOfWeek.get(k);
    if (!cur || f.takenAt > cur.takenAt) latestOfWeek.set(k, f);
  }
  return fulls.filter((f) => {
    if (f.takenAt >= allCut) return false;
    if (f === newestComplete || f.id === newestComplete?.id) return false;
    if (
      f.takenAt >= weeklyCut &&
      f.state === 'complete' &&
      latestOfWeek.get(isoWeekKey(f.takenAt))?.id === f.id
    )
      return false;
    return true;
  });
}
