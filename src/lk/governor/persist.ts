/**
 * Governor counters across restarts (v1.0.1, review finding F-14).
 *
 * The governor's sliding windows live in memory. Straight after a restart it used to believe the last minute, hour and
 * day were empty, although LegendKeeper still counts them, so under heavy use it could over-estimate the remaining
 * budget until a response's rate headers corrected the tightest tier. Now each tier's recent counts are saved (at most
 * every `intervalMs` while they change, and on `close()`) and restored when the governor is built.
 *
 * - **Compact and conservative.** A tier's events are grouped into buckets of `max(1 s, window / 60)`, and each bucket
 *   is stamped with the LATEST time in it, so a restored unit never expires earlier than the real one: the restored
 *   model can only over-count, which makes the governor wait a little longer, never send too much.
 * - **Stale data is ignored.** A bucket whose time plus the tier's (current) window has passed is dropped; a bucket from
 *   the future (the clock went back) is clamped to now. A 429 block is kept only while it is still in the future
 *   (and at most a day ahead).
 * - **Never fatal.** A missing record restores nothing; an unreadable or malformed one restores nothing and is reported
 *   through `warn`; a failing save is reported and the governor carries on. Restored totals are capped at the tier's
 *   configured limit, so a corrupt record can at worst make a tier look full until its window passes.
 */
import * as z from 'zod';
import { TIER_IDS, type TierId } from '../registry-types.js';
import type { WindowEvent } from './window.js';

export const COUNTERS_FORMAT = 1;

/** What is stored: per tier, `[time, units]` buckets (oldest first) and an active 429 block. */
export interface PersistedCounters {
  readonly v: typeof COUNTERS_FORMAT;
  readonly savedAt: number;
  readonly tiers: Partial<
    Record<TierId, { readonly buckets: [number, number][]; readonly blockedUntil?: number }>
  >;
}

/** Where the counters live (the bridge uses SQLite: `createSqliteCounterStore`). `load` returns the raw record. */
export interface CounterStore {
  load(): unknown;
  save(counters: PersistedCounters): void;
}

export interface GovernorPersistence {
  readonly store: CounterStore;
  /** Longest gap between a change and its save. Default 10 s. */
  readonly intervalMs?: number;
  /** Reports a load or save problem (never fatal). */
  readonly warn?: (message: string, error?: unknown) => void;
}

export const DEFAULT_PERSIST_INTERVAL_MS = 10_000;
const MAX_BLOCK_AHEAD_MS = 86_400_000;

/** Groups live events into conservative buckets (each at the latest time in it). */
export function toBuckets(events: readonly WindowEvent[], windowMs: number): [number, number][] {
  const size = Math.max(1000, Math.floor(windowMs / 60));
  const out: [number, number][] = [];
  let key: number | null = null;
  for (const e of events) {
    if (e.n <= 0) continue;
    const k = Math.floor(e.t / size);
    const last = out[out.length - 1];
    if (last && k === key) {
      last[0] = Math.max(last[0], e.t);
      last[1] += e.n;
    } else {
      out.push([e.t, e.n]);
      key = k;
    }
  }
  return out;
}

const finite = z.number().finite();
const recordSchema = z.object({
  v: z.literal(COUNTERS_FORMAT),
  savedAt: finite,
  tiers: z.record(
    z.string(),
    z.object({
      buckets: z.array(z.tuple([finite, z.number().int().positive()])).max(10_000),
      blockedUntil: finite.optional(),
    }),
  ),
});

export interface RestoredTier {
  readonly events: WindowEvent[];
  readonly blockedUntil: number;
}

/**
 * Validates a raw record and returns, per tier the governor has, the events still inside the tier's window at `now`
 * and any 429 block still ahead. Throws on a malformed record (the governor then restores nothing and warns).
 */
export function restoreCounters(
  raw: unknown,
  now: number,
  tiers: Readonly<Record<TierId, { readonly windowMs: number | null; readonly limit: number | null }>>,
): Partial<Record<TierId, RestoredTier>> {
  const record = recordSchema.parse(raw);
  const out: Partial<Record<TierId, RestoredTier>> = {};
  for (const [id, saved] of Object.entries(record.tiers)) {
    if (!(TIER_IDS as readonly string[]).includes(id)) continue; // a tier this release does not have
    const tier = tiers[id as TierId];
    let blockedUntil = 0;
    if (
      saved.blockedUntil !== undefined &&
      saved.blockedUntil > now &&
      saved.blockedUntil <= now + MAX_BLOCK_AHEAD_MS
    )
      blockedUntil = saved.blockedUntil;
    const events: WindowEvent[] = [];
    if (tier.windowMs !== null && tier.limit !== null) {
      let total = 0;
      const live = saved.buckets
        .map(([t, n]) => ({ t: Math.min(t, now), n }))
        .filter((e) => e.t + tier.windowMs! > now)
        .sort((a, b) => a.t - b.t);
      // Newest first when capping, so the units kept are the ones that last longest.
      for (let i = live.length - 1; i >= 0 && total < tier.limit; i--) {
        const e = live[i]!;
        const n = Math.min(e.n, tier.limit - total);
        total += n;
        events.unshift({ t: e.t, n });
      }
    }
    if (events.length > 0 || blockedUntil > 0) out[id as TierId] = { events, blockedUntil };
  }
  return out;
}

/** The minimal SQLite surface the store needs (better-sqlite3's `Database`). */
interface SqliteLike {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
}

/**
 * Keeps the counters in the bridge database, table `governor_counters` (migration 0500), one row. `load` returns the
 * parsed JSON (or undefined when there is no row); a row that is not JSON throws, which the governor reports.
 */
export function createSqliteCounterStore(db: SqliteLike, key = 'lk'): CounterStore {
  return {
    load() {
      const row = db.prepare('SELECT data FROM governor_counters WHERE key = ?').get(key) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as unknown) : undefined;
    },
    save(counters) {
      db.prepare(
        `INSERT INTO governor_counters (key, saved_at, data) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET saved_at = excluded.saved_at, data = excluded.data`,
      ).run(key, counters.savedAt, JSON.stringify(counters));
    },
  };
}
