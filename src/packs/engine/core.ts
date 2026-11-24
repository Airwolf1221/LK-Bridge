/**
 * v3 F7.1 (ADR 0072): the Character Core rule, in one place.
 *
 * Character Architecture: "a character with an index and several owners has a Character Core". This module answers the
 * two questions every planner that changes a character's set has to ask:
 *
 * 1. **Is a Core needed?** (`coreNeed`, `ownersInIndex`): used by the package planner (planPackage's extend mode:
 *    arkona_add_character_art, arkona_create_owner's character pages, arkona_create_character with target, a
 *    relationship) and by the split planner (`core.needed`, CR-2026-11-R3 R3-66), so the two cannot drift apart.
 *    An **owner page** is a page of the character's set: in the tree, a `[BSRC]` or `[BWRK]` page directly under the
 *    character's index (never an index, never an Archived page); in a package, a page whose role rule holds facts (any
 *    role but the index: the registry's `facts: 'none'`) placed under the character's index (a relationship hosted
 *    under the other participant, or a Working draft placed flat under [INDEX] Working, is not this index's owner).
 * 2. **What does the upgrade change in the page's text?** (`planCoreText`): the compact-identity phrasings replaced
 *    deterministically, on the upgraded page and on the character's Art page; every image the Art page also holds
 *    removed from the Core, and every image it lacks moved there (never dropped); any other sentence still saying
 *    "compact" listed for the owner, never edited.
 *
 * Everything here is pure: the planners read the pages live and the job applies the change inside its lock
 * (`applyCoreText`, the `pack.core_text` filler), touching only the blocks the plan named.
 */
import { textChanges, type TextChange } from '../../jobs/text-change.js';
import type { LkBlock } from '../../markdown/index.js';
import { blockText, sectionsOf, textKey } from './text.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ============================================================================================ is a Core needed?

/** The tree kinds an owner page has (a page, current or Working; never an index or an Archived page). */
export const OWNER_PAGE_KINDS: ReadonlySet<string> = new Set(['bsrc', 'bwrk']);

/** A package role that makes an owner page: every role whose rule holds facts (the index's rule holds none). */
export const isOwnerRole = (rule: { readonly facts: string }): boolean => rule.facts !== 'none';

/**
 * The owner pages directly under a character's index besides its identity page (and besides `leaving`: a split's source
 * to be retired). Counted from the repository tree.
 */
export function ownersInIndex(
  children: readonly { readonly id: string; readonly kind: string }[],
  identityId: string,
  leaving: ReadonlySet<string> = new Set(),
): number {
  return children.filter((c) => OWNER_PAGE_KINDS.has(c.kind) && c.id !== identityId && !leaving.has(c.id))
    .length;
}

export interface CoreNeed {
  /** Whether the character, after the change, has an index and two or more owner pages under a Compact Reference. */
  readonly needed: boolean;
  /** Its owner pages after the change: the identity page, the others it keeps, and the new ones. */
  readonly owners: number;
}

/**
 * The rule: the identity page is a Compact Character Reference (`role === from`), the character has an index after the
 * change (one now, or one the change makes), and it has two or more owner pages then (its identity page, the others it
 * keeps under the index, and the new ones placed there).
 */
export function coreNeed(a: {
  readonly role: string;
  /** The role a Core is upgraded from (the hook's `upgrade.from`: `compact`), or null when the type has no upgrade. */
  readonly from: string | null;
  readonly hasIndex: boolean;
  /** Owner pages under the index besides the identity page (`ownersInIndex`). */
  readonly existing: number;
  /** New owner pages the change places under the index. */
  readonly added: number;
}): CoreNeed {
  const owners = 1 + a.existing + a.added;
  const indexAfter = a.hasIndex || a.added > 0;
  return { needed: a.from !== null && a.role === a.from && indexAfter && owners >= 2, owners };
}

// ============================================================================================ the wording

