/**
 * Properties of the calendar engine (v2 D1): for random valid dates in every era (the Archon Age's descending years, the
 * Fourth Age's boundary included), writing a date in each form and reading it back gives the same minutes, form and
 * detail; minutes resolve and compose back exactly; KCY is continuous. Plus every refusal, and calendars with what
 * Kumikan lacks (leap days, months every N years, a year 0, a `calendar` reset, the default formats).
 */
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CalendarError,
  createCalendar,
  DEFAULT_DATE_STYLE,
  DEFAULT_KCY_STYLE,
  formatKcy,
  parseKcyCell,
  type DateForm,
} from '../../src/calendar/index.js';

const oracle = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as {
  calendar: Record<string, unknown>;
};
const kumikan = createCalendar(oracle.calendar);
const RUNS = 10_000;

function code(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof CalendarError) return e.code;
    throw e;
  }
}

/** A random day-aligned minute inside an era, biased towards its edges (the first and last years). */
function minuteIn(cal: ReturnType<typeof createCalendar>, eraIndex: number, t: number, edge: number): number {
  const e = cal.engine;
  const era = e.eras[eraIndex]!;
  const first = Math.max(era.startsAt, e.minMinute);
  const last = e.eraLast(era);
  const day = e.minutesPerDay;
  const span = Math.floor((last - first) / day);
  const pick =
    edge === 0
      ? Math.floor(t * span)
      : edge === 1
        ? Math.floor(t * Math.min(span, 1500))
        : span - Math.floor(t * Math.min(span, 1500));
  return first + Math.max(0, Math.min(span, pick)) * day;
}

const FORMS: readonly DateForm[] = [
  'day',
  'year',
  'unknown-year',
  'month',
  'date-range',
  'day-range',
  'cross-month-range',
  'month-range',
  'month-range-full',
  'year-range',
];

/** A valid (start, end) for a form from two minutes in the era, or null when the form cannot hold them. */
function spanFor(
  cal: ReturnType<typeof createCalendar>,
  form: DateForm,
  a: number,
  b: number,
): [number, number | null] | null {
  const e = cal.engine;
  const p = cal.parser;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const ma = e.resolve(lo);
  const mb = e.resolve(hi);
  const yearStart = (m: typeof ma) => Math.max(e.yearStart(m.era, m.year), m.era.startsAt, e.minMinute);
  const monthStart = (m: typeof ma) =>
    Math.max(e.monthStart(m.era, m.year, m.monthIndex), m.era.startsAt, e.minMinute);
  void p;
  switch (form) {
    case 'day':
      return [lo, null];
    case 'year':
    case 'unknown-year':
      return [yearStart(ma), null];
    case 'month':
      return [monthStart(ma), null];
    case 'date-range':
      return hi > lo ? [lo, hi] : null;
    case 'day-range':
      return hi > lo && ma.era.id === mb.era.id && ma.year === mb.year && ma.monthIndex === mb.monthIndex
        ? [lo, hi]
        : null;
    case 'cross-month-range':
      return hi > lo && ma.era.id === mb.era.id && ma.year === mb.year ? [lo, hi] : null;
    case 'month-range': {
      if (ma.era.id !== mb.era.id || ma.year !== mb.year) return null;
      const s = monthStart(ma);
      const t = monthStart(mb);
      return t > s ? [s, t] : null;
    }
    case 'month-range-full': {
      const s = monthStart(ma);
      const t = monthStart(mb);
      return t > s ? [s, t] : null;
    }
    case 'year-range': {
      const s = yearStart(ma);
      const t = yearStart(mb);
      return t > s ? [s, t] : null;
    }
  }
}

