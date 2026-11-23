/**
 * v3 F7b (ADR 0071, D2): an image's written authority. The owner records on a page what an image establishes, its
 * precedence and its limits, in the paragraphs under it; this reads them back.
 *
 * - **Which pages**: the bridge's asset reference index (`appraisal_images`, every image block of every page in the
 *   newest snapshot, by its URL's path so `assets` and `assets2` match), and the pages this call read live (they stand
 *   in for their snapshot copy). Never LegendKeeper's search. Every page the index holds (the AI REPOSITORY) is looked
 *   at; the character's Art and Wardrobe pages (`artView.ownerPages`) are marked `ownerPage` and listed first within
 *   their lifecycle.
 * - **What each says**: per image block embedding the URL, its page, document, section (the heading path above it),
 *   lifecycle, `label` (the block's alt text) and `text`: the blocks under the image, up to the next image or heading at
 *   its level, trimmed to `textChars` (1,200) with `truncated: true`.
 * - **Order**: Authoritative first, then pages with no lifecycle, then Working, then Archived; owner pages first within
 *   each; then by path.
 *
 * The pure part (`embeddingsIn`) reads blocks only; `AuthorityIndex` reads the bridge's database and snapshot store.
 */
import { deepText, ownText, urlPath } from '../../appraisal/extract.js';
import type { Appraisal } from '../../appraisal/service.js';
import type { PageReader } from '../../appraisal/reader.js';
import type { AreaKey, Lifecycle } from '../../appraisal/scope.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const NO_AUTHORITY_WARNING = 'No owner page embeds this image; it establishes nothing about canon';

/** One image block embedding a URL, as the page holds it. */
export interface Embedding {
  readonly blockId: string | null;
  readonly section: string | null;
  readonly label: string | null;
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Every image block in `blocks` whose URL has `path` as its path, in document order, with the text under it. The
 * text is the blocks that follow the image in the same list (a column, a callout, the page), up to the next image or
 * heading; a container's heading governs only inside it, as the appraisal reads sections.
 */
export function embeddingsIn(blocks: readonly unknown[], path: string, textChars: number): Embedding[] {
  const out: Embedding[] = [];
  let stack: { level: number; title: string }[] = [];
  const sectionPath = () => (stack.length > 0 ? stack.map((s) => s.title).join(' > ') : null);
  const walk = (list: readonly unknown[], depth: number): void => {
    if (depth > 64) return;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!isObj(b)) continue;
      if (b.kind === 'heading') {
        const level = typeof b.level === 'number' ? b.level : 1;
        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, title: tidy(ownText(b)) || '(untitled heading)' });
        continue;
      }
      if (b.kind === 'image') {
        const url = typeof b.url === 'string' ? b.url : typeof b.src === 'string' ? b.src : null;
        if (url !== null && urlPath(url) === path) {
          const parts: string[] = [];
          for (let j = i + 1; j < list.length; j++) {
            const n = list[j];
            if (!isObj(n)) continue;
            if (n.kind === 'heading' || n.kind === 'image') break;
            const t = deepText(n).trim();
            if (t !== '') parts.push(t);
          }
          const all = parts.join('\n\n');
          const truncated = all.length > textChars;
          const alt = typeof b.alt === 'string' && tidy(b.alt) !== '' ? tidy(b.alt) : null;
          out.push({
            blockId: typeof b.id === 'string' ? b.id : null,
            section: sectionPath(),
            label: alt,
            text: truncated ? `${all.slice(0, textChars - 1).trimEnd()}…` : all,
            truncated,
          });
        }
        continue;
      }
      if (Array.isArray(b.children)) {
        const saved = stack;
        stack = [...stack];
        walk(b.children as unknown[], depth + 1);
        stack = saved;
      }
    }
  };
  walk(blocks, 0);
  return out;
}