/** One phrase replaced in one block (for the preview, the proposal and the job's record). */
export interface Replacement {
  readonly blockId: string;
  /** The whole text run before and after (what the job's record and the fix's staleness check compare). */
  readonly before: string;
  readonly after: string;
}

/** A sentence still saying "compact" after the replacements: listed for the owner, never edited. */
export interface CompactLeft {
  readonly page: string;
  readonly blockId: string;
  readonly sentence: string;
}

/**
 * A phrase a rule matched but did not replace, because the bridge cannot tell it means the page itself (amendment 1 to
 * ADR 0072 decisions 3 and 5b): listed for the owner, never edited.
 */
export interface WordingSkipped {
  readonly blockId: string;
  readonly phrase: string;
  readonly sentence: string;
  readonly why: string;
}

/** Which page's rules: the upgraded page's own, or the Art page's (which also says "her character reference"). */
export type WordingRole = 'core' | 'art';

/**
 * Who the page is about, for the self-reference test (amendment 1 to ADR 0072): its Subject (the first name, used for
 * the old page name) and any other name it goes by (its Canonical Display Name); and, when the caller knows them, the
 * names of the project's other characters (a sentence naming one of them is never edited).
 */
export interface WordingNames {
  readonly names?: readonly string[];
  readonly others?: readonly string[];
}

/** The replacement keeps an all-capitals phrase in capitals; otherwise the Core's proper name, "Character Core". */
const keepCase = (found: string, to: string): string =>
  /[a-z]/i.test(found) && found === found.toUpperCase() ? to.toUpperCase() : to;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const norm = (s: string) =>
  s.normalize('NFKC').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** A phrase rule: what it matches and what it becomes; `kind` says which self-reference test it must pass. */
interface Rule {
  readonly re: RegExp;
  readonly to: (m: RegExpExecArray) => string;
  /** `compact`: one of the compact phrasings; `purpose`: the Purpose opener's form; `name`: the page's old name; `art`: "character reference" on the Art page. */
  readonly kind: 'compact' | 'purpose' | 'name' | 'art';
}

/**
 * The phrase rules, in order (the longest first). Deterministic: a phrase is replaced, the rest of the run is kept.
 *
 * - "Compact Main CANON reference" (any case; Main optional; CANON or AU) → "Main CANON Character Core";
 * - "Compact Character Reference", "compact character reference", "compact reference" → "Character Core";
 * - the page's old name "<Name> - Character Reference" → "<Name> - Character Core";
 * - on the Art page only, "character reference" (not followed by "images", "sheet", "art", "pages" or "folder").
 *
 * Whether a match is replaced is the self-reference test's (`selfReference`), never the pattern's alone.
 */
function rulesFor(role: WordingRole, subject: string): Rule[] {
  const rules: Rule[] = [
    {
      re: /\bcompact\s+(main\s+)?(canon|au)\s+reference\b/gi,
      to: (m) => keepCase(m[0], `${m[1] ? `${m[1].trim()} ` : ''}${m[2]!} Character Core`),
      kind: 'purpose',
    },
    {
      re: /\bcompact\s+character\s+reference\b/gi,
      to: (m) => keepCase(m[0], 'Character Core'),
      kind: 'compact',
    },
    { re: /\bcompact\s+reference\b/gi, to: (m) => keepCase(m[0], 'Character Core'), kind: 'compact' },
  ];
  if (subject.trim() !== '')
    rules.push({
      re: new RegExp(`\\b${escape(subject.trim())}\\s+-\\s+Character\\s+Reference\\b`, 'gi'),
      to: () => `${subject.trim()} - Character Core`,
      kind: 'name',
    });
  if (role === 'art')
    rules.push({
      re: /\bcharacter\s+reference\b(?!\s+(?:images?|sheets?|art|pages?|folders?)\b)/gi,
      to: (m) => keepCase(m[0], 'Character Core'),
      kind: 'art',
    });
  return rules;
}

