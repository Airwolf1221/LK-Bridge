/**
 * v3 F3d (renames), ADR 0058 (the owner-approved design docs/design/F3d-renames.md): the text of a rename, pure.
 *
 * - **A name in text**: the exact characters of the name, never touching a letter, a digit or a hyphen on either side
 *   (a possessive "’s" after it is allowed): "Nadira al-Khalid’s archive" names her, "Nadira al-Khalidi" does not.
 * - **D1 (a)**: whether an occurrence starts UNTICKED, and why: inside quotation marks; after "formerly", "previously",
 *   "once called" or "originally" in the same sentence; under an Unresolved Material heading.
 * - **A block's fingerprint**: its runs with every occurrence of the old or the new name replaced by one marker, so the
 *   check inside the lock accepts a block that differs from the plan only by this rename's own edits (a resumed job, a
 *   re-proposal of what was left out), and refuses any other change.
 * - **Edits**: the n-th occurrence of the name in a block's text runs, or the n-th mention whose custom label holds it,
 *   applied to the block as it is when the job runs (an occurrence already renamed is left as it is).
 */
import { createHash } from 'node:crypto';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name as a pattern (global): the exact characters, not touching a letter, a digit or a hyphen. */
export function namePattern(...names: string[]): RegExp {
  const alts = [...new Set(names.filter((n) => n.trim() !== ''))]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}'’\\-])(?:${alts})(?![\\p{L}\\p{N}\\-])`, 'gu');
}

