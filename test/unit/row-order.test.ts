/**
 * LegendKeeper's one row order and the comparison of rows by id (the hotfix of 10 November 2026): `listProperties`,
 * `getProperty` and `getResource` give a key-value property's rows in stored order, `listPropertyRows` by rank, so
 * every comparison puts both sides in rank order (code-unit string order, ties by id) and matches rows by id.
 */
import { describe, expect, it } from 'vitest';
import { applySidebarWrite, rowsFrom, sidebarFrom } from '../../src/facts/sidebar.js';
import { planFacts, rowStates } from '../../src/facts/plan.js';
import { inRankOrder, sidebarInRankOrder } from '../../src/lk/row-order.js';
import { compareRows, rowsContentHash, rowsState } from '../../src/jobs/sidebar-state.js';
import { byRank, rankBetween } from '../facts/sidebar-model.js';
import { BIO_KEYS, RHEASHIRA_ROWS } from '../facts/world.js';

/** Rheashira Aela's rows as LegendKeeper gives them: stored order (`listProperties`) and rank order (`listPropertyRows`). */
const stored = RHEASHIRA_ROWS.map(([key, text, rank, id]) => ({
  id,
  rank,
  key,
  text,
  content: text ? [{ text }] : [],
}));
const ranked = [...stored].sort(byRank);
const keysOf = (rows: readonly { key: string }[]) => rows.map((r) => r.key);

describe('the one order: by rank, in code-unit order', () => {
  it('sorts the real ranks as LegendKeeper does: O V X \\ a aR af b c d dZ do e g i l m', () => {
    expect(inRankOrder(stored).map((r) => r.rank)).toEqual([
      'O',
      'V',
      'X',
      '\\',
      'a',
      'aR',
      'af',
      'b',
      'c',
      'd',
      'dZ',
      'do',
      'e',
      'g',
      'i',
      'l',
      'm',
    ]);
    expect(keysOf(inRankOrder(stored))).toEqual(keysOf(ranked));
    // Not locale order, which would put "aR" after "af".
    expect(['af', 'aR'].sort((a, b) => a.localeCompare(b))).toEqual(['af', 'aR']);
    expect(inRankOrder([{ rank: 'af' }, { rank: 'aR' }]).map((r) => r.rank)).toEqual(['aR', 'af']);
  });
  it('breaks ties by id, and keeps a planned row (no rank) after the row it followed', () => {
    expect(
      inRankOrder([
        { id: 'b', rank: 'k' },
        { id: 'a', rank: 'k' },
      ]).map((r) => r.id),
    ).toEqual(['a', 'b']);
    const planned = [
      { id: 'x', rank: 'm' },
      { id: 'y', rank: 'a' },
      { id: null, key: 'new' },
      { id: 'z', rank: 'c' },
    ];
    expect(inRankOrder(planned).map((r) => r.id)).toEqual(['y', null, 'z', 'x']);
    expect(inRankOrder([{ id: '1' }, { id: '2' }]).map((r) => r.id)).toEqual(['1', '2']);
  });
  it('rowsState, rowsFrom and a sidebar read all give rank order, whichever endpoint the rows came from', () => {
    expect(keysOf(rowsState(stored))).toEqual(keysOf(ranked));
    expect(keysOf(rowsFrom(stored))).toEqual(keysOf(ranked));
    expect(
      keysOf(sidebarFrom({ data: [{ id: 'p', kind: 'keyValue', title: 'P', rows: stored }] })[0]!.rows!),
    ).toEqual(keysOf(ranked));
    const view = sidebarInRankOrder({ id: 'p', kind: 'keyValue', rows: stored }) as {
      rows: { key: string }[];
    };
    expect(keysOf(view.rows)).toEqual(keysOf(ranked));
  });
});