/** Every image block's URL in `blocks`, in document order (the page selector). */
export function imageUrlsIn(
  blocks: readonly unknown[],
): { blockId: string | null; url: string; alt: string | null }[] {
  const out: { blockId: string | null; url: string; alt: string | null }[] = [];
  const walk = (list: readonly unknown[], depth: number) => {
    if (depth > 64) return;
    for (const b of list) {
      if (!isObj(b)) continue;
      if (b.kind === 'image') {
        const url = typeof b.url === 'string' ? b.url : typeof b.src === 'string' ? b.src : null;
        if (url)
          out.push({
            blockId: typeof b.id === 'string' ? b.id : null,
            url,
            alt: typeof b.alt === 'string' && tidy(b.alt) !== '' ? tidy(b.alt) : null,
          });
        continue;
      }
      if (Array.isArray(b.children)) walk(b.children as unknown[], depth + 1);
    }
  };
  walk(blocks, 0);
  return out;
}

export interface AuthorityPage {
  readonly page: { readonly id: string; readonly name: string; readonly path: string };
  readonly document: { readonly id: string; readonly name: string | null };
  readonly section: string | null;
  readonly lifecycle: Lifecycle | null;
  /** A non-current area (the Legacy Canon Archive, the Design References), when the page sits in one. */
  readonly area?: AreaKey;
  /** One of the character's Art or Wardrobe pages (looked at first). */
  readonly ownerPage: boolean;
  readonly blockId: string | null;
  readonly label: string | null;
  readonly text: string;
  readonly truncated?: true;
  /** Where the page was read from. */
  readonly from: 'snapshot' | 'live';
}

export type Authority =
  | {
      readonly status: 'found';
      readonly pages: readonly AuthorityPage[];
      /** Only the pages read live in this call were looked at (no index): why. Others may embed it too. */
      readonly partial?: string;
    }
  | { readonly status: 'none'; readonly warning: string; readonly pages: readonly [] }
  | { readonly status: 'unavailable'; readonly reason: string };

/** A page this call read live: the documents read stand in for their snapshot copies. */
export interface LivePage {
  readonly id: string;
  readonly name: string;
  readonly documents: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly blocks: unknown[];
  }[];
}

const LIFECYCLE_RANK: Record<string, number> = { Authoritative: 0, none: 1, Working: 2, Archived: 3 };

export function sortAuthority(pages: AuthorityPage[]): AuthorityPage[] {
  return pages.sort(
    (a, b) =>
      LIFECYCLE_RANK[a.lifecycle ?? 'none']! - LIFECYCLE_RANK[b.lifecycle ?? 'none']! ||
      Number(b.ownerPage) - Number(a.ownerPage) ||
      a.page.path.localeCompare(b.page.path) ||
      (a.document.id < b.document.id ? -1 : a.document.id > b.document.id ? 1 : 0),
  );
}

export interface AuthorityOptions {
  readonly textChars: number;
  /** Whether a page is one of the character's Art or Wardrobe pages. */
  readonly isOwnerPage: (pageId: string) => boolean;
  readonly live: ReadonlyMap<string, LivePage>;
}

/**
 * The authority of several image URLs, from one reader of the appraisal's index (the snapshots) and the pages read
 * live. Unavailable (never "none") when there is no index yet.
 */
export class AuthorityIndex {
  private constructor(
    private readonly appraisal: Appraisal | null,
    private readonly reader: PageReader | null,
    private readonly projectId: string,
    readonly source: { readonly newestSnapshotAt: number | null; readonly reason?: string },
  ) {}