/** Each occurrence of a name in a text. */
export function occurrences(text: string, name: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(namePattern(name))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** The text with every occurrence of `from` replaced by `to` (whole names only). */
export function replaceName(text: string, from: string, to: string): string {
  return text.replace(namePattern(from), to);
}

/** Whether a text names `name`. */
export function names(text: string, name: string): boolean {
  return occurrences(text, name).length > 0;
}

// ============================================================================================ D1 (a)

const FORMER = /(?<![\p{L}])(formerly|previously|once called|originally)(?![\p{L}])/giu;

/** Where the sentence holding `at` begins (after the last ". ", "! " or "? " before it, or the text's start). */
export function sentenceStart(text: string, at: number): number {
  let start = 0;
  for (const m of text.slice(0, at).matchAll(/[.!?](?:["”’)\]]*)\s+/g)) start = m.index + m[0].length;
  return start;
}

/** The sentence holding [start, end), for the owner (at most 300 characters around it). */
export function sentenceAround(text: string, start: number, end: number): string {
  const from = sentenceStart(text, start);
  const rest = text.slice(end);
  const stop = rest.search(/[.!?](?:["”’)\]]*)(?:\s|$)/);
  const to = stop < 0 ? text.length : end + stop + 1;
  const s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** Whether `at` is inside quotation marks (“…”, «…», "…", or ‘…’ used as quotes rather than an apostrophe). */
export function insideQuotes(text: string, at: number): boolean {
  const before = text.slice(0, at);
  const count = (re: RegExp) => (before.match(re) ?? []).length;
  if (count(/[“«]/g) - count(/[”»]/g) > 0) return true;
  if (count(/"/g) % 2 === 1) return true;
  // A ’ followed by a letter is an apostrophe (“Khalid’s”), not a closing quote.
  const closes = (before.match(/’(?![\p{L}])/gu) ?? []).length;
  return count(/‘/g) - closes > 0;
}

/**
 * D1 (a): why an occurrence starts unticked, or null when it starts ticked (on a current page). `section` is the path of
 * headings above it; `unresolved` the pack's Unresolved Material heading.
 */
export function d1Why(
  text: string,
  start: number,
  section: readonly string[],
  unresolved: string,
): string | null {
  if (insideQuotes(text, start)) return 'it is inside quotation marks';
  const sentence = text.slice(sentenceStart(text, start), start);
  const said = [...sentence.matchAll(FORMER)].at(-1);
  if (said) return `it follows “${said[1]!.toLowerCase()}” in the same sentence`;
  const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (section.some((h) => key(h) === key(unresolved))) return `it is under ${unresolved}`;
  return null;
}

// ============================================================================================ blocks

/** The runs of a text block (a paragraph, a heading, a list item's paragraph), or null when it holds none. */
export function runsOf(block: unknown): Obj[] | null {
  if (!isObj(block) || !Array.isArray(block.content)) return null;
  return (block.content as unknown[]).filter(isObj);
}

/** The plain text of a block's text runs (mentions left out), as the occurrences are counted. */
export function textOf(block: unknown): string {
  return (runsOf(block) ?? []).map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
}

/** Every block in a tree with its heading path (the headings above it at any level), in document order. */
export function walkBlocks(blocks: readonly unknown[]): {
  readonly block: Obj;
  readonly section: readonly string[];
  readonly parentKind: string | null;
  /** Inside a table (a row's cell): the rename does not edit it (it is reported for a hand edit). */
  readonly inTable: boolean;
}[] {
  const out: { block: Obj; section: string[]; parentKind: string | null; inTable: boolean }[] = [];
  const heads: { level: number; text: string }[] = [];
  const walk = (list: readonly unknown[], parentKind: string | null, depth: number, inTable: boolean) => {
    if (depth > 30) return;
    for (const b of list) {
      if (!isObj(b)) continue;
      if (b.kind === 'heading' && depth === 0) {
        const level = typeof b.level === 'number' ? b.level : 1;
        while (heads.length > 0 && heads.at(-1)!.level >= level) heads.pop();
        out.push({ block: b, section: heads.map((h) => h.text), parentKind, inTable });
        heads.push({ level, text: plainText(b) });
        continue;
      }
      out.push({ block: b, section: heads.map((h) => h.text), parentKind, inTable });
      if (Array.isArray(b.children))
        walk(
          b.children as unknown[],
          typeof b.kind === 'string' ? b.kind : null,
          depth + 1,
          inTable || (typeof b.kind === 'string' && /^table/i.test(b.kind)),
        );
    }
  };
  walk(blocks, null, 0, false);
  return out;
}

/** Every string of text under a block (its runs, its cells, its code), for finding a name the rename does not edit. */
export function deepText(block: unknown, depth = 0): string {
  if (depth > 40 || !isObj(block)) return '';
  const parts: string[] = [];
  if (typeof block.text === 'string') parts.push(block.text);
  for (const r of runsOf(block) ?? []) {
    if (typeof r.text === 'string') parts.push(r.text);
    const label = customLabel(r);
    if (label !== null) parts.push(label);
  }
  if (Array.isArray(block.children)) for (const c of block.children) parts.push(deepText(c, depth + 1));
  return parts.join(' ');
}

/** A block's visible text: its text runs and its mentions' labels. */
export function plainText(block: unknown): string {
  return (runsOf(block) ?? [])
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : isObj(r.mention)
          ? typeof r.mention.text === 'string'
            ? r.mention.text
            : typeof r.mention.name === 'string'
              ? r.mention.name
              : ''
          : '',
    )
    .join('');
}

/** A mention run's custom label (null for a plain mention, which shows the page's own name). */
export function customLabel(run: Obj): string | null {
  const m = run.mention;
  if (!isObj(m)) return null;
  return typeof m.text === 'string' && m.text.trim() !== '' ? m.text : null;
}

const MARK = '\u0000N\u0000';
const VOLATILE = new Set(['version', 'updatedAt', 'createdAt']);

/**
 * A block's fingerprint: the block with every occurrence of the old or the new name (in its text runs and its mentions'
 * custom labels) replaced by one marker, and its volatile fields left out. Equal fingerprints: the block differs from
 * the plan only by this rename's own edits.
 */
export function fingerprint(block: unknown, oldName: string, newName: string): string {
  const re = namePattern(oldName, newName);
  const norm = (v: unknown, depth = 0): unknown => {
    if (depth > 40) return null;
    if (typeof v === 'string') return v.replace(re, MARK);
    if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1));
    if (!isObj(v)) return v;
    const out: Obj = {};
    for (const k of Object.keys(v).sort()) {
      if (VOLATILE.has(k)) continue;
      // A mention's `name` is the page's current name (read-only): a renamed page shows its new one.
      if (k === 'name' && depth > 0) continue;
      out[k] = norm(v[k], depth + 1);
    }
    return out;
  };
  return createHash('sha256')
    .update(JSON.stringify(norm(block)))
    .digest('hex')
    .slice(0, 32);
}

/** One edit of a block: the n-th occurrence of the name in its text runs, or the n-th mention whose label holds it. */
export interface BlockEdit {
  readonly kind: 'text' | 'mention';
  /** 0-based, counted over the old OR the new name (so an occurrence already renamed keeps its number). */
  readonly ordinal: number;
}

/**
 * The occurrences of the old or the new name in a block, as edits number them: each text run's in order, and each
 * mention with a custom label holding one. Occurrences across two runs (formatting in the middle of the name) are not
 * found (the planner reports them).
 */
export function blockOccurrences(
  block: unknown,
  oldName: string,
  newName: string,
): {
  readonly text: {
    readonly run: number;
    readonly start: number;
    readonly end: number;
    readonly isOld: boolean;
  }[];
  readonly mentions: { readonly run: number; readonly isOld: boolean; readonly label: string }[];
} {
  const text: { run: number; start: number; end: number; isOld: boolean }[] = [];
  const mentions: { run: number; isOld: boolean; label: string }[] = [];
  const re = namePattern(oldName, newName);
  const runs = runsOf(block) ?? [];
  runs.forEach((r, i) => {
    if (typeof r.text === 'string') {
      for (const m of r.text.matchAll(re))
        text.push({ run: i, start: m.index, end: m.index + m[0].length, isOld: m[0] === oldName });
    }
    const label = customLabel(r);
    if (label !== null) {
      const hits = [...label.matchAll(re)];
      if (hits.length > 0) mentions.push({ run: i, isOld: hits.some((h) => h[0] === oldName), label });
    }
  });
  return { text, mentions };
}

/**
 * The block with `edits` applied (each occurrence that still shows the old name now shows the new one), or null when an
 * edit's occurrence is not there (the block is not as planned).
 */
export function applyEdits(
  block: Obj,
  edits: readonly BlockEdit[],
  oldName: string,
  newName: string,
): Obj | null {
  const found = blockOccurrences(block, oldName, newName);
  const runs = (runsOf(block) ?? []).map((r) => ({ ...r }));
  const textByRun = new Map<number, { start: number; end: number }[]>();
  for (const e of edits) {
    if (e.kind === 'text') {
      const o = found.text[e.ordinal];
      if (!o) return null;
      if (!o.isOld) continue;
      textByRun.set(o.run, [...(textByRun.get(o.run) ?? []), { start: o.start, end: o.end }]);
    } else {
      const o = found.mentions[e.ordinal];
      if (!o) return null;
      if (!o.isOld) continue;
      const r = runs[o.run]!;
      r.mention = { ...(r.mention as Obj), text: replaceName(o.label, oldName, newName) };
    }
  }
  for (const [i, spans] of textByRun) {
    const r = runs[i]!;
    let t = String(r.text);
    for (const sp of [...spans].sort((a, b) => b.start - a.start))
      t = `${t.slice(0, sp.start)}${newName}${t.slice(sp.end)}`;
    r.text = t;
  }
  return { ...block, content: runs };
}

/** A block anywhere in a tree, by id. */
export function findBlock(blocks: readonly unknown[], id: string, depth = 0): Obj | null {
  if (depth > 40) return null;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.id === id) return b;
    if (Array.isArray(b.children)) {
      const hit = findBlock(b.children as unknown[], id, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** A block without the fields a write may not send back (its version). */
export function writable(block: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(block)) if (!VOLATILE.has(k)) out[k] = v;
  return out;
}

// ============================================================================================ rebasing (ADR 0058, A)

/** One planned text edit of a block, with what it rests on: its item and the sentence it is in (with the old name). */
export interface PlannedEdit extends BlockEdit {
  readonly item: string;
  /** The sentence around the occurrence, as planned (with the old name). */
  readonly sentence: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The text occurrences of the old or the new name in a block, each with the sentence around it (as `sentenceAround`
 * gives it over the block's text runs), numbered as `blockOccurrences` numbers them.
 */
export function occurrencesWithSentences(
  block: unknown,
  oldName: string,
  newName: string,
): { readonly ordinal: number; readonly isOld: boolean; readonly sentence: string }[] {
  const found = blockOccurrences(block, oldName, newName);
  const runs = runsOf(block) ?? [];
  const starts: number[] = [];
  let offset = 0;
  for (const r of runs) {
    starts.push(offset);
    if (typeof r.text === 'string') offset += r.text.length;
  }
  const text = textOf(block);
  return found.text.map((o, k) => {
    const start = starts[o.run]! + o.start;
    return {
      ordinal: k,
      isOld: o.isOld,
      sentence: norm(sentenceAround(text, start, start + (o.end - o.start))),
    };
  });
}

/**
 * ADR 0058 amendment (A): a block's planned edits re-applied to the block as it is NOW. Rebasing never widens an edit:
 *
 * - the block differs from the plan only by this rename's own edits (equal fingerprints): each edit keeps its number;
 * - otherwise each edit is found again by its SENTENCE: exactly one occurrence of the old name in the same sentence is
 *   the one meant (its number now); none, and the sentence already shows the new name, it is done; none at all, the text
 *   changed meanwhile (skipped, with a before and after excerpt); more than one, which is meant cannot be told (skipped).
 *
 * Returns the edits to apply now (numbered in the block as it is), the items done already and the items skipped.
 */
export function rebaseEdits(
  block: Obj | null,
  plan: {
    readonly fingerprint: string;
    readonly edits: readonly PlannedEdit[];
    readonly oldName: string;
    readonly newName: string;
    readonly where?: string;
  },
): {
  readonly edits: BlockEdit[];
  readonly items: string[];
  readonly done: string[];
  readonly skipped: { item: string; reason: string; before: string; after: string | null; where?: string }[];
} {
  const { oldName, newName } = plan;
  const where = plan.where !== undefined ? { where: plan.where } : {};
  const now = block ? norm(plainText(block)) : null;
  const short = (s: string | null) => (s === null ? null : s.length > 300 ? `${s.slice(0, 299)}…` : s);
  if (!block)
    return {
      edits: [],
      items: [],
      done: [],
      skipped: plan.edits.map((e) => ({
        item: e.item,
        reason: 'changed meanwhile: the paragraph is gone',
        before: e.sentence,
        after: null,
        ...where,
      })),
    };
  if (fingerprint(block, oldName, newName) === plan.fingerprint) {
    const found = blockOccurrences(block, oldName, newName);
    const edits: BlockEdit[] = [];
    const items: string[] = [];
    const done: string[] = [];
    for (const e of plan.edits) {
      // A proposal made before the amendment may hold a mention label's edit: kept as it was planned.
      const o = e.kind === 'mention' ? found.mentions[e.ordinal] : found.text[e.ordinal];
      if (o && !o.isOld) done.push(e.item);
      else {
        edits.push({ kind: e.kind, ordinal: e.ordinal });
        items.push(e.item);
      }
    }
    return { edits, items, done, skipped: [] };
  }
  const occ = occurrencesWithSentences(block, oldName, newName);
  const edits: BlockEdit[] = [];
  const items: string[] = [];
  const done: string[] = [];
  const skipped: { item: string; reason: string; before: string; after: string | null; where?: string }[] =
    [];
  const taken = new Set<number>();
  for (const e of plan.edits) {
    const kept = (e as { sentence?: unknown }).sentence;
    if (e.kind !== 'text' || typeof kept !== 'string') {
      // An edit planned before the amendment (a mention label, or no sentence kept): it cannot be found again.
      skipped.push({
        item: e.item,
        reason: 'changed meanwhile',
        before: typeof kept === 'string' ? kept : '',
        after: short(now),
        ...where,
      });
      continue;
    }
    const want = norm(e.sentence);
    const renamed = norm(replaceName(e.sentence, oldName, newName));
    const olds = occ.filter((o) => o.isOld && o.sentence === want);
    if (olds.length === 1 && !taken.has(olds[0]!.ordinal)) {
      taken.add(olds[0]!.ordinal);
      edits.push({ kind: 'text', ordinal: olds[0]!.ordinal });
      items.push(e.item);
    } else if (olds.length > 1) {
      skipped.push({
        item: e.item,
        reason: 'the sentence now appears more than once, so which occurrence is meant cannot be told',
        before: e.sentence,
        after: short(now),
        ...where,
      });
    } else if (occ.some((o) => !o.isOld && o.sentence === renamed)) {
      done.push(e.item);
    } else {
      skipped.push({
        item: e.item,
        reason: 'changed meanwhile',
        before: e.sentence,
        after: short(now),
        ...where,
      });
    }
  }
  return { edits, items, done, skipped };
}

/** A block's text runs with the old name renamed (mentions, and their custom labels, kept as they are). */
export function renameTextRuns(block: Obj, oldName: string, newName: string, depth = 0): Obj {
  if (depth > 40) return block;
  const out: Obj = {};
  for (const [k, v] of Object.entries(block)) {
    if (VOLATILE.has(k)) continue;
    if (k === 'text' && typeof v === 'string') out[k] = replaceName(v, oldName, newName);
    else if (k === 'mention') out[k] = v;
    else if (Array.isArray(v))
      out[k] = (v as unknown[]).map((x) => (isObj(x) ? renameTextRuns(x, oldName, newName, depth + 1) : x));
    else if (isObj(v)) out[k] = renameTextRuns(v, oldName, newName, depth + 1);
    else out[k] = v;
  }
  return out;
}
