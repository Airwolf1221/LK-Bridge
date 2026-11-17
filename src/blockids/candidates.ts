/**
 * The block-id sweep's candidates (ADR 0056, point 1 of the statement): every `page` document of a page inside the AI
 * REPOSITORY whose blocks, as the latest snapshot holds them, include a block without an id or an id used twice. Read
 * from the snapshot overlay (the newest full snapshot plus the change snapshots since: src/appraisal/overlay.ts) and the
 * snapshot store, so finding them costs no LegendKeeper request. Maps, timelines and boards are never candidates.
 */
import { legacyProblems } from './detect.js';

/** A document of a page as the snapshot overlay holds it. */
export interface OverlayDocumentLike {
  readonly id: string;
  readonly type: string;
  readonly name: string | null;
  readonly sha256: string;
}

/** A page as the snapshot overlay holds it (the fields the sweep reads). */
export interface OverlayPageLike {
  readonly id: string;
  readonly parentId: string | null;
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: string;
  readonly documents: readonly OverlayDocumentLike[];
  readonly sourceTakenAt: number;
}

/** What the sweep needs from the snapshots: the overlay brought up to date, its pages, and a stored piece. */
export interface SnapshotOverlay {
  /** Brings the overlay up to date; null when there is no full snapshot yet. */
  ensure(projectId: string): Promise<{
    readonly snapshotId: string;
    readonly takenAt: number;
    readonly stamp: string;
  } | null>;
  pages(projectId: string): ReadonlyMap<string, OverlayPageLike>;
  /** A stored piece (a document's `{ settings, blocks }`), or null when it is missing or damaged. */
  piece(sha256: string): Promise<unknown>;
}

export interface Candidate {
  readonly resourceId: string;
  readonly documentId: string;
  /** The page's name as LegendKeeper shows it, and its place in the tree. */
  readonly page: string;
  readonly path: string;
  readonly document: string | null;
  readonly blocks: number;
  readonly missing: number;
  readonly duplicates: number;
  readonly unsupported: number;
  /** When the snapshot that holds this document was taken. */
  readonly seenAt: number;
}

export interface CandidateScan {
  readonly snapshot: { readonly id: string; readonly takenAt: number; readonly stamp: string } | null;
  /** In tree order (path, then document name). */
  readonly candidates: readonly Candidate[];
  /** Page documents read from the store. */
  readonly documents: number;
  /** Page documents whose piece could not be read (not guessed). */
  readonly unreadable: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, Math.max(1, items.length)) }, worker));
}

/** Scans one project's overlay for legacy page documents. */
export async function scanCandidates(overlay: SnapshotOverlay, projectId: string): Promise<CandidateScan> {
  const snap = await overlay.ensure(projectId);
  if (!snap) return { snapshot: null, candidates: [], documents: 0, unreadable: 0 };
  const pages = overlay.pages(projectId);
  const pathOf = (id: string): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let cur = pages.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.displayName);
      cur = cur.parentId ? pages.get(cur.parentId) : undefined;
    }
    return names.join(' / ');
  };
  const work: { page: OverlayPageLike; doc: OverlayDocumentLike }[] = [];
  for (const p of pages.values()) {
    if (p.kind === 'root') continue; // the AI REPOSITORY itself: only the pages inside it
    for (const d of p.documents) if (d.type === 'page' && d.sha256 !== '') work.push({ page: p, doc: d });
  }
  const found: (Candidate & { order: string })[] = [];
  let unreadable = 0;
  await pool(work, 8, async ({ page, doc }) => {
    const piece = await overlay.piece(doc.sha256).catch(() => null);
    if (!isObj(piece) || !Array.isArray(piece.blocks)) {
      unreadable++;
      return;
    }
    const p = legacyProblems(piece.blocks as unknown[]);
    if (p.missing === 0 && p.duplicates.length === 0) return;
    const path = pathOf(page.id);
    found.push({
      resourceId: page.id,
      documentId: doc.id,
      page: page.displayName,
      path,
      document: doc.name,
      blocks: p.blocks,
      missing: p.missing,
      duplicates: p.duplicates.length,
      unsupported: p.unsupported,
      seenAt: page.sourceTakenAt,
      order: `${path}\u0000${doc.name ?? ''}\u0000${doc.id}`,
    });
  });
  found.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return {
    snapshot: { id: snap.snapshotId, takenAt: snap.takenAt, stamp: snap.stamp },
    candidates: found.map(({ order: _order, ...c }) => c),
    documents: work.length,
    unreadable,
  };
}
