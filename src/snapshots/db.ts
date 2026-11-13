/**
 * The snapshot store's index and bookkeeping in SQLite (v2 E1a, ADR 0042; migration 2000). The manifest files are the
 * truth; `snapshots` and `snapshot_pieces` index them (and are rebuilt from them when a row is missing), and the rest is
 * the state of runs, owed change snapshots, verify findings, notices and rehearsals.
 */
import type { Db } from '../db/open.js';
import { manifestPieces, type Manifest, type PageEntry, type SnapshotKind } from './manifest.js';

export interface SnapshotRow {
  readonly id: string;
  readonly projectId: string;
  readonly kind: SnapshotKind;
  readonly state: 'complete' | 'partial';
  readonly takenAt: number;
  readonly startedAt: number;
  readonly pages: number;
  readonly pieces: number;
  readonly logicalBytes: number;
  readonly newObjects: number;
  readonly newBytes: number;
  readonly reads: number;
  readonly downloads: number;
  readonly missing: number;
  readonly path: string;
  readonly trigger: Record<string, unknown>;
  readonly summary: string;
  readonly damaged: string | null;
}

export interface PieceRow {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly piece: string;
  readonly ref: string;
  readonly docType: string | null;
  readonly name: string | null;
  readonly sha256: string | null;
  readonly size: number;
  readonly takenAt: number;
  readonly kind: SnapshotKind;
  readonly state: 'complete' | 'partial';
}

export type RunState = 'running' | 'succeeded' | 'failed' | 'refused' | 'stopped';

export interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'full';
  readonly state: RunState;
  readonly trigger: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  readonly rootId: string | null;
  readonly total: number;
  readonly done: number;
  readonly reads: number;
  readonly downloads: number;
  readonly newObjects: number;
  readonly newBytes: number;
  readonly estimate: Record<string, unknown> | null;
  readonly error: string | null;
  readonly snapshotId: string | null;
  readonly library: Record<string, unknown> | null;
}

export interface OwedRow {
  readonly id: number;
  readonly projectId: string;
  readonly jobId: string;
  readonly pageId: string;
  readonly piece: string;
  readonly ref: string;
  readonly opId: string;
  readonly tool: string | null;
  readonly createdAt: number;
}

export interface FindingRow {
  readonly id: number;
  readonly sha256: string;
  readonly problem: 'missing' | 'corrupt' | 'manifest';
  readonly detail: string | null;
  readonly snapshots: string[];
  readonly foundAt: number;
  readonly resolvedAt: number | null;
}

export interface NoticeRow {
  readonly id: number;
  readonly projectId: string | null;
  readonly level: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly at: number;
}

export interface RehearsalRow {
  readonly id: string;
  readonly projectId: string;
  readonly sourceProjectId: string;
  readonly snapshotId: string;
  readonly mode: 'sampled' | 'full';
  readonly state: 'running' | 'succeeded' | 'failed' | 'stopped';
  readonly keep: boolean;
  readonly rootId: string | null;
  readonly rootName: string | null;
  readonly rootState: 'none' | 'kept' | 'deleted' | 'delete_failed';
  readonly startedBy: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly estimate: Record<string, unknown> | null;
  readonly plan: Record<string, unknown> | null;
  readonly progress: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

type Raw = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function snapshotRow(r: Raw): SnapshotRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as SnapshotKind,
    state: r.state as 'complete' | 'partial',
    takenAt: num(r.taken_at),
    startedAt: num(r.started_at),
    pages: num(r.pages),
    pieces: num(r.pieces),
    logicalBytes: num(r.logical_bytes),
    newObjects: num(r.new_objects),
    newBytes: num(r.new_bytes),
    reads: num(r.reads),
    downloads: num(r.downloads),
    missing: num(r.missing),
    path: String(r.path),
    trigger: json(r.trigger, {}),
    summary: typeof r.summary === 'string' ? r.summary : '',
    damaged: strOrNull(r.damaged),
  };
}

