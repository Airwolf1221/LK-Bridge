/**
 * The image pipeline (v2 D3, ADR 0041; PLAN-v2 4.10, section 9 and the D3 note of 10.2).
 *
 * - **Intake**: bytes from one of the ways in are converted (src/images/convert.ts, one at a time) and deduplicated per
 *   project by the original's SHA-256.
 * - **Upload**: ONE `upload_image` job creates the missing folders in order, uploads the WebP (createImageUpload, the
 *   signed PUT, createImageAsset), downloads the stored file and compares its SHA-256 with the bytes sent
 *   (`storedBytesVerified`), and for a staged image hides it. Everything is recorded in `image_uploads`.
 * - **Staging**: a staged image is uploaded, verified and hidden in the project's staging folder (found or created by
 *   name), and recorded with its hashes, size, principal and intended destination. Placing it is ONE `batch_ops` job (or
 *   proposal, at scope `propose`): missing folders, then `updateAsset` (move, unhide, optionally rename), then a read
 *   back (`bridge.verify`). Discarding deletes the asset, after its bytes were kept (src/images/kept.ts). Nothing is
 *   removed automatically: old staged images are only reported.
 * - **Records follow the jobs**: a row is settled from its job when the job ends (an engine event), and again whenever
 *   it is read (so a restart, or a proposal approved later, settles it too).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AssetService } from '../assets/service.js';
import type { AssetPlan } from '../assets/plan.js';
import type { ImageSettings, ToolsSettings } from '../config/tools.js';
import type { Db } from '../db/open.js';
import type { LkClient } from '../lk/client.js';
import { downloadAsset } from './download.js';
import { createHash } from 'node:crypto';
import {
  TERMINAL_JOB_STATUSES,
  type JobEngine,
  type JobEngineEvents,
  type JobOrigin,
  type JobView,
  type PriorityClass,
  type ProposalCaptured,
  type StepSpec,
  type SubmitResult,
} from '../jobs/index.js';
import { VERIFY_STEP } from '../jobs/internal-steps.js';
import type { ProjectSettings } from '../projects/settings.js';
import type { Registry } from '../registry/index.js';
import { SlidingWindowLimiter } from '../auth/rate-limit.js';
import { ConversionQueue, type ConvertedImage } from './convert.js';
import {
  planDestination,
  planStaging,
  type DestinationDeps,
  type DestinationInput,
  type DestinationResult,
} from './destination.js';
import { ByteStore, createAssetDeleteKeeper, type KeptByteStore } from './kept.js';
import { UploadSlots } from './slots.js';
import { ImageStore, type ImageUploadRow, type UploadSource } from './store.js';

export const DEFAULT_STAGING_FOLDER = 'LK-Bridge staging';
const SWEEP_MS = 60_000;
const KEPT_SWEEP_MS = 3_600_000;
const DAY = 86_400_000;
/** v3 F2: an expiring staged image is removed this long after the dashboard first warned about it. */
export const STAGING_EXPIRY_WARNING_MS = 7 * DAY;

export interface ImageServiceOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly assets: AssetService;
  readonly registry: Registry;
  readonly projectSettings: (projectId: string) => ProjectSettings;
  readonly upload: ToolsSettings['upload'];
  readonly images: ImageSettings;
  /**
   * The database file the runtime was given (`databaseFile`; `:memory:` for an in-memory one), for the default image
   * directory (`images/` next to it). Never the config's DB_PATH: that is relative to the working directory.
   */
  readonly dbPath: string;
  /** The proposal states, for placements proposed at scope `propose`. */
  readonly proposals?: {
    get(id: string): { readonly state: string; readonly jobId: string | null } | undefined;
    /**
     * v3 F3b (ADR 0052): whether a proposal does nothing but place this one staged image (upload_image's own placement:
     * no high-level operation, and every operation it lists is that image's placement).
     */
    isImagePlacement?(id: string, stagedId: string): boolean;
    /** v3 F3b: withdraws a PENDING proposal for a package that takes over what it does (recorded with the reason). */
    supersede?(id: string, reason: string): boolean;
  };
  readonly now: () => number;
  readonly log?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
  };
  /** Start the timers (default true; tests drive `sweep` themselves). */
  readonly timers?: boolean;
  /** v2 E1a (ADR 0042): where kept bytes go (the snapshot store); default D3's own `kept-bytes/` directory. */
  readonly keptBytes?: KeptByteStore;
  /** v3 F2: a project's LegendKeeper client (migrate-staging downloads the old staged images through its governor). */
  readonly lkFor?: (projectId: string) => LkClient | undefined;
  /**
   * v2 E1a: the bytes of every upload, handed to the snapshot store as the upload starts, so a change snapshot names the
   * new image with its hash without downloading it (best effort: a failure never stops the upload).
   */
  readonly uploadedBytes?: (bytes: Buffer) => Promise<unknown>;
}

/**
 * The directory the bridge keeps image files in (IMAGE_DATA_DIR, or `images/` next to the database it was given). Only
 * a name: nothing is created until the first binary upload or the first kept file (ADR 0041, the image directory).
 */
export function imageDataDir(images: ImageSettings, dbPath: string): string {
  if (images.dataDir) return resolve(images.dataDir);
  if (dbPath === ':memory:' || dbPath === '') {
    return join(process.env.TMPDIR ?? '/tmp', `lk-bridge-images-${process.pid}`);
  }
  return join(dirname(resolve(dbPath)), 'images');
}

export interface StartUpload {
  readonly projectId: string;
  readonly image: ConvertedImage;
  readonly name: string;
  readonly description?: string | undefined;
  readonly plan: AssetPlan;
  readonly staged: boolean;
  readonly intended?: Record<string, unknown> | null | undefined;
  readonly source: UploadSource;
  readonly origin: JobOrigin;
  readonly priority?: PriorityClass;
  /**
   * v3 F2 (ADR 0049 decision 10): where a staged image waits: `server` (the default: the bridge's own disk) or
   * `legendkeeper` (hidden in the old staging folder): only the image restore of E1a, whose proposal must name the
   * new asset's URL in the pages it rewrites (left for a later session; ADR 0049 says so).
   */
  readonly stageIn?: 'server' | 'legendkeeper';
}

export class ImageServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ImageServiceError';
  }
}

const newId = () => `img_${randomBytes(12).toString('base64url')}`;

