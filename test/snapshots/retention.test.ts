/**
 * v2 E1a follow-up (ADR 0042 decision 4): the retention of full snapshots (nightly): every one for 30 days, then one a
 * week (the latest of its ISO week, London time) for 8 weeks, then none; the newest complete one is never removed.
 */
import { describe, expect, it } from 'vitest';
import type { SnapshotRow } from '../../src/snapshots/db.js';
import { fullsToDrop, isoWeekKey } from '../../src/snapshots/service.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const SETTINGS = { keepFullDays: 30, keepWeekly: 8 };

/** A nightly full snapshot at 00:30 London time, `n` nights back (the night of 13 November is 0). */
function night(n: number, state: 'complete' | 'partial' = 'complete'): SnapshotRow {
  const d = new Date(Date.UTC(2026, 10, 13, 0, 30) - n * DAY);
  // London is GMT from 25 October 2026 (BST before): 00:30 BST is 23:30 UTC the evening before.
  const bst = d.getTime() < Date.parse('2026-10-25T01:00:00Z');
  const at = bst ? d.getTime() - 3_600_000 : d.getTime();
  return {
    id: `20261113T${String(n).padStart(6, '0')}Z-full-${n}`,
    takenAt: at,
    kind: 'full',
    state,
  } as SnapshotRow;
}

describe('isoWeekKey', () => {
  it('is the ISO week of the London date', () => {
    expect(isoWeekKey(Date.parse('2026-11-13T12:00:00Z'))).toBe('2026-W46'); // a Friday
    expect(isoWeekKey(Date.parse('2026-11-08T00:30:00Z'))).toBe('2026-W45'); // a Sunday belongs to the week before
    expect(isoWeekKey(Date.parse('2026-11-09T00:30:00Z'))).toBe('2026-W46'); // the Monday
    expect(isoWeekKey(Date.parse('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(Date.parse('2027-01-01T12:00:00Z'))).toBe('2026-W53'); // a Friday: still 2026's week 53
    expect(isoWeekKey(Date.parse('2024-12-30T12:00:00Z'))).toBe('2025-W01');
  });
  it('uses London time: 23:30 UTC on a summer Sunday is already Monday in London', () => {
    expect(isoWeekKey(Date.parse('2026-08-02T23:30:00Z'))).toBe('2026-W32'); // Monday 3 August, 00:30 BST
    expect(isoWeekKey(Date.parse('2026-08-02T22:30:00Z'))).toBe('2026-W31'); // Sunday 2 August, 23:30 BST
  });
});

describe('fullsToDrop', () => {
  const all = Array.from({ length: 121 }, (_, n) => night(n));
  const drop = fullsToDrop(all, NOW, SETTINGS);
  const kept = all.filter((f) => !drop.includes(f));
  const ageDays = (f: SnapshotRow) => (NOW - f.takenAt) / DAY;

  it('keeps every full snapshot of the last 30 days', () => {
    const recent = all.filter((f) => ageDays(f) <= 30);
    expect(recent.length).toBeGreaterThanOrEqual(30);
    for (const f of recent) expect(kept).toContain(f);
  });

  it('then keeps one a week: the latest of each ISO week, for 8 weeks, and nothing older', () => {
    const old = kept.filter((f) => ageDays(f) > 30);
    expect(old.length).toBe(8);
    // One per ISO week, each the latest snapshot of that week among all of them.
    const weeks = old.map((f) => isoWeekKey(f.takenAt));
    expect(new Set(weeks).size).toBe(8);
    for (const f of old) {
      const sameWeek = all.filter((x) => isoWeekKey(x.takenAt) === isoWeekKey(f.takenAt));
      expect(f.takenAt).toBe(Math.max(...sameWeek.map((x) => x.takenAt)));
      expect(ageDays(f)).toBeLessThan(30 + 8 * 7);
    }
    // Nothing older than the 8 weeks survives.
    expect(kept.filter((f) => ageDays(f) >= 30 + 8 * 7).length).toBe(0);
    expect(kept.length).toBe(all.filter((f) => ageDays(f) <= 30).length + 8);
  });

  it('is settings: a different window and number of weeks', () => {
    const d = fullsToDrop(all, NOW, { keepFullDays: 7, keepWeekly: 2 });
    const k = all.filter((f) => !d.includes(f));
    expect(k.filter((f) => ageDays(f) > 7).length).toBe(2);
    expect(k.filter((f) => ageDays(f) <= 7).length).toBe(all.filter((f) => ageDays(f) <= 7).length);
    // No weeks at all: only the window.
    const none = fullsToDrop(all, NOW, { keepFullDays: 30, keepWeekly: 0 });
    expect(all.filter((f) => !none.includes(f)).every((f) => ageDays(f) <= 30)).toBe(true);
  });

  it('never removes the newest complete full snapshot, however old; a partial one is kept only in the first window', () => {
    const lone = [night(200)];
    expect(fullsToDrop(lone, NOW, SETTINGS)).toEqual([]);
    const partialOld = night(45, 'partial'); // would be the latest of its week, but it is partial
    const completeSameWeek = night(46);
    expect(isoWeekKey(partialOld.takenAt)).toBe(isoWeekKey(completeSameWeek.takenAt));
    const d = fullsToDrop([night(0), partialOld, completeSameWeek, night(47)], NOW, SETTINGS);
    expect(d).toContain(partialOld);
    // Within 30 days a partial one stays like the rest.
    expect(fullsToDrop([night(0), night(3, 'partial')], NOW, SETTINGS)).toEqual([]);
  });

  it('nothing to remove while every snapshot is young', () => {
    expect(fullsToDrop(all.slice(0, 25), NOW, SETTINGS)).toEqual([]);
  });
});
