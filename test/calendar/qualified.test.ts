/**
 * Qualified dates read by their anchor (v2 E6, "Chronology II", ADR 0048). Every date form from Arkona's age tables
 * (the owner's examples of 15 and 16 November 2026), read or deliberately left unread, with the structure the reader
 * gives. The calendar is the oracle's (Kumikan Epochal); nothing about it is in the reader.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createCalendar,
  describeReading,
  parseQualified,
  readQualifiedKcy,
} from '../../src/calendar/index.js';
import { ARKONA_QUALIFIED, READ, READ_F21, UNREAD } from '../fixtures/chronology/qualified-forms.js';

const oracle = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: unknown };
const { parser } = createCalendar(oracle.calendar);

describe('qualified dates are read by their anchor (ADR 0048)', () => {
  it.each([...READ, ...READ_F21])('$cell', (f) => {
    const r = parseQualified(parser, f.cell);
    if (!r.ok) throw new Error(`${f.cell}: ${r.code} ${r.message}`);
    const q = r.reading;
    expect({
      shape: q.shape,
      anchor: q.anchorText,
      approximate: q.approximate,
      open: q.openStart ? 'start' : q.openEnd ? 'end' : undefined,
      qualifier: q.qualifier,
      detail: q.date.detail,
      inclusive: q.inclusive === true,
      endsText: q.endsText,
    }).toEqual({
      shape: f.shape,
      anchor: f.anchor,
      approximate: f.approximate ?? false,
      open: f.open,
      qualifier: f.qualifier,
      detail: f.detail,
      inclusive: f.inclusive ?? false,
      endsText: f.endsText,
    });
    // The anchor is an ordinary date the engine writes and reads back: what the timeline event takes.
    const again = parser.parse(q.anchorText);
    expect([again.start, again.end, again.detail]).toEqual([q.date.start, q.date.end, q.date.detail]);
    if (f.endsText) {
      // v3 F2.1: each end at its own precision; the event (q.date) by the coarser one, starting at the same unit.
      const [a, b] = f.endsText.split(' - ');
      expect([q.start, q.end]).toEqual([parser.parse(a!).start, parser.parse(b!).start]);
      expect(q.date.start).toBeLessThanOrEqual(q.start);
      expect(q.date.end).toBeLessThanOrEqual(q.end!);
    } else {
      expect(q.start).toBe(q.date.start);
      expect(q.end ?? null).toBe(q.date.end);
    }
    expect(q.text).toBe(f.cell);
  });

  it.each(UNREAD)('$cell stays unread ($code)', (f) => {
    const r = parseQualified(parser, f.cell);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(f.code);
    expect(r.message).toMatch(f.why);
  });

  it('a shared trailing year applies to both ends, never a leading one', () => {
    const r = parseQualified(parser, 'After Isar 6th and before Zarzakh 29th, 4A 610');
    expect(r.ok && r.reading.anchors).toEqual(['Isar 6th', 'Zarzakh 29th, 4A 610']);
    const lead = parseQualified(parser, 'Between Isar 6th, 4A 610 and Zarzakh 29th');
    expect(lead.ok).toBe(false);
  });

  it('“approximately” after the semicolon describes something else: the date is not approximate', () => {
    const r = parseQualified(
      parser,
      'Kumikas 25th, 4A 630; first coronation proceeding, approximately four hours',
    );
    expect(r.ok && r.reading.approximate).toBe(false);
  });

  it('a plain date reads as itself, with nothing but the anchor', () => {
    const r = parseQualified(parser, 'Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102');
    expect(r.ok && [r.reading.shape, r.reading.qualifier]).toEqual(['range', '…']);
  });

  it('v3 F2.1: describes an inclusive bound and a range of mixed precision in plain words', () => {
    const say = (c: string) => {
      const r = parseQualified(parser, c);
      if (!r.ok) throw new Error(r.message);
      return describeReading(r.reading);
    };
    expect(say('On or after Selaphos 9th, 4A 643')).toBe('from Selaphos 9th, 4A 643 (an open end)');
    expect(say('Before or during the third week of Isar, 4A 566')).toBe(
      'up to and including Isar 4A 566 (an open start)',
    );
    expect(say('Late 4A 621 onward')).toBe('after 4A 621 (an open end), approximate');
    expect(say('Camue 4A 624 - Kumikas 25th, 4A 630')).toBe(
      'range Camue 4A 624 - Kumikas 25th, 4A 630 (the event by month)',
    );
  });

  it('describes a reading in plain words', () => {
    const say = (c: string) => {
      const r = parseQualified(parser, c);
      if (!r.ok) throw new Error(r.message);
      return describeReading(r.reading);
    };
    expect(say('c. 4A 563; exact date unresolved')).toBe('year 4A 563, approximate');
    expect(say('By 4A 623; x')).toBe('before 4A 623 (an open start)');
    expect(say('Days following Isar 19th, 4A 613')).toBe('after Isar 19th, 4A 613 (an open end)');
    expect(say('c. 4A 564-565')).toBe('years 4A 564 - 4A 565, approximate');
  });

  it('counts how many of the owner’s example forms are read (25) and unread (1)', () => {
    const forms = [...READ.map((r) => r.cell), UNREAD[0]!.cell];
    const read = forms.filter((c) => parseQualified(parser, c).ok);
    expect([read.length, forms.length - read.length]).toEqual([25, 1]);
  });
});

describe('a qualified row’s KCY cell: its words are text, not errors', () => {
  it.each([
    ['1,250,926 - 1,250,931', { kind: 'value', start: 1250926, end: 1250931, words: '' }],
    ['1,250,870 (approximate)', { kind: 'value', start: 1250870, end: null, words: '(approximate)' }],
    ['1,250,872 (year only)', { kind: 'value', start: 1250872, end: null, words: '(year only)' }],
    ['1,250,937 onward', { kind: 'value', start: 1250937, end: null, words: 'onward' }],
    ['c. 1,250,896 - 1,250,907', { kind: 'value', start: 1250896, end: 1250907, words: 'c.' }],
    ['-1,988,119 (approximate)', { kind: 'value', start: -1988119, end: null, words: '(approximate)' }],
    ['Unassigned - 1,250,870', { kind: 'value', start: 1250870, end: null, words: 'Unassigned -' }],
    ['Unassigned - approximate date', { kind: 'text' }],
    ['1,250,870 or 1,250,871', { kind: 'unclear' }],
  ] as const)('%s', (cell, want) => {
    expect(readQualifiedKcy(cell)).toEqual(want);
  });
});

describe('the Arkona-shaped set of 63 qualified cells', () => {
  it('none is read by the plain forms; the qualified reader is certain of 54 and leaves 9 unread', () => {
    expect(ARKONA_QUALIFIED).toHaveLength(63);
    for (const { cell } of ARKONA_QUALIFIED) expect(() => parser.parse(cell), cell).toThrow();
    const got = ARKONA_QUALIFIED.map(({ cell }) => ({ cell, read: parseQualified(parser, cell).ok }));
    expect(got).toEqual(ARKONA_QUALIFIED.map(({ cell, read }) => ({ cell, read })));
    expect(got.filter((x) => x.read)).toHaveLength(54);
  });
});
