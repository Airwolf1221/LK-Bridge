/**
 * The pieces of a snapshot and their canonical serialisation (v2 E1a, ADR 0042). Pure.
 *
 * Every piece is stored once, named by the SHA-256 of its canonical serialisation: JSON with every object's keys in
 * code-unit order (`stableJson`, the same function the in-lock checks hash with), no whitespace, read-only and volatile
 * fields left out, and the lists whose order LegendKeeper does not keep stable put in one order:
 *
 * - sidebar properties by rank (then their read order), key-value rows and collection items by rank then id (C2a.1's
 *   order: LegendKeeper's endpoints return the same rows in different orders);
 * - map features by rank then id, timeline lanes by rank then id, events by lane, rank, then id;
 * - a board's pages, shapes, bindings and assets by id (tldraw orders them by their own `index`, which is kept);
 * - blocks in their document order (their order IS the page).
 *
 * Left out: `version` (anywhere in blocks, and on documents, properties and boards), `updatedAt`, `createdAt`,
 * `deletedAt`, `permissions`, a row's derived `text` (its runs are kept), a resource's documents and properties (they
 * are pieces of their own) and its parent and rank (they are the manifest's tree). Ids of the page and its documents are
 * the manifest's, not the pieces', so identical pieces of different pages (template copies' sidebars, which LegendKeeper
 * gives the same ids: ADR 0037) are stored once. Mention names are kept: they are what the page showed.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../jobs/sidebar-state.js';
import { validateAgainstSpec } from '../markdown/index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The piece kinds a page has (the asset library and its images are the project's, not a page's). */
export type PieceKind = 'resource' | 'sidebar' | 'document';
export type DocumentType = 'page' | 'map' | 'time' | 'board' | 'blank';

export const DOCUMENT_TYPES: readonly DocumentType[] = ['page', 'map', 'time', 'board', 'blank'];

/** The bytes a piece is stored as (and hashed from). */
export function canonicalBytes(piece: unknown): Buffer {
  return Buffer.from(stableJson(piece), 'utf8');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The hash a piece is stored under, and its canonical size. */
export function pieceHash(piece: unknown): { sha256: string; size: number; bytes: Buffer } {
  const bytes = canonicalBytes(piece);
  return { sha256: sha256(bytes), size: bytes.length, bytes };
}

const byRankThenId = (a: Obj, b: Obj): number => {
  const ra = str(a.rank) ?? '';
  const rb = str(b.rank) ?? '';
  if (ra !== rb) return ra < rb ? -1 : 1;
  const ia = str(a.id) ?? '';
  const ib = str(b.id) ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};
const byId = (a: Obj, b: Obj): number => {
  const ia = str(a.id) ?? '';
  const ib = str(b.id) ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};

/** A copy without the given keys at the top level. */
function omit(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k) && v !== undefined) out[k] = v;
  return out;
}

/** A copy of a block tree without its read-only `version` fields (at any depth). */
export function stripVersions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVersions);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'version' && typeof x === 'string') continue;
    if (x === undefined) continue;
    out[k] = stripVersions(x);
  }
  return out;
}

// ============================================================================================ the resource

/** The resource's own settings (its name, tags, aliases, icon and the rest). */
export const RESOURCE_FIELDS = [
  'name',
  'tags',
  'aliases',
  'iconGlyph',
  'iconColor',
  'iconShape',
  'iconSize',
  'isHidden',
  'isLocked',
  'isFullWidth',
  'showPropertyBar',
  'imageUrl',
  'banner',
] as const;

export interface ResourcePiece {
  readonly [key: string]: unknown;
}

