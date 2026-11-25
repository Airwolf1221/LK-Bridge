/**
 * A page's snapshot history and the diffs between its states (v2 E1a, ADR 0042), shared by the snapshot tools
 * (`list_snapshots`, `snapshot_diff`) and the dashboard's Snapshots page, so both show the same thing.
 *
 * - `pieceFilterOf`: "sidebar", "settings", or a document by id or by a name the page's snapshots know.
 * - `historyOf`: the page's snapshots, newest first, each piece compared with the same piece's previous state. Free: the
 *   bridge's own index.
 * - `pieceThen` / `pieceNow`: one piece rendered as text, at a snapshot (free) or as the page is now (a few reads at P1).
 */
import { documentPieceOf } from './capture.js';
import {
  resourcePiece,
  sidebarPiece,
  type DocumentPiece,
  type ResourcePiece,
  type SidebarPiece,
} from './canonical.js';
import { prepared } from '../db/statements.js';
import type { PieceRow } from './db.js';
import { decodeCursor, encodeCursor } from './page-index.js';
import { renderDocument, renderResource, renderSidebar } from './diff.js';
import { RestoreError, stateAt } from './restore.js';
import type { SnapshotService } from './service.js';

type Obj = Record<string, unknown>;

/** Which piece of a page: everything, its settings (the resource), its sidebar, or one document. */
export interface PieceFilter {
  readonly piece?: 'resource' | 'sidebar' | 'document';
  readonly ref?: string;
  readonly label: string;
}

export type PieceFilterResult =
  PieceFilter | { readonly error: string; readonly documents: { id: string; name: string | null }[] };

/** The documents the page's snapshots know (id → the last name seen). */
export function documentsOf(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
): Map<string, string | null> {
  const rows = svc.index.pageHistory(projectId, pageId, { piece: 'document', limit: 5000 });
  const docs = new Map<string, string | null>();
  for (const r of rows)
    if (r.piece === 'document' || r.piece === 'document-deleted')
      if (!docs.has(r.ref) || (r.name && !docs.get(r.ref))) docs.set(r.ref, r.name);
  return docs;
}

export function pieceFilterOf(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  piece: string | undefined,
): PieceFilterResult {
  if (!piece) return { label: 'everything' };
  const p = piece.trim();
  if (p.toLowerCase() === 'sidebar') return { piece: 'sidebar', label: 'sidebar' };
  if (p.toLowerCase() === 'settings' || p.toLowerCase() === 'resource')
    return { piece: 'resource', label: 'page settings' };
  const docs = documentsOf(svc, projectId, pageId);
  if (docs.has(p)) return { piece: 'document', ref: p, label: `document ${docs.get(p) ?? p}` };
  const byName = [...docs].filter(([, n]) => n !== null && n.toLowerCase() === p.toLowerCase());
  if (byName.length === 1)
    return { piece: 'document', ref: byName[0]![0], label: `document ${byName[0]![1]}` };
  return {
    error:
      byName.length > 1
        ? `Several documents of this page were named “${p}”; give its id.`
        : `No document “${p}” in this page’s snapshots.`,
    documents: [...docs].map(([id, name]) => ({ id, name })),
  };
}

export interface HistoryPiece {
  /** "settings", "sidebar", or "document <name>". */
  readonly piece: string;
  readonly documentId?: string;
  readonly change:
    'deleted' | 'missing (a partial snapshot)' | 'first seen' | 'back' | 'unchanged' | 'changed';
}

export interface HistoryEntry {
  readonly snapshot: string;
  readonly takenAt: string;
  readonly kind: string;
  readonly partial?: true;
  readonly damaged?: unknown;
  readonly madeBy?: string;
  readonly pieces: HistoryPiece[];
}

function rowView(r: PieceRow, prev: PieceRow | undefined): HistoryPiece {
  const change: HistoryPiece['change'] =
    r.piece === 'deleted' || r.piece === 'document-deleted'
      ? 'deleted'
      : r.sha256 === null
        ? 'missing (a partial snapshot)'
        : !prev
          ? 'first seen'
          : prev.piece === 'deleted' || prev.piece === 'document-deleted'
            ? 'back'
            : prev.sha256 === r.sha256
              ? 'unchanged'
              : 'changed';
  return {
    piece:
      r.piece === 'document' || r.piece === 'document-deleted'
        ? `document ${r.name ?? r.ref}`
        : r.piece === 'resource'
          ? 'settings'
          : r.piece,
    ...(r.piece === 'document' || r.piece === 'document-deleted' ? { documentId: r.ref } : {}),
    change,
  };
}

