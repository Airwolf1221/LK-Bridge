import { describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { estimateFrom } from '../../src/lk/governor/estimate.js';
import { formatBudgetFooter } from '../../src/lk/governor/footer.js';
import type { BudgetSnapshot, TierSnapshot } from '../../src/lk/governor/types.js';
import { TIER_IDS, type TierId } from '../../src/lk/registry-types.js';
import { lkError, rate, setup, WRITE } from './governor-helpers.js';

const settings = defaultGovernorSettings();
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function snapshot(
  used: Partial<Record<TierId, number>> = {},
  queues: { P0: number; P1: number; P2: number; P3: number; P4?: number } = { P0: 0, P1: 0, P2: 0, P3: 0 },
): BudgetSnapshot {
  const tiers = Object.fromEntries(
    TIER_IDS.map((tier) => {
      const limit = settings.tierLimits[tier];
      const t: TierSnapshot = {
        tier,
        limit,
        configuredLimit: limit,
        used: used[tier] ?? 0,
        remaining: limit === null ? null : limit - (used[tier] ?? 0),
        windowMs: settings.tierWindowsMs[tier],
        resetAtMs: null,
        blockedUntilMs: null,
        inFlight: 0,
        reactiveOnly: limit === null,
        drift: null,
      };
      return [tier, t];
    }),
  ) as Record<TierId, TierSnapshot>;
  return {
    atMs: NOW,
    tiers,
    operationTiers: [],
    queues: { P4: 0, ...queues },
    inFlight: 0,
    writeSpacingMs: 500,
    nextWriteAtMs: null,
  };
}

describe('estimate', () => {
  it('the PLAN §5.4 example: 3,500 reads + 800 writes as a job (P2)', () => {
    const e = estimateFrom(snapshot(), settings, { reads: 3500, writes: 800 });
    // P2 may use 225/min of key-min: (4,300 - 225) * 60 s / 225 = 1,086,667 ms (~18 min).
    expect(e.tightestTier).toBe('key-min');
    expect(e.wallClockMs).toBe(1_086_667);
    // Pacing: 51 writes at 0.5 s, then 749 at 1.2 s.
    expect(e.pacingMs).toBe(51 * 500 + 749 * 1200);
    expect(e.fitsToday).toBe(true);
    expect(e.dayNeeded).toBe(4300);
    expect(e.dayRemaining).toBe(45_000);
    expect(e.tiers.find((t) => t.tier === 'key-hour')).toMatchObject({
      demand: 4300,
      available: 4500,
      timeMs: 0,
    });
  });

  it('write-heavy work is bounded by pacing', () => {
    const e = estimateFrom(snapshot(), settings, { writes: 778, priority: 'P1' });
    expect(e.tightestTier).toBe('pacing');
    expect(e.wallClockMs).toBe(51 * 500 + 727 * 1200);
  });

  it('createManyItems adds one write per 100 items and draws the items tiers', () => {
    const e = estimateFrom(snapshot(), settings, { createManyItems: 1000 });
    expect(e.calls).toEqual({ reads: 0, writes: 0, createManyCalls: 10 });
    expect(e.tiers.find((t) => t.tier === 'items-min')).toMatchObject({ demand: 1000, available: 450 });
    expect(e.tightestTier).toBe('items-min');
    expect(e.wallClockMs).toBe(Math.ceil((550 * 60_000) / 450));
  });

  it('accounts for budget already used and for the class floor', () => {
    const busy = snapshot({ 'key-day': 40_000 });
    expect(estimateFrom(busy, settings, { reads: 6000 })).toMatchObject({
      fitsToday: false,
      dayRemaining: 5000,
    });
    expect(estimateFrom(busy, settings, { reads: 6000, priority: 'P0' })).toMatchObject({
      fitsToday: true,
      dayRemaining: 20_000,
    });
  });

  it('small work that waits on nothing names the tier with least headroom', () => {
    const e = estimateFrom(snapshot({ 'write-min': 80 }), settings, { reads: 1, writes: 1, priority: 'P0' });
    expect(e.wallClockMs).toBe(500);
    expect(e.tightestTier).toBe('pacing');
    const r = estimateFrom(snapshot({ 'key-min': 280 }), settings, { reads: 5, priority: 'P0' });
    expect(r).toMatchObject({ wallClockMs: 0, tightestTier: 'key-min' });
  });

  it('rejects negative input', () => {
    expect(() => estimateFrom(snapshot(), settings, { reads: -1 })).toThrow(RangeError);
  });

  it('governor.estimate uses the live snapshot', async () => {
    const env = setup();
    await env.call({ costs: WRITE });
    expect(env.governor.estimate({ writes: 1 }).tiers[0]).toMatchObject({ tier: 'write-min', available: 89 });
  });
});

describe('budget footer', () => {
  it('produces the PLAN §5.4 line', () => {
    const s = snapshot(
      {
        'write-min': 87,
        'write-hour': 2410,
        'key-min': 241,
        'key-hour': 5102,
        'key-day': 48_000,
        'project-hour': 9800,
      },
      { P0: 0, P1: 0, P2: 14, P3: 0 },
    );
    expect(formatBudgetFooter(s)).toBe(
      'budget: writes 87/120·min 2,410/3,000·h | all 241/300·min 5,102/6,000·h 48k/60k·d | project 9.8k/12k·h | queue P1:0 P2:14',
    );
  });

  it('shows P0/P3 only when non-zero and rounds large numbers', () => {
    const s = snapshot({ 'key-day': 123, 'project-hour': 11_499 }, { P0: 1, P1: 2, P2: 0, P3: 5 });
    expect(formatBudgetFooter(s)).toBe(
      'budget: writes 0/120·min 0/3,000·h | all 0/300·min 0/6,000·h 123/60k·d | project 11k/12k·h | queue P0:1 P1:2 P2:0 P3:5',
    );
  });

  it('appends blocked tiers while LK refuses them', async () => {
    const env = setup();
    env.setResponder(() =>
      lkError(429, 'RATE_LIMITED', { ...rate(300, 0, env.clock.now() + 120_000), 'retry-after': '120' }),
    );
    await expect(env.call()).rejects.toThrow();
    expect(formatBudgetFooter(env.governor.snapshot())).toMatch(/ \| blocked key-min 120s$/);
  });
});

describe('the footer names the project (v2 A1)', () => {
  it('reads "budget (<project>): …" when given the project, and is otherwise unchanged', () => {
    const s = snapshot({ 'write-min': 3 }, { P0: 0, P1: 1, P2: 0, P3: 0 });
    expect(formatBudgetFooter(s, 'arkona')).toBe(
      formatBudgetFooter(s).replace(/^budget: /, 'budget (arkona): '),
    );
    expect(formatBudgetFooter(s)).toMatch(/^budget: writes /);
  });
});
