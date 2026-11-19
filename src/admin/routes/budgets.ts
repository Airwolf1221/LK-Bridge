import { requireReauth } from '../guard.js';
import * as z from 'zod';
import type { BudgetSampleView } from '../../jobs/index.js';
import { TIER_IDS } from '../../lk/registry-types.js';
import { ALL_PROJECTS } from '../../projects/index.js';
import { redactDeep } from '../redact.js';
import { AdminHttpError } from '../http.js';
import { budgetPayload } from '../stream.js';
import { reserveFloorsSchema } from '../runtime-settings.js';
import { confirmBody, limitSchema, parseInput, projectParam, type Register } from './util.js';

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
  const { engine, projects, envConfig } = ctx.deps.runtime;
  const { actions, now } = ctx;
  const clientOf = (project: { id: string; name: string }) => {
    const lk = projects.anyClient(project.id);
    if (!lk) {
      throw new AdminHttpError(409, 'PROJECT_UNAVAILABLE', `Project "${project.name}" has no governor now`);
    }
    return lk;
  };
  // Reserve floors are bridge-wide (every governor has the same); the default project's governor reports them.
  const floorsNow = () => {
    const g = projects.clients()[0]?.client.governor;
    if (!g) return envConfig.governor.reserveFloors;
    const f = g.settings.reserveFloors;
    return { interactive: f.P1, job: f.P2, maintenance: f.P3 };
  };
  const budgetQuery = z.object({
    hours: z.coerce.number().min(1).max(48).default(24),
    points: limitSchema(288, 1000),
    project: projectParam,
  });

  /** One project's budgets (each project has its own key, so its own governor and tiers; v2 A1). */
  api.get('/budgets', (req) => {
    const q = parseInput(budgetQuery, req.query);
    const p = ctx.project(q.project);
    const until = now();
    const since = until - q.hours * 3_600_000;
    const samples = engine.queries.listBudgetSamples(p.id, { since, until, limit: 50_000 });
    const live = budgetPayload(clientOf(p));
    const project = live.snapshot.tiers['project-hour'];
    return {
      project: p,
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

  /** Every project's budgets side by side: the live tiers and the 24 h history of each. */
  api.get('/budgets/all', (req) => {
    const q = parseInput(budgetQuery, req.query);
    const until = now();
    const since = until - q.hours * 3_600_000;
    return {
      tierOrder: TIER_IDS,
      projects: projects.clients().map((c) => {
        const samples = engine.queries.listBudgetSamples(c.id, { since, until, limit: 50_000 });
        const live = budgetPayload(c.client);
        return {
          project: { id: c.id, name: c.name },
          status: projects.find(c.id)?.status ?? 'unknown',
          ...(redactDeep(live) as object),
          projectDrift: live.snapshot.tiers['project-hour'].drift,
          samples: { since, until, ...bucketSamples(samples, since, until, q.points), count: samples.length },
        };
      }),
    };
  });

  api.put('/budgets/reserve-floors', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
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

  api.get('/writers', (req) => {
    const writers = engine.queries.writers();
    const locks = engine.queries.locks();
    const ids = new Set<string>();
    for (const s of writers.slots) if (s.jobId) ids.add(s.jobId);
    for (const w of writers.waiting) ids.add(w.jobId);
    for (const l of locks) {
      ids.add(l.holder.jobId);
      for (const w of l.waiting) ids.add(w.jobId);
    }
    // The writer pool and the locks are bridge-wide (shared by every project), so this view spans projects on purpose,
    // naming each job's project.
    const jobs: Record<
      string,
      { title: string; status: string; profile: string; principalId: string; project: string }
    > = {};
    for (const id of ids) {
      const j = engine.queries.getJob(ALL_PROJECTS, id);
      if (j) {
        jobs[id] = {
          title: j.title,
          status: j.status,
          profile: j.profile,
          principalId: j.principalId,
          project: projects.nameOf(j.projectId),
        };
      }
    }
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const lk = projects.anyClient(p.id);
    const live = lk ? budgetPayload(lk) : null;
    return {
      project: p,
      writers,
      locks,
      controls: engine.queries.controls(),
      jobs: redactDeep(jobs),
      writesPerMinute: live?.writesPerMinute ?? 0,
      writeMinuteLimit: live?.snapshot.tiers['write-min'].limit ?? null,
      writeSpacingMs: live?.snapshot.writeSpacingMs ?? 0,
    };
  });

  api.put('/writers/max', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
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
