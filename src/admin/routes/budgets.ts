import * as z from 'zod';
import type { BudgetSampleView } from '../../jobs/index.js';
import { TIER_IDS } from '../../lk/registry-types.js';
import { redactDeep } from '../redact.js';
import { budgetPayload } from '../stream.js';
import { reserveFloorsSchema } from '../runtime-settings.js';
import { confirmBody, limitSchema, parseInput, type Register } from './util.js';

interface Point {
  at: number;
  tiers: Record<string, { used: number; limit: number | null }>;
  queues: Record<string, number>;
}

/** Folds the 10-second samples into at most `points` buckets: the busiest value in each bucket, so spikes survive. */
export function bucketSamples(
  samples: readonly BudgetSampleView[],
  since: number,
  until: number,
  points: number,
) {
  const bucketMs = Math.max(10_000, Math.ceil((until - since) / points / 10_000) * 10_000);
  const buckets = new Map<number, Point>();
  for (const s of samples) {
    const key = Math.floor((s.at - since) / bucketMs);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { at: since + key * bucketMs, tiers: {}, queues: {} }));
    for (const [tier, t] of Object.entries(s.tiers ?? {})) {
      const cur = b.tiers[tier];
      if (!cur || t.used > cur.used) b.tiers[tier] = { used: t.used, limit: t.limit };
    }
    for (const [c, n] of Object.entries(s.queues ?? {})) b.queues[c] = Math.max(b.queues[c] ?? 0, n);
  }
  return { bucketMs, points: [...buckets.entries()].sort(([a], [b]) => a - b).map(([, p]) => p) };
}

export const registerBudgets: Register = (api, ctx) => {
  const { engine, lk, envConfig } = ctx.deps.runtime;
  const { actions, now } = ctx;
  const floorsNow = () => {
    const f = lk.governor.settings.reserveFloors;
    return { interactive: f.P1, job: f.P2, maintenance: f.P3 };
  };

  api.get('/budgets', (req) => {
    const q = parseInput(
      z.object({ hours: z.coerce.number().min(1).max(48).default(24), points: limitSchema(288, 1000) }),
      req.query,
    );
    const until = now();
    const since = until - q.hours * 3_600_000;
    const samples = engine.queries.listBudgetSamples({ since, until, limit: 50_000 });
    const live = budgetPayload(lk);
    const project = live.snapshot.tiers['project-hour'];
    return {
      ...(redactDeep(live) as object),
      tierOrder: TIER_IDS,
      reserveFloors: {
        current: floorsNow(),
        environment: envConfig.governor.reserveFloors,
        stored: actions.storedSettings().reserveFloors,
      },
      // Observed (LegendKeeper's own count) against modelled (ours) for the tier other keys also draw on.
      projectDrift: project.drift,
      samples: { since, until, ...bucketSamples(samples, since, until, q.points), count: samples.length },
    };
  });

  api.put('/budgets/reserve-floors', (req) => {
    const body = parseInput(
      z.union([
        z.object({ reset: z.literal(true), confirm: z.literal(true) }),
        reserveFloorsSchema.and(confirmBody),
      ]),
      req.body,
    );
    if ('reset' in body) return { reserveFloors: actions.setReserveFloors(null) };
    const { confirm: _confirm, ...floors } = body;
    return { reserveFloors: actions.setReserveFloors(floors) };
  });

  // ---------------------------------------------------------------------------------------------- writers

  api.get('/writers', () => {
    const writers = engine.queries.writers();
    const locks = engine.queries.locks();
    const ids = new Set<string>();
    for (const s of writers.slots) if (s.jobId) ids.add(s.jobId);
    for (const w of writers.waiting) ids.add(w.jobId);
    for (const l of locks) {
      ids.add(l.holder.jobId);
      for (const w of l.waiting) ids.add(w.jobId);
    }
    const jobs: Record<string, { title: string; status: string; profile: string; principalId: string }> = {};
    for (const id of ids) {
      const j = engine.queries.getJob(id);
      if (j) jobs[id] = { title: j.title, status: j.status, profile: j.profile, principalId: j.principalId };
    }
    const live = budgetPayload(lk);
    return {
      writers,
      locks,
      controls: engine.queries.controls(),
      jobs: redactDeep(jobs),
      writesPerMinute: live.writesPerMinute,
      writeMinuteLimit: live.snapshot.tiers['write-min'].limit,
      writeSpacingMs: live.snapshot.writeSpacingMs,
    };
  });

  api.put('/writers/max', (req) => {
    const b = parseInput(
      z.object({ value: z.number().int(), confirm: z.literal(true).optional() }),
      req.body,
    );
    return { controls: actions.setWritersMax(b.value) };
  });
  api.post('/writes/pause', () => ({ controls: actions.pauseWrites() }));
  api.post('/writes/resume', () => ({ controls: actions.resumeWrites() }));
  api.post('/writes/drain', () => ({ controls: actions.drain() }));
  api.post('/writes/undrain', () => ({ controls: actions.undrain() }));
};
