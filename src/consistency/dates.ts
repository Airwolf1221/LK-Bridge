/**
 * v3 F4b (ADR 0064; design D2, D3, D7): dates as the consistency check and "as of a date" read them. Pure functions over
 * the calendar engine (src/calendar): nothing about Arkona is here, and nothing is guessed.
 *
 * - **Reading** keeps the date's **precision**: a day, a month, a year, a "c." (approximate) date, or a range. A date
 *   the engine cannot read is reported as unreadable, with the text, never guessed.
 * - **A span** (design D3): a day is that day, `4A 100` that whole year, a month that month, a range from the first unit
 *   to the last; a "c." date is widened by the pack's margin (`approxMargin`, in years) on each side.
 * - **Two values conflict** only when their spans do not overlap.
 * - **Elapsed calendar years** (design D7): a whole number when both dates are exact days, else a range from the spans;
 *   never apparent or biological age.
 */
import {
  DEFAULT_DATE_STYLE,
  QualifiedReader,
  type Calendar,
  type DateTextStyle,
  type ParsedDate,
} from '../calendar/index.js';

export type Precision = 'day' | 'month' | 'year';
export type Shape = 'day' | 'month' | 'year' | 'range';

/** A date read, as written, with its precision. `start` and `end` are the first minutes of its first and last unit. */
export interface DateReading {
  /** The date's text exactly as it stands in the source (the slice read). */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly precision: Precision;
  readonly shape: Shape;
  readonly approximate: boolean;
  /** Before a bound only ("by 4A 623"): the start is not known. */
  readonly openStart?: boolean;
  /** After a bound only ("after 4A 600"): the end is not known. */
  readonly openEnd?: boolean;
}

export type ReadResult =
  { readonly ok: true; readonly reading: DateReading } | { readonly ok: false; readonly reason: string };

/** A span on the calendar: its first and last minute (both included). */
export interface Span {
  readonly from: number;
  readonly to: number;
}

const APPROX = /^(?:c\.|ca\.|circa|approx\.|approximately|about|around)\s*/iu;
const RANGE_JOIN = /^\s*(?:[-–—]|to\b|through\b|until\b)\s*/iu;
const PRECISION: Readonly<Record<1 | 2 | 3, Precision>> = { 1: 'year', 2: 'month', 3: 'day' };

/** The first minute of the last unit of a parsed date (its end, or its start). */
const lastOf = (d: ParsedDate): number => d.end ?? d.start;

/**
 * Reads the date a text BEGINS with (whatever follows it is ignored): an optional "c." or "approximately", one date of
 * the calendar's forms, and optionally `– <date>` or `– <year>` for a range ("c. 4A 640–645", "5A 411–5A 931"). The
 * text is cut at its first `;` (a clause).
 */
export function readLeading(
  cal: Calendar,
  input: string,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
): ReadResult {
  const clause = input.split(';')[0]!.replace(/\s+/g, ' ').trim();
  if (clause === '') return { ok: false, reason: 'no date is written there' };
  const approx = APPROX.exec(clause);
  const body = approx ? clause.slice(approx[0].length) : clause;
  const first = cal.parser.leadingDate(body, style);
  if (!first) {
    // A plain form the leading reader does not take on its own (a range written whole, "Unknown, 1A 200").
    try {
      const whole = cal.parser.parse(body, style);
      return { ok: true, reading: fromParsed(whole, clause, approx !== null) };
    } catch {
      return {
        ok: false,
        reason: `the calendar cannot read a date at the start of “${clip(clause, 120)}”${calendarReason(cal, body, style)}`,
      };
    }
  }
  let reading = fromParsed(first.date, '', approx !== null);
  let used = first.match;
  const join = RANGE_JOIN.exec(first.rest);
  if (join) {
    const rest = first.rest.slice(join[0].length);
    const second = cal.parser.leadingDate(rest, style);
    if (second && second.date.start >= first.date.start) {
      const p = Math.min(first.date.detail, second.date.detail) as 1 | 2 | 3;
      reading = {
        ...reading,
        end: lastOf(second.date),
        precision: PRECISION[p],
        shape: 'range',
      };
      used = `${first.match}${join[0]}${second.match}`;
    } else if (first.date.detail === 1 && !second) {
      // "4A 640–645": the second end a bare year of the same era.
      const bare = /^(\d{1,3}(?:,\d{3})+|\d+)\b/u.exec(rest);
      if (bare) {
        const year = Number(bare[1]!.replace(/,/g, ''));
        try {
          const era = first.date.era;
          const end = cal.engine.yearStart(era, year);
          if (end > first.date.start) {
            reading = { ...reading, end, shape: 'range' };
            used = `${first.match}${join[0]}${bare[1]}`;
          }
        } catch {
          // Not a year of that era: the first date alone is read.
        }
      }
    }
  }
  const text = `${approx ? approx[0] : ''}${used}`.trim();
  return { ok: true, reading: { ...reading, text } };
}

