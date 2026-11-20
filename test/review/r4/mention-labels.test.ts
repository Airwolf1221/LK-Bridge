/**
 * The owner's sandbox run of CR-2026-11-R3's checks, X2: a custom mention label (in a table cell too) is kept as sent.
 * So the verify ignores a mention's display fields only where LegendKeeper fills them in (`name` always; `text` when the
 * bridge sent none, R3-67) and compares a label the bridge itself wrote. Pure functions; no LegendKeeper.
 */
import { describe, expect, it } from 'vitest';
import { sameContent } from '../../../src/jobs/sidebar-state.js';
import { compareStoredBlocks } from '../../../src/jobs/verify-blocks.js';

const page = 'pg000001';
const para = (id: string, runs: unknown[]) => ({ id, kind: 'paragraph', content: runs });
const cell = (runs: unknown[]) => ({
  id: 'tbl00001',
  kind: 'table',
  rows: [{ id: 'row00001', cells: [{ id: 'cel00001', children: [para('cp000001', runs)] }] }],
});

describe('X2: the verify and mention labels', () => {
  it('no label sent: the name and label LegendKeeper fills in never count (R3-67)', () => {
    const sent = [para('p0000001', [{ text: 'See ' }, { mention: { resourceId: page } }])];
    const stored = [
      para('p0000001', [
        { text: 'See ' },
        { mention: { resourceId: page, name: 'Harbour', text: 'Harbour' } },
      ]),
    ];
    expect(compareStoredBlocks(sent, stored).ok).toBe(true);
  });

  it('a label the bridge wrote is compared: kept as sent verifies; another label is a difference', () => {
    const sent = [para('p0000001', [{ mention: { resourceId: page, text: 'the old harbour' } }])];
    const kept = [
      para('p0000001', [{ mention: { resourceId: page, name: 'Harbour', text: 'the old harbour' } }]),
    ];
    const changed = [para('p0000001', [{ mention: { resourceId: page, name: 'Harbour', text: 'Harbour' } }])];
    expect(compareStoredBlocks(sent, kept).ok).toBe(true);
    const r = compareStoredBlocks(sent, changed);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.differences)).toContain('the old harbour');
  });

  it('inside a table cell the same (where X2 was seen), with text runs merged around the mentions', () => {
    const sent = [
      cell([
        { text: 'Kept ' },
        { text: 'by ' },
        { mention: { resourceId: page } },
        { text: ' and ' },
        { mention: { resourceId: page, text: 'An Old Name' } },
      ]),
    ];
    const stored = [
      cell([
        { text: 'Kept by ' },
        { mention: { resourceId: page, name: 'Harbour', text: 'Harbour' } },
        { text: ' and ' },
        { mention: { resourceId: page, name: 'Harbour', text: 'An Old Name' } },
      ]),
    ];
    expect(compareStoredBlocks(sent, stored).ok).toBe(true);
    const relabelled = JSON.parse(JSON.stringify(stored).replace('An Old Name', 'Harbour')) as unknown[];
    expect(compareStoredBlocks(sent, relabelled).ok).toBe(false);
  });

  it('a sidebar row the same way: its expected content first', () => {
    const expected = [{ mention: { resourceId: page, text: 'Captain' } }];
    expect(sameContent(expected, [{ mention: { resourceId: page, name: 'Harbour', text: 'Captain' } }])).toBe(
      true,
    );
    expect(sameContent(expected, [{ mention: { resourceId: page, name: 'Harbour', text: 'Harbour' } }])).toBe(
      false,
    );
    expect(
      sameContent([{ mention: { resourceId: page } }], [{ mention: { resourceId: page, text: 'Harbour' } }]),
    ).toBe(true);
  });
});
