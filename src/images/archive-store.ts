/**
 * v3 F7c (ADR 0075): the image archives' records (migration 4400). Server-local only.
 */
import type { Db } from '../db/open.js';

export type ArchiveState = 'open' | 'done' | 'discarded' | 'expired';
export type EntryStatus =
  'listed' | 'queued' | 'converting' | 'held' | 'staged' | 'refused' | 'failed' | 'duplicate' | 'discarded';
export type HeldBy = 'rate' | 'storage';

/** A placement waiting for an entry's staged image: the package's proposal or job and the image's asset step. */
export interface EntryLink {
  readonly proposalId?: string;
  readonly jobId?: string;
  /** The intended placing (name, path, folderId, assetStep) the image record gets once it exists. */
  readonly placing?: Record<string, unknown>;
}

export interface ArchiveRow {
  readonly id: string;
  readonly projectId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly fileName: string | null;
  readonly principalId: string;
  readonly source: string;
  readonly workstream: string | null;
  readonly state: ArchiveState;
  readonly serverFile: string | null;
  readonly entryCount: number;
  readonly skipped: number;
  readonly uncompressedBytes: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly removedAt: number | null;
  readonly discardedBy: string | null;
}

export interface EntryRow {
  readonly archiveId: string;
  readonly seq: number;
  readonly projectId: string;
  readonly path: string;
  readonly folder: string | null;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly compressedBytes: number;
  readonly format: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frames: number | null;
  readonly status: EntryStatus;
  readonly heldBy: HeldBy | null;
  readonly expectedAt: number | null;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly duplicateOf: number | null;
  readonly stagedId: string | null;
  readonly attempts: number;
  readonly wantedAt: number | null;
  readonly links: readonly EntryLink[];
  readonly updatedAt: number;
}

export type EntryPatch = Partial<
  Pick<
    EntryRow,
    | 'status'
    | 'heldBy'
    | 'expectedAt'
    | 'reasonCode'
    | 'reason'
    | 'stagedId'
    | 'attempts'
    | 'wantedAt'
    | 'links'
  >
>;

type Raw = Record<string, unknown>;

const archiveOf = (r: Raw): ArchiveRow => ({
  id: r.id as string,
  projectId: r.project_id as string,
  sha256: r.sha256 as string,
  bytes: r.bytes as number,
  fileName: (r.file_name as string | null) ?? null,
  principalId: r.principal_id as string,
  source: r.source as string,
  workstream: (r.workstream as string | null) ?? null,
  state: r.state as ArchiveState,
  serverFile: (r.server_file as string | null) ?? null,
  entryCount: r.entry_count as number,
  skipped: r.skipped as number,
  uncompressedBytes: r.uncompressed_bytes as number,
  createdAt: r.created_at as number,
  lastActivityAt: r.last_activity_at as number,
  removedAt: (r.removed_at as number | null) ?? null,
  discardedBy: (r.discarded_by as string | null) ?? null,
});

function parseLinks(s: unknown): EntryLink[] {
  if (typeof s !== 'string' || s === '') return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as EntryLink[]) : [];
  } catch {
    return [];
  }
}