export class ImageService {
  readonly store: ImageStore;
  readonly slots: UploadSlots;
  readonly bytes: KeptByteStore;
  /**
   * v3 F2 (ADR 0049 decision 10): staged images' WebP bytes, on the bridge's server only (images/staged/, by SHA-256).
   * Not the snapshot store: staged images are unapproved, so they are in no snapshot and no off-site copy.
   */
  readonly stagedBytes: ByteStore;
  readonly queue: ConversionQueue;
  readonly dir: string;
  /**
   * In memory: `prepare_image_upload` calls per principal per hour, accepted binary uploads per principal per hour, and
   * requests to the binary endpoint per client address per hour (refused ones included).
   */
  readonly rate: {
    readonly prepare: SlidingWindowLimiter;
    readonly upload: SlidingWindowLimiter;
    readonly ip: SlidingWindowLimiter;
  };
  private timers: NodeJS.Timeout[] = [];
  private detach: (() => void)[] = [];

  constructor(private readonly o: ImageServiceOptions) {
    this.store = new ImageStore(o.db, o.now);
    // v2 D3.1: every change to a staged image is announced here, from the service's own store, so it does not depend on
    // the route (MCP tool, proposal approval, job ending, binary endpoint, dashboard).
    this.store.onChange((after, before) => this.announce(after, before));
    this.dir = imageDataDir(o.images, o.dbPath);
    this.slots = new UploadSlots(this.store, join(this.dir, 'upload-tmp'));
    // v2 E1a (ADR 0042): the snapshot store's objects when the runtime has one (one store, not two).
    this.bytes = o.keptBytes ?? new ByteStore(join(this.dir, 'kept-bytes'));
    this.stagedBytes = new ByteStore(join(this.dir, 'staged'));
    this.queue = new ConversionQueue(() => this.limits(), o.images.convertConcurrency);
    const hour = 3_600_000;
    this.rate = {
      prepare: new SlidingWindowLimiter(o.images.ratePerPrincipalPerHour, hour, o.now),
      upload: new SlidingWindowLimiter(o.images.ratePerPrincipalPerHour, hour, o.now),
      ip: new SlidingWindowLimiter(o.images.ratePerIpPerHour, hour, o.now),
    };
  }

  get settings(): { readonly upload: ToolsSettings['upload']; readonly images: ImageSettings } {
    return { upload: this.o.upload, images: this.o.images };
  }

  limits() {
    return {
      maxBytes: this.o.upload.maxBytes,
      maxPixels: this.o.images.maxPixels,
      maxFrames: this.o.images.maxFrames,
      timeoutMs: this.o.images.convertTimeoutMs,
    };
  }

  /** Cleans the temporary directory, registers the delete keeper and the job follower, and starts the timers. */
  start(): void {
    const removed = this.slots.cleanAtStart();
    if (removed > 0)
      this.o.log?.info?.({ removed }, 'image upload temporary files left from an earlier run were removed');
    this.detach.push(
      this.o.engine.setAssetDeleteKeeper(
        createAssetDeleteKeeper({
          store: this.store,
          bytes: this.bytes,
          assetHosts: this.o.images.assetHosts,
          retentionMs: () => this.o.images.keptBytesRetentionDays * DAY,
          ...(this.o.log ? { log: this.o.log } : {}),
        }),
      ),
    );
    // A proposal approved, rejected, expired or conflicted: the staged image it would place follows it.
    this.detach.push(
      this.o.engine.events.on('proposal', (e) => {
        try {
          for (const r of this.store.withPlacementProposal(e.projectId))
            if (r.placementProposalId === e.proposalId) this.settle(r);
        } catch (err) {
          this.o.log?.warn({ err, proposalId: e.proposalId }, 'a staged image could not follow its proposal');
        }
      }),
    );
    this.detach.push(
      this.o.engine.events.on('job', (e) => {
        if (TERMINAL_JOB_STATUSES.has(e.job.status)) this.onJobEnded(e.job);
      }),
    );
    for (const row of this.store.uploading()) this.settle(row);
    if (this.o.timers !== false) {
      const t1 = setInterval(
        () => void this.sweep().catch((err: unknown) => this.o.log?.warn({ err }, 'image sweep failed')),
        SWEEP_MS,
      );
      const t2 = setInterval(
        () =>
          void this.expireKept()
            .then(() => this.expireStaged())
            .catch((err: unknown) => this.o.log?.warn({ err }, 'kept-bytes or staging expiry failed')),
        KEPT_SWEEP_MS,
      );
      t1.unref();
      t2.unref();
      this.timers.push(t1, t2);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const d of this.detach.splice(0)) d();
  }

  /** Expired binary uploads lose their files (every minute); v3 F2: a migrate-staging request is run. */
  async sweep(): Promise<number> {
    const n = await this.slots.sweep();
    await this.runMigrationRequests();
    return n;
  }

  /** v3 F2: runs the migrate-staging requests the CLI wrote (one at a time; each is claimed once). */
  async runMigrationRequests(): Promise<void> {
    for (const m of this.store.pendingMigrations()) {
      if (!this.store.claimMigration(m.id)) continue;
      try {
        const r = await this.migrateStaging(m.projectId, m.requestedBy, false);
        this.store.finishMigration(m.id, 'done', r, r.proposalId);
      } catch (e) {
        this.store.finishMigration(
          m.id,
          'failed',
          { error: e instanceof Error ? e.message : String(e) },
          null,
        );
      }
    }
  }

