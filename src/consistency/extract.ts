/**
 * v3 F4b (ADR 0064; design D1, D2): the fact extractor. Pure functions: one page's text units (as the appraisal's
 * full-text index holds them: its name, its sidebar facts by key, each block of text) and the chronology's rows in, the
 * facts the pack's phrasings read out.
 *
 * - **A closed list of facts** (D1): dated life events (birth, death, the bounds of an attested life) from the Temporal
 *   Scope field, a dated "Deceased" Life State, prose and chronology rows; and the identity facts (Race / Species,
 *   Naming Culture, Life State, Personal / Given Name, Family / Surname) as a page's sidebar states them. Nothing that
 *   needs reading comprehension.
 * - **Deliberately narrow** (D2): only the phrasings the pack lists (`rules.consistency.patterns`, pack data); a sentence
 *   is about someone only when it names them: a name, an alias or a Canonical Display Name (in either order), never a
 *   pronoun. A given name alone counts only on that character's own pages (decided where the facts are compared).
 * - **Dates** go through the calendar engine and keep their precision; a date it cannot read is kept as unreadable, with
 *   the reason, and never guessed.
 * - **ADR 0064 amendment 1** (from the first live run): the subject is the name governing the verb in its own clause
 *   (rule A, `resolveName`); the date is the first date-shaped text after the verb, and nothing date-shaped is no fact
 *   (rule B, `scan`); a table row is never read as its joined cells (rule C, `extractRowFacts` reads the chronology's
 *   rows by their columns); an identity value's principal part decides a gap (rule E); facts in sections or rows marked
 *   non-current are marked (F).
 */
import { createHash } from 'node:crypto';
import type { Calendar, DateTextStyle } from '../calendar/index.js';
import { nameKeyOf, subjectPart } from '../packs/naming/namesakes.js';
import { textKey } from '../packs/engine/text.js';
import type { ConsistencyPattern, ConsistencyRules } from '../packs/types.js';
import { readCell, readFirst, readLeading, readRangeParts, readScan, type DateReading } from './dates.js';

export type FactKind = 'birth' | 'death' | 'attested' | 'identity';
export type FactSource = 'temporalScope' | 'lifeState' | 'prose' | 'chronology' | 'sidebar';
/** How a fact's subject was found: the page's own subject, a name (or alias), a given name alone, a row's mention. */
export type MatchedAs = 'page' | 'name' | 'given' | 'mention';

/** One fact read from a page. */
export interface ExtractedFact {
  readonly pageId: string;
  readonly kind: FactKind;
  /** An identity fact's field (`Race / Species`). */
  readonly field: string | null;
  readonly source: FactSource;
  /** The pack phrasing that read it (`birth.scope`), or `identity`. */
  readonly pattern: string;
  /** Who it is about: a name's normalised key, or `page:<id>` for a chronology row's mention. */
  readonly subjectKey: string;
  readonly subjectText: string;
  readonly matchedAs: MatchedAs;
  /** The date (or value) exactly as written; empty for a gap with no text. */
  readonly valueText: string;
  /** A deliberate gap ("birth date unestablished", `Unestablished`). */
  readonly gap: boolean;
  readonly date: DateReading | null;
  /** Why the date could not be read (never guessed). */
  readonly unreadable: string | null;
  /** An attested date's bound (D7): `to` (through: the life is attested up to it), `from`, or `both`. */
  readonly bound: 'from' | 'to' | 'both' | null;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly section: string | null;
  /** The sentence, the field's text, or the row (clipped). */
  readonly excerpt: string;
  readonly mentions: readonly string[];
  /**
   * ADR 0064 amendment 1 (F): read from a section (or a chronology row) marked non-current ("Author-Facing Pre-Rewrite
   * History"): left out unless `include: ["pre-rewrite"]` asks for it, while the pack's switch is on.
   */
  readonly nonCurrent?: true;
  /**
   * CR-2026-11-R4 (the pick's placement): where the value was read, so "Pick the right value" edits it in its place and
   * nowhere else. `sha`: the SHA-1 of the sentence (prose), of the field's `;` clause (Temporal Scope, Life State), of the
   * whole field (an identity fact) or of the row's Historical Event text (a chronology row), as the extractor read it;
   * `at`: the date's offset in that sentence or clause (null: no date there, an identity value or a row).
   */
  readonly place?: FactPlace;
  /**
   * CR-2026-11-R4 (the owner's request L): the life a birth or death belongs to, when the phrasing names it ("First
   * life …", "second life born …", "second-life actual death …"): 1 for the first.
   */
  readonly life?: number;
  /**
   * CR-2026-11-R4 (request L): an attested start that begins a new life: a `return` ("Reborn 4A 300", "born again 4A
   * 300") or a `restoration` ("restored to life … Camue 1st, 5A 1").
   */
  readonly start?: 'return' | 'restoration';
}