function pieceRow(r: Raw): PieceRow {
  return {
    snapshotId: String(r.snapshot_id),
    projectId: String(r.project_id),
    pageId: String(r.page_id),
    piece: String(r.piece),
    ref: typeof r.ref === 'string' ? r.ref : '',
    docType: strOrNull(r.doc_type),
    name: strOrNull(r.name),
    sha256: strOrNull(r.sha256),
    size: num(r.size),
    takenAt: num(r.taken_at),
    kind: r.kind as SnapshotKind,
    state: r.state as 'complete' | 'partial',
  };
}

function runRow(r: Raw): RunRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as 'full',
    state: r.state as RunState,
    trigger: String(r.trigger),
    startedAt: num(r.started_at),
    updatedAt: num(r.updated_at),
    finishedAt: r.finished_at === null ? null : num(r.finished_at),
    rootId: strOrNull(r.root_id),
    total: num(r.total),
    done: num(r.done),
    reads: num(r.reads),
    downloads: num(r.downloads),
    newObjects: num(r.new_objects),
    newBytes: num(r.new_bytes),
    estimate: json(r.estimate, null),
    error: strOrNull(r.error),
    snapshotId: strOrNull(r.snapshot_id),
    library: json(r.library, null),
  };
}

function rehearsalRow(r: Raw): RehearsalRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    sourceProjectId: String(r.source_project_id),
    snapshotId: String(r.snapshot_id),
    mode: r.mode as 'sampled' | 'full',
    state: r.state as RehearsalRow['state'],
    keep: r.keep === 1,
    rootId: strOrNull(r.root_id),
    rootName: strOrNull(r.root_name),
    rootState: r.root_state as RehearsalRow['rootState'],
    startedBy: String(r.started_by),
    startedAt: num(r.started_at),
    finishedAt: r.finished_at === null ? null : num(r.finished_at),
    estimate: json(r.estimate, null),
    plan: json(r.plan, null),
    progress: json(r.progress, {}),
    result: json(r.result, null),
    error: strOrNull(r.error),
  };
}

export class SnapshotDb {
  constructor(
    readonly db: Db,
    readonly now: () => number,
  ) {}

  // ============================================================================================ the index

