/**
 * The converter's model of a page: which blocks Markdown can express (and which become keep regions), and the
 * "projection" of each expressible block, which is exactly what its Markdown shows. Parsing Markdown yields
 * projections; matching a parsed block against the current page compares projections, so a block whose Markdown did
 * not change is restored verbatim, with its id and every attribute Markdown cannot show.
 *
 * Invariant (proved by the property tests): for every expressible block B, parse(render(B)) equals project(B).
 */
import type { LkBlock, LkRun } from './types.js';

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ------------------------------------------------------------------------------------------------ runs

/** Boolean marks, in a fixed order. `code` is rendered innermost. */
export const BOOL_MARKS = ['bold', 'italic', 'strike', 'underline', 'sub', 'sup', 'code'] as const;
export type BoolMark = (typeof BOOL_MARKS)[number];

/**
 * Text colour and highlight are not in the API's run schema (spec 3.0.0); the converter reads and writes them as
 * `color` and `highlight` so the owner's `<span style>` syntax works the day the API adds them. Until then a write
 * carrying one is refused by the schema check.
 */
const TEXT_RUN_KEYS: ReadonlySet<string> = new Set(['text', ...BOOL_MARKS, 'link', 'color', 'highlight']);
const MENTION_KEYS: ReadonlySet<string> = new Set(['resourceId', 'documentId', 'text', 'name']);
const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
/** Ids that can be written in a keep marker (`id="…"` inside an HTML comment). */
export const SAFE_ID_RE = /^[A-Za-z0-9_.:-]+$/;
/** Ids that can be written in an `lk://` URL without escaping. */
export const URL_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface Marks {
  bold?: true;
  italic?: true;
  strike?: true;
  underline?: true;
  sub?: true;
  sup?: true;
  code?: true;
  link?: string;
  color?: string;
  highlight?: string;
}

export type NRun =
  | { readonly t: 'text'; readonly text: string; readonly marks: Marks }
  | {
      readonly t: 'mention';
      readonly resourceId: string;
      readonly documentId?: string;
      readonly label: string;
    }
  | { readonly t: 'break' };

/**
 * Characters Markdown cannot carry inside a line of text (or that CommonMark rewrites): line breaks, control characters
 * other than tab, a byte-order mark, and unpaired surrogates.
 */
const BAD_TEXT_RE = new RegExp(
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  '[\\n\\r\\0\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\ufeff]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]',
);
export const hasBadText = (s: string): boolean => BAD_TEXT_RE.test(s);

export function marksKey(m: Marks): string {
  return `${BOOL_MARKS.map((k) => (m[k] ? '1' : '0')).join('')}|${m.link ?? ''}|${m.color ?? ''}|${m.highlight ?? ''}`;
}

export function sameMarks(a: Marks, b: Marks): boolean {
  return marksKey(a) === marksKey(b);
}

/** The label a mention shows: its own text, else the resource's name. */
export function mentionLabel(m: Obj): string {
  if (typeof m.text === 'string') return m.text;
  if (typeof m.name === 'string') return m.name;
  return '';
}

/**
 * Normalises runs the way LegendKeeper does on write (empty text dropped, neighbours with identical marks merged) and
 * returns them in the converter's form, or the reason Markdown cannot express them.
 */
