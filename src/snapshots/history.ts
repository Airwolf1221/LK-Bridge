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
import type { PieceRow } from './db.js';
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

/** The page's snapshots (of one piece, or of everything), newest first. */
export function historyOf(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  f: Pick<PieceFilter, 'piece' | 'ref'>,
  limit: number,
): { count: number; snapshots: HistoryEntry[]; more?: number } {
  const rows = svc.index.pageHistory(projectId, pageId, {
    ...(f.piece ? { piece: f.piece } : {}),
    ...(f.ref !== undefined ? { ref: f.ref } : {}),
    limit: 5000,
  });
  // Each piece compared with the same piece's previous row (oldest first); a page deletion resets them all.
  const asc = [...rows].reverse();
  const prevOf = new Map<PieceRow, PieceRow | undefined>();
  const lastBy = new Map<string, PieceRow>();
  for (const r of asc) {
    const k =
      r.piece === 'deleted' ? '*' : `${r.piece === 'document-deleted' ? 'document' : r.piece}:${r.ref}`;
    const prev = r.piece === 'deleted' ? undefined : (lastBy.get(k) ?? lastBy.get('*'));
    prevOf.set(r, prev);
    lastBy.set(k, r);
    if (r.piece === 'deleted') for (const key of [...lastBy.keys()]) lastBy.set(key, r);
  }
  const bySnap = new Map<string, PieceRow[]>();
  for (const r of rows) bySnap.set(r.snapshotId, [...(bySnap.get(r.snapshotId) ?? []), r]);
  const snapshots = [...bySnap.entries()].slice(0, limit).map(([id, list]): HistoryEntry => {
    const s = svc.index.snapshot(id);
    return {
      snapshot: id,
      takenAt: new Date(list[0]!.takenAt).toISOString(),
      kind: list[0]!.kind,
      ...(list[0]!.state === 'partial'
        ? { partial: true as const, ...(s?.damaged ? { damaged: s.damaged } : {}) }
        : {}),
      ...(s?.trigger && typeof s.trigger.tool === 'string' ? { madeBy: s.trigger.tool } : {}),
      pieces: list.map((r) => rowView(r, prevOf.get(r))),
    };
  });
  return { count: bySnap.size, snapshots, ...(bySnap.size > limit ? { more: bySnap.size - limit } : {}) };
}

/** One piece of the page as it is now, rendered as text (1 read, plus the document's own). */
export async function pieceNow(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  f: Pick<PieceFilter, 'piece' | 'ref'>,
): Promise<{ text: string; reads: number }> {
  const read = svc.reader(projectId, 'P1');
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
  const row = stateAt(svc, projectId, pageId, f.piece!, f.ref ?? '', { id: s.id, takenAt: s.takenAt });
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