  static async open(appraisal: Appraisal | undefined, projectId: string): Promise<AuthorityIndex> {
    if (!appraisal)
      return new AuthorityIndex(null, null, projectId, {
        newestSnapshotAt: null,
        reason: 'the bridge’s full-text and asset reference index is not available here',
      });
    try {
      const { reader, state } = await appraisal.reader(projectId);
      return new AuthorityIndex(appraisal, reader, projectId, { newestSnapshotAt: state.newestTakenAt });
    } catch (e) {
      return new AuthorityIndex(null, null, projectId, {
        newestSnapshotAt: null,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  get available(): boolean {
    return this.reader !== null;
  }

  /** The document pieces of an indexed page's document (null: not in the snapshot store). */
  private async blocksOf(pageId: string, documentId: string): Promise<unknown[] | null> {
    const page = this.reader?.page(pageId);
    const doc = page?.documents.find((d) => d.id === documentId);
    if (!doc || !doc.sha256 || !this.appraisal) return null;
    const piece = await this.appraisal.d.snapshots.store.getJson(doc.sha256);
    return isObj(piece) && Array.isArray(piece.blocks) ? (piece.blocks as unknown[]) : null;
  }

  async authorityOf(url: string, o: AuthorityOptions): Promise<Authority> {
    const path = urlPath(url);
    if (!this.appraisal || !this.reader) {
      // No index: the pages read live in this call still say what they say; nothing else can be known.
      const found: AuthorityPage[] = [];
      for (const lp of o.live.values())
        for (const d of lp.documents)
          for (const e of embeddingsIn(d.blocks, path, o.textChars))
            found.push({
              page: { id: lp.id, name: lp.name, path: lp.name },
              document: { id: d.id, name: d.name },
              section: e.section,
              lifecycle: null,
              ownerPage: o.isOwnerPage(lp.id),
              blockId: e.blockId,
              label: e.label,
              text: e.text,
              ...(e.truncated ? { truncated: true as const } : {}),
              from: 'live',
            });
      return found.length > 0
        ? { status: 'found', pages: sortAuthority(found), partial: this.source.reason ?? 'no index' }
        : { status: 'unavailable', reason: this.source.reason ?? 'no index' };
    }
    const rows = this.appraisal.d.db
      .prepare(
        `SELECT DISTINCT page_id, document_id FROM appraisal_images
         WHERE project_id = ? AND kind = 'block' AND url_path = ? AND document_id IS NOT NULL`,
      )
      .all(this.projectId, path) as { page_id: string; document_id: string }[];
    const pages: AuthorityPage[] = [];
    const reader = this.reader;
    const add = (
      pageId: string,
      name: string,
      doc: { id: string; name: string | null },
      list: Embedding[],
      from: 'snapshot' | 'live',
    ) => {
      const labels = reader.page(pageId) ? reader.labels(pageId) : null;
      for (const e of list)
        pages.push({
          page: { id: pageId, name, path: reader.page(pageId) ? reader.pathText(pageId) : name },
          document: doc,
          section: e.section,
          lifecycle: labels?.lifecycle ?? null,
          ...(labels?.area ? { area: labels.area } : {}),
          ownerPage: o.isOwnerPage(pageId),
          blockId: e.blockId,
          label: e.label,
          text: e.text,
          ...(e.truncated ? { truncated: true as const } : {}),
          from,
        });
    };
    for (const r of rows) {
      // A document read live in this call stands in for its snapshot copy (the page's other documents still count).
      if (o.live.get(r.page_id)?.documents.some((d) => d.id === r.document_id)) continue;
      const page = reader.page(r.page_id);
      if (!page) continue;
      const blocks = await this.blocksOf(r.page_id, r.document_id);
      if (!blocks) continue;
      const doc = page.documents.find((d) => d.id === r.document_id);
      add(
        r.page_id,
        page.rawName,
        { id: r.document_id, name: doc?.name ?? null },
        embeddingsIn(blocks, path, o.textChars),
        'snapshot',
      );
    }
    for (const lp of o.live.values())
      for (const d of lp.documents)
        add(lp.id, lp.name, { id: d.id, name: d.name }, embeddingsIn(d.blocks, path, o.textChars), 'live');
    if (pages.length === 0) return { status: 'none', warning: NO_AUTHORITY_WARNING, pages: [] };
    return { status: 'found', pages: sortAuthority(pages) };
  }
}