export function normalizeRuns(runs: unknown): { runs: NRun[] } | { reason: string } {
  if (!Array.isArray(runs)) return { reason: 'content is not a list of runs' };
  const out: NRun[] = [];
  for (const r of runs) {
    if (!isObj(r)) return { reason: 'a run is not an object' };
    if ('mention' in r) {
      const m = r.mention;
      if (Object.keys(r).length !== 1 || !isObj(m)) return { reason: 'a mention run has extra fields' };
      if (!Object.keys(m).every((k) => MENTION_KEYS.has(k)))
        return { reason: 'a mention has unknown fields' };
      if (typeof m.resourceId !== 'string' || !URL_ID_RE.test(m.resourceId))
        return { reason: 'a mention id cannot be written as a link' };
      if (m.documentId !== undefined && (typeof m.documentId !== 'string' || !URL_ID_RE.test(m.documentId)))
        return { reason: 'a mention document id cannot be written as a link' };
      if (m.text !== undefined && typeof m.text !== 'string')
        return { reason: 'a mention label is not text' };
      if (m.name !== undefined && typeof m.name !== 'string') return { reason: 'a mention name is not text' };
      const label = mentionLabel(m);
      if (hasBadText(label)) return { reason: 'a mention label holds a line break or control character' };
      out.push({
        t: 'mention',
        resourceId: m.resourceId,
        ...(typeof m.documentId === 'string' ? { documentId: m.documentId } : {}),
        label,
      });
      continue;
    }
    if ('break' in r) {
      if (Object.keys(r).length !== 1 || r.break !== true)
        return { reason: 'a line break run has extra fields' };
      out.push({ t: 'break' });
      continue;
    }
    if (typeof r.text !== 'string')
      return { reason: 'a run of a kind Markdown cannot show (an inline icon?)' };
    const marks: Marks = {};
    for (const [k, v] of Object.entries(r)) {
      if (!TEXT_RUN_KEYS.has(k)) return { reason: `a run carries "${k}", which Markdown cannot show` };
      if (k === 'text') continue;
      if ((BOOL_MARKS as readonly string[]).includes(k)) {
        if (v === true) marks[k as BoolMark] = true;
        else if (v !== false && v !== undefined) return { reason: `a run's "${k}" is not true or false` };
      } else if (k === 'link') {
        if (v === undefined) continue;
        if (typeof v !== 'string' || v === '' || hasBadText(v) || /^lk:/i.test(v))
          return { reason: 'a link cannot be written in Markdown' };
        marks.link = v;
      } else if (k === 'color' || k === 'highlight') {
        if (v === undefined) continue;
        if (typeof v !== 'string' || !COLOUR_RE.test(v)) return { reason: `a run's ${k} is not #RRGGBB` };
        marks[k] = v;
      }
    }
    if (hasBadText(r.text)) return { reason: 'text holds a line break or control character' };
    if (r.text === '') continue;
    const prev = out[out.length - 1];
    if (prev?.t === 'text' && sameMarks(prev.marks, marks)) {
      out[out.length - 1] = { t: 'text', text: prev.text + r.text, marks };
    } else out.push({ t: 'text', text: r.text, marks });
  }
  return { runs: out };
}

/** Converter runs back to LegendKeeper runs (the projection of `content`). */
export function toLkRuns(runs: readonly NRun[]): LkRun[] {
  return runs.map((r): LkRun => {
    if (r.t === 'break') return { break: true };
    if (r.t === 'mention') {
      return {
        mention: {
          resourceId: r.resourceId,
          ...(r.documentId !== undefined ? { documentId: r.documentId } : {}),
          ...(r.label !== '' ? { text: r.label } : {}),
        },
      };
    }
    return { text: r.text, ...r.marks };
  });
}

/** Plain text of runs: text, mention labels, a space for a line break. */
export function runsPlainText(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  let s = '';
  for (const r of runs) {
    if (!isObj(r)) continue;
    if (typeof r.text === 'string') s += r.text;
    else if (isObj(r.mention)) s += mentionLabel(r.mention);
    else if (r.break === true) s += ' ';
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ blocks

/** Kinds with `children`. */
export const CONTAINER_KINDS: ReadonlySet<string> = new Set([
  'quote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'table',
  'tableRow',
  'tableCell',
  'callout',
  'expand',
  'layout',
  'layoutColumn',
  'secret',
  'textField',
]);

/** Kinds Markdown never expresses: always keep regions. */
export const KEEP_KINDS: Readonly<Record<string, string>> = {
  embed: 'an embedded player',
  keyValue: 'a key-value block',
  infobox: 'an infobox',
  meter: 'a meter',
  resourceCollection: 'a collection',
  resourceLink: 'a link block',
  map: 'a map block',
  textField: 'a text field block',
  layout: 'a column layout',
  layoutColumn: 'a layout column',
  unsupported: 'content the API cannot show',
};

/** Fields Markdown shows, per kind. On a changed block these come from the Markdown; every other field is kept. */
export const SHOWN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  paragraph: ['content'],
  heading: ['level', 'content'],
  quote: [],
  callout: ['tone'],
  expand: ['title'],
  secret: [],
  code: ['language', 'text'],
  rule: [],
  bulletList: [],
  orderedList: ['start'],
  listItem: [],
  taskList: [],
  taskItem: ['checked', 'content'],
  table: [],
  tableRow: [],
  // `header` is kept from the current cell: GFM can only mark the first row, LegendKeeper any cell.
  tableCell: [],
  image: ['url', 'alt'],
};

export const CALLOUT_TONES: readonly string[] = ['info', 'note', 'success', 'warning', 'error'];
/** A code language Markdown can carry in a fence's info string. */
export const LANGUAGE_RE = /^[^\s`\\&<>]+(?: [^\s`\\&<>]+)*$/;
/** The largest ordered-list start CommonMark accepts (nine digits). */
export const MAX_LIST_START = 999_999_999;