/** `getResource`'s answer as a piece. */
export function resourcePiece(res: unknown): ResourcePiece {
  const r = isObj(res) ? res : {};
  const out: Obj = {};
  for (const k of RESOURCE_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

// ============================================================================================ the sidebar

export interface SidebarPiece {
  readonly properties: readonly Obj[];
}

/** A row's runs as LegendKeeper reads them; a row read with `text` only becomes one text run. */
function rowContent(row: Obj): unknown[] {
  if (Array.isArray(row.content)) return stripVersions(row.content) as unknown[];
  if (typeof row.text === 'string' && row.text !== '') return [{ text: row.text }];
  return [];
}

function property(p: Obj): Obj {
  const base = omit(p, ['version', 'updatedAt', 'createdAt']);
  if (p.kind === 'keyValue') {
    const rows = (Array.isArray(p.rows) ? (p.rows as unknown[]) : [])
      .filter(isObj)
      .map((r) => ({ ...omit(r, ['text', 'version', 'content']), content: rowContent(r) }))
      .sort(byRankThenId);
    return { ...base, rows };
  }
  if (p.kind === 'resourceCollection' || p.kind === 'resourceLink') {
    const items = (Array.isArray(p.items) ? (p.items as unknown[]) : [])
      .filter(isObj)
      .map((i) => omit(i, ['version']))
      .sort(byRankThenId);
    return { ...base, items };
  }
  return stripVersions(base) as Obj;
}

/** A sidebar (`getResource`'s `properties`, or `listProperties`' answer) as a piece. */
export function sidebarPiece(sidebar: unknown): SidebarPiece {
  const list = Array.isArray(sidebar)
    ? sidebar
    : isObj(sidebar) && Array.isArray(sidebar.data)
      ? sidebar.data
      : isObj(sidebar) && Array.isArray(sidebar.properties)
        ? sidebar.properties
        : [];
  const props = (list as unknown[]).filter(isObj);
  // Properties by rank where they carry one (a stable sort keeps the read order otherwise).
  const ordered = props
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = str(a.p.rank);
      const rb = str(b.p.rank);
      if (ra !== null && rb !== null && ra !== rb) return ra < rb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => property(x.p));
  return { properties: ordered };
}

// ============================================================================================ documents

/** A document's own settings, as `getDocument` (or a resource's document list) gives them. */
export const DOCUMENT_FIELDS = [
  'name',
  'type',
  'rank',
  'isHidden',
  'isFullWidth',
  'calendarId',
  'mapImage',
  'sources',
] as const;

export function documentSettings(doc: unknown): Obj {
  const d = isObj(doc) ? doc : {};
  const out: Obj = {};
  for (const k of DOCUMENT_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

export interface DocumentPiece {
  readonly settings: Obj;
  /** A page's blocks (with `unsupported` placeholders by id, and every block a Markdown keep region holds). */
  readonly blocks?: readonly unknown[];
  /** A map's features. */
  readonly features?: readonly Obj[];
  /** A timeline's lanes and events. */
  readonly lanes?: readonly Obj[];
  readonly events?: readonly Obj[];
  /** A board's content. */
  readonly content?: Obj;
}

export function pageDocumentPiece(settings: unknown, blocksBody: unknown): DocumentPiece {
  const blocks = isObj(blocksBody) && Array.isArray(blocksBody.blocks) ? blocksBody.blocks : [];
  return { settings: documentSettings(settings), blocks: stripVersions(blocks) as unknown[] };
}

export function mapDocumentPiece(settings: unknown, features: readonly unknown[]): DocumentPiece {
  return {
    settings: documentSettings(settings),
    features: features
      .filter(isObj)
      .map((f) => omit(f, ['updatedAt', 'createdAt', 'version']))
      .sort(byRankThenId),
  };
}

export function timelineDocumentPiece(
  settings: unknown,
  lanes: readonly unknown[],
  events: readonly unknown[],
): DocumentPiece {
  return {
    settings: documentSettings(settings),
    lanes: lanes
      .filter(isObj)
      .map((l) => omit(l, ['updatedAt', 'createdAt', 'version']))
      .sort(byRankThenId),
    events: events
      .filter(isObj)
      .map((e) => omit(e, ['updatedAt', 'createdAt', 'version']))
      .sort((a, b) => {
        const la = str(a.laneId) ?? '';
        const lb = str(b.laneId) ?? '';
        if (la !== lb) return la < lb ? -1 : 1;
        return byRankThenId(a, b);
      }),
  };
}

export function boardDocumentPiece(settings: unknown, content: unknown): DocumentPiece {
  const c = isObj(content) ? content : {};
  const list = (k: string) =>
    (Array.isArray(c[k]) ? (c[k] as unknown[]) : [])
      .filter(isObj)
      .map((x) => ({ ...x }))
      .sort(byId);
  return {
    settings: documentSettings(settings),
    content: {
      ...(c.schema !== undefined ? { schema: c.schema } : {}),
      pages: list('pages'),
      shapes: list('shapes'),
      bindings: list('bindings'),
      assets: list('assets'),
    },
  };
}

export function blankDocumentPiece(settings: unknown): DocumentPiece {
  return { settings: documentSettings(settings) };
}

/** The type of a document piece. */
export function documentType(piece: DocumentPiece): string {
  return str(piece.settings.type) ?? 'blank';
}

// ============================================================================================ the asset library

export interface LibraryFolder {
  readonly id: string;
  readonly name: string | null;
  readonly folderId: string | null;
}

export interface LibraryAsset {
  readonly id: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly folderId: string | null;
  readonly isHidden: boolean;
  readonly description: string | null;
  readonly url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** The SHA-256 of the file's bytes (stored as an object of its own), or null when it could not be fetched. */
  readonly sha256: string | null;
}

export interface LibraryPiece {
  readonly folders: readonly LibraryFolder[];
  readonly assets: readonly LibraryAsset[];
}

export function libraryPiece(
  folders: readonly LibraryFolder[],
  assets: readonly LibraryAsset[],
): LibraryPiece {
  const sortId = <T extends { id: string }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { folders: sortId(folders), assets: sortId(assets) };
}

// ============================================================================================ images

/** Every asset URL a piece refers to (any string field on an asset host: image blocks, map images, pins, banners…). */
export function imageUrls(piece: unknown, hosts: readonly string[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 200) return;
    if (typeof v === 'string') {
      if (v.startsWith('https://')) {
        try {
          const u = new URL(v);
          if (hosts.includes(u.hostname.toLowerCase())) out.add(v);
        } catch {
          /* not a URL */
        }
      }
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (isObj(v)) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(piece, 0);
  return [...out].sort();
}

/** Replaces every occurrence of the given URLs in a piece (any string field equal to one), returning a copy. */
export function replaceUrls<T>(piece: T, map: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) {
      const out: Obj = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(piece) as T;
}

// ============================================================================================ blocks LegendKeeper cannot take back

/**
 * Whether a run is one LegendKeeper's write schema has no form for (B1 models an inline icon as an `icon` run): judged by
 * the converter's own schema check against the spec's `Run`, so it is the same rule the engine applies before sending.
 */
export function isUnwritableRun(run: unknown): boolean {
  if (!isObj(run)) return false;
  return validateAgainstSpec(stripVersions(run), 'Run').length > 0;
}

export interface BlockFinding {
  readonly blockId: string | null;
  readonly kind: string;
  readonly what: 'unsupported' | 'inline-icon';
}

/** The `unsupported` blocks and blocks holding inline icons (any depth), in document order. */
export function unwritableBlocks(blocks: readonly unknown[]): BlockFinding[] {
  const out: BlockFinding[] = [];
  const walk = (list: readonly unknown[]): void => {
    for (const b of list) {
      if (!isObj(b)) continue;
      const id = str(b.id);
      const kind = str(b.kind) ?? '?';
      if (kind === 'unsupported') out.push({ blockId: id, kind, what: 'unsupported' });
      else if (Array.isArray(b.content) && (b.content as unknown[]).some(isUnwritableRun))
        out.push({ blockId: id, kind, what: 'inline-icon' });
      if (Array.isArray(b.children)) walk(b.children as unknown[]);
    }
  };
  walk(blocks);
  return out;
}

/** Every block id in a tree (any depth). */
export function blockIds(blocks: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly unknown[]): void => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (typeof b.id === 'string') ids.add(b.id);
      if (Array.isArray(b.children)) walk(b.children as unknown[]);
    }
  };
  walk(blocks);
  return ids;
}