/**
 * CR-2026-11-R4 (the owner's request L): a range's two ends read on their own, each with its own text and precision
 * ("Camue 1st, 4A 100–Camue 33rd, 4A 325": a life's birth and its death). The text must BEGIN with the range (an
 * optional "c." or "approximately" applying to both); a bare second year ("4A 640–645") takes the first one's era.
 * Null when the text does not begin with a range the calendar can read.
 */
export function readRangeParts(
  cal: Calendar,
  input: string,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
): { from: DateReading; to: DateReading } | null {
  const clause = input.split(';')[0]!.replace(/\s+/g, ' ').trim();
  const approx = APPROX.exec(clause);
  const body = approx ? clause.slice(approx[0].length) : clause;
  const first = cal.parser.leadingDate(body, style);
  if (!first) return null;
  const join = RANGE_JOIN.exec(first.rest);
  if (!join) return null;
  const rest = first.rest.slice(join[0].length);
  const a = {
    ...fromParsed(first.date, '', approx !== null),
    text: `${approx ? approx[0] : ''}${first.match}`.trim(),
  };
  const second = cal.parser.leadingDate(rest, style);
  if (second) {
    if (second.date.start < first.date.start) return null;
    return { from: a, to: { ...fromParsed(second.date, '', approx !== null), text: second.match.trim() } };
  }
  const bare = first.date.detail === 1 ? /^(\d{1,3}(?:,\d{3})+|\d+)\b/u.exec(rest) : null;
  if (!bare) return null;
  try {
    const era = first.date.era;
    const year = Number(bare[1]!.replace(/,/g, ''));
    const start = cal.engine.yearStart(era, year);
    if (start <= first.date.start) return null;
    return {
      from: a,
      to: {
        text: bare[1]!,
        start,
        end: start,
        precision: 'year',
        shape: 'year',
        approximate: approx !== null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * The calendar's own reason a date-shaped start is not a date (`Camue has 50 days; there is no day 51.`): its leading
 * words tried as a whole date, longest first. Empty when no start looks like a date.
 */
function calendarReason(cal: Calendar, body: string, style: DateTextStyle): string {
  const words = body.split(' ');
  for (let k = Math.min(8, words.length); k >= 1; k--) {
    try {
      cal.parser.parse(
        words
          .slice(0, k)
          .join(' ')
          .replace(/[,.;:]+$/u, ''),
        style,
      );
    } catch (e) {
      // CR-2026-11-R4: an age's end too ("4A 960 is after the Fourth Arkonan Age (4A) ends … Write it in 5A").
      if (
        e instanceof Error &&
        /days|does not occur|no year|outside|not a year|\bends\b|write it in/i.test(e.message)
      )
        return ` (${e.message})`;
    }
  }
  return '';
}

/**
 * The first date in a text (up to its first `;`), read at the start of each word in turn ("alive and immortal in
 * Fifth-Age present 5A 931" → `5A 931`). Unreadable when no word starts a date.
 */
export function readFirst(
  cal: Calendar,
  input: string,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
): ReadResult {
  const clause = input.split(';')[0]!.replace(/\s+/g, ' ').trim();
  if (clause === '') return { ok: false, reason: 'no date is written there' };
  const starts = [0];
  for (const m of clause.matchAll(/\s+/gu)) starts.push(m.index + m[0].length);
  for (const i of starts) {
    if (i >= clause.length) continue;
    const r = readLeading(cal, clause.slice(i), style);
    if (r.ok) return r;
  }
  return { ok: false, reason: `the calendar cannot read a date in “${clip(clause, 120)}”` };
}

/** What a scan found: a reading, a date-shaped text the calendar refused (with its reason), or nothing date-shaped. */
export type ScanResult =
  | { readonly ok: true; readonly reading: DateReading }
  | { readonly ok: false; readonly reason: string; readonly text: string }
  | null;

const SHAPES = new WeakMap<Calendar, RegExp>();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a date-shaped substring starts (ADR 0064 amendment 1, rule B): a word starting with one of the calendar's month
 * names or era abbreviations followed by a number (`Jehet 27th, 4A 84`, `Isar 4A 566`, `2A 748,455`), with an optional
 * "c." or "approximately" before it. Built from the calendar: nothing about Arkona is here.
 */
function shapeOf(cal: Calendar): RegExp {
  let re = SHAPES.get(cal);
  if (!re) {
    const alt = (xs: readonly string[]) =>
      xs
        .map((x) => x.trim())
        .filter((x) => x !== '')
        .sort((a, b) => b.length - a.length)
        .map(escapeRe)
        .join('|');
    const months = alt(cal.engine.definition.months.map((m) => m.name));
    const eras = alt(cal.engine.eras.filter((e) => !e.hideAbbr).map((e) => e.abbr));
    const heads = [months, eras].filter((x) => x !== '').map((x) => `(?:${x})\\s+\\d`);
    re = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:(?:c\\.|ca\\.|circa|approx\\.|approximately|about|around)\\s*)?(?:${heads.join('|') || '(?!)'})`,
      'giu',
    );
    SHAPES.set(cal, re);
  }
  return re;
}

/** CR-2026-11-R4 (RC-2): how narrowly a scan reads the date of its clause (all off: ADR 0064 amendment 1's scan). */
export interface ScanOptions {
  /** Bracketed parentheticals are skipped: "(born Malakh 33rd, 4A 280)", "(1,250,391 KCY)". */
  readonly skipBrackets?: boolean;
  /** The clause is cut at ":" and at a relative clause: ", which", ", who", ", whose", ", where", "since", "that". */
  readonly cutRelative?: boolean;
  /**
   * The date must be reached from the verb directly or through at most one "in / on / at <place>" ("born in Altan-Saray
   * on Camue 44th, 4A 360", "died at midday Zahras 36th, 4A 950"); any other text before it ("between", "no later
   * than", "to <parents> … on") reads nothing.
   */
  readonly reach?: boolean;
}

/** Where a relative clause or a colon starts: the date of the clause is never read past it. */
const RELATIVE = /:|,\s*(?:which|who|whom|whose|where)\b|\b(?:since|that)\b/iu;
/** The hop words of `reach`: a preposition that introduces a place (or the parents) or the date. */
const HOP = String.raw`(?:in|on|at|to)`;
/** A word of a place: any word that is no hop word ("Altan-Saray", "the Empire of Fujimatsu", "Wadi Al-Sihr,"). */
const PLACE_WORD = String.raw`(?!${HOP}\b)\S+`;
/**
 * What may stand between the verb and the date (`reach`): nothing; one "in / on / at / to <place or parents>" and the
 * preposition of the date ("in Altan-Saray on", "Altan-Saray on" once the phrasing took the "in", "to Murad al-Khalid
 * on"); or a preposition with a few words before the date ("at midday").
 */
const REACH = new RegExp(
  String.raw`^(?:(?:${HOP}\s+)?(?:${PLACE_WORD}\s+)+)?(?:(?:in|on|at)(?:\s+${PLACE_WORD}){0,6})?$`,
  'iu',
);

/** A text with its bracketed parentheticals blanked out (nested ones too); an unclosed bracket is left as it is. */
function withoutBrackets(s: string): string {
  let t = s;
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/\([^()]*\)|\[[^[\]]*\]/gu, ' ');
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * The first date-shaped substring of a clause, read by the calendar engine (ADR 0064 amendment 1, rule B): a leading
 * place ("Erzherzogtum Falkenau on …"), "to <parents>" and a trailing "(… KCY)" are skipped because only the date-shaped
 * text is read. The text is cut at its first `;`. Null when nothing in it is date-shaped (then no fact is recorded:
 * "unreadable" is kept for a date-shaped text the calendar refuses, with its reason). CR-2026-11-R4 (RC-2, `o`): the
 * date of the clause only, never another date in it (a parent's birth in brackets, a city's fall in a relative clause,
 * "ruled since 3A 60"); and two dates joined by "or" ("4A 100 or 4A 101") read as the span holding both (RC-22).
 */
export function readScan(
  cal: Calendar,
  input: string,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
  o: ScanOptions = {},
): ScanResult {
  let clause = input.split(';')[0]!;
  if (o.skipBrackets) clause = withoutBrackets(clause);
  if (o.cutRelative) clause = clause.split(RELATIVE)[0] ?? '';
  clause = clause.replace(/\s+/g, ' ').trim();
  if (clause === '') return null;
  const re = shapeOf(cal);
  re.lastIndex = 0;
  const m = re.exec(clause);
  if (!m) return null;
  if (o.reach && !REACH.test(clause.slice(0, m.index).trim())) return null;
  const at = clause.slice(m.index);
  const r = readLeading(cal, at, style);
  if (!r.ok) return { ok: false, reason: r.reason, text: clip(at, 120) };
  if (!o.reach && !o.cutRelative) return r;
  // "4A 100 or 4A 101": either date, so the span holding both (never the first alone).
  const rest = at.slice(at.indexOf(r.reading.text) + r.reading.text.length);
  const or = /^\s*(?:,\s*)?or\s+/iu.exec(rest);
  if (!or) return r;
  const second = readLeading(cal, rest.slice(or[0].length), style);
  if (!second.ok)
    return {
      ok: false,
      reason: 'two dates are given (“or”), and the second cannot be read',
      text: clip(at, 120),
    };
  const a = r.reading;
  const b = second.reading;
  const first = a.start <= b.start ? a : b;
  const last = a.start <= b.start ? b : a;
  return {
    ok: true,
    reading: {
      text: `${a.text}${or[0]}${b.text}`.replace(/\s+/g, ' ').trim(),
      start: first.start,
      end: Math.max(first.end, last.end),
      precision: PRECISION[Math.min(DETAIL[a.precision], DETAIL[b.precision]) as 1 | 2 | 3],
      shape: 'range',
      approximate: a.approximate || b.approximate,
    },
  };
}

const DETAIL: Readonly<Record<Precision, number>> = { year: 1, month: 2, day: 3 };

/**
 * A chronology row's Date cell, read as the chronology reads it: a plain form, else the qualified reader (by its anchor:
 * `c. 4A 563; exact date unresolved`, `Before Selyros 40th, 4A 605`).
 */
export function readCell(cal: Calendar, cell: string, style: DateTextStyle = DEFAULT_DATE_STYLE): ReadResult {
  const t = cell.replace(/\s+/g, ' ').trim();
  if (t === '') return { ok: false, reason: 'the Date cell is empty' };
  try {
    return { ok: true, reading: fromParsed(cal.parser.parse(t, style), t, false) };
  } catch {
    // The qualified reader below.
  }
  const q = new QualifiedReader(cal.parser, style).read(t);
  if (!q.ok) return { ok: false, reason: q.message };
  const r = q.reading;
  return {
    ok: true,
    reading: {
      text: t,
      start: r.start,
      end: r.end ?? r.start,
      precision: r.precision,
      shape: r.shape,
      approximate: r.approximate,
      ...(r.openStart ? { openStart: true } : {}),
      ...(r.openEnd ? { openEnd: true } : {}),
    },
  };
}

function fromParsed(d: ParsedDate, text: string, approximate: boolean): DateReading {
  const precision = PRECISION[d.detail];
  return {
    text,
    start: d.start,
    end: lastOf(d),
    precision,
    shape: d.end !== null ? 'range' : precision,
    approximate,
  };
}

/** The first minute after the unit (a day, a month or a year) that starts at `minute`. */
function unitEnd(cal: Calendar, minute: number, precision: Precision): number {
  const e = cal.engine;
  if (precision === 'day') return minute + e.minutesPerDay;
  const m = e.resolve(minute);
  return precision === 'month' ? e.monthEnd(m.era, m.year, m.monthIndex) : e.yearEnd(m.era, m.year);
}

/** The first minute of a KCY, clamped to the calendar. */
function kcyStart(cal: Calendar, kcy: number): number {
  try {
    return cal.engine.yearsOfKcy(kcy)[0]!.from;
  } catch {
    return cal.engine.minMinute;
  }
}

/** The last minute of a KCY, clamped to the calendar. */
function kcyLast(cal: Calendar, kcy: number): number {
  try {
    const ys = cal.engine.yearsOfKcy(kcy);
    return ys[ys.length - 1]!.to;
  } catch {
    return cal.engine.maxMinute;
  }
}

/**
 * The span a reading stands for (design D3): its first unit's first minute to its last unit's last minute, widened by
 * `margin` years each side when it is approximate. An open side runs to the calendar's edge.
 */
export function spanOf(cal: Calendar, r: DateReading, margin: number): Span {
  let from = r.start;
  let to = unitEnd(cal, r.end, r.precision) - 1;
  if (r.approximate && margin > 0) {
    // CR-2026-11-R4 (RC-14): the margin is counted in years (their indices), so it steps over a missing year 0.
    from = kcyStart(cal, kcyOfIndex(cal, yearIndexOfKcy(cal, cal.engine.kcyOf(from)) - margin));
    to = kcyLast(cal, kcyOfIndex(cal, yearIndexOfKcy(cal, cal.engine.kcyOf(to)) + margin));
  }
  if (r.openStart) from = cal.engine.minMinute;
  if (r.openEnd) to = cal.engine.maxMinute;
  return { from, to };
}

/** Two spans overlap: then their values can both be true (design D3). */
export const overlaps = (a: Span, b: Span): boolean => a.from <= b.to && b.from <= a.to;

/** A reading is exact: one day, not approximate, not open. */
export const isExact = (r: DateReading): boolean =>
  r.shape === 'day' && !r.approximate && !r.openStart && !r.openEnd;

/**
 * CR-2026-11-R4 (RC-14): a KCY's year index: KCY labels skip year 0 in a calendar without one (… -2, -1, 1, 2 …), so
 * years are counted on the indices, never the labels (AA 1 to 1A 1 is one year, not two).
 */
function yearIndexOfKcy(cal: Calendar, kcy: number): number {
  return kcy > 0 && !cal.engine.rules.hasZeroYear ? kcy - 1 : kcy;
}

/** The KCY label of a year index (the inverse of `yearIndexOfKcy`). */
function kcyOfIndex(cal: Calendar, index: number): number {
  return index >= 0 && !cal.engine.rules.hasZeroYear ? index + 1 : index;
}

/**
 * CR-2026-11-R4 (RC-15): where a minute falls in its year, by month, day and time of day (a leap day earlier in one of
 * the years moves the minutes, never the anniversary); by minutes into the year where an era keeps a frame of its own.
 */
function placeInYear(cal: Calendar, minute: number, kcy: number): number[] {
  try {
    const m = cal.engine.resolve(minute);
    if (m.era.resetMode !== 'calendar') return [m.monthIndex, m.day, m.hour, m.minuteOfHour];
  } catch {
    // Outside the calendar: the minutes into the year below.
  }
  return [minute - kcyStart(cal, kcy)];
}

const before = (x: readonly number[], y: readonly number[]): boolean => {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};

/** Whole calendar years from one minute to a later one (an anniversary not yet reached does not count). */
export function yearsBetween(cal: Calendar, a: number, b: number): number {
  if (b < a) return -yearsBetween(cal, b, a);
  const e = cal.engine;
  const ka = e.kcyOf(a);
  const kb = e.kcyOf(b);
  let years = yearIndexOfKcy(cal, kb) - yearIndexOfKcy(cal, ka);
  const pa = placeInYear(cal, a, ka);
  const pb = placeInYear(cal, b, kb);
  if (pa.length === pb.length ? before(pb, pa) : b - kcyStart(cal, kb) < a - kcyStart(cal, ka)) years -= 1;
  return Math.max(0, years);
}

export type Elapsed =
  | { readonly kind: 'exact'; readonly years: number }
  | {
      readonly kind: 'range';
      readonly min: number;
      readonly max: number;
      /** CR-2026-11-R4 (RC-21): the date may come before the birth (inside its margin or its unit). */
      readonly maybeUnborn?: true;
    }
  | { readonly kind: 'not_yet_born' };

/**
 * Elapsed calendar years from a birth to a date (design D7): a single number when both are exact days; a range when
 * either is approximate or coarser; "not yet born" when the date ends before the birth can have begun. Never apparent
 * or biological age.
 */
export function elapsedYears(
  cal: Calendar,
  birth: { readonly reading: DateReading; readonly span: Span },
  at: { readonly reading: DateReading; readonly span: Span },
): Elapsed {
  if (at.span.to < birth.span.from) return { kind: 'not_yet_born' };
  if (isExact(birth.reading) && isExact(at.reading)) {
    if (at.reading.start < birth.reading.start) return { kind: 'not_yet_born' };
    return { kind: 'exact', years: yearsBetween(cal, birth.reading.start, at.reading.start) };
  }
  const min = at.span.from <= birth.span.to ? 0 : yearsBetween(cal, birth.span.to, at.span.from);
  const max = yearsBetween(cal, birth.span.from, at.span.to);
  // CR-2026-11-R4 (RC-21): a date that may come before the birth ("c. 4A 640" asked 4A 636) says so.
  return at.span.from < birth.span.to
    ? { kind: 'range', min, max, maybeUnborn: true }
    : { kind: 'range', min, max };
}

/** A span in words for answers (`4A 100`, `Camue 1st, 4A 100`), from its reading. */
export function describe(r: DateReading): string {
  const what =
    r.shape === 'range' ? `a range (by ${r.precision})` : r.shape === 'day' ? 'a day' : `a ${r.shape}`;
  return `${what}${r.approximate ? ', approximate' : ''}${r.openStart ? ', open start' : ''}${r.openEnd ? ', open end' : ''}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