  /**
   * v3 F2 (ADR 0049 decision 10): moves the old LegendKeeper staging folder's images to server staging. For each staged
   * record whose hidden asset is in that folder, its bytes are downloaded (checked against the record's SHA-256) and
   * kept on the server, and the record becomes a server-staged image (same staged id). Then ONE proposal deletes those
   * hidden assets (the delete keeper keeps their bytes as usual) and, when nothing else is in it, the folder. Anything it
   * does not know is listed and left alone. Never deletes without a proposal; idempotent: copied records are not copied
   * again, and while its proposal is pending nothing new is proposed.
   */
  async migrateStaging(
    projectId: string,
    by: string,
    /** Record the proposal as a migration of its own (false: the CLI's request row records it). */
    record = true,
  ): Promise<{
    folder: string | null;
    copied: string[];
    alreadyOnServer: string[];
    leftAlone: { id: string; name: string; why: string }[];
    proposalId: string | null;
    pendingProposalId?: string;
    message: string;
  }> {
    const name = this.stagingFolderName(projectId);
    const folder = this.o.assets.store.children(projectId, null).folders.find((f) => f.name === name);
    const copied: string[] = [];
    const alreadyOnServer: string[] = [];
    const leftAlone: { id: string; name: string; why: string }[] = [];
    if (!folder)
      return {
        folder: null,
        copied,
        alreadyOnServer,
        leftAlone,
        proposalId: null,
        message: `There is no “${name}” folder in the asset library: nothing to migrate. The imageStagingFolder setting can be cleared.`,
      };
    const pending = this.store
      .migrationProposals(projectId)
      .find((id) => ['pending', 'approved'].includes(this.o.proposals?.get(id)?.state ?? ''));
    const inside = this.o.assets.store.children(projectId, folder.id);
    for (const f of inside.folders) leftAlone.push({ id: f.id, name: f.name, why: 'a folder inside it' });
    const toDelete: string[] = [];
    for (const item of inside.items) {
      const row = this.store.byAsset(projectId, item.id);
      if (!row || !row.staged) {
        leftAlone.push({ id: item.id, name: item.name, why: 'not a staged image the bridge recorded' });
        continue;
      }
      if (row.legacyAssetId === item.id && row.serverSha256) {
        alreadyOnServer.push(row.id);
        toDelete.push(item.id);
        continue;
      }
      if (row.placementJobId || row.placementProposalId || row.discardJobId) {
        leftAlone.push({ id: item.id, name: item.name, why: `${row.id} is being placed or discarded` });
        continue;
      }
      const lk = this.o.lkFor?.(projectId);
      if (!lk) throw new ImageServiceError('PROJECT_UNAVAILABLE', 'The project is not served now.');
      const got = await downloadAsset(lk, item.url, {
        hosts: this.o.images.assetHosts,
        priority: 'P2',
        opId: 'images.migrate_staging',
      });
      const sha = createHash('sha256').update(got.bytes).digest('hex');
      if (sha !== row.webp.sha256) {
        leftAlone.push({
          id: item.id,
          name: item.name,
          why: `its stored bytes (${sha.slice(0, 12)}…) are not the ones staged (${row.webp.sha256.slice(0, 12)}…)`,
        });
        continue;
      }
      await this.checkStagingDisk(got.bytes.length);
      await this.stagedBytes.put(got.bytes);
      this.store.updateUpload(projectId, row.id, {
        serverSha256: sha,
        legacyAssetId: item.id,
        assetId: null,
        folderId: null,
        folderPath: null,
      });
      copied.push(row.id);
      toDelete.push(item.id);
    }
    const base = { folder: folder.id, copied, alreadyOnServer, leftAlone };
    if (pending)
      return {
        ...base,
        proposalId: null,
        pendingProposalId: pending,
        message: `A migration proposal (${pending}) is already waiting for the owner; nothing new was proposed.`,
      };
    const empties = leftAlone.length === 0;
    if (toDelete.length === 0 && !empties)
      return { ...base, proposalId: null, message: 'Nothing the bridge can remove: see leftAlone.' };
    const steps: StepSpec[] = [
      ...toDelete.map((id) => ({
        op: 'deleteAsset',
        params: { path: { assetId: id } },
        journalOperation: { tool: 'migrate_staging', write: `the hidden staged asset ${id}` },
      })),
      ...(empties
        ? [
            {
              op: 'deleteAsset',
              params: { path: { assetId: folder.id } },
              journalOperation: { tool: 'migrate_staging', write: `the empty folder “${name}”` },
            },
          ]
        : []),
    ];
    const summary = `migrate-staging: delete ${toDelete.length} hidden staged image(s) from “${name}” (now kept on the bridge’s server)${empties ? `, then the empty folder “${name}”` : `; the folder stays (${leftAlone.length} item(s) the bridge does not know)`}`;
    const submitted = await this.o.engine.submit({
      kind: 'batch_ops',
      project: projectId,
      steps,
      onError: 'stop',
      priority: 'P2',
      origin: { kind: 'ui', client: 'owner', tool: 'images.migrate_staging', detail: by },
      title: summary.slice(0, 300),
      forceProposal: true,
      proposal: { summary },
    });
    const proposalId = 'proposalId' in submitted ? submitted.proposalId : null;
    if (record && proposalId) {
      const mid = this.store.requestMigration(projectId, by);
      this.store.claimMigration(mid);
      this.store.finishMigration(mid, 'done', { copied, direct: true }, proposalId);
    }
    return {
      ...base,
      proposalId,
      message: proposalId
        ? `Proposal ${proposalId} deletes them${empties ? ' and the folder' : ''}; approve it on the Proposals page.`
        : 'Submitted.',
    };
  }

  /** Kept bytes past their retention are removed (hourly). */
  async expireKept(): Promise<number> {
    const gone = this.store.expireKept(this.o.now());
    for (const sha of gone) await this.bytes.remove(sha);
    return gone.length;
  }

  // ============================================================================================ destinations

  destinationDeps(): DestinationDeps | null {
    const plan = this.o.assets.planDeps();
    return plan ? { plan, types: (p) => this.o.registry.forProject(p) } : null;
  }

  stagingFolderName(projectId: string): string {
    const v = this.o.projectSettings(projectId).imageStagingFolder;
    return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_STAGING_FOLDER;
  }

  plan(projectId: string, input: DestinationInput): DestinationResult {
    const deps = this.destinationDeps();
    if (!deps) {
      return {
        ok: false,
        error: { code: 'REPOSITORY_TREE_NOT_READY', message: 'The planner has no repository tree.' },
      };
    }
    return planDestination(projectId, input, deps);
  }

  planStaging(projectId: string): DestinationResult {
    const deps = this.destinationDeps();
    if (!deps) {
      return {
        ok: false,
        error: { code: 'REPOSITORY_TREE_NOT_READY', message: 'The planner has no repository tree.' },
      };
    }
    return planStaging(projectId, this.stagingFolderName(projectId), deps);
  }

  // ============================================================================================ intake

  convert(bytes: Uint8Array): Promise<ConvertedImage> {
    return this.queue.convert(bytes);
  }

  /**
   * An earlier upload of the same original in this project that still stands (uploaded, its asset not known to be
   * deleted) or is still under way; null when there is none.
   */
  findDuplicate(projectId: string, originalSha256: string): ImageUploadRow | null {
    for (const r0 of this.store.byOriginal(projectId, originalSha256)) {
      const r = this.settle(r0);
      if (r.state === 'uploading') return r;
      // v3 F2: an image waiting on the bridge's server is that image too.
      if (r.state === 'uploaded' && r.staged && r.serverSha256) return r;
      if (r.state !== 'uploaded' || !r.assetId) continue;
      if (!this.assetMayExist(projectId, r.assetId)) continue;
      return r;
    }
    return null;
  }