/** The SQL (and its arguments) selecting one piece of a page's rows, page deletions included (as `pageHistory`). */
function pieceWhere(f: Pick<PieceFilter, 'piece' | 'ref'>): { sql: string; args: unknown[] } {
  const sql: string[] = [];
  const args: unknown[] = [];
  if (f.piece === 'document') sql.push(`piece IN ('document', 'document-deleted', 'deleted')`);
  else if (f.piece) {
    sql.push(`piece IN (?, 'deleted')`);
    args.push(f.piece);
  }
  if (f.ref !== undefined) {
    sql.push(`(ref = ? OR piece = 'deleted')`);
    args.push(f.ref);
  }
  return { sql: sql.map((x) => ` AND ${x}`).join(''), args };
}

const keyOf = (r: Pick<PieceRow, 'piece' | 'ref'>): string =>
  r.piece === 'deleted' ? '*' : `${r.piece === 'document-deleted' ? 'document' : r.piece}:${r.ref}`;

/** Whether `a` is newer than `b` in history order (taken_at, then snapshot id). */
const newer = (a: PieceRow, b: PieceRow): boolean =>
  a.takenAt !== b.takenAt ? a.takenAt > b.takenAt : a.snapshotId > b.snapshotId;

/**
 * The page's snapshots (of one piece, or of everything), newest first, `limit` at a time: `cursor` is the previous
 * page's `next`. The 25 November 2026 freeze (ADR 0042 amendment 2): only this page's rows are read, through the page
 * index (`snapshot_pieces_page`), and only those of the snapshots shown, each piece compared with its state just
 * before them (one indexed lookup per piece); never every snapshot of the project.
 */
