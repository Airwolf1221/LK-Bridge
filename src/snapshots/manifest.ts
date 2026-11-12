/**
 * A snapshot's manifest (v2 E1a, ADR 0042): what a snapshot is. Small (hashes and the tree, never content), written to
 * the store as `manifests/<project>/<id>.json.gz` once the snapshot is complete, and part of E1b's contract.
 *
 * - `kind`: `full` (everything under the AI REPOSITORY, with the asset library), `change` (the pieces one bridge job
 *   changed) or `daily` (the pages whose `updatedAt` moved). A `full` manifest lists every page with every piece; the
 *   other two list only the pages and pieces they took (a missing `resource`, `sidebar` or document means "not taken
 *   by this snapshot", never "empty").
 * - `pages[].missing`: a piece that could not be read or stored. A snapshot with any is `complete: false` (partial).
 * - Hashes name objects in the store: `sha256` of the canonical JSON of a piece, or of an image's bytes.
 */
export const MANIFEST_FORMAT = 'lk-bridge-snapshot';
export const MANIFEST_VERSION = 1;

export type SnapshotKind = 'full' | 'change' | 'daily';

/** One stored piece: its hash and uncompressed size. */
export interface PieceRef {
  readonly sha256: string;
  readonly size: number;
}

export interface DocumentEntry extends PieceRef {
  readonly id: string;
  readonly type: string;
  readonly name: string | null;
}

export interface ImageEntry {
  readonly url: string;
  /** The image's bytes (null: they could not be fetched; the page's entry lists it as missing). */
  readonly sha256: string | null;
  readonly size: number;
  readonly assetId: string | null;
}

export interface MissingPiece {
  readonly piece: string;
  readonly ref?: string;
  readonly reason: string;
}

export interface PageEntry {
  // The tree: id, parent, rank, name, kind.
  readonly id: string;
  readonly parentId: string | null;
  readonly rank: string | null;
  readonly name: string;
  readonly kind: string;
  /** The page was deleted (a change snapshot after a delete); it has no pieces. */
  readonly deleted?: true;
  readonly resource?: PieceRef;
  readonly sidebar?: PieceRef;
  readonly documents?: readonly DocumentEntry[];
  /** Documents deleted by the change this snapshot followed. */
  readonly deletedDocuments?: readonly string[];
  readonly images?: readonly ImageEntry[];
  /** `getResource`'s `updatedAt` when it was read (the daily pass compares it). */
  readonly updatedAt?: string | null;
  readonly missing?: readonly MissingPiece[];
}

export interface LibraryEntry {
  readonly piece: PieceRef | null;
  readonly folders: number;
  readonly images: readonly {
    readonly assetId: string;
    readonly url: string;
    readonly sha256: string | null;
    readonly size: number;
  }[];
  readonly missing?: readonly MissingPiece[];
}

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly version: typeof MANIFEST_VERSION;
  readonly id: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly kind: SnapshotKind;
  readonly takenAt: string;
  readonly startedAt: string;
  /** The AI REPOSITORY root the pages were taken under. */
  readonly rootId: string | null;
  /** False when any piece is missing (a partial snapshot). */
  readonly complete: boolean;
  /** What made it: a change snapshot's job, tool and principal; a full or daily run's id and trigger. */
  readonly trigger: Readonly<Record<string, unknown>>;
  readonly pages: readonly PageEntry[];
  /** The asset library (folders and every asset with its bytes): full snapshots, and change snapshots after asset writes. */
  readonly library: LibraryEntry | null;
  readonly counts: {
    readonly pages: number;
    readonly pieces: number;
    readonly reads: number;
    readonly downloads: number;
    readonly newObjects: number;
    readonly newBytes: number;
    readonly logicalBytes: number;
    readonly missing: number;
  };
}

/** `20261112T031500Z-full-a1b2c3`: sorts by time; the kind is in the name. */
export function newSnapshotId(kind: SnapshotKind, at: number, random: string): string {
  const iso = new Date(at).toISOString(); // 2026-11-12T03:15:00.000Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return `${stamp}-${kind}-${random}`;
}

/** Every piece a manifest refers to (for the index and the garbage collector), with the page it belongs to. */
export function manifestPieces(m: Manifest): {
  pageId: string;
  piece: string;
  ref: string;
  docType: string | null;
  name: string | null;
  sha256: string | null;
  size: number;
}[] {
  const out: ReturnType<typeof manifestPieces> = [];
  for (const p of m.pages) {
    if (p.deleted) {
      out.push({
        pageId: p.id,
        piece: 'deleted',
        ref: '',
        docType: null,
        name: p.name,
        sha256: null,
        size: 0,
      });
      continue;
    }
    if (p.resource)
      out.push({ pageId: p.id, piece: 'resource', ref: '', docType: null, name: p.name, ...p.resource });
    if (p.sidebar)
      out.push({ pageId: p.id, piece: 'sidebar', ref: '', docType: null, name: p.name, ...p.sidebar });
    for (const d of p.documents ?? [])
      out.push({
        pageId: p.id,
        piece: 'document',
        ref: d.id,
        docType: d.type,
        name: d.name,
        sha256: d.sha256,
        size: d.size,
      });
    for (const d of p.deletedDocuments ?? [])
      out.push({
        pageId: p.id,
        piece: 'document-deleted',
        ref: d,
        docType: null,
        name: null,
        sha256: null,
        size: 0,
      });
    for (const i of p.images ?? [])
      out.push({
        pageId: p.id,
        piece: 'image',
        ref: i.url,
        docType: null,
        name: null,
        sha256: i.sha256,
        size: i.size,
      });
    // A piece that could not be taken is indexed with no hash, so the page's history shows the gap.
    for (const x of p.missing ?? [])
      if (x.piece === 'resource' || x.piece === 'sidebar' || x.piece === 'document')
        out.push({
          pageId: p.id,
          piece: x.piece,
          ref: x.ref ?? '',
          docType: null,
          name: p.name,
          sha256: null,
          size: 0,
        });
  }
  if (m.library) {
    if (m.library.piece)
      out.push({ pageId: '*', piece: 'library', ref: '', docType: null, name: null, ...m.library.piece });
    for (const a of m.library.images)
      out.push({
        pageId: '*',
        piece: 'asset',
        ref: a.assetId,
        docType: null,
        name: a.url,
        sha256: a.sha256,
        size: a.size,
      });
  }
  return out;
}