/** The names the page goes by (the subject first), and the words they are made of (for "Akari's"). */
function nameSet(subject: string, ctx: WordingNames | undefined): { full: string[]; tokens: Set<string> } {
  const full = [...new Set([subject, ...(ctx?.names ?? [])].map((n) => n.trim()).filter((n) => n !== ''))];
  const tokens = new Set<string>();
  for (const n of full)
    for (const t of n.split(/[\s]+/)) if (t.replace(/[^\p{L}]/gu, '').length >= 3) tokens.add(norm(t));
  return { full, tokens };
}

/** A word of a name that names on its own: capitalised, three letters or more ("Akari", "Taraji"; not "of", "the"). */
export const nameWord = (t: string): boolean => /^\p{Lu}/u.test(t) && t.replace(/[^\p{L}]/gu, '').length >= 3;

/** Words that may stand before "'s" without naming anyone (the sentence's own words, the page's kind). */
const NOT_A_NAME = new Set([
  'it',
  'that',
  'what',
  'there',
  'here',
  'he',
  'she',
  'who',
  'let',
  'this',
  'one',
  'everyone',
  'someone',
]);

/**
 * Whether a span of a block's text names or mentions someone other than the page's character: a mention of any page
 * but the character's own, a possessive of a capitalised word that is not the character's name ("Taraji's"), or one of
 * the project's other characters by name. When in doubt it says yes: a phrase it cannot clear is listed, never edited.
 */
