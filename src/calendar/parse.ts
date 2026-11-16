/**
 * The owner's date forms (PLAN-v2 section 1 and 4.8; v2 D1, ADR 0038), read and written from the calendar's own
 * templates, month names and era abbreviations. Nothing about Arkona is hard-coded: for the Kumikan calendar (day
 * `MMMM D^, E YYYY`, month `MMMM E YYYY`, year `E YYYY`) the forms are
 *
 * | form                | example                                        | stored as                |
 * | ------------------- | ---------------------------------------------- | ------------------------ |
 * | `day`               | `Kumikas 1st, 1A 159`                          | day (detail 3)           |
 * | `year`              | `4A 881`                                       | year-only (detail 1)     |
 * | `unknown-year`      | `Unknown, 4A 101`                              | year-only (detail 1)     |
 * | `month`             | `Zahras 4A 367`                                | month-only (detail 2)    |
 * | `date-range`        | `Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102`  | date-range (detail 3)    |
 * | `day-range`         | `Jehet 11th - 18th, 4A 424`                    | date-range (detail 3)    |
 * | `cross-month-range` | `Isar 20th - Pahan 31st, 4A 32`                | date-range (detail 3)    |
 * | `month-range`       | `Kumikas - Azaakh, 4A 180`                     | month-range (detail 2)   |
 * | `month-range-full`  | `Zahras 4A 367 - Attina 4A 367`                | month-range (detail 2)   |
 * | `year-range`        | `4A 881 - 4A 900`                              | year-range (detail 1)    |
 *
 * The compressed forms (`day-range`, `cross-month-range`, `month-range`, `unknown-year`) exist when the day template
 * divides into a month-and-day part and a year part (template.ts, `splitTemplate`). Matching ignores case, accepts any
 * ordinal suffix or none, extra spaces, any dash between the ends of a range, and a year with or without thousands
 * commas (so both the table style, `AA 1,988,119`, and LegendKeeper's, `AA 1988119`, are read). `Unknown` alone is
 * refused.
 *
 * Minutes follow LegendKeeper (verified on 330 real events, the spike's oracle): a day starts at its first minute; a
 * date range ends at the first minute of its last day; a month range at the first minute of its last month; a year range
 * at the first minute of its last year. A year or month that begins before its era (the era's first year, `4A 1`)
 * starts at the era's first minute; a day must lie inside its era.
 */
import { DAY_PART, splitTemplate, tokenize, type Token } from './template.js';
import type { Era } from './definition.js';
import { CalendarError } from './errors.js';
import type { CalendarEngine, Detail, EventDate } from './engine.js';

export type DateForm =
  | 'day'
  | 'year'
  | 'unknown-year'
  | 'month'
  | 'date-range'
  | 'day-range'
  | 'cross-month-range'
  | 'month-range'
  | 'month-range-full'
  | 'year-range';

/** How LegendKeeper stores an event's dates (the spike's names): its `detail` and whether it has an end. */
export type EventShape = 'day' | 'date-range' | 'month-only' | 'month-range' | 'year-only' | 'year-range';

/**
 * How a date is written as text. There are two styles (ADR 0039):
 *
 * - the TABLE style (this type, learned from the tables and confirmed by the owner): the year's thousands separator
 *   (`AA 1,988,119`) and the range separator. Used only for table Date and KCY cells;
 * - LegendKeeper's style (`LK_DATE_STYLE`): no separator in the year (`AA 1988119`), as it shows on events.
 */
export interface DateTextStyle {
  /** Between the two ends of a range. The owner's forms use ` - `. */
  readonly rangeSeparator: string;
  /** A year's thousands separator (`AA 1,988,119`); `''` for none. */
  readonly yearGrouping: string;
}

/** The table style until the owner confirms the one learned from the rows (the owner's own forms). */
export const DEFAULT_DATE_STYLE: DateTextStyle = { rangeSeparator: ' - ', yearGrouping: ',' };

