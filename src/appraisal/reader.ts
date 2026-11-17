/**
 * The appraisal's page reader (v3 F3c, ADR 0054): a page as the overlay holds it, its pieces read from the snapshot
 * store by their hashes (free: no LegendKeeper request), or read live when the caller asked for `live: true` (then the
 * page's settings and sidebar, and its main page document: 2 reads).
 *
 * Unlike the audits' model, it keeps the body's blocks: the appraisal checks the body's structure (Purpose first,
 * headings, pasted Markdown, blank paragraphs, dashes).
 */
import { extractSidebar, type SidebarFacts } from '../audits/model.js';
import { sidebarPiece } from '../snapshots/canonical.js';
import { classifyName } from '../tree/classify.js';
import type { OverlayDocument, OverlayPage } from './overlay.js';
import { labelsOf, type LabelContext, type Labels, type LabelPath } from './scope.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A live read for `live: true` (the tool's own governed read, at interactive priority). */
export type LiveRead = (op: string, params: Record<string, unknown>) => Promise<unknown>;

export interface Collection {
  readonly id: string | null;
  readonly title: string;
  readonly items: readonly { readonly resourceId: string; readonly documentId: string | null }[];
  /** The collection has a filter (it may show pages its items do not list). */
  readonly filtered: boolean;
}

export interface LoadedPage {
  readonly page: OverlayPage;
  readonly path: LabelPath;
  readonly pathText: string;
  readonly labels: Labels;
  readonly resource: Obj | null;
  /** The sidebar's facts and properties (the audits' extraction), or null when it could not be read. */
  readonly sidebar: SidebarFacts | null;
  readonly collections: readonly Collection[];
  /** The main page document (the first page document named Main, else the first page document) and its blocks. */
  readonly body: { readonly documentId: string; readonly name: string | null; readonly blocks: Obj[] } | null;
  readonly unreadable: readonly string[];
  readonly source: 'snapshot' | 'live';
}

export interface ReaderDeps {
  readonly pages: ReadonlyMap<string, OverlayPage>;
  readonly piece: (sha256: string) => Promise<unknown>;
  readonly propertiesName: string;
  readonly labels: LabelContext;
}

/** The main page document of a page: `Main` when it is a page, else the first page document. */
export function mainDocument(docs: readonly OverlayDocument[]): OverlayDocument | null {
  return (
    docs.find((d) => d.type === 'page' && (d.name ?? '').trim().toLowerCase() === 'main') ??
    docs.find((d) => d.type === 'page') ??
    null
  );
}

function collectionsOf(sidebar: unknown): Collection[] {
  const list = isObj(sidebar) && Array.isArray(sidebar.properties) ? (sidebar.properties as unknown[]) : [];
  const out: Collection[] = [];
  for (const p of list) {
    if (!isObj(p) || (p.kind !== 'resourceCollection' && p.kind !== 'resourceLink')) continue;
    const items = (Array.isArray(p.items) ? (p.items as unknown[]) : [])
      .filter(isObj)
      .filter((i) => typeof i.resourceId === 'string')
      .map((i) => ({ resourceId: String(i.resourceId), documentId: str(i.documentId) }));
    out.push({
      id: str(p.id),
      title: str(p.title) ?? '',
      items,
      filtered: p.filter !== undefined && p.filter !== null,
    });
  }
  return out;
}

export class PageReader {
  private readonly loaded = new Map<string, Promise<LoadedPage | null>>();
  private readonly kids = new Map<string, OverlayPage[]>();
  /** Pages read live in this request (`live: true`): they stand in for the overlay's copy. */
  private readonly live = new Map<string, OverlayPage>();

  constructor(private readonly d: ReaderDeps) {
    for (const p of d.pages.values()) {
      if (p.parentId === null) continue;
      const l = this.kids.get(p.parentId) ?? [];
      l.push(p);
      this.kids.set(p.parentId, l);
    }
    for (const l of this.kids.values())
      l.sort((a, b) => {
        if (a.rank !== b.rank) {
          if (a.rank === null) return 1;
          if (b.rank === null) return -1;
          return a.rank < b.rank ? -1 : 1;
        }
        return a.id < b.id ? -1 : 1;
      });
  }

  page(id: string): OverlayPage | null {
    return this.live.get(id) ?? this.d.pages.get(id) ?? null;
  }

  /** Every page of the overlay, in id order. */
  all(): OverlayPage[] {
    return [...this.d.pages.values()];
  }

  children(id: string): readonly OverlayPage[] {
    return this.kids.get(id) ?? [];
  }

  /** Every page beneath one (not itself), depth first in sibling order. */
  descendants(id: string): OverlayPage[] {
    const out: OverlayPage[] = [];
    const walk = (pid: string, depth: number) => {
      if (depth > 64) return;
      for (const c of this.children(pid)) {
        out.push(c);
        walk(c.id, depth + 1);
      }
    };
    walk(id, 0);
    return out;
  }