export function historyOf(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  f: Pick<PieceFilter, 'piece' | 'ref'>,
  limit: number,
  cursor?: string,
): { count: number; snapshots: HistoryEntry[]; more?: number; next?: string } {
  const db = svc.index.db;
  const w = pieceWhere(f);
  const base = `FROM snapshot_pieces INDEXED BY snapshot_pieces_page WHERE project_id = ? AND page_id = ?${w.sql}`;
  const args = [projectId, pageId, ...w.args];
  const count = (
    prepared(db, `SELECT COUNT(DISTINCT snapshot_id) AS n ${base}`).get(...args) as { n: number }
  ).n;
  const c = decodeCursor(cursor);
  const shown = db
    .prepare(
      `SELECT snapshot_id, MAX(taken_at) AS t ${base} GROUP BY snapshot_id
       ${c ? 'HAVING (t < ? OR (t = ? AND snapshot_id < ?))' : ''} ORDER BY t DESC, snapshot_id DESC LIMIT ?`,
    )
    .all(...args, ...(c ? [c.at, c.at, c.id] : []), limit + 1) as { snapshot_id: string; t: number }[];
  const page = shown.slice(0, limit);
  if (page.length === 0) return { count, snapshots: [] };
  // The rows of the snapshots shown (each by its primary key), this piece only, oldest first.
  const want = (r: PieceRow) =>
    (f.piece === undefined ||
      r.piece === 'deleted' ||
      (f.piece === 'document'
        ? r.piece === 'document' || r.piece === 'document-deleted'
        : r.piece === f.piece)) &&
    (f.ref === undefined || r.ref === f.ref || r.piece === 'deleted');
  const bySnap = new Map<string, PieceRow[]>();
  for (const s of page) bySnap.set(s.snapshot_id, svc.index.piecesOf(s.snapshot_id, pageId).filter(want));
  const asc = [...page].reverse().flatMap((s) => bySnap.get(s.snapshot_id) ?? []);
  // Each piece's state just before the oldest snapshot shown, and the page's last deletion before it.
  const oldest = page.at(-1)!;
  const before = (pieceSql: string, pieceArgs: unknown[]): PieceRow | undefined => {
    const r = prepared(
      db,
      `SELECT p.*, s.kind, s.state FROM snapshot_pieces p INDEXED BY snapshot_pieces_page JOIN snapshots s ON s.id = p.snapshot_id
          WHERE p.project_id = ? AND p.page_id = ? AND ${pieceSql}
            AND (p.taken_at < ? OR (p.taken_at = ? AND p.snapshot_id < ?))
          ORDER BY p.taken_at DESC, p.snapshot_id DESC LIMIT 1`,
    ).get(projectId, pageId, ...pieceArgs, oldest.t, oldest.t, oldest.snapshot_id) as
      Record<string, unknown> | undefined;
    return r ? svc.index.pieceRowOf(r) : undefined;
  };
  const lastDeleted = before(`p.piece = 'deleted' AND p.ref = ''`, []);
  const lastBy = new Map<string, PieceRow>();
  if (lastDeleted) lastBy.set('*', lastDeleted);
  for (const r of asc) {
    const k = keyOf(r);
    if (k === '*' || lastBy.has(k)) continue;
    const prev =
      r.piece === 'document' || r.piece === 'document-deleted'
        ? before(`p.piece IN ('document', 'document-deleted') AND p.ref = ?`, [r.ref])
        : before(`p.piece = ? AND p.ref = ?`, [r.piece, r.ref]);
    const seed =
      prev && lastDeleted ? (newer(prev, lastDeleted) ? prev : lastDeleted) : (prev ?? lastDeleted);
    if (seed) lastBy.set(k, seed);
  }
  // Each piece compared with the same piece's previous row; a page deletion resets them all.
  const prevOf = new Map<PieceRow, PieceRow | undefined>();
  for (const r of asc) {
    const k = keyOf(r);
    const prev = r.piece === 'deleted' ? undefined : (lastBy.get(k) ?? lastBy.get('*'));
    prevOf.set(r, prev);
    lastBy.set(k, r);
    if (r.piece === 'deleted') for (const key of [...lastBy.keys()]) lastBy.set(key, r);
  }
  const snapshots = page.map(({ snapshot_id: id }): HistoryEntry => {
    // Its pieces in a fixed order: by piece, then reference (the snapshot's primary key).
    const list = bySnap.get(id) ?? [];
    const s = svc.index.snapshot(id);
    const first = list[0];
    return {
      snapshot: id,
      takenAt: new Date(first?.takenAt ?? s?.takenAt ?? 0).toISOString(),
      kind: first?.kind ?? s?.kind ?? 'change',
      ...((first?.state ?? s?.state) === 'partial'
        ? { partial: true as const, ...(s?.damaged ? { damaged: s.damaged } : {}) }
        : {}),
      ...(s?.trigger && typeof s.trigger.tool === 'string' ? { madeBy: s.trigger.tool } : {}),
      pieces: list.map((r) => rowView(r, prevOf.get(r))),
    };
  });
  const last = page.at(-1)!;
  const older =
    shown.length > limit
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM (SELECT snapshot_id, MAX(taken_at) AS t ${base} GROUP BY snapshot_id
                 HAVING (t < ? OR (t = ? AND snapshot_id < ?)))`,
            )
            .get(...args, last.t, last.t, last.snapshot_id) as { n: number }
        ).n
      : 0;
  return {
    count,
    snapshots,
    ...(older > 0 ? { more: older, next: encodeCursor(last.t, last.snapshot_id) } : {}),
  };
}

/** One piece of the page as it is now, rendered as text (1 read, plus the document's own). */
export async function pieceNow(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  f: Pick<PieceFilter, 'piece' | 'ref'>,
  signal?: AbortSignal,
): Promise<{ text: string; reads: number }> {
  const read = svc.reader(projectId, 'P1', signal ? { signal } : {});
  let reads = 1;
  const res = (await read('getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!res) return { text: '(the page is deleted)', reads };
  if (f.piece === 'sidebar') return { text: renderSidebar(sidebarPiece(res.properties ?? [])), reads };
  if (f.piece === 'resource') return { text: renderResource(resourcePiece(res)), reads };
  const doc = (Array.isArray(res.documents) ? (res.documents as Obj[]) : []).find(
    (d) => d.id === f.ref && d.deletedAt == null,
  );
  if (!doc) return { text: '(the document is not on the page now)', reads };
  const counted = async (op: string, params: Parameters<typeof read>[1]) => {
    reads++;
    return read(op, params);
  };
  const piece = (await documentPieceOf(counted, pageId, doc)) as DocumentPiece | undefined;
  return { text: renderDocument(piece ?? null), reads };
}

/** One piece of the page at a snapshot, rendered as text (free: the bridge's own store). */
export async function pieceThen(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  f: Pick<PieceFilter, 'piece' | 'ref'>,
  snapshotId: string,
): Promise<string> {
  const s = svc.index.snapshot(snapshotId);
  if (!s || s.projectId !== projectId)
    throw new RestoreError('SNAPSHOT_NOT_FOUND', `No snapshot ${snapshotId} of this project.`);
  const row = stateAt(svc, projectId, pageId, f.piece!, f.ref ?? '', {
    id: s.id,
    takenAt: s.takenAt,
    kind: s.kind,
  });
  if (!row)
    return f.piece === 'document' ? '(the document did not exist then)' : '(no state at that snapshot)';
  if (!row.sha256) return '(missing from that snapshot: it was partial)';
  const v = await svc.store.getJson<unknown>(row.sha256);
  if (v === null)
    throw new RestoreError(
      'SNAPSHOT_PIECE_DAMAGED',
      `The stored piece ${row.sha256.slice(0, 12)}… is missing or damaged.`,
    );
  if (f.piece === 'sidebar') return renderSidebar(v as SidebarPiece);
  if (f.piece === 'resource') return renderResource(v as ResourcePiece);
  return renderDocument(v as DocumentPiece);
}
