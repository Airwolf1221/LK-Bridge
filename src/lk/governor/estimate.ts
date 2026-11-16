/**
 * Workload estimate maths (PLAN §5.4, `bridge_estimate`). Pure: takes a snapshot plus settings.
 *
 * For each tier the work draws on, `demand` units must pass. The class may use `cap = limit - reserve` per window
 * and has `available = cap - used` right now. Units beyond `available` flow at the steady rate `cap / window`,
 * so the tier needs `(demand - available) * window / cap`. Write pacing adds its own lower bound: the first writes
 * go at the normal spacing until the stretch threshold's per-minute pace is reached, the rest at the stretched
 * spacing. The answer is the maximum of all of these.
 *
 * v2 E5.5 (ADR 0047): every limit is the tier's effective one (the snapshot's `limit`, which is `limitOf`), and the
 * learned operation tiers are tiers too, but only for the operations the caller names in `ops` that are in their group
 * (a rehearsal's image uploads are paced by the `assets` group; its other writes are not). Backlog 16: a write takes at
 * least the project's measured per-write duration (the median wall time of its recent write steps), floored at the
 * configured spacing; `perWrite` says which figure was used.
 */
import type { GovernorSettings } from '../../config/lk.js';
import type { TierId } from '../registry-types.js';
import { drawsLearnedTier, type BudgetTierId } from './groups.js';
import type {
  BudgetSnapshot,
  Estimate,
  EstimateInput,
  MeasuredWriteDuration,
  OperationTierEstimate,
  PerWriteFigure,
  TierEstimate,
} from './types.js';

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

/** v2 E5.5: the time per write the pacing assumes: the measured duration when it is above the spacing, else the spacing. */
export function perWriteFigure(
  settings: Pick<GovernorSettings, 'writeSpacingMs'>,
  measured: MeasuredWriteDuration | null,
): PerWriteFigure {
  const spacingMs = settings.writeSpacingMs;
  const m = measured && measured.samples > 0 && Number.isFinite(measured.ms) ? measured : null;
  return m && m.ms > spacingMs
    ? { ms: Math.ceil(m.ms), source: 'measured', spacingMs, measured: m }
    : { ms: spacingMs, source: 'spacing', spacingMs, measured: m };
}

export function estimateFrom(
  snapshot: BudgetSnapshot,
  settings: GovernorSettings,
  input: EstimateInput,
  measured: MeasuredWriteDuration | null = null,
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
    tiers.push({
      tier,
      limit: t.limit,
      windowMs: t.windowMs,
      demand,
      available,
      capacityPerWindow: cap,
      timeMs: Math.ceil(timeMs),
    });
  }

  // v2 E5.5: the learned operation tiers, for the named operations in their group only.
  const ops = Object.entries(input.ops ?? {}).map(([op, n]) => [op, count(n, `ops.${op}`)] as const);
  const operationTiers: OperationTierEstimate[] = [];
  for (const g of snapshot.operationTiers ?? []) {
    let demand = 0;
    for (const [op, n] of ops) if (drawsLearnedTier(op, g.group, g.ops)) demand += n;
    if (demand === 0) continue;
    const cap = Math.max(1, g.limit - reserveUnits(g.limit, floor));
    const available = Math.max(0, cap - g.used);
    const blockedMs = g.blockedUntilMs !== null ? Math.max(0, g.blockedUntilMs - now) : 0;
    const timeMs =
      demand <= available ? blockedMs : Math.max(blockedMs, ((demand - available) * g.windowMs) / cap);
    operationTiers.push({
      tier: g.id,
      id: g.id,
      group: g.group,
      limit: g.limit,
      windowMs: g.windowMs,
      demand,
      available,
      capacityPerWindow: cap,
      timeMs: Math.ceil(timeMs),
    });
  }

  // Pacing: spacing stretches once the per-minute pace would project past the hourly threshold. Backlog 16: a write
  // takes at least the measured per-write duration.
  const perWrite = perWriteFigure(settings, measured);
  const floorMs = perWrite.measured ? perWrite.measured.ms : 0;
  const fastWrites = Math.floor(settings.stretchHourlyWrites / 60) + 1;
  const pacingMs =
    writeCalls === 0
      ? 0
      : Math.ceil(
          Math.min(writeCalls, fastWrites) * perWrite.ms +
            Math.max(0, writeCalls - fastWrites) * Math.max(settings.writeSpacingStretchedMs, floorMs),
        );

  let tightest: TierEstimate | undefined;
  for (const t of [...tiers, ...operationTiers]) if (!tightest || t.timeMs > tightest.timeMs) tightest = t;
  let tightestTier: BudgetTierId | 'pacing';
  const maxTier = tightest?.timeMs ?? 0;
  if (pacingMs > 0 && pacingMs >= maxTier) tightestTier = 'pacing';
  else if (tightest && maxTier > 0) tightestTier = tightest.tier;
  else {
    // Nothing has to wait: report the tier left with the least headroom relative to its size.
    let best: { tier: BudgetTierId; ratio: number } | undefined;
    for (const t of [...tiers, ...operationTiers]) {
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
    operationTiers,
    perWrite,
  };
}
