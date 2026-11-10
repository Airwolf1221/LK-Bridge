/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies and loosely typed test data */
/**
 * The Maintenance Jobs admin routes keep chunk 5's rules (owner session only, Origin and CSRF on every change, every
 * change audited and evented). The route list comes from Fastify, so test/admin/auth.test.ts covers these routes too;
 * this file checks them by name, and the behaviour behind them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullFlow } from '../auth/helpers.js';
import { PROJECT, startAdminStack, until, type AdminStack } from '../admin/helpers.js';

let stack: AdminStack;
let oauthAccess: string;

beforeAll(async () => {
  stack = await startAdminStack();
  oauthAccess = (await fullFlow(stack.bridge)).access;
});
afterAll(() => stack.close());

const mine = () => stack.routes.filter((r) => r.url.startsWith('/api/admin/maintenance'));
const concrete = (url: string) => url.replace(':id', 'budget-sampler');

describe('routes and auth', () => {
  it('registers the documented routes', () => {
    expect(mine().map((r) => `${r.method} ${r.url}`)).toEqual(
      expect.arrayContaining([
        'GET /api/admin/maintenance',
        'GET /api/admin/maintenance/:id',
        'POST /api/admin/maintenance/:id/enable',
        'POST /api/admin/maintenance/:id/disable',
        'PUT /api/admin/maintenance/:id/schedule',
        'POST /api/admin/maintenance/:id/run',
      ]),
    );
  });

  it('are closed to no credentials, to OAuth access tokens and to bearer tokens beside a cookie', async () => {
    for (const r of mine()) {
      for (const o of [
        { cookie: null, csrf: null, origin: null },
        { cookie: null, authorization: `Bearer ${oauthAccess}` },
      ]) {
        const reply = await stack.call(r.method, concrete(r.url), o);
        expect(reply.status, `${r.method} ${r.url}`).toBe(401);
        expect(reply.headers.get('www-authenticate')).toBeNull();
      }
    }
  });

  it('refuse a missing or wrong CSRF token and a missing or foreign Origin, and do nothing', async () => {
    const before = stack.audit().length;
    for (const r of mine().filter((r) => r.method !== 'GET')) {
      for (const o of [
        { csrf: null },
        { csrf: 'wrong' },
        { origin: null },
        { origin: 'https://evil.example' },
      ]) {
        const reply = await stack.call(r.method, concrete(r.url), { body: { schedule: null }, ...o });
        expect(reply.status, `${r.method} ${r.url} ${JSON.stringify(o)}`).toBe(403);
        expect(['BAD_CSRF', 'BAD_ORIGIN']).toContain(reply.json.error.code);
      }
    }
    expect(stack.audit().length).toBe(before);
  });

  it('reads need the session but not CSRF', async () => {
    expect((await stack.get('/api/admin/maintenance', { csrf: null, origin: null })).status).toBe(200);
  });
});

describe('the registry', () => {
  it('lists every job with status, schedule, last and next run', async () => {
    const r = await stack.get('/api/admin/maintenance');
    expect(r.status).toBe(200);
    expect(r.json.schedulerEnabled).toBe(false); // the test stack switches the scheduler off
    expect(r.json.jobs.map((j: any) => j.id)).toEqual([
      'budget-sampler',
      'journal-prune',
      'proposal-expiry',
      'proposal-prune',
      'connection-removal',
      'sqlite-optimise',
      'tree-sweep',
      'tree-check',
      'assign-block-ids-sweep',
      'orphan-and-link-audit',
      'tag-audit',
      'asset-refresh',
      'asset-check',
      'link-sweep', // v2 C2c
    ]);
    expect(r.json.jobs[0]).toMatchObject({
      name: 'Budget sampler',
      implemented: true,
      priority: 'P3',
      scheduleText: 'Every 10 seconds',
      lastRun: null,
    });
    expect(r.json.jobs[6]).toMatchObject({ id: 'tree-sweep', implemented: true, scope: 'project' });
    expect(r.json.jobs[8]).toMatchObject({ implemented: false, enabled: false, note: 'Not implemented yet' });
  });

  it('404s an unknown job', async () => {
    expect((await stack.get('/api/admin/maintenance/nope')).status).toBe(404);
    expect((await stack.post('/api/admin/maintenance/nope/enable')).status).toBe(404);
  });
});

describe('changes', () => {
  it('disable and enable, audited and evented', async () => {
    const off = await stack.post('/api/admin/maintenance/sqlite-optimise/disable');
    expect(off.json.job).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await stack.post('/api/admin/maintenance/sqlite-optimise/enable');
    expect(on.json.job.enabled).toBe(true);
    expect(stack.audit('maintenance.disable')[0]).toMatchObject({
      actor: 'owner',
      target: 'sqlite-optimise',
    });
    expect(stack.audit('maintenance.enable')).toHaveLength(1);
    expect(stack.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['maintenance.disable', 'maintenance.enable']),
    );
  });

  it('edits the schedule, validates it, and can restore the default', async () => {
    const put = (schedule: unknown) =>
      stack.put('/api/admin/maintenance/journal-prune/schedule', { schedule });
    const ok = await put({ kind: 'daily', time: '04:45' });
    expect(ok.status).toBe(200);
    expect(ok.json.job).toMatchObject({
      scheduleText: 'Daily at 04:45 (London time)',
      scheduleOverridden: true,
    });
    for (const bad of [
      { kind: 'daily', time: '4:45' },
      { kind: 'interval', everySeconds: 3 },
      { kind: 'weekly' },
      'x',
    ]) {
      const r = await put(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.error.code).toBe('INVALID_SCHEDULE');
    }
    expect((await stack.get('/api/admin/maintenance/journal-prune')).json.job.scheduleText).toBe(
      'Daily at 04:45 (London time)',
    );
    const reset = await put(null);
    expect(reset.json.job).toMatchObject({
      scheduleText: 'Daily at 03:30 (London time)',
      scheduleOverridden: false,
    });
    expect((await stack.put('/api/admin/maintenance/journal-prune/schedule', {})).status).toBe(400); // no schedule given
    expect(stack.audit('maintenance.set_schedule').length).toBe(2);
  });

  it('refuses to enable, schedule or run a placeholder, and changes nothing', async () => {
    const before = stack.audit().length;
    for (const id of ['assign-block-ids-sweep', 'orphan-and-link-audit', 'tag-audit']) {
      for (const r of [
        await stack.post(`/api/admin/maintenance/${id}/enable`),
        await stack.post(`/api/admin/maintenance/${id}/run`),
        await stack.put(`/api/admin/maintenance/${id}/schedule`, {
          schedule: { kind: 'interval', everySeconds: 60 },
        }),
      ]) {
        expect(r.status).toBe(409);
        expect(r.json.error).toEqual({ code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' });
      }
      // Disabling an already-disabled placeholder is harmless.
      expect((await stack.post(`/api/admin/maintenance/${id}/disable`)).json.job.enabled).toBe(false);
    }
    // Only the (harmless) disables were audited: no enable, schedule change or run left a trace.
    const added = stack.audit().slice(0, stack.audit().length - before);
    expect(added.length).toBe(3);
    for (const row of added) expect(row.action).toBe('maintenance.disable');
  });

  it('Run now answers at once, runs the job, records the run and audits it', async () => {
    const r = await stack.post('/api/admin/maintenance/sqlite-optimise/run');
    expect(r.status).toBe(202);
    await until(() => stack.runtime.maintenance.scheduler.get('sqlite-optimise').lastRun !== null);
    const job = (await stack.get('/api/admin/maintenance/sqlite-optimise')).json.job;
    expect(job.lastRun).toMatchObject({ outcome: 'succeeded' });
    // v2 A1: SQLite upkeep is bridge-wide, so its run is recorded in the history (project `*`) and not as a job on any
    // one project's Jobs page.
    expect(job.history[0]).toMatchObject({ trigger: 'manual', outcome: 'succeeded', projectId: '*' });
    expect(job.lastRun.jobId).toBeNull();
    const jobs = (await stack.get('/api/admin/jobs?limit=200')).json.jobs as { origin: { tool?: string } }[];
    expect(jobs.filter((j) => j.origin.tool === 'sqlite-optimise')).toEqual([]);
    expect(stack.audit('maintenance.run_now')).toHaveLength(1);
  });

  it('budget-sampler feeds the Request Budgets history that the sparklines draw', async () => {
    const points = async () => (await stack.get('/api/admin/budgets')).json.samples.count as number;
    const before = await points();
    expect((await stack.post('/api/admin/maintenance/budget-sampler/run')).status).toBe(202);
    await until(() => stack.runtime.maintenance.scheduler.get('budget-sampler').lastRun !== null);
    expect(await points()).toBeGreaterThan(before);
  });

  it('the Jobs page can filter maintenance runs by origin', async () => {
    // v2 A1: the built-in jobs are all bridge-wide now (no job record); a per-project run is a job of its project, as
    // the later LegendKeeper jobs will be. Record one the way the scheduler does.
    stack.runtime.engine.recordResult({
      project: PROJECT,
      opId: 'maintenance:probe',
      params: {},
      value: { outcome: 'succeeded' },
      origin: { kind: 'maintenance', client: 'maintenance', tool: 'probe' },
      priority: 'P3',
    });
    const r = await stack.get('/api/admin/jobs?view=history&origin=maintenance');
    expect(r.status).toBe(200);
    expect(r.json.jobs.length).toBeGreaterThan(0);
    for (const j of r.json.jobs) expect(j.origin.kind).toBe('maintenance');
  });
});