  /** False only when the asset tree is built and knows the asset is gone. */
  private assetMayExist(projectId: string, assetId: string): boolean {
    try {
      const a = this.o.assets.queries.asset(projectId, assetId);
      if (a.tree.status === 'not_built' || a.tree.status === 'building') return true;
      return a.data !== null || this.o.assets.store.tombstone(projectId, assetId) === undefined;
    } catch {
      return true;
    }
  }

  /**
   * v3 F2 (ADR 0049 decision 10): stages an image on the bridge's server: the converted WebP is kept in images/staged/
   * (refused when the disk is below IMAGE_STAGING_MIN_FREE_GB), and recorded with its hashes, size, dimensions,
   * intended destination and extension-free name. Nothing is sent to LegendKeeper.
   */
  async stageOnServer(p: Omit<StartUpload, 'plan' | 'staged'>): Promise<ImageUploadRow> {
    const out = p.image.output;
    await this.checkStagingDisk(out.bytes);
    const sha = await this.stagedBytes.put(out.data);
    return this.store.insertUpload({
      projectId: p.projectId,
      id: newId(),
      jobId: null,
      serverSha256: sha,
      name: p.name,
      description: p.description ?? null,
      folderId: null,
      folderPath: null,
      staged: true,
      intended: p.intended ?? null,
      source: p.source,
      principalId: p.origin.principal?.principalId ?? 'system',
      original: {
        format: p.image.source.format,
        sha256: p.image.source.sha256,
        bytes: p.image.source.bytes,
        orientation: p.image.source.orientation,
      },
      webp: { sha256: out.sha256, bytes: out.bytes },
      width: out.width,
      height: out.height,
      frames: out.frames,
      hasAlpha: out.hasAlpha,
      conversionMode: p.image.mode,
      quality: p.image.quality,
      convertMs: p.image.ms,
    });
  }

  /** v3 F2: refuses a new staged image when the image store's disk is below its headroom. */
  async checkStagingDisk(adding: number): Promise<void> {
    const min = this.o.images.stagingMinFreeBytes;
    if (min <= 0) return;
    const free = await this.freeBytes();
    if (free !== null && free - adding < min)
      throw new ImageServiceError(
        'STAGING_DISK_LOW',
        `The bridge’s image store has ${Math.floor(free / 1_048_576)} MiB free, below the ${Math.round(min / 1_073_741_824)} GiB it keeps (IMAGE_STAGING_MIN_FREE_GB). Nothing was staged: place or discard staged images, or free disk space.`,
        { freeBytes: free, minFreeBytes: min },
      );
  }