describe('compareRows: by id, in rank order', () => {
  const plan = rowsState(stored); // what the plan saw (listProperties)
  const lock = rowsState(ranked); // what the check in the lock reads (listPropertyRows)

  it('the same rows from two endpoints are the same: no difference (the 10 November conflict)', () => {
    expect(compareRows('PROPERTIES', plan, lock)).toEqual([]);
    expect(rowsContentHash(plan)).toBe(rowsContentHash(lock));
    // An expectation stored before ranks were kept still matches by id.
    const old = stored.map(({ id, key, content }) => ({ id, key, content }));
    expect(compareRows('PROPERTIES', old, lock)).toEqual([]);
  });
  it('a changed value is a difference naming the row', () => {
    const now = rowsState(
      ranked.map((r) => (r.key === 'Scope' ? { ...r, content: [{ text: 'Changed' }] } : r)),
    );
    const d = compareRows('PROPERTIES', plan, now);
    expect(d).toHaveLength(1);
    expect(d[0]!.path).toBe('PROPERTIES “Scope” (rhea0012).value');
  });
  it('a changed rank is a reorder, a real change', () => {
    const now = rowsState(ranked.map((r) => (r.key === 'Aliases' ? { ...r, rank: 'z' } : r)));
    const d = compareRows('PROPERTIES', plan, now);
    expect(d.map((x) => x.path)).toEqual(['PROPERTIES “Aliases” (rhea0011).rank (reordered)']);
    expect(rowsContentHash(plan)).not.toBe(rowsContentHash(now));
  });
  it('an added and a removed row are differences', () => {
    const added = rowsState([...ranked, { id: 'other001', rank: 'n', key: 'Mood', text: 'x', content: [] }]);
    expect(compareRows('PROPERTIES', plan, added).map((x) => x.path)).toEqual([
      'PROPERTIES “Mood” (other001) (added)',
    ]);
    const removed = rowsState(ranked.filter((r) => r.key !== 'Supersedes'));
    expect(compareRows('PROPERTIES', plan, removed).map((x) => x.path)).toEqual([
      'PROPERTIES “Supersedes” (rhea0014) (removed)',
    ]);
  });
  it('a planned new row is matched by key and must stand where the plan put it', () => {
    const expected = rowStates([
      ...rowsFrom(stored).slice(0, 5), // … Subject (a)
      { id: null, key: 'Epithet', content: [{ text: 'the Envoy' }] },
      ...rowsFrom(stored).slice(5),
    ]);
    const landed = (rank: string) =>
      rowsState([...ranked, { id: 'new00001', rank, key: 'Epithet', content: [{ text: 'the Envoy' }] }]);
    expect(compareRows('PROPERTIES', expected, landed('a9'))).toEqual([]); // between a and aR
    expect(rowsContentHash(expected)).toBe(rowsContentHash(landed('a9')));
    const wrong = compareRows('PROPERTIES', expected, landed('az')); // after af: between af and b
    expect(wrong.map((x) => x.path)).toEqual(['PROPERTIES “Epithet” (new00001) (order)']);
    expect(wrong[0]).toMatchObject({ expected: 'after “Subject”', actual: 'after “Race / Species”' });
  });
  it('rows without an id are compared by position (the fallback)', () => {
    const a = [{ id: null, key: 'K', content: [{ text: '1' }] }];
    expect(compareRows('P', a, [{ id: null, key: 'K', content: [{ text: '1' }] }])).toEqual([]);
    expect(
      compareRows('P', a, [{ id: null, key: 'K', content: [{ text: '2' }] }]).map((x) => x.path),
    ).toEqual(['P “K”.value']);
  });
});

describe('placement of a new template fact on Rheashira’s page', () => {
  it('anchors after Subject, and plans it between Subject (a) and Life State (aR), not before Canonical Display Name', () => {
    const sidebar = sidebarFrom({
      data: [{ id: 'hnocyl8o', kind: 'keyValue', title: 'PROPERTIES', rows: stored }],
    });
    const plan = planFacts({
      resourceId: 'kzwy5zrs',
      sidebar,
      propertyTitle: 'PROPERTIES',
      facts: [{ key: 'Epithet', value: [{ text: 'the Envoy' }] }],
      links: [],
      templateKeys: BIO_KEYS,
    });
    expect(plan.writes[0]!.params.body).toMatchObject({ key: 'Epithet', after: 'rhea0005' });
    expect(keysOf(plan.rowsAfter).slice(3, 8)).toEqual([
      'Inheritance',
      'Subject',
      'Epithet',
      'Life State',
      'Race / Species',
    ]);
    // The model LegendKeeper's placement follows: between the anchor and its rank-sorted neighbour.
    const after = applySidebarWrite(sidebar, 'createPropertyRow', plan.writes[0]!.params)!;
    expect(keysOf(after[0]!.rows!)).toEqual(keysOf(plan.rowsAfter));
  });
  it('the mock’s ranks fall strictly between their neighbours, without collisions', () => {
    for (const [a, b] of [
      ['a', 'aR'],
      ['\\', 'a'],
      ['af', 'b'],
      ['m', null],
      [null, 'O'],
      ['a', 'a#'],
      ['a~', 'b'],
    ] as [string | null, string | null][]) {
      const r = rankBetween(a, b);
      if (a !== null) expect(r > a, `${a} < ${r}`).toBe(true);
      if (b !== null) expect(r < b, `${r} < ${b}`).toBe(true);
    }
    const ranks = new Set(ranked.map((r) => r.rank));
    let lo = 'a';
    for (let i = 0; i < 30; i++) {
      lo = rankBetween(lo, 'aR');
      expect(ranks.has(lo)).toBe(false);
      ranks.add(lo);
    }
  });
});
