/**
 * CR-2026-11-R4 pass 3, unit level (no world): the elapsed calendar years of `arkona_as_of` (ADR 0064 D7: "a whole
 * number when both dates are exact days (an anniversary not reached does not count), a range … when either is
 * approximate"), the alias parser (`splitAliases`, ADR 0064 amendment 2, 3), and the approved pack's Life State and
 * Temporal Scope phrasings (an upper bound never a death date: amendment 1, D.2; ADR 0065 "On top of F4b.1" 3). On
 * Arkona's own calendar (Kumikan Epochal: no year 0, no leap days, five ages of 716-day years) unless a test says
 * otherwise. Each test asserts the SAFE answer.
 */
import { describe, expect, it } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../../src/calendar/index.js';
import { elapsedYears, readLeading, spanOf, type DateReading } from '../../../src/consistency/dates.js';
import { aliasName, splitAliases } from '../../../src/packs/naming/namesakes.js';
import { cal, nameIndex, ORACLE, proseFacts, RULES, sidebarFacts } from './helpers.js';

const read = (c: typeof cal, text: string): DateReading => {
  const r = readLeading(c, text, DEFAULT_DATE_STYLE);
  if (!r.ok) throw new Error(`${text}: ${r.reason}`);
  return r.reading;
};
const years = (birth: string, at: string, c = cal) => {
  const b = read(c, birth);
  const a = read(c, at);
  return elapsedYears(
    c,
    { reading: b, span: spanOf(c, b, RULES.approxMargin) },
    { reading: a, span: spanOf(c, a, RULES.approxMargin) },
  );
};

describe('elapsed calendar years', () => {
  it('AS-33: control: an anniversary not reached does not count, within an age and across the Fourth and Fifth Ages', () => {
    expect(years('Camue 44th, 4A 360', 'Camue 43rd, 4A 400')).toEqual({ kind: 'exact', years: 39 });
    expect(years('Camue 44th, 4A 360', 'Camue 44th, 4A 400')).toEqual({ kind: 'exact', years: 40 });
    expect(years('Camue 44th, 4A 360', 'Camue 43rd, 5A 100')).toEqual({ kind: 'exact', years: 688 });
    expect(years('Camue 44th, 4A 360', 'Camue 44th, 5A 100')).toEqual({ kind: 'exact', years: 689 });
  });

  it('AS-34: across the Archon Age and the First Age (no year 0): Camue 1st, AA 10 to Camue 1st, 1A 10 is 19 years, AA 1 to 1A 1 is one', () => {
    expect(ORACLE.calendar.hasZeroYear).toBe(false);
    expect(years('Camue 1st, AA 10', 'Camue 1st, 1A 10')).toEqual({ kind: 'exact', years: 19 });
    expect(years('Camue 1st, AA 1', 'Camue 1st, 1A 1')).toEqual({ kind: 'exact', years: 1 });
  });

  it('AS-35: control: an approximate birth (c. 4A 640, ±5 years) gives a range holding every possible age (54 to 65 at Camue 1st, 4A 700)', () => {
    const e = years('c. 4A 640', 'Camue 1st, 4A 700');
    expect(e).toMatchObject({ kind: 'range' });
    if (e.kind !== 'range') return;
    expect(e.min).toBeLessThanOrEqual(54);
    expect(e.max).toBeGreaterThanOrEqual(65);
  });

  const leap = createCalendar({
    ...ORACLE.calendar,
    id: 'leaptest',
    leapDays: [{ id: 'lp', name: 'Leap', month: 1, interval: '4', offset: 0 }],
  });

  it('control: a calendar with a leap day in Isar every 4 years: Isar has 43 days in 1A 4 and 42 in 1A 5; born before the leap day, the anniversary counts', () => {
    expect(leap.engine.monthLength(leap.engine.eraByAbbr('1A')[0]!, 4, 1)).toBe(43);
    expect(leap.engine.monthLength(leap.engine.eraByAbbr('1A')[0]!, 5, 1)).toBe(42);
    expect(years('Kumikas 1st, 1A 4', 'Kumikas 1st, 1A 5', leap)).toEqual({ kind: 'exact', years: 1 });
  });

  it('AS-37: a calendar with a leap day (the engine is generic; Arkona’s has none): the anniversary in a common year counts (born Selaphos 1st, 1A 4, a leap year; one year on Selaphos 1st, 1A 5)', () => {
    expect(years('Selaphos 1st, 1A 4', 'Selaphos 1st, 1A 5', leap)).toEqual({ kind: 'exact', years: 1 });
  });

  it('AS-89: control: a range birth ("4A 100–4A 105") gives a range holding every possible age (14 to 20 at Camue 1st, 4A 120)', () => {
    const e = years('4A 100–4A 105', 'Camue 1st, 4A 120');
    expect(e).toMatchObject({ kind: 'range' });
    if (e.kind !== 'range') return;
    expect(e.min).toBeLessThanOrEqual(14);
    expect(e.max).toBeGreaterThanOrEqual(20);
    expect(e.max).toBeLessThanOrEqual(20);
  });

  it('AS-90: a date inside an approximate birth’s margin but before its year ("c. 4A 640" asked 4A 636) never reads as born: the answer says the birth may not have happened yet', () => {
    const e = years('c. 4A 640', '4A 636');
    // The safe answers: "not yet born" is possible here, so a plain range from 0 (which says "born, under a year old")
    // is not one.
    expect(e.kind === 'range' && e.min === 0 && !('maybeUnborn' in e)).toBe(false);
  });

  it('AS-38: an approximate date near the epoch ("c. 1A 5") is widened by its margin only, never to the start of the Archon Age', () => {
    const r = read(cal, 'c. 1A 5');
    const s = spanOf(cal, r, RULES.approxMargin);
    const fiveBefore = read(cal, 'AA 1').start;
    expect(s.from).toBeGreaterThanOrEqual(read(cal, 'AA 2').start);
    expect(s.from).toBeLessThanOrEqual(fiveBefore);
    const e = years('c. 1A 5', '1A 100');
    expect(e.kind === 'range' ? e.max : 0).toBeLessThanOrEqual(101);
  });
});

