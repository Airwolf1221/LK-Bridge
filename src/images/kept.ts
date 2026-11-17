/**
 * Asset deletes keep their bytes (v2 D3, ADR 0041; the CR-2026-11 open item).
 *
 * Before ANY `deleteAsset` is sent, through any route (the Staging page's Discard, `lk_api_write`, `lk_api_batch`,
 * `lk_op_*`), the engine's read for the journal pre-image calls this keeper (src/jobs/step-exec.ts). It downloads the
 * asset's file (anonymously, from the asset host, through the governor) and stores it content-addressed by SHA-256 in
 * the bridge's private directory (`kept-bytes/`, mode 0700, files 0600), with a reference row; the pre-image records the
 * hash. A folder's children are listed (every depth) and each image's bytes kept the same way. If the bytes cannot be
 * fetched, the delete is refused (`ASSET_BYTES_NOT_KEPT`) unless the owner has allowed this one asset on the dashboard.
 *
 * Kept bytes are removed after ASSET_BYTES_RETENTION_DAYS (default 90). v2 E1a (ADR 0042): they are objects of the
 * snapshot store (one store, not two); their reference rows expire after the retention, and the snapshot store's
 * collector removes the bytes once no reference and no snapshot needs them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobsError, type AssetDeleteKeeper } from '../jobs/index.js';
import { downloadAsset, AssetDownloadError } from './download.js';
import type { ImageStore } from './store.js';

const SHA = /^[0-9a-f]{64}$/;

/** Content-addressed files: `<dir>/<first two hex>/<sha256>`, written once, read back checked. */
export class ByteStore {
  /** `dir` is created by the first file kept (`put`), not here: see UploadSlots (ADR 0041, the image directory). */
  constructor(readonly dir: string) {}