function roundTrips(cal: ReturnType<typeof createCalendar>, label: string) {
  const eras = cal.engine.eras.length;
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: eras - 1 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.integer({ min: 0, max: 2 }),
      fc.integer({ min: 0, max: 400 }),
      fc.constantFrom(...FORMS),
      fc.boolean(),
      (eraIndex, t1, t2, edge, gapDays, form, shout) => {
        const a = minuteIn(cal, eraIndex, t1, edge);
        const lastDay =
          Math.floor(cal.engine.eraLast(cal.engine.eras[eraIndex]!) / cal.engine.minutesPerDay) *
          cal.engine.minutesPerDay;
        const b = Math.min(lastDay, a + gapDays * cal.engine.minutesPerDay);
        void t2;
        const span = spanFor(cal, form, a, b);
        if (!span) return;
        const [start, end] = span;
        const text = cal.parser.render(form, start, end, DEFAULT_DATE_STYLE);
        // Case and spacing do not matter.
        const variant = shout ? text.toUpperCase().replace(/ /g, '  ') : text;
        const p = cal.parser.parse(variant);
        expect({ label, text, start: p.start, end: p.end, form: p.form }).toEqual({
          label,
          text,
          start,
          end,
          form,
        });
        expect(p.text).toBe(text);
        // KCY is the year of the epoch frame: consistent with the start and end.
        expect(p.kcy.start).toBe(cal.engine.kcyOf(start));
      },
    ),
    { numRuns: RUNS },
  );
}

describe('format then parse round-trips (10,000 runs per calendar)', () => {
  it('Kumikan Epochal: every era, the Archon Age counting down, the era edges', () => {
    roundTrips(kumikan, 'kumikan');
  });

  it('a calendar with leap days, a month every 4 years, a year 0, a calendar-reset era and the default formats', () => {
    roundTrips(createCalendar(odd), 'odd');
  });
});

describe('minutes resolve and compose back exactly (10,000 runs)', () => {
  const check = (cal: ReturnType<typeof createCalendar>) => {
    const e = cal.engine;
    fc.assert(
      fc.property(fc.integer({ min: e.minMinute, max: e.maxMinute }), (m) => {
        const r = e.resolve(m);
        const back = e.compose({
          era: r.era,
          year: r.year,
          monthIndex: r.monthIndex,
          day: r.day,
          hour: r.hour,
          minute: r.minuteOfHour,
        });
        expect(back).toBe(m);
        expect(e.eraAt(m)?.id).toBe(r.era.id);
      }),
      { numRuns: RUNS },
    );
  };
  it('Kumikan Epochal', () => check(kumikan));
  it('the odd calendar', () => check(createCalendar(odd)));
});

/**
 * A calendar exercising what Kumikan lacks: an intercalary month every 4 years, a Gregorian leap day, year 0, a forward
 * era with `calendar` reset, no format (LegendKeeper's default `MMMM D^, YYYY E`).
 */
const odd = {
  id: 'oddcal01',
  name: 'Odd Reckoning',
  hasZeroYear: true,
  maxMinutes: 24 * 60 * 400 * 3000,
  months: [
    { id: 'a', name: 'Firstmonth', isIntercalary: false, length: 31, interval: 1, offset: 0 },
    { id: 'b', name: 'Second Month', isIntercalary: false, length: 28, interval: 1, offset: 0 },
    { id: 'c', name: 'Festival', isIntercalary: true, length: 5, interval: 4, offset: 1 },
    { id: 'd', name: 'Lastmonth', isIntercalary: false, length: 30, interval: 1, offset: 0 },
  ],
  leapDays: [
    {
      id: 'l',
      name: 'Leap',
      intercalary: false,
      month: 1,
      addsWeekDay: false,
      day: 1,
      weekDay: '',
      interval: '400,!100,4',
      offset: 0,
    },
  ],
  weekdays: [
    { id: 'x', name: 'Oneday' },
    { id: 'y', name: 'Twoday' },
  ],
  epochWeekday: 0,
  hoursInDay: 24,
  minutesInHour: 60,
  negativeEra: { id: 'bce', name: 'Before', abbr: 'BE', startsAt: -24 * 60 * 400 * 2000, resetMode: 'none' },
  positiveEras: [
    { id: 'ce', name: 'Common', abbr: 'CE', startsAt: 0, resetMode: 'none' },
    {
      id: 'ne',
      name: 'New Reckoning',
      abbr: 'NR',
      startsAt: 24 * 60 * 90 * 1000 + 24 * 60 * 40,
      resetMode: 'calendar',
    },
  ],
  version: 'v1',
};

