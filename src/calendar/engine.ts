/**
 * The calendar engine (v2 D1, PLAN-v2 4.8, ADR 0038): built from a LegendKeeper calendar definition, it turns minutes
 * from the epoch into dates (era, year, month, day) and back, works out KCY (the continuous year count with no era
 * resets), and formats a minute exactly as LegendKeeper's `formattedStart` does, from the calendar's own templates.
 * Parsing the owner's date forms is in parse.ts; the table's KCY and date cells in kcy.ts.
 */
import { YearFrame, YearRules } from './arithmetic.js';
import {
  calendarDefinitionSchema,
  DEFAULT_FORMAT,
  eraRef,
  type CalendarDefinition,
  type Era,
  type EraRef,
} from './definition.js';
import { CalendarError } from './errors.js';
import { groupDigits, ordinal, tokenize, type Token } from './template.js';

/** LegendKeeper's `detail`: 1 year, 2 month, 3 day, 4 time. */
export type Detail = 1 | 2 | 3 | 4;

/** A minute resolved into the calendar. */
export interface Moment {
  /** Minutes from the epoch. */
  readonly minute: number;
  readonly era: Era;
  /** The year as the era displays it (counting down in the negative era). */
  readonly year: number;
  /** Zero-based index into the calendar's months. */
  readonly monthIndex: number;
  /** 1-based. */
  readonly day: number;
  readonly hour: number;
  readonly minuteOfHour: number;
  /** The continuous year (the epoch frame's year number): KCY. */
  readonly kcy: number;
  /** Days from the epoch to this date (for weekdays). */
  readonly epochDay: number;
}

/** LegendKeeper's `EventDate`. */
export interface EventDate {
  readonly year: number;
  readonly month: number;
  readonly monthName: string;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly era: EraRef;
}

/** Formatting choices LegendKeeper's text does not settle by itself (ADR 0038): the year's thousands separator. */
export interface FormatOptions {
  /** Between groups of three digits of a year (`1,988,119`); `''` for none. Default `,`. */
  readonly yearGrouping?: string;
}

export interface DateFields {
  readonly era: Era;
  readonly year: number;
  readonly monthIndex: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
}

export class CalendarEngine {
  readonly definition: CalendarDefinition;
  readonly id: string;
  readonly name: string;
  /** Earliest first: the negative era (if any), then the forward eras. */
  readonly eras: readonly Era[];
  readonly rules: YearRules;
  readonly minutesPerDay: number;
  readonly minutesInHour: number;
  readonly hoursInDay: number;
  readonly formats: {
    readonly year: Token[];
    readonly month: Token[];
    readonly day: Token[];
    readonly time: Token[];
  };
  readonly formatText: {
    readonly year: string;
    readonly month: string;
    readonly day: string;
    readonly time: string;
  };
  private readonly epoch: YearFrame;
  private readonly frames = new Map<string, YearFrame>();
  readonly minMinute: number;
  readonly maxMinute: number;

  private constructor(def: CalendarDefinition) {
    this.definition = def;
    this.id = def.id;
    this.name = def.name;
    this.rules = new YearRules(def);
    this.minutesPerDay = this.rules.minutesPerDay;
    this.minutesInHour = def.minutesInHour;
    this.hoursInDay = def.hoursInDay;
    this.epoch = new YearFrame(this.rules, 0);
    const eras: Era[] = [];
    const pos = [...def.positiveEras];
    for (let i = 1; i < pos.length; i++) {
      if (pos[i]!.startsAt <= pos[i - 1]!.startsAt)
        throw new CalendarError(
          'CALENDAR_UNSUPPORTED',
          'The forward eras are not in ascending startsAt order.',
        );
    }
    if (def.negativeEra) {
      const n = def.negativeEra;
      if (n.resetMode !== undefined && n.resetMode !== 'none')
        throw new CalendarError(
          'CALENDAR_UNSUPPORTED',
          `The negative era's reset mode “${n.resetMode}” is not known.`,
        );
      eras.push({
        id: n.id,
        name: n.name,
        abbr: n.abbr ?? 'AD',
        hideAbbr: n.hideAbbr === true,
        startsAt: n.startsAt,
        endsBefore: pos[0]!.startsAt,
        negative: true,
        resetMode: 'none',
        index: 0,
      });
    }
    pos.forEach((e, i) => {
      eras.push({
        id: e.id,
        name: e.name,
        abbr: e.abbr ?? 'AD',
        hideAbbr: e.hideAbbr === true,
        startsAt: e.startsAt,
        endsBefore: pos[i + 1]?.startsAt ?? null,
        negative: false,
        resetMode: e.resetMode ?? 'none',
        index: eras.length,
      });
    });
    this.eras = eras;
    for (const e of eras)
      if (e.resetMode === 'calendar') this.frames.set(e.id, new YearFrame(this.rules, e.startsAt));
    this.minMinute = def.negativeEra ? def.negativeEra.startsAt : pos[0]!.startsAt;
    this.maxMinute = typeof def.maxMinutes === 'number' ? def.maxMinutes : Number.MAX_SAFE_INTEGER;
    const f = def.format ?? DEFAULT_FORMAT;
    this.formatText = { year: f.year, month: f.month, day: f.day, time: f.time };
    this.formats = {
      year: tokenize(f.year),
      month: tokenize(f.month),
      day: tokenize(f.day),
      time: tokenize(f.time),
    };
  }