  path(id: string): LabelPath {
    const ids: string[] = [];
    const names: string[] = [];
    const kinds: string[] = [];
    let cur: OverlayPage | undefined = this.live.get(id) ?? this.d.pages.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      ids.unshift(cur.id);
      names.unshift(cur.displayName);
      kinds.unshift(cur.kind);
      cur = cur.parentId ? (this.live.get(cur.parentId) ?? this.d.pages.get(cur.parentId)) : undefined;
    }
    return { ids, names, kinds };
  }

  pathText(id: string): string {
    return this.path(id).names.join(' / ');
  }

  labels(id: string): Labels {
    return labelsOf(this.path(id), this.d.labels);
  }

  /** A page's pieces from the store (cached for the reader's life). */
  load(id: string): Promise<LoadedPage | null> {
    let p = this.loaded.get(id);
    if (!p) {
      p = this.read(id);
      this.loaded.set(id, p);
    }
    return p;
  }

  private async read(id: string): Promise<LoadedPage | null> {
    const page = this.d.pages.get(id);
    if (!page) return null;
    const unreadable = [...page.unreadable];
    const resource = page.resourceSha ? await this.d.piece(page.resourceSha) : null;
    if (page.resourceSha && resource === null && !unreadable.includes('resource'))
      unreadable.push('resource');
    const side = page.sidebarSha ? await this.d.piece(page.sidebarSha) : null;
    if (page.sidebarSha && side === null && !unreadable.includes('sidebar')) unreadable.push('sidebar');
    const main = mainDocument(page.documents);
    let body: LoadedPage['body'] = null;
    if (main) {
      const piece = await this.d.piece(main.sha256);
      if (piece === null) {
        if (!unreadable.includes(`document ${main.id}`)) unreadable.push(`document ${main.id}`);
      } else {
        const blocks = isObj(piece) && Array.isArray(piece.blocks) ? (piece.blocks as Obj[]) : [];
        body = { documentId: main.id, name: main.name, blocks };
      }
    }
    const path = this.path(id);
    return {
      page,
      path,
      pathText: path.names.join(' / '),
      labels: labelsOf(path, this.d.labels),
      resource: isObj(resource) ? resource : null,
      sidebar: side === null ? null : extractSidebar(side, this.d.propertiesName),
      collections: side === null ? [] : collectionsOf(side),
      body,
      unreadable,
      source: 'snapshot',
    };
  }

  /**
   * The page read live (`live: true`): its settings and sidebar (`getResource`), then its main page document
   * (`getDocumentBlocks`), unless `body: false` (the snapshot's copy of the body is kept: A3 needs only the name and
   * aliases). Replaces the snapshot's copy in this reader. Returns the reads made.
   */
  async readLive(
    id: string,
    read: LiveRead,
    now: number,
    opts: { readonly body?: boolean } = {},
  ): Promise<{ page: LoadedPage | null; reads: number }> {
    const kept = opts.body === false ? await this.load(id) : null;
    let reads = 1;
    const res = await read('getResource', { path: { resourceId: id } });
    if (!isObj(res)) {
      this.loaded.set(id, Promise.resolve(null));
      return { page: null, reads };
    }
    const docs: OverlayDocument[] = (Array.isArray(res.documents) ? (res.documents as unknown[]) : [])
      .filter(isObj)
      .filter((d) => typeof d.id === 'string' && !d.deletedAt)
      .map((d) => ({
        id: String(d.id),
        type: str(d.type) ?? 'blank',
        name: str(d.name),
        sha256: '',
      }));
    const name = str(res.name) ?? this.d.pages.get(id)?.rawName ?? id;
    const c = classifyName(name);
    const prev = this.d.pages.get(id);
    const page: OverlayPage = {
      id,
      parentId: str(res.parentId) ?? prev?.parentId ?? null,
      rank: str(res.rank) ?? prev?.rank ?? null,
      rawName: name,
      displayName: c.displayName,
      kind: prev?.kind === 'root' ? 'root' : c.kind,
      resourceSha: null,
      sidebarSha: null,
      documents: docs,
      sourceSnapshotId: 'live',
      sourceTakenAt: now,
      unreadable: [],
    };
    this.live.set(id, page);
    const side = sidebarPiece(res.properties ?? []);
    const main = mainDocument(docs);
    let body: LoadedPage['body'] = kept?.body ?? null;
    if (main && opts.body !== false) {
      reads++;
      const b = await read('getDocumentBlocks', { path: { resourceId: id, documentId: main.id } });
      const blocks = isObj(b) && Array.isArray(b.blocks) ? (b.blocks as Obj[]) : [];
      body = { documentId: main.id, name: main.name, blocks };
    }
    const livePath = this.path(id);
    const loaded: LoadedPage = {
      page,
      path: livePath,
      pathText: livePath.names.join(' / '),
      labels: labelsOf(livePath, this.d.labels),
      resource: res,
      sidebar: extractSidebar(side, this.d.propertiesName),
      collections: collectionsOf(side),
      body,
      unreadable: [],
      source: 'live',
    };
    this.loaded.set(id, Promise.resolve(loaded));
    return { page: loaded, reads };
  }
}