const entryOf = (r: Raw): EntryRow => ({
  archiveId: r.archive_id as string,
  seq: r.seq as number,
  projectId: r.project_id as string,
  path: r.path as string,
  folder: (r.folder as string | null) ?? null,
  sha256: (r.sha256 as string | null) ?? null,
  bytes: r.bytes as number,
  compressedBytes: r.compressed_bytes as number,
  format: (r.format as string | null) ?? null,
  width: (r.width as number | null) ?? null,
  height: (r.height as number | null) ?? null,
  frames: (r.frames as number | null) ?? null,
  status: r.status as EntryStatus,
  heldBy: (r.held_by as HeldBy | null) ?? null,
  expectedAt: (r.expected_at as number | null) ?? null,
  reasonCode: (r.reason_code as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  duplicateOf: (r.duplicate_of as number | null) ?? null,
  stagedId: (r.staged_id as string | null) ?? null,
  attempts: r.attempts as number,
  wantedAt: (r.wanted_at as number | null) ?? null,
  links: parseLinks(r.links),
  updatedAt: r.updated_at as number,
});

const COLUMN: Record<keyof EntryPatch, string> = {
  status: 'status',
  heldBy: 'held_by',
  expectedAt: 'expected_at',
  reasonCode: 'reason_code',
  reason: 'reason',
  stagedId: 'staged_id',
  attempts: 'attempts',
  wantedAt: 'wanted_at',
  links: 'links',
};

export class ArchiveStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  archive(id: string): ArchiveRow | undefined {
    const r = this.db.prepare('SELECT * FROM image_archives WHERE id = ?').get(id) as Raw | undefined;
    return r ? archiveOf(r) : undefined;
  }

  bySha(projectId: string, sha256: string): ArchiveRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM image_archives WHERE project_id = ? AND sha256 = ?')
      .get(projectId, sha256) as Raw | undefined;
    return r ? archiveOf(r) : undefined;
  }

  insertArchive(
    a: Omit<ArchiveRow, 'createdAt' | 'lastActivityAt' | 'removedAt' | 'discardedBy'>,
  ): ArchiveRow {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO image_archives (id, project_id, sha256, bytes, file_name, principal_id, source, workstream, state,
           server_file, entry_count, skipped, uncompressed_bytes, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.projectId,
        a.sha256,
        a.bytes,
        a.fileName,
        a.principalId,
        a.source,
        a.workstream,
        a.state,
        a.serverFile,
        a.entryCount,
        a.skipped,
        a.uncompressedBytes,
        now,
        now,
      );
    return this.archive(a.id)!;
  }

  updateArchive(
    id: string,
    patch: Partial<Pick<ArchiveRow, 'state' | 'serverFile' | 'removedAt' | 'discardedBy' | 'lastActivityAt'>>,
  ): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      state: 'state',
      serverFile: 'server_file',
      removedAt: 'removed_at',
      discardedBy: 'discarded_by',
      lastActivityAt: 'last_activity_at',
    };
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${map[k]!} = ?`);
      vals.push(v);
    }
    if (cols.length === 0) return;
    this.db.prepare(`UPDATE image_archives SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  touch(id: string): void {
    this.updateArchive(id, { lastActivityAt: this.now() });
  }

  /** A connection's archives, most recent activity first. */
  byPrincipal(principalId: string, projectId: string | null, limit = 10): ArchiveRow[] {
    const rows = (
      projectId === null
        ? this.db
            .prepare(
              'SELECT * FROM image_archives WHERE principal_id = ? ORDER BY last_activity_at DESC LIMIT ?',
            )
            .all(principalId, limit)
        : this.db
            .prepare(
              'SELECT * FROM image_archives WHERE principal_id = ? AND project_id = ? ORDER BY last_activity_at DESC LIMIT ?',
            )
            .all(principalId, projectId, limit)
    ) as Raw[];
    return rows.map(archiveOf);
  }

  /** A project's archives (the dashboard), most recent first. */
  ofProject(projectId: string, limit = 100): ArchiveRow[] {
    return (
      this.db
        .prepare('SELECT * FROM image_archives WHERE project_id = ? ORDER BY last_activity_at DESC LIMIT ?')
        .all(projectId, limit) as Raw[]
    ).map(archiveOf);
  }

  /** Archives whose server copy is still kept. */
  withServerCopy(): ArchiveRow[] {
    return (this.db.prepare('SELECT * FROM image_archives WHERE server_file IS NOT NULL').all() as Raw[]).map(
      archiveOf,
    );
  }

  insertEntries(rows: readonly Omit<EntryRow, 'updatedAt' | 'links' | 'attempts' | 'wantedAt'>[]): void {
    const now = this.now();
    const st = this.db.prepare(
      `INSERT INTO image_archive_entries (archive_id, seq, project_id, path, folder, sha256, bytes, compressed_bytes,
         format, width, height, frames, status, held_by, expected_at, reason_code, reason, duplicate_of, staged_id,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const e of rows)
        st.run(
          e.archiveId,
          e.seq,
          e.projectId,
          e.path,
          e.folder,
          e.sha256,
          e.bytes,
          e.compressedBytes,
          e.format,
          e.width,
          e.height,
          e.frames,
          e.status,
          e.heldBy,
          e.expectedAt,
          e.reasonCode,
          e.reason,
          e.duplicateOf,
          e.stagedId,
          now,
        );
    })();
  }

  entries(archiveId: string): EntryRow[] {
    return (
      this.db
        .prepare('SELECT * FROM image_archive_entries WHERE archive_id = ? ORDER BY seq')
        .all(archiveId) as Raw[]
    ).map(entryOf);
  }

  entry(archiveId: string, seq: number): EntryRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM image_archive_entries WHERE archive_id = ? AND seq = ?')
      .get(archiveId, seq) as Raw | undefined;
    return r ? entryOf(r) : undefined;
  }

  /** The entry whose staged image has this id (reserved or real), if any. */
  byStagedId(projectId: string, stagedId: string): EntryRow | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM image_archive_entries WHERE project_id = ? AND staged_id = ? AND status != 'duplicate' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(projectId, stagedId) as Raw | undefined;
    return r ? entryOf(r) : undefined;
  }

  updateEntry(archiveId: string, seq: number, patch: EntryPatch): EntryRow | undefined {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof EntryPatch, unknown][]) {
      cols.push(`${COLUMN[k]} = ?`);
      vals.push(k === 'links' ? JSON.stringify(v ?? []) : v);
    }
    cols.push('updated_at = ?');
    vals.push(this.now());
    this.db
      .prepare(`UPDATE image_archive_entries SET ${cols.join(', ')} WHERE archive_id = ? AND seq = ?`)
      .run(...vals, archiveId, seq);
    return this.entry(archiveId, seq);
  }

  /** Entries waiting for the worker (queued or held), in the order they were asked for, then archive order. */
  waiting(limit = 500): EntryRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM image_archive_entries WHERE status IN ('queued', 'held') ORDER BY wanted_at, archive_id, seq LIMIT ?",
        )
        .all(limit) as Raw[]
    ).map(entryOf);
  }

  /** At start-up: a conversion cut short by a stop is queued again. */
  resetConverting(): number {
    return this.db
      .prepare(
        "UPDATE image_archive_entries SET status = 'queued', updated_at = ? WHERE status = 'converting'",
      )
      .run(this.now()).changes;
  }

  /** Entries that keep waiting placements (links), in a project. */
  linked(projectId: string): EntryRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM image_archive_entries WHERE project_id = ? AND links IS NOT NULL AND links != '[]'",
        )
        .all(projectId) as Raw[]
    ).map(entryOf);
  }
}
