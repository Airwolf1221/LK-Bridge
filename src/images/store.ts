/**
 * The image pipeline's own records (v2 D3, ADR 0041; migration 1950): the uploads (with their hashes, sizes, dimensions
 * and conversion mode, and their staging state), the binary endpoint's single-use slots, the bytes kept before asset
 * deletes, and the owner's one-use permissions to delete without them. Every row is per project.
 */
import type { Db } from '../db/open.js';

export type UploadState = 'uploading' | 'uploaded' | 'failed' | 'discarded';
export type UploadSource =
  | 'data_base64'
  | 'url'
  | 'upload_id'
  | 'dashboard'
  | 'restore'
  /** v3 F2 (ADR 0049 decision 12): a ChatGPT conversation attachment (`file`), downloaded by the bridge. */
  | 'chatgpt_file'
  /** v3 F2 (ADR 0049 decision 10): an image migrate-staging brought from the old LegendKeeper staging folder. */
  | 'migrated';

export interface ImageUploadRow {
  readonly projectId: string;
  readonly id: string;
  readonly state: UploadState;
  readonly jobId: string | null;
  readonly assetId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly folderId: string | null;
  readonly folderPath: readonly string[] | null;
  readonly staged: boolean;
  readonly intended: Record<string, unknown> | null;
  readonly source: UploadSource;
  readonly principalId: string;
  readonly original: {
    readonly format: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly orientation: number | null;
  };
  readonly webp: { readonly sha256: string; readonly bytes: number };
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly hasAlpha: boolean;
  /** `webp_passthrough`: the bytes as given, unchanged (a WebP original, or a restore of the snapshot store's bytes). */
  readonly conversionMode: 'converted' | 'webp_passthrough';
  readonly quality: number | null;
  readonly convertMs: number | null;
  readonly storedVerified: boolean | null;
  readonly storedSha256: string | null;
  readonly verifyReason: string | null;
  readonly error: string | null;
  readonly placedAt: number | null;
  readonly placedBy: string | null;
  readonly placementJobId: string | null;
  readonly placementProposalId: string | null;
  readonly discardJobId: string | null;
  readonly discardedAt: number | null;
  readonly discardedBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * v3 F2 (ADR 0049 decision 10): a staged image whose bytes wait on the bridge's server (images/staged/), not in
   * LegendKeeper: the WebP's SHA-256 there. Null for an image staged in LegendKeeper before F2, or once placed.
   */
  readonly serverSha256: string | null;
  /** v3 F2: when the dashboard first warned that it is past IMAGE_STAGING_MAX_DAYS (removed a week later). */
  readonly expiryWarnedAt: number | null;
  /** v3 F2: the hidden asset it had in the old LegendKeeper staging folder, after migrate-staging copied its bytes. */
  readonly legacyAssetId: string | null;
}

interface UploadRaw {
  project_id: string;
  id: string;
  state: UploadState;
  job_id: string | null;
  asset_id: string | null;
  name: string;
  description: string | null;
  folder_id: string | null;
  folder_path: string | null;
  staged: number;
  intended: string | null;
  source: UploadSource;
  principal_id: string;
  original_format: string;
  original_sha256: string;
  original_bytes: number;
  orientation: number | null;
  webp_sha256: string;
  webp_bytes: number;
  width: number;
  height: number;
  frames: number;
  has_alpha: number;
  conversion_mode: 'converted' | 'webp_passthrough';
  quality: number | null;
  convert_ms: number | null;
  stored_verified: number | null;
  stored_sha256: string | null;
  verify_reason: string | null;
  error: string | null;
  placed_at: number | null;
  placed_by: string | null;
  placement_job_id: string | null;
  placement_proposal_id: string | null;
  discard_job_id: string | null;
  discarded_at: number | null;
  discarded_by: string | null;
  created_at: number;
  updated_at: number;
  server_sha256: string | null;
  expiry_warned_at: number | null;
  legacy_asset_id: string | null;
}

const parse = <T>(t: string | null): T | null => {
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
};