export const emptyParagraph = (): LkBlock => ({ kind: 'paragraph', content: [] });

/** An analysed block: whether Markdown expresses it, and its analysed children. */
export interface ANode {
  readonly block: LkBlock;
  /** Why it is a keep region, or null when Markdown expresses it. */
  readonly keep: string | null;
  /** The keep region id (the block id, or `anon-<n>`). */
  readonly keepId: string | null;
  /** The kind of the container holding it ('root' at the top level). */
  readonly parentKind: string;
  /** Analysed children of an expressible container (the projection's children). */
  readonly children: readonly ANode[];
  /** For a table cell: its row index. */
  readonly row: number;
  /** Normalised runs of a text block. */
  readonly runs: readonly NRun[] | null;
  /** Lazily computed. */
  ownProj?: LkBlock;
  fp?: number;
  /** The interner `fp` belongs to (fingerprints from different interners are unrelated). */
  fpBy?: Interner;
  /** For an empty container: the one empty paragraph its Markdown shows. */
  emptyKids?: ANode[];
}

function blockChildren(b: LkBlock): unknown[] | null {
  return Array.isArray(b.children) ? b.children : null;
}

/** Why a block is a keep region in this position, or null when Markdown expresses it. */
function keepReason(b: unknown, parentKind: string): string | null {
  if (!isObj(b) || typeof b.kind !== 'string') return 'not a block';
  const kind = b.kind;
  if (kind in KEEP_KINDS) return KEEP_KINDS[kind]!;
  const kids = blockChildren(b as LkBlock);
  if (CONTAINER_KINDS.has(kind) && kids === null) return 'a container without children';
  switch (kind) {
    case 'paragraph': {
      const r = normalizeRuns(b.content);
      return 'reason' in r ? r.reason : null;
    }
    case 'heading': {
      if (!Number.isInteger(b.level) || (b.level as number) < 1 || (b.level as number) > 6)
        return 'a heading level outside 1 to 6';
      const r = normalizeRuns(b.content);
      return 'reason' in r ? r.reason : null;
    }
    case 'quote':
    case 'secret':
      return null;
    case 'callout':
      if (typeof b.tone !== 'string' || !CALLOUT_TONES.includes(b.tone))
        return 'a callout with a custom colour';
      if (b.color !== undefined) return 'a callout with its own colour';
      return null;
    case 'expand':
      if (typeof b.title !== 'string' || hasBadText(b.title)) return 'an expand title Markdown cannot show';
      return null;
    case 'code': {
      if (typeof b.text !== 'string') return 'code without text';
      if (/[\r\0\ufeff]/.test(b.text) || hasBadText(b.text.replace(/\n/g, '')))
        return 'code with characters Markdown rewrites';
      const lang = b.language;
      if (lang !== undefined && lang !== '' && (typeof lang !== 'string' || !LANGUAGE_RE.test(lang)))
        return 'a code language Markdown cannot show';
      if (typeof lang === 'string' && lang.toLowerCase() === 'lk-block') return 'code marked lk-block';
      return null;
    }
    case 'rule':
      return null;
    case 'bulletList':
    case 'orderedList':
      if (kind === 'orderedList' && b.start !== undefined) {
        if (!Number.isInteger(b.start) || (b.start as number) < 0 || (b.start as number) > MAX_LIST_START)
          return 'a list start Markdown cannot show';
      }
      if (kids!.length === 0) return 'an empty list';
      if (!kids!.every((c) => isObj(c) && c.kind === 'listItem' && Array.isArray(c.children)))
        return 'a list holding something other than list items';
      return null;
    case 'listItem':
      return parentKind === 'bulletList' || parentKind === 'orderedList'
        ? null
        : 'a list item outside a list';
    case 'taskList':
      if (kids!.length === 0) return 'an empty task list';
      for (const c of kids!) {
        if (!isObj(c) || c.kind !== 'taskItem') return 'a task list holding something other than tasks';
        if (typeof c.checked !== 'boolean') return 'a task without a checked state';
        const r = normalizeRuns(c.content);
        if ('reason' in r) return r.reason;
      }
      return null;
    case 'taskItem':
      return parentKind === 'taskList' ? null : 'a task outside a task list';
    case 'table':
      return tableReason(kids!);
    case 'tableRow':
      return parentKind === 'table' ? null : 'a table row outside a table';
    case 'tableCell':
      return parentKind === 'tableRow' ? null : 'a table cell outside a table';
    case 'image':
      if (typeof b.url !== 'string' || hasBadText(b.url)) return 'an image URL Markdown cannot show';
      if (b.alt !== undefined && (typeof b.alt !== 'string' || hasBadText(b.alt)))
        return 'image alt text Markdown cannot show';
      return null;
    default:
      return `a block of kind "${kind}"`;
  }
}