  /** Builds the engine from a definition as `listCalendars` returns it; refuses one it cannot use. */
  static fromDefinition(raw: unknown): CalendarEngine {
    const r = calendarDefinitionSchema.safeParse(raw);
    if (!r.success) {
      throw new CalendarError(
        'CALENDAR_UNSUPPORTED',
        `The calendar definition cannot be read: ${r.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}.`,
      );
    }
    return new CalendarEngine(r.data);
  }

  get months(): readonly string[] {
    return this.definition.months.map((m) => m.name);
  }

  // ------------------------------------------------------------------------------------------------ eras

  /** The era a minute belongs to, or null outside the calendar. */
  eraAt(minute: number): Era | null {
    if (minute < this.minMinute || minute > this.maxMinute) return null;
    let found: Era | null = null;
    for (const e of this.eras) if (e.startsAt <= minute) found = e;
    return found;
  }

  /** The era a year label of the epoch frame (KCY) begins in, by era. */
  eraByAbbr(abbr: string): Era[] {
    const a = abbr.trim().toLowerCase();
    return this.eras.filter((e) => e.abbr.toLowerCase() === a);
  }

  // ------------------------------------------------------------------------------------------------ minutes → date

  private frameFor(era: Era): YearFrame {
    return this.frames.get(era.id) ?? this.epoch;
  }

  /** The continuous year (KCY) holding a minute: the epoch frame's year number. */
  kcyOf(minute: number): number {
    const day = Math.floor(minute / this.minutesPerDay);
    return this.epoch.labelOf(this.epoch.yearOfDay(day).y0);
  }

  /** Resolves a minute into its era, year, month, day and time. */
  resolve(minute: number): Moment {
    if (!Number.isFinite(minute) || !Number.isInteger(minute))
      throw new CalendarError('DATE_OUT_OF_RANGE', `${minute} is not a whole number of minutes.`);
    const era = this.eraAt(minute);
    if (!era) {
      throw new CalendarError(
        'DATE_OUT_OF_RANGE',
        `Minute ${minute} is outside the calendar “${this.name}” (minutes ${this.minMinute} to ${this.maxMinute}).`,
        { minute, min: this.minMinute, max: this.maxMinute },
      );
    }
    const frame = this.frameFor(era);
    const rel = minute - frame.base;
    const day = Math.floor(rel / this.minutesPerDay);
    const inDay = rel - day * this.minutesPerDay;
    const { y0, doy } = frame.yearOfDay(day);
    const label = frame.labelOf(y0);
    const { monthIndex, day: dom } = this.rules.monthDay(label, doy);
    const kcy = this.kcyOf(minute);
    return {
      minute,
      era,
      year: this.displayYear(era, label, kcy),
      monthIndex,
      day: dom,
      hour: Math.floor(inDay / this.minutesInHour),
      minuteOfHour: inDay % this.minutesInHour,
      kcy,
      epochDay: Math.floor(minute / this.minutesPerDay),
    };
  }

  /** The year an era displays for a year of its frame (`label`; the epoch frame's is also the KCY). */
  private displayYear(era: Era, label: number, kcy: number): number {
    if (era.negative) return -kcy;
    if (era.resetMode === 'calendar') return label;
    if (era.resetMode === 'year') return kcy - this.kcyOf(era.startsAt) + 1;
    return kcy;
  }

  /** LegendKeeper's `EventDate` for a minute. */
  eventDate(minute: number): EventDate {
    const m = this.resolve(minute);
    return {
      year: m.year,
      month: m.monthIndex + 1,
      monthName: this.definition.months[m.monthIndex]!.name,
      day: m.day,
      hour: m.hour,
      minute: m.minuteOfHour,
      era: eraRef(m.era),
    };
  }