describe('the alias parser (splitAliases)', () => {
  it('AS-73: control: the owner’s live Aliases, and a bracket that is part of a name ("Leopold (the Elder)")', () => {
    expect(
      splitAliases('Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)'),
    ).toEqual(['Rita von Katzen', 'Yamato', 'Katsuragi Yamato']);
    expect(splitAliases('Leopold (the Elder)')).toEqual(['Leopold (the Elder)']);
  });

  it('AS-70: a regnal designation in brackets ("Leopold (Second of the Name)") is part of the name, never a note: the alias is not the bare given name "Leopold"', () => {
    expect(splitAliases('Leopold (Second of the Name)')).not.toEqual(['Leopold']);
  });

  it('AS-71: an Arabic epithet in brackets ("Abu al-Abbas (as-Saffah)") is part of the name, never a note', () => {
    expect(aliasName('Abu al-Abbas (as-Saffah)')).toBe('Abu al-Abbas (as-Saffah)');
  });

  it('AS-72: a semicolon inside a note ("Yamato (from 4A 192; regnal)") never makes the note’s tail an alias', () => {
    expect(splitAliases('Yamato (from 4A 192; regnal)')).toEqual(['Yamato']);
  });

  it('AS-86: a birth name written as a leading note ("(birth name Rita von Katzen); Katsuragi Yamato") keeps the name as an alias', () => {
    expect(splitAliases('(birth name Rita von Katzen); Katsuragi Yamato')).toContain('Rita von Katzen');
  });
});

describe('the approved pack’s phrasings: an upper bound is never a death date', () => {
  it('AS-79: Life State "Deceased, by 5A 931", "Deceased – by 5A 931", "Deceased no later than 5A 931", "Deceased at the latest by 5A 931": no death date (as "Deceased by 5A 931")', () => {
    // Control: the owner's own phrasing reads no death date.
    expect(sidebarFacts('Jahan-Timur', { 'Life State': 'Deceased by 5A 931' }).filter((f) => f.date)).toEqual(
      [],
    );
    const read = Object.fromEntries(
      [
        'Deceased, by 5A 931',
        'Deceased – by 5A 931',
        'Deceased no later than 5A 931',
        'Deceased at the latest by 5A 931',
      ].map((v) => [
        v,
        sidebarFacts('Jahan-Timur', { 'Life State': v })
          .filter((f) => f.kind === 'death' && f.date)
          .map((f) => f.valueText),
      ]),
    );
    // Each variant's death dates (none is the safe answer).
    expect(Object.entries(read).filter(([, d]) => d.length > 0)).toEqual([]);
  });

  it('AS-80: Temporal Scope "Died no later than 4A 300" is no death in 4A 300', () => {
    const f = sidebarFacts('Odo Stand-in', { 'Temporal Scope': 'Born 4A 100; died no later than 4A 300' });
    expect(f.filter((x) => x.kind === 'death' && x.date).map((x) => x.valueText)).toEqual([]);
  });

  it('AS-98: an uncertain birth ("Born 4A 100 or 4A 101", "Born between 4A 100 and 4A 110", "Born no later than 4A 100", "Born by 4A 100") is never read as a birth in the single year 4A 100', () => {
    const single = read(cal, '4A 100');
    const exactYear = (v: string) =>
      sidebarFacts('Odo Stand-in', { 'Temporal Scope': v })
        .filter((x) => x.kind === 'birth' && x.date)
        .filter(
          (b) =>
            b.date!.start === single.start &&
            b.date!.end === single.end &&
            !b.date!.approximate &&
            !b.date!.openStart,
        )
        .map((b) => b.valueText);
    const read1 = [
      'Born 4A 100 or 4A 101',
      'Born between 4A 100 and 4A 110',
      'Born no later than 4A 100',
      'Born by 4A 100',
    ].map((v) => [v, exactYear(v)] as const);
    // Each variant read as the single year 4A 100 (none is the safe answer).
    expect(read1.filter(([, d]) => d.length > 0)).toEqual([]);
  });

  it('AS-81: a Temporal Scope clause recording a death ("Present status: deceased since 4A 600") never attests the life to 4A 600', () => {
    const f = sidebarFacts('Odo Stand-in', {
      'Temporal Scope': 'Born 4A 100; present status: deceased since 4A 600',
    });
    expect(f.filter((x) => x.kind === 'attested').map((x) => `${x.pattern}: ${x.valueText}`)).toEqual([]);
  });
});

describe('Unicode in names and dashes', () => {
  const names = nameIndex(['Rashad al-Khalid', 'Rita von Katzen'], ['Rashad', 'Rita']);

  it('AS-82: control: a name written with a Cyrillic look-alike letter ("Rаshad al-Khalid", U+0430) is nobody’s, never Rashad’s', () => {
    expect(proseFacts('R\u0430shad al-Khalid was born on Camue 1st, 4A 401.', names)).toEqual([]);
  });

  it('AS-83: control: the dated line with a horizontal bar (U+2015) for its dash reads nothing rather than a wrong date', () => {
    const f = proseFacts('Zahras 1st, 4A 99 \u2015 Rita von Katzen is born in Varadyn Kiralysag.', names);
    expect(f.filter((x) => x.date && x.valueText !== 'Zahras 1st, 4A 99')).toEqual([]);
  });
});
