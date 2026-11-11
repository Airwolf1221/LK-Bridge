/**
 * The two date styles (v2 D1.1, ADR 0039). LegendKeeper writes a year with no thousands separator on events
 * (`formattedStart`: `Kumikas 1st, AA 1988119`); the owner's tables write it with separators (`AA 1,988,119`). The
 * engine keeps them apart: `format` is LegendKeeper's, `formatTable` and `render` with a table style are the tables'.
 * Both are read. The owner's sandbox run (11 November 2026) found LegendKeeper's text for AA, 1A and 2A events.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE, LK_DATE_STYLE } from '../../src/calendar/index.js';

const oracle = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: unknown; events: { formattedStart: string; start: number; detail: number }[] };
const { engine, parser } = createCalendar(oracle.calendar);

/** Years over 1,000 (the owner's examples: the Archon Age, 1A, and a 2A year of the same size). */
const FIXTURES = [
  { era: 'AA', lk: 'Kumikas 1st, AA 1988119', table: 'Kumikas 1st, AA 1,988,119', form: 'day' },
  { era: '1A', lk: 'Isar 17th, 1A 8501', table: 'Isar 17th, 1A 8,501', form: 'day' },
  { era: '2A', lk: 'Isar 17th, 2A 1234', table: 'Isar 17th, 2A 1,234', form: 'day' },
  { era: 'AA', lk: 'AA 1988119', table: 'AA 1,988,119', form: 'year' },
  { era: '1A', lk: 'Zahras 1A 8501', table: 'Zahras 1A 8,501', form: 'month' },
] as const;

describe('LegendKeeper’s style and the table style', () => {
  it.each(FIXTURES)('$lk ⇄ $table (both read to the same minutes; each written in its own style)', (f) => {
    const a = parser.parse(f.lk, DEFAULT_DATE_STYLE);
    const b = parser.parse(f.table, DEFAULT_DATE_STYLE);
    expect([a.start, a.end, a.form]).toEqual([b.start, b.end, b.form]);
    expect(a.form).toBe(f.form);
    // The parse result carries both texts whichever was given.
    expect(a.formatted).toBe(f.lk);
    expect(b.formatted).toBe(f.lk);
    expect(a.tableFormatted).toBe(f.table);
    expect(b.tableFormatted).toBe(f.table);
    expect(a.formattedStart).toBe(f.lk);
    // And the engine writes each style from the minutes.
    expect(parser.render(f.form, a.start, null, LK_DATE_STYLE)).toBe(f.lk);
    expect(parser.render(f.form, a.start, null, DEFAULT_DATE_STYLE)).toBe(f.table);
    expect(a.era.abbr).toBe(f.era);
  });

  it('the Archon Age’s first day: LegendKeeper has no separator, the tables have, and it is the calendar’s first minute', () => {
    const p = parser.parse('Kumikas 1st, AA 1988119');
    expect(p.start).toBe(engine.minMinute);
    expect(p.kcy.start).toBe(-1_988_119);
    expect(engine.format(engine.minMinute, 3)).toBe('Kumikas 1st, AA 1988119');
    expect(engine.formatTable(engine.minMinute, 3, DEFAULT_DATE_STYLE)).toBe('Kumikas 1st, AA 1,988,119');
    expect(engine.formatTable(engine.minMinute, 3, { yearGrouping: '' })).toBe('Kumikas 1st, AA 1988119');
  });

  it('`format` is LegendKeeper’s style for any year, at every detail', () => {
    const m = parser.parse('Isar 17th, 1A 8,501').start;
    expect(engine.format(m, 3)).toBe('Isar 17th, 1A 8501');
    expect(engine.format(m, 2)).toBe('Isar 1A 8501');
    expect(engine.format(m, 1)).toBe('1A 8501');
    expect(engine.formatTable(m, 1, DEFAULT_DATE_STYLE)).toBe('1A 8,501');
  });

  it('a range carries both styles: the table’s range separator and year grouping, LegendKeeper’s plain years', () => {
    const p = parser.parse('Kumikas 1st, AA 1,988,119 - Isar 17th, 1A 8,501');
    expect(p.formatted).toBe('Kumikas 1st, AA 1988119 - Isar 17th, 1A 8501');
    expect(p.formattedEnd).toBe('Isar 17th, 1A 8501');
    expect(p.tableFormatted).toBe('Kumikas 1st, AA 1,988,119 - Isar 17th, 1A 8,501');
    // The same range written in LegendKeeper's style reads back to the same minutes.
    const q = parser.parse(p.formatted);
    expect([q.start, q.end]).toEqual([p.start, p.end]);
  });

  it('keeps a badly grouped year refused in either style, and a space after punctuation required', () => {
    expect(() => parser.parse('Isar 17th, 1A 8,50')).toThrow(/not a year/);
    expect(() => parser.parse('Isar 17th, 1A 85,01')).toThrow(/not a year/);
  });

  it('the oracle’s 330 events (all under 1,000 years, so both styles agree) format identically in both', () => {
    for (const e of oracle.events) {
      expect(engine.formatTable(e.start, e.detail as 1 | 2 | 3, DEFAULT_DATE_STYLE)).toBe(e.formattedStart);
    }
  });
});
