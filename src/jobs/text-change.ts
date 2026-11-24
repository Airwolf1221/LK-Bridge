/**
 * Amendment 1 to ADR 0072 (v3 F7.1a, 24 November 2026): a proposal that changes words never hides them.
 *
 * A **text change** is one edit of a page's words, as the owner reads it: the sentence (or sentences) it touches before
 * and after, and where in each the replaced words are (`removed` in `before`, `added` in `after`), so the proposal's
 * summary, its item view on the Proposals page and the Review page's card can all show the same thing and highlight the
 * words that change. Every automation and audit fix whose plan replaces words gives its changes this way, on its
 * high-level operation (`textChanges`); the proposal service adds them to the summary.
 *
 * Pure: built from the text before and after (a whole run, a block's text or a line), never from LegendKeeper.
 */

/** Where the changed words are, as character offsets into the sentence (end exclusive). */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface TextChange {
  /** The page's name (as the plan knew it). */
  readonly page: string;
  readonly pageId?: string;
  readonly blockId?: string;
  /** What kind of change, in a word or two ("wording", "dash", "heading link", "dateline", "folder path"). */
  readonly what?: string;
  /** The sentence(s) the change touches, before and after ("…" where a long sentence is shortened). */
  readonly before: string;
  readonly after: string;
  /** The replaced words in `before` and the words that replace them in `after`. */
  readonly removed: TextSpan;
  readonly added: TextSpan;
}

/** The longest a sentence is shown; past it, the text around the change is kept and the rest becomes "…". */
const SENTENCE_MAX = 320;
const CONTEXT = 120;

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_'’-]/u.test(c);

/**
 * The change between `before` and `after` as one span in each: the common start and end kept, the middle the change,
 * widened to whole words.
 */
function changedSpans(before: string, after: string): { removed: TextSpan; added: TextSpan } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  // Whole words: move the start back and the end forward while inside a word (in both texts alike).
  while (p > 0 && (isWord(before[p - 1]) || isWord(after[p - 1])) && (isWord(before[p]) || isWord(after[p])))
    p--;
  while (
    s > 0 &&
    (isWord(before[before.length - s]) || isWord(after[after.length - s])) &&
    (isWord(before[before.length - s - 1]) || isWord(after[after.length - s - 1]))
  )
    s--;
  return {
    removed: { start: p, end: before.length - s },
    added: { start: p, end: after.length - s },
  };
}