/** LegendKeeper's style: how it writes a date on an event (no thousands separator in a year). */
export const LK_DATE_STYLE: DateTextStyle = { rangeSeparator: ' - ', yearGrouping: '' };

export interface ParsedDate {
  readonly input: string;
  readonly form: DateForm;
  readonly shape: EventShape;
  readonly detail: 1 | 2 | 3;
  /** LegendKeeper minutes. */
  readonly start: number;
  readonly end: number | null;
  readonly era: Era;
  readonly endEra: Era | null;
  readonly startDate: EventDate;
  readonly endDate: EventDate | null;
  /** KCY of the start's year, and of the end's (null when there is no end). */
  readonly kcy: { readonly start: number; readonly end: number | null };
  /** What LegendKeeper shows for these minutes (`formattedStart`, `formattedEnd`): LegendKeeper's style. */
  readonly formattedStart: string;
  readonly formattedEnd: string | null;
  /** LegendKeeper's text of the whole date: the start, or `start - end` for a range (LegendKeeper's style). */
  readonly formatted: string;
  /**
   * The date written back in its own form with the calendar's names, in the TABLE style given to the parser (what a
   * table Date cell gets). `tableFormatted` is the same text.
   */
  readonly text: string;
  readonly tableFormatted: string;
}

const SHAPE: Readonly<Record<DateForm, EventShape>> = {
  day: 'day',
  year: 'year-only',
  'unknown-year': 'year-only',
  month: 'month-only',
  'date-range': 'date-range',
  'day-range': 'date-range',
  'cross-month-range': 'date-range',
  'month-range': 'month-range',
  'month-range-full': 'month-range',
  'year-range': 'year-range',
};

const DETAIL: Readonly<Record<EventShape, 1 | 2 | 3>> = {
  day: 3,
  'date-range': 3,
  'month-only': 2,
  'month-range': 2,
  'year-only': 1,
  'year-range': 1,
};

type Segment =
  | { readonly tokens: readonly Token[]; readonly end: 1 | 2 }
  | { readonly range: true }
  | { readonly lit: string; readonly re: string };

interface FormDef {
  readonly form: DateForm;
  readonly segments: readonly Segment[];
  strict?: RegExp;
  loose?: RegExp;
  /** v2 E6 (ADR 0048): a single date (day, month, year) at the start, and at the end, of a longer text. */
  lead?: RegExp;
  tail?: RegExp;
}

