/**
 * v3 F9 amendment 1 (ADR 0074): a class's wait in words. Wherever the bridge shows a class waiting for budget (the
 * dashboard's queue line, the Overview, `bridge_budget`, a job's status, the snapshot card) it names the tier, the
 * floor and when it frees: "bulk waiting: the daily tier is at 30.0% and bulk may use it up to 30% (frees in 19 min)".
 * Pure functions; the governor fills in the figures.
 */
import type { FloorRow } from '../../config/floors.js';
import type { PriorityClass } from '../../config/lk.js';
import type { TierId } from '../registry-types.js';
import { groupOfTierId, type BudgetTierId } from './groups.js';
import type { WaitCause } from './types.js';

/** The classes as the owner reads them. */
export const CLASS_WORDS: Readonly<Record<PriorityClass, string>> = {
  P0: 'dashboard',
  P1: 'interactive',
  P2: 'jobs',
  P3: 'maintenance',
  P4: 'bulk',
};

const TIER_WORDS: Readonly<Record<TierId, string>> = {
  'write-min': 'the per-minute write tier',
  'write-hour': 'the hourly write tier',
  'key-min': 'the per-minute tier',
  'key-hour': 'the hourly tier',
  'key-day': 'the daily tier',
  'project-hour': 'the project’s hourly tier',
  'items-min': 'the per-minute createMany item tier',
  'items-hour': 'the hourly createMany item tier',
  upload: 'the upload tier',
};

const windowWord = (ms: number) => (ms <= 60_000 ? 'minute' : ms <= 3_600_000 ? 'hour' : 'day');

/** A tier in words: a documented one by name, a learned one by its group and window. */
export function tierWords(tier: BudgetTierId, windowMs?: number | null): string {
  if (tier in TIER_WORDS) return TIER_WORDS[tier as TierId];
  const group = groupOfTierId(tier) ?? tier;
  return `the learned ${group} limit${windowMs ? ` (per ${windowWord(windowMs)})` : ''}`;
}

/** A row of floors in words. */
export function rowWords(row: FloorRow): string {
  return row === 'day' ? 'the day floors' : 'the minute and hour floors';
}

/** "19 min", "45 s", "2 h 5 min"; "now" for nothing left; "never" for no end. */
export function freesInWords(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** 30.0% (one decimal: how full the tier is). */
const pctUsed = (f: number) => `${(Math.floor(f * 1000) / 10).toFixed(1)}%`;
/** 30%, 85%, 97.5% (what the class may use: no trailing zero). */
const pctShare = (f: number) => `${Math.round(f * 1000) / 10}%`;

export interface WaitFigures {
  readonly priority: PriorityClass;
  readonly cause: WaitCause;
  readonly tier: BudgetTierId | null;
  readonly windowMs?: number | null;
  readonly floor: number | null;
  readonly used: number | null;
  readonly limit: number | null;
  readonly freesAtMs: number | null;
  readonly maxInFlight?: number;
}

/** The sentence for a class's wait, at `now`. */
export function waitText(w: WaitFigures, now: number): string {
  const who = CLASS_WORDS[w.priority];
  const frees = w.freesAtMs === null ? '' : ` (frees in ${freesInWords(w.freesAtMs - now)})`;
  switch (w.cause) {
    case 'tier': {
      const tier = w.tier === null ? 'a tier' : tierWords(w.tier, w.windowMs);
      const at = w.used !== null && w.limit ? ` is at ${pctUsed(w.used / w.limit)}` : ' is at its floor';
      const share = w.floor === null ? '' : ` and ${who} may use it up to ${pctShare(1 - w.floor)}`;
      return `${who} waiting: ${tier}${at}${share}${frees}`;
    }
    case 'refused':
      return `${who} waiting: LegendKeeper refused ${w.tier === null ? 'a tier' : tierWords(w.tier, w.windowMs)} (429)${frees}`;
    case 'pacing':
      return `${who} waiting: the gap between writes${frees}`;
    case 'agents':
      return `${who} waiting: agents’ calls and jobs (P1, P2) are queued and go first`;
    case 'in-flight':
      return `${who} waiting: every request slot is taken${w.maxInFlight ? ` (${w.maxInFlight} in flight)` : ''}`;
  }
}