/** The pack's ordinal words for lives when it names none (`lifeOrdinals`): "first" is life 1. */
export const DEFAULT_LIFE_ORDINALS: readonly string[] = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

/** A life's ordinal as a phrasing's `life` group gives it ("second", "2nd"): 1-based, or null. */
export function lifeOrdinal(text: string | undefined, ordinals: readonly string[]): number | null {
  const t = (text ?? '').trim().toLocaleLowerCase('en-GB');
  if (t === '') return null;
  const i = ordinals.findIndex((o) => o.trim().toLocaleLowerCase('en-GB') === t);
  if (i >= 0) return i + 1;
  const n = /^(\d{1,3})(?:st|nd|rd|th)?$/u.exec(t);
  return n ? Number(n[1]) : null;
}

/** Where a fact's value was read (see `ExtractedFact.place`). */
export interface FactPlace {
  readonly sha: string;
  readonly at: number | null;
}

/** The SHA-1 a fact's place keeps of its sentence or clause (as the extractor reads it: whitespace collapsed). */
export const placeSha = (text: string): string =>
  createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

/**
 * Whether `len` characters at `i` of `text` stand whole: not inside a longer word or number ("4A 10" inside "4A 100",
 * "2A 73" inside "2A 73,511"). Used to place a date read from a phrasing, and again by the pick before it edits one.
 */
export function standsWhole(text: string, i: number, len: number): boolean {
  if (i < 0 || len <= 0 || i + len > text.length) return false;
  const before = i > 0 ? text[i - 1]! : '';
  const after = text.slice(i + len, i + len + 2);
  if (/[\p{L}\p{N}]/u.test(before)) return false;
  return !/^(?:[\p{L}\p{N}]|[,.]\p{N})/u.test(after);
}

/**
 * The offset of a date read from a phrasing's `date` group in its sentence or clause: the first place at or after the
 * group's start where the date's text stands whole (the reader read the first date-shaped text there, so it is that
 * one). Null when it cannot be found (the pick then never edits it).
 */
export function dateOffset(text: string, from: number, date: string): number | null {
  if (date === '') return null;
  const first = (t: string): number | null => {
    for (let i = t.indexOf(date, Math.max(0, from)); i >= 0; i = t.indexOf(date, i + 1))
      if (standsWhole(t, i, date.length)) return i;
    return null;
  };
  // CR-2026-11-R4 (LD-09): the scan reads no date inside a closed bracketed parenthetical (RC-2), so the same text in
  // brackets before the date read is never its place: outside the brackets first; inside them only when the date
  // occurs nowhere else (a value read whole, as "(Camue 1st, 4A 100)").
  return first(bracketsBlanked(text)) ?? first(text);
}

/** `text` with each closed bracketed parenthetical (nested ones too) blanked to as many spaces: every offset kept. */
function bracketsBlanked(text: string): string {
  let t = text;
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/\([^()]*\)|\[[^[\]]*\]/gu, (m) => ' '.repeat(m.length));
    if (next === t) break;
    t = next;
  }
  return t;
}

/** A page's own subject and continuity, as its sidebar states them. */
export interface PageMeta {
  readonly subject: string | null;
  readonly continuityType: string | null;
  readonly continuity: string | null;
}

/** A unit of the full-text index (src/appraisal/extract.ts). */
export interface Unit {
  readonly unit: string;
  readonly text: string;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly field: string | null;
  readonly section: string | null;
}