function view(r: UploadRaw): ImageUploadRow {
  return {
    projectId: r.project_id,
    id: r.id,
    state: r.state,
    jobId: r.job_id,
    assetId: r.asset_id,
    name: r.name,
    description: r.description,
    folderId: r.folder_id,
    folderPath: parse<string[]>(r.folder_path),
    staged: r.staged === 1,
    intended: parse<Record<string, unknown>>(r.intended),
    source: r.source,
    principalId: r.principal_id,
    original: {
      format: r.original_format,
      sha256: r.original_sha256,
      bytes: r.original_bytes,
      orientation: r.orientation,
    },
    webp: { sha256: r.webp_sha256, bytes: r.webp_bytes },
    width: r.width,
    height: r.height,
    frames: r.frames,
    hasAlpha: r.has_alpha === 1,
    conversionMode: r.conversion_mode,
    quality: r.quality,
    convertMs: r.convert_ms,
    storedVerified: r.stored_verified === null ? null : r.stored_verified === 1,
    storedSha256: r.stored_sha256,
    verifyReason: r.verify_reason,
    error: r.error,
    placedAt: r.placed_at,
    placedBy: r.placed_by,
    placementJobId: r.placement_job_id,
    placementProposalId: r.placement_proposal_id,
    discardJobId: r.discard_job_id,
    discardedAt: r.discarded_at,
    discardedBy: r.discarded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    serverSha256: r.server_sha256 ?? null,
    expiryWarnedAt: r.expiry_warned_at ?? null,
    legacyAssetId: r.legacy_asset_id ?? null,
  };
}

export interface NewUpload {
  readonly projectId: string;
  readonly id: string;
  /** Null for an image staged on the bridge's server (v3 F2): no job until it is placed. */
  readonly jobId: string | null;
  /** v3 F2: staged on the server, with these bytes (the row is then `uploaded` at once, with no asset). */
  readonly serverSha256?: string;
  readonly legacyAssetId?: string;
  readonly name: string;
  readonly description: string | null;
  readonly folderId: string | null;
  readonly folderPath: readonly string[] | null;
  readonly staged: boolean;
  readonly intended: Record<string, unknown> | null;
  readonly source: UploadSource;
  readonly principalId: string;
  readonly original: { format: string; sha256: string; bytes: number; orientation: number | null };
  readonly webp: { sha256: string; bytes: number };
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly hasAlpha: boolean;
  readonly conversionMode: 'converted' | 'webp_passthrough';
  readonly quality: number | null;
  readonly convertMs: number | null;
}

export interface UploadPatch {
  state?: UploadState;
  assetId?: string | null;
  folderId?: string | null;
  folderPath?: readonly string[] | null;
  name?: string;
  staged?: boolean;
  storedVerified?: boolean | null;
  storedSha256?: string | null;
  verifyReason?: string | null;
  error?: string | null;
  placedAt?: number | null;
  placedBy?: string | null;
  placementJobId?: string | null;
  placementProposalId?: string | null;
  discardJobId?: string | null;
  discardedAt?: number | null;
  discardedBy?: string | null;
  intended?: Record<string, unknown> | null;
  serverSha256?: string | null;
  expiryWarnedAt?: number | null;
  legacyAssetId?: string | null;
}

const COLUMNS: Record<keyof UploadPatch, string> = {
  state: 'state',
  assetId: 'asset_id',
  folderId: 'folder_id',
  folderPath: 'folder_path',
  name: 'name',
  staged: 'staged',
  storedVerified: 'stored_verified',
  storedSha256: 'stored_sha256',
  verifyReason: 'verify_reason',
  error: 'error',
  placedAt: 'placed_at',
  placedBy: 'placed_by',
  placementJobId: 'placement_job_id',
  placementProposalId: 'placement_proposal_id',
  discardJobId: 'discard_job_id',
  discardedAt: 'discarded_at',
  discardedBy: 'discarded_by',
  intended: 'intended',
  serverSha256: 'server_sha256',
  expiryWarnedAt: 'expiry_warned_at',
  legacyAssetId: 'legacy_asset_id',
};

// ---------------------------------------------------------------------------------------------- binary upload slots

export type SlotState = 'prepared' | 'receiving' | 'received' | 'consumed' | 'expired';

export interface UploadSlotRow {
  readonly id: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly tokenHash: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly name: string;
  readonly state: SlotState;
  readonly tokenExpiresAt: number;
  readonly expiresAt: number;
  readonly fileName: string | null;
  readonly receivedAt: number | null;
  readonly consumedAt: number | null;
  readonly createdAt: number;
}

