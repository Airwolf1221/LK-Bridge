import { describe, expect, it } from 'vitest';
import { blocksToLines, diffBlocks, lineDiff, looksLikeBlocks } from '../../ui/src/diff';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, fmtTime, pct, principalText } from '../../ui/src/format';

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
    expect(fmtBytes(10 * 1024 ** 3)).toBe('10.0 GB'); // v2 E1a: the snapshot store and the disk
    expect(fmtBytes(2.5 * 1024 ** 4)).toBe('2.5 TB');
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

describe('dates carry the year when it is not the current one (hotfix, ADR 0033)', () => {
  const utc = (y: number, m: number, d: number, h = 0, min = 0, sec = 0) =>
    Date.UTC(y, m - 1, d, h, min, sec);
  const NOW = utc(2026, 11, 10, 12);

  it('omits the year inside the current year and adds it outside it, in British English, 24-hour', () => {
    expect(fmtTime(utc(2026, 11, 3, 2, 12, 35), NOW, 'UTC')).toBe('3 Nov, 02:12:35');
    expect(fmtTime(utc(2027, 11, 3, 2, 12, 35), NOW, 'UTC')).toBe('3 Nov 2027, 02:12:35');
    expect(fmtTime(utc(2025, 12, 31, 23, 59, 59), NOW, 'UTC')).toBe('31 Dec 2025, 23:59:59');
    expect(fmtTime(utc(2026, 1, 1, 13, 5, 0), NOW, 'UTC')).toBe('1 Jan, 13:05:00'); // 24-hour, not 1:05 pm
  });

  it('across a year boundary: the same instant reads differently before and after midnight on 31 December', () => {
    const t = utc(2026, 12, 31, 23, 0, 0);
    expect(fmtTime(t, utc(2026, 12, 31, 23, 30), 'UTC')).toBe('31 Dec, 23:00:00');
    expect(fmtTime(t, utc(2027, 1, 1, 0, 30), 'UTC')).toBe('31 Dec 2026, 23:00:00');
    // The year is the one in the display zone, not in UTC: 23:30 UTC on 31 Dec is already 2027 in Auckland.
    expect(fmtTime(utc(2026, 12, 31, 23, 30), utc(2026, 6, 1), 'Pacific/Auckland')).toContain('2027');
    expect(fmtTime(null, NOW)).toBe('–');
  });

  it('a PAT created on 8 Nov 2026 with 360 days expires on 3 Nov 2027, from auth_pats.expires_at', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const created = utc(2026, 11, 8, 2, 12, 35);
      const pats = new PatService({
        store: new AuthStore(db),
        event: () => {},
        now: () => Math.floor(created / 1000),
      });
      const { pat } = pats.create({ name: 'Claude Code (PC)', expiresInDays: 360 });
      const row = db.prepare('SELECT created_at, expires_at FROM auth_pats WHERE id = ?').get(pat.id) as {
        created_at: number;
        expires_at: number;
      };
      expect(new Date(row.created_at * 1000).toISOString()).toBe('2026-11-08T02:12:35.000Z');
      expect(new Date(row.expires_at * 1000).toISOString()).toBe('2027-11-03T02:12:35.000Z');
      // What the dashboard shows on 10 Nov 2026: the creation without a year, the expiry WITH it.
      expect(fmtTime(row.created_at * 1000, NOW, 'UTC')).toBe('8 Nov, 02:12:35');
      expect(fmtTime(row.expires_at * 1000, NOW, 'UTC')).toBe('3 Nov 2027, 02:12:35');
    } finally {
      db.close();
    }
  });
});

describe('principal names (hotfix, ADR 0033)', () => {
  const names = {
    pat_1: { id: 'pat_1', name: 'ChatGPT (removed 10 Nov 2026)', type: 'removed' as const, removedAt: 1 },
    grant_2: { id: 'grant_2', name: 'Claude', type: 'grant' as const, removedAt: null },
  };
  it('names a removed connection from its tombstone, a live one by its label, and never shows a bare id', () => {
    expect(principalText('pat_1', names, 'chatgpt')).toBe('ChatGPT (removed 10 Nov 2026)');
    expect(principalText('pat_1', names, 'chatgpt', true)).toBe('ChatGPT (removed 10 Nov 2026)');
    expect(principalText('grant_2', names, 'claude')).toBe('Claude');
    expect(principalText('grant_2', names, 'Claude (OAuth)', true)).toBe('Claude (OAuth)');
    expect(principalText('pat_gone', undefined, 'chatgpt')).toBe('chatgpt');
    expect(principalText('pat_gone', {}, undefined)).toBe('Unknown connection');
    expect(principalText('system', undefined)).toBe('System');
  });
});
