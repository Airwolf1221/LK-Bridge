/**
 * Taking a page's pieces, and the asset library (v2 E1a, ADR 0042). Every read goes through the reader the caller
 * hands in (the engine's governed `internalRead`, at the caller's priority), images through `image` (the asset host:
 * no API budget). Nothing here writes to LegendKeeper.
 *
 * Reads per page: one `getResource` (the resource, the sidebar and the document list), then per document: a page one
 * (`getDocumentBlocks`), a map two (`getDocument` for its image, `listFeatures`), a timeline three or more
 * (`getDocument`, `listLanes`, `listEvents` per 100 events), a board one (`getBoardContent`), a blank none. A change
 * snapshot reads only the pieces the write changed, and not even those when the job's own verify step already read them.
 */
import { stableJson } from '../jobs/sidebar-state.js';
import type { OpParams } from '../jobs/types.js';
import {
  blankDocumentPiece,
  boardDocumentPiece,
  imageUrls,
  libraryPiece,
  mapDocumentPiece,
  pageDocumentPiece,
  resourcePiece,
  sidebarPiece,
  timelineDocumentPiece,
  type LibraryAsset,
  type LibraryFolder,
} from './canonical.js';
import type {
  DocumentEntry,
  ImageEntry,
  LibraryEntry,
  MissingPiece,
  PageEntry,
  PieceRef,
} from './manifest.js';
import type { SnapshotStore } from './store.js';
import { canonicalBytes } from './canonical.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A governed read: the answer, or undefined when the entity is gone (404). Anything else throws. */
export type Reader = (op: string, params: OpParams) => Promise<unknown>;

export interface Counters {
  reads: number;
  downloads: number;
  newObjects: number;
  newBytes: number;
  logicalBytes: number;
  pieces: number;
  missing: number;
}

export const newCounters = (): Counters => ({
  reads: 0,
  downloads: 0,
  newObjects: 0,
  newBytes: 0,
  logicalBytes: 0,
  pieces: 0,
  missing: 0,
});

export interface ImageResult {
  readonly sha256: string;
  readonly size: number;
  readonly downloaded: boolean;
  readonly created: boolean;
  readonly stored: number;
}

export interface CaptureDeps {
  readonly store: SnapshotStore;
  /** The hosts asset files are served from (an image is any string field on one). */
  readonly assetHosts: readonly string[];
  /**
   * The bytes of an asset URL, stored (downloaded only when the store does not already hold them). `null`: not taken by
   * this snapshot (a change snapshot never downloads; the image is recorded by URL and left to the full snapshot).
   */
  image(url: string): Promise<ImageResult | null>;
  /** Reads the verify step (or another read of the same job) already made, by `op` and path: used before reading. */
  readonly cached?: (op: string, params: OpParams) => unknown;
  /** Whether a stored object is known to be damaged (an open verify finding): it is then written again. */
  readonly damaged?: (sha256: string) => boolean;
}

export interface PageNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly rank: string | null;
  readonly name: string;
  readonly kind: string;
}

/** Which pieces to take: everything (a full or daily snapshot, a new page), or what a write changed. */
export interface PieceSelection {
  readonly resource: boolean;
  readonly sidebar: boolean;
  /** `all`, or these document ids. */
  readonly documents: 'all' | readonly string[];
}

export const EVERYTHING: PieceSelection = { resource: true, sidebar: true, documents: 'all' };

/** Reads through the cache first (a change snapshot), counting only the reads actually made. */
function counted(read: Reader, c: Counters, cached?: CaptureDeps['cached']): Reader {
  return async (op, params) => {
    if (cached) {
      const hit = cached(op, params);
      if (hit !== undefined) return hit;
    }
    c.reads++;
    return read(op, params);
  };
}

async function putPiece(
  store: SnapshotStore,
  piece: unknown,
  c: Counters,
  damaged?: (sha256: string) => boolean,
): Promise<PieceRef> {
  const bytes = canonicalBytes(piece);
  const r = await store.lock.shared(() =>
    store.putBytes(bytes, { compress: 'text', ...(damaged ? { repair: damaged } : {}) }),
  );
  c.pieces++;
  c.logicalBytes += r.size;
  if (r.created) {
    c.newObjects++;
    c.newBytes += r.stored;
  }
  return { sha256: r.sha256, size: r.size };
}

/** Every item of a paged list (`{ data, hasMore, nextCursor }`), or of a plain `{ data }` answer. */
async function listAll(
  read: Reader,
  op: string,
  path: Record<string, string>,
  query: Obj = {},
): Promise<Obj[] | undefined> {
  const out: Obj[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const body = (await read(op, {
      ...(Object.keys(path).length > 0 ? { path } : {}),
      query: { ...query, ...(cursor ? { cursor } : {}) },
    })) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
    if (body === undefined) return page === 0 ? undefined : out;
    if (Array.isArray(body.data)) out.push(...(body.data as unknown[]).filter(isObj));
    if (body.hasMore !== true || typeof body.nextCursor !== 'string') break;
    cursor = body.nextCursor;
  }
  return out;
}

