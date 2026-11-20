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
import type { Calendar, DateTextStyle } from '../calendar/index.js';
import { nameKeyOf, subjectPart } from '../packs/naming/namesakes.js';
import { textKey } from '../packs/engine/text.js';
import type { ConsistencyPattern, ConsistencyRules } from '../packs/types.js';
import { readCell, readFirst, readLeading, readScan, type DateReading } from './dates.js';

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
}

/** ADR 0064 amendment 1, rule A: what may stand between a clause's start and its subject, and what starts a clause. */
export interface SubjectWords {
  readonly titles: ReadonlySet<string>;
  /** Splits a text before a verb into clauses: commas, semicolons, a spaced dash and the clause words (captured). */
  readonly split: RegExp;
  /** Where the text after a verb stops being its clause: a semicolon or a clause word. */
  readonly cut: RegExp;
}

/** Rule A's defaults (the owner's words, 20 November 2026), when the pack names none. */
export const DEFAULT_TITLES: readonly string[] = ['Kaiser', 'Kaiserin'];
export const DEFAULT_CLAUSE_WORDS: readonly string[] = ['after', 'when', 'before', 'until', 'while'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function subjectWords(
  titles: readonly string[] = DEFAULT_TITLES,
  clauseWords: readonly string[] = DEFAULT_CLAUSE_WORDS,
): SubjectWords {
  const words = clauseWords
    .map((w) => w.trim())
    .filter((w) => w !== '')
    .map(escapeRe)
    .join('|');
  const wordAlt = words ? `|\\b(?:${words})\\b` : '';
  return {
    titles: new Set(titles.map(nameKeyOf).filter((t) => t !== '')),
    split: new RegExp(`(,|;|\\s[-–—]\\s${wordAlt})`, 'iu'),
    cut: new RegExp(`;${wordAlt}`, 'iu'),
  };
}

/** A marker or a heading as markers compare: case, and any dashes or spaces between words, ignored. */
const markerKey = (s: string) =>
  s
    .toLocaleLowerCase('en-GB')
    .replace(/[\s\-–—_]+/gu, ' ')
    .trim();

/** Whether a text (a section's headings, a row) holds one of the non-current markers. */
export function isNonCurrent(text: string | null | undefined, markers: readonly string[] | null): boolean {
  if (!text || !markers || markers.length === 0) return false;
  const k = ` ${markerKey(text)} `;
  return markers.some((m) => m !== '' && k.includes(m));
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
    words: subjectWords(rules.titles, rules.clauseWords),
    nonCurrent: rules.nonCurrent ? rules.nonCurrent.markers.map(markerKey).filter((m) => m !== '') : null,
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
    // The clause runs straight into the verb: its last words name the subject, or nobody does.
    const ws = wordsOf(last.text);
    for (let k = Math.min(8, ws.length); k >= 1; k--) {
      const r = tryText(ws.slice(-k).join(' '));
      if (r) return r;
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
): { date: DateReading | null; unreadable: string | null; text?: string } | null {
  if (!ctx.cal)
    return { date: null, unreadable: 'the chronology’s calendar is not available to the bridge yet' };
  if (how === 'scan') {
    // The clause after the verb: up to a semicolon or a clause word ("…in Falkenau, when the war ended in 3A 98").
    const clause = text.split(ctx.compiled.words.cut)[0] ?? '';
    const r = readScan(ctx.cal, clause, ctx.style);
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
            const d = gap
              ? { date: null, unreadable: null }
              : readDate(ctx, dateText, cp.p.date ?? 'leading');
            if (!d) continue; // nothing date-shaped: not a fact (rule B)
            facts.push({
              ...base(u),
              kind: cp.p.kind,
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
              bound: cp.p.kind === 'attested' ? (cp.p.bound ?? 'both') : null,
              excerpt: clip(`${u.field}: ${tidy(u.text)}`),
            });
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
          const d = gap ? { date: null, unreadable: null } : readDate(ctx, dateText, cp.p.date ?? 'leading');
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
        ...(isNonCurrent(`${row.event} ${row.date}`, ctx.compiled.nonCurrent)
          ? { nonCurrent: true as const }
          : {}),
      });
      break;
    }
  }
  return out;
}
