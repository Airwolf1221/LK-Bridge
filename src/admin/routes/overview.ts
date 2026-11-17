import * as z from 'zod';
import { ADMIN_CSRF_PURPOSE, sessionTokenOf } from '../guard.js';
import { budgetPayload } from '../stream.js';
import { redactDeep } from '../redact.js';
import type { Health } from '../health.js';
import { limitSchema, parseInput, projectParam, type Register } from './util.js';

const ACTIVE = ['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused'] as const;

export const registerOverview: Register = (api, ctx) => {
  const { deps, now } = ctx;
  const { engine, projects, policy, secrets } = deps.runtime;
  const { owner, config, credentials } = deps.services;

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
      totpEnabled: credentials.totpRequired(),
    };
  });

  api.get('/overview', async (req) => {
    const q = parseInput(
      z.object({ refresh: z.stringbool().default(false), project: projectParam }),
      req.query,
    );
    // The Overview must show a project that is not served (a refused key, a mismatched id, LegendKeeper unreachable at
    // start-up) even before its key ever proved its id: such a project has no data yet, only its status and reason.
    const view = q.project ? projects.find(q.project) : projects.defaultProject();
    if (!view) ctx.project(q.project); // throws the 400 UNKNOWN_PROJECT
    const project = { id: view!.id, name: view!.name };
    const served = view!.status === 'active' && project.id !== null;
    const health: Health = served
      ? await ctx.health({ id: project.id!, name: project.name }, q.refresh)
      : {
          checkedAt: view!.checkedAt ?? now(),
          // A key LegendKeeper answered about (refused, unpaid, another project) means it was reachable.
          reachable: view!.keyValid !== null ? true : view!.status === 'unverified' ? false : null,
          projectName: view!.displayName,
          keyRole: 'unknown',
          plan: /paid plan/.test(view!.reason ?? '') ? 'unpaid' : 'unknown',
          note: view!.reason,
        };
    const id = project.id;
    const controls = engine.queries.controls(id ?? undefined);
    const active = id ? engine.queries.listJobs(id, { status: ACTIVE, limit: 500 }) : [];
    const errors = id ? engine.queries.listErrors(id, { since: now() - 3_600_000, limit: 1000 }) : [];
    const pending = id
      ? policy.commands.listProposals('owner', { project: id, state: 'pending', limit: 500 })
      : [];
    const lk = project.id ? projects.anyClient(project.id) : undefined;
    const budget = lk ? budgetPayload(lk) : null;
    const headline = ['write-min', 'key-min', 'key-hour', 'project-hour'] as const;
    return {
      project,
      // v2 A1: every project's status, so a stopped one (a refused key, a mismatched id) shows here.
      projects: projects.list().map((p) => ({
        name: p.name,
        id: p.id,
        status: p.status,
        reason: p.reason,
        isDefault: p.isDefault,
        readOnly: p.readOnly,
      })),
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
      // v3 F3.4 (ADR 0055): agents' direct writes at scope `write` the owner has not reviewed yet.
      unreviewedDirectWrites:
        id && deps.runtime.review ? deps.runtime.review.store.count(id, { state: 'unreviewed' }) : 0,
      writes: {
        state: controls.draining ? 'draining' : controls.writesPaused ? 'paused' : 'running',
        perMinute: budget?.writesPerMinute ?? 0,
      },
      budget: budget
        ? {
            queues: budget.snapshot.queues,
            gauges: headline.map((t) => budget.snapshot.tiers[t]),
          }
        : null,
      // v2 E1b (ADR 0043): the off-site copy's health, so a broken backup cannot go unnoticed: a broken Google
      // connection, a last good copy older than the setting (2 days), a failed copy, or a verify that found problems.
      offsite: deps.runtime.offsite ? deps.runtime.offsite.health() : null,
      // OPS2: keys can now be changed from here, so the owner's own sign-in matters more: the page recommends the
      // authenticator strongly while it is off, and shows any secret-store problem and env/store key differences.
      security: (() => {
        const store = secrets.state();
        return {
          totpEnabled: credentials.totpRequired(),
          canManageKeys: projects.canManageKeys,
          storeProblem: store.problem,
          warnings: [
            ...credentials.warnings(),
            ...projects.notes,
            ...projects
              .list()
              .filter((p) => p.keyConflict !== null)
              .map((p) => `${p.name}: ${p.keyConflict}`),
            ...(store.underPrevious > 0
              ? [
                  `${store.underPrevious} secret(s) are still sealed with the previous master key: run the rotation command (runbook, "Rotating the master key").`,
                ]
              : []),
          ],
        };
      })(),
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