  /** The free bytes where the image store lives (null when it cannot be told). Overridable in tests. */
  freeBytes: () => Promise<number | null> = async () => {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const st = await statfs(this.dir);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return null;
    }
  };

  /** v3 F2: the bytes of a staged image on the server (the Staging page's thumbnail), or null. */
  async stagedImage(projectId: string, stagedId: string): Promise<Buffer | null> {
    const r = this.store.upload(projectId, stagedId);
    if (!r?.serverSha256) return null;
    return this.stagedBytes.get(r.serverSha256);
  }

  /** v3 F2: days an unplaced staged image is kept (the project's imageStagingMaxDays, else IMAGE_STAGING_MAX_DAYS). */
  stagingMaxDays(projectId: string): number {
    const v = (this.o.projectSettings(projectId) as { imageStagingMaxDays?: unknown }).imageStagingMaxDays;
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : this.o.images.stagingMaxDays;
  }

  /**
   * v3 F2: an unplaced image staged on the server past its project's maximum age is first WARNED about (the Staging page
   * shows it, with the date it goes), and removed from the server a week after that warning. Never one being placed.
   */
  async expireStaged(projectIds?: readonly string[]): Promise<{ warned: number; removed: number }> {
    let warned = 0;
    let removed = 0;
    const now = this.o.now();
    const projects = projectIds ?? this.store.projectsWithStaged();
    for (const projectId of projects) {
      const maxMs = this.stagingMaxDays(projectId) * DAY;
      for (const r of this.store.staged(projectId)) {
        if (!r.staged || !r.serverSha256 || r.state !== 'uploaded') continue;
        if (r.placementJobId || r.placementProposalId) continue;
        if (now - r.createdAt < maxMs) continue;
        if (r.expiryWarnedAt === null) {
          this.store.updateUpload(projectId, r.id, { expiryWarnedAt: now });
          warned++;
          continue;
        }
        if (now - r.expiryWarnedAt < STAGING_EXPIRY_WARNING_MS) continue;
        await this.dropStaged(r, 'expired', 'system');
        removed++;
      }
    }
    return { warned, removed };
  }

  /** v3 F2: a staged image's server copy removed (discarded or expired): its bytes go unless another row needs them. */
  private async dropStaged(r: ImageUploadRow, why: 'discarded' | 'expired', by: string): Promise<void> {
    const sha = r.serverSha256;
    this.store.updateUpload(r.projectId, r.id, {
      state: 'discarded',
      staged: false,
      serverSha256: null,
      discardedAt: this.o.now(),
      discardedBy: by,
      error:
        why === 'expired'
          ? `removed from the server after ${this.stagingMaxDays(r.projectId)} days unplaced`
          : null,
    });
    if (sha && !this.store.serverShaInUse(sha)) await this.stagedBytes.remove(sha);
  }

  /** Submits the upload job and records the upload. */
  async startUpload(
    p: StartUpload,
  ): Promise<{ row: ImageUploadRow | null; submitted: SubmitResult | ProposalCaptured | null }> {
    // v3 F2 (ADR 0049 decision 10): a staged image waits on the bridge's server; nothing is sent to LegendKeeper.
    if (p.staged && p.stageIn !== 'legendkeeper')
      return { row: await this.stageOnServer(p), submitted: null };
    const plan = p.plan;
    const creates = plan.wouldCreate.map((s) => s.name);
    const parentId =
      creates.length > 0
        ? (plan.wouldCreate[0]!.parentFolderId ?? null)
        : (plan.destination.folderId ?? null);
    const out = p.image.output;
    if (this.o.uploadedBytes) await this.o.uploadedBytes(out.data).catch(() => undefined);
    const submitted = await this.o.engine.submit({
      kind: 'upload_image',
      project: p.projectId,
      contentType: out.contentType,
      contentLength: out.bytes,
      contentHash: out.sha256,
      dataBase64: out.data.toString('base64'),
      name: p.name,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(parentId !== null ? { folderId: parentId } : {}),
      ...(creates.length > 0 ? { createFolders: creates } : {}),
      verifyStored: true,
      ...(p.staged ? { hide: true, staging: true } : {}),
      origin: p.origin,
      priority: p.priority ?? 'P1',
      title: `${p.staged ? 'stage' : 'upload'} image: ${p.name} → ${plan.destination.path.join(' / ')}`.slice(
        0,
        300,
      ),
    });
    if (!('jobId' in submitted)) return { row: null, submitted };
    const row = this.store.insertUpload({
      projectId: p.projectId,
      id: newId(),
      jobId: submitted.jobId,
      name: p.name,
      description: p.description ?? null,
      folderId: plan.destination.folderId,
      folderPath: plan.destination.path,
      staged: p.staged,
      intended: p.intended ?? null,
      source: p.source,
      principalId: p.origin.principal?.principalId ?? 'system',
      original: {
        format: p.image.source.format,
        sha256: p.image.source.sha256,
        bytes: p.image.source.bytes,
        orientation: p.image.source.orientation,
      },
      webp: { sha256: out.sha256, bytes: out.bytes },
      width: out.width,
      height: out.height,
      frames: out.frames,
      hasAlpha: out.hasAlpha,
      conversionMode: p.image.mode,
      quality: p.image.quality,
      convertMs: p.image.ms,
    });
    return { row, submitted };
  }

  // ============================================================================================ announcing

  /** Sends the dashboard's `staging` event for a change to a staged image (never for an image that was never staged). */
  private announce(after: ImageUploadRow, before: ImageUploadRow | undefined): void {
    if (!after.staged && !before?.staged) return;
    const change: JobEngineEvents['staging']['change'] =
      before === undefined
        ? 'created'
        : after.state === 'failed' && before.state !== 'failed'
          ? 'failed'
          : after.state === 'discarded' && before.state !== 'discarded'
            ? 'discarded'
            : before.staged && !after.staged && after.state === 'uploaded'
              ? 'placed'
              : before.state === 'uploading' && after.state === 'uploaded'
                ? 'uploaded'
                : 'updated';
    try {
      const staged = this.store.staged(after.projectId).filter((r) => r.staged && r.state !== 'failed');
      const oldBefore = this.o.now() - this.o.images.stagingReportDays * DAY;
      this.o.engine.events.emit('staging', {
        projectId: after.projectId,
        stagedId: after.id,
        change,
        name: after.name,
        state: after.state,
        source: after.source,
        staged: staged.length,
        old: staged.filter((r) => r.createdAt < oldBefore).length,
      });
    } catch (err) {
      this.o.log?.warn({ err, stagedId: after.id }, 'the staging event could not be sent');
    }
  }

  // ============================================================================================ following the jobs

  private onJobEnded(job: JobView): void {
    try {
      for (const r of this.store.uploading(job.projectId)) if (r.jobId === job.id) this.settle(r);
      // A placement proposed at scope `propose` and approved since has no job id on its record yet: settle every open one
      // (the approval's job is this one, or another's; settling reads the proposal and the job and does only what is due).
      for (const r of this.store.staged(job.projectId))
        if (r.placementJobId === job.id || r.discardJobId === job.id || r.placementProposalId) this.settle(r);
    } catch (err) {
      this.o.log?.warn({ err, jobId: job.id }, 'an image record could not be settled from its job');
    }
  }

  /** Brings a record up to date with its jobs and proposal (see the module comment). Returns the row as it now is. */
  settle(row: ImageUploadRow): ImageUploadRow {
    let r = row;
    const job = (id: string | null) => (id ? this.o.engine.queries.getJob(r.projectId, id) : undefined);
    if (r.state === 'uploading') {
      const j = job(r.jobId);
      if (j && TERMINAL_JOB_STATUSES.has(j.status)) {
        const res = (j.result ?? {}) as {
          asset?: Record<string, unknown>;
          stored?: {
            storedBytesVerified?: unknown;
            storedSha256?: unknown;
            reason?: unknown;
            storedBytes?: unknown;
          };
          hidden?: unknown;
        };
        const assetId = typeof res.asset?.id === 'string' ? res.asset.id : null;
        const verified = res.stored?.storedBytesVerified === true;
        const ok = j.status === 'succeeded' && assetId !== null;
        r =
          this.store.updateUpload(r.projectId, r.id, {
            state: ok ? 'uploaded' : 'failed',
            assetId,
            ...(typeof res.asset?.folderId === 'string' || res.asset?.folderId === null
              ? { folderId: res.asset.folderId ?? null }
              : {}),
            storedVerified: assetId ? verified : null,
            storedSha256: typeof res.stored?.storedSha256 === 'string' ? res.stored.storedSha256 : null,
            verifyReason: verified
              ? null
              : typeof res.stored?.reason === 'string'
                ? res.stored.reason
                : assetId
                  ? 'the stored file was not checked'
                  : null,
            error: ok
              ? r.staged && res.hidden === false
                ? 'the image could not be hidden in the staging folder'
                : null
              : (j.lastError?.message ?? `the upload job ${j.status}`),
            ...(ok ? {} : { staged: false }),
          }) ?? r;
        if (ok && verified && assetId) {
          try {
            this.o.assets.store.recordHash(r.projectId, assetId, r.webp.sha256, r.webp.bytes);
          } catch {
            // the asset tree may not hold the row yet; the hash is on the image record either way
          }
        }
      }
    }
    if (r.staged && r.placementProposalId && !r.placementJobId) {
      const p = this.o.proposals?.get(r.placementProposalId);
      if (p?.jobId) r = this.store.updateUpload(r.projectId, r.id, { placementJobId: p.jobId }) ?? r;
      else if (p && ['rejected', 'expired', 'conflicted', 'failed'].includes(p.state)) {
        r =
          this.store.updateUpload(r.projectId, r.id, {
            placementProposalId: null,
            error: `the placement proposal was ${p.state}`,
          }) ?? r;
      }
    }
    if (r.staged && r.placementJobId && r.serverSha256) {
      // v3 F2 (ADR 0049 decision 10): a placement that uploaded the image from the server into its final folder.
      const j = job(r.placementJobId);
      if (j && TERMINAL_JOB_STATUSES.has(j.status)) r = this.settleServerPlacement(r, j);
    }
    if (r.staged && r.placementJobId && !r.serverSha256) {
      const j = job(r.placementJobId);
      if (j && TERMINAL_JOB_STATUSES.has(j.status)) {
        const res = (j.result ?? {}) as { verified?: unknown };
        if (j.status === 'succeeded') {
          const intended = (r.intended ?? {}) as {
            placing?: { name?: string; path?: string[]; folderId?: string | null };
          };
          const folderId = this.placedFolder(j, r.assetId) ?? intended.placing?.folderId ?? null;
          r =
            this.store.updateUpload(r.projectId, r.id, {
              staged: false,
              placedAt: j.finishedAt ?? this.o.now(),
              placedBy: j.approvedBy ?? j.principalId,
              folderId,
              ...(intended.placing?.path ? { folderPath: intended.placing.path } : {}),
              ...(intended.placing?.name ? { name: intended.placing.name } : {}),
              error:
                res.verified === false
                  ? 'placed, but the read back did not match the plan (see the job)'
                  : null,
            }) ?? r;
        } else {
          r =
            this.store.updateUpload(r.projectId, r.id, {
              placementJobId: null,
              placementProposalId: null,
              error: `placing failed: ${j.lastError?.message ?? j.status}`,
            }) ?? r;
        }
      }
    }
    if (r.discardJobId && r.state !== 'discarded') {
      const j = job(r.discardJobId);
      if (j && TERMINAL_JOB_STATUSES.has(j.status)) {
        r =
          (j.status === 'succeeded'
            ? this.store.updateUpload(r.projectId, r.id, {
                state: 'discarded',
                staged: false,
                discardedAt: j.finishedAt ?? this.o.now(),
                error: null,
              })
            : this.store.updateUpload(r.projectId, r.id, {
                discardJobId: null,
                discardedBy: null,
                error: `discarding failed: ${j.lastError?.message ?? j.status}`,
              })) ?? r;
      }
    }
    return r;
  }

  /**
   * v3 F2: the end of a placement that uploaded a server-staged image: the asset its createImageAsset made, whether the
   * stored file's SHA-256 matched (`upload_image.verify`), and the folder used; the server copy goes once it is placed.
   */
  private settleServerPlacement(r: ImageUploadRow, j: JobView): ImageUploadRow {
    const steps = this.o.engine.stepResults(r.projectId, j.id) ?? [];
    const at = ((r.intended ?? {}) as { placing?: { assetStep?: number } }).placing?.assetStep ?? 0;
    const asset = steps.find((s) => s.stepNo === at && s.status === 'succeeded');
    const a = (asset?.value ?? {}) as { id?: unknown; folderId?: unknown };
    const verify = steps.find((s) => s.stepNo === at + 1 && s.status === 'succeeded');
    const v = (verify?.value ?? {}) as {
      storedBytesVerified?: unknown;
      storedSha256?: unknown;
      reason?: unknown;
    };
    const assetId = typeof a.id === 'string' ? a.id : null;
    // v3 F3a (ADR 0050): the image is placed once ITS asset was created, even when a later step of the same job (a
    // setting pack's page writes) stopped it: the asset exists in LegendKeeper, so it must never be uploaded again.
    if (assetId && (j.status === 'succeeded' || asset !== undefined)) {
      const intended = (r.intended ?? {}) as {
        placing?: { name?: string; path?: string[]; folderId?: string | null };
      };
      const verified = v.storedBytesVerified === true;
      const sha = r.serverSha256;
      const res = (j.result ?? {}) as { verified?: unknown };
      const after =
        this.store.updateUpload(r.projectId, r.id, {
          assetId,
          staged: false,
          serverSha256: null,
          placedAt: j.finishedAt ?? this.o.now(),
          placedBy: j.approvedBy ?? j.principalId,
          folderId: typeof a.folderId === 'string' ? a.folderId : (intended.placing?.folderId ?? null),
          ...(intended.placing?.path ? { folderPath: intended.placing.path } : {}),
          ...(intended.placing?.name ? { name: intended.placing.name } : {}),
          storedVerified: verified,
          storedSha256: typeof v.storedSha256 === 'string' ? v.storedSha256 : null,
          verifyReason: verified
            ? null
            : typeof v.reason === 'string'
              ? v.reason
              : 'the stored file was not checked',
          error:
            j.status !== 'succeeded'
              ? `placed, but the job that placed it then stopped: ${j.lastError?.message ?? j.status}`
              : res.verified === false
                ? 'placed, but the read back did not match the plan (see the job)'
                : null,
        }) ?? r;
      if (verified) {
        try {
          this.o.assets.store.recordHash(r.projectId, assetId, r.webp.sha256, r.webp.bytes);
        } catch {
          // the asset tree may not hold the row yet
        }
      }
      if (sha && !this.store.serverShaInUse(sha))
        void this.stagedBytes
          .remove(sha)
          .catch((err: unknown) =>
            this.o.log?.warn({ err, stagedId: r.id }, 'a placed image’s server copy could not be removed'),
          );
      return after;
    }
    return (
      this.store.updateUpload(r.projectId, r.id, {
        placementJobId: null,
        placementProposalId: null,
        error: `placing failed: ${j.lastError?.message ?? j.status}`,
      }) ?? r
    );
  }

  /** The folder a placement put the asset in, as the asset tree read it back after the move (in the same job). */
  private placedFolder(j: JobView, assetId: string | null): string | null {
    if (!assetId) return null;
    try {
      const a = this.o.assets.queries.asset(j.projectId, assetId).data;
      return a ? a.folderId : null;
    } catch {
      return null;
    }
  }

  // ============================================================================================ staging

  /** A staged image of this project by its staged id (settled), or undefined. */
  staged(projectId: string, stagedId: string): ImageUploadRow | undefined {
    const r = this.store.upload(projectId, stagedId);
    return r ? this.settle(r) : undefined;
  }

  listStaged(projectId: string): ImageUploadRow[] {
    return this.store
      .staged(projectId)
      .map((r) => this.settle(r))
      .filter((r) => r.staged && r.state !== 'failed');
  }

  /** Staged images older than IMAGE_STAGING_REPORT_DAYS (reported on the dashboard; never removed automatically). */
  oldStaged(projectId: string): ImageUploadRow[] {
    const before = this.o.now() - this.o.images.stagingReportDays * DAY;
    return this.listStaged(projectId).filter((r) => r.createdAt < before);
  }

  /**
   * Places a staged image: ONE batch job (or proposal at scope `propose`): the missing folders in order, then
   * `updateAsset` (move, unhide, optionally rename), then a read back.
   */
  async place(p: {
    readonly projectId: string;
    readonly row: ImageUploadRow;
    readonly plan: AssetPlan;
    readonly rename?: string | undefined;
    readonly origin: JobOrigin;
    readonly tool: string;
    readonly described?: Record<string, unknown>;
  }): Promise<{ submitted: SubmitResult | ProposalCaptured; labels: string[] }> {
    const row = p.row;
    if (!row.staged || row.state !== 'uploaded' || (!row.assetId && !row.serverSha256)) {
      throw new ImageServiceError(
        'NOT_STAGED',
        `${row.id} is not a staged image ready to be placed (it is ${row.state}${row.staged ? '' : ', not staged'}).`,
      );
    }
    if (row.placementProposalId || row.placementJobId || row.discardJobId) {
      throw new ImageServiceError(
        'STAGED_BUSY',
        `${row.id} is already being ${row.discardJobId ? 'discarded' : 'placed'} (${row.placementProposalId ? `proposal ${row.placementProposalId}` : `job ${row.placementJobId ?? row.discardJobId}`}).`,
      );
    }
    if (p.plan.destination.path.length === 0)
      throw new ImageServiceError(
        'DESTINATION_IS_ROOT',
        'An image is never placed in the asset library’s root: give a folder (Visual References, “Intake and approval”).',
      );
    // v3 F2 (ADR 0049 decision 10): an image waiting on the bridge's server is uploaded straight into its final folder.
    if (row.serverSha256 && !row.assetId) return this.placeFromServer(p);
    const plan = p.plan;
    const steps: StepSpec[] = [];
    const labels: string[] = [];
    const creates = plan.wouldCreate;
    creates.forEach((c, i) => {
      steps.push({
        op: 'createAssetFolder',
        params: {
          body: { name: c.name, ...(i === 0 && c.parentFolderId ? { folderId: c.parentFolderId } : {}) },
        },
        ...(i > 0 ? { bindFrom: { step: i, to: 'body.folderId' as const } } : {}),
        // v3 F2 (ADR 0049 decision 9): found or created when the job runs (another placement may have made it since).
        findOrCreate: true,
        journalOperation: { tool: p.tool, write: `folder ${c.path.join(' / ')}` },
      });
      labels.push(`create folder ${c.path.join(' / ')}`);
    });
    const name = p.rename?.trim() || row.name;
    const body: Record<string, unknown> = {
      isHidden: false,
      ...(creates.length === 0 ? { folderId: plan.destination.folderId } : {}),
      ...(name !== row.name ? { name } : {}),
    };
    steps.push({
      op: 'updateAsset',
      params: { path: { assetId: row.assetId! }, body },
      ...(creates.length > 0 ? { bindFrom: { step: creates.length, to: 'body.folderId' as const } } : {}),
    });
    labels.push(
      `move ${row.assetId} to ${plan.destination.path.join(' / ')}, unhide${name !== row.name ? `, rename to “${name}”` : ''}`,
    );
    steps.push({
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'asset',
              label: `image “${name}”`,
              assetId: row.assetId,
              fields: {
                isHidden: false,
                name,
                ...(creates.length === 0 ? { folderId: plan.destination.folderId } : {}),
              },
              ...(creates.length > 0 ? { folderFrom: { step: creates.length } } : {}),
            },
          ],
        },
      },
    });
    labels.push('verify');
    const summary = `${p.tool}: place staged image “${name}” in ${plan.destination.path.join(' / ')}${creates.length ? ` (creating ${creates.map((c) => c.name).join(' / ')})` : ''}`;
    const submitted = await this.o.engine.submit({
      kind: 'batch_ops',
      project: p.projectId,
      steps,
      onError: 'stop',
      priority: 'P1',
      origin: p.origin,
      title: summary.slice(0, 300),
      internal: true,
      proposal: {
        summary,
        operations: [
          {
            kind: 'place_image',
            stagedId: row.id,
            assetId: row.assetId,
            name,
            from: row.folderPath ?? null,
            to: plan.destination.path,
            createsFolders: creates.map((c) => c.path.join(' / ')),
            image: {
              format: row.original.format,
              width: row.width,
              height: row.height,
              frames: row.frames,
              bytes: row.webp.bytes,
              storedBytesVerified: row.storedVerified,
            },
            ...(p.described ? { destination: p.described } : {}),
          },
        ],
      },
    });
    const placing = { name, path: plan.destination.path, folderId: plan.destination.folderId };
    this.store.updateUpload(p.projectId, row.id, {
      ...('jobId' in submitted
        ? { placementJobId: submitted.jobId }
        : { placementProposalId: submitted.proposalId }),
      intended: { ...(row.intended ?? {}), placing },
      error: null,
    });
    return { submitted, labels };
  }

  /**
   * v3 F2 (ADR 0049 decision 10): places an image staged on the server, in the order of Visual References' “Intake and
   * approval”: the destination resolved deterministically (the plan: ambiguity refused, never the library's root), a
   * collision check on the display name in that folder (numbered: “Name (2)”), the WebP's type, length and SHA-256 from
   * the converted bytes, the folders found or created (when the job runs, under the asset-folder lock), the upload with
   * the final folder and extension-free name, then the stored file's SHA-256 and the asset's folder and name verified.
   * ONE batch job, or ONE proposal at scope `propose` (the bytes are read from the server when it runs).
   */
  private async placeFromServer(p: {
    readonly projectId: string;
    readonly row: ImageUploadRow;
    readonly plan: AssetPlan;
    readonly rename?: string | undefined;
    readonly origin: JobOrigin;
    readonly tool: string;
    readonly described?: Record<string, unknown>;
  }): Promise<{ submitted: SubmitResult | ProposalCaptured; labels: string[] }> {
    const row = p.row;
    const plan = p.plan;
    const creates = plan.wouldCreate;
    const wanted = p.rename?.trim() || row.name;
    const name = creates.length > 0 ? wanted : this.freeName(p.projectId, plan.destination.folderId, wanted);
    const steps: StepSpec[] = [];
    const labels: string[] = [];
    creates.forEach((c, i) => {
      steps.push({
        op: 'createAssetFolder',
        params: {
          body: { name: c.name, ...(i === 0 && c.parentFolderId ? { folderId: c.parentFolderId } : {}) },
        },
        ...(i > 0 ? { bindFrom: { step: i, to: 'body.folderId' as const } } : {}),
        findOrCreate: true,
        journalOperation: { tool: p.tool, write: `folder ${c.path.join(' / ')}` },
      });
      labels.push(`create folder ${c.path.join(' / ')}`);
    });
    const contentHash = row.webp.sha256;
    steps.push({
      op: 'createImageUpload',
      params: { body: { contentType: 'image/webp', contentLength: row.webp.bytes, contentHash } },
    });
    labels.push('create the upload');
    steps.push({
      op: 'upload_image.put',
      params: {
        body: {
          contentType: 'image/webp',
          contentLength: row.webp.bytes,
          contentHash,
          stagedSha256: row.serverSha256!,
        },
      },
    });
    labels.push('send the file (from the bridge’s server)');
    const assetStep = steps.length + 1;
    steps.push({
      op: 'createImageAsset',
      params: {
        body: {
          uploadKey: 'pending',
          name,
          ...(row.description ? { description: row.description } : {}),
          folderId: creates.length > 0 ? 'pending' : plan.destination.folderId!,
        },
      },
      ...(creates.length > 0 ? { bindFrom: { step: creates.length, to: 'body.folderId' as const } } : {}),
      journalOperation: { tool: p.tool, write: `image “${name}”`, stagedId: row.id },
    });
    labels.push(`create the image “${name}” in ${plan.destination.path.join(' / ')}`);
    steps.push({
      op: 'upload_image.verify',
      params: { body: { assetStep, contentLength: row.webp.bytes, contentHash } },
    });
    labels.push('verify the stored file');
    steps.push({
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'asset',
              label: `image “${name}”`,
              assetFrom: { step: assetStep },
              fields: {
                isHidden: false,
                name,
                ...(creates.length === 0 ? { folderId: plan.destination.folderId } : {}),
              },
              ...(creates.length > 0 ? { folderFrom: { step: creates.length } } : {}),
            },
          ],
        },
      },
    });
    labels.push('verify');
    const summary = `${p.tool}: place staged image “${name}” in ${plan.destination.path.join(' / ')}${creates.length ? ` (creating ${creates.map((c) => c.name).join(' / ')})` : ''}; uploaded from the bridge’s server when approved`;
    const submitted = await this.o.engine.submit({
      kind: 'batch_ops',
      project: p.projectId,
      steps,
      onError: 'stop',
      priority: 'P1',
      origin: p.origin,
      title: summary.slice(0, 300),
      internal: true,
      stagedPlacement: true,
      proposal: {
        summary,
        operations: [
          {
            kind: 'place_image',
            stagedId: row.id,
            name,
            ...(name !== wanted
              ? { renamedFrom: wanted, why: 'an image of that name is already in the folder' }
              : {}),
            to: plan.destination.path,
            createsFolders: creates.map((c) => c.path.join(' / ')),
            image: {
              format: row.original.format,
              width: row.width,
              height: row.height,
              frames: row.frames,
              bytes: row.webp.bytes,
              sha256: row.webp.sha256,
            },
            ...(p.described ? { destination: p.described } : {}),
          },
        ],
      },
    });
    const placing = { name, path: plan.destination.path, folderId: plan.destination.folderId, assetStep };
    this.store.updateUpload(p.projectId, row.id, {
      ...('jobId' in submitted
        ? { placementJobId: submitted.jobId }
        : { placementProposalId: submitted.proposalId }),
      intended: { ...(row.intended ?? {}), placing },
      error: null,
    });
    return { submitted, labels };
  }

  /**
   * v3 F2: a display name free in the folder (the asset tree's view): the name itself, or “Name (2)”, “Name (3)”, ….
   * Names are compared as LegendKeeper stores them (exactly). A folder the job creates is empty: no check is needed.
   */
  freeName(projectId: string, folderId: string | null, name: string): string {
    let taken: Set<string>;
    try {
      const c = this.o.assets.store.children(projectId, folderId);
      taken = new Set(c.items.map((i) => i.name));
    } catch {
      return name;
    }
    if (!taken.has(name)) return name;
    for (let n = 2; n < 1000; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
    return name;
  }

  /**
   * v3 F3b (ADR 0052; design section 6): the placement proposal a setting pack's package may take over: the image's OWN
   * placement (made by upload_image at scope `propose`), still pending, and its only activity. Null when anything else
   * is going on (another package's proposal, an approved or running placement, a discard): that stays STAGED_IMAGE_BUSY.
   */
  ownPendingPlacement(row: ImageUploadRow): string | null {
    if (!row.staged || row.placementJobId || row.discardJobId || !row.placementProposalId) return null;
    const p = this.o.proposals?.get(row.placementProposalId);
    if (!p || p.state !== 'pending' || p.jobId) return null;
    if (!this.o.proposals?.isImagePlacement?.(row.placementProposalId, row.id)) return null;
    return row.placementProposalId;
  }

  /**
   * v3 F3b: withdraws that proposal for the package `by` (its proposal or job id), recorded as "superseded by package
   * <by>"; the image's record then follows the package. False when the proposal is no longer pending (decided meanwhile:
   * the package's own job checks the image is still unplaced before it writes anything).
   */
  supersedePlacement(projectId: string, stagedId: string, proposalId: string, by: string): boolean {
    const row = this.store.upload(projectId, stagedId);
    if (!row || row.placementProposalId !== proposalId) return false;
    const ok = this.o.proposals?.supersede?.(proposalId, `superseded by package ${by}`) ?? false;
    if (ok)
      this.store.updateUpload(projectId, stagedId, {
        placementProposalId: null,
        error: null,
      });
    return ok;
  }

  /** Discards a staged image: deletes the asset (its bytes are kept first, by the delete keeper). */
  async discard(p: {
    readonly projectId: string;
    readonly row: ImageUploadRow;
    readonly origin: JobOrigin;
    readonly by: string;
  }): Promise<SubmitResult | ProposalCaptured | { readonly status: 'discarded' }> {
    const row = p.row;
    if (!row.staged || row.state !== 'uploaded' || (!row.assetId && !row.serverSha256)) {
      throw new ImageServiceError(
        'NOT_STAGED',
        `${row.id} is not a staged image (it is ${row.state}${row.staged ? '' : ', not staged'}).`,
      );
    }
    if (row.placementJobId || row.placementProposalId || row.discardJobId) {
      throw new ImageServiceError('STAGED_BUSY', `${row.id} is already being placed or discarded.`);
    }
    // v3 F2: an image staged on the server is simply removed from it: nothing is in LegendKeeper.
    if (row.serverSha256 && !row.assetId) {
      await this.dropStaged(row, 'discarded', p.by);
      return { status: 'discarded' };
    }
    const submitted = await this.o.engine.submit({
      kind: 'batch_ops',
      project: p.projectId,
      steps: [{ op: 'deleteAsset', params: { path: { assetId: row.assetId! } } }],
      onError: 'stop',
      priority: 'P1',
      origin: p.origin,
      title: `discard staged image: ${row.name}`,
    });
    if ('jobId' in submitted) {
      this.store.updateUpload(p.projectId, row.id, { discardJobId: submitted.jobId, discardedBy: p.by });
    }
    return submitted;
  }
}

export function createImages(o: ImageServiceOptions): ImageService {
  return new ImageService(o);
}
