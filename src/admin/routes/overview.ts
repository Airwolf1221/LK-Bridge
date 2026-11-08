import * as z from 'zod';
import { ADMIN_CSRF_PURPOSE, sessionTokenOf } from '../guard.js';
import { budgetPayload } from '../stream.js';
import { redactDeep } from '../redact.js';
import { limitSchema, parseInput, type Register } from './util.js';

const ACTIVE = ['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused'] as const;

export const registerOverview: Register = (api, ctx) => {
  const { deps, now } = ctx;
  const { engine, lk, policy } = deps.runtime;
  const { owner, config } = deps.services;

  /** Who is signed in, and the two tokens the dashboard needs: CSRF for its requests, and for the sign-out form. */
  api.get('/session', (req) => {
    const token = sessionTokenOf(req);
    return {
      authenticated: true,
      username: config.owner.username,
      csrfToken: owner.csrfToken(token, ADMIN_CSRF_PURPOSE),
      logoutCsrfToken: owner.csrfToken(token, 'logout'),
      logoutPath: '/oauth/logout',
      version: deps.version,
      publicUrl: config.publicUrl,
    };
  });

  api.get('/overview', async (req) => {
    const q = parseInput(z.object({ refresh: z.stringbool().default(false) }), req.query);
    const health = await ctx.health(q.refresh);
    const controls = engine.queries.controls();
    const active = engine.queries.listJobs({ status: ACTIVE, limit: 500 });
    const errors = engine.queries.listErrors({ since: now() - 3_600_000, limit: 1000 });
    const pending = policy.commands.listProposals('owner', { state: 'pending', limit: 500 });
    const budget = budgetPayload(lk);
    const headline = ['write-min', 'key-min', 'key-hour', 'project-hour'] as const;
    return {
      health,
      controls,
      activeJobs: {
        total: active.length,
        running: active.filter((j) => j.status === 'running').length,
        queued: active.filter((j) => j.status === 'queued').length,
        waiting: active.filter((j) => j.status === 'waiting_budget' || j.status === 'waiting_lock').length,
        paused: active.filter((j) => j.status === 'paused').length,
        uncertain: active.filter((j) => j.uncertain).length,
      },
      errorsLastHour: { count: errors.length, capped: errors.length >= 1000 },
      pendingProposals: pending.length,
      writes: {
        state: controls.draining ? 'draining' : controls.writesPaused ? 'paused' : 'running',
        perMinute: budget.writesPerMinute,
      },
      budget: {
        queues: budget.snapshot.queues,
        gauges: headline.map((t) => budget.snapshot.tiers[t]),
      },
    };
  });

  api.get('/audit', (req) => {
    const q = parseInput(
      z.object({
        limit: limitSchema(50, 500),
        before: z.coerce.number().int().optional(),
        action: z.string().max(100).optional(),
      }),
      req.query,
    );
    const rows = policy.commands.listAudit('owner', {
      limit: q.limit,
      ...(q.before !== undefined ? { before: q.before } : {}),
      ...(q.action ? { action: q.action } : {}),
    });
    return { entries: redactDeep(rows) };
  });
};
