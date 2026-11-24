/**
 * v3 F7b (ADR 0071 decision 9; completing F7's G10): the titled-block defaults F7's sandbox probe B3 recorded live on
 * 23 November 2026, one test per kind. A block of the kind sent without `title` and `isTitleHidden` and stored with
 * LegendKeeper's default verifies; the same kind stored with another value still reports it. v3 F6a (ADR 0076): the
 * probe printed `meter` on 23 November 2026 (`title="Meter" isTitleHidden=false`), so every titled kind is in the table.
 */
import { describe, expect, it } from 'vitest';
import { compareStoredBlocks, TITLED_BLOCK_DEFAULTS } from '../../src/jobs/verify-blocks.js';

const CASES: readonly {
  kind: string;
  title: string;
  isTitleHidden: boolean;
  block: Record<string, unknown>;
}[] = [
  {
    kind: 'image',
    title: 'Image',
    isTitleHidden: true,
    block: { url: 'https://assets.legendkeeper.com/x.webp' },
  },
  {
    kind: 'embed',
    title: 'Embed',
    isTitleHidden: true,
    block: { provider: 'youtube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  },
  {
    kind: 'keyValue',
    title: 'Stats',
    isTitleHidden: false,
    block: { rows: [{ key: 'Probe', content: [{ text: 'value' }] }] },
  },
  { kind: 'resourceCollection', title: 'Collection', isTitleHidden: false, block: {} },
  {
    kind: 'resourceLink',
    title: 'Links',
    isTitleHidden: false,
    block: { items: [{ resourceId: 'abc12345' }] },
  },
  { kind: 'map', title: 'Map', isTitleHidden: false, block: {} },
  {
    kind: 'textField',
    title: 'Text',
    isTitleHidden: false,
    block: { children: [{ kind: 'paragraph', content: [{ text: 'Probe.' }] }] },
  },
  // v3 F6a (ADR 0076): F7's probe printed meter on 23 November 2026.
  {
    kind: 'meter',
    title: 'Meter',
    isTitleHidden: false,
    block: { mode: 'bar', items: [{ name: 'Probe', icon: 'heart', current: 1, max: 2 }] },
  },
];

describe('G10 completed: the probe’s titled-block defaults', () => {
  it('the table holds exactly the confirmed kinds: every titled kind, meter included (F6a)', () => {
    expect(Object.keys(TITLED_BLOCK_DEFAULTS).sort()).toEqual(CASES.map((c) => c.kind).sort());
    expect(TITLED_BLOCK_DEFAULTS.meter).toEqual({ title: 'Meter', isTitleHidden: false });
  });

  for (const c of CASES)
    describe(c.kind, () => {
      const sent = { id: 'b0000001', kind: c.kind, ...c.block };
      it(`sent without title fields, stored as “${c.title}”, isTitleHidden ${c.isTitleHidden}: verified`, () => {
        expect(TITLED_BLOCK_DEFAULTS[c.kind]).toEqual({ title: c.title, isTitleHidden: c.isTitleHidden });
        const r = compareStoredBlocks([sent], [{ ...sent, title: c.title, isTitleHidden: c.isTitleHidden }]);
        expect(r).toMatchObject({ ok: true, count: 0 });
      });
      it('stored with the other isTitleHidden, or another title: still a difference', () => {
        const flipped = compareStoredBlocks(
          [sent],
          [{ ...sent, title: c.title, isTitleHidden: !c.isTitleHidden }],
        );
        expect(flipped.ok).toBe(false);
        expect(flipped.differences.map((d) => d.path)).toEqual(['[0].isTitleHidden']);
        const other = compareStoredBlocks(
          [sent],
          [{ ...sent, title: 'Something else', isTitleHidden: c.isTitleHidden }],
        );
        expect(other.differences.map((d) => d.path)).toEqual(['[0].title']);
      });
    });
});
