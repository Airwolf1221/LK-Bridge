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
      if (e instanceof Error && /days|does not occur|no year|outside|not a year/i.test(e.message))
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

/**
 * The first date-shaped substring of a clause, read by the calendar engine (ADR 0064 amendment 1, rule B): a leading
 * place ("Erzherzogtum Falkenau on …"), "to <parents>" and a trailing "(… KCY)" are skipped because only the date-shaped
 * text is read. The text is cut at its first `;`. Null when nothing in it is date-shaped (then no fact is recorded:
 * "unreadable" is kept for a date-shaped text the calendar refuses, with its reason).
 */
export function readScan(
  cal: Calendar,
  input: string,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
): ScanResult {
  const clause = input.split(';')[0]!.replace(/\s+/g, ' ').trim();
  if (clause === '') return null;
  const re = shapeOf(cal);
  re.lastIndex = 0;
  const m = re.exec(clause);
  if (!m) return null;
  const at = clause.slice(m.index);
  const r = readLeading(cal, at, style);
  return r.ok ? r : { ok: false, reason: r.reason, text: clip(at, 120) };
}

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
    from = kcyStart(cal, cal.engine.kcyOf(from) - margin);
    to = kcyLast(cal, cal.engine.kcyOf(to) + margin);
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

/** Whole calendar years from one minute to a later one (an anniversary not yet reached does not count). */
export function yearsBetween(cal: Calendar, a: number, b: number): number {
  if (b < a) return -yearsBetween(cal, b, a);
  const e = cal.engine;
  const ka = e.kcyOf(a);
  const kb = e.kcyOf(b);
  let years = kb - ka;
  if (b - kcyStart(cal, kb) < a - kcyStart(cal, ka)) years -= 1;
  return Math.max(0, years);
}

export type Elapsed =
  | { readonly kind: 'exact'; readonly years: number }
  | { readonly kind: 'range'; readonly min: number; readonly max: number }
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
  return min === max ? { kind: 'range', min, max } : { kind: 'range', min, max };
}

/** A span in words for answers (`4A 100`, `Camue 1st, 4A 100`), from its reading. */
export function describe(r: DateReading): string {
  const what =
    r.shape === 'range' ? `a range (by ${r.precision})` : r.shape === 'day' ? 'a day' : `a ${r.shape}`;
  return `${what}${r.approximate ? ', approximate' : ''}${r.openStart ? ', open start' : ''}${r.openEnd ? ', open end' : ''}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
