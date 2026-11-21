/**
 * What the appraisal keeps of a page's snapshot pieces (v3 F3c, ADR 0054): pure functions, no file, database or
 * LegendKeeper. A page's pieces in, out:
 *
 * - **units** of text for the full-text index: the page's name, each alias, each sidebar key-value row's value (the
 *   facts, by key), and each block of text (a heading, a paragraph, a list item's paragraph, a callout…), a table row as
 *   one unit (its cells joined), a code block; each with its document, block and the section path of the headings above
 *   it (`Purpose`, `History > Early Years`);
 * - **references** to other pages: mentions (in the sidebar's rows and in the documents' text) and collection items
 *   (the sidebar's Dependencies and Related Sources, a document's collection blocks), each with where it is and the text
 *   around it;
 * - **images**: each image block with the label heading above it and whether interpretation text follows it before the
 *   next heading or image; and any other image URL a page holds (a banner, a map's image, a board's assets).
 */
import { runsText } from '../audits/model.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A unit of text the full-text index holds. */
export interface TextUnit {
  readonly unit: 'name' | 'alias' | 'fact' | 'heading' | 'text' | 'row' | 'code';
  readonly text: string;
  readonly documentId: string | null;
  readonly blockId: string | null;
  /** A fact's key (`Scope`), or the property title of a key-value row outside PROPERTIES (`Infobox / Age`). */
  readonly field: string | null;
  /** The headings above the block (`History > Early Years`), or the sidebar property. */
  readonly section: string | null;
}

export interface PageRef {
  readonly fromDocument: string | null;
  readonly fromBlock: string | null;
  readonly section: string | null;
  readonly via: 'mention' | 'collection';
  readonly property: string | null;
  readonly rowKey: string | null;
  readonly toPage: string;
  readonly toDocument: string | null;
  /** The text a mention displays (its label when it was made). */
  readonly label: string | null;
  /** The unit's text around it, clipped. */
  readonly context: string | null;
}

export interface PageImage {
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly kind: 'block' | 'other';
  readonly url: string;
  /** The heading just above the image (its label, on an Art page), when there is one in its section. */
  readonly label: string | null;
  /** A paragraph of text follows the image before the next heading or image. */
  readonly interpretation: boolean;
  readonly section: string | null;
}

export interface PageExtract {
  readonly units: TextUnit[];
  readonly refs: PageRef[];
  readonly images: PageImage[];
}

export interface DocumentInput {
  readonly id: string;
  readonly type: string;
  readonly name: string | null;
  /** The document piece (`{ settings, blocks? , features?, … }`), or null when the store could not give it. */
  readonly piece: unknown;
}

export interface ExtractInput {
  readonly rawName: string;
  readonly displayName: string;
  /** The resource piece (name, tags, aliases, banner…), or null. */
  readonly resource: unknown;
  /** The sidebar piece (`{ properties }`), or null. */
  readonly sidebar: unknown;
  readonly documents: readonly DocumentInput[];
}

/** The longest text one unit keeps (a very long paragraph is still searchable by its start). */
export const MAX_UNIT_CHARS = 20_000;
const CONTEXT_CHARS = 300;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The URL's path, so the same asset matches on `assets` and `assets2` (v2 E5.2). */
export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A block's own text: its runs (mentions by their label), else a code block's text. */
export function ownText(b: Obj): string {
  if (Array.isArray(b.content)) return runsText(b.content);
  if (typeof b.text === 'string') return b.text;
  return '';
}

/** The text of a block and everything under it. */
export function deepText(b: Obj): string {
  const parts: string[] = [];
  const own = ownText(b);
  if (own.trim() !== '') parts.push(own);
  if (Array.isArray(b.children)) for (const c of b.children) if (isObj(c)) parts.push(deepText(c));
  return parts.filter((p) => p.trim() !== '').join(' ');
}

function mentionsOf(
  runs: readonly unknown[],
): { resourceId: string; documentId: string | null; label: string }[] {
  const out: { resourceId: string; documentId: string | null; label: string }[] = [];
  for (const r of runs) {
    if (!isObj(r) || !isObj(r.mention) || typeof r.mention.resourceId !== 'string') continue;
    out.push({
      resourceId: r.mention.resourceId,
      documentId: str(r.mention.documentId),
      label: str(r.mention.text) ?? str(r.mention.name) ?? '',
    });
  }
  return out;
}

/** Every https URL in a value (a banner, a map image, a board's assets…). */
function urlsIn(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 60) return;
  if (typeof v === 'string') {
    if (v.startsWith('https://')) out.add(v);
    return;
  }
  if (Array.isArray(v)) for (const x of v) urlsIn(x, out, depth + 1);
  else if (isObj(v)) for (const x of Object.values(v)) urlsIn(x, out, depth + 1);
}