/** The single-date forms: what a qualified cell's anchor, or one end of its range, is read as (ADR 0048). */
const SINGLE_FORMS: ReadonlySet<DateForm> = new Set(['day', 'month', 'year']);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (names: readonly string[]) =>
  [...new Set(names.filter((n) => n.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A literal of a template as a tolerant pattern: a space may be several, and punctuation may have spaces before it.
 * A space the template puts after punctuation stays required: with a template such as `MMMM D^, YYYY E`, `8,841` must
 * read as the year 8,841, never as day 8 of year 841.
 */
function literalPattern(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/\s/.test(ch)) out += '\\s+';
    else out += `\\s*${escape(ch)}`;
  }
  // Collapse runs of space patterns: any optional one makes the run optional.
  return out.replace(/(?:\\s[*+]){2,}/g, (run) => (run.includes('\\s*') ? '\\s*' : '\\s+'));
}

export class DateParser {
  private readonly forms: FormDef[] = [];
  private readonly split: ReturnType<typeof splitTemplate>;
  private readonly names: {
    months: string;
    monthAbbrs: string;
    eras: string;
    eraNames: string;
    weekdays: string;
    weekdayAbbrs: string;
  };

  constructor(readonly cal: CalendarEngine) {
    const def = cal.definition;
    const wd = (def.weekdays ?? []).map((w) => w.name);
    this.names = {
      months: alt(def.months.map((m) => m.name)),
      monthAbbrs: alt(def.months.map((m) => m.name.slice(0, 3))),
      eras: alt(cal.eras.map((e) => e.abbr)),
      eraNames: alt(cal.eras.map((e) => e.name)),
      weekdays: alt(wd),
      weekdayAbbrs: alt(wd.map((w) => w.slice(0, 3))),
    };
    const { day, month, year } = cal.formats;
    this.split = splitTemplate(day);
    const R = { range: true } as const;
    const one = (tokens: readonly Token[], end: 1 | 2 = 1) => ({ tokens, end }) as const;
    const add = (form: DateForm, segments: Segment[]) => this.forms.push({ form, segments });
    add('day', [one(day)]);
    add('year', [one(year)]);
    const sepText = this.split?.sep ?? ', ';
    add('unknown-year', [{ lit: `Unknown${sepText}`, re: `unknown\\s*,?\\s*` }, one(year)]);
    add('month', [one(month)]);
    add('date-range', [one(day), R, one(day, 2)]);
    if (this.split) {
      const { head, sep, tail } = this.split;
      const sepSeg: Segment = { lit: sep, re: literalPattern(sep) };
      const dayAt = head.findIndex((t) => t.kind === 'day');
      if (
        dayAt === head.length - 1 &&
        head.slice(0, dayAt).some((t) => DAY_PART.has(t.kind) && t.kind !== 'day')
      ) {
        add('day-range', [one(head), R, one(head.slice(dayAt), 2), sepSeg, one(tail)]);
      }
      add('cross-month-range', [one(head), R, one(head, 2), sepSeg, one(tail)]);
      const monthAt = head.findIndex(
        (t) => t.kind === 'month' || t.kind === 'monthAbbr' || t.kind === 'monthNum',
      );
      if (monthAt >= 0 && !head.slice(0, monthAt).some((t) => t.kind === 'day')) {
        const monthPart = head.slice(0, monthAt + 1);
        add('month-range', [one(monthPart), R, one(monthPart, 2), sepSeg, one(tail)]);
      }
    }
    add('month-range-full', [one(month), R, one(month, 2)]);
    add('year-range', [one(year), R, one(year, 2)]);
    for (const f of this.forms) {
      const src = this.source(f.segments, false);
      f.strict = new RegExp(`^${src}$`, 'iu');
      f.loose = new RegExp(`^${this.source(f.segments, true)}$`, 'iu');
      if (SINGLE_FORMS.has(f.form)) {
        f.lead = new RegExp(`^(?:${src})`, 'iu');
        f.tail = new RegExp(`(?:${src})$`, 'iu');
      }
    }
  }

  /**
   * v2 E6 (ADR 0048): the longest single date (a day, a month or a year) that a text begins with, read strictly, and
   * the text after it; null when the text does not begin with one. The date must end at a word boundary, so `4A 56`
   * is never read out of `4A 563`. Used only by the qualified reader (qualified.ts): a strict cell is read by `parse`.
   */
  leadingDate(
    text: string,
    style: DateTextStyle = DEFAULT_DATE_STYLE,
  ): { readonly date: ParsedDate; readonly match: string; readonly rest: string } | null {
    return this.edgeDate(text, style, 'lead');
  }

  /** v2 E6 (ADR 0048): the longest single date a text ends with, read strictly, and the text before it; or null. */
  trailingDate(
    text: string,
    style: DateTextStyle = DEFAULT_DATE_STYLE,
  ): { readonly date: ParsedDate; readonly match: string; readonly rest: string } | null {
    return this.edgeDate(text, style, 'tail');
  }

  private edgeDate(
    text: string,
    style: DateTextStyle,
    edge: 'lead' | 'tail',
  ): { date: ParsedDate; match: string; rest: string } | null {
    const t = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    let best: { date: ParsedDate; match: string; rest: string } | null = null;
    for (const f of this.forms) {
      const re = f[edge];
      if (!re) continue;
      const m = re.exec(t);
      if (!m) continue;
      // A year written with grouping commas may swallow a comma that ends the date (`4A 624, departure`).
      const raw = edge === 'lead' ? m[0].replace(/[\s,]+$/, '') : m[0].replace(/^[\s,]+/, '');
      const at = edge === 'lead' ? 0 : t.length - raw.length;
      const before = t.slice(0, at);
      const after = t.slice(at + raw.length);
      if (edge === 'lead' && /^[\p{L}\p{N}]/u.test(after)) continue;
      if (edge === 'tail' && /[\p{L}\p{N}]$/u.test(before)) continue;
      let date: ParsedDate;
      try {
        date = this.parse(raw, style);
      } catch {
        continue;
      }
      if (date.end !== null) continue;
      if (!best || raw.length > best.match.length)
        best = { date, match: raw, rest: edge === 'lead' ? after : before };
    }
    return best;
  }

  /** The forms this calendar accepts, each with an example built from the calendar (for refusals and the guide). */
  examples(): { form: DateForm; example: string }[] {
    const era = this.cal.eras[this.cal.eras.length - 1]!;
    const year = 2;
    const start = this.cal.yearStart(era, year);
    const m1 = 0;
    const m2 = Math.min(this.cal.definition.months.length - 1, 2);
    const at = (mi: number, d: number) =>
      this.cal.compose({ era, year, monthIndex: mi, day: Math.min(d, this.cal.monthLength(era, year, mi)) });
    const sample: Record<DateForm, { start: number; end: number | null }> = {
      day: { start: at(m1, 1), end: null },
      year: { start, end: null },
      'unknown-year': { start, end: null },
      month: { start: at(m1, 1), end: null },
      'date-range': { start: at(m1, 1), end: this.cal.yearStart(era, year + 1) },
      'day-range': { start: at(m1, 1), end: at(m1, 3) },
      'cross-month-range': { start: at(m1, 1), end: at(m2, 2) },
      'month-range': { start: at(m1, 1), end: at(m2, 1) },
      'month-range-full': { start: at(m1, 1), end: at(m2, 1) },
      'year-range': { start, end: this.cal.yearStart(era, year + 3) },
    };
    return this.forms.map((f) => ({
      form: f.form,
      example: this.render(f.form, sample[f.form].start, sample[f.form].end, DEFAULT_DATE_STYLE),
    }));
  }

  private tokenPattern(t: Token, end: 1 | 2, loose: boolean): string {
    const g = (name: string, body: string) => `(?<${name}${end}>${body})`;
    const word = `\\p{L}[\\p{L}'’.\\-]*(?:\\s+\\p{L}[\\p{L}'’.\\-]*)*?`;
    switch (t.kind) {
      case 'lit':
        return literalPattern(t.text);
      case 'year':
        return g('year', `\\d[\\d,]*`) + (t.ordinal ? `(?:st|nd|rd|th)?` : '');
      case 'era':
        return g('era', loose ? `[\\p{L}\\p{N}.'’\\-]+?` : this.names.eras || '(?!)');
      case 'eraName':
        return g('eraName', loose ? word : this.names.eraNames || '(?!)');
      case 'month':
        return g('month', loose ? word : this.names.months);
      case 'monthAbbr':
        return g('monthAbbr', loose ? `\\p{L}+` : this.names.monthAbbrs);
      case 'monthNum':
        return g('monthNum', `\\d{1,2}`) + (t.ordinal ? `(?:st|nd|rd|th)?` : '');
      case 'day':
        return g('day', `\\d{1,3}`) + `(?:st|nd|rd|th)?`;
      case 'weekday':
        return `(?:${loose || !this.names.weekdays ? '\\p{L}+' : this.names.weekdays})`;
      case 'weekdayAbbr':
        return `(?:${loose || !this.names.weekdayAbbrs ? '\\p{L}+' : this.names.weekdayAbbrs})`;
      case 'hour':
        return g('hour', `\\d{1,2}`);
      case 'minute':
        return g('minute', `\\d{1,2}`);
    }
  }

  private source(segments: readonly Segment[], loose: boolean): string {
    let s = '';
    for (const seg of segments) {
      if ('range' in seg) s += `\\s*[-–—−]\\s*`;
      else if ('lit' in seg) s += seg.re;
      else for (const t of seg.tokens) s += this.tokenPattern(t, seg.end, loose);
    }
    return s.replace(/(?:\\s[*+]){2,}/g, (run) => (run.includes('\\s*') ? '\\s*' : '\\s+'));
  }

  // ------------------------------------------------------------------------------------------------ parsing

  /** Parses a date in any accepted form, or refuses with a precise reason. */
  parse(input: string, style: DateTextStyle = DEFAULT_DATE_STYLE): ParsedDate {
    const text = input.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (text === '') throw new CalendarError('DATE_EMPTY', 'No date was given.');
    if (/^unknown[.,]?$/i.test(text)) {
      throw new CalendarError(
        'DATE_UNKNOWN_ALONE',
        '“Unknown” alone is not a date: give at least the year, as “Unknown, <era> <year>” (stored as year-only).',
        { forms: this.examples() },
      );
    }
    for (const f of this.forms) {
      const m = f.strict!.exec(text);
      if (m) return this.build(f.form, m.groups ?? {}, input, style);
    }
    this.diagnose(text);
    throw new CalendarError(
      'DATE_UNRECOGNISED',
      `“${text}” is not a date in a form the calendar “${this.cal.name}” accepts. Accepted forms: ${this.examples()
        .map((e) => `“${e.example}”`)
        .join(', ')}.`,
      { forms: this.examples() },
    );
  }

  /** A form matched loosely: name the month or era the calendar does not have. */
  private diagnose(text: string): void {
    for (const f of this.forms) {
      const m = f.loose!.exec(text);
      if (!m) continue;
      const groups = m.groups ?? {};
      for (const [k, v] of Object.entries(groups)) {
        if (v === undefined) continue;
        if (k.startsWith('month') && !k.startsWith('monthNum') && this.monthIndex(v) === null) {
          throw new CalendarError(
            'DATE_UNKNOWN_MONTH',
            `“${v}” is not a month of the calendar “${this.cal.name}”. Its months are: ${this.cal.months.join(', ')}.`,
            { month: v, months: this.cal.months },
          );
        }
        if (k.startsWith('era') && !k.startsWith('eraName') && this.cal.eraByAbbr(v).length === 0) {
          throw new CalendarError(
            'DATE_UNKNOWN_ERA',
            `“${v}” is not an era of the calendar “${this.cal.name}”. Its eras are: ${this.cal.eras
              .map((e) => `${e.abbr} (${e.name})`)
              .join(', ')}.`,
            { era: v, eras: this.cal.eras.map((e) => e.abbr) },
          );
        }
      }
    }
  }

  private monthIndex(name: string): number | null {
    const n = norm(name);
    const months = this.cal.definition.months;
    let i = months.findIndex((m) => norm(m.name) === n);
    if (i < 0) i = months.findIndex((m) => norm(m.name.slice(0, 3)) === n);
    return i < 0 ? null : i;
  }

  private era(abbr: string | undefined, name: string | undefined): Era {
    if (abbr !== undefined) {
      const hits = this.cal.eraByAbbr(abbr);
      if (hits.length === 1) return hits[0]!;
      throw new CalendarError(
        hits.length === 0 ? 'DATE_UNKNOWN_ERA' : 'CALENDAR_UNSUPPORTED',
        hits.length === 0
          ? `“${abbr}” is not an era of the calendar “${this.cal.name}”.`
          : `Several eras of the calendar “${this.cal.name}” are written “${abbr}”; dates in them cannot be told apart.`,
        { era: abbr },
      );
    }
    if (name !== undefined) {
      const hit = this.cal.eras.find((e) => norm(e.name) === norm(name));
      if (hit) return hit;
      throw new CalendarError(
        'DATE_UNKNOWN_ERA',
        `“${name}” is not an era of the calendar “${this.cal.name}”.`,
      );
    }
    const shown = this.cal.eras.filter((e) => !e.hideAbbr);
    if (this.cal.eras.length === 1) return this.cal.eras[0]!;
    throw new CalendarError(
      'DATE_UNRECOGNISED',
      `The date names no era; the calendar “${this.cal.name}” has ${shown.length} (${shown.map((e) => e.abbr).join(', ')}).`,
    );
  }

  private year(text: string | undefined): number {
    if (text === undefined) throw new CalendarError('DATE_UNRECOGNISED', 'The date names no year.');
    if (!/^\d+$/.test(text) && !/^\d{1,3}(,\d{3})+$/.test(text)) {
      throw new CalendarError(
        'DATE_INVALID_YEAR',
        `“${text}” is not a year: write it with no commas or with a comma every three digits (1,988,119).`,
        { year: text },
      );
    }
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isSafeInteger(n))
      throw new CalendarError('DATE_INVALID_YEAR', `“${text}” is too large a year.`);
    return n;
  }

  private month(groups: Record<string, string | undefined>, end: 1 | 2): number | null {
    const name = groups[`month${end}`] ?? groups[`monthAbbr${end}`];
    if (name !== undefined) {
      const i = this.monthIndex(name);
      if (i === null) {
        throw new CalendarError(
          'DATE_UNKNOWN_MONTH',
          `“${name}” is not a month of the calendar “${this.cal.name}”. Its months are: ${this.cal.months.join(', ')}.`,
          { month: name, months: this.cal.months },
        );
      }
      return i;
    }
    const num = groups[`monthNum${end}`];
    if (num !== undefined) {
      const i = Number(num) - 1;
      if (i < 0 || i >= this.cal.definition.months.length)
        throw new CalendarError('DATE_UNKNOWN_MONTH', `The calendar has no month ${num}.`);
      return i;
    }
    return null;
  }

  private dayStr(minute: number): string {
    return this.cal.format(minute, 3);
  }

  /** The refusal for a minute outside its era, naming where the era begins or ends. */
  private outside(what: string, era: Era, minute: number): CalendarError {
    const first = Math.max(era.startsAt, this.cal.minMinute);
    if (minute < first) {
      return new CalendarError(
        'DATE_OUTSIDE_ERA',
        era.negative
          ? `${what} is before the calendar “${this.cal.name}” begins (${this.dayStr(first)}).`
          : `${what} is before the ${era.name} (${era.abbr}) begins, on ${this.dayStr(first)}.`,
        { era: era.abbr, begins: this.dayStr(first) },
      );
    }
    const next = this.cal.eras[era.index + 1];
    if (next && minute >= next.startsAt) {
      return new CalendarError(
        'DATE_OUTSIDE_ERA',
        `${what} is after the ${era.name} (${era.abbr}) ends: the ${next.name} (${next.abbr}) begins on ${this.dayStr(next.startsAt)}. Write it in ${next.abbr}.`,
        { era: era.abbr, nextEra: next.abbr, nextBegins: this.dayStr(next.startsAt) },
      );
    }
    return new CalendarError(
      'DATE_OUTSIDE_ERA',
      `${what} is past the end of the calendar “${this.cal.name}” (${this.dayStr(this.cal.maxMinute)}).`,
      { era: era.abbr },
    );
  }

  private inEra(era: Era, minute: number): boolean {
    return minute >= Math.max(era.startsAt, this.cal.minMinute) && minute <= this.cal.eraLast(era);
  }

  /** A span [from, to) at year or month detail, clamped to begin no earlier than its era (the era's first year). */
  private clamp(what: string, era: Era, from: number, to: number): number {
    const first = Math.max(era.startsAt, this.cal.minMinute);
    if (to <= first || from > this.cal.eraLast(era)) throw this.outside(what, era, from);
    return Math.max(from, first);
  }

  private dayMinute(what: string, era: Era, year: number, monthIndex: number, day: number): number {
    const m = this.cal.compose({ era, year, monthIndex, day });
    if (!this.inEra(era, m)) throw this.outside(what, era, m);
    return m;
  }

  private build(
    form: DateForm,
    groups: Record<string, string | undefined>,
    input: string,
    style: DateTextStyle,
  ): ParsedDate {
    // An end that names no era or year (compressed forms) takes the start's.
    const era1 = this.era(groups.era1, groups.eraName1);
    const year1 = this.year(groups.year1);
    const has2 = groups.era2 !== undefined || groups.eraName2 !== undefined;
    const era2 = has2 ? this.era(groups.era2, groups.eraName2) : era1;
    const year2 = groups.year2 !== undefined ? this.year(groups.year2) : year1;
    const mon1 = this.month(groups, 1);
    const mon2 = this.month(groups, 2) ?? mon1;
    const day1 = groups.day1 !== undefined ? Number(groups.day1) : null;
    const day2 = groups.day2 !== undefined ? Number(groups.day2) : null;
    const label = (e: Era, y: number, mi: number | null, d: number | null) => {
      const ym = `${e.abbr} ${y}`;
      if (mi === null) return ym;
      const mn = this.cal.definition.months[mi]!.name;
      return d === null ? `${mn} ${ym}` : `${mn} ${d}, ${ym}`;
    };
    const shape = SHAPE[form];
    let start: number;
    let end: number | null = null;
    switch (shape) {
      case 'day':
      case 'date-range': {
        start = this.dayMinute(label(era1, year1, mon1, day1), era1, year1, mon1!, day1!);
        if (shape === 'date-range')
          end = this.dayMinute(label(era2, year2, mon2, day2), era2, year2, mon2!, day2!);
        break;
      }
      case 'month-only':
      case 'month-range': {
        const s = this.cal.monthStart(era1, year1, mon1!);
        start = this.clamp(label(era1, year1, mon1, null), era1, s, this.cal.monthEnd(era1, year1, mon1!));
        if (shape === 'month-range') {
          const s2 = this.cal.monthStart(era2, year2, mon2!);
          end = this.clamp(label(era2, year2, mon2, null), era2, s2, this.cal.monthEnd(era2, year2, mon2!));
        }
        break;
      }
      case 'year-only':
      case 'year-range': {
        start = this.clamp(
          label(era1, year1, null, null),
          era1,
          this.cal.yearStart(era1, year1),
          this.cal.yearEnd(era1, year1),
        );
        if (shape === 'year-range')
          end = this.clamp(
            label(era2, year2, null, null),
            era2,
            this.cal.yearStart(era2, year2),
            this.cal.yearEnd(era2, year2),
          );
        break;
      }
    }
    if (end !== null && end <= start) {
      throw new CalendarError(
        'DATE_RANGE_REVERSED',
        end === start
          ? `The range “${input.trim()}” ends where it begins; give a single date instead.`
          : `The range “${input.trim()}” ends before it begins; write the earlier date first.`,
        { start, end },
      );
    }
    return this.result(form, start, end, input, style);
  }

  /** The parse result for minutes in a form. */
  result(form: DateForm, start: number, end: number | null, input: string, style: DateTextStyle): ParsedDate {
    const shape = SHAPE[form];
    const detail = DETAIL[shape];
    const a = this.cal.resolve(start);
    const b = end !== null ? this.cal.resolve(end) : null;
    const tableText = this.render(form, start, end, style);
    return {
      input,
      form,
      shape,
      detail,
      start,
      end,
      era: a.era,
      endEra: b?.era ?? null,
      startDate: this.cal.eventDate(start),
      endDate: end !== null ? this.cal.eventDate(end) : null,
      kcy: { start: a.kcy, end: b?.kcy ?? null },
      formattedStart: this.cal.format(start, detail),
      formattedEnd: end !== null ? this.cal.format(end, detail) : null,
      formatted:
        end !== null
          ? `${this.cal.format(start, detail)}${LK_DATE_STYLE.rangeSeparator}${this.cal.format(end, detail)}`
          : this.cal.format(start, detail),
      text: tableText,
      tableFormatted: tableText,
    };
  }

  /** The date written in a form, with the calendar's names (the inverse of `parse` for valid dates). */
  render(form: DateForm, start: number, end: number | null, style: DateTextStyle): string {
    const o = { yearGrouping: style.yearGrouping };
    const a = this.cal.resolve(start);
    const b = end !== null ? this.cal.resolve(end) : null;
    const { day, month, year } = this.cal.formats;
    const r = (tokens: readonly Token[], m: typeof a) => this.cal.render(tokens, m, o);
    const RS = style.rangeSeparator;
    const sp = this.split;
    const need = <T>(v: T | null): T => {
      if (v === null) throw new CalendarError('DATE_UNRECOGNISED', `The form ${form} needs an end date.`);
      return v;
    };
    switch (form) {
      case 'day':
        return r(day, a);
      case 'year':
        return r(year, a);
      case 'unknown-year':
        return `Unknown${sp?.sep ?? ', '}${r(year, a)}`;
      case 'month':
        return r(month, a);
      case 'date-range':
        return `${r(day, a)}${RS}${r(day, need(b))}`;
      case 'year-range':
        return `${r(year, a)}${RS}${r(year, need(b))}`;
      case 'month-range-full':
        return `${r(month, a)}${RS}${r(month, need(b))}`;
      default: {
        if (!sp) return `${r(day, a)}${RS}${r(day, need(b))}`;
        const tail = r(sp.tail, a);
        if (form === 'day-range') {
          const dayAt = sp.head.findIndex((t) => t.kind === 'day');
          return `${r(sp.head, a)}${RS}${r(sp.head.slice(dayAt), need(b))}${sp.sep}${tail}`;
        }
        if (form === 'cross-month-range')
          return `${r(sp.head, a)}${RS}${r(sp.head, need(b))}${sp.sep}${tail}`;
        const monthAt = sp.head.findIndex(
          (t) => t.kind === 'month' || t.kind === 'monthAbbr' || t.kind === 'monthNum',
        );
        const mp = sp.head.slice(0, monthAt + 1);
        return `${r(mp, a)}${RS}${r(mp, need(b))}${sp.sep}${tail}`;
      }
    }
  }

  /**
   * The form a date with these minutes and detail is best written in (for a date given as minutes, or an event read
   * from a timeline): the compressed forms when both ends share a year (and a month), the full ones otherwise.
   */
  formFor(start: number, end: number | null, detail: Detail): DateForm {
    const a = this.cal.resolve(start);
    const shape: EventShape =
      detail <= 1
        ? end !== null
          ? 'year-range'
          : 'year-only'
        : detail === 2
          ? end !== null
            ? 'month-range'
            : 'month-only'
          : end !== null
            ? 'date-range'
            : 'day';
    if (end === null) return shape === 'year-only' ? 'year' : shape === 'month-only' ? 'month' : 'day';
    const b = this.cal.resolve(end);
    const sameYear = a.era.id === b.era.id && a.year === b.year;
    const has = (f: DateForm) => this.forms.some((x) => x.form === f);
    if (shape === 'year-range') return 'year-range';
    if (shape === 'month-range') return sameYear && has('month-range') ? 'month-range' : 'month-range-full';
    if (sameYear && a.monthIndex === b.monthIndex && has('day-range')) return 'day-range';
    if (sameYear && has('cross-month-range')) return 'cross-month-range';
    return 'date-range';
  }

  /** The forms this calendar accepts. */
  get acceptedForms(): readonly DateForm[] {
    return this.forms.map((f) => f.form);
  }
}

export { tokenize };
