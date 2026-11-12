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
import { dirname, join, resolve } from 'node:path';
import type { AssetService } from '../assets/service.js';
import type { AssetPlan } from '../assets/plan.js';
import type { ImageSettings, ToolsSettings } from '../config/tools.js';
import type { Db } from '../db/open.js';
import {
  TERMINAL_JOB_STATUSES,
  type JobEngine,
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
import { ByteStore, createAssetDeleteKeeper } from './kept.js';
import { UploadSlots } from './slots.js';
import { ImageStore, type ImageUploadRow, type UploadSource } from './store.js';

export const DEFAULT_STAGING_FOLDER = 'LK-Bridge staging';
const SWEEP_MS = 60_000;
const KEPT_SWEEP_MS = 3_600_000;
const DAY = 86_400_000;

export interface ImageServiceOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly assets: AssetService;
  readonly registry: Registry;
  readonly projectSettings: (projectId: string) => ProjectSettings;
  readonly upload: ToolsSettings['upload'];
  readonly images: ImageSettings;
  /** DB_PATH, for the default image directory (`images/` next to it). */
  readonly dbPath: string;
  /** The proposal states, for placements proposed at scope `propose`. */
  readonly proposals?: {
    get(id: string): { readonly state: string; readonly jobId: string | null } | undefined;
  };
  readonly now: () => number;
  readonly log?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
  };
  /** Start the timers (default true; tests drive `sweep` themselves). */
  readonly timers?: boolean;
}

/** The directory the bridge keeps image files in (IMAGE_DATA_DIR, or `images/` next to the database). */
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
  readonly bytes: ByteStore;
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
    this.dir = imageDataDir(o.images, o.dbPath);
    this.slots = new UploadSlots(this.store, join(this.dir, 'upload-tmp'));
    this.bytes = new ByteStore(join(this.dir, 'kept-bytes'));
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
          void this.expireKept().catch((err: unknown) =>
            this.o.log?.warn({ err }, 'kept-bytes expiry failed'),
          ),
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

  /** Expired binary uploads lose their files (every minute). */
  sweep(): Promise<number> {
    return this.slots.sweep();
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

  /** Submits the upload job and records the upload. */
  async startUpload(
    p: StartUpload,
  ): Promise<{ row: ImageUploadRow | null; submitted: SubmitResult | ProposalCaptured }> {
    const plan = p.plan;
    const creates = plan.wouldCreate.map((s) => s.name);
    const parentId =
      creates.length > 0
        ? (plan.wouldCreate[0]!.parentFolderId ?? null)
        : (plan.destination.folderId ?? null);
    const out = p.image.output;
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

  // ============================================================================================ following the jobs

  private onJobEnded(job: JobView): void {
    try {
      for (const r of this.store.uploading(job.projectId)) if (r.jobId === job.id) this.settle(r);
      for (const r of this.store.staged(job.projectId))
        if (r.placementJobId === job.id || r.discardJobId === job.id) this.settle(r);
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
    if (r.staged && r.placementJobId) {
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
    if (!row.staged || row.state !== 'uploaded' || !row.assetId) {
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
      params: { path: { assetId: row.assetId }, body },
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

  /** Discards a staged image: deletes the asset (its bytes are kept first, by the delete keeper). */
  async discard(p: {
    readonly projectId: string;
    readonly row: ImageUploadRow;
    readonly origin: JobOrigin;
    readonly by: string;
  }): Promise<SubmitResult | ProposalCaptured> {
    const row = p.row;
    if (!row.staged || row.state !== 'uploaded' || !row.assetId) {
      throw new ImageServiceError(
        'NOT_STAGED',
        `${row.id} is not a staged image (it is ${row.state}${row.staged ? '' : ', not staged'}).`,
      );
    }
    if (row.placementJobId || row.placementProposalId || row.discardJobId) {
      throw new ImageServiceError('STAGED_BUSY', `${row.id} is already being placed or discarded.`);
    }
    const submitted = await this.o.engine.submit({
      kind: 'batch_ops',
      project: p.projectId,
      steps: [{ op: 'deleteAsset', params: { path: { assetId: row.assetId } } }],
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