/** One document as a piece (its reads by type), or undefined when it is gone. */
export async function documentPieceOf(read: Reader, pageId: string, doc: Obj): Promise<unknown> {
  const documentId = String(doc.id);
  const path = { resourceId: pageId, documentId };
  const type = str(doc.type) ?? 'blank';
  switch (type) {
    case 'page': {
      const b = await read('getDocumentBlocks', { path });
      return b === undefined ? undefined : pageDocumentPiece(doc, b);
    }
    case 'map': {
      const d = await read('getDocument', { path });
      if (d === undefined || (isObj(d) && typeof d.deletedAt === 'string')) return undefined;
      const f = await read('listFeatures', { path });
      if (f === undefined) return undefined;
      const features = isObj(f) && Array.isArray(f.data) ? (f.data as unknown[]) : [];
      return mapDocumentPiece({ ...doc, ...(isObj(d) ? d : {}) }, features);
    }
    case 'time': {
      const d = await read('getDocument', { path });
      if (d === undefined || (isObj(d) && typeof d.deletedAt === 'string')) return undefined;
      const lanesBody = await read('listLanes', { path });
      if (lanesBody === undefined) return undefined;
      const lanes = isObj(lanesBody) && Array.isArray(lanesBody.data) ? (lanesBody.data as unknown[]) : [];
      const events = (await listAll(read, 'listEvents', path, { limit: 100 })) ?? [];
      return timelineDocumentPiece({ ...doc, ...(isObj(d) ? d : {}) }, lanes, events);
    }
    case 'board': {
      const c = await read('getBoardContent', { path });
      return c === undefined ? undefined : boardDocumentPiece(doc, c);
    }
    default:
      return blankDocumentPiece(doc);
  }
}

/** The page's documents from `getResource` (deleted ones left out). */
function documentsOf(res: Obj): Obj[] {
  return (Array.isArray(res.documents) ? (res.documents as unknown[]) : [])
    .filter(isObj)
    .filter((d) => typeof d.id === 'string' && d.deletedAt == null);
}

/**
 * Takes a page's pieces (see PieceSelection) and stores them. A piece that cannot be read or stored is listed as
 * missing (with why) instead of failing the page; a page that is gone (404) is returned with `deleted: true`.
 * A budget wait or the bridge stopping propagates (the run continues later).
 */
