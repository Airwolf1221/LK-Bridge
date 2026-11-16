/**
 * v2 E5.5 (ADR 0047, backlog 16): the time a restore or a rehearsal should take, and the figures it rests on.
 *
 * Both run their steps one after another, so the governor's estimate (which assumes the work flows at the budget's
 * steady rate) is only a lower bound. On top of it:
 *
 * - every write takes at least `msPerWrite`: the project's measured per-write duration (the median wall time of its
 *   recent write steps), floored at the configured spacing, or the class's share of a write tier once the work needs
 *   more than a window of it (`pacingOf`); every read its share of the request tiers likewise;
 * - the steps of a learned operation group (a rehearsal's asset folder and image uploads) take at least the time that
 *   group's learned limit allows them, and only those steps: the rest are paced by the documented tiers as usual.
 *
 * `figures` says which numbers were used: the per-write duration and where it came from, each documented tier's
 * effective limit and the class's share of it, and each learned group's limit and the time its steps take.
 */
import { rateGroupOf, UPLOAD_PUT_OP } from '../lk/governor/groups.js';
import { getOperation } from '../lk/registry.js';

/** What a plan needs of the governor's estimate (structural, so tests can stub it). */
export interface EstimateLike {
  readonly wallClockMs: number;
  readonly fitsToday: boolean;
  readonly tightestTier: string;
  readonly pacingMs?: number;
  readonly tiers?: readonly {
    readonly tier: string;
    readonly demand: number;
    readonly capacityPerWindow: number;
    readonly limit?: number | null;
    readonly windowMs?: number | null;
  }[];
  readonly operationTiers?: readonly {
    readonly group: string;
    readonly limit: number;
    readonly windowMs: number;
    readonly demand: number;
    readonly capacityPerWindow: number;
    readonly timeMs: number;
  }[];
  readonly perWrite?: {
    readonly ms: number;
    readonly source: 'measured' | 'spacing';
    readonly spacingMs: number;
    readonly measured: { readonly ms: number; readonly samples: number } | null;
  };
}

/** What the governor is asked for (the same as `EstimateInput`, with the class fixed by the caller). */
export interface PlanEstimateInput {
  readonly reads: number;
  readonly writes: number;
  readonly priority?: 'P1' | 'P2' | 'P3';
  readonly ops?: Readonly<Record<string, number>>;
}

export interface PlanFigures {
  /** The time one write is taken to cost: the measured median when it is above the spacing, otherwise the spacing. */
  readonly perWrite: {
    readonly ms: number;
    readonly from: 'measured' | 'spacing';
    readonly measuredMs: number | null;
    readonly samples: number;
    readonly spacingMs: number;
  } | null;
  /** The documented tiers the work draws: each one's effective limit and the class's share of it per window. */
  readonly limits: readonly {
    readonly tier: string;
    readonly limit: number | null;
    readonly windowMs: number | null;
    readonly share: number;
  }[];
  /** Learned operation groups that pace some of the steps: the limit, and the steps and time they take. */
  readonly groups: readonly {
    readonly group: string;
    readonly limit: number;
    readonly windowMs: number;
    readonly steps: number;
    readonly ms: number;
  }[];
}

const WINDOW_MS: Readonly<Record<string, number>> = { min: 60_000, hour: 3_600_000, day: 86_400_000 };
const windowOf = (tier: string): number | null => WINDOW_MS[tier.split('-').pop() ?? ''] ?? null;

/**
 * v2 E5.4: the time per write and per read at the plan's class, from the governor's own estimate: a write takes at
 * least the pacing per write (the spacing, or since E5.5 the measured per-write duration if longer), and once the work
 * needs more than a window's share of a tier (`capacityPerWindow`), its share of that tier (`window / capacity`): a
 * write of the write and request tiers, a read of the request tiers.
 */
