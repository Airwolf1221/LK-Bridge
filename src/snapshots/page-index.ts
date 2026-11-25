/**
 * The snapshot page index (the 25 November 2026 Snapshots freeze; ADR 0042 amendment 2, migration 4600).
 *
 * The Snapshots page's page list and a page's history used to come from an aggregate over every piece row of the
 * project, run synchronously inside the request (`SnapshotDb.pagesWithHistory`: a GROUP BY over every piece, and per
 * page a correlated subquery SQLite answered from `snapshot_pieces_name`, which scans every settings and sidebar row of
 * the project: pages × rows; 71 s at the retention's steady state, the event loop held throughout). Now:
 *
 * - **kept current as each snapshot is written:** `apply(snapshotId)` brings one snapshot's pages in (page → the
 *   snapshots that hold it, with sizes, times, the name it had and whether it was deleted; the page's summary row; the
 *   project's logical totals through each hash's reference count), in chunks of pages, each chunk one transaction,
 *   yielding to the event loop between chunks (never more than about 20 ms of work at a time). `forget(snapshotId)` is
 *   its inverse, before retention removes a snapshot. Both are idempotent and survive an interruption (a page already
 *   in, or already out, is skipped).
 * - **a one-time backfill** (`backfill`): the snapshots indexed before migration 4600 (`paged = 0`), newest first, the
 *   same `apply`; then the missing-piece lists of partial snapshots, from their manifests. Background work (the
 *   runtime's runner), pausing while agents' work is queued, as the full snapshot does.
 * - **read with indexed queries only**: the page list is keyset-paged on (last_at, page_id), filtered by name and branch
 *   on the server; nothing reads every snapshot per request.
 */
import type { Db } from '../db/open.js';
import { prepared } from '../db/statements.js';

/** One page in the list. */
export interface IndexedPage {
  readonly pageId: string;
  readonly name: string | null;
  readonly lastAt: number;
  readonly firstAt: number;
  readonly deleted: boolean;
  readonly branch: { readonly id: string; readonly name: string | null } | null;
  /** How many snapshots hold it, and their bytes (uncompressed). */
  readonly snapshots: number;
  readonly bytes: number;
  readonly lastSnapshotId: string | null;
}

export interface PageListQuery {
  /** "Name contains" (case-insensitive). */
  readonly query?: string;
  /** Only pages of this branch (the first index below the AI REPOSITORY root, by id). */
  readonly branch?: string;
  readonly limit: number;
  /** The `next` of the previous page of results. */
  readonly cursor?: string;
}

export interface Totals {
  readonly referenced: number;
  readonly unique: number;
  readonly uniqueCount: number;
}

/** The library's pseudo-page (`*`): counted in the totals, never listed as a page. */
const LIBRARY = '*';
/** Pages per transaction; the chunk loop yields once its slice of time is spent. */
const BATCH = 25;
const SLICE_MS = 20;

export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

class Aborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/** A keyset cursor: `<last_at>.<page_id>` (or `<taken_at>.<snapshot_id>`), base64url. */
export function encodeCursor(at: number, id: string): string {
  return Buffer.from(`${at}.${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(c: string | undefined): { at: number; id: string } | null {
  if (!c) return null;
  const s = Buffer.from(c, 'base64url').toString('utf8');
  const dot = s.indexOf('.');
  if (dot <= 0) return null;
  const at = Number(s.slice(0, dot));
  const id = s.slice(dot + 1);
  return Number.isSafeInteger(at) && id.length > 0 && id.length <= 128 ? { at, id } : null;
}

type Raw = Record<string, unknown>;

export class SnapshotPageIndex {
  /** Snapshots being applied or forgotten now (the backfill leaves them to their caller). */
  private readonly busy = new Set<string>();
  /** The longest stretch of synchronous work a chunk took (ms): the tests' evidence that it yields. */
  longestSliceMs = 0;
  /** How many times `apply`/`forget`/`backfill` yielded to the event loop. */
  yields = 0;

  constructor(private readonly db: Db) {}

  // ============================================================================================ writing

  /** Whether the snapshot's pages are in the index. */
  isPaged(snapshotId: string): boolean {
    const r = prepared(this.db, 'SELECT paged FROM snapshots WHERE id = ?').get(snapshotId) as
      { paged: number } | undefined;
    return r?.paged === 1;
  }

  /**
   * Brings one snapshot's pages into the index (idempotent; a page already in is skipped), in transactions of a few
   * pages, yielding between them. Returns false when there is no such snapshot.
   */
  async apply(snapshotId: string, o: { readonly signal?: AbortSignal } = {}): Promise<boolean> {
    const snap = prepared(this.db, 'SELECT id, project_id, kind, paged FROM snapshots WHERE id = ?').get(
      snapshotId,
    ) as { id: string; project_id: string; kind: string; paged: number } | undefined;
    if (!snap) return false;
    if (snap.paged === 1) return true;
    this.busy.add(snapshotId);
    try {
      const pagesOf = prepared(
        this.db,
        `SELECT page_id, COUNT(*) AS pieces, COALESCE(SUM(size), 0) AS bytes, MAX(taken_at) AS taken_at,
                MAX(CASE WHEN piece IN ('resource', 'sidebar', 'deleted') THEN name END) AS name,
                MAX(CASE WHEN piece = 'deleted' THEN 2 WHEN piece = 'resource' THEN 1 ELSE 0 END) AS st
           FROM snapshot_pieces WHERE snapshot_id = ? AND page_id > ?
          GROUP BY page_id ORDER BY page_id LIMIT ?`,
      );
      const hashesOf = prepared(
        this.db,
        'SELECT sha256, size FROM snapshot_pieces WHERE snapshot_id = ? AND page_id = ? AND sha256 IS NOT NULL',
      );
      const insert = prepared(
        this.db,
        `INSERT OR IGNORE INTO snapshot_page_snapshots
           (project_id, page_id, snapshot_id, taken_at, kind, pieces, bytes, name, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let after = '';
      for (;;) {
        const rows = pagesOf.all(snapshotId, after, BATCH) as {
          page_id: string;
          pieces: number;
          bytes: number;
          taken_at: number;
          name: string | null;
          st: number;
        }[];
        if (rows.length === 0) break;
        after = rows.at(-1)!.page_id;
        await this.slice(o.signal, () =>
          this.db.transaction(() => {
            for (const r of rows) {
              const state = r.st === 2 ? 'deleted' : r.st === 1 ? 'present' : null;
              const ins = insert.run(
                snap.project_id,
                r.page_id,
                snapshotId,
                r.taken_at,
                snap.kind,
                r.pieces,
                r.bytes,
                r.name,
                state,
              );
              if (ins.changes === 0) continue; // already in (an interrupted apply, or the backfill)
              this.countHashes(
                snap.project_id,
                hashesOf.all(snapshotId, r.page_id) as { sha256: string; size: number }[],
                +1,
              );
              if (r.page_id !== LIBRARY) this.recompute(snap.project_id, r.page_id, true);
            }
          })(),
        );
      }
      prepared(this.db, 'UPDATE snapshots SET paged = 1 WHERE id = ?').run(snapshotId);
      return true;
    } finally {
      this.busy.delete(snapshotId);
    }
  }

  /**
   * Takes one snapshot's pages out of the index (before retention removes it): each page's row goes, its summary is
   * worked out again from the snapshots still holding it (or goes too), and the totals lose its references. Yields
   * between chunks; idempotent.
   */
  async forget(snapshotId: string, o: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.busy.add(snapshotId);
    try {
      const next = prepared(
        this.db,
        `SELECT project_id, page_id, bytes FROM snapshot_page_snapshots WHERE snapshot_id = ? ORDER BY page_id LIMIT ?`,
      );
      const hashesOf = prepared(
        this.db,
        'SELECT sha256, size FROM snapshot_pieces WHERE snapshot_id = ? AND page_id = ? AND sha256 IS NOT NULL',
      );
      const del = prepared(
        this.db,
        'DELETE FROM snapshot_page_snapshots WHERE snapshot_id = ? AND page_id = ?',
      );
      for (;;) {
        const rows = next.all(snapshotId, BATCH) as { project_id: string; page_id: string; bytes: number }[];
        if (rows.length === 0) break;
        await this.slice(o.signal, () =>
          this.db.transaction(() => {
            for (const r of rows) {
              if (del.run(snapshotId, r.page_id).changes === 0) continue;
              this.countHashes(
                r.project_id,
                hashesOf.all(snapshotId, r.page_id) as { sha256: string; size: number }[],
                -1,
              );
              if (r.page_id !== LIBRARY) this.recompute(r.project_id, r.page_id, false);
            }
          })(),
        );
      }
      prepared(this.db, 'UPDATE snapshots SET paged = 0 WHERE id = ?').run(snapshotId);
    } finally {
      this.busy.delete(snapshotId);
    }
  }

  /**
   * The one-time backfill: every snapshot not in the index yet (indexed before migration 4600, or written by a bridge
   * that stopped before its `apply` finished), newest first, then the missing-piece lists of partial snapshots
   * (`listMissing` reads a manifest). Pauses while `busy()` says agents' work is queued; stops when aborted.
   */
  async backfill(o: {
    readonly signal?: AbortSignal;
    readonly busy?: () => boolean;
    readonly listMissing?: (snapshotId: string) => Promise<void>;
  }): Promise<{ paged: number; listed: number }> {
    let paged = 0;
    let listed = 0;
    const nextUnpaged = prepared(
      this.db,
      'SELECT id FROM snapshots WHERE paged = 0 ORDER BY taken_at DESC, id DESC LIMIT 50',
    );
    const wait = async () => {
      for (let i = 0; i < 240 && o.busy?.(); i++) {
        if (o.signal?.aborted) throw new Aborted();
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    for (;;) {
      const ids = (nextUnpaged.all() as { id: string }[]).map((r) => r.id).filter((id) => !this.busy.has(id));
      if (ids.length === 0) break;
      for (const id of ids) {
        await wait();
        if (o.signal?.aborted) throw new Aborted();
        if (await this.apply(id, o.signal ? { signal: o.signal } : {})) paged++;
      }
    }
    if (o.listMissing) {
      const nextUnlisted = prepared(
        this.db,
        'SELECT id FROM snapshots WHERE missing_listed = 0 ORDER BY taken_at DESC, id DESC LIMIT 50',
      );
      const tried = new Set<string>();
      for (;;) {
        const ids = (nextUnlisted.all() as { id: string }[]).map((r) => r.id).filter((id) => !tried.has(id));
        if (ids.length === 0) break;
        for (const id of ids) {
          tried.add(id);
          await wait();
          if (o.signal?.aborted) throw new Aborted();
          await o.listMissing(id);
          listed++;
          this.yields++;
          await yieldToLoop();
        }
      }
    }
    return { paged, listed };
  }

  /** Runs one chunk (synchronous work), then yields; aborts between chunks. */
  private async slice(signal: AbortSignal | undefined, fn: () => void): Promise<void> {
    if (signal?.aborted) throw new Aborted();
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    if (ms > this.longestSliceMs) this.longestSliceMs = ms;
    this.sliceSpent += ms;
    if (this.sliceSpent >= SLICE_MS) {
      this.sliceSpent = 0;
      this.yields++;
      await yieldToLoop();
    }
  }
  private sliceSpent = 0;

  /** References counted up (+1) or down (-1) for one page of one snapshot; the totals follow. */
  private countHashes(
    projectId: string,
    hashes: readonly { sha256: string; size: number }[],
    dir: 1 | -1,
  ): void {
    let bytes = 0;
    const get = prepared(this.db, 'SELECT refs FROM snapshot_hash_refs WHERE project_id = ? AND sha256 = ?');
    let newBytes = 0;
    let newCount = 0;
    for (const h of hashes) {
      bytes += h.size;
      const cur = (get.get(projectId, h.sha256) as { refs: number } | undefined)?.refs ?? 0;
      if (dir === 1) {
        if (cur === 0) {
          prepared(
            this.db,
            'INSERT INTO snapshot_hash_refs (project_id, sha256, size, refs) VALUES (?, ?, ?, 1)',
          ).run(projectId, h.sha256, h.size);
          newBytes += h.size;
          newCount++;
        } else
          prepared(
            this.db,
            'UPDATE snapshot_hash_refs SET refs = refs + 1 WHERE project_id = ? AND sha256 = ?',
          ).run(projectId, h.sha256);
      } else if (cur <= 1) {
        if (cur === 1) {
          prepared(this.db, 'DELETE FROM snapshot_hash_refs WHERE project_id = ? AND sha256 = ?').run(
            projectId,
            h.sha256,
          );
          newBytes -= h.size;
          newCount--;
        }
      } else
        prepared(
          this.db,
          'UPDATE snapshot_hash_refs SET refs = refs - 1 WHERE project_id = ? AND sha256 = ?',
        ).run(projectId, h.sha256);
    }
    prepared(
      this.db,
      `INSERT INTO snapshot_totals (project_id, referenced, unique_bytes, unique_count) VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id) DO UPDATE SET referenced = referenced + excluded.referenced,
             unique_bytes = unique_bytes + excluded.unique_bytes, unique_count = unique_count + excluded.unique_count`,
    ).run(projectId, dir * bytes, newBytes, newCount);
  }

  /** A page's summary row, worked out again from the snapshots holding it (indexed: that page's rows only). */
  private recompute(projectId: string, pageId: string, added: boolean): void {
    const agg = prepared(
      this.db,
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, MIN(taken_at) AS first_at
           FROM snapshot_page_snapshots WHERE project_id = ? AND page_id = ?`,
    ).get(projectId, pageId) as { n: number; bytes: number; first_at: number | null };
    if (agg.n === 0) {
      prepared(this.db, 'DELETE FROM snapshot_pages WHERE project_id = ? AND page_id = ?').run(
        projectId,
        pageId,
      );
      return;
    }
    const latest = (cond: string) =>
      prepared(
        this.db,
        `SELECT snapshot_id, taken_at, name, state FROM snapshot_page_snapshots
            WHERE project_id = ? AND page_id = ? ${cond} ORDER BY taken_at DESC, snapshot_id DESC LIMIT 1`,
      ).get(projectId, pageId) as
        { snapshot_id: string; taken_at: number; name: string | null; state: string | null } | undefined;
    const last = latest('')!;
    const name = latest('AND name IS NOT NULL')?.name ?? null;
    const state = latest('AND state IS NOT NULL')?.state ?? null;
    // The branch: from the repository tree when the page is in it now; else the one recorded before.
    const branch = added ? this.branchOf(projectId, pageId) : null;
    prepared(
      this.db,
      `INSERT INTO snapshot_pages (project_id, page_id, name, name_key, deleted, branch_id, branch_name, snapshots, bytes,
           first_at, last_at, last_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, page_id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
           deleted = excluded.deleted, branch_id = COALESCE(excluded.branch_id, branch_id),
           branch_name = CASE WHEN excluded.branch_id IS NULL THEN branch_name ELSE excluded.branch_name END,
           snapshots = excluded.snapshots, bytes = excluded.bytes, first_at = excluded.first_at,
           last_at = excluded.last_at, last_snapshot_id = excluded.last_snapshot_id`,
    ).run(
      projectId,
      pageId,
      name,
      (name ?? '').toLowerCase(),
      state === 'deleted' ? 1 : 0,
      branch?.id ?? null,
      branch?.name ?? null,
      agg.n,
      agg.bytes,
      agg.first_at,
      last.taken_at,
      last.snapshot_id,
    );
  }

  /** The page's branch now: the first node below the AI REPOSITORY root on its path in the repository tree. */
  private branchOf(projectId: string, pageId: string): { id: string; name: string } | null {
    let r: { path_ids: string; path_names: string } | undefined;
    try {
      r = prepared(
        this.db,
        'SELECT path_ids, path_names FROM tree_nodes WHERE project_id = ? AND id = ?',
      ).get(projectId, pageId) as typeof r;
    } catch {
      return null; // no repository tree in this database
    }
    if (!r) return null;
    try {
      const ids = JSON.parse(r.path_ids) as string[];
      const names = JSON.parse(r.path_names) as string[];
      return ids.length > 1 ? { id: ids[1]!, name: names[1] ?? ids[1]! } : null;
    } catch {
      return null;
    }
  }

  // ============================================================================================ reading

  /** One page of the page list, newest first, filtered by name and branch; `next` when more follow. */
  list(projectId: string, q: PageListQuery): { pages: IndexedPage[]; next: string | null } {
    const where = ['project_id = ?', `page_id <> '${LIBRARY}'`];
    const args: unknown[] = [projectId];
    if (q.branch) {
      where.push('branch_id = ?');
      args.push(q.branch);
    }
    const term = q.query?.trim().toLowerCase();
    if (term) {
      where.push('instr(name_key, ?) > 0');
      args.push(term);
    }
    const c = decodeCursor(q.cursor);
    if (c) {
      where.push('(last_at < ? OR (last_at = ? AND page_id < ?))');
      args.push(c.at, c.at, c.id);
    }
    const rows = prepared(
      this.db,
      `SELECT * FROM snapshot_pages INDEXED BY ${q.branch ? 'snapshot_pages_branch' : 'snapshot_pages_recent'}
          WHERE ${where.join(' AND ')} ORDER BY last_at DESC, page_id DESC LIMIT ?`,
    ).all(...args, q.limit + 1) as Raw[];
    const pages = rows.slice(0, q.limit).map(pageRow);
    const last = pages.at(-1);
    return { pages, next: rows.length > q.limit && last ? encodeCursor(last.lastAt, last.pageId) : null };
  }

  /** The branches the listed pages are in, with how many pages each (for the filter). */
  branches(projectId: string): { id: string; name: string | null; pages: number }[] {
    return (
      prepared(
        this.db,
        `SELECT branch_id, MAX(branch_name) AS branch_name, COUNT(*) AS n FROM snapshot_pages INDEXED BY snapshot_pages_branch
            WHERE project_id = ? AND branch_id IS NOT NULL GROUP BY branch_id`,
      ).all(projectId) as { branch_id: string; branch_name: string | null; n: number }[]
    )
      .map((r) => ({ id: r.branch_id, name: r.branch_name, pages: r.n }))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  page(projectId: string, pageId: string): IndexedPage | null {
    const r = prepared(this.db, 'SELECT * FROM snapshot_pages WHERE project_id = ? AND page_id = ?').get(
      projectId,
      pageId,
    ) as Raw | undefined;
    return r ? pageRow(r) : null;
  }

  /** The project's logical totals (every piece's bytes; each distinct piece once), kept with the index. */
  totals(projectId: string): Totals {
    const r = prepared(
      this.db,
      'SELECT referenced, unique_bytes, unique_count FROM snapshot_totals WHERE project_id = ?',
    ).get(projectId) as { referenced: number; unique_bytes: number; unique_count: number } | undefined;
    return {
      referenced: r?.referenced ?? 0,
      unique: r?.unique_bytes ?? 0,
      uniqueCount: r?.unique_count ?? 0,
    };
  }

  /** How far the index is: snapshots of the project in it, and still to come (the backfill's progress). */
  status(projectId: string): { indexed: number; pending: number; missingPending: number } {
    const r = prepared(
      this.db,
      `SELECT SUM(paged = 1) AS indexed, SUM(paged = 0) AS pending, SUM(missing_listed = 0) AS unlisted
           FROM snapshots WHERE project_id = ?`,
    ).get(projectId) as { indexed: number | null; pending: number | null; unlisted: number | null };
    return { indexed: r.indexed ?? 0, pending: r.pending ?? 0, missingPending: r.unlisted ?? 0 };
  }
}

function pageRow(r: Raw): IndexedPage {
  return {
    pageId: String(r.page_id),
    name: typeof r.name === 'string' ? r.name : null,
    lastAt: Number(r.last_at),
    firstAt: Number(r.first_at),
    deleted: Number(r.deleted) === 1,
    branch:
      typeof r.branch_id === 'string'
        ? { id: r.branch_id, name: typeof r.branch_name === 'string' ? r.branch_name : null }
        : null,
    snapshots: Number(r.snapshots),
    bytes: Number(r.bytes),
    lastSnapshotId: typeof r.last_snapshot_id === 'string' ? r.last_snapshot_id : null,
  };
}