describe('refusals, each with a precise message', () => {
  const p = kumikan.parser;
  it.each([
    ['', 'DATE_EMPTY'],
    ['Unknown', 'DATE_UNKNOWN_ALONE'],
    ['unknown.', 'DATE_UNKNOWN_ALONE'],
    ['Frogmonth 3rd, 4A 12', 'DATE_UNKNOWN_MONTH'],
    ['Kumikas 3rd, 9Z 12', 'DATE_UNKNOWN_ERA'],
    ['Kumikas 31st, 4A 12', 'DATE_IMPOSSIBLE_DAY'],
    ['Highsun 5th, 4A 12', 'DATE_IMPOSSIBLE_DAY'],
    ['Kumikas 0, 4A 12', 'DATE_IMPOSSIBLE_DAY'],
    ['Kumikas 1st, 4A 1', 'DATE_OUTSIDE_ERA'],
    ['Azah 17th, 4A 1', 'DATE_OUTSIDE_ERA'],
    ['Kumikas - Azaakh, 4A 1', 'DATE_OUTSIDE_ERA'],
    ['4A 2000', 'DATE_OUTSIDE_ERA'],
    ['Kumikas 1st, 3A 400', 'DATE_OUTSIDE_ERA'],
    ['AA 1,988,120', 'DATE_OUTSIDE_ERA'],
    ['4A 0', 'DATE_INVALID_YEAR'],
    ['4A 1,00', 'DATE_INVALID_YEAR'],
    ['Meshaph 10th, 4A 102 - Kumikas 19th, 4A 100', 'DATE_RANGE_REVERSED'],
    ['Jehet 18th - 11th, 4A 424', 'DATE_RANGE_REVERSED'],
    ['Azaakh - Kumikas, 4A 180', 'DATE_RANGE_REVERSED'],
    ['4A 900 - 4A 881', 'DATE_RANGE_REVERSED'],
    ['Jehet 11th - 11th, 4A 424', 'DATE_RANGE_REVERSED'],
    ['sometime in the spring', 'DATE_UNRECOGNISED'],
    ['4A', 'DATE_UNRECOGNISED'],
  ])('%j → %s', (text, want) => {
    expect(code(() => p.parse(text))).toBe(want);
  });

  it('names where the era begins', () => {
    try {
      p.parse('Kumikas 1st, 4A 1');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('before the Fourth Arkonan Age (4A) begins, on Azah 18th, 4A 1');
    }
  });

  it('lists the months for an unknown month and the accepted forms for an unrecognised date', () => {
    expect(() => p.parse('Frogmonth 3rd, 4A 12')).toThrow(/Kumikas, Isar, Selaphos/);
    expect(() => p.parse('sometime')).toThrow(/Accepted forms: .*Unknown, /);
  });
});