/** The start of the sentence holding offset `at` (after the last ". " before it), and the end of the one holding `to`. */
function sentenceBounds(text: string, at: number, to: number): TextSpan {
  let start = 0;
  for (const m of text.slice(0, at).matchAll(/[.!?]["”’)]?\s+/g)) start = m.index + m[0].length;
  const rest = /[.!?]["”’)]?(?=\s|$)/.exec(text.slice(to));
  return { start, end: rest ? to + rest.index + rest[0].length : text.length };
}

/** A long sentence shortened around the change; the spans moved with it. */
function shorten(text: string, span: TextSpan, keepStart: number): { text: string; span: TextSpan } {
  if (text.length <= SENTENCE_MAX) return { text, span };
  let from = Math.max(0, Math.min(keepStart, span.start) - CONTEXT);
  let to = Math.min(text.length, span.end + CONTEXT);
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  const lead = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  return {
    text: `${lead}${text.slice(from, to)}${tail}`,
    span: { start: span.start - from + lead.length, end: span.end - from + lead.length },
  };
}

/**
 * One text change from the text before and after (a run, a block's text, a line): the sentence(s) around the change in
 * each, and the changed words marked. Null when nothing changed.
 */
export function textChange(o: {
  readonly page: string;
  readonly pageId?: string;
  readonly blockId?: string;
  readonly what?: string;
  readonly before: string;
  readonly after: string;
}): TextChange | null {
  if (o.before === o.after) return null;
  const { removed, added } = changedSpans(o.before, o.after);
  // The same sentence in both: its start is in the common beginning, its end in the common ending.
  const b = sentenceBounds(o.before, removed.start, removed.end);
  const tailB = o.before.length - b.end;
  const a = { start: b.start, end: Math.max(added.end, o.after.length - tailB) };
  const sb = shorten(
    o.before.slice(b.start, b.end).trimEnd(),
    {
      start: removed.start - b.start,
      end: removed.end - b.start,
    },
    removed.start - b.start,
  );
  const sa = shorten(
    o.after.slice(a.start, a.end).trimEnd(),
    {
      start: added.start - a.start,
      end: added.end - a.start,
    },
    added.start - a.start,
  );
  // Leading spaces are not part of a sentence.
  const lb = sb.text.length - sb.text.trimStart().length;
  const la = sa.text.length - sa.text.trimStart().length;
  const clamp = (x: TextSpan, n: number, len: number): TextSpan => ({
    start: Math.max(0, Math.min(len, x.start - n)),
    end: Math.max(0, Math.min(len, x.end - n)),
  });
  const before = sb.text.trimStart();
  const after = sa.text.trimStart();
  return {
    page: o.page,
    ...(o.pageId ? { pageId: o.pageId } : {}),
    ...(o.blockId ? { blockId: o.blockId } : {}),
    ...(o.what ? { what: o.what } : {}),
    before,
    after,
    removed: clamp(sb.span, lb, before.length),
    added: clamp(sa.span, la, after.length),
  };
}

/** Every text change of the pairs given (nulls dropped). */
export function textChanges(
  list: readonly {
    readonly page: string;
    readonly pageId?: string;
    readonly blockId?: string;
    readonly what?: string;
    readonly before: string;
    readonly after: string;
  }[],
): TextChange[] {
  return list.map(textChange).filter((c): c is TextChange => c !== null);
}

/** The replaced words alone: `“compact character reference” → “Character Core”` (or "added"/"removed"). */
export function replacedWords(c: TextChange): string {
  const was = c.before.slice(c.removed.start, c.removed.end).trim();
  const now = c.after.slice(c.added.start, c.added.end).trim();
  if (was === '' && now === '') return 'spacing';
  if (was === '') return `added “${now}”`;
  if (now === '') return `removed “${was}”`;
  return `“${was}” → “${now}”`;
}

/** In words, for a summary or a note: `“before” → “after” (“was” → “now”)`, the page first when it has one. */
export function textChangeWords(c: TextChange): string {
  const page = c.page ? `${c.page}: ` : '';
  return `${page}“${c.before}” → “${c.after}” (${replacedWords(c)})`;
}

/**
 * The text changes for a proposal's summary, within `budget` characters: each one's sentences shortened to a little
 * context around the change, and a count of the rest ("and 3 more on the proposal").
 */
export function textChangesSummary(changes: readonly TextChange[], budget: number): string {
  if (changes.length === 0 || budget < 40) return '';
  const near = (text: string, span: TextSpan): string => {
    // A short sentence is shown whole; a long one, around the change.
    if (text.length <= 160) return text;
    const from = Math.max(0, span.start - 50);
    const to = Math.min(text.length, span.end + 30);
    let a = from;
    let b = to;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length && isWord(text[b])) b++;
    return `${a > 0 ? '…' : ''}${text.slice(a, b)}${b < text.length ? '…' : ''}`;
  };
  const parts: string[] = [];
  let used = 'Text: '.length;
  for (const [i, c] of changes.entries()) {
    const line = `“${near(c.before, c.removed)}” → “${near(c.after, c.added)}”`;
    const rest = changes.length - i - 1;
    const more = rest > 0 ? `; and ${rest} more on the proposal` : '';
    if (used + line.length + 2 + more.length > budget) {
      const left = changes.length - i;
      parts.push(
        `and ${left}${parts.length === 0 ? ' text change' + (left === 1 ? '' : 's') : ' more'} on the proposal`,
      );
      break;
    }
    parts.push(line);
    used += line.length + 2;
  }
  return `Text: ${parts.join('; ')}`;
}

/** The `textChanges` of a proposal's high-level operations (bridge code sets them; anything malformed is dropped). */
export function textChangesOf(
  operations: readonly Readonly<Record<string, unknown>>[] | undefined,
): TextChange[] {
  const out: TextChange[] = [];
  for (const o of operations ?? []) {
    const list = o.textChanges;
    if (!Array.isArray(list)) continue;
    for (const c of list as unknown[]) if (isTextChange(c)) out.push(c);
  }
  return out;
}

const isSpan = (v: unknown): v is TextSpan =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as TextSpan).start === 'number' &&
  typeof (v as TextSpan).end === 'number';

export function isTextChange(v: unknown): v is TextChange {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.page === 'string' &&
    typeof c.before === 'string' &&
    typeof c.after === 'string' &&
    isSpan(c.removed) &&
    isSpan(c.added)
  );
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A block's own words as the owner reads them, a link shown in square brackets (a mention by its label, a run with a
 * link mark by its text): so a link dropped from a heading shows as `[Tarim]` → `Tarim`.
 */
export function shownText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const r of content) {
    if (!isObj(r)) continue;
    if (isObj(r.mention)) {
      const m = r.mention;
      const label = typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
      s += `[${label}]`;
    } else if (typeof r.text === 'string') s += 'link' in r && r.link !== undefined ? `[${r.text}]` : r.text;
    else if (r.break === true) s += ' ';
  }
  return s;
}

/**
 * The text changes between two versions of a document's blocks, block by block (nested blocks too), matched by id: each
 * block whose words differ gives one change. Blocks only in one version (added or removed) are not words replaced.
 */
export function blocksTextChanges(
  before: readonly unknown[],
  after: readonly unknown[],
  page: { readonly id?: string; readonly name: string },
  what: string,
): TextChange[] {
  const index = (list: readonly unknown[], out = new Map<string, Obj>()): Map<string, Obj> => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (typeof b.id === 'string') out.set(b.id, b);
      if (Array.isArray(b.children)) index(b.children, out);
    }
    return out;
  };
  const was = index(before);
  const out: TextChange[] = [];
  for (const [id, b] of index(after)) {
    const old = was.get(id);
    if (!old) continue;
    const c = textChange({
      page: page.name,
      ...(page.id ? { pageId: page.id } : {}),
      blockId: id,
      what,
      before: shownText(old.content),
      after: shownText(b.content),
    });
    if (c) out.push(c);
  }
  return out;
}