export function pacingOf(
  est: Pick<EstimateLike, 'pacingMs' | 'tiers'>,
  writes: number,
): { msPerWrite: number; msPerRead: number } {
  let msPerWrite = writes > 0 && est.pacingMs ? est.pacingMs / writes : 0;
  let msPerRead = 0;
  for (const t of est.tiers ?? []) {
    const w = windowOf(t.tier);
    // A tier slows the run only once the work needs more than one window's share; then it flows at its steady rate.
    if (w === null || t.capacityPerWindow <= 0 || t.demand <= t.capacityPerWindow) continue;
    const per = w / t.capacityPerWindow;
    if (t.tier.startsWith('write-')) msPerWrite = Math.max(msPerWrite, per);
    else if (!t.tier.startsWith('items-')) {
      msPerRead = Math.max(msPerRead, per);
      // A write is also a request: it costs at least its share of the request tiers.
      msPerWrite = Math.max(msPerWrite, per);
    }
  }
  return { msPerWrite: Math.ceil(msPerWrite), msPerRead: Math.ceil(msPerRead) };
}

/** The plan's writes per learned group: the ops it names that are LK writes (the signed PUT is not one). */
export function groupWrites(ops: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [op, n] of Object.entries(ops)) {
    if (op === UPLOAD_PUT_OP || n <= 0) continue;
    const g = rateGroupOf(op);
    out[g] = (out[g] ?? 0) + n;
  }
  return out;
}

/**
 * The sequential estimate of a plan: the governor's estimate, and at least the writes at `msPerWrite` and the reads at
 * `msPerRead`, with each learned group's steps taking the longer of their pacing and what its limit allows.
 */
export function sequentialEstimate(
  est: EstimateLike | undefined,
  plan: { readonly reads: number; readonly writes: number; readonly ops?: Readonly<Record<string, number>> },
): {
  wallClockMs: number | null;
  fitsToday: boolean | null;
  pacing: { msPerWrite: number; msPerRead: number } | null;
  figures: PlanFigures | null;
} {
  if (!est) return { wallClockMs: null, fitsToday: null, pacing: null, figures: null };
  const pacing = pacingOf(est, plan.writes);
  let paced = plan.writes * pacing.msPerWrite + plan.reads * pacing.msPerRead;
  const inGroup = groupWrites(plan.ops ?? {});
  const byGroup = new Map<string, { limit: number; windowMs: number; timeMs: number }>();
  for (const g of est.operationTiers ?? []) {
    const cur = byGroup.get(g.group);
    // Several learned tiers in one group: the tightest decides (the lowest limit, the longest time).
    byGroup.set(g.group, {
      limit: cur ? Math.min(cur.limit, g.limit) : g.limit,
      windowMs: cur && cur.limit <= g.limit ? cur.windowMs : g.windowMs,
      timeMs: Math.max(cur?.timeMs ?? 0, g.timeMs),
    });
  }
  const groups: PlanFigures['groups'][number][] = [];
  for (const [group, g] of byGroup) {
    const steps = inGroup[group] ?? 0;
    const own = steps * pacing.msPerWrite;
    const ms = Math.max(own, g.timeMs);
    paced += ms - own;
    groups.push({ group, limit: g.limit, windowMs: g.windowMs, steps, ms });
  }
  const pw = est.perWrite;
  return {
    wallClockMs: Math.max(est.wallClockMs, paced),
    fitsToday: est.fitsToday,
    pacing,
    figures: {
      perWrite: pw
        ? {
            ms: pw.ms,
            from: pw.source,
            measuredMs: pw.measured?.ms ?? null,
            samples: pw.measured?.samples ?? 0,
            spacingMs: pw.spacingMs,
          }
        : null,
      limits: (est.tiers ?? [])
        .filter((t) => !t.tier.startsWith('group:'))
        .map((t) => ({
          tier: t.tier,
          limit: t.limit ?? null,
          windowMs: t.windowMs ?? null,
          share: t.capacityPerWindow,
        })),
      groups,
    },
  };
}

/**
 * The reads, writes and operations of a list of job steps (a restore's): registry reads and writes by their kind, the
 * bridge's own steps (`bridge.*`) as one read each.
 */
export function countSteps(steps: readonly { readonly op: string }[]): {
  reads: number;
  writes: number;
  ops: Record<string, number>;
} {
  let reads = 0;
  let writes = 0;
  const ops: Record<string, number> = {};
  for (const s of steps) {
    ops[s.op] = (ops[s.op] ?? 0) + 1;
    const def = getOperation(s.op);
    if (!def) reads++;
    else if (def.kind === 'read') reads++;
    else writes++;
  }
  return { reads, writes, ops };
}
