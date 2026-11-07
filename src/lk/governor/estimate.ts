/**
 * Workload estimate maths (PLAN §5.4, `bridge_estimate`). Pure: takes a snapshot plus settings.
 *
 * For each tier the work draws on, `demand` units must pass. The class may use `cap = limit - reserve` per window
 * and has `available = cap - used` right now. Units beyond `available` flow at the steady rate `cap / window`,
 * so the tier needs `(demand - available) * window / cap`. Write pacing adds its own lower bound: the first writes
 * go at the normal spacing until the stretch threshold's per-minute pace is reached, the rest at the stretched
 * spacing. The answer is the maximum of all of these.
 */
import type { GovernorSettings } from '../../config/lk.js';
import type { TierId } from '../registry-types.js';
import type { BudgetSnapshot, Estimate, EstimateInput, TierEstimate } from './types.js';

export const CREATE_MANY_MAX_ITEMS = 100;

const WRITE_TIERS: readonly TierId[] = ['write-min', 'write-hour'];
const ALL_TIERS: readonly TierId[] = ['key-min', 'key-hour', 'key-day', 'project-hour'];
const ITEM_TIERS: readonly TierId[] = ['items-min', 'items-hour'];

function count(n: number | undefined, name: string): number {
  const v = n ?? 0;
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`estimate: ${name} must be a non-negative number`);
  return Math.ceil(v);
}

function reserveUnits(limit: number, floor: number): number {
  return Math.ceil(Math.round(limit * floor * 1e6) / 1e6);
}

export function estimateFrom(
  snapshot: BudgetSnapshot,
  settings: GovernorSettings,
  input: EstimateInput,
): Estimate {
  const reads = count(input.reads, 'reads');
  const writes = count(input.writes, 'writes');
  const items = count(input.createManyItems, 'createManyItems');
  const createManyCalls = Math.ceil(items / CREATE_MANY_MAX_ITEMS);
  const writeCalls = writes + createManyCalls;
  const floor = settings.reserveFloors[input.priority ?? 'P2'];
  const now = snapshot.atMs;

  const demandFor = (tier: TierId): number => {
    if (WRITE_TIERS.includes(tier)) return writeCalls;
    if (ALL_TIERS.includes(tier)) return reads + writeCalls;
    if (ITEM_TIERS.includes(tier)) return items;
    return 0;
  };

  const tiers: TierEstimate[] = [];
  for (const tier of [...WRITE_TIERS, ...ALL_TIERS, ...ITEM_TIERS]) {
    const t = snapshot.tiers[tier];
    const demand = demandFor(tier);
    if (t.limit === null || t.windowMs === null || demand === 0) continue;
    const cap = Math.max(0, t.limit - reserveUnits(t.limit, floor));
    const available = Math.max(0, cap - t.used);
    const blockedMs = t.blockedUntilMs !== null ? Math.max(0, t.blockedUntilMs - now) : 0;
    let timeMs: number;
    if (demand <= available) timeMs = blockedMs;
    else if (cap === 0) timeMs = Number.POSITIVE_INFINITY;
    else timeMs = Math.max(blockedMs, ((demand - available) * t.windowMs) / cap);
    tiers.push({ tier, demand, available, capacityPerWindow: cap, timeMs: Math.ceil(timeMs) });
  }

  // Pacing: spacing stretches once the per-minute pace would project past the hourly threshold.
  const fastWrites = Math.floor(settings.stretchHourlyWrites / 60) + 1;
  const pacingMs =
    writeCalls === 0
      ? 0
      : Math.min(writeCalls, fastWrites) * settings.writeSpacingMs +
        Math.max(0, writeCalls - fastWrites) * settings.writeSpacingStretchedMs;

  let tightest: TierEstimate | undefined;
  for (const t of tiers) if (!tightest || t.timeMs > tightest.timeMs) tightest = t;
  let tightestTier: TierId | 'pacing';
  const maxTier = tightest?.timeMs ?? 0;
  if (pacingMs > 0 && pacingMs >= maxTier) tightestTier = 'pacing';
  else if (tightest && maxTier > 0) tightestTier = tightest.tier;
  else {
    // Nothing has to wait: report the tier left with the least headroom relative to its size.
    let best: { tier: TierId; ratio: number } | undefined;
    for (const t of tiers) {
      const ratio = (t.available - t.demand) / Math.max(1, t.capacityPerWindow);
      if (!best || ratio < best.ratio) best = { tier: t.tier, ratio };
    }
    tightestTier = best?.tier ?? 'key-day';
  }

  const day = snapshot.tiers['key-day'];
  const dayCap = day.limit === null ? Number.POSITIVE_INFINITY : day.limit - reserveUnits(day.limit, floor);
  const dayRemaining = Math.max(0, dayCap - day.used);
  const dayNeeded = reads + writeCalls;

  return {
    wallClockMs: Math.max(pacingMs, maxTier),
    tightestTier,
    fitsToday: dayNeeded <= dayRemaining,
    dayRemaining,
    dayNeeded,
    pacingMs,
    calls: { reads, writes, createManyCalls },
    tiers,
  };
}
