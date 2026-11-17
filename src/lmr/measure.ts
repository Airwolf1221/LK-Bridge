/**
 * v3 F3c (ADR 0051 decision 1): what counts as a major revision. The owner's rule of 16 November 2026 ("Tiny edits like
 * this aren't enough for a major revision"), replacing F2's "substantial" test. Pure functions: the planner (src/lmr/)
 * measures an edit when the calling tool has read the page's old state, and the `bridge.lmr` step measures it when the
 * job runs otherwise (from the journal's pre-images). The rule, exactly as the owner approves it, is in ADR 0051.
 *
 * Counts:
 * - page text: added, removed or rewritten paragraphs, list items, headings and table rows, where the changed text in the
 *   whole edit is at least 8 words; a heading's wording changing always counts;
 * - sidebar facts: a change to any fact other than the housekeeping keys, except the minor cases;
 * - Dependencies: adding or removing one (Related Sources alone does not count);
 * - a chronology row: a change to its date or description cell (adding or removing a row changes both).
 *
 * Does not count (the minor cases): trimming a value to a prefix of itself, or removing a descriptive tail or a
 * parenthetical; changes only to punctuation, dashes, whitespace or capitalisation; typo fixes (at most 2 characters
 * changed per word, in at most 3 words; a word with a digit in it that changes is never a typo); a KCY-only change in a
 * chronology row; tags, resource aliases, the page name or a move.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The threshold of the page-text rule: the changed text in the whole edit is at least this many words. */
export const MAJOR_WORDS = 8;
/** The typo rule: at most this many characters changed per word … */
export const TYPO_CHARS = 2;
/** … in at most this many words. */
export const TYPO_WORDS = 3;

export interface LmrVerdict {
  /** True: a major revision (the row is set); false: not one (it is left). */
  readonly major: boolean;
  /** In words, for the proposal and the answer: `12 words of page text changed`, `a trimmed value`. */
  readonly reason: string;
}

// ============================================================================================ text of runs and words

/** The text of a run list (LegendKeeper's `content`): text runs and mentions' labels. */
export function runsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((r) => {
      if (!isObj(r)) return '';
      if (typeof r.text === 'string') return r.text;
      if (typeof r.name === 'string') return r.name;
      // v3 F3c: a mention is the text it shows (its label), so a link dropped from words that stay is no rewording.
      if (isObj(r.mention)) {
        const m = r.mention;
        return typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
      }
      return '';
    })
    .join('');
}

const DASHES = /[‐-―−﹘﹣－-]/g;

/**
 * A text with punctuation, dashes, whitespace and capitalisation taken out of the comparison: what is left are the words
 * (letters and digits, in order; an apostrophe inside a word keeps it one word: “envoy’s”). Two texts with the same
 * `wordsOf` differ only in those.
 */
