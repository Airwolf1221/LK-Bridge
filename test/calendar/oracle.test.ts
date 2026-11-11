/**
 * The calendar engine against LegendKeeper's own answers (v2 D1, PLAN-v2 4.8): test/fixtures/calendar/oracle.json holds
 * the test world's calendar and 330 real Fourth Age events with LegendKeeper's minutes, detail, formatted text and parsed
 * dates. Every one must come out exactly.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCalendar, type Detail } from '../../src/calendar/index.js';

interface OracleEvent {
  id: string;
  name: string;
  shape: string;
  detail: number;
  start: number;
  end?: number;
  formattedStart: string;
  formattedEnd?: string;
  startDate: Record<string, unknown>;
  endDate?: Record<string, unknown>;
}

const oracle = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as {
  calendar: unknown;
  events: OracleEvent[];
};
const { engine, parser } = createCalendar(oracle.calendar);

describe('the oracle (330 Fourth Age events)', () => {
  it('holds 330 events', () => {
    expect(oracle.events).toHaveLength(330);
  });

  it('parses every formattedStart (and the range it makes) to LegendKeeper’s start, detail, shape and startDate', () => {
    const bad: string[] = [];
    for (const e of oracle.events) {
      const text = e.formattedEnd ? `${e.formattedStart} - ${e.formattedEnd}` : e.formattedStart;
      const p = parser.parse(text);
      const got = {
        start: p.start,
        end: p.end ?? undefined,
        detail: p.detail,
        shape: p.shape,
        startDate: p.startDate,
        endDate: p.endDate ?? undefined,
      };
      const want = {
        start: e.start,
        end: e.end,
        detail: e.detail,
        shape: e.shape,
        startDate: e.startDate,
        endDate: e.endDate,
      };
      if (JSON.stringify(got) !== JSON.stringify(want))
        bad.push(`${text}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    }
    expect(bad).toEqual([]);
  });

  it('formats every start (and end) back to LegendKeeper’s formattedStart (and formattedEnd), byte for byte', () => {
    const bad: string[] = [];
    for (const e of oracle.events) {
      const s = engine.format(e.start, e.detail as Detail);
      if (s !== e.formattedStart) bad.push(`${e.start}: ${s} ≠ ${e.formattedStart}`);
      if (e.end !== undefined) {
        const f = engine.format(e.end, e.detail as Detail);
        if (f !== e.formattedEnd) bad.push(`${e.end}: ${f} ≠ ${String(e.formattedEnd)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('writes LegendKeeper’s style: `format` never puts a thousands separator in a year (ADR 0039)', () => {
    expect(engine.format(engine.minMinute, 3)).toBe('Kumikas 1st, AA 1988119');
    for (const e of oracle.events) expect(engine.format(e.start, e.detail as Detail)).not.toMatch(/\d,\d/);
  });

  it('gives each event the date LegendKeeper resolved (eventDate)', () => {
    for (const e of oracle.events) {
      expect(engine.eventDate(e.start)).toEqual(e.startDate);
      if (e.end !== undefined) expect(engine.eventDate(e.end)).toEqual(e.endDate);
    }
  });

  it('parses formattedStart alone to the start and detail (the year-only, month and day forms)', () => {
    for (const e of oracle.events) {
      const p = parser.parse(e.formattedStart);
      expect(p.start).toBe(e.start);
      expect(p.detail).toBe(e.detail);
    }
  });
});

describe('known facts of the Kumikan calendar (PLAN-v2 section 2)', () => {
  it('has 716-day years of 30-hour days', () => {
    expect(engine.minutesPerDay).toBe(1800);
    expect(engine.rules.yearLength(1)).toBe(716);
  });

  it('starts the Fourth Age on Azah 18th, with KCY = year + 1,250,307', () => {
    const p = parser.parse('Azah 18th, 4A 1');
    expect(p.start).toBe(1611395897400);
    expect(p.kcy.start).toBe(1 + 1_250_307);
    expect(parser.parse('4A 881').kcy.start).toBe(881 + 1_250_307);
  });

  it('counts the Archon Age down: Kumikas 1st, AA 1,988,119 is KCY -1,988,119, the calendar’s first day', () => {
    const p = parser.parse('Kumikas 1st, AA 1,988,119');
    expect(p.kcy.start).toBe(-1_988_119);
    expect(p.start).toBe(engine.minMinute);
    expect(p.era.abbr).toBe('AA');
    expect(parser.parse('Frostmoot 4th, AA 1').kcy.start).toBe(-1);
    expect(parser.parse('Kumikas 1st, 1A 1').start).toBe(0);
  });

  it('restarts the year at 2A, 3A, 4A and 5A but not at 1A', () => {
    for (const abbr of ['2A', '3A', '4A', '5A']) {
      const era = engine.eras.find((e) => e.abbr === abbr)!;
      expect(engine.resolve(era.startsAt).year).toBe(1);
      expect(engine.resolve(era.startsAt - 1).era.abbr).not.toBe(abbr);
    }
    expect(engine.resolve(0).year).toBe(1);
  });
});
