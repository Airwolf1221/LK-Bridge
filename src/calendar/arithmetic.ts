/**
 * Date arithmetic from a LegendKeeper calendar definition (v2 D1, PLAN-v2 4.8, ADR 0038): minutes from the epoch to and
 * from years, months and days, for any calendar the API can describe: months that occur every N years (`interval`,
 * `offset`), leap days with their `400,!100,4` rules, a year 0 or none, eras counting backwards before the epoch, and
 * forward eras that keep counting, restart their year numbering (`year`) or restart the whole date (`calendar`).
 *
 * Years are counted in a FRAME: the epoch frame (minute 0 begins the first year; the negative era counts back from it)
 * or, for a `calendar` era, a frame of its own beginning at the era's first minute. A frame's year index `y0` is 0 for
 * the year beginning at the frame's base, negative before it. A year's LABEL (the signed year number the calendar's
 * month and leap rules read) is `y0 + 1` from the base on (`y0` when the calendar has a year 0) and `y0` before it.
 *
 * Every year rule repeats with a period L (the least common multiple of the rules' intervals), separately on each side
 * of the base (the label is a fixed shift of `y0` there), so converting a minute to a year never walks the years: a
 * cycle of L years is summed once.
 */
import { CalendarError } from './errors.js';
import type { CalendarDefinition } from './definition.js';

/** One term of a leap-day interval: every `every` years (shifted by `offset`); `exclude` removes those years. */
interface LeapTerm {
  readonly every: number;
  readonly offset: number;
  readonly exclude: boolean;
}

interface LeapRule {
  readonly month: number;
  readonly terms: readonly LeapTerm[];
  readonly offset: number;
}

interface MonthRule {
  readonly length: number;
  readonly interval: number;
  readonly offset: number;
}

const MAX_CYCLE = 100_000;

const mod = (a: number, n: number) => ((a % n) + n) % n;
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

/** Parses a leap day's `interval` (`4`, `400,!100,4`, `4+1`). */
export function parseLeapInterval(text: string): LeapTerm[] {
  const terms: LeapTerm[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim();
    if (t === '') continue;
    const m = /^(!?)\s*(\d+)\s*(?:\+\s*(-?\d+))?$/.exec(t);
    if (!m)
      throw new CalendarError(
        'CALENDAR_UNSUPPORTED',
        `A leap-day rule “${text}” cannot be read (term “${t}”).`,
      );
    const every = Number(m[2]);
    if (!Number.isInteger(every) || every < 1)
      throw new CalendarError('CALENDAR_UNSUPPORTED', `A leap-day rule “${text}” has an interval below 1.`);
    terms.push({ every, offset: m[3] ? Number(m[3]) : 0, exclude: m[1] === '!' });
  }
  return terms;
}

/** The calendar's year rules: which months a year has, and how long each is. */
export class YearRules {
  readonly months: readonly MonthRule[];
  private readonly leaps: readonly LeapRule[];
  readonly hasZeroYear: boolean;
  /** Every rule repeats with this many years. */
  readonly cycle: number;
  readonly minutesPerDay: number;

  constructor(def: CalendarDefinition) {
    this.months = def.months.map((m) => ({
      length: m.length,
      interval: m.interval ?? 1,
      offset: m.offset ?? 0,
    }));
    this.leaps = (def.leapDays ?? []).map((l) => {
      if (l.month >= def.months.length)
        throw new CalendarError(
          'CALENDAR_UNSUPPORTED',
          `A leap day names month ${l.month}, which the calendar does not have.`,
        );
      return { month: l.month, terms: parseLeapInterval(l.interval), offset: l.offset ?? 0 };
    });
    this.hasZeroYear = def.hasZeroYear === true;
    this.minutesPerDay = def.hoursInDay * def.minutesInHour;
    let cycle = 1;
    for (const m of this.months) if (m.interval > 1) cycle = lcm(cycle, m.interval);
    for (const l of this.leaps) for (const t of l.terms) cycle = lcm(cycle, t.every);
    if (cycle > MAX_CYCLE)
      throw new CalendarError(
        'CALENDAR_UNSUPPORTED',
        `The calendar's month and leap-day rules repeat only every ${cycle} years; the engine handles up to ${MAX_CYCLE}.`,
      );
    this.cycle = cycle;
  }

  /** Whether month `index` occurs in the year labelled `label`. */
  hasMonth(label: number, index: number): boolean {
    const m = this.months[index];
    if (!m) return false;
    return m.interval <= 1 || mod(label - m.offset, m.interval) === 0;
  }