interface SlotRaw {
  id: string;
  project_id: string;
  principal_id: string;
  token_hash: string;
  sha256: string;
  byte_length: number;
  content_type: string;
  name: string;
  state: SlotState;
  token_expires_at: number;
  expires_at: number;
  file_name: string | null;
  received_at: number | null;
  consumed_at: number | null;
  created_at: number;
}

const slotView = (r: SlotRaw): UploadSlotRow => ({
  id: r.id,
  projectId: r.project_id,
  principalId: r.principal_id,
  tokenHash: r.token_hash,
  sha256: r.sha256,
  byteLength: r.byte_length,
  contentType: r.content_type,
  name: r.name,
  state: r.state,
  tokenExpiresAt: r.token_expires_at,
  expiresAt: r.expires_at,
  fileName: r.file_name,
  receivedAt: r.received_at,
  consumedAt: r.consumed_at,
  createdAt: r.created_at,
});

// ---------------------------------------------------------------------------------------------- the store

/** A change to an upload record: `before` is undefined for a new one. */
export type UploadChangeListener = (after: ImageUploadRow, before: ImageUploadRow | undefined) => void;

export class ImageStore {
  private readonly changeListeners = new Set<UploadChangeListener>();

  constructor(
    private readonly db: Db,
    readonly now: () => number,
  ) {}

  /**
   * Calls `cb` after every insert or update of an upload record, whatever made it (the service's own steps, a job
   * ending, a proposal's approval, the dashboard): the one place every change to a staged image passes. A listener that
   * throws is ignored (it can never break a write). Returns the unsubscribe function.
   */
  onChange(cb: UploadChangeListener): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private notify(after: ImageUploadRow | undefined, before: ImageUploadRow | undefined): void {
    if (!after) return;
    for (const cb of this.changeListeners) {
      try {
        cb(after, before);
      } catch {
        // a listener must not break the write it follows
      }
    }
  }

  // ---- uploads

  insertUpload(u: NewUpload): ImageUploadRow {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO image_uploads (project_id, id, state, job_id, name, description, folder_id, folder_path, staged,
           intended, source, principal_id, original_format, original_sha256, original_bytes, orientation, webp_sha256,
           webp_bytes, width, height, frames, has_alpha, conversion_mode, quality, convert_ms, created_at, updated_at,
           server_sha256, legacy_asset_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.projectId,
        u.id,
        u.serverSha256 ? 'uploaded' : 'uploading',
        u.jobId,
        u.name,
        u.description,
        u.folderId,
        u.folderPath ? JSON.stringify(u.folderPath) : null,
        u.staged ? 1 : 0,
        u.intended ? JSON.stringify(u.intended) : null,
        u.source,
        u.principalId,
        u.original.format,
        u.original.sha256,
        u.original.bytes,
        u.original.orientation,
        u.webp.sha256,
        u.webp.bytes,
        u.width,
        u.height,
        u.frames,
        u.hasAlpha ? 1 : 0,
        u.conversionMode,
        u.quality,
        u.convertMs,
        now,
        now,
        u.serverSha256 ?? null,
        u.legacyAssetId ?? null,
      );
    const row = this.upload(u.projectId, u.id)!;
    this.notify(row, undefined);
    return row;
  }