  private pathOf(sha256: string): string {
    if (!SHA.test(sha256)) throw new Error('not a SHA-256');
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await stat(this.pathOf(sha256));
      return true;
    } catch {
      return false;
    }
  }

  /** Stores the bytes under their own hash (no-op when already there). Returns the hash. */
  async put(bytes: Uint8Array): Promise<string> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (await this.has(sha)) return sha;
    const sub = join(this.dir, sha.slice(0, 2));
    await mkdir(sub, { recursive: true, mode: 0o700 });
    const tmp = join(sub, `.${sha}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.pathOf(sha));
    return sha;
  }

  /** The bytes, or null when missing or damaged (the hash is checked). */
  async get(sha256: string): Promise<Buffer | null> {
    try {
      const b = await readFile(this.pathOf(sha256));
      return createHash('sha256').update(b).digest('hex') === sha256 ? b : null;
    } catch {
      return null;
    }
  }

  async remove(sha256: string): Promise<void> {
    await rm(this.pathOf(sha256), { force: true });
  }

  /** CR-2026-11-R2 (R2-42): the same, at once (decided and done in one tick, where the caller cannot wait). */
  removeSync(sha256: string): void {
    rmSync(this.pathOf(sha256), { force: true });
  }
}

/**
 * v2 E1a (ADR 0042): where kept bytes go. The runtime hands the snapshot store's `KeptBytes` (one store, not two);
 * `ByteStore` above is the stand-alone store D3 used, kept for callers without a snapshot store.
 */
export interface KeptByteStore {
  readonly dir: string;
  has(sha256: string): Promise<boolean>;
  put(bytes: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Buffer | null>;
  remove(sha256: string): Promise<void>;
}

export interface KeeperOptions {
  readonly store: ImageStore;
  readonly bytes: KeptByteStore;
  readonly assetHosts: readonly string[];
  readonly retentionMs: () => number;
  /** Most assets inside one folder delete (every depth) whose bytes are kept; more is refused without an override. */
  readonly maxChildren?: number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

interface Child {
  readonly id: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly folderId: string | null;
  readonly url: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The engine's `AssetDeleteKeeper` (see the module comment). */
export function createAssetDeleteKeeper(o: KeeperOptions): AssetDeleteKeeper {
  const maxChildren = o.maxChildren ?? 500;
  return async (ctx) => {
    const projectId = ctx.job.projectId;
    const asset = ctx.asset;
    const assetId = str(asset.id) ?? '(unknown)';
    const failures: string[] = [];

    const keepOne = async (a: Child): Promise<Record<string, unknown>> => {
      if (a.url === null) {
        if (a.type === 'IMAGE') failures.push(`${a.name ?? a.id}: the image has no file URL`);
        return { file: false };
      }
      try {
        const got = await downloadAsset(ctx.lk, a.url, {
          hosts: o.assetHosts,
          priority: ctx.job.priority,
          opId: 'deleteAsset.keepBytes',
          jobId: ctx.job.id,
        });
        const sha = await o.bytes.put(got.bytes);
        o.store.keepBytes(sha, got.bytes.length, got.contentType);
        const refId = o.store.addKeptRef({
          projectId,
          assetId: a.id,
          name: a.name,
          folderId: a.folderId,
          sha256: sha,
          jobId: ctx.job.id,
          stepNo: ctx.step.stepNo,
          expiresAt: o.store.now() + o.retentionMs(),
        });
        return {
          keptBytes: {
            sha256: sha,
            size: got.bytes.length,
            contentType: got.contentType,
            store: 'snapshots',
            refId,
          },
        };
      } catch (e) {
        const why = e instanceof AssetDownloadError ? e.message : e instanceof Error ? e.message : String(e);
        failures.push(`${a.name ?? a.id}: ${why}`);
        return { keptBytes: null, notKept: why };
      }
    };

    let extra: Record<string, unknown>;
    if (asset.type === 'FOLDER') {
      // Every asset inside the folder at any depth (LegendKeeper deletes them all with it), listed in the job's name.
      const children: (Child & Record<string, unknown>)[] = [];
      const queue: string[] = [assetId];
      let truncated = false;
      while (queue.length > 0 && !truncated) {
        const folderId = queue.shift()!;
        let cursor: string | undefined;
        for (let page = 0; page < 1000; page++) {
          const body = (await ctx.read('listAssets', {
            query: { folderId, limit: 100, ...(cursor ? { cursor } : {}) },
          })) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
          for (const raw of Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : []) {
            if (!raw || typeof raw.id !== 'string') continue;
            if (children.length >= maxChildren) {
              truncated = true;
              break;
            }
            const c: Child = {
              id: raw.id,
              name: str(raw.name),
              type: str(raw.type),
              folderId: str(raw.folderId) ?? folderId,
              url: str(raw.url),
            };
            if (c.type === 'FOLDER') {
              queue.push(c.id);
              children.push({ ...c });
            } else children.push({ ...c, ...(await keepOne(c)) });
          }
          if (truncated || body?.hasMore !== true || typeof body.nextCursor !== 'string') break;
          cursor = body.nextCursor;
        }
      }
      if (truncated) {
        failures.push(`the folder holds more than ${maxChildren} assets; their bytes were not all kept`);
      }
      extra = { children, childCount: children.length, ...(truncated ? { childrenTruncated: true } : {}) };
    } else {
      extra = await keepOne({
        id: assetId,
        name: str(asset.name),
        type: str(asset.type),
        folderId: str(asset.folderId),
        url: str(asset.url),
      });
    }

    if (failures.length > 0) {
      if (o.store.useOverride(projectId, assetId)) {
        o.log?.warn(
          { projectId, assetId, failures },
          'asset deleted without all its bytes kept (owner override)',
        );
        return { ...extra, bytesNotKept: failures, ownerOverride: true };
      }
      throw new JobsError(
        'ASSET_BYTES_NOT_KEPT',
        `The asset ${assetId} was NOT deleted: its bytes could not be kept first (${failures.slice(0, 5).join('; ')}` +
          `${failures.length > 5 ? `; and ${failures.length - 5} more` : ''}). A deleted image must stay restorable. ` +
          'Try again later; if the file is really gone, the owner can allow this one delete on the dashboard (Staging page, ' +
          '“Allow a delete without its bytes”).',
        { jobId: ctx.job.id, stepNo: ctx.step.stepNo },
      );
    }
    return extra;
  };
}