  // ------------------------------------------------------------------------------------------------ date → minutes

  /**
   * The frame and year index of an era's year, or the refusal. A year of an era is a year of its frame: the negative
   * era counts back from the epoch, `none` counts on from it, `year` restarts at 1 in the year the era begins, and
   * `calendar` restarts the whole date at the era's first minute.
   */
  yearIndex(era: Era, year: number): { frame: YearFrame; y0: number; label: number } {
    const frame = this.frameFor(era);
    if (!Number.isInteger(year) || year < 0)
      throw new CalendarError('DATE_INVALID_YEAR', `Year ${year} is not a year of ${era.name}.`);
    let label: number;
    if (era.negative) {
      if (year < 1)
        throw new CalendarError('DATE_INVALID_YEAR', `${era.name} has no year 0; its years count down to 1.`);
      label = -year;
    } else if (era.resetMode === 'year') {
      if (year < 1) throw new CalendarError('DATE_INVALID_YEAR', `${era.name} begins with year 1.`);
      label = this.kcyOf(era.startsAt) + year - 1;
    } else label = year;
    const y0 = frame.indexOf(label);
    if (y0 === null)
      throw new CalendarError(
        'DATE_INVALID_YEAR',
        `The calendar “${this.name}” has no year 0 (${era.abbr} 0).`,
      );
    return { frame, y0, label };
  }

  /** The first minute of an era's year (before any clamping to the era). */
  yearStart(era: Era, year: number): number {
    const { frame, y0 } = this.yearIndex(era, year);
    return frame.base + frame.startDay(y0) * this.minutesPerDay;
  }

  /** The first minute after an era's year. */
  yearEnd(era: Era, year: number): number {
    const { frame, y0 } = this.yearIndex(era, year);
    return frame.base + frame.startDay(y0 + 1) * this.minutesPerDay;
  }

  /** Days in a month of an era's year (0 when it does not occur that year). */
  monthLength(era: Era, year: number, monthIndex: number): number {
    return this.rules.monthLength(this.yearIndex(era, year).label, monthIndex);
  }

  /**
   * The minute of a date, with no era check (the caller checks it against the era). Refuses a day the month does not
   * have, or a month that does not occur that year.
   */
  compose(f: DateFields): number {
    const { frame, y0, label } = this.yearIndex(f.era, f.year);
    const months = this.definition.months;
    const month = months[f.monthIndex];
    if (!month)
      throw new CalendarError('DATE_UNKNOWN_MONTH', `The calendar has no month ${f.monthIndex + 1}.`);
    const len = this.rules.monthLength(label, f.monthIndex);
    if (len === 0) {
      throw new CalendarError(
        'DATE_IMPOSSIBLE_DAY',
        `${month.name} does not occur in ${f.era.abbr} ${f.year} (it comes every ${month.interval} years).`,
        { month: month.name, era: f.era.abbr, year: f.year },
      );
    }
    if (!Number.isInteger(f.day) || f.day < 1 || f.day > len) {
      throw new CalendarError(
        'DATE_IMPOSSIBLE_DAY',
        `${month.name} has ${len} days${len !== month.length ? ` in ${f.era.abbr} ${f.year}` : ''}; there is no day ${f.day}.`,
        { month: month.name, days: len, day: f.day },
      );
    }
    const hour = f.hour ?? 0;
    const min = f.minute ?? 0;
    if (hour < 0 || hour >= this.hoursInDay || min < 0 || min >= this.minutesInHour)
      throw new CalendarError('DATE_IMPOSSIBLE_DAY', `${hour}:${min} is not a time of day in this calendar.`);
    const day = frame.startDay(y0) + this.rules.daysBeforeMonth(label, f.monthIndex) + f.day - 1;
    return frame.base + day * this.minutesPerDay + hour * this.minutesInHour + min;
  }

  /** The first minute of a month of an era's year. */
  monthStart(era: Era, year: number, monthIndex: number): number {
    const { frame, y0, label } = this.yearIndex(era, year);
    if (this.rules.monthLength(label, monthIndex) === 0) {
      const m = this.definition.months[monthIndex]!;
      throw new CalendarError('DATE_IMPOSSIBLE_DAY', `${m.name} does not occur in ${era.abbr} ${year}.`);
    }
    return (
      frame.base + (frame.startDay(y0) + this.rules.daysBeforeMonth(label, monthIndex)) * this.minutesPerDay
    );
  }