function namesAnother(
  text: string,
  mentions: readonly { start: number; end: number; label: string }[],
  names: { full: string[]; tokens: Set<string> },
  others: readonly string[],
  span: { start: number; end: number },
): string | null {
  const own = new Set(names.full.map(norm));
  for (const m of mentions)
    if (m.end > span.start && m.start < span.end && !own.has(norm(m.label)))
      return `the sentence links to another page (“${m.label || 'a mention'}”)`;
  const part = text.slice(span.start, span.end);
  for (const m of part.matchAll(/(\p{Lu}[\p{L}\p{M}-]*)['’]s\b/gu)) {
    const w = norm(m[1]!);
    if (NOT_A_NAME.has(w) || names.tokens.has(w)) continue;
    return `the sentence names someone else (“${m[0]}”)`;
  }
  for (const o of others) {
    const on = o.trim();
    if (on === '' || own.has(norm(on))) continue;
    // The full name, and each capitalised word of it (a given name, a family name: never "the" of "Kumi the Elder").
    const words = [on, ...on.split(/\s+/).filter(nameWord)];
    for (const w of words) {
      if (names.tokens.has(norm(w))) continue;
      if (new RegExp(`(^|[^\\p{L}])${escape(w)}(?![\\p{L}])`, 'u').test(part))
        return `the sentence names another character (“${w}”)`;
    }
  }
  return null;
}

/** The sentence of `text` around [start, end): from the end of the sentence before to the end of its own. */
function sentenceAt(text: string, start: number, end: number): { start: number; end: number } {
  let s = 0;
  for (const m of text.slice(0, start).matchAll(/[.!?]["”’)]?\s+/g)) s = m.index + m[0].length;
  const rest = /[.!?]["”’)]?(?=\s|$)/.exec(text.slice(end));
  const e = rest ? end + rest.index + rest[0].length : text.length;
  return { start: s, end: e };
}

/**
 * The self-reference test (amendment 1 to ADR 0072, decisions 3 and 5b): a phrase is replaced only when it refers to
 * the page itself. Otherwise the reason it is left (and listed).
 *
 * - The old page name "<Name> - Character Reference" is the page itself: replaced.
 * - On the Core: a compact phrasing directly after "this" ("This compact character reference owns …"); or the Purpose
 *   opener, a compact phrasing that opens its sentence followed by "for <the page's Subject or Canonical Display
 *   Name>" ("Compact Main CANON reference for Emine al-Noor …").
 * - On the Art page (at least as strict): a phrase directly after the character's own possessive ("Emine's character
 *   reference"), or after "her", "his", "their" or "its" when the whole block names nobody else.
 * - Never when its sentence names or mentions anyone else (another character, a mention of another page).
 */
function selfReference(
  rule: Rule,
  role: WordingRole,
  text: string,
  at: { start: number; end: number },
  mentions: readonly { start: number; end: number; label: string }[],
  names: { full: string[]; tokens: Set<string> },
  others: readonly string[],
  /** The block is the page's Purpose paragraph (the first paragraph under Purpose, or before any heading). */
  purpose: boolean,
): string | null {
  if (rule.kind === 'name') return null;
  const sentence = sentenceAt(text, at.start, at.end);
  const before = text.slice(sentence.start, at.start);
  const after = text.slice(at.end, sentence.end);
  const other = namesAnother(text, mentions, names, others, sentence);
  if (role === 'core') {
    const isThis = /(^|[^\p{L}])this\s+$/iu.test(before);
    const opener =
      purpose &&
      /^[\s"“'‘(]*(the\s+)?$/iu.test(before) &&
      names.full.some((n) => new RegExp(`^\\s+for\\s+${escape(n)}(?![\\p{L}])`, 'iu').test(after));
    if (!isThis && !opener)
      return 'it does not say “this”, and it is not the Purpose paragraph’s opener naming this page’s character: it may mean another page';
    return other;
  }
  // The Art page.
  const possessive = names.full
    .concat([...names.tokens])
    .some((n) => new RegExp(`(^|[^\\p{L}])${escape(n)}['’]s\\s+$`, 'iu').test(before));
  const pronoun = /(^|[^\p{L}])(her|his|their|its)\s+$/iu.test(before);
  if (!possessive && !pronoun)
    return 'it is not the character’s own (“<Name>’s”, or “her”, “his”, “their”, “its”): it may mean another page';
  if (other) return other;
  if (!possessive && pronoun) {
    const whole = namesAnother(text, mentions, names, others, { start: 0, end: text.length });
    if (whole)
      return `“her”, “his”, “their” or “its” may mean someone else: ${whole.replace(/^the sentence/, 'the paragraph')}`;
  }
  return null;
}

/** A block's runs as one text: each run's span (a mention's is its label), for the sentence around a phrase. */
function runSpans(content: readonly unknown[]): {
  text: string;
  spans: ({ start: number; end: number } | null)[];
  mentions: { start: number; end: number; label: string }[];
} {
  let text = '';
  const spans: ({ start: number; end: number } | null)[] = [];
  const mentions: { start: number; end: number; label: string }[] = [];
  for (const r of content) {
    if (!isObj(r)) {
      spans.push(null);
      continue;
    }
    if (isObj(r.mention)) {
      const m = r.mention;
      const label = typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
      const start = text.length;
      text += label;
      mentions.push({ start, end: text.length, label });
      spans.push(null);
      continue;
    }
    if (typeof r.text === 'string') {
      const start = text.length;
      text += r.text;
      spans.push({ start, end: text.length });
      continue;
    }
    if (r.break === true) text += ' ';
    spans.push(null);
  }
  return { text, spans, mentions };
}

/**
 * One block's own runs with the rules applied, each match only where the self-reference test passes; every match that
 * fails it is recorded in `skipped`. Mentions are never edited; a phrase is never matched across runs.
 */
function rewordRuns(
  content: readonly unknown[],
  role: WordingRole,
  subject: string,
  ctx: WordingNames | undefined,
  top: string,
  out: Replacement[],
  skipped: WordingSkipped[],
  purpose: boolean,
): unknown[] | null {
  const names = nameSet(subject, ctx);
  const others = ctx?.others ?? [];
  let runs = [...content];
  const original = content.map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : null));
  let changed = false;
  for (const rule of rulesFor(role, subject)) {
    const { text, spans, mentions } = runSpans(runs);
    runs = runs.map((r, i) => {
      const span = spans[i];
      if (!span || !isObj(r) || typeof r.text !== 'string' || isObj(r.mention)) return r;
      const own = r.text;
      rule.re.lastIndex = 0;
      let next = '';
      let last = 0;
      for (let m = rule.re.exec(own); m !== null; m = rule.re.exec(own)) {
        const at = { start: span.start + m.index, end: span.start + m.index + m[0].length };
        const why = selfReference(rule, role, text, at, mentions, names, others, purpose);
        if (why !== null) {
          const s = sentenceAt(text, at.start, at.end);
          if (
            !skipped.some(
              (x) =>
                x.blockId === top && x.phrase === m[0] && x.sentence === text.slice(s.start, s.end).trim(),
            )
          )
            skipped.push({
              blockId: top,
              phrase: m[0],
              sentence: text.slice(s.start, s.end).trim().slice(0, 500),
              why,
            });
          continue;
        }
        next += own.slice(last, m.index) + rule.to(m);
        last = m.index + m[0].length;
      }
      if (last === 0) return r;
      changed = true;
      return { ...r, text: next + own.slice(last) };
    });
  }
  if (!changed) return null;
  runs.forEach((r, i) => {
    const was = original[i];
    if (isObj(r) && typeof r.text === 'string' && was !== null && was !== undefined && r.text !== was)
      out.push({ blockId: top, before: was, after: r.text });
  });
  return runs;
}

/** One run's text with the rules applied, as a block of that one run (a test and preview convenience). */
export function rewordText(text: string, role: WordingRole, subject: string, ctx?: WordingNames): string {
  const r = rewordRuns([{ text }], role, subject, ctx, '', [], [], false);
  const first = r?.[0];
  return isObj(first) && typeof first.text === 'string' ? first.text : text;
}

/** The blocks whose runs change, by top-level block id: each changed run as a replacement. Never `unsupported`. */
function rewordBlock(
  b: Obj,
  role: WordingRole,
  subject: string,
  ctx: WordingNames | undefined,
  top: string,
  out: Replacement[],
  skipped: WordingSkipped[],
  purpose = false,
): Obj {
  if (b.kind === 'unsupported') return b;
  let changed = false;
  const next: Obj = { ...b };
  if (Array.isArray(b.content)) {
    const content = rewordRuns(b.content as unknown[], role, subject, ctx, top, out, skipped, purpose);
    if (content) {
      next.content = content;
      changed = true;
    }
  }
  if (Array.isArray(b.children)) {
    let kidChanged = false;
    const kids = (b.children as unknown[]).map((c) => {
      if (!isObj(c)) return c;
      const n = rewordBlock(c, role, subject, ctx, top, out, skipped);
      if (n !== c) kidChanged = true;
      return n;
    });
    if (kidChanged) {
      next.children = kids;
      changed = true;
    }
  }
  return changed ? next : b;
}

/**
 * The page's Purpose paragraph, whose opener may describe the page itself: the first paragraph with text under a
 * "Purpose" heading, or, on a page whose text starts before any heading, its first paragraph. Null when there is none.
 */
function purposeParagraph(blocks: readonly LkBlock[]): string | null {
  let inPurpose = true;
  let seenHeading = false;
  for (const b of blocks) {
    const o = b as unknown as Obj;
    if (o.kind === 'heading') {
      inPurpose = /^\s*purpose\s*$/i.test(blockText(o));
      seenHeading = true;
      continue;
    }
    if (o.kind !== 'paragraph' || blockText(o).trim() === '') continue;
    if (inPurpose || !seenHeading) return typeof o.id === 'string' ? o.id : null;
  }
  return null;
}

/**
 * The rules applied to `blocks` (only the top-level blocks in `only` when given): the new blocks, every replacement,
 * and every phrase a rule matched but the self-reference test left (`skipped`, for the owner). The same function plans
 * (on the page read live) and applies inside the job's lock (on the page as it is then, with the same names).
 */
export function reword(
  blocks: readonly LkBlock[],
  role: WordingRole,
  subject: string,
  only?: ReadonlySet<string>,
  ctx?: WordingNames,
): { blocks: LkBlock[]; replacements: Replacement[]; skipped: WordingSkipped[] } {
  const replacements: Replacement[] = [];
  const skipped: WordingSkipped[] = [];
  const purpose = purposeParagraph(blocks);
  const out = blocks.map((b) => {
    const o = b as unknown as Obj;
    const id = typeof o.id === 'string' ? o.id : '';
    if (only && !only.has(id)) return b;
    return rewordBlock(
      o,
      role,
      subject,
      ctx,
      id,
      replacements,
      skipped,
      id !== '' && id === purpose,
    ) as unknown as LkBlock;
  });
  return { blocks: out, replacements, skipped };
}

/**
 * For the owner: every sentence still saying "compact" (`compactSentences`) and every phrase the self-reference test
 * left (`skipped`), one entry per sentence.
 */
export function wordingLeft(
  after: readonly LkBlock[],
  skipped: readonly WordingSkipped[],
  page: string,
): CompactLeft[] {
  const out = compactSentences(after, page);
  for (const s of skipped)
    if (!out.some((x) => x.blockId === s.blockId && x.sentence === s.sentence))
      out.push({ page, blockId: s.blockId, sentence: s.sentence });
  return out;
}

/** Every top-level block's own text, nested text included. */
function deepText(b: Obj): string {
  const own = blockText(b);
  const kids = Array.isArray(b.children) ? (b.children as unknown[]).filter(isObj).map(deepText) : [];
  return [own, ...kids].filter((x) => x !== '').join(' ');
}

/** The sentences of `blocks` that still say "compact" (the owner's to judge; never edited). */
export function compactSentences(blocks: readonly LkBlock[], page: string): CompactLeft[] {
  const out: CompactLeft[] = [];
  for (const b of blocks) {
    const o = b as unknown as Obj;
    if (o.kind === 'unsupported') continue;
    const text = deepText(o);
    if (!/\bcompact\b/i.test(text)) continue;
    for (const s of text.split(/(?<=[.!?])\s+/))
      if (/\bcompact\b/i.test(s))
        out.push({ page, blockId: typeof o.id === 'string' ? o.id : '', sentence: s.trim().slice(0, 500) });
  }
  return out;
}

// ============================================================================================ the images

/** The URL's path: the same file on `assets` and `assets2` matches (as the asset reference index does). */
export function urlKey(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Every image URL anywhere in `blocks` (nested ones too), by its path. */
export function imageKeys(blocks: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (xs: readonly unknown[]) => {
    for (const x of xs) {
      if (!isObj(x)) continue;
      if (x.kind === 'image' && typeof x.url === 'string' && x.url !== '') out.add(urlKey(x.url));
      if (Array.isArray(x.children)) walk(x.children);
    }
  };
  walk(blocks);
  return out;
}

/** An image the upgrade takes off the Core: already on the Art page, or moved there first. */
export interface CoreImage {
  readonly blockId: string;
  readonly url: string;
  /** The section of the Core it was in (its heading's text; "" before the first heading). */
  readonly section: string;
  readonly onArt: boolean;
}

export interface CoreImagePlan {
  readonly remove: readonly CoreImage[];
  /** For the images the Art page lacks: per image its label (level 3), a copy of the image and its interpretation. */
  readonly append: readonly LkBlock[];
  /** The Core's sections that held a removed image, and the text left in them (for the overlap warning). */
  readonly sections: readonly { readonly title: string; readonly paragraphs: number }[];
}

/**
 * The Core's top-level image blocks against the Art page's images: each image the Art page holds is removed from the
 * Core; each it lacks is copied to the Art page (its label, the image, and the paragraphs that follow it up to the next
 * image or heading as its interpretation) and then removed from the Core. Only the image block leaves the Core: its
 * prose stays, for the owner to trim. `mint` gives the copies new block ids.
 */
export function planCoreImages(
  core: readonly LkBlock[],
  artKeys: ReadonlySet<string>,
  subject: string,
  mint: () => string,
): CoreImagePlan {
  const remove: CoreImage[] = [];
  const append: LkBlock[] = [];
  const touched = new Map<string, number>();
  let section = '';
  const seen = new Set<string>();
  for (let i = 0; i < core.length; i++) {
    const b = core[i] as unknown as Obj;
    if (b.kind === 'heading') {
      section = blockText(b);
      continue;
    }
    if (b.kind !== 'image' || typeof b.url !== 'string' || b.url === '' || typeof b.id !== 'string') continue;
    const key = urlKey(b.url);
    const onArt = artKeys.has(key) || seen.has(key);
    if (!onArt) {
      seen.add(key);
      const label =
        (typeof b.alt === 'string' && b.alt.trim()) ||
        (typeof b.title === 'string' && b.title.trim() && b.title.trim() !== 'Image' ? b.title.trim() : '') ||
        `${subject} - From the Character Core`;
      append.push({
        id: mint(),
        kind: 'heading',
        level: 3,
        content: [{ text: label }],
      });
      const { id: _id, ...rest } = b;
      void _id;
      append.push({ ...rest, id: mint() } as unknown as LkBlock);
      for (let j = i + 1; j < core.length; j++) {
        const n = core[j] as unknown as Obj;
        if (n.kind === 'heading' || n.kind === 'image') break;
        if (n.kind !== 'paragraph') continue;
        append.push({ ...(JSON.parse(JSON.stringify(n)) as Obj), id: mint() } as unknown as LkBlock);
      }
    }
    remove.push({ blockId: b.id, url: b.url, section, onArt: artKeys.has(key) });
    touched.set(section, 0);
  }
  for (const s of sectionsOf(core)) {
    const key = s.heading ? s.title : '';
    if (!touched.has(key)) continue;
    touched.set(
      key,
      s.blocks.filter((x) => (x as unknown as Obj).kind === 'paragraph' && blockText(x).trim() !== '').length,
    );
  }
  return {
    remove,
    append,
    sections: [...touched.entries()].map(([title, paragraphs]) => ({ title, paragraphs })),
  };
}

// ============================================================================================ inside the job's lock

/** The filler that applies the upgrade's text change inside a job's lock (registered by the pack engine). */
export const CORE_TEXT_FILLER = 'pack.core_text';

/** The `pack.core_text` filler's input: what the plan named, re-applied to the page as it is when the job runs. */
export interface CoreTextInput {
  readonly role: WordingRole;
  readonly subject: string;
  /** Amendment 1 to ADR 0072: the names the self-reference test used when planning (the same ones apply). */
  readonly names?: readonly string[];
  readonly others?: readonly string[];
  /** The top-level blocks whose wording the plan changes. */
  readonly reword: readonly string[];
  /**
   * Amendment 1 to ADR 0072: the replacements the owner was shown, per block. A block whose replacements inside the
   * lock are not exactly these is left as it is (`held`): the filler never writes words the proposal did not show.
   */
  readonly expect?: readonly { readonly blockId: string; readonly before: string; readonly after: string }[];
  /** The image blocks removed (each only while it still shows the same file). */
  readonly remove: readonly { readonly blockId: string; readonly url: string }[];
  /** With planned blocks (the moved images): the Art page's images section and its boundary sections. */
  readonly section?: string;
  readonly boundaries?: readonly string[];
}

/**
 * The change applied to the document as it is now: the wording rules on the named blocks, the named image blocks
 * removed while they still show the planned file. (Appending the moved images is the Art filler's, run by the caller.)
 * Nothing else is touched, so every `unsupported` block stays where it is.
 */
export function applyCoreText(
  current: readonly LkBlock[],
  input: CoreTextInput,
): { blocks: LkBlock[]; replaced: number; removed: number; held: number } {
  const r = reword(current, input.role, input.subject, new Set(input.reword), {
    ...(input.names ? { names: input.names } : {}),
    ...(input.others ? { others: input.others } : {}),
  });
  let held = 0;
  let replaced = r.replacements.length;
  let reworded = r.blocks;
  if (input.expect) {
    const key = (xs: readonly { before: string; after: string }[]) =>
      xs
        .map((x) => `${x.before}\u0000${x.after}`)
        .sort()
        .join('\u0001');
    const ids = new Set([...input.reword]);
    const hold = new Set<string>();
    for (const id of ids) {
      const want = input.expect.filter((x) => x.blockId === id);
      const got = r.replacements.filter((x) => x.blockId === id);
      if (key(want) !== key(got)) hold.add(id);
    }
    if (hold.size > 0) {
      held = hold.size;
      replaced = r.replacements.filter((x) => !hold.has(x.blockId)).length;
      reworded = r.blocks.map((b, i) => {
        const id = (b as unknown as Obj).id;
        return typeof id === 'string' && hold.has(id) ? current[i]! : b;
      });
    }
  }
  const drop = new Map(input.remove.map((x) => [x.blockId, urlKey(x.url)]));
  let removed = 0;
  const blocks = reworded.filter((b) => {
    const o = b as unknown as Obj;
    const want = typeof o.id === 'string' ? drop.get(o.id) : undefined;
    if (want === undefined || o.kind !== 'image' || typeof o.url !== 'string' || urlKey(o.url) !== want)
      return true;
    removed++;
    return false;
  });
  return { blocks, replaced, removed, held };
}

/** For the overlap warning: the text a Core keeps in a section whose images left it. */
export function visualTextWarning(
  page: string,
  sections: CoreImagePlan['sections'],
): { code: string; message: string; page: string; section: string }[] {
  return sections
    .filter((s) => s.paragraphs > 0)
    .map((s) => ({
      code: 'UPGRADE_OVERLAP',
      message: `${page}: its section “${s.title || '(before the first heading)'}” held images that are now only on the Art page; its ${s.paragraphs} paragraph${s.paragraphs === 1 ? '' : 's'} of visual text stay${s.paragraphs === 1 ? 's' : ''} in the Core. Trim it from the Core afterwards (write_page), as a follow-up: the Art page owns the visual references.`,
      page,
      section: s.title,
    }));
}

/** The upgrade's text change, in words (the preview, the proposal and the step's label). */
export function coreTextWords(c: {
  readonly replacements: readonly Replacement[];
  readonly append: readonly unknown[];
  readonly remove: readonly unknown[];
  readonly section: string;
}): string {
  const parts: string[] = [];
  if (c.replacements.length)
    parts.push(
      `${c.replacements.length} phrase${c.replacements.length === 1 ? '' : 's'} calling the identity page compact now say${c.replacements.length === 1 ? 's' : ''} Character Core`,
    );
  const images = c.append.filter((b) => isObj(b) && b.kind === 'image').length;
  if (images)
    parts.push(
      `${c.section}: +${images} image(s) moved from the Character Core, each with its interpretation`,
    );
  if (c.remove.length)
    parts.push(`${c.remove.length} image block(s) removed (each on the Art page; no prose removed)`);
  return parts.join('; ') || 'no change';
}

/**
 * Amendment 1 to ADR 0072: an upgrade's (or the audit fix's) wording change as the owner reads it: per replacement, the
 * sentence before and after with the replaced words marked (src/jobs/text-change.ts).
 */
export function coreTextChanges(c: {
  readonly page: { readonly id: string; readonly rawName?: string; readonly name?: string };
  readonly replacements: readonly Replacement[];
}): TextChange[] {
  const page = c.page.rawName ?? c.page.name ?? c.page.id;
  return textChanges(
    c.replacements.map((r) => ({
      page,
      pageId: c.page.id,
      blockId: r.blockId,
      what: 'wording',
      before: r.before,
      after: r.after,
    })),
  );
}

/** textKey, re-exported for callers matching section names. */
export { textKey };