/** A heading stack: the section path of the blocks below. */
class Sections {
  private stack: { level: number; title: string }[] = [];
  heading(level: number, title: string): void {
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.level >= level) this.stack.pop();
    this.stack.push({ level, title: tidy(title) || '(untitled heading)' });
  }
  get path(): string | null {
    return this.stack.length > 0 ? this.stack.map((s) => s.title).join(' > ') : null;
  }
  /**
   * CR-2026-11-R4 (RC-17): a container (an expand, a layout column, a callout) opens a frame of its own: a heading inside
   * it governs the blocks after it in the container only, never the blocks after the container.
   */
  frame<T>(fn: () => T): T {
    const saved = [...this.stack];
    try {
      return fn();
    } finally {
      this.stack = saved;
    }
  }
}

/** One page document's units, references and images. */
function extractDocument(doc: DocumentInput, out: PageExtract): void {
  const piece = isObj(doc.piece) ? doc.piece : null;
  if (!piece) return;
  if (doc.type !== 'page') {
    // A map, a timeline or a board: its images (a map's image, an event's, a board's assets) by URL; its text is not
    // indexed (event names and descriptions are the timeline's, not the page's body).
    const urls = new Set<string>();
    urlsIn(piece, urls);
    for (const url of urls)
      out.images.push({
        documentId: doc.id,
        blockId: null,
        kind: 'other',
        url,
        label: null,
        interpretation: false,
        section: null,
      });
    return;
  }
  const blocks = Array.isArray(piece.blocks) ? (piece.blocks as unknown[]) : [];
  const sections = new Sections();
  // Images waiting for their interpretation (a paragraph after them before the next heading or image).
  let pendingImage: { index: number } | null = null;
  let lastHeading: string | null = null;
  const settleImage = (interpreted: boolean) => {
    if (pendingImage === null) return;
    const img = out.images[pendingImage.index]!;
    out.images[pendingImage.index] = { ...img, interpretation: interpreted };
    pendingImage = null;
  };
  const addRefs = (runs: readonly unknown[], blockId: string | null, context: string) => {
    for (const m of mentionsOf(runs))
      out.refs.push({
        fromDocument: doc.id,
        fromBlock: blockId,
        section: sections.path,
        via: 'mention',
        property: null,
        rowKey: null,
        toPage: m.resourceId,
        toDocument: m.documentId,
        label: m.label,
        context: clip(tidy(context), CONTEXT_CHARS),
      });
  };
  /** Mentions anywhere under a block (a table row's cells), attributed to that block. */
  const deepRefs = (b: Obj, blockId: string | null, context: string) => {
    if (Array.isArray(b.content)) addRefs(b.content, blockId, context);
    if (Array.isArray(b.children)) for (const c of b.children) if (isObj(c)) deepRefs(c, blockId, context);
  };
  const walk = (list: readonly unknown[], topLevel: boolean): void => {
    for (const raw of list) {
      if (!isObj(raw)) continue;
      const b = raw;
      const kind = str(b.kind) ?? '';
      const id = str(b.id);
      if (kind === 'heading') {
        const title = ownText(b);
        settleImage(false);
        const level = typeof b.level === 'number' ? b.level : 1;
        sections.heading(level, title);
        lastHeading = tidy(title) || null;
        if (tidy(title) !== '')
          out.units.push({
            unit: 'heading',
            text: clip(tidy(title), MAX_UNIT_CHARS),
            documentId: doc.id,
            blockId: id,
            field: null,
            section: sections.path,
          });
        if (Array.isArray(b.content)) addRefs(b.content, id, title);
        continue;
      }
      if (kind === 'image') {
        settleImage(false);
        const url = str(b.url) ?? str(b.src);
        if (url) {
          out.images.push({
            documentId: doc.id,
            blockId: id,
            kind: 'block',
            url,
            label: lastHeading,
            interpretation: false,
            section: sections.path,
          });
          pendingImage = { index: out.images.length - 1 };
        }
        const caption = typeof b.caption === 'string' ? b.caption : typeof b.alt === 'string' ? b.alt : '';
        if (tidy(caption) !== '')
          out.units.push({
            unit: 'text',
            text: clip(tidy(caption), MAX_UNIT_CHARS),
            documentId: doc.id,
            blockId: id,
            field: 'image',
            section: sections.path,
          });
        continue;
      }
      if (kind === 'tableRow') {
        const cells = (Array.isArray(b.children) ? (b.children as unknown[]) : [])
          .filter(isObj)
          .map((c) => tidy(deepText(c)));
        const text = cells.join(' | ');
        if (cells.some((c) => c !== ''))
          out.units.push({
            unit: 'row',
            text: clip(text, MAX_UNIT_CHARS),
            documentId: doc.id,
            blockId: id,
            field: null,
            section: sections.path,
          });
        deepRefs(b, id, text);
        continue;
      }
      if (kind === 'code' || (typeof b.text === 'string' && !Array.isArray(b.content))) {
        const text = typeof b.text === 'string' ? b.text : '';
        if (tidy(text) !== '')
          out.units.push({
            unit: 'code',
            text: clip(text.trim(), MAX_UNIT_CHARS),
            documentId: doc.id,
            blockId: id,
            field: null,
            section: sections.path,
          });
        continue;
      }
      if ((kind === 'resourceCollection' || kind === 'resourceLink') && Array.isArray(b.items)) {
        for (const i of (b.items as unknown[]).filter(isObj))
          if (typeof i.resourceId === 'string')
            out.refs.push({
              fromDocument: doc.id,
              fromBlock: id,
              section: sections.path,
              via: 'collection',
              property: null,
              rowKey: null,
              toPage: i.resourceId,
              toDocument: str(i.documentId),
              label: null,
              context: null,
            });
        continue;
      }
      if (Array.isArray(b.content)) {
        const text = runsText(b.content);
        if (tidy(text) !== '') {
          // A paragraph of text right after an image is its interpretation (the Art page's layout).
          if (kind === 'paragraph' && topLevel) settleImage(true);
          out.units.push({
            unit: 'text',
            text: clip(tidy(text), MAX_UNIT_CHARS),
            documentId: doc.id,
            blockId: id,
            field: null,
            section: sections.path,
          });
        }
        addRefs(b.content, id, text);
      }
      if (Array.isArray(b.children)) sections.frame(() => walk(b.children as unknown[], false));
    }
  };
  walk(blocks, true);
  settleImage(false);
}