  /** v3 F2: the record of an upload by its asset (the newest), or undefined. */
  byAsset(projectId: string, assetId: string): ImageUploadRow | undefined {
    const r = this.db
      .prepare(
        'SELECT * FROM image_uploads WHERE project_id = ? AND (asset_id = ? OR legacy_asset_id = ?) ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, assetId, assetId) as UploadRaw | undefined;
    return r ? view(r) : undefined;
  }

  // ---- v3 F2: migrate-staging requests (the CLI writes one; the running bridge's sweep runs it)

  requestMigration(projectId: string, by: string): number {
    const info = this.db
      .prepare(
        `INSERT INTO image_staging_migrations (project_id, state, requested_by, requested_at) VALUES (?, 'requested', ?, ?)`,
      )
      .run(projectId, by, this.now());
    return Number(info.lastInsertRowid);
  }

  pendingMigrations(): { id: number; projectId: string; requestedBy: string }[] {
    return (
      this.db
        .prepare(
          "SELECT id, project_id, requested_by FROM image_staging_migrations WHERE state = 'requested' ORDER BY id",
        )
        .all() as { id: number; project_id: string; requested_by: string }[]
    ).map((r) => ({ id: r.id, projectId: r.project_id, requestedBy: r.requested_by }));
  }

  claimMigration(id: number): boolean {
    return (
      this.db
        .prepare("UPDATE image_staging_migrations SET state = 'running' WHERE id = ? AND state = 'requested'")
        .run(id).changes === 1
    );
  }

  finishMigration(id: number, state: 'done' | 'failed', result: unknown, proposalId: string | null): void {
    this.db
      .prepare(
        'UPDATE image_staging_migrations SET state = ?, result = ?, proposal_id = ?, finished_at = ? WHERE id = ?',
      )
      .run(state, JSON.stringify(result), proposalId, this.now(), id);
  }

  migration(id: number): { state: string; result: unknown; proposalId: string | null } | undefined {
    const r = this.db
      .prepare('SELECT state, result, proposal_id FROM image_staging_migrations WHERE id = ?')
      .get(id) as { state: string; result: string | null; proposal_id: string | null } | undefined;
    return r ? { state: r.state, result: parse(r.result), proposalId: r.proposal_id } : undefined;
  }

  /** The proposal ids earlier migrations of this project made (newest first). */
  migrationProposals(projectId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT proposal_id FROM image_staging_migrations WHERE project_id = ? AND proposal_id IS NOT NULL ORDER BY id DESC',
        )
        .all(projectId) as { proposal_id: string }[]
    ).map((r) => r.proposal_id);
  }

  /** v3 F2: the projects with any staged image (for the expiry sweep). */
  projectsWithStaged(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT project_id FROM image_uploads WHERE staged = 1').all() as {
        project_id: string;
      }[]
    ).map((r) => r.project_id);
  }

  /** v3 F2: whether any row still keeps these bytes on the server (the same image staged twice, in two projects). */
  serverShaInUse(sha256: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM image_uploads WHERE server_sha256 = ? LIMIT 1').get(sha256) !== undefined
    );
  }

  upload(projectId: string, id: string): ImageUploadRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM image_uploads WHERE project_id = ? AND id = ?')
      .get(projectId, id) as UploadRaw | undefined;
    return r ? view(r) : undefined;
  }

  /** The newest upload of an asset (the row that put it there). */
  uploadOfAsset(projectId: string, assetId: string): ImageUploadRow | undefined {
    const r = this.db
      .prepare(
        'SELECT * FROM image_uploads WHERE project_id = ? AND asset_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, assetId) as UploadRaw | undefined;
    return r ? view(r) : undefined;
  }

  uploadsOfAssets(projectId: string, assetIds: readonly string[]): Map<string, ImageUploadRow> {
    const out = new Map<string, ImageUploadRow>();
    for (let i = 0; i < assetIds.length; i += 500) {
      const part = assetIds.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT * FROM image_uploads WHERE project_id = ? AND asset_id IN (${part.map(() => '?').join(',')})
           ORDER BY created_at`,
        )
        .all(projectId, ...part) as UploadRaw[];
      for (const r of rows) out.set(r.asset_id!, view(r));
    }
    return out;
  }

  /** Uploads of the same original (newest first), not failed or discarded. */
  byOriginal(projectId: string, sha256: string): ImageUploadRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM image_uploads WHERE project_id = ? AND original_sha256 = ? AND state IN ('uploading', 'uploaded')
           ORDER BY created_at DESC`,
        )
        .all(projectId, sha256) as UploadRaw[]
    ).map(view);
  }

  uploading(projectId?: string): ImageUploadRow[] {
    return (
      (projectId
        ? this.db
            .prepare("SELECT * FROM image_uploads WHERE project_id = ? AND state = 'uploading'")
            .all(projectId)
        : this.db.prepare("SELECT * FROM image_uploads WHERE state = 'uploading'").all()) as UploadRaw[]
    ).map(view);
  }

  /** Staged images (not placed, not discarded), newest first; and those still uploading to staging. */
  staged(projectId: string, limit = 500): ImageUploadRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM image_uploads WHERE project_id = ? AND staged = 1 AND state IN ('uploading', 'uploaded')
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, limit) as UploadRaw[]
    ).map(view);
  }

  recent(projectId: string, limit = 100): ImageUploadRow[] {
    return (
      this.db
        .prepare('SELECT * FROM image_uploads WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(projectId, limit) as UploadRaw[]
    ).map(view);
  }

  /** Staged rows whose placement was proposed and is still open. */
  withPlacementProposal(projectId?: string): ImageUploadRow[] {
    return (
      (projectId
        ? this.db
            .prepare(
              'SELECT * FROM image_uploads WHERE project_id = ? AND staged = 1 AND placement_proposal_id IS NOT NULL',
            )
            .all(projectId)
        : this.db
            .prepare('SELECT * FROM image_uploads WHERE staged = 1 AND placement_proposal_id IS NOT NULL')
            .all()) as UploadRaw[]
    ).map(view);
  }

  updateUpload(projectId: string, id: string, patch: UploadPatch): ImageUploadRow | undefined {
    const before = this.changeListeners.size > 0 ? this.upload(projectId, id) : undefined;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof UploadPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMNS[k]} = ?`);
      values.push(
        typeof v === 'boolean'
          ? v
            ? 1
            : 0
          : (k === 'folderPath' || k === 'intended') && v !== null
            ? JSON.stringify(v)
            : v,
      );
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE image_uploads SET ${sets.join(', ')}, updated_at = ? WHERE project_id = ? AND id = ?`,
        )
        .run(...values, this.now(), projectId, id);
    }
    const after = this.upload(projectId, id);
    if (sets.length > 0) this.notify(after, before);
    return after;
  }

  // ---- slots

  insertSlot(s: Omit<UploadSlotRow, 'state' | 'fileName' | 'receivedAt' | 'consumedAt' | 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO image_upload_slots (id, project_id, principal_id, token_hash, sha256, byte_length, content_type, name,
           state, token_expires_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
      )
      .run(
        s.id,
        s.projectId,
        s.principalId,
        s.tokenHash,
        s.sha256,
        s.byteLength,
        s.contentType,
        s.name,
        s.tokenExpiresAt,
        s.expiresAt,
        this.now(),
      );
  }

  slot(id: string): UploadSlotRow | undefined {
    const r = this.db.prepare('SELECT * FROM image_upload_slots WHERE id = ?').get(id) as SlotRaw | undefined;
    return r ? slotView(r) : undefined;
  }

  /** Moves a slot from one state to the next, only if it is still in `from` (an atomic claim). */
  transitionSlot(
    id: string,
    from: SlotState,
    to: SlotState,
    extra: { fileName?: string | null; receivedAt?: number; consumedAt?: number } = {},
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE image_upload_slots SET state = ?, file_name = COALESCE(?, file_name),
           received_at = COALESCE(?, received_at), consumed_at = COALESCE(?, consumed_at)
         WHERE id = ? AND state = ?`,
      )
      .run(to, extra.fileName ?? null, extra.receivedAt ?? null, extra.consumedAt ?? null, id, from);
    return r.changes === 1;
  }

  /** Slots past their expiry that still hold (or may hold) a file. */
  expiredSlots(now: number): UploadSlotRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM image_upload_slots WHERE state IN ('prepared', 'receiving', 'received') AND expires_at <= ?",
        )
        .all(now) as SlotRaw[]
    ).map(slotView);
  }

  expireSlot(id: string): void {
    this.db
      .prepare(
        "UPDATE image_upload_slots SET state = 'expired' WHERE id = ? AND state IN ('prepared', 'receiving', 'received')",
      )
      .run(id);
  }

  /** Every slot that was receiving when the process stopped: their partial files are gone (the directory is cleaned). */
  resetReceiving(): number {
    return this.db.prepare("UPDATE image_upload_slots SET state = 'expired' WHERE state = 'receiving'").run()
      .changes;
  }

  /** Slot rows older than `before` that are finished: removed (the audit and the job keep what matters). */
  pruneSlots(before: number): number {
    return this.db
      .prepare("DELETE FROM image_upload_slots WHERE state IN ('consumed', 'expired') AND created_at < ?")
      .run(before).changes;
  }

  liveFileNames(): Set<string> {
    const rows = this.db
      .prepare("SELECT file_name FROM image_upload_slots WHERE state = 'received' AND file_name IS NOT NULL")
      .all() as { file_name: string }[];
    return new Set(rows.map((r) => r.file_name));
  }

  // ---- kept bytes

  keepBytes(sha256: string, size: number, contentType: string | null): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO asset_kept_bytes (sha256, size, content_type, stored_at, last_kept_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET last_kept_at = excluded.last_kept_at`,
      )
      .run(sha256, size, contentType, now, now);
  }

  hasBytes(sha256: string): boolean {
    return this.db.prepare('SELECT 1 FROM asset_kept_bytes WHERE sha256 = ?').get(sha256) !== undefined;
  }

  addKeptRef(r: {
    projectId: string;
    assetId: string;
    name: string | null;
    folderId: string | null;
    sha256: string;
    jobId: string | null;
    stepNo: number | null;
    expiresAt: number;
  }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO asset_kept_refs (project_id, asset_id, name, folder_id, sha256, job_id, step_no, kept_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.projectId, r.assetId, r.name, r.folderId, r.sha256, r.jobId, r.stepNo, this.now(), r.expiresAt)
        .lastInsertRowid,
    );
  }

  keptRefs(
    projectId: string,
    assetId?: string,
  ): {
    id: number;
    assetId: string;
    name: string | null;
    folderId: string | null;
    sha256: string;
    size: number;
    contentType: string | null;
    jobId: string | null;
    keptAt: number;
    expiresAt: number;
  }[] {
    const rows = (
      assetId
        ? this.db
            .prepare(
              `SELECT r.*, b.size, b.content_type FROM asset_kept_refs r JOIN asset_kept_bytes b ON b.sha256 = r.sha256
               WHERE r.project_id = ? AND r.asset_id = ? ORDER BY r.kept_at DESC`,
            )
            .all(projectId, assetId)
        : this.db
            .prepare(
              `SELECT r.*, b.size, b.content_type FROM asset_kept_refs r JOIN asset_kept_bytes b ON b.sha256 = r.sha256
               WHERE r.project_id = ? ORDER BY r.kept_at DESC LIMIT 500`,
            )
            .all(projectId)
    ) as {
      id: number;
      asset_id: string;
      name: string | null;
      folder_id: string | null;
      sha256: string;
      size: number;
      content_type: string | null;
      job_id: string | null;
      kept_at: number;
      expires_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      name: r.name,
      folderId: r.folder_id,
      sha256: r.sha256,
      size: r.size,
      contentType: r.content_type,
      jobId: r.job_id,
      keptAt: r.kept_at,
      expiresAt: r.expires_at,
    }));
  }

  /** Removes references past their retention; returns the files no reference (and no recent keep) needs any more. */
  expireKept(now: number): string[] {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM asset_kept_refs WHERE expires_at <= ?').run(now);
      const orphans = this.db
        .prepare(
          `SELECT sha256 FROM asset_kept_bytes b WHERE NOT EXISTS (SELECT 1 FROM asset_kept_refs r WHERE r.sha256 = b.sha256)`,
        )
        .all() as { sha256: string }[];
      const del = this.db.prepare('DELETE FROM asset_kept_bytes WHERE sha256 = ?');
      for (const o of orphans) del.run(o.sha256);
      return orphans.map((o) => o.sha256);
    })();
  }

  keptTotals(): { files: number; bytes: number } {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM asset_kept_bytes')
      .get() as {
      n: number;
      b: number;
    };
    return { files: r.n, bytes: r.b };
  }

  // ---- delete overrides

  grantOverride(projectId: string, assetId: string, by: string, ttlMs: number): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO asset_delete_overrides (project_id, asset_id, granted_by, granted_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (project_id, asset_id) DO UPDATE SET granted_by = excluded.granted_by,
           granted_at = excluded.granted_at, expires_at = excluded.expires_at, used_at = NULL`,
      )
      .run(projectId, assetId, by, now, now + ttlMs);
  }

  /** Uses the owner's permission for this asset, once. True when there was a live one. */
  useOverride(projectId: string, assetId: string): boolean {
    const now = this.now();
    return (
      this.db
        .prepare(
          `UPDATE asset_delete_overrides SET used_at = ? WHERE project_id = ? AND asset_id = ? AND used_at IS NULL
             AND expires_at > ?`,
        )
        .run(now, projectId, assetId, now).changes === 1
    );
  }

  overrides(
    projectId: string,
  ): { assetId: string; grantedBy: string; grantedAt: number; expiresAt: number; usedAt: number | null }[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM asset_delete_overrides WHERE project_id = ? ORDER BY granted_at DESC LIMIT 100',
        )
        .all(projectId) as {
        asset_id: string;
        granted_by: string;
        granted_at: number;
        expires_at: number;
        used_at: number | null;
      }[]
    ).map((r) => ({
      assetId: r.asset_id,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
    }));
  }
}