/** A chronology row, as the extractor reads it (from the snapshots). */
export interface ChronologyRowInput {
  readonly pageId: string;
  readonly documentId: string;
  readonly rowId: string;
  readonly event: string;
  readonly date: string;
  readonly mentions: readonly string[];
  /**
   * ADR 0064 amendment 1 (rule A): the pages mentioned in the Historical Event cell, with the mention's text. A row is
   * attributed to a mentioned page's character only when the mention's text is the name governing the verb.
   */
  readonly subjects?: readonly { readonly resourceId: string; readonly text: string }[];
}

/** The names the extractor recognises: a name's key → how it names a character (a name, or a given name alone). */
export interface NameIndex {
  lookup(key: string): MatchedAs | null;
}

export interface CompiledPattern {
  readonly p: ConsistencyPattern;
  readonly re: RegExp;
  readonly named: boolean;
}

export interface Compiled {
  readonly rules: ConsistencyRules;
  readonly bySource: Readonly<
    Record<'temporalScope' | 'lifeState' | 'prose' | 'chronology', readonly CompiledPattern[]>
  >;
  /** A pattern whose regular expression does not compile: skipped, and said (a pack data error). */
  readonly problems: readonly string[];
  readonly identity: ReadonlySet<string>;
  readonly unestablished: ReadonlySet<string>;
  /** Rule A's vocabulary: titles (name keys) and the clause words. */
  readonly words: SubjectWords;
  /** F's markers, normalised; null when the pack names none. */
  readonly nonCurrent: readonly string[] | null;
  /** CR-2026-11-R4 (request L): the ordinal words a phrasing's `life` group is read with ("first" is life 1). */
  readonly lifeOrdinals: readonly string[];
}

/** ADR 0064 amendment 1, rule A: what may stand between a clause's start and its subject, and what starts a clause. */
export interface SubjectWords {
  readonly titles: ReadonlySet<string>;
  /**
   * CR-2026-11-R4 (RC-1): the relational particles (name keys: "of", "bint", "ibn", "née"…) that make the name after
   * them someone else's relation, never the subject ("The daughter of Rashad al-Khalid was born").
   */
  readonly relational: ReadonlySet<string>;
  /** Splits a text before a verb into clauses: commas, semicolons, a spaced dash and the clause words (captured). */
  readonly split: RegExp;
  /** Where the text after a verb stops being its clause: a semicolon or a clause word. */
  readonly cut: RegExp;
}

/** Rule A's defaults (the owner's words, 20 November 2026), when the pack names none. */
export const DEFAULT_TITLES: readonly string[] = ['Kaiser', 'Kaiserin'];
export const DEFAULT_CLAUSE_WORDS: readonly string[] = ['after', 'when', 'before', 'until', 'while'];
/**
 * CR-2026-11-R4 (RC-1): the relational particles when the pack names none: a name right after one of them is a
 * relation of the subject (a parent, a spouse, a patronymic), never the subject.
 */
export const DEFAULT_RELATIONAL: readonly string[] = [
  'of',
  'bint',
  'ibn',
  'bin',
  'ben',
  'bat',
  'née',
  'by',
  'with',
  'for',
  'to',
  'from',
  'and',
  'or',
  'nor',
];

