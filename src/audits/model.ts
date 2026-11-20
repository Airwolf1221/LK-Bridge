/**
 * What an audit knows about a project, extracted from snapshot pieces (v2 E2, ADR 0044). Pure functions: a page's
 * sidebar piece and document pieces in, a compact `AuditPage` out. Nothing here reads a file, the database or
 * LegendKeeper, so every check is testable with hand-made pages.
 *
 * Extraction keeps only what the checks need (facts, sidebar structure, references, per-block keep-region findings),
 * never the blocks themselves, so a model of 1,500 pages stays small.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../jobs/sidebar-state.js';
import type { NodeKind } from '../tree/index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** A paragraph's runs hashed in key order (the snapshot store keeps keys sorted, a live read does not). */
export const runsHashOf = (runs: readonly unknown[]): string => sha1(stableJson(runs));

/** A reference from one page to a page (and maybe one of its documents). */
export interface Ref {
  readonly resourceId: string;
  readonly documentId: string | null;
  readonly via:
    | { readonly kind: 'mention'; readonly where: 'sidebar'; readonly property: string; readonly row: string }
    | {
        readonly kind: 'mention';
        readonly where: 'document';
        readonly documentId: string;
        readonly blockId: string | null;
      }
    | { readonly kind: 'collection'; readonly where: 'sidebar'; readonly property: string }
    | {
        readonly kind: 'collection';
        readonly where: 'document';
        readonly documentId: string;
        readonly blockId: string | null;
      };
}

export interface PropertySummary {
  readonly id: string | null;
  readonly kind: string;
  readonly title: string | null;
  readonly isTitleHidden: boolean;
  readonly isHidden: boolean;
  readonly display: string | null;
  /** Key-value properties: each row's key and plain text, in rank order. */
  readonly rows:
    readonly { readonly id: string | null; readonly key: string; readonly text: string }[] | null;
}

export interface DocumentInfo {
  readonly id: string;
  readonly name: string | null;
  readonly type: string;
}

/** A paragraph whose text holds a line break (or another character Markdown cannot carry). */
export interface LineBreakParagraph {
  readonly blockId: string | null;
  /** Visible escapes of the offending characters, for example `\n`, `\r`, `\u0007`. */
  readonly characters: readonly string[];
  /** Only line breaks (`\n`, `\r`): the block can be split into paragraphs. */
  readonly splittable: boolean;
  /** How many parts splitting it would give. */
  readonly parts: number;
  readonly preview: string;
  /** A hash of the block's runs, so the evidence changes when the paragraph does. */
  readonly runsHash: string;
}

export interface DocumentScan {
  readonly documentId: string;
  readonly name: string | null;
  readonly lineBreaks: readonly LineBreakParagraph[];
  /** Blocks holding a run LegendKeeper's write format has no form for (an inline icon). */
  readonly iconBlocks: readonly string[];
  readonly unsupported: { readonly count: number; readonly blockIds: readonly string[] };
  readonly collectionBlocks: number;
  /** `json` code blocks (kept only for the tag-definition document). */
  readonly codeBlocks: readonly {
    readonly blockId: string | null;
    readonly language: string;
    readonly text: string;
  }[];
  /**
   * v3 F4c (ADR 0065): the plain text of the document's first block (at most 300 characters; mentions by their label),
   * or null for an empty document: a chapter's dateline, for the narrative audit.
   */
  readonly firstText?: string | null;
}

export interface AuditPage {
  readonly id: string;
  readonly parentId: string | null;
  readonly rank: string | null;
  /** The name as stored, prefix included. */
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: Exclude<NodeKind, 'root'> | 'root';
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  /** The sidebar's properties in order; null when no sidebar piece could be read. */
  readonly properties: readonly PropertySummary[] | null;
  /** The facts: the PROPERTIES key-value rows by lower-case key (first row wins). */
  readonly facts: ReadonlyMap<
    string,
    {
      readonly key: string;
      readonly text: string;
      readonly rowId: string | null;
      /** How many rows of PROPERTIES have this key (more than one: the fact is ambiguous). */
      readonly count: number;
    }
  >;
  /** True when the PROPERTIES property exists. */
  readonly hasProperties: boolean;
  /** Documents in the order the snapshot lists them. */
  readonly documents: readonly DocumentInfo[];
  readonly scans: readonly DocumentScan[];
  /** Every reference the page holds: its sidebar's mentions and collection items, its documents' mentions and collections. */
  readonly refs: readonly Ref[];
  /** The snapshot that supplied the page's newest piece, and when it was taken (ms). */
  readonly sourceSnapshotId: string;
  readonly sourceTakenAt: number;
  /** Pieces the snapshot named but the store could not give (missing or damaged). */
  readonly unreadable: readonly string[];
}

