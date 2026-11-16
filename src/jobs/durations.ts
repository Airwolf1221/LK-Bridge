/**
 * v2 E5.5 (backlog 16): a project's measured per-write duration, for the governor's estimates.
 *
 * The median wall time (`finished_at - started_at`) of the project's last `limit` succeeded write steps: registry
 * writes and the upload operations (`op_kind` write or upload; the bridge's own read-only steps are `read`). It is what
 * one write has really taken, the LegendKeeper round trip, the step's own reads and any pacing included, so an estimate
 * built on it tracks what a run will take. The median keeps the occasional long wait (a window filling up, a parked
 * step) from dominating. The governor floors it at the configured spacing (`perWriteFigure`).
 *
 * Read at most once per `ttlMs` (default a minute): the engine estimates on every submit.
 */
import type { Db } from '../db/open.js';
import type { MeasuredWriteDuration } from '../lk/governor/types.js';

/** How many recent write steps the median is taken over. */
export const MEASURED_WRITE_STEPS = 200;

export function medianWriteStepMs(
  db: Db,
  projectId: string,
  limit = MEASURED_WRITE_STEPS,
): MeasuredWriteDuration | null {
  const rows = db
    .prepare(
      `SELECT finished_at - started_at AS ms FROM steps
       WHERE project_id = ? AND op_kind IN ('write', 'upload') AND status = 'succeeded'
         AND started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at
       ORDER BY finished_at DESC LIMIT ?`,
    )
    .all(projectId, limit) as { ms: number }[];
  if (rows.length === 0) return null;
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const ms = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { ms: Math.round(ms), samples: sorted.length };
}

/** A cached source for `GovernorOptions.writeDuration`. A database error reads as "nothing measured". */
export function writeDurationSource(
  db: Db,
  projectId: string,
  now: () => number,
  o: { readonly limit?: number; readonly ttlMs?: number } = {},
): () => MeasuredWriteDuration | null {
  const ttl = o.ttlMs ?? 60_000;
  let cached: { at: number; value: MeasuredWriteDuration | null } | null = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < ttl && t >= cached.at) return cached.value;
    let value: MeasuredWriteDuration | null;
    try {
      value = medianWriteStepMs(db, projectId, o.limit ?? MEASURED_WRITE_STEPS);
    } catch {
      value = null;
    }
    cached = { at: t, value };
    return value;
  };
}