/** A sidebar's units (key-value rows) and references (row mentions, collection items). */
function extractSidebar(sidebar: unknown, propertiesName: string, out: PageExtract): void {
  const list = isObj(sidebar) && Array.isArray(sidebar.properties) ? (sidebar.properties as unknown[]) : [];
  const facts = propertiesName.trim().toLowerCase();
  for (const p of list) {
    if (!isObj(p)) continue;
    const title = str(p.title) ?? '';
    const kind = str(p.kind) ?? '';
    if (kind === 'keyValue' && Array.isArray(p.rows)) {
      const isFacts = title.trim().toLowerCase() === facts;
      for (const r of (p.rows as unknown[]).filter(isObj)) {
        const key = str(r.key) ?? '';
        const runs = Array.isArray(r.content) ? (r.content as unknown[]) : [];
        const text = runs.length > 0 ? runsText(runs) : (str(r.text) ?? '');
        if (tidy(text) !== '')
          out.units.push({
            unit: 'fact',
            text: clip(tidy(text), MAX_UNIT_CHARS),
            documentId: null,
            blockId: str(r.id),
            field: isFacts ? key : `${title} / ${key}`,
            section: `sidebar: ${title}`,
          });
        for (const m of mentionsOf(runs))
          out.refs.push({
            fromDocument: null,
            fromBlock: str(r.id),
            section: `sidebar: ${title}`,
            via: 'mention',
            property: title,
            rowKey: key,
            toPage: m.resourceId,
            toDocument: m.documentId,
            label: m.label,
            context: clip(`${key}: ${tidy(text)}`, CONTEXT_CHARS),
          });
      }
    }
    if ((kind === 'resourceCollection' || kind === 'resourceLink') && Array.isArray(p.items)) {
      for (const i of (p.items as unknown[]).filter(isObj))
        if (typeof i.resourceId === 'string')
          out.refs.push({
            fromDocument: null,
            fromBlock: str(p.id),
            section: `sidebar: ${title}`,
            via: 'collection',
            property: title,
            rowKey: null,
            toPage: i.resourceId,
            toDocument: str(i.documentId),
            label: null,
            context: null,
          });
    }
  }
}

/** Everything the index keeps of one page. */
export function extractPage(input: ExtractInput, propertiesName: string): PageExtract {
  const out: PageExtract = { units: [], refs: [], images: [] };
  const name = tidy(input.displayName);
  if (name !== '')
    out.units.push({
      unit: 'name',
      text: name,
      documentId: null,
      blockId: null,
      field: null,
      section: null,
    });
  const res = isObj(input.resource) ? input.resource : {};
  const aliases = Array.isArray(res.aliases)
    ? (res.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  for (const a of aliases)
    if (tidy(a) !== '')
      out.units.push({
        unit: 'alias',
        text: clip(tidy(a), MAX_UNIT_CHARS),
        documentId: null,
        blockId: null,
        field: null,
        section: null,
      });
  // The page's own images outside its documents (a banner, its image).
  const own = new Set<string>();
  urlsIn([isObj(res.banner) ? res.banner.url : null, res.imageUrl], own);
  for (const url of own)
    out.images.push({
      documentId: null,
      blockId: null,
      kind: 'other',
      url,
      label: null,
      interpretation: false,
      section: null,
    });
  if (input.sidebar !== null) extractSidebar(input.sidebar, propertiesName, out);
  for (const d of input.documents) extractDocument(d, out);
  return out;
}
