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
 */
import type { Calendar, DateTextStyle } from '../calendar/index.js';
import { nameKeyOf, subjectPart } from '../packs/naming/namesakes.js';
import { textKey } from '../packs/engine/text.js';
import type { ConsistencyPattern, ConsistencyRules } from '../packs/types.js';
import { readCell, readFirst, readLeading, type DateReading } from './dates.js';

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
      const re = new RegExp(p.regex.replace('{name}', NAME_GROUP), 'iu');
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
  };
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
 * Who a run of words before a verb names: a name, an alias or a Canonical Display Name, never a pronoun. Before an
 * appositive ("Yasmin al-Naim, daughter of Karim al-Naim, is born") the name is what comes before the first comma, and
 * must be one whole; otherwise the longest run of its last words that is a name.
 */
export function resolveName(
  candidate: string,
  names: NameIndex,
): { readonly key: string; readonly text: string; readonly as: MatchedAs } | null {
  const c = tidy(candidate).replace(/[,\s]+$/u, '');
  if (c === '') return null;
  const tryText = (t: string) => {
    const key = nameKeyOf(t);
    if (key === '') return null;
    const as = names.lookup(key);
    return as ? { key, text: t, as } : null;
  };
  if (c.includes(',')) {
    // "Yasmin al-Naim, daughter of Karim al-Naim, is born": the name before the appositive. "In 4A 100, Yasmin was
    // born": the whole part after the last comma. Never a name found inside an appositive ("…of Karim al-Naim").
    const parts = c.split(',').map((p) => p.trim());
    return tryText(parts[0]!) ?? tryText(parts[parts.length - 1]!);
  }
  const words = c.split(' ');
  for (let k = Math.min(8, words.length); k >= 1; k--) {
    const r = tryText(words.slice(-k).join(' '));
    if (r) return r;
  }
  return null;
}

interface Ctx {
  readonly compiled: Compiled;
  readonly names: NameIndex;
  readonly cal: Calendar | null;
  readonly style: DateTextStyle;
}

function readDate(
  ctx: Ctx,
  text: string,
  how: 'leading' | 'first',
): { date: DateReading | null; unreadable: string | null } {
  if (!ctx.cal)
    return { date: null, unreadable: 'the chronology’s calendar is not available to the bridge yet' };
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
          gap: ctx.compiled.unestablished.has(textKey(u.text)),
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
            facts.push({
              ...base(u),
              kind: cp.p.kind,
              field: u.field,
              source,
              pattern: cp.p.id,
              subjectKey: own.key,
              subjectText: own.text,
              matchedAs: 'page',
              valueText: gap ? tidy(m[0]) : (d.date?.text ?? tidy(dateText)),
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
    if ((u.unit === 'text' || u.unit === 'row') && VERBS.test(u.text))
      for (const sentence of sentences(u.text)) {
        if (!VERBS.test(sentence)) continue;
        for (const cp of ctx.compiled.bySource.prose) {
          const m = cp.re.exec(sentence);
          if (!m) continue;
          const who = cp.named
            ? resolveName(m.groups?.name ?? '', ctx.names)
            : own
              ? { ...own, as: 'page' as const }
              : null;
          if (!who) continue; // a pronoun, or a name the bridge does not know: never read (D2)
          const gap = cp.p.gap === true;
          const dateText = m.groups?.date ?? '';
          const d = gap ? { date: null, unreadable: null } : readDate(ctx, dateText, cp.p.date ?? 'leading');
          facts.push({
            ...base(u),
            kind: cp.p.kind,
            field: null,
            source: 'prose',
            pattern: cp.p.id,
            subjectKey: who.key,
            subjectText: who.text,
            matchedAs: who.as,
            valueText: gap ? tidy(m[0]) : (d.date?.text ?? tidy(dateText).slice(0, 120)),
            gap,
            date: d.date,
            unreadable: d.unreadable,
            bound: cp.p.kind === 'attested' ? (cp.p.bound ?? 'both') : null,
            excerpt: clip(sentence),
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
      let who: { key: string; text: string; as: MatchedAs } | null = cp.named
        ? resolveName(m.groups?.name ?? '', ctx.names)
        : null;
      // No name: the one page the row mentions (resolved to its character where the facts are compared).
      if (!who && row.mentions.length === 1)
        who = { key: `page:${row.mentions[0]!}`, text: m.groups?.name?.trim() || row.event, as: 'mention' };
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
      });
      break;
    }
  }
  return out;
}