/** Words before a name that are neither titles nor names ("the", "their"): read as lower-case words, whatever case. */
const DETERMINERS = new Set([
  'the',
  'a',
  'an',
  'his',
  'her',
  'their',
  'its',
  'our',
  'my',
  'your',
  'this',
  'that',
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function subjectWords(
  titles: readonly string[] = DEFAULT_TITLES,
  clauseWords: readonly string[] = DEFAULT_CLAUSE_WORDS,
  relational: readonly string[] = DEFAULT_RELATIONAL,
): SubjectWords {
  const words = clauseWords
    .map((w) => w.trim())
    .filter((w) => w !== '')
    .map(escapeRe)
    .join('|');
  const wordAlt = words ? `|\\b(?:${words})\\b` : '';
  return {
    titles: new Set(titles.map(nameKeyOf).filter((t) => t !== '')),
    relational: new Set(relational.map(nameKeyOf).filter((t) => t !== '')),
    split: new RegExp(`(,|;|\\s[-–—]\\s${wordAlt})`, 'iu'),
    cut: new RegExp(`;${wordAlt}`, 'iu'),
  };
}

/** A marker or a heading as markers compare: case, and any dashes or spaces between words, ignored. */
const markerKey = (s: string) =>
  s
    .toLocaleLowerCase('en-GB')
    // CR-2026-11-R4 (RC-16): every Unicode dash ("Pre‑Rewrite" with a non-breaking hyphen) is a dash.
    .replace(/[\s\p{Pd}_]+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();

/** A segment's key starts with a marker, as whole words. */
const startsWithMarker = (segment: string, markers: readonly string[]): boolean => {
  const k = markerKey(segment);
  return markers.some((m) => m !== '' && (k === m || k.startsWith(`${m} `)));
};

/**
 * Whether a text (a section's headings, a row) carries one of the non-current markers. CR-2026-11-R4 (RC-16): only as
 * a heading's own qualifier, never anywhere in it: a heading of the path (headings joined by " > ") is marked when it
 * starts with a marker ("Author-Facing Notes") or one of its qualifiers does, after a spaced dash ("Key Life
 * Transitions - Author-Facing Pre-Rewrite History") or in brackets ("History (Pre-Rewrite)"); "Birth and Upbringing
 * (Current Canon, superseding the Pre-Rewrite History)" is current. A row (`row: true`) is marked only by a bracketed
 * provenance note that starts with a marker ("(author-facing pre-rewrite provenance)"), never by a note quoting one
 * ("(date confirmed; the pre-rewrite date is retired)").
 */
export function isNonCurrent(
  text: string | null | undefined,
  markers: readonly string[] | null,
  o: { readonly row?: boolean } = {},
): boolean {
  if (!text || !markers || markers.length === 0) return false;
  if (o.row) return [...text.matchAll(/\(([^()]*)\)/gu)].some((m) => startsWithMarker(m[1]!, markers));
  return text.split(' > ').some((heading) => {
    const qualifiers = heading
      .replace(/\([^()]*\)/gu, ' ')
      .split(/\s\p{Pd}\s|:/u)
      .filter((x) => x.trim() !== '');
    const own = [...heading.matchAll(/\(([^()]*)\)/gu)].map((m) => m[1]!);
    return [...qualifiers, ...own].some((q) => startsWithMarker(q, markers));
  });
}

/** What `{name}` becomes: a short run of words before the verb (resolved against the name index afterwards). */
const NAME_GROUP = String.raw`(?<name>[^.;:!?]{1,160}?)`;
/** A sentence or row worth reading as prose: it holds one of the life-event verbs. */
const VERBS = /\b(?:born|died|dies|killed)\b/iu;

export function compilePatterns(rules: ConsistencyRules): Compiled {
  const bySource = { temporalScope: [], lifeState: [], prose: [], chronology: [] } as Record<
    'temporalScope' | 'lifeState' | 'prose' | 'chronology',
    CompiledPattern[]
  >;
  const problems: string[] = [];
  for (const p of rules.patterns) {
    const named = p.regex.includes('{name}');
    try {
      // `d`: the name group's indices, so a comma the phrasing passes over before the verb is kept (rule A).
      const re = new RegExp(p.regex.replace('{name}', NAME_GROUP), 'iud');
      bySource[p.source].push({ p, re, named });
    } catch (e) {
      problems.push(
        `The pack's phrasing ${p.id} is not a valid pattern (${e instanceof Error ? e.message : String(e)}); it is skipped.`,
      );
    }
  }
  return {
    rules,
    bySource,
    problems,
    identity: new Set(rules.identityFields.map(textKey)),
    unestablished: new Set(rules.unestablished.map(textKey)),
    words: subjectWords(rules.titles, rules.clauseWords, rules.relational),
    nonCurrent: rules.nonCurrent ? rules.nonCurrent.markers.map(markerKey).filter((m) => m !== '') : null,
    lifeOrdinals: rules.lifeOrdinals ?? DEFAULT_LIFE_ORDINALS,
  };
}

/**
 * An identity value's principal part (ADR 0064 amendment 1, rule E): what comes before its first qualifier (`;`, `(`,
 * or a spaced dash). "Rangawan (current); Falkenreicher (historical identity)" → "Rangawan"; "None - adopted Old
 * Shenxian mononym" → "None".
 */
export function principalValue(v: string): string {
  const cut = v.search(/;|\(|\s[-–—]\s/u);
  const p = (cut >= 0 ? v.slice(0, cut) : v).replace(/\s+/g, ' ').trim();
  return p === '' ? v.replace(/\s+/g, ' ').trim() : p;
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A text's sentences (a "c." or "ca." never ends one). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<!\b(?:c|ca|approx|St|Dr|Mr|Mrs|Ms))[.!?]+["”’)]*\s+(?=\S)/u)
    .map(tidy)
    .filter((s) => s !== '');
}

/**
 * CR-2026-11-R4 (the pick's placement): `sentences` with where each stands in `text` (a text whose whitespace is
 * collapsed, as the full-text index keeps it), each found in turn after the one before. Derived from `sentences` itself,
 * so the pick splits a paragraph exactly as the extractor did; a sentence that is not found as written is left out.
 */
export function sentenceSpans(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let from = 0;
  for (const s of sentences(text)) {
    const i = text.indexOf(s, from);
    if (i < 0) continue;
    out.push({ start: i, end: i + s.length, text: s });
    from = i + s.length;
  }
  return out;
}

/**
 * Who governs a verb (ADR 0064 amendment 1, rule A; D2 made precise): the name or alias directly before it in its own
 * clause, with only titles ("Kaiser") and appositives between; never a pronoun, and never a name elsewhere in the
 * sentence. `candidate` is the text of the sentence before the verb.
 *
 * - **Clauses** break at commas, semicolons, a spaced dash and the clause words (after, when, before, until, while).
 * - **The clause right before the verb** ("The imperial dignity passed to Soren after | Tobias von Hohenfalk died"): the
 *   longest run of its last words that is a name ("Their son Murad al-Khalid" → Murad al-Khalid; "After Kaiser Soren von
 *   Woerfels" → Soren von Woerfels). None: nobody (never a name earlier in the sentence).
 * - **A comma right before the verb** ("Their son, Leopold I von Hohenfalk, was born"; "Yasmin al-Naim, daughter of
 *   Karim al-Naim, is born"): the clause before it must be a name on its own (after its titles); otherwise it is an
 *   appositive, passed over only when a comma opens it too. A name inside an appositive is never the subject.
 */
export function resolveName(
  candidate: string,
  names: NameIndex,
  words: SubjectWords = DEFAULT_WORDS,
): { readonly key: string; readonly text: string; readonly as: MatchedAs } | null {
  const c = tidy(candidate);
  if (c === '') return null;
  const tryText = (t: string) => {
    const key = nameKeyOf(t);
    if (key === '') return null;
    const as = names.lookup(key);
    return as ? { key, text: t, as } : null;
  };
  // Clauses, each with what opens it: the sentence's start, a comma, or a clause word (a semicolon, a dash).
  const parts = c.split(words.split);
  const clauses: { text: string; opened: 'start' | 'comma' | 'clause' }[] = [];
  let opened: 'start' | 'comma' | 'clause' = 'start';
  parts.forEach((p, i) => {
    if (i % 2 === 1) opened = p === ',' ? 'comma' : 'clause';
    else clauses.push({ text: tidy(p ?? ''), opened });
  });
  const wordsOf = (t: string) => t.split(' ').filter((w) => w !== '');
  const withoutTitles = (t: string) => {
    const ws = wordsOf(t);
    while (ws.length > 1 && (words.titles.has(nameKeyOf(ws[0]!)) || /^the$/iu.test(ws[0]!))) ws.shift();
    return ws.join(' ');
  };
  let i = clauses.length - 1;
  const last = clauses[i]!;
  if (last.text !== '') {
    // The clause runs straight into the verb: its last words name the subject, or nobody does. CR-2026-11-R4 (RC-1):
    // the run must start the clause or follow a lower-case word ("Their son Murad al-Khalid") or a title ("Kaiser Soren
    // von Woerfels"); after a relational particle ("The daughter of Rashad al-Khalid", "Layla bint Rashad al-Khalid") it
    // is someone's relation, and after a capitalised word that is no title ("Karl Tobias von Hohenfalk") it is the end
    // of a longer name: nobody, never the shorter name.
    const ws = wordsOf(last.text);
    for (let k = Math.min(8, ws.length); k >= 1; k--) {
      const r = tryText(ws.slice(-k).join(' '));
      if (!r) continue;
      const before = ws[ws.length - k - 1];
      if (before === undefined) return r;
      const bk = nameKeyOf(before);
      if (words.relational.has(bk)) return null;
      if (words.titles.has(bk) || DETERMINERS.has(bk)) return r;
      return /^[\p{Lu}\p{Lt}]/u.test(before.replace(/^[^\p{L}]+/u, '')) ? null : r;
    }
    return null;
  }
  if (last.opened !== 'comma') return null;
  // "<subject>, <appositive>, was born": a clause standing alone as a name, else an appositive to pass over.
  for (i -= 1; i >= 0; i--) {
    const cl = clauses[i]!;
    const r = cl.text === '' ? null : tryText(withoutTitles(cl.text));
    if (r) return r;
    if (cl.opened !== 'comma') return null;
  }
  return null;
}

const DEFAULT_WORDS = subjectWords();

/** The text before the verb a phrasing matched: its `{name}` group, with the comma the phrasing passed over after it. */
function beforeVerb(m: RegExpExecArray, src: string): string {
  const name = m.groups?.name ?? '';
  const end = m.indices?.groups?.name?.[1];
  return end !== undefined && /^\s*,/u.test(src.slice(end)) ? `${name},` : name;
}

interface Ctx {
  readonly compiled: Compiled;
  readonly names: NameIndex;
  readonly cal: Calendar | null;
  readonly style: DateTextStyle;
}

/**
 * The date a phrasing's `date` group holds. Null for `scan` when nothing in the clause is date-shaped: then no fact is
 * recorded (ADR 0064 amendment 1, rule B), "unreadable" being kept for a date-shaped text the calendar refuses.
 */
function readDate(
  ctx: Ctx,
  text: string,
  how: 'leading' | 'first' | 'scan',
  kind: ConsistencyPattern['kind'] = 'attested',
): { date: DateReading | null; unreadable: string | null; text?: string } | null {
  if (!ctx.cal)
    return { date: null, unreadable: 'the chronology’s calendar is not available to the bridge yet' };
  if (how === 'scan') {
    // The clause after the verb: up to a semicolon or a clause word ("…in Falkenau, when the war ended in 3A 98").
    const clause = text.split(ctx.compiled.words.cut)[0] ?? '';
    // CR-2026-11-R4 (RC-2): never another date of the clause: brackets skipped, cut at a colon or a relative clause,
    // and a birth's or death's date reached from the verb through at most one "in / on / at <place>".
    const r = readScan(ctx.cal, clause, ctx.style, {
      skipBrackets: true,
      cutRelative: true,
      reach: kind === 'birth' || kind === 'death',
    });
    if (r === null) return null;
    return r.ok ? { date: r.reading, unreadable: null } : { date: null, unreadable: r.reason, text: r.text };
  }
  const r = how === 'first' ? readFirst(ctx.cal, text, ctx.style) : readLeading(ctx.cal, text, ctx.style);
  return r.ok ? { date: r.reading, unreadable: null } : { date: null, unreadable: r.reason };
}

/** The facts of one page, and its own subject and continuity. */
export function extractPageFacts(
  pageId: string,
  units: readonly Unit[],
  ctx: Ctx,
): { facts: ExtractedFact[]; meta: PageMeta } {
  const rules = ctx.compiled.rules;
  const factOf = (key: string) =>
    units.find((u) => u.unit === 'fact' && textKey(u.field ?? '') === textKey(key));
  const name = units.find((u) => u.unit === 'name')?.text ?? '';
  const subject = factOf('Subject')?.text ?? (name ? subjectPart(name) : null);
  const meta: PageMeta = {
    subject: subject && subject.trim() !== '' ? subject.trim() : null,
    continuityType: factOf('Continuity Type')?.text ?? null,
    continuity: factOf('Continuity')?.text ?? null,
  };
  const facts: ExtractedFact[] = [];
  const own = meta.subject ? { key: nameKeyOf(meta.subject), text: meta.subject } : null;
  const base = (u: Unit) => ({
    pageId,
    documentId: u.documentId,
    blockId: u.blockId,
    section: u.section,
    mentions: [] as string[],
  });
  for (const u of units) {
    if (u.unit === 'fact' && own) {
      const field = textKey(u.field ?? '');
      // Identity facts, as the page's sidebar states them.
      if (ctx.compiled.identity.has(field))
        facts.push({
          ...base(u),
          kind: 'identity',
          field: u.field,
          source: 'sidebar',
          pattern: 'identity',
          subjectKey: own.key,
          subjectText: own.text,
          matchedAs: 'page',
          valueText: tidy(u.text),
          gap:
            ctx.compiled.unestablished.has(textKey(u.text)) ||
            ctx.compiled.unestablished.has(textKey(principalValue(u.text))),
          date: null,
          unreadable: null,
          bound: null,
          excerpt: clip(`${u.field}: ${tidy(u.text)}`),
          place: { sha: placeSha(u.text), at: null },
        });
      const source =
        field === textKey(rules.temporalScope)
          ? 'temporalScope'
          : field === textKey(rules.lifeState)
            ? 'lifeState'
            : null;
      if (source) {
        // Each `;` clause on its own ("Born …; attested through …").
        for (const clause of u.text
          .split(';')
          .map(tidy)
          .filter((c) => c !== ''))
          for (const cp of ctx.compiled.bySource[source]) {
            const m = cp.re.exec(clause);
            if (!m) continue;
            const gap = cp.p.gap === true;
            const dateText = m.groups?.date ?? '';
            // CR-2026-11-R4 (request L): the life the phrasing names ("second life born …"), and a return or a
            // restoration (an attested start that begins a new life).
            const life = lifeOrdinal(m.groups?.life, ctx.compiled.lifeOrdinals);
            const lifeOf = life !== null ? { life } : {};
            const start =
              cp.p.kind === 'attested' && (cp.p.bound ?? 'both') === 'from'
                ? { start: cp.p.life === 'restoration' ? ('restoration' as const) : ('return' as const) }
                : {};
            const fact = (
              kind: ExtractedFact['kind'],
              d: { date: DateReading | null; unreadable: string | null; text?: string },
            ): ExtractedFact => ({
              ...base(u),
              kind,
              field: u.field,
              source,
              pattern: cp.p.id,
              subjectKey: own.key,
              subjectText: own.text,
              matchedAs: 'page',
              valueText: gap ? tidy(m[0]) : (d.date?.text ?? d.text ?? tidy(dateText)),
              gap,
              date: d.date,
              unreadable: d.unreadable,
              bound: kind === 'attested' ? (cp.p.bound ?? 'both') : null,
              excerpt: clip(`${u.field}: ${tidy(u.text)}`),
              place: {
                sha: placeSha(clause),
                at: d.date ? dateOffset(clause, m.indices?.groups?.date?.[0] ?? 0, d.date.text) : null,
              },
              ...lifeOf,
              ...start,
            });
            if (cp.p.life === 'span' && !gap) {
              // "First life Camue 1st, 4A 100–Camue 33rd, 4A 325": that life's birth (its start) and its death (its end).
              const parts = ctx.cal ? readRangeParts(ctx.cal, dateText, ctx.style) : null;
              if (!parts) continue;
              facts.push(fact('birth', { date: parts.from, unreadable: null }));
              facts.push(fact('death', { date: parts.to, unreadable: null }));
              continue;
            }
            const d = gap
              ? { date: null, unreadable: null }
              : readDate(ctx, dateText, cp.p.date ?? 'leading', cp.p.kind);
            if (!d) continue; // nothing date-shaped: not a fact (rule B)
            facts.push(fact(cp.p.kind, d));
          }
      }
      continue;
    }
    // Prose only: a table row is never read as its joined cells (rule C); the chronology's rows are read by their
    // columns (extractRowFacts).
    if (u.unit === 'text' && VERBS.test(u.text))
      for (const sentence of sentences(u.text)) {
        if (!VERBS.test(sentence)) continue;
        for (const cp of ctx.compiled.bySource.prose) {
          const m = cp.re.exec(sentence);
          if (!m) continue;
          const who = cp.named
            ? resolveName(beforeVerb(m, sentence), ctx.names, ctx.compiled.words)
            : own
              ? { ...own, as: 'page' as const }
              : null;
          if (!who) continue; // a pronoun, another clause's name, or a name the bridge does not know: never read (D2)
          const gap = cp.p.gap === true;
          const dateText = m.groups?.date ?? '';
          const d = gap
            ? { date: null, unreadable: null }
            : readDate(ctx, dateText, cp.p.date ?? 'leading', cp.p.kind);
          if (!d) continue; // nothing date-shaped after the verb: not a fact (rule B)
          facts.push({
            ...base(u),
            kind: cp.p.kind,
            field: null,
            source: 'prose',
            pattern: cp.p.id,
            subjectKey: who.key,
            subjectText: who.text,
            matchedAs: who.as,
            valueText: gap ? tidy(m[0]) : (d.date?.text ?? d.text ?? tidy(dateText).slice(0, 120)),
            gap,
            date: d.date,
            unreadable: d.unreadable,
            bound: cp.p.kind === 'attested' ? (cp.p.bound ?? 'both') : null,
            excerpt: clip(sentence),
            ...(isNonCurrent(u.section, ctx.compiled.nonCurrent) ? { nonCurrent: true as const } : {}),
            place: {
              sha: placeSha(sentence),
              at: d.date ? dateOffset(sentence, m.indices?.groups?.date?.[0] ?? 0, d.date.text) : null,
            },
          });
          break; // one fact a sentence: the first phrasing that reads it
        }
      }
  }
  return { facts, meta };
}

/** The facts of the chronology's rows: the event's kind and subject from its Historical Event cell, its Date cell. */
export function extractRowFacts(rows: readonly ChronologyRowInput[], ctx: Ctx): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const row of rows) {
    if (!VERBS.test(row.event)) continue;
    for (const cp of ctx.compiled.bySource.chronology) {
      const m = cp.re.exec(row.event);
      if (!m) continue;
      // Rule A on the Historical Event cell: the name governing the verb, or a mention whose text is that name (then the
      // mentioned page's character, resolved where the facts are compared). Never the joined row (rule C).
      const mentioned = new Map<string, string>();
      for (const s of row.subjects ?? []) {
        const k = nameKeyOf(s.text);
        if (k !== '' && !mentioned.has(k)) mentioned.set(k, s.resourceId);
      }
      const lookup: NameIndex = {
        lookup: (k) => ctx.names.lookup(k) ?? (mentioned.has(k) ? 'mention' : null),
      };
      const found = cp.named ? resolveName(beforeVerb(m, row.event), lookup, ctx.compiled.words) : null;
      const who: { key: string; text: string; as: MatchedAs } | null =
        found && found.as === 'mention'
          ? { key: `page:${mentioned.get(found.key)!}`, text: found.text, as: 'mention' }
          : found;
      if (!who) continue;
      const d = ctx.cal
        ? (() => {
            const r = readCell(ctx.cal, row.date, ctx.style);
            return r.ok ? { date: r.reading, unreadable: null } : { date: null, unreadable: r.reason };
          })()
        : { date: null, unreadable: 'the chronology’s calendar is not available to the bridge yet' };
      out.push({
        pageId: row.pageId,
        kind: cp.p.kind,
        field: null,
        source: 'chronology',
        pattern: cp.p.id,
        subjectKey: who.key,
        subjectText: who.text,
        matchedAs: who.as,
        valueText: tidy(row.date),
        gap: false,
        date: d.date,
        unreadable: d.unreadable,
        bound: cp.p.kind === 'attested' ? (cp.p.bound ?? 'both') : null,
        documentId: row.documentId,
        blockId: row.rowId,
        section: null,
        excerpt: clip(`${tidy(row.event)} | ${tidy(row.date)}`),
        mentions: row.mentions,
        ...(isNonCurrent(`${row.event} ${row.date}`, ctx.compiled.nonCurrent, { row: true })
          ? { nonCurrent: true as const }
          : {}),
        place: { sha: placeSha(row.event), at: null },
      });
      break;
    }
  }
  return out;
}
