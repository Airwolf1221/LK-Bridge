/**
 * How rows and events are paired (v2 D1.1, ADR 0039): the bridge's links, then the same date with the name, then the same
 * date alone (wording differs by design), then the same event with another date. The pure function the check, the
 * sandbox test and the tools share.
 */
import { describe, expect, it } from 'vitest';
import { createCalendar } from '../../src/calendar/index.js';
import { eventOf, matchRowsAndEvents, type TimelineEvent } from '../../src/chronology/check.js';
import type { AgeConfig } from '../../src/chronology/settings.js';
import { readAgeTable } from '../../src/chronology/table.js';
import { ORACLE } from './world.js';

const cal = createCalendar(ORACLE.calendar);
const age: AgeConfig = {
  name: 'Fourth Arkonan Age',
  eraId: 'x',
  tableDocumentId: 'tab',
  timelineDocumentId: 'tl',
  laneId: 'lane',
  laneName: 'Historical Events',
  mainRowId: 'm',
};
const cell = (t: string) => ({
  kind: 'tableCell',
  children: [{ kind: 'paragraph', content: [{ text: t }] }],
});
const table = (rows: [string, string, string][]) =>
  readAgeTable(
    [
      {
        id: 't',
        kind: 'table',
        children: [
          { id: 'h', kind: 'tableRow', children: ['Historical Event', 'Date', 'KCY'].map(cell) },
          ...rows.map(([d, t, k], i) => ({
            id: `r${i}`,
            kind: 'tableRow',
            children: [cell(t), cell(d), cell(k)],
          })),
        ],
      },
    ],
    cal.parser,
  )!;
const ev = (id: string, name: string, date: string): TimelineEvent => {
  const p = cal.parser.parse(date);
  return eventOf({
    id,
    laneId: 'lane',
    name,
    start: p.start,
    ...(p.end !== null ? { end: p.end } : {}),
    detail: p.detail,
  });
};

describe('matchRowsAndEvents', () => {
  const t = table([
    ['Kumikas 1st, 4A 100', 'The council of Ashgate meets and records its decisions at length', '1'],
    ['Isar 3rd, 4A 619 - Camue 5th, 4A 624', 'Mehrana crosses the Divan Heirage', '2'],
    ['4A 41', 'Zapolyarna Svetlana Valerievna', '3'],
  ]);

  it('pairs by date and name, then by date alone when only the wording differs', () => {
    const p = matchRowsAndEvents(
      t.rows,
      [
        ev('a', 'The council of Ashgate meets and records its decisions at length', 'Kumikas 1st, 4A 100'),
        ev('b', 'Mehrana (short)', 'Isar 3rd, 4A 619 - Camue 5th, 4A 624'),
      ],
      [],
      age,
    );
    expect(p.pairs.map((x) => [x.row.id, x.event.id, x.how])).toEqual([
      ['r0', 'a', 'date+name'],
      ['r1', 'b', 'date'],
    ]);
    // The year-only row has no event: the only thing left.
    expect(p.rows.map((r) => r.id)).toEqual(['r2']);
    expect(p.mismatches).toEqual([]);
    expect(p.events).toEqual([]);
  });

  it('a range row with a single-day event is a date mismatch, not two unpaired', () => {
    const p = matchRowsAndEvents(
      t.rows,
      [ev('b', 'Mehrana crosses the Divan Heirage', 'Isar 3rd, 4A 619')],
      [],
      age,
    );
    expect(p.mismatches.map((m) => [m.row.id, m.event.id, m.by])).toEqual([['r1', 'b', 'name']]);
    expect(p.pairs).toEqual([]);
    expect(p.rows.map((r) => r.id).sort()).toEqual(['r0', 'r2']);
    expect(p.events).toEqual([]);
  });

  it('by the same start when the wording differs as well', () => {
    const p = matchRowsAndEvents(t.rows, [ev('b', 'Something else', 'Isar 3rd, 4A 619')], [], age);
    expect(p.mismatches.map((m) => [m.row.id, m.by])).toEqual([['r1', 'start']]);
  });

  it('a link says which event is the row’s, and a linked pair that disagrees about the date is a mismatch', () => {
    const link = {
      tableDocumentId: 'tab',
      timelineDocumentId: 'tl',
      rowId: 'r1',
      eventId: 'b',
      age: age.name,
    };
    const same = matchRowsAndEvents(
      t.rows,
      [ev('b', 'whatever', 'Isar 3rd, 4A 619 - Camue 5th, 4A 624')],
      [link],
      age,
    );
    expect(same.pairs.map((x) => x.how)).toEqual(['link']);
    const apart = matchRowsAndEvents(t.rows, [ev('b', 'whatever', 'Isar 3rd, 4A 619')], [link], age);
    expect(apart.pairs).toEqual([]);
    expect(apart.mismatches.map((m) => [m.row.id, m.by])).toEqual([['r1', 'link']]);
  });

  it('two candidates for one row stay unpaired (ambiguous), never guessed', () => {
    const p = matchRowsAndEvents(
      t.rows,
      [ev('a', 'One telling', '4A 41'), ev('b', 'Another telling', '4A 41')],
      [],
      age,
    );
    expect(p.pairs).toEqual([]);
    expect(p.mismatches).toEqual([]);
    expect(p.rows.map((r) => r.id)).toContain('r2');
    expect(p.events.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});