export async function capturePage(
  deps: CaptureDeps,
  readRaw: Reader,
  node: PageNode,
  select: PieceSelection,
  c: Counters,
): Promise<PageEntry> {
  const read = counted(readRaw, c, deps.cached);
  const missing: MissingPiece[] = [];
  const res = (await read('getResource', { path: { resourceId: node.id } })) as Obj | undefined;
  if (res === undefined || !isObj(res)) {
    return { ...treeOf(node), deleted: true };
  }
  const tree = {
    id: node.id,
    parentId: str(res.parentId) ?? null,
    rank: str(res.rank) ?? node.rank,
    name: str(res.name) ?? node.name,
    kind: node.kind,
  };
  const urls = new Set<string>();
  const entry: {
    resource?: PieceRef;
    sidebar?: PieceRef;
    documents?: DocumentEntry[];
    deletedDocuments?: string[];
  } = {};
  const keep = async (piece: unknown, what: string, ref?: string): Promise<PieceRef | null> => {
    try {
      for (const u of imageUrls(piece, deps.assetHosts)) urls.add(u);
      return await putPiece(deps.store, piece, c, deps.damaged);
    } catch (e) {
      missing.push({
        piece: what,
        ...(ref ? { ref } : {}),
        reason: `could not be stored: ${e instanceof Error ? e.message : String(e)}`,
      });
      return null;
    }
  };
  if (select.resource) {
    const r = await keep(resourcePiece(res), 'resource');
    if (r) entry.resource = r;
  }
  if (select.sidebar) {
    // getResource carries the sidebar; a cached listProperties (the verify step's) is the same piece.
    const r = await keep(sidebarPiece(res.properties ?? []), 'sidebar');
    if (r) entry.sidebar = r;
  }
  const docs = documentsOf(res);
  const wanted =
    select.documents === 'all'
      ? docs
      : docs.filter((d) => (select.documents as readonly string[]).includes(String(d.id)));
  if (select.documents !== 'all') {
    const live = new Set(docs.map((d) => String(d.id)));
    const gone = select.documents.filter((id) => !live.has(id));
    if (gone.length > 0) entry.deletedDocuments = gone;
  }
  const documents: DocumentEntry[] = [];
  for (const d of wanted) {
    const id = String(d.id);
    let piece: unknown;
    try {
      piece = await documentPieceOf(read, node.id, d);
    } catch (e) {
      if (isStop(e)) throw e;
      missing.push({
        piece: 'document',
        ref: id,
        reason: `could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (piece === undefined) {
      (entry.deletedDocuments ??= []).push(id);
      continue;
    }
    const r = await keep(piece, 'document', id);
    if (r) documents.push({ id, type: str(d.type) ?? 'blank', name: str(d.name), ...r });
  }
  if (documents.length > 0 || select.documents === 'all') entry.documents = documents;
  const images: ImageEntry[] = [];
  for (const url of [...urls].sort()) {
    try {
      const got = await deps.image(url);
      if (got === null) {
        images.push({ url, sha256: null, size: 0, assetId: null, deferred: true });
        continue;
      }
      if (got.downloaded) c.downloads++;
      if (got.created) {
        c.newObjects++;
        c.newBytes += got.stored;
      }
      images.push({ url, sha256: got.sha256, size: got.size, assetId: null });
    } catch (e) {
      if (isStop(e)) throw e;
      images.push({ url, sha256: null, size: 0, assetId: null });
      missing.push({ piece: 'image', ref: url, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  c.missing += missing.length;
  return {
    ...tree,
    ...entry,
    ...(images.length > 0 ? { images } : {}),
    updatedAt: str(res.updatedAt),
    ...(missing.length > 0 ? { missing } : {}),
  };
}

function treeOf(node: PageNode): PageEntry {
  return { id: node.id, parentId: node.parentId, rank: node.rank, name: node.name, kind: node.kind };
}

/** True for the errors that must stop a run rather than be recorded as a missing piece (budget waits, stopping). */
export function isStop(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  const code = (e as { code?: unknown } | null)?.code;
  return name === 'BudgetExhaustedError' || name === 'StopError' || code === 'BUDGET_EXHAUSTED';
}

/**
 * The whole asset library: every folder (walked level by level with `listAssets`, as LegendKeeper lists one folder at a
 * time) and every asset, with each image's bytes stored. About one read per folder, plus one per 100 assets.
 */
export async function captureLibrary(deps: CaptureDeps, readRaw: Reader, c: Counters): Promise<LibraryEntry> {
  const read = counted(readRaw, c);
  const folders: LibraryFolder[] = [];
  const assets: Omit<LibraryAsset, 'sha256'>[] = [];
  const queue: (string | null)[] = [null];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const folderId = queue.shift()!;
    const items =
      (await listAll(read, 'listAssets', {}, { limit: 100, ...(folderId ? { folderId } : {}) })) ?? [];
    for (const a of items) {
      const id = str(a.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (a.type === 'FOLDER') {
        folders.push({ id, name: str(a.name), folderId: str(a.folderId) ?? folderId });
        queue.push(id);
      } else {
        assets.push({
          id,
          name: str(a.name),
          type: str(a.type),
          folderId: str(a.folderId) ?? folderId,
          isHidden: a.isHidden === true,
          description: str(a.description),
          url: str(a.url),
          width: typeof a.width === 'number' ? a.width : null,
          height: typeof a.height === 'number' ? a.height : null,
        });
      }
    }
  }
  const missing: MissingPiece[] = [];
  const images: LibraryEntry['images'][number][] = [];
  const withHashes: LibraryAsset[] = [];
  for (const a of assets) {
    let sha: string | null = null;
    if (a.url) {
      try {
        const got = await deps.image(a.url);
        if (got === null) {
          // A change snapshot names a new asset without its bytes: the next full snapshot takes them.
          images.push({ assetId: a.id, url: a.url, sha256: null, size: 0, deferred: true });
          withHashes.push({ ...a, sha256: null });
          continue;
        }
        if (got.downloaded) c.downloads++;
        if (got.created) {
          c.newObjects++;
          c.newBytes += got.stored;
        }
        sha = got.sha256;
        images.push({ assetId: a.id, url: a.url, sha256: sha, size: got.size });
      } catch (e) {
        if (isStop(e)) throw e;
        images.push({ assetId: a.id, url: a.url, sha256: null, size: 0 });
        missing.push({ piece: 'asset', ref: a.id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    withHashes.push({ ...a, sha256: sha });
  }
  let piece: PieceRef | null = null;
  try {
    piece = await putPiece(deps.store, libraryPiece(folders, withHashes), c, deps.damaged);
  } catch (e) {
    missing.push({
      piece: 'library',
      reason: `could not be stored: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  c.missing += missing.length;
  return { piece, folders: folders.length, images, ...(missing.length > 0 ? { missing } : {}) };
}

/** A cache key for a read (op and path; queries ignored except a list's first page). */
export function readKey(op: string, params: OpParams): string {
  return `${op}:${stableJson(params.path ?? {})}`;
}
