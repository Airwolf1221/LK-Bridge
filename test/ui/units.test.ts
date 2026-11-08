import { describe, expect, it } from 'vitest';
import { blocksToLines, diffBlocks, lineDiff, looksLikeBlocks } from '../../ui/src/diff';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, pct } from '../../ui/src/format';

describe('block text', () => {
  it('flattens a tree to one indented line per block, with inline text and scalar properties', () => {
    const tree = [
      { id: 'a', kind: 'heading', level: 2, content: [{ text: 'The ' }, { text: 'Kingdom' }] },
      {
        kind: 'list',
        children: [
          { kind: 'item', content: [{ text: 'First' }] },
          { kind: 'item', children: [{ kind: 'paragraph', content: [{ text: 'Nested' }] }] },
        ],
      },
      { kind: 'unsupported', id: 'u1' },
    ];
    expect(blocksToLines(tree)).toEqual([
      '[heading level=2] The Kingdom',
      '[list]',
      '  [item] First',
      '  [item]',
      '    [paragraph] Nested',
      '[unsupported block: kept as it is]',
    ]);
  });

  it('recognises block content, and nothing else', () => {
    expect(looksLikeBlocks([{ kind: 'paragraph', content: [] }])).toBe(true);
    expect(looksLikeBlocks({ kind: 'paragraph', content: [] })).toBe(true);
    expect(looksLikeBlocks([])).toBe(false);
    expect(looksLikeBlocks('text')).toBe(false);
    expect(looksLikeBlocks({ name: 'x' })).toBe(false);
    expect(looksLikeBlocks(null)).toBe(false);
  });
});

describe('line diff', () => {
  it('marks additions and removals and keeps common lines in order', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
    expect(lineDiff([], ['x'])).toEqual([{ kind: 'add', text: 'x' }]);
    expect(lineDiff(['x'], [])).toEqual([{ kind: 'del', text: 'x' }]);
    expect(lineDiff(['x'], ['x'])).toEqual([{ kind: 'same', text: 'x' }]);
  });

  it('shows a creation as all additions and a deletion as all removals', () => {
    expect(diffBlocks(null, [{ kind: 'paragraph', content: [{ text: 'New' }] }]).map((l) => l.kind)).toEqual([
      'add',
    ]);
    expect(diffBlocks([{ kind: 'paragraph', content: [{ text: 'Gone' }] }], []).map((l) => l.kind)).toEqual([
      'del',
    ]);
  });

  it('falls back to remove-all, add-all for enormous inputs instead of freezing the page', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
    const out = lineDiff(
      big,
      big.map((l) => `${l}!`),
    );
    expect(out).toHaveLength(5000);
    expect(out.filter((l) => l.kind === 'del')).toHaveLength(2500);
  });
});

describe('formatting', () => {
  it('formats numbers, sizes and percentages', () => {
    expect(fmtInt(12000)).toBe('12,000');
    expect(fmtInt(null)).toBe('–');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(3 * 1024 ** 2)).toBe('3.0 MB');
    expect(pct(30, 120)).toBe(25);
    expect(pct(500, 120)).toBe(100);
    expect(pct(5, null)).toBe(0);
  });

  it('formats countdowns and “ago”', () => {
    expect(fmtDuration(45_000)).toBe('45 s');
    expect(fmtDuration(125_000)).toBe('2 min 05 s');
    expect(fmtDuration(3_660_000)).toBe('1 h 01 min');
    expect(fmtDuration(90_000_000)).toBe('1 d 1 h');
    expect(fmtDuration(-5)).toBe('0 s');
    expect(fmtAgo(1000, 1000)).toBe('just now');
    expect(fmtAgo(1000, 31_000)).toBe('30 s ago');
    expect(fmtAgo(0, 120_000)).toBe('2 min ago');
    expect(fmtAgo(null, 0)).toBe('never');
  });
});