  /** Indexes a written manifest (idempotent: an existing row is left as it is). */
  indexManifest(m: Manifest, rel: string, summary: string): void {
    const pieces = manifestPieces(m);
    const takenAt = Date.parse(m.takenAt);
    this.db.transaction(() => {
      const ins = this.db
        .prepare(
          `INSERT OR IGNORE INTO snapshots (id, project_id, kind, state, taken_at, started_at, pages, pieces, logical_bytes,
             new_objects, new_bytes, reads, downloads, missing, path, trigger, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.id,
          m.project.id,
          m.kind,
          m.complete ? 'complete' : 'partial',
          takenAt,
          Date.parse(m.startedAt),
          m.counts.pages,
          m.counts.pieces,
          m.counts.logicalBytes,
          m.counts.newObjects,
          m.counts.newBytes,
          m.counts.reads,
          m.counts.downloads,
          m.counts.missing,
          rel,
          JSON.stringify(m.trigger),
          summary.slice(0, 500),
        );
      if (ins.changes === 0) return;
      const add = this.db.prepare(
        `INSERT OR IGNORE INTO snapshot_pieces (snapshot_id, project_id, page_id, piece, ref, doc_type, name, sha256, size, taken_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of pieces)
        add.run(m.id, m.project.id, p.pageId, p.piece, p.ref, p.docType, p.name, p.sha256, p.size, takenAt);
    })();
  }

  hasSnapshot(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM snapshots WHERE id = ?').get(id) !== undefined;
  }

  snapshot(id: string): SnapshotRow | null {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Raw | undefined;
    return r ? snapshotRow(r) : null;
  }

  snapshots(
    projectId: string | null,
    o: { readonly kind?: SnapshotKind; readonly limit?: number; readonly before?: number } = {},
  ): SnapshotRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (projectId !== null) {
      where.push('project_id = ?');
      args.push(projectId);
    }
    if (o.kind) {
      where.push('kind = ?');
      args.push(o.kind);
    }
    if (o.before !== undefined) {
      where.push('taken_at < ?');
      args.push(o.before);
    }
    const sql = `SELECT * FROM snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY taken_at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, o.limit ?? 200) as Raw[]).map(snapshotRow);
  }

  removeSnapshot(id: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  /** Marks snapshots partial because a piece they use is missing or damaged (the reason is kept). */
  markDamaged(ids: readonly string[], reason: string): number {
    const upd = this.db.prepare(
      `UPDATE snapshots SET state = 'partial', damaged = ? WHERE id = ? AND (damaged IS NULL OR damaged <> ?)`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) n += upd.run(reason.slice(0, 500), id, reason.slice(0, 500)).changes;
    })();
    return n;
  }

  /** The pieces of one snapshot (optionally of one page). */
  piecesOf(snapshotId: string, pageId?: string): PieceRow[] {
    const rows = (
      pageId === undefined
        ? this.db
            .prepare(
              `SELECT p.*, s.kind, s.state FROM snapshot_pieces p JOIN snapshots s ON s.id = p.snapshot_id WHERE p.snapshot_id = ?`,
            )
            .all(snapshotId)
        : this.db
            .prepare(
              `SELECT p.*, s.kind, s.state FROM snapshot_pieces p JOIN snapshots s ON s.id = p.snapshot_id
               WHERE p.snapshot_id = ? AND p.page_id = ?`,
            )
            .all(snapshotId, pageId)
    ) as Raw[];
    return rows.map(pieceRow);
  }

  /** A page's history: every indexed piece row (optionally one piece, one document), newest first. */
  pageHistory(
    projectId: string,
    pageId: string,
    o: { readonly piece?: string; readonly ref?: string; readonly limit?: number } = {},
  ): PieceRow[] {
    const where = ['p.project_id = ?', 'p.page_id = ?'];
    const args: unknown[] = [projectId, pageId];
    if (o.piece) {
      if (o.piece === 'document') where.push(`p.piece IN ('document', 'document-deleted', 'deleted')`);
      else {
        where.push(`p.piece IN (?, 'deleted')`);
        args.push(o.piece);
      }
    }
    if (o.ref !== undefined) {
      where.push(`(p.ref = ? OR p.piece = 'deleted')`);
      args.push(o.ref);
    }
    return (
      this.db
        .prepare(
          `SELECT p.*, s.kind, s.state FROM snapshot_pieces p JOIN snapshots s ON s.id = p.snapshot_id
           WHERE ${where.join(' AND ')} ORDER BY p.taken_at DESC, p.snapshot_id DESC LIMIT ?`,
        )
        .all(...args, o.limit ?? 500) as Raw[]
    ).map(pieceRow);
  }

  /** Pages that have any snapshot, with their last known name (for the dashboard's page picker and deleted pages). */
  pagesWithHistory(
    projectId: string,
    o: { readonly query?: string; readonly limit?: number } = {},
  ): {
    pageId: string;
    name: string | null;
    lastAt: number;
    deleted: boolean;
  }[] {
    const like = o.query ? `%${o.query.replace(/[%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = this.db
      .prepare(
        // The page's latest name is a subquery's; it is filtered in an outer query, because inside the grouped one
        // `name` would be the table's own column (a document's name, of an arbitrary row).
        `SELECT * FROM (
           SELECT page_id, MAX(taken_at) AS last_at,
             (SELECT name FROM snapshot_pieces q WHERE q.project_id = p.project_id AND q.page_id = p.page_id AND q.name IS NOT NULL
                AND q.piece IN ('resource', 'sidebar', 'deleted') ORDER BY q.taken_at DESC LIMIT 1) AS page_name,
             (SELECT piece FROM snapshot_pieces q WHERE q.project_id = p.project_id AND q.page_id = p.page_id
                AND q.piece IN ('resource', 'deleted') ORDER BY q.taken_at DESC LIMIT 1) AS last_piece
           FROM snapshot_pieces p WHERE project_id = ? AND page_id <> '*'
           GROUP BY page_id)
         ${like ? `WHERE page_name LIKE ? ESCAPE '\\'` : ''}
         ORDER BY last_at DESC LIMIT ?`,
      )
      .all(...(like ? [projectId, like] : [projectId]), o.limit ?? 200) as Raw[];
    return rows.map((r) => ({
      pageId: String(r.page_id),
      name: strOrNull(r.page_name),
      lastAt: num(r.last_at),
      deleted: r.last_piece === 'deleted',
    }));
  }

  /** Every hash any snapshot refers to. */
  referencedBySnapshots(): Set<string> {
    const s = new Set<string>();
    for (const r of this.db
      .prepare('SELECT DISTINCT sha256 FROM snapshot_pieces WHERE sha256 IS NOT NULL')
      .all() as {
      sha256: string;
    }[])
      s.add(r.sha256);
    return s;
  }

  /** Hashes runs in progress have stored (their pages' entries), so the collector keeps them. */
  referencedByRuns(): Set<string> {
    const s = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT p.entry FROM snapshot_run_pages p JOIN snapshot_runs r ON r.id = p.run_id
         WHERE r.state = 'running' AND p.entry IS NOT NULL`,
      )
      .all() as { entry: string }[];
    for (const r of rows) {
      const e = json<PageEntry | null>(r.entry, null);
      if (!e) continue;
      if (e.resource) s.add(e.resource.sha256);
      if (e.sidebar) s.add(e.sidebar.sha256);
      for (const d of e.documents ?? []) s.add(d.sha256);
      for (const i of e.images ?? []) if (i.sha256) s.add(i.sha256);
    }
    for (const r of this.db
      .prepare(`SELECT library FROM snapshot_runs WHERE state = 'running' AND library IS NOT NULL`)
      .all() as {
      library: string;
    }[]) {
      const lib = json<{ piece?: { sha256?: string }; images?: { sha256?: string | null }[] } | null>(
        r.library,
        null,
      );
      if (lib?.piece?.sha256) s.add(lib.piece.sha256);
      for (const i of lib?.images ?? []) if (i.sha256) s.add(i.sha256);
    }
    return s;
  }

  /** Hashes D3's kept bytes still refer to (their retention has not ended). */
  referencedByKeptBytes(now: number): Set<string> {
    const s = new Set<string>();
    try {
      for (const r of this.db
        .prepare('SELECT DISTINCT sha256 FROM asset_kept_refs WHERE expires_at > ?')
        .all(now) as {
        sha256: string;
      }[])
        s.add(r.sha256);
      // A kept file with no reference row yet (written just now) is kept too.
      for (const r of this.db.prepare('SELECT sha256 FROM asset_kept_bytes').all() as { sha256: string }[])
        s.add(r.sha256);
    } catch {
      /* the images tables are missing (a database before migration 1950) */
    }
    return s;
  }

  /** The snapshots that refer to a hash. */
  snapshotsUsing(sha256: string): string[] {
    return (
      this.db.prepare('SELECT DISTINCT snapshot_id FROM snapshot_pieces WHERE sha256 = ?').all(sha256) as {
        snapshot_id: string;
      }[]
    ).map((r) => r.snapshot_id);
  }

  /** The size (uncompressed) every snapshot's pieces add up to, and the unique pieces' (for the dedup ratio). */
  logicalTotals(projectId?: string): { referenced: number; unique: number; uniqueCount: number } {
    const where = projectId ? 'WHERE project_id = ? AND sha256 IS NOT NULL' : 'WHERE sha256 IS NOT NULL';
    const args = projectId ? [projectId] : [];
    const a = this.db
      .prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM snapshot_pieces ${where}`)
      .get(...args) as Raw;
    const b = this.db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM (SELECT sha256, MAX(size) AS size FROM snapshot_pieces ${where} GROUP BY sha256)`,
      )
      .get(...args) as Raw;
    return { referenced: num(a.n), unique: num(b.n), uniqueCount: num(b.c) };
  }

  countsByKind(projectId: string): Record<string, { count: number; last: number | null }> {
    const out: Record<string, { count: number; last: number | null }> = {};
    for (const r of this.db
      .prepare(
        'SELECT kind, COUNT(*) AS c, MAX(taken_at) AS last FROM snapshots WHERE project_id = ? GROUP BY kind',
      )
      .all(projectId) as Raw[])
      out[String(r.kind)] = { count: num(r.c), last: r.last === null ? null : num(r.last) };
    return out;
  }

  // ============================================================================================ runs

  createRun(r: {
    id: string;
    projectId: string;
    kind: 'full';
    trigger: string;
    rootId: string | null;
    pages: readonly string[];
    estimate?: Record<string, unknown>;
  }): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO snapshot_runs (id, project_id, kind, state, trigger, started_at, updated_at, root_id, total, estimate)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.projectId,
          r.kind,
          r.trigger,
          now,
          now,
          r.rootId,
          r.pages.length,
          r.estimate ? JSON.stringify(r.estimate) : null,
        );
      const add = this.db.prepare(
        `INSERT OR IGNORE INTO snapshot_run_pages (run_id, page_id, seq, state) VALUES (?, ?, ?, 'pending')`,
      );
      r.pages.forEach((p, i) => add.run(r.id, p, i));
    })();
  }

  /** A refused run (disk space): recorded so the dashboard shows it, with nothing to resume. */
  refusedRun(r: {
    id: string;
    projectId: string;
    kind: 'full';
    trigger: string;
    error: string;
    estimate?: Record<string, unknown>;
  }): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO snapshot_runs (id, project_id, kind, state, trigger, started_at, updated_at, finished_at, error, estimate)
         VALUES (?, ?, ?, 'refused', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.projectId,
        r.kind,
        r.trigger,
        now,
        now,
        now,
        r.error,
        r.estimate ? JSON.stringify(r.estimate) : null,
      );
  }

  run(id: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM snapshot_runs WHERE id = ?').get(id) as Raw | undefined;
    return r ? runRow(r) : null;
  }

  runningRun(projectId: string, kind: 'full'): RunRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM snapshot_runs WHERE project_id = ? AND kind = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(projectId, kind) as Raw | undefined;
    return r ? runRow(r) : null;
  }

  runs(projectId: string | null, limit = 20): RunRow[] {
    return (
      (projectId === null
        ? this.db.prepare('SELECT * FROM snapshot_runs ORDER BY started_at DESC LIMIT ?').all(limit)
        : this.db
            .prepare('SELECT * FROM snapshot_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
            .all(projectId, limit)) as Raw[]
    ).map(runRow);
  }

  pendingPages(runId: string): string[] {
    return (
      this.db
        .prepare(`SELECT page_id FROM snapshot_run_pages WHERE run_id = ? AND state = 'pending' ORDER BY seq`)
        .all(runId) as { page_id: string }[]
    ).map((r) => r.page_id);
  }

  /** Records a page done (its entry), and the run's counters, in one transaction: a restart continues after it. */
  savePage(
    runId: string,
    pageId: string,
    entry: PageEntry | null,
    add: { reads: number; downloads: number; newObjects: number; newBytes: number },
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE snapshot_run_pages SET state = 'done', entry = ? WHERE run_id = ? AND page_id = ?`)
        .run(entry ? JSON.stringify(entry) : null, runId, pageId);
      this.db
        .prepare(
          `UPDATE snapshot_runs SET done = done + 1, reads = reads + ?, downloads = downloads + ?, new_objects = new_objects + ?,
             new_bytes = new_bytes + ?, updated_at = ? WHERE id = ?`,
        )
        .run(add.reads, add.downloads, add.newObjects, add.newBytes, this.now(), runId);
    })();
  }

  addRunCounts(
    runId: string,
    add: { reads: number; downloads: number; newObjects: number; newBytes: number },
  ): void {
    this.db
      .prepare(
        `UPDATE snapshot_runs SET reads = reads + ?, downloads = downloads + ?, new_objects = new_objects + ?,
           new_bytes = new_bytes + ?, updated_at = ? WHERE id = ?`,
      )
      .run(add.reads, add.downloads, add.newObjects, add.newBytes, this.now(), runId);
  }

  setRunLibrary(runId: string, library: unknown): void {
    this.db
      .prepare('UPDATE snapshot_runs SET library = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(library), this.now(), runId);
  }

  runEntries(runId: string): PageEntry[] {
    return (
      this.db
        .prepare(
          `SELECT entry FROM snapshot_run_pages WHERE run_id = ? AND state = 'done' AND entry IS NOT NULL ORDER BY seq`,
        )
        .all(runId) as { entry: string }[]
    )
      .map((r) => json<PageEntry | null>(r.entry, null))
      .filter((e): e is PageEntry => e !== null);
  }

  finishRun(id: string, state: RunState, o: { error?: string; snapshotId?: string } = {}): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE snapshot_runs SET state = ?, finished_at = ?, updated_at = ?, error = ?, snapshot_id = ? WHERE id = ?`,
      )
      .run(state, now, now, o.error ?? null, o.snapshotId ?? null, id);
    if (state !== 'running') this.db.prepare('DELETE FROM snapshot_run_pages WHERE run_id = ?').run(id);
  }

  noteRunError(id: string, error: string): void {
    this.db
      .prepare('UPDATE snapshot_runs SET error = ?, updated_at = ? WHERE id = ?')
      .run(error.slice(0, 1000), this.now(), id);
  }

  // ============================================================================================ owed change snapshots

  addOwed(rows: readonly Omit<OwedRow, 'id' | 'createdAt'>[]): void {
    if (rows.length === 0) return;
    const now = this.now();
    const ins = this.db.prepare(
      `INSERT INTO snapshot_owed (project_id, job_id, page_id, piece, ref, op_id, tool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const r of rows) ins.run(r.projectId, r.jobId, r.pageId, r.piece, r.ref, r.opId, r.tool, now);
    })();
  }

  owedFor(projectId: string, jobId: string): OwedRow[] {
    return (
      this.db
        .prepare('SELECT * FROM snapshot_owed WHERE project_id = ? AND job_id = ? ORDER BY id')
        .all(projectId, jobId) as Raw[]
    ).map((r) => ({
      id: num(r.id),
      projectId: String(r.project_id),
      jobId: String(r.job_id),
      pageId: String(r.page_id),
      piece: String(r.piece),
      ref: typeof r.ref === 'string' ? r.ref : '',
      opId: String(r.op_id),
      tool: strOrNull(r.tool),
      createdAt: num(r.created_at),
    }));
  }

  /** Jobs with owed change snapshots (start-up recovery). */
  owedJobs(): { projectId: string; jobId: string }[] {
    return (
      this.db
        .prepare('SELECT DISTINCT project_id, job_id FROM snapshot_owed ORDER BY project_id, job_id')
        .all() as Raw[]
    ).map((r) => ({ projectId: String(r.project_id), jobId: String(r.job_id) }));
  }

  owedCount(projectId?: string): number {
    const r = (
      projectId
        ? this.db.prepare('SELECT COUNT(*) AS n FROM snapshot_owed WHERE project_id = ?').get(projectId)
        : this.db.prepare('SELECT COUNT(*) AS n FROM snapshot_owed').get()
    ) as Raw;
    return num(r.n);
  }

  clearOwed(ids: readonly number[]): void {
    const del = this.db.prepare('DELETE FROM snapshot_owed WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) del.run(id);
    })();
  }

  // ============================================================================================ findings

  openFindings(limit = 200): FindingRow[] {
    return (
      this.db
        .prepare('SELECT * FROM snapshot_findings WHERE resolved_at IS NULL ORDER BY found_at DESC LIMIT ?')
        .all(limit) as Raw[]
    ).map((r) => ({
      id: num(r.id),
      sha256: String(r.sha256),
      problem: r.problem as FindingRow['problem'],
      detail: strOrNull(r.detail),
      snapshots: json<string[]>(r.snapshots, []),
      foundAt: num(r.found_at),
      resolvedAt: null,
    }));
  }

  /** Records a finding unless the same one is already open. */
  addFinding(f: {
    sha256: string;
    problem: FindingRow['problem'];
    detail?: string;
    snapshots: readonly string[];
  }): boolean {
    const open = this.db
      .prepare('SELECT id FROM snapshot_findings WHERE sha256 = ? AND problem = ? AND resolved_at IS NULL')
      .get(f.sha256, f.problem) as Raw | undefined;
    if (open) {
      this.db
        .prepare('UPDATE snapshot_findings SET snapshots = ?, detail = ? WHERE id = ?')
        .run(JSON.stringify(f.snapshots), f.detail ?? null, Number(open.id));
      return false;
    }
    this.db
      .prepare(
        'INSERT INTO snapshot_findings (sha256, problem, detail, snapshots, found_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(f.sha256, f.problem, f.detail ?? null, JSON.stringify(f.snapshots), this.now());
    return true;
  }

  resolveFindings(sha256: string): number {
    return this.db
      .prepare('UPDATE snapshot_findings SET resolved_at = ? WHERE sha256 = ? AND resolved_at IS NULL')
      .run(this.now(), sha256).changes;
  }

  // ============================================================================================ notices

  notice(n: { projectId: string | null; level: NoticeRow['level']; code: string; message: string }): void {
    this.db
      .prepare('INSERT INTO snapshot_notices (project_id, level, code, message, at) VALUES (?, ?, ?, ?, ?)')
      .run(n.projectId, n.level, n.code, n.message.slice(0, 2000), this.now());
    // Keep the newest 500.
    this.db
      .prepare(
        'DELETE FROM snapshot_notices WHERE id NOT IN (SELECT id FROM snapshot_notices ORDER BY id DESC LIMIT 500)',
      )
      .run();
  }

  notices(projectId: string | null, limit = 50): NoticeRow[] {
    return (
      (projectId === null
        ? this.db.prepare('SELECT * FROM snapshot_notices ORDER BY id DESC LIMIT ?').all(limit)
        : this.db
            .prepare(
              'SELECT * FROM snapshot_notices WHERE project_id = ? OR project_id IS NULL ORDER BY id DESC LIMIT ?',
            )
            .all(projectId, limit)) as Raw[]
    ).map((r) => ({
      id: num(r.id),
      projectId: strOrNull(r.project_id),
      level: r.level as NoticeRow['level'],
      code: String(r.code),
      message: String(r.message),
      at: num(r.at),
    }));
  }

  // ============================================================================================ rehearsals

  createRehearsal(r: {
    id: string;
    projectId: string;
    sourceProjectId: string;
    snapshotId: string;
    mode: 'sampled' | 'full';
    keep: boolean;
    startedBy: string;
    estimate: Record<string, unknown>;
    plan: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO snapshot_rehearsals (id, project_id, source_project_id, snapshot_id, mode, state, keep, started_by, started_at, estimate, plan)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.projectId,
        r.sourceProjectId,
        r.snapshotId,
        r.mode,
        r.keep ? 1 : 0,
        r.startedBy,
        this.now(),
        JSON.stringify(r.estimate),
        JSON.stringify(r.plan),
      );
  }

  updateRehearsal(
    id: string,
    f: Partial<{
      state: RehearsalRow['state'];
      rootId: string;
      rootName: string;
      rootState: RehearsalRow['rootState'];
      progress: Record<string, unknown>;
      result: Record<string, unknown>;
      error: string | null;
      finished: boolean;
      keep: boolean;
    }>,
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (f.state !== undefined) set('state', f.state);
    if (f.rootId !== undefined) set('root_id', f.rootId);
    if (f.rootName !== undefined) set('root_name', f.rootName);
    if (f.rootState !== undefined) set('root_state', f.rootState);
    if (f.progress !== undefined) set('progress', JSON.stringify(f.progress));
    if (f.result !== undefined) set('result', JSON.stringify(f.result));
    if (f.error !== undefined) set('error', f.error);
    if (f.keep !== undefined) set('keep', f.keep ? 1 : 0);
    if (f.finished) set('finished_at', this.now());
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE snapshot_rehearsals SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  rehearsal(id: string): RehearsalRow | null {
    const r = this.db.prepare('SELECT * FROM snapshot_rehearsals WHERE id = ?').get(id) as Raw | undefined;
    return r ? rehearsalRow(r) : null;
  }

  rehearsals(projectId: string | null, limit = 50): RehearsalRow[] {
    return (
      (projectId === null
        ? this.db.prepare('SELECT * FROM snapshot_rehearsals ORDER BY started_at DESC LIMIT ?').all(limit)
        : this.db
            .prepare(
              'SELECT * FROM snapshot_rehearsals WHERE project_id = ? OR source_project_id = ? ORDER BY started_at DESC LIMIT ?',
            )
            .all(projectId, projectId, limit)) as Raw[]
    ).map(rehearsalRow);
  }

  runningRehearsals(): RehearsalRow[] {
    return (this.db.prepare(`SELECT * FROM snapshot_rehearsals WHERE state = 'running'`).all() as Raw[]).map(
      rehearsalRow,
    );
  }
}