  /** The first minute after a month of an era's year. */
  monthEnd(era: Era, year: number, monthIndex: number): number {
    return (
      this.monthStart(era, year, monthIndex) + this.monthLength(era, year, monthIndex) * this.minutesPerDay
    );
  }

  /** The era's last minute (inclusive): the next era's first minute less one, or the calendar's end. */
  eraLast(era: Era): number {
    return era.endsBefore !== null ? era.endsBefore - 1 : this.maxMinute;
  }

  /** The KCY values an era's years run over: [first, last]. */
  eraKcyRange(era: Era): [number, number] {
    return [this.kcyOf(era.startsAt), this.kcyOf(this.eraLast(era))];
  }

  /** For a KCY (a year of the epoch frame), the era years it holds: one, or several where an era begins that year. */
  yearsOfKcy(kcy: number): { era: Era; year: number; from: number; to: number }[] {
    if (!Number.isInteger(kcy))
      throw new CalendarError('DATE_OUT_OF_RANGE', `KCY ${kcy} is not a whole year.`);
    const y0 = this.epoch.indexOf(kcy);
    if (y0 === null) throw new CalendarError('DATE_OUT_OF_RANGE', `There is no KCY 0 in this calendar.`);
    const from = this.epoch.startDay(y0) * this.minutesPerDay;
    const to = this.epoch.startDay(y0 + 1) * this.minutesPerDay - 1;
    const out: { era: Era; year: number; from: number; to: number }[] = [];
    for (const e of this.eras) {
      const a = Math.max(from, e.startsAt, this.minMinute);
      const b = Math.min(to, this.eraLast(e));
      if (a > b) continue;
      out.push({ era: e, year: this.resolve(a).year, from: a, to: b });
    }
    if (out.length === 0)
      throw new CalendarError('DATE_OUT_OF_RANGE', `KCY ${kcy} is outside the calendar “${this.name}”.`, {
        kcy,
      });
    return out;
  }

  // ------------------------------------------------------------------------------------------------ formatting

  /** The template LegendKeeper uses for a detail. */
  templateFor(detail: Detail): Token[] {
    return detail <= 1
      ? this.formats.year
      : detail === 2
        ? this.formats.month
        : detail === 3
          ? this.formats.day
          : this.formats.time;
  }

  /** A minute as LegendKeeper formats it at a detail (`formattedStart`). */
  format(minute: number, detail: Detail, o: FormatOptions = {}): string {
    return this.render(this.templateFor(detail), this.resolve(minute), o);
  }

  /** Renders tokens for a moment. */
  render(tokens: readonly Token[], m: Moment, o: FormatOptions = {}): string {
    const grouping = o.yearGrouping ?? ',';
    const months = this.definition.months;
    const weekdays = this.definition.weekdays ?? [];
    const num = (n: number, t: Token) => {
      const s = t.pad ? String(n).padStart(2, '0') : String(n);
      return t.ordinal ? ordinal(n).replace(String(n), s) : s;
    };
    const weekday = (): string => {
      if (weekdays.length === 0) return '';
      const idx = this.definition.weekResetsEachMonth
        ? (m.day - 1) % weekdays.length
        : (((m.epochDay + (this.definition.epochWeekday ?? 0)) % weekdays.length) + weekdays.length) %
          weekdays.length;
      return weekdays[idx]?.name ?? '';
    };
    let out = '';
    for (const t of tokens) {
      switch (t.kind) {
        case 'lit':
          out += t.text;
          break;
        case 'year':
          out += t.ordinal
            ? ordinal(m.year).replace(String(m.year), groupDigits(m.year, grouping))
            : groupDigits(m.year, grouping);
          break;
        case 'era':
          out += m.era.hideAbbr ? '' : m.era.abbr;
          break;
        case 'eraName':
          out += m.era.name;
          break;
        case 'month':
          out += months[m.monthIndex]!.name;
          break;
        case 'monthAbbr':
          out += months[m.monthIndex]!.name.slice(0, 3);
          break;
        case 'monthNum':
          out += num(m.monthIndex + 1, t);
          break;
        case 'day':
          out += num(m.day, t);
          break;
        case 'weekday':
          out += weekday();
          break;
        case 'weekdayAbbr':
          out += weekday().slice(0, 3);
          break;
        case 'hour':
          out += num(m.hour, t);
          break;
        case 'minute':
          out += num(m.minuteOfHour, t);
          break;
      }
    }
    // A hidden era abbreviation leaves its spaces behind: close them up as the app shows the text.
    return out
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+,/g, ',')
      .trim();
  }
}