function tableReason(rows: unknown[]): string | null {
  if (rows.length === 0) return 'an empty table';
  let width = -1;
  for (const r of rows) {
    if (!isObj(r) || r.kind !== 'tableRow' || !Array.isArray(r.children))
      return 'a table holding something other than rows';
    if (width === -1) width = r.children.length;
    if (r.children.length !== width || width === 0) return 'rows of different lengths';
    for (const c of r.children) {
      if (!isObj(c) || c.kind !== 'tableCell' || !Array.isArray(c.children))
        return 'a row holding something other than cells';
      if ((c.colspan !== undefined && c.colspan !== 1) || (c.rowspan !== undefined && c.rowspan !== 1))
        return 'merged cells';
      const kids = c.children as unknown[];
      if (kids.length > 1) return 'a cell holding several blocks';
      if (kids.length === 1) {
        const p = kids[0];
        if (!isObj(p) || p.kind !== 'paragraph')
          return 'a cell holding something other than one line of text';
        const n = normalizeRuns(p.content);
        if ('reason' in n) return n.reason;
        // GFM reads `\|` in a cell as an escaped pipe even inside code, so code cannot end a backslash before a pipe.
        if (n.runs.some((r) => r.t === 'text' && r.marks.code && /\\\|/.test(r.text)))
          return CODE_PIPE_REASON;
      }
    }
  }
  return null;
}

export const CODE_PIPE_REASON = 'inline code with a backslash before "|" in a table cell';

interface AnalyseState {
  n: number;
  /** How many blocks of the page carry each id. */
  readonly ids: ReadonlyMap<string, number>;
}