export function wordsOf(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-GB')
    .replace(/(?<=[\p{L}\p{N}])['\u2019](?=[\p{L}\p{N}])/gu, '')
    .replace(DASHES, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

const hasDigit = (w: string) => /\p{N}/u.test(w);

/** Levenshtein distance, stopping early once it exceeds `max` (then max + 1). */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The longest common subsequence's length of two word lists. */
function lcs(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return prev[b.length]!;
}

/** Words changed between two texts: the larger of the words added and the words removed (a word replaced is one). */
export function wordsChanged(before: string, after: string): number {
  const a = wordsOf(before);
  const b = wordsOf(after);
  const common = lcs(a, b);
  return Math.max(a.length - common, b.length - common);
}

/**
 * A typo fix: the same number of words, at most 3 of them different, each by at most 2 characters, and none of the
 * changed words holding a digit (a changed number or date is a real change, never a typo).
 */
export function isTypoFix(before: string, after: string): boolean {
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (a.length !== b.length || a.length === 0) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    changed++;
    if (changed > TYPO_WORDS) return false;
    if (hasDigit(a[i]!) || hasDigit(b[i]!)) return false;
    if (distance(a[i]!, b[i]!, TYPO_CHARS) > TYPO_CHARS) return false;
  }
  return changed > 0;
}

const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
/** Separators that begin a descriptive tail: a dash, a colon, a semicolon or a comma. */
const TAIL = /\s*(?:[–—−]|\s-\s|--|[:;,])\s*/g;
const PARENS = /\s*(?:\([^()]*\)|\[[^[\]]*\])\s*/g;

/**
 * A value trimmed: the new value is a prefix of the old one (at a word's end), or the old one with a descriptive tail
 * (after a dash, colon, semicolon or comma) or one or more parentheticals removed. An emptied value is a removal, not a
 * trim.
 */
export function isTrim(before: string, after: string): boolean {
  const b = squash(before);
  const a = squash(after);
  if (a === '' || a === b || a.length >= b.length) return false;
  const bare = (s: string) => s.replace(/[\s\p{P}\p{S}]+$/u, '');
  // A prefix of itself, ending where a word ends.
  if (b.startsWith(bare(a)) && bare(a) !== '') {
    const next = b.slice(bare(a).length, bare(a).length + 1);
    if (next === '' || !/[\p{L}\p{N}]/u.test(next)) return true;
  }
  // The parentheticals removed.
  const unbracketed = squash(b.replace(PARENS, ' '));
  if (unbracketed !== b && wordsOf(unbracketed).join(' ') === wordsOf(a).join(' ')) return true;
  // A descriptive tail removed (after any of its separators), with or without the parentheticals.
  for (const m of [...b.matchAll(TAIL)]) {
    const head = b.slice(0, m.index);
    if (wordsOf(head).join(' ') === wordsOf(a).join(' ')) return true;
    if (wordsOf(squash(head.replace(PARENS, ' '))).join(' ') === wordsOf(a).join(' ')) return true;
  }
  return false;
}

export type ValueChange = 'same' | 'punctuation' | 'trim' | 'typo' | 'real';

/** How a value (a fact, a table cell) changed, by the rule's minor cases. */
export function valueChange(before: string, after: string): ValueChange {
  if (squash(before) === squash(after)) return 'same';
  if (wordsOf(before).join(' ') === wordsOf(after).join(' ')) return 'punctuation';
  if (isTrim(before, after)) return 'trim';
  if (isTypoFix(before, after)) return 'typo';
  return 'real';
}

export const MINOR_REASON: Readonly<Record<Exclude<ValueChange, 'real'>, string>> = {
  same: 'nothing changed',
  punctuation: 'only punctuation, dashes, whitespace or capitalisation changed',
  trim: 'a trimmed value',
  typo: 'a typo fix',
};

// ============================================================================================ page text

export interface TextUnit {
  readonly kind: 'paragraph' | 'heading' | 'listItem' | 'tableRow';
  readonly text: string;
}

/**
 * The page text of a block tree, as the rule counts it: each paragraph, heading, list item and table row is one unit.
 * A list item's text is its own paragraphs (a nested list's items are units of their own); a table row's text is its
 * cells, joined. Containers (quotes, callouts, expands, layouts) are looked into; blocks with no text (images, rules,
 * embeds, `unsupported`) are not text.
 */
export function textUnits(blocks: unknown): TextUnit[] {
  const out: TextUnit[] = [];
  const own = (b: Obj): string => {
    // The text directly in a list item or a cell: its paragraphs and headings, not a nested list.
    const kids = Array.isArray(b.children) ? (b.children as unknown[]) : [];
    return kids
      .filter(isObj)
      .filter((k) => k.kind !== 'bulletList' && k.kind !== 'orderedList' && k.kind !== 'taskList')
      .map((k) => (k.content !== undefined ? runsText(k.content) : own(k)))
      .filter((t) => t !== '')
      .join(' ');
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 64) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    const kind = typeof v.kind === 'string' ? v.kind : '';
    if (kind === 'tableRow') {
      const cells = (Array.isArray(v.children) ? (v.children as unknown[]) : []).filter(isObj).map(own);
      out.push({ kind: 'tableRow', text: cells.join(' | ') });
      return;
    }
    if (kind === 'listItem' || kind === 'taskItem') {
      out.push({ kind: 'listItem', text: own(v) });
      for (const k of Array.isArray(v.children) ? (v.children as unknown[]) : [])
        if (isObj(k) && (k.kind === 'bulletList' || k.kind === 'orderedList' || k.kind === 'taskList'))
          walk(k, depth + 1);
      return;
    }
    if (kind === 'heading') {
      out.push({ kind: 'heading', text: runsText(v.content) });
      return;
    }
    if (v.content !== undefined && kind !== 'unsupported') {
      const t = runsText(v.content);
      if (t !== '') out.push({ kind: 'paragraph', text: t });
    } else if (kind === 'code' && typeof v.text === 'string' && v.text !== '') {
      out.push({ kind: 'paragraph', text: v.text });
    }
    if (Array.isArray(v.children)) walk(v.children, depth + 1);
  };
  walk(blocks, 0);
  return out;
}

const unitKey = (u: TextUnit) => `${u.kind}\u0000${squash(u.text)}`;

/** The pairs of an LCS alignment of two unit lists (indexes into each). */
function alignUnits(a: readonly TextUnit[], b: readonly TextUnit[]): [number, number][] {
  const ka = a.map(unitKey);
  const kb = b.map(unitKey);
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i]![j] = ka[i] === kb[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

export interface TextMeasure extends LmrVerdict {
  /** The words the rule counted. */
  readonly words: number;
}

/**
 * The page-text rule over a whole edit: units unchanged are matched (in order); between them, units of the same kind are
 * paired as rewrites in order and the rest are added or removed. A rewrite that is only punctuation, dashes, whitespace
 * or capitalisation, or a typo fix, counts 0 words; any other rewrite counts the larger of the words it adds and removes;
 * an added or removed unit counts its words. A heading added, removed or reworded (beyond those minor cases) always
 * counts.
 */
export function measureText(before: readonly TextUnit[], after: readonly TextUnit[]): TextMeasure {
  const anchors = alignUnits(before, after);
  let words = 0;
  let heading: string | null = null;
  let typos = 0;
  let punctuation = 0;
  const gaps: { b: TextUnit[]; a: TextUnit[] }[] = [];
  let pi = 0;
  let pj = 0;
  for (const [i, j] of [...anchors, [before.length, after.length] as [number, number]]) {
    gaps.push({ b: before.slice(pi, i), a: after.slice(pj, j) });
    pi = i + 1;
    pj = j + 1;
  }
  for (const g of gaps) {
    const removed = [...g.b];
    const added = [...g.a];
    // Rewrites: the same kind, in order.
    for (const kind of ['paragraph', 'heading', 'listItem', 'tableRow'] as const) {
      const rb = removed.filter((u) => u.kind === kind);
      const ra = added.filter((u) => u.kind === kind);
      const n = Math.min(rb.length, ra.length);
      for (let k = 0; k < n; k++) {
        const ob = rb[k]!;
        const oa = ra[k]!;
        removed.splice(removed.indexOf(ob), 1);
        added.splice(added.indexOf(oa), 1);
        if (wordsOf(ob.text).join(' ') === wordsOf(oa.text).join(' ')) {
          punctuation++;
          continue;
        }
        if (isTypoFix(ob.text, oa.text)) {
          typos++;
          continue;
        }
        if (kind === 'heading') heading ??= `a heading changed (“${clip(ob.text)}” → “${clip(oa.text)}”)`;
        words += wordsChanged(ob.text, oa.text);
      }
    }
    for (const u of removed) {
      if (u.kind === 'heading') heading ??= `a heading removed (“${clip(u.text)}”)`;
      words += wordsOf(u.text).length;
    }
    for (const u of added) {
      if (u.kind === 'heading') heading ??= `a heading added (“${clip(u.text)}”)`;
      words += wordsOf(u.text).length;
    }
  }
  const counted = `${words} word${words === 1 ? '' : 's'} of page text changed`;
  if (heading !== null) return { major: true, words, reason: heading };
  if (words >= MAJOR_WORDS) return { major: true, words, reason: counted };
  if (words > 0) return { major: false, words, reason: `${counted} (fewer than ${MAJOR_WORDS})` };
  if (typos > 0) return { major: false, words, reason: 'a typo fix' };
  if (punctuation > 0) return { major: false, words, reason: MINOR_REASON.punctuation };
  return { major: false, words, reason: 'no page text changed' };
}

const clip = (s: string) => {
  const t = squash(s);
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};

// ============================================================================================ the evidence of an edit

/** What one write of a request changed, as far as the rule is concerned (on one page). */
export type LmrEvidence =
  /** Page text: the units before and after (from the blocks the write replaces and the blocks it sends). */
  | { readonly kind: 'text'; readonly before: readonly TextUnit[]; readonly after: readonly TextUnit[] }
  /** A sidebar fact (not a housekeeping key): its value before and after (null: absent). */
  | {
      readonly kind: 'fact';
      readonly key: string;
      readonly before: string | null;
      readonly after: string | null;
    }
  /** A link collection: how many links were added and removed. */
  | { readonly kind: 'links'; readonly title: string; readonly added: number; readonly removed: number }
  /** A chronology table row: its cells before and after (null: added or removed). */
  | {
      readonly kind: 'chronologyRow';
      readonly before: ChronologyCells | null;
      readonly after: ChronologyCells | null;
    }
  /** The Main table's count of a chronology age (a number: never a major revision on its own). */
  | { readonly kind: 'chronologyCount' }
  /** A write the rule cannot see into (its old text is not known): counted, as F2 did. */
  | { readonly kind: 'unknown'; readonly what: string };

export interface ChronologyCells {
  readonly description: string;
  readonly date: string;
  readonly kcy: string;
}

const DEPENDENCIES = 'dependencies';

/** One fact's change by the rule. */
export function measureFact(key: string, before: string | null, after: string | null): LmrVerdict {
  const b = before ?? '';
  const a = after ?? '';
  if (before === null && squash(a) === '') return { major: false, reason: `${key}: an empty fact added` };
  if (before === null) return { major: true, reason: `${key}: a fact added` };
  if (after === null) return { major: true, reason: `${key}: a fact removed` };
  if (squash(b) !== '' && squash(a) === '') return { major: true, reason: `${key}: a fact emptied` };
  const c = valueChange(b, a);
  if (c === 'real') return { major: true, reason: `${key}: a fact changed` };
  return { major: false, reason: `${key}: ${MINOR_REASON[c]}` };
}

/** A chronology row's change by the rule: its date or description cell (the KCY cell alone never counts). */
export function measureChronologyRow(
  before: ChronologyCells | null,
  after: ChronologyCells | null,
): LmrVerdict {
  if (before === null && after !== null) return { major: true, reason: 'a chronology row added' };
  if (after === null && before !== null) return { major: true, reason: 'a chronology row removed' };
  if (!before || !after) return { major: false, reason: 'no chronology row changed' };
  const date = valueChange(before.date, after.date);
  if (date === 'real') return { major: true, reason: 'a chronology row’s date changed' };
  const desc = valueChange(before.description, after.description);
  if (desc === 'real') return { major: true, reason: 'a chronology row’s description changed' };
  const kcy = squash(before.kcy) !== squash(after.kcy);
  const minor = [date, desc].find((c) => c !== 'same');
  if (minor !== undefined) return { major: false, reason: `a chronology row: ${MINOR_REASON[minor]}` };
  return {
    major: false,
    reason: kcy ? 'a KCY-only change in a chronology row' : 'no chronology cell changed',
  };
}

/**
 * The verdict for one page from everything a request does to it. The page text is measured over the whole edit (all
 * its text writes together); facts, Dependencies and chronology rows each count on their own. `unknown` evidence counts.
 */
export function verdictFor(evidence: readonly LmrEvidence[]): LmrVerdict {
  const minors: string[] = [];
  const unknown = evidence.find((e) => e.kind === 'unknown');
  if (unknown) return { major: true, reason: `${unknown.what} (its old text is not known, so it counts)` };
  const before: TextUnit[] = [];
  const after: TextUnit[] = [];
  let text = false;
  for (const e of evidence) {
    if (e.kind === 'text') {
      text = true;
      before.push(...e.before);
      after.push(...e.after);
    }
  }
  if (text) {
    const t = measureText(before, after);
    if (t.major) return t;
    minors.push(t.reason);
  }
  for (const e of evidence) {
    if (e.kind === 'fact') {
      const v = measureFact(e.key, e.before, e.after);
      if (v.major) return v;
      minors.push(v.reason);
    } else if (e.kind === 'links') {
      if (e.title.trim().toLocaleLowerCase('en-GB') === DEPENDENCIES && e.added + e.removed > 0)
        return {
          major: true,
          reason: `Dependencies: ${[e.added ? `${e.added} added` : '', e.removed ? `${e.removed} removed` : ''].filter(Boolean).join(', ')}`,
        };
      minors.push(`${e.title}: links only (not Dependencies)`);
    } else if (e.kind === 'chronologyRow') {
      const v = measureChronologyRow(e.before, e.after);
      if (v.major) return v;
      minors.push(v.reason);
    } else if (e.kind === 'chronologyCount') {
      minors.push('a chronology count');
    }
  }
  return { major: false, reason: minors.length > 0 ? [...new Set(minors)].join('; ') : 'nothing changed' };
}

// ============================================================================================ evidence from writes

/** A block by id anywhere in a tree (null: not there). */
export function findBlock(tree: unknown, id: string, depth = 0): Obj | null {
  if (depth > 64) return null;
  if (Array.isArray(tree)) {
    for (const x of tree) {
      const hit = findBlock(x, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObj(tree)) return null;
  if (tree.id === id) return tree;
  return Array.isArray(tree.children) ? findBlock(tree.children, id, depth + 1) : null;
}

/** The blocks of a document as LegendKeeper answers them (`{ blocks }`), or of a stored pre-image. */
export function blocksOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v as unknown[];
  if (isObj(v) && Array.isArray(v.blocks)) return v.blocks as unknown[];
  return null;
}

/** A single block as a write sends it or a pre-image keeps it (`{ block }` or the block itself). */
export function blockOf(v: unknown): Obj | null {
  if (!isObj(v)) return null;
  if (isObj(v.block)) return v.block;
  return typeof v.kind === 'string' ? v : null;
}

export const TEXT_WRITE_OPS: ReadonlySet<string> = new Set([
  'replaceDocumentBlocks',
  'insertBlock',
  'replaceBlock',
  'updateBlock',
  'deleteBlock',
]);

/**
 * The evidence of one block write, given what the document held before it: the whole document's blocks (`oldDoc`, a
 * read the calling tool made), or the block it replaces or deletes (`oldBlock`, a journal pre-image). `unknown` when the
 * old text cannot be told (a block edit with neither, a row of a key-value block).
 */
export function blockWriteEvidence(
  op: string,
  params: { readonly path?: Record<string, string> | undefined; readonly body?: unknown },
  old: { readonly oldDoc?: unknown; readonly oldBlock?: unknown },
): LmrEvidence {
  const blockId = params.path?.blockId;
  const docBlocks = blocksOf(old.oldDoc);
  const prior = blockOf(old.oldBlock) ?? (docBlocks && blockId ? findBlock(docBlocks, blockId) : null);
  switch (op) {
    case 'replaceDocumentBlocks': {
      const before = docBlocks ?? blocksOf(old.oldBlock);
      const after = blocksOf(params.body);
      if (!before || !after) return { kind: 'unknown', what: 'a whole-document write' };
      return { kind: 'text', before: textUnits(before), after: textUnits(after) };
    }
    case 'insertBlock': {
      const b = blockOf(params.body);
      return b
        ? { kind: 'text', before: [], after: textUnits([b]) }
        : { kind: 'unknown', what: 'a block insert' };
    }
    case 'replaceBlock': {
      const b = blockOf(params.body);
      if (!prior || !b) return { kind: 'unknown', what: 'a block replace' };
      return { kind: 'text', before: textUnits([prior]), after: textUnits([b]) };
    }
    case 'updateBlock': {
      if (!prior || !isObj(params.body)) return { kind: 'unknown', what: 'a block update' };
      return { kind: 'text', before: textUnits([prior]), after: textUnits([{ ...prior, ...params.body }]) };
    }
    case 'deleteBlock':
      if (!prior) return { kind: 'unknown', what: 'a block delete' };
      return { kind: 'text', before: textUnits([prior]), after: [] };
    default:
      return { kind: 'unknown', what: `a ${op}` };
  }
}

/** A sidebar's properties as `listProperties` answers (`{ data }` or `{ properties }`). */
export function propertiesOf(v: unknown): Obj[] {
  if (!isObj(v)) return [];
  const list = Array.isArray(v.data) ? v.data : Array.isArray(v.properties) ? v.properties : [];
  return (list as unknown[]).filter(isObj);
}

/**
 * The evidence of one sidebar write (a fact row, or a link collection's items), given the sidebar the calling tool read
 * before planning it. `unknown` when the row or the property is not in that read.
 */
export function sidebarWriteEvidence(
  op: string,
  params: { readonly path?: Record<string, string> | undefined; readonly body?: unknown },
  sidebar: readonly Obj[],
): LmrEvidence {
  const prop = sidebar.find((p) => p.id === params.path?.propertyId);
  const body = isObj(params.body) ? params.body : {};
  const rows = Array.isArray(prop?.rows) ? (prop.rows as unknown[]).filter(isObj) : [];
  const row = rows.find((r) => r.id === params.path?.rowId);
  const key = (r: Obj | undefined) => (typeof r?.key === 'string' ? r.key : '');
  switch (op) {
    case 'createPropertyRow':
      return {
        kind: 'fact',
        key: typeof body.key === 'string' ? body.key : '',
        before: null,
        after: runsText(body.content),
      };
    case 'updatePropertyRow':
      if (!row) return { kind: 'unknown', what: 'a sidebar row' };
      return {
        kind: 'fact',
        key: typeof body.key === 'string' ? body.key : key(row),
        before: runsText(row.content),
        after:
          body.content === null
            ? ''
            : body.content === undefined
              ? runsText(row.content)
              : runsText(body.content),
      };
    case 'deletePropertyRow':
      if (!row) return { kind: 'unknown', what: 'a sidebar row' };
      return { kind: 'fact', key: key(row), before: runsText(row.content), after: null };
    case 'updateProperty': {
      if (!prop) return { kind: 'unknown', what: 'a link collection' };
      const ref = (i: unknown) =>
        isObj(i)
          ? `${typeof i.resourceId === 'string' ? i.resourceId : ''}/${typeof i.documentId === 'string' ? i.documentId : ''}`
          : '';
      const was = new Set((Array.isArray(prop.items) ? prop.items : []).map(ref));
      const now = new Set((Array.isArray(body.items) ? body.items : []).map(ref));
      return {
        kind: 'links',
        title: typeof prop.title === 'string' ? prop.title : '',
        added: [...now].filter((x) => !was.has(x)).length,
        removed: [...was].filter((x) => !now.has(x)).length,
      };
    }
    default:
      return { kind: 'unknown', what: `a ${op}` };
  }
}

/** Evidence a bridge planner attached to a write's journal operation (`lmr`), when it is well formed. */
export function journalEvidence(journal: unknown): LmrEvidence | null {
  if (!isObj(journal) || !isObj(journal.lmr)) return null;
  const e = journal.lmr;
  const cells = (v: unknown): ChronologyCells | null =>
    isObj(v) && typeof v.description === 'string' && typeof v.date === 'string'
      ? { description: v.description, date: v.date, kcy: typeof v.kcy === 'string' ? v.kcy : '' }
      : null;
  if (e.kind === 'chronologyRow')
    return { kind: 'chronologyRow', before: cells(e.before), after: cells(e.after) };
  if (e.kind === 'chronologyCount') return { kind: 'chronologyCount' };
  return null;
}