// ============================================================================================ runs and text

/** A row's plain text from its runs (mentions by their label, breaks as a newline). */
export function rowText(row: Obj): string {
  if (Array.isArray(row.content)) return runsText(row.content);
  return typeof row.text === 'string' ? row.text : '';
}

export function runsText(runs: readonly unknown[]): string {
  let out = '';
  for (const r of runs) {
    if (!isObj(r)) continue;
    if (typeof r.text === 'string') out += r.text;
    else if (r.break === true) out += '\n';
    else if (isObj(r.mention)) out += str(r.mention.text) ?? str(r.mention.name) ?? '';
  }
  return out;
}

/** Characters Markdown cannot carry inside a line (B1's rule): line breaks, control characters, a BOM, lone surrogates. */
/* eslint-disable no-control-regex -- matching control characters is the point */
const BAD =
  /[\n\r\0\x01-\x08\x0b\x0c\x0e-\x1f\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/* eslint-enable no-control-regex */

const escapeChar = (c: string): string =>
  c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** The run kinds LegendKeeper's write format has: text, mention, break. Anything else (an `icon`) cannot be written back. */
export const isKnownRun = (r: Obj): boolean =>
  typeof r.text === 'string' || isObj(r.mention) || r.break === true;

function mentionsIn(runs: readonly unknown[]): { resourceId: string; documentId: string | null }[] {
  const out: { resourceId: string; documentId: string | null }[] = [];
  for (const r of runs) {
    if (isObj(r) && isObj(r.mention) && typeof r.mention.resourceId === 'string')
      out.push({ resourceId: r.mention.resourceId, documentId: str(r.mention.documentId) });
  }
  return out;
}

// ============================================================================================ sidebar

export interface SidebarFacts {
  readonly properties: readonly PropertySummary[];
  readonly facts: AuditPage['facts'];
  readonly hasProperties: boolean;
  readonly refs: Ref[];
}

const norm = (s: string): string => s.normalize('NFC').trim().toLowerCase();
export const nameKey = norm;

/** A sidebar piece (`{ properties }`, rank-sorted, rows in rank order) summarised. */
export function extractSidebar(piece: unknown, propertiesName: string): SidebarFacts {
  const list = isObj(piece) && Array.isArray(piece.properties) ? (piece.properties as unknown[]) : [];
  const properties: PropertySummary[] = [];
  const refs: Ref[] = [];
  const facts = new Map<string, { key: string; text: string; rowId: string | null; count: number }>();
  let hasProperties = false;
  for (const p of list) {
    if (!isObj(p)) continue;
    const kind = str(p.kind) ?? 'unknown';
    const title = str(p.title);
    const rows =
      kind === 'keyValue' && Array.isArray(p.rows)
        ? (p.rows as unknown[]).filter(isObj).map((r) => ({
            id: str(r.id),
            key: str(r.key) ?? '',
            text: rowText(r),
          }))
        : null;
    properties.push({
      id: str(p.id),
      kind,
      title,
      isTitleHidden: p.isTitleHidden === true,
      isHidden: p.isHidden === true,
      display: str(p.display),
      rows,
    });
    if (kind === 'keyValue' && Array.isArray(p.rows)) {
      for (const r of (p.rows as unknown[]).filter(isObj)) {
        for (const m of mentionsIn(Array.isArray(r.content) ? r.content : []))
          refs.push({
            ...m,
            via: { kind: 'mention', where: 'sidebar', property: title ?? '', row: str(r.key) ?? '' },
          });
      }
      if (title !== null && norm(title) === norm(propertiesName)) {
        hasProperties = true;
        for (const r of rows ?? []) {
          const k = norm(r.key);
          if (k === '') continue;
          const had = facts.get(k);
          if (had) facts.set(k, { ...had, count: had.count + 1 });
          else facts.set(k, { key: r.key, text: r.text, rowId: r.id, count: 1 });
        }
      }
    }
    if ((kind === 'resourceCollection' || kind === 'resourceLink') && Array.isArray(p.items)) {
      for (const i of (p.items as unknown[]).filter(isObj)) {
        if (typeof i.resourceId === 'string')
          refs.push({
            resourceId: i.resourceId,
            documentId: str(i.documentId),
            via: { kind: 'collection', where: 'sidebar', property: title ?? '' },
          });
      }
    }
  }
  return { properties, facts, hasProperties, refs };
}

// ============================================================================================ documents

/** The text of a paragraph's runs, for the finding's preview. */
const preview = (runs: readonly unknown[]): string => {
  const t = runsText(runs).replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

/** Splits runs at `\n` / `\r\n` / `\r` inside text runs: one list of runs per resulting paragraph (marks kept). */
export function splitRunsAtBreaks(runs: readonly unknown[]): Obj[][] {
  const parts: Obj[][] = [[]];
  for (const r of runs) {
    if (!isObj(r)) continue;
    if (typeof r.text !== 'string' || !/[\n\r]/.test(r.text)) {
      parts[parts.length - 1]!.push(r);
      continue;
    }
    const pieces = r.text.split(/\r\n|\n|\r/);
    pieces.forEach((piece, i) => {
      if (i > 0) parts.push([]);
      if (piece !== '') parts[parts.length - 1]!.push({ ...r, text: piece });
    });
  }
  return parts;
}

export interface ScanOptions {
  /** Keep `json` code blocks (the tag-definition document). */
  readonly keepCode?: boolean;
}

/** Walks a page document's blocks once: references, line-break paragraphs, icons, unsupported blocks, collections. */
export function scanDocument(
  doc: { readonly id: string; readonly name: string | null },
  blocks: readonly unknown[],
  o: ScanOptions = {},
): { scan: DocumentScan; refs: Ref[] } {
  const refs: Ref[] = [];
  const lineBreaks: LineBreakParagraph[] = [];
  const iconBlocks: string[] = [];
  const unsupportedIds: string[] = [];
  const codeBlocks: { blockId: string | null; language: string; text: string }[] = [];
  let unsupportedCount = 0;
  let collectionBlocks = 0;
  const walk = (list: readonly unknown[]): void => {
    for (const b of list) {
      if (!isObj(b)) continue;
      const kind = str(b.kind);
      const id = str(b.id);
      if (kind === 'unsupported') {
        unsupportedCount++;
        if (id) unsupportedIds.push(id);
      }
      if (Array.isArray(b.content)) {
        const runs = b.content as unknown[];
        for (const m of mentionsIn(runs))
          refs.push({ ...m, via: { kind: 'mention', where: 'document', documentId: doc.id, blockId: id } });
        if (runs.some((r) => isObj(r) && !isKnownRun(r))) iconBlocks.push(id ?? '');
        if (kind === 'paragraph') {
          const bad = new Set<string>();
          for (const r of runs) {
            if (isObj(r) && typeof r.text === 'string') for (const m of r.text.matchAll(BAD)) bad.add(m[0]);
          }
          if (bad.size > 0) {
            const chars = [...bad].sort();
            const onlyBreaks = chars.every((c) => c === '\n' || c === '\r');
            lineBreaks.push({
              blockId: id,
              characters: chars.map(escapeChar),
              splittable: onlyBreaks,
              parts: onlyBreaks ? splitRunsAtBreaks(runs).filter((p) => p.length > 0).length : 0,
              preview: preview(runs),
              runsHash: runsHashOf(runs),
            });
          }
        }
      }
      if ((kind === 'resourceCollection' || kind === 'resourceLink') && Array.isArray(b.items)) {
        collectionBlocks++;
        for (const i of (b.items as unknown[]).filter(isObj)) {
          if (typeof i.resourceId === 'string')
            refs.push({
              resourceId: i.resourceId,
              documentId: str(i.documentId),
              via: { kind: 'collection', where: 'document', documentId: doc.id, blockId: id },
            });
        }
      }
      if (kind === 'code' && o.keepCode === true)
        codeBlocks.push({ blockId: id, language: str(b.language) ?? '', text: str(b.text) ?? '' });
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  const first = blocks.find(isObj);
  const firstRuns = first && Array.isArray(first.content) ? (first.content as unknown[]) : null;
  const firstText = firstRuns
    ? firstRuns
        .map((r) =>
          isObj(r) && typeof r.text === 'string'
            ? r.text
            : isObj(r) && isObj(r.mention)
              ? (str(r.mention.text) ?? '')
              : '',
        )
        .join('')
        .trim()
        .slice(0, 300)
    : null;
  return {
    refs,
    scan: {
      documentId: doc.id,
      name: doc.name,
      firstText,
      lineBreaks,
      iconBlocks,
      unsupported: { count: unsupportedCount, blockIds: unsupportedIds },
      collectionBlocks,
      codeBlocks,
    },
  };
}

/** The resource piece's tags and aliases. */
export function extractResource(piece: unknown): { tags: string[]; aliases: string[] } {
  const r = isObj(piece) ? piece : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { tags: list(r.tags), aliases: list(r.aliases) };
}