describe('the forms that really occur', () => {
  const p = kumikan.parser;
  it.each([
    ['Kumikas 1st, 1A 159', 'day', 3, 'day'],
    ['4A 881', 'year', 1, 'year-only'],
    ['Unknown, 4A 101', 'unknown-year', 1, 'year-only'],
    ['Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102', 'date-range', 3, 'date-range'],
    ['Kumikas - Azaakh, 4A 180', 'month-range', 2, 'month-range'],
    ['Zahras 4A 367 - Attina 4A 367', 'month-range-full', 2, 'month-range'],
    ['Jehet 11th - 18th, 4A 424', 'day-range', 3, 'date-range'],
    ['4A 881 - 4A 900', 'year-range', 1, 'year-range'],
    ['Isar 20th - Pahan 31st, 4A 32', 'cross-month-range', 3, 'date-range'],
    ['Kumikas 1st, AA 1,988,119', 'day', 3, 'day'],
  ])('%s', (text, form, detail, shape) => {
    const d = p.parse(text);
    expect([d.form, d.detail, d.shape, d.text]).toEqual([form, detail, shape, text]);
  });

  it('is tolerant of case, spacing, suffixes and dashes', () => {
    const want = p.parse('Jehet 11th - 18th, 4A 424');
    for (const t of ['jehet 11 – 18, 4a 424', '  JEHET 11TH-18TH , 4A 424 ', 'Jehet 11st — 18nd, 4A 424']) {
      const d = p.parse(t);
      expect([d.start, d.end, d.text]).toEqual([want.start, want.end, want.text]);
    }
  });

  it('stores Unknown, 4A 101 exactly as 4A 101 (year-only) but writes it back in its own form', () => {
    const a = p.parse('Unknown, 4A 101');
    const b = p.parse('4A 101');
    expect([a.start, a.detail, a.end]).toEqual([b.start, b.detail, b.end]);
    expect(a.text).toBe('Unknown, 4A 101');
  });

  it('starts a year-only or month date of an era’s first year at the era’s first minute', () => {
    const era = kumikan.engine.eras.find((e) => e.abbr === '4A')!;
    expect(p.parse('4A 1').start).toBe(era.startsAt);
    expect(p.parse('Azah 4A 1').start).toBe(era.startsAt);
    expect(p.parse('Azah 18th, 4A 1').start).toBe(era.startsAt);
  });

  it('gives the Jehet 4A 424 range the same KCY at both ends', () => {
    const d = p.parse('Jehet 11th - 18th, 4A 424');
    expect(d.kcy).toEqual({ start: 424 + 1_250_307, end: 424 + 1_250_307 });
  });
});

describe('KCY cells', () => {
  it('formats single values, negative values and ranges in a style, and reads them back', () => {
    const s = DEFAULT_KCY_STYLE;
    expect(formatKcy({ start: 1_250_308, end: null }, s)).toBe('1,250,308');
    expect(formatKcy({ start: -1_988_119, end: null }, s)).toBe('-1,988,119');
    expect(formatKcy({ start: 1_250_407, end: 1_250_409 }, s)).toBe('1,250,407 - 1,250,409');
    expect(formatKcy({ start: 1_250_731, end: 1_250_731 }, s)).toBe('1,250,731 - 1,250,731');
    expect(formatKcy({ start: 1_250_731, end: 1_250_731 }, { ...s, sameYearRange: 'single' })).toBe(
      '1,250,731',
    );
    expect(formatKcy({ start: 1_250_407, end: 1_250_409 }, { ...s, grouping: '', rangeSeparator: '-' })).toBe(
      '1250407-1250409',
    );
    expect(parseKcyCell('-1,988,119')).toMatchObject({
      start: -1_988_119,
      end: null,
      grouping: ',',
      minus: '-',
    });
    expect(parseKcyCell('1250407-1250409')).toMatchObject({
      start: 1_250_407,
      end: 1_250_409,
      grouping: '',
      rangeSeparator: '-',
    });
    expect(parseKcyCell('-5 - -3')).toMatchObject({ start: -5, end: -3, rangeSeparator: ' - ' });
    expect(parseKcyCell('soon')).toBeNull();
  });

  it('round-trips any value and style (10,000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2_000_000, max: 2_000_000 }),
        fc.option(fc.integer({ min: -2_000_000, max: 2_000_000 }), { nil: null }),
        fc.constantFrom(',', ''),
        fc.constantFrom('-', '−'),
        fc.constantFrom(' - ', '-', ' – ', ' to '),
        (a, b, grouping, minus, rangeSeparator) => {
          const style = { grouping, minus, rangeSeparator, sameYearRange: 'range' as const };
          const text = formatKcy({ start: a, end: b }, style);
          const back = parseKcyCell(text);
          expect(back).not.toBeNull();
          expect([back!.start, back!.end]).toEqual([a, b]);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