  private leapApplies(rule: LeapRule, label: number): boolean {
    for (const t of rule.terms) {
      if (mod(label - rule.offset - t.offset, t.every) === 0) return !t.exclude;
    }
    return false;
  }

  /** Days in month `index` of the year labelled `label` (0 when the month does not occur that year). */
  monthLength(label: number, index: number): number {
    if (!this.hasMonth(label, index)) return 0;
    let n = this.months[index]!.length;
    for (const l of this.leaps) if (l.month === index && this.leapApplies(l, label)) n++;
    return n;
  }

  /** Days in the year labelled `label`. */
  yearLength(label: number): number {
    let n = 0;
    for (let i = 0; i < this.months.length; i++) n += this.monthLength(label, i);
    return n;
  }

  /** Days before month `index` in the year labelled `label`. */
  daysBeforeMonth(label: number, index: number): number {
    let n = 0;
    for (let i = 0; i < index; i++) n += this.monthLength(label, i);
    return n;
  }

  /** The month (index) and day (1-based) of day `doy` (0-based) of the year labelled `label`. */
  monthDay(label: number, doy: number): { monthIndex: number; day: number } {
    let d = doy;
    for (let i = 0; i < this.months.length; i++) {
      const len = this.monthLength(label, i);
      if (d < len) return { monthIndex: i, day: d + 1 };
      d -= len;
    }
    throw new CalendarError('DATE_OUT_OF_RANGE', `Day ${doy} is past the end of year ${label}.`);
  }
}

/**
 * A frame of years (see the module comment): the epoch frame, or a `calendar` era's own. Year index `y0` counts from
 * the frame's base; `labelOf(y0)` is the year number the rules read.
 */
export class YearFrame {
  private readonly posCycleDays: number;
  private readonly posPrefix: number[];
  private readonly negCycleDays: number;
  private readonly negPrefix: number[];

  constructor(
    readonly rules: YearRules,
    /** The frame's first minute. */
    readonly base: number,
  ) {
    const L = rules.cycle;
    this.posPrefix = [0];
    for (let k = 0; k < L; k++) this.posPrefix.push(this.posPrefix[k]! + rules.yearLength(this.labelOf(k)));
    this.posCycleDays = this.posPrefix[L]!;
    this.negPrefix = [0];
    for (let j = 1; j <= L; j++)
      this.negPrefix.push(this.negPrefix[j - 1]! + rules.yearLength(this.labelOf(-j)));
    this.negCycleDays = this.negPrefix[L]!;
    if (this.posCycleDays <= 0 || this.negCycleDays <= 0)
      throw new CalendarError('CALENDAR_UNSUPPORTED', 'The calendar has years with no days.');
  }

  /** The year number (label) of year index `y0`. */
  labelOf(y0: number): number {
    if (y0 >= 0) return this.rules.hasZeroYear ? y0 : y0 + 1;
    return y0;
  }

  /** The year index of a label (the inverse of `labelOf`); null for 0 in a calendar without year 0. */
  indexOf(label: number): number | null {
    if (label > 0) return this.rules.hasZeroYear ? label : label - 1;
    if (label === 0) return this.rules.hasZeroYear ? 0 : null;
    return label;
  }

  /** Days from the frame's base to the first day of year index `y0` (negative before the base). */
  startDay(y0: number): number {
    const L = this.rules.cycle;
    if (y0 >= 0) return Math.floor(y0 / L) * this.posCycleDays + this.posPrefix[y0 % L]!;
    const n = -y0;
    return -(Math.floor(n / L) * this.negCycleDays + this.negPrefix[n % L]!);
  }

  /** The year index holding day `d` (days from the base), and the day of that year (0-based). */
  yearOfDay(d: number): { y0: number; doy: number } {
    const L = this.rules.cycle;
    if (d >= 0) {
      const q = Math.floor(d / this.posCycleDays);
      const rem = d - q * this.posCycleDays;
      let r = 0;
      while (r < L - 1 && this.posPrefix[r + 1]! <= rem) r++;
      const y0 = q * L + r;
      return { y0, doy: d - this.startDay(y0) };
    }
    const e = -d;
    const q = Math.floor((e - 1) / this.negCycleDays);
    const rem = e - q * this.negCycleDays;
    let r = 1;
    while (r < L && this.negPrefix[r]! < rem) r++;
    const y0 = -(q * L + r);
    return { y0, doy: d - this.startDay(y0) };
  }
}