/** How many blocks of a tree carry each id (a legacy page can repeat one). */
export function blockIdCounts(blocks: readonly unknown[]): Map<string, number> {
  const ids = new Map<string, number>();
  const walk = (list: readonly unknown[], depth: number) => {
    if (depth > 200) return;
    for (const b of list) {
      if (!isObj(b)) continue;
      if (typeof b.id === 'string') ids.set(b.id, (ids.get(b.id) ?? 0) + 1);
      if (Array.isArray(b.children)) walk(b.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return ids;
}

/** The id a keep region can be written with: the block's own when it is safe in a marker and unique on the page. */
export function usableKeepId(id: unknown, ids: ReadonlyMap<string, number>): string | null {
  return typeof id === 'string' && SAFE_ID_RE.test(id) && ids.get(id) === 1 ? id : null;
}

/**
 * Analyses a page's blocks. A keep region whose block has no usable id (none, one that cannot be written in a marker,
 * or one the page repeats) is numbered `anon-<n>` in document order.
 */
export function analyse(blocks: readonly unknown[]): ANode[] {
  const st: AnalyseState = { n: 0, ids: blockIdCounts(blocks) };
  return blocks.map((b) => analyseOne(b, 'root', st, 0));
}

function analyseOne(b: unknown, parentKind: string, anon: AnalyseState, row: number): ANode {
  const block = (isObj(b) ? b : { kind: '(invalid)' }) as LkBlock;
  const reason = keepReason(b, parentKind);
  if (reason !== null) {
    const keepId = usableKeepId(block.id, anon.ids) ?? `anon-${++anon.n}`;
    return { block, keep: reason, keepId, parentKind, children: [], row, runs: null };
  }
  let children: ANode[] = [];
  const kids = blockChildren(block);
  if (block.kind === 'table') {
    children = kids!.map((r, i) => analyseOne(r, 'table', anon, i));
  } else if (block.kind === 'tableRow') {
    children = kids!.map((c) => analyseOne(c, 'tableRow', anon, row));
  } else if (block.kind === 'taskList') {
    children = kids!.map((c) => analyseOne(c, 'taskList', anon, 0));
  } else if (CONTAINER_KINDS.has(block.kind) && kids) {
    children = kids.map((c) => analyseOne(c, block.kind, anon, 0));
  }
  let runs: NRun[] | null = null;
  if (block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'taskItem') {
    const n = normalizeRuns(block.content);
    runs = 'runs' in n ? n.runs : [];
  }
  return { block, keep: null, keepId: null, parentKind, children, row, runs };
}

/** The node's own projection (without children): exactly the fields its Markdown shows, normalised. */
export function ownProjection(n: ANode): LkBlock {
  if (n.ownProj) return n.ownProj;
  const b = n.block;
  let p: LkBlock;
  switch (b.kind) {
    case 'paragraph':
      p = { kind: 'paragraph', content: toLkRuns(n.runs ?? []) };
      break;
    case 'heading':
      p = { kind: 'heading', level: b.level, content: toLkRuns(n.runs ?? []) };
      break;
    case 'taskItem':
      p = { kind: 'taskItem', checked: b.checked, content: toLkRuns(n.runs ?? []) };
      break;
    case 'callout':
      p = { kind: 'callout', tone: b.tone };
      break;
    case 'expand':
      p = { kind: 'expand', title: b.title };
      break;
    case 'code':
      p = {
        kind: 'code',
        text: b.text,
        ...(typeof b.language === 'string' && b.language !== '' ? { language: b.language } : {}),
      };
      break;
    case 'orderedList':
      p = { kind: 'orderedList', ...(b.start !== undefined && b.start !== 1 ? { start: b.start } : {}) };
      break;
    case 'tableCell':
      p = { kind: 'tableCell', ...(n.row === 0 ? { header: true } : {}) };
      break;
    case 'image':
      p = {
        kind: 'image',
        url: b.url,
        ...(typeof b.alt === 'string' && b.alt !== '' ? { alt: b.alt } : {}),
      };
      break;
    default:
      p = { kind: b.kind };
  }
  n.ownProj = p;
  return p;
}

/** Children of a node as its Markdown shows them: an empty container reads back holding one empty paragraph. */
export function projectedChildren(n: ANode): readonly ANode[] {
  if (n.children.length > 0 || !CONTAINER_KINDS.has(n.block.kind)) return n.children;
  if (n.block.kind === 'table' || n.block.kind === 'tableRow' || n.block.kind === 'taskList')
    return n.children;
  n.emptyKids ??= [
    {
      block: emptyParagraph(),
      keep: null,
      keepId: null,
      parentKind: n.block.kind,
      children: [],
      row: 0,
      runs: [],
    },
  ];
  return n.emptyKids;
}

/** Full projection with children (keep regions as `{ kind: '@keep', id }`), for tests and diagnostics. */
export function fullProjection(n: ANode): LkBlock {
  if (n.keep !== null) return { kind: '@keep', id: n.keepId ?? '' };
  const own = ownProjection(n);
  if (!CONTAINER_KINDS.has(n.block.kind)) return own;
  return { ...own, children: projectedChildren(n).map(fullProjection) };
}

// ------------------------------------------------------------------------------------------------ fingerprints

/** Canonical JSON: object keys sorted, so equal values give equal strings. */
export function canon(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Obj;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(',')}}`;
}

/** Interns structural fingerprints to small integers: equal integers mean equal projected subtrees. */
export class Interner {
  private readonly table = new Map<string, number>();
  private unique = -1;
  id(key: string): number {
    let v = this.table.get(key);
    if (v === undefined) {
      v = this.table.size + 1;
      this.table.set(key, v);
    }
    return v;
  }
  /** A fingerprint equal to nothing else. */
  fresh(): number {
    return this.unique--;
  }
}

/** The fingerprint of an analysed node (memoised on the node). */
export function fingerprint(n: ANode, interner: Interner): number {
  if (n.fp !== undefined && n.fpBy === interner) return n.fp;
  let fp: number;
  if (n.keep !== null) fp = interner.id(`K:${n.keepId}`);
  else {
    const kids = CONTAINER_KINDS.has(n.block.kind)
      ? projectedChildren(n).map((c) => fingerprint(c, interner))
      : [];
    fp = interner.id(`${canon(ownProjection(n))}:${kids.join(',')}`);
  }
  n.fp = fp;
  n.fpBy = interner;
  return fp;
}

/** Deep equality of JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ao = a as Obj;
  const bo = b as Obj;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => k in bo && jsonEqual(ao[k], bo[k]));
}
