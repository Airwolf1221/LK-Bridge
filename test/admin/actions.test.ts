/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON replies and mock data in tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { LkModel } from '../jobs/lk-model.js';
import { PROJECT, startAdminStack, until, type AdminStack } from './helpers.js';
import { systemClock } from '../../src/lk/index.js';

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});
let failCreates = false;
const respond = (req: MockRequest): MockResponse | undefined => {
  if (failCreates && req.method === 'POST' && /\/resources\/?$/.test(req.path)) {
    return {
      status: 400,
      body: {
        message: 'The name is not allowed',
        code: 'VALIDATION_ERROR',
        requestId: 'req-fail-1',
        errors: [{ path: 'name', message: 'bad' }],
      },
    };
  }
  return model.respond(req);
};

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ respond });
});
afterAll(() => stack.close());

const engine = () => stack.runtime.engine;
const origin = { kind: 'ui', tool: 'test' } as const;
const batch = (n = 1, title = 'test batch') =>
  engine().submit({
    project: PROJECT,
    kind: 'batch_ops',
    title,
    origin,
    steps: Array.from({ length: n }, (_, i) => ({
      op: 'createResource',
      params: { body: { name: `R${i}` } },
    })),
  });

/** Runs `fn`, then checks it left exactly the audit row and the stream event the action promises. */
async function audited<T>(action: string, target: string | null | RegExp, fn: () => Promise<T>) {
  const rows = stack.audit(action).length;
  const events = stack.events.filter((e) => e.action === action).length;
  const result = await fn();
  const after = stack.audit(action);
  expect(after.length, `audit rows for ${action}`).toBe(rows + 1);
  const row = after[0]!;
  expect(row.actor).toBe('owner');
  if (target instanceof RegExp) expect(row.target).toMatch(target);
  else if (target !== undefined) expect(row.target).toBe(target);
  expect(stack.events.filter((e) => e.action === action).length, `events for ${action}`).toBe(events + 1);
  return { result, row };
}

describe('jobs', () => {
  it('cancels a job through the engine control, audited, with an event', async () => {
    engine().controls.pauseWrites('test');
    const { jobId } = (await batch(2)) as { jobId: string };
    const { result } = await audited('job.cancel', jobId, () =>
      stack.post(`/api/admin/jobs/${jobId}/cancel`),
    );
    expect(result.status).toBe(200);
    expect(engine().queries.getJob(PROJECT, jobId)?.status).toBe('cancelled');
  });

  it('pauses and resumes a job', async () => {
    const { jobId } = (await batch(2)) as { jobId: string };
    await audited('job.pause', jobId, () => stack.post(`/api/admin/jobs/${jobId}/pause`));
    expect(engine().queries.getJob(PROJECT, jobId)?.status).toBe('paused');
    await audited('job.resume', jobId, () => stack.post(`/api/admin/jobs/${jobId}/resume`));
    expect(engine().queries.getJob(PROJECT, jobId)?.status).toBe('queued');
    await stack.post(`/api/admin/jobs/${jobId}/cancel`);
  });

  it('answers an unknown job with 404 and writes no audit row', async () => {
    const rows = stack.audit().length;
    const r = await stack.post('/api/admin/jobs/job_missing/cancel');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('JOB_NOT_FOUND');
    expect(stack.audit().length).toBe(rows);
  });

  it('retries a failed step, with and without force, and flags the risk of a step that may have applied', async () => {
    failCreates = true;
    engine().controls.resumeWrites('test');
    const { jobId } = (await batch(1, 'will fail')) as { jobId: string };
    await until(() => engine().queries.getJob(PROJECT, jobId)?.status === 'failed');
    const detail = await stack.get(`/api/admin/jobs/${jobId}`);
    expect(detail.json.job.steps[0]).toMatchObject({
      status: 'failed',
      retry: { allowed: true, ambiguous: false, warning: null },
    });

    const stepNo = detail.json.job.steps[0].stepNo as number;
    const r1 = await audited('job.retry_step', `${jobId}#${stepNo}`, () =>
      stack.post(`/api/admin/jobs/${jobId}/steps/${stepNo}/retry`, { force: false }),
    );
    expect(r1.result.status).toBe(200);
    expect(r1.row.after).toMatchObject({ force: false });
    await until(
      () =>
        engine().queries.getJob(PROJECT, jobId)?.status === 'failed' &&
        engine().queries.getJob(PROJECT, jobId)!.steps[0]!.attempt0 === 1,
    );

    const r2 = await audited('job.retry_step', `${jobId}#${stepNo}`, () =>
      stack.post(`/api/admin/jobs/${jobId}/steps/${stepNo}/retry`, { force: true }),
    );
    expect(r2.row.after).toMatchObject({ force: true });
    await until(
      () =>
        engine().queries.getJob(PROJECT, jobId)?.steps[0]?.attempt0 === 2 &&
        engine().queries.getJob(PROJECT, jobId)?.status === 'failed',
    );

    // Once the cause is fixed a retry succeeds.
    failCreates = false;
    await stack.post(`/api/admin/jobs/${jobId}/steps/${stepNo}/retry`, { force: false });
    await until(() => engine().queries.getJob(PROJECT, jobId)?.status === 'succeeded');
  });

  it('refuses to retry a step that has not failed', async () => {
    const { jobId } = (await batch(1, 'ok job')) as { jobId: string };
    await until(() => engine().queries.getJob(PROJECT, jobId)?.status === 'succeeded');
    const stepNo = engine().queries.getJob(PROJECT, jobId)!.steps[0]!.stepNo;
    const r = await stack.post(`/api/admin/jobs/${jobId}/steps/${stepNo}/retry`, { force: false });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('INVALID_CONTROL');
  });
});

describe('errors', () => {
  it('lists groups, shows the full LK body and request id, and marks a group resolved', async () => {
    const list = await stack.get('/api/admin/errors');
    const group = list.json.groups.find((g: any) => g.code === 'VALIDATION_ERROR');
    expect(group).toMatchObject({ opId: 'createResource', classification: 'user_fixable', resolved: false });
    expect(group.count).toBeGreaterThanOrEqual(3);
    const detail = await stack.get(
      `/api/admin/errors/group?fingerprint=${encodeURIComponent(group.fingerprint)}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.json.occurrences[0]).toMatchObject({ message: 'The name is not allowed' });
    expect(detail.json.occurrences[0].jobId).toBeTypeOf('string');
    const { result } = await audited('error.resolve', group.fingerprint, () =>
      stack.post('/api/admin/errors/resolve', { fingerprint: group.fingerprint }),
    );
    expect(result.json.resolved).toBeGreaterThanOrEqual(3);
    const after = await stack.get('/api/admin/errors?resolved=all');
    expect(after.json.groups.find((g: any) => g.fingerprint === group.fingerprint).resolved).toBe(true);
    expect(
      (await stack.get('/api/admin/errors')).json.groups.some(
        (g: any) => g.fingerprint === group.fingerprint,
      ),
    ).toBe(false);
  });
});

describe('writers and controls', () => {
  it('changes WRITERS_MAX live, audited, and refuses values outside 1-8', async () => {
    const before = (await stack.get('/api/admin/writers')).json;
    expect(before.writers.max).toBe(2);
    await audited('writers.set_max', null, () => stack.put('/api/admin/writers/max', { value: 4 }));
    const after = (await stack.get('/api/admin/writers')).json;
    expect(after.writers.max).toBe(4);
    expect(after.writers.slots).toHaveLength(4);
    expect(engine().writers.max).toBe(4); // the running pool, no restart
    for (const bad of [0, 9, 1.5]) {
      expect((await stack.put('/api/admin/writers/max', { value: bad })).status).toBe(400);
    }
    await stack.put('/api/admin/writers/max', { value: 2 });
  });

  it('pauses, resumes and drains writes', async () => {
    await audited('writes.pause', null, () => stack.post('/api/admin/writes/pause'));
    expect(engine().queries.controls().writesPaused).toBe(true);
    await audited('writes.resume', null, () => stack.post('/api/admin/writes/resume'));
    expect(engine().queries.controls().writesPaused).toBe(false);
    const { result } = await audited('writes.drain', null, () => stack.post('/api/admin/writes/drain'));
    expect(result.json.controls.draining).toBe(true);
    await audited('writes.undrain', null, () => stack.post('/api/admin/writes/undrain'));
    expect(engine().queries.controls().draining).toBe(false);
  });
});

describe('budgets', () => {
  it('changes reserve floors live and can reset them', async () => {
    const gov = stack.runtime.projects.client(PROJECT)!.governor;
    expect(gov.settings.reserveFloors.P2).toBe(0.25);
    await audited('budget.set_reserve_floors', null, () =>
      stack.put('/api/admin/budgets/reserve-floors', {
        interactive: 0.2,
        job: 0.4,
        maintenance: 0.6,
        confirm: true,
      }),
    );
    expect(gov.settings.reserveFloors).toMatchObject({ P0: 0, P1: 0.2, P2: 0.4, P3: 0.6 });
    expect((await stack.get('/api/admin/budgets')).json.reserveFloors.current).toEqual({
      interactive: 0.2,
      job: 0.4,
      maintenance: 0.6,
      bulk: 0.7, // v3 F9: not given, so the default
    });
    const bad = await stack.put('/api/admin/budgets/reserve-floors', {
      interactive: 0.5,
      job: 0.4,
      maintenance: 0.6,
      confirm: true,
    });
    expect(bad.status).toBe(400);
    await stack.put('/api/admin/budgets/reserve-floors', { reset: true, confirm: true });
    expect(gov.settings.reserveFloors.P2).toBe(0.25);
  });

  it('survives a restart: the stored floors are applied when the runtime is built', async () => {
    await stack.put('/api/admin/budgets/reserve-floors', {
      interactive: 0.15,
      job: 0.3,
      maintenance: 0.7,
      confirm: true,
    });
    const { applyStoredSettings } = await import('../../src/admin/index.js');
    const applied = applyStoredSettings(stack.runtime.envConfig, stack.db);
    expect(applied.governor.reserveFloors).toEqual({
      interactive: 0.15,
      job: 0.3,
      maintenance: 0.7,
      bulk: 0.7,
    });
    await stack.put('/api/admin/budgets/reserve-floors', { reset: true, confirm: true });
  });

  // v3 F9 (ADR 0074): the fourth floor, bulk (P4).
  describe('the bulk floor (P4)', () => {
    const put = (body: Record<string, unknown>) =>
      stack.put('/api/admin/budgets/reserve-floors', { ...body, confirm: true });
    const gov = () => stack.runtime.projects.client(PROJECT)!.governor;

    it('is saved, shown and applied live', async () => {
      const r = await put({ interactive: 0.1, job: 0.25, maintenance: 0.5, bulk: 0.8 });
      expect(r.status).toBe(200);
      expect(gov().settings.reserveFloors.P4).toBe(0.8);
      const b = (await stack.get('/api/admin/budgets')).json.reserveFloors;
      expect(b.current).toEqual({ interactive: 0.1, job: 0.25, maintenance: 0.5, bulk: 0.8 });
      expect(b.bulkExplicit).toBe(true);
      await put({ reset: true });
      expect(gov().settings.reserveFloors.P4).toBe(0.7);
      expect((await stack.get('/api/admin/budgets')).json.reserveFloors.bulkExplicit).toBe(false);
    });

    it('refuses a bulk floor below the maintenance floor, naming both', async () => {
      const r = await put({ interactive: 0.1, job: 0.25, maintenance: 0.6, bulk: 0.55 });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain('The bulk floor (55%) is below the maintenance floor (60%)');
      expect(gov().settings.reserveFloors.P3).toBe(0.5); // nothing changed
    });

    it('the owner-raised P3 floor: with no bulk value the bulk floor follows it up, and back', async () => {
      const r = await put({ interactive: 0.1, job: 0.25, maintenance: 0.85 });
      expect(r.status).toBe(200);
      expect(gov().settings.reserveFloors).toMatchObject({ P3: 0.85, P4: 0.85 });
      const { applyStoredSettings } = await import('../../src/admin/index.js');
      expect(applyStoredSettings(stack.runtime.envConfig, stack.db).governor.reserveFloors.bulk).toBe(0.85);
      await put({ interactive: 0.1, job: 0.25, maintenance: 0.5 }); // the note in the report: back to the default
      expect(gov().settings.reserveFloors).toMatchObject({ P3: 0.5, P4: 0.7 });
      await put({ reset: true });
    });
  });
});

describe('settings', () => {
  it('changes read-only mode at once and asks for confirmation', async () => {
    expect((await stack.put('/api/admin/settings/read-only', { value: true })).status).toBe(400); // no confirm
    await audited('settings.read_only', null, () =>
      stack.put('/api/admin/settings/read-only', { value: true, confirm: true }),
    );
    expect(engine().queries.controls().readOnly).toBe(true);
    const s = (await stack.get('/api/admin/settings')).json.settings;
    expect(s.readOnly).toMatchObject({ effective: true, override: true, environment: false });
    await stack.put('/api/admin/settings/read-only', { value: null, confirm: true });
    expect(engine().queries.controls().readOnly).toBe(false);
  });

  it('stores the settings that need a restart, shows them pending, and applies them when the runtime is next built', async () => {
    await audited('settings.expose_per_op_tools', null, () =>
      stack.put('/api/admin/settings/expose-per-op-tools', { value: true, confirm: true }),
    );
    await audited('settings.member_admin', null, () =>
      stack.put('/api/admin/settings/member-admin', { value: true, confirm: true }),
    );
    await audited('settings.journal_retention', null, () =>
      stack.put('/api/admin/settings/journal-retention', {
        value: { retentionDays: 7, maxBytes: 5 * 1024 ** 2 },
        confirm: true,
      }),
    );
    await audited('settings.tier_limits', null, () =>
      stack.put('/api/admin/settings/tier-limits', { value: { 'write-min': 60 }, confirm: true }),
    );
    const s = (await stack.get('/api/admin/settings')).json.settings;
    expect(s.exposePerOpTools).toMatchObject({ running: false, stored: true, pendingRestart: true });
    expect(s.memberAdmin).toMatchObject({ running: false, stored: true, pendingRestart: true });
    expect(s.journalRetention).toMatchObject({ stored: { retentionDays: 7 }, pendingRestart: true });
    expect(s.tierLimits.stored).toEqual({ 'write-min': 60 });
    expect(s.tierLimits.pendingRestart).toBe(true);
    expect(s.tierLimits.running['write-min']).toBe(120);

    const { applyStoredSettings } = await import('../../src/admin/index.js');
    const next = applyStoredSettings(stack.runtime.envConfig, stack.db);
    expect(next.mcp.exposePerOpTools).toBe(true);
    expect(next.lk.allowMemberAdmin).toBe(true);
    expect(next.journal).toEqual({ retentionDays: 7, maxBytes: 5 * 1024 ** 2 });
    expect(next.lk.tierLimits['write-min']).toBe(60);
    expect(next.lk.tierLimits['key-min']).toBe(300);

    for (const [path] of [
      ['expose-per-op-tools'],
      ['member-admin'],
      ['journal-retention'],
      ['tier-limits'],
    ] as const) {
      await stack.put(`/api/admin/settings/${path}`, { value: null, confirm: true });
    }
    const cleared = (await stack.get('/api/admin/settings')).json.settings;
    expect(cleared.exposePerOpTools.pendingRestart).toBe(false);
    expect(cleared.tierLimits.pendingRestart).toBe(false);
  });

  it('rejects invalid values without storing them', async () => {
    const rows = stack.audit().length;
    for (const [path, value] of [
      ['journal-retention', { retentionDays: 0, maxBytes: 5 * 1024 ** 2 }],
      ['journal-retention', { retentionDays: 3, maxBytes: 10 }],
      ['tier-limits', { 'write-min': -4 }],
      ['tier-limits', { upload: 5 }],
      ['tier-limits', { bogus: 5 }],
    ] as const) {
      const r = await stack.put(`/api/admin/settings/${path}`, { value, confirm: true });
      expect(r.status, `${path} ${JSON.stringify(value)}`).toBe(400);
    }
    expect(stack.audit().length).toBe(rows);
  });
});

describe('clients and access', () => {
  it('creates a profile, sets scopes with a confirmation for raising, and sets the default scope', async () => {
    const created = await audited('profile.create', /^prof_/, () =>
      stack.post('/api/admin/clients/profiles', { label: 'Test agent', kind: 'other' }),
    );
    const profile = created.result.json.profile;
    expect(profile).toMatchObject({ label: 'Test agent', scope: 'read' });
    // CR-2026-11-R2 (R2-50): a raise needs the owner's re-authentication first (test/admin/r2-scope-reauth.test.ts).
    stack.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
      .run(Math.floor(Date.now() / 1000), stack.services.sessionHash(stack.sessionToken));

    const refused = await stack.put(`/api/admin/clients/profiles/${profile.id}/scope`, { scope: 'write' });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(stack.policy.store.getProfile(profile.id)?.scope).toBe('read');

    await audited('profile.set_scope', profile.id, () =>
      stack.put(`/api/admin/clients/profiles/${profile.id}/scope`, { scope: 'propose', confirmRaise: true }),
    );
    expect(stack.policy.store.getProfile(profile.id)?.scope).toBe('propose');
    // Lowering needs no confirmation.
    await stack.put(`/api/admin/clients/profiles/${profile.id}/scope`, { scope: 'read' });
    expect(stack.policy.store.getProfile(profile.id)?.scope).toBe('read');

    expect((await stack.put('/api/admin/clients/default-scope', { scope: 'write' })).json.error.code).toBe(
      'CONFIRMATION_REQUIRED',
    );
    await audited('policy.set_default_scope', 'default_scope', () =>
      stack.put('/api/admin/clients/default-scope', { scope: 'propose', confirmRaise: true }),
    );
    await stack.put('/api/admin/clients/default-scope', { scope: 'read' });
  });

  it('shows or hides the low-level tools per profile: off by default, audited, no confirmation (v2 B2)', async () => {
    const created = await stack.post('/api/admin/clients/profiles', { label: 'Tools agent', kind: 'other' });
    const profile = created.json.profile;
    expect(profile.showLowLevelTools).toBe(false);
    const listed = (await stack.get('/api/admin/clients')).json.profiles.find(
      (p: any) => p.id === profile.id,
    );
    expect(listed.showLowLevelTools).toBe(false);

    const on = await audited('profile.set_low_level_tools', profile.id, () =>
      stack.put(`/api/admin/clients/profiles/${profile.id}/low-level-tools`, { show: true }),
    );
    expect(on.result.json.profile.showLowLevelTools).toBe(true);
    expect(stack.policy.store.getProfile(profile.id)?.showLowLevelTools).toBe(true);
    expect(on.row).toMatchObject({
      before: { showLowLevelTools: false },
      after: { showLowLevelTools: true },
    });
    // It changes what is listed, never the scope.
    expect(stack.policy.store.getProfile(profile.id)?.scope).toBe('read');
    await stack.put(`/api/admin/clients/profiles/${profile.id}/low-level-tools`, { show: false });
    expect(stack.policy.store.getProfile(profile.id)?.showLowLevelTools).toBe(false);
    expect(
      (await stack.put(`/api/admin/clients/profiles/${profile.id}/low-level-tools`, { show: 'yes' })).status,
    ).toBe(400);
    expect(
      (await stack.put('/api/admin/clients/profiles/prof_nope/low-level-tools', { show: true })).status,
    ).toBe(404);
  });

  it('creates a PAT, shows the token once, never again and never in the audit log or events', async () => {
    const profile = stack.policy.commands.listProfiles('owner').find((p) => p.label === 'Test agent')!;
    const { result, row } = await audited('pat.create', /^pat_/, () =>
      stack.post('/api/admin/clients/pats', { name: 'Laptop', profileId: profile.id, expiresInDays: 30 }),
    );
    expect(result.status).toBe(201);
    const { token, pat, shownOnce } = result.json;
    expect(token).toMatch(/^lkb_pat_/);
    expect(shownOnce).toBe(true);
    expect(pat).toMatchObject({ name: 'Laptop', profileId: profile.id });
    // It works as a bearer token at /mcp...
    const mcp = await stack.bridge.fetch(stack.bridge.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(mcp.status).not.toBe(401);
    // ...and appears nowhere afterwards.
    const secretPart = token.slice('lkb_pat_'.length);
    expect(JSON.stringify(row)).not.toContain(secretPart);
    expect(JSON.stringify(stack.events)).not.toContain(secretPart);
    for (const path of [
      '/api/admin/clients',
      '/api/admin/audit',
      '/api/admin/overview',
      '/api/admin/settings',
    ]) {
      expect((await stack.get(path)).text, path).not.toContain(secretPart);
    }
    const listed = (await stack.get('/api/admin/clients')).json.connections.find((c: any) => c.id === pat.id);
    expect(listed).toMatchObject({ type: 'pat', label: 'Laptop', profile: 'Test agent', active: true });
    expect(listed.lastUsedAt).toBeTypeOf('number'); // the ping above

    // Revoke.
    await audited('connection.revoke', pat.id, () =>
      stack.post(`/api/admin/clients/connections/${pat.id}/revoke`),
    );
    const denied = await stack.bridge.fetch(stack.bridge.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(denied.status).toBe(401);
  });

  it('moves a connection to another profile and rejects bad PAT requests', async () => {
    const profiles = stack.policy.commands.listProfiles('owner');
    const a = profiles.find((p) => p.label === 'Test agent')!;
    const created = stack.services.pats.create({ name: 'Mover', profileId: a.id });
    const other = (await stack.post('/api/admin/clients/profiles', { label: 'Other agent', kind: 'claude' }))
      .json.profile;
    await audited('connection.set_profile', created.pat.id, () =>
      stack.put(`/api/admin/clients/connections/${created.pat.id}/profile`, { profileId: other.id }),
    );
    expect((await stack.post('/api/admin/clients/pats', { name: '', profileId: a.id })).status).toBe(400);
    expect(
      (await stack.post('/api/admin/clients/pats', { name: 'x', profileId: 'prof_missing' })).status,
    ).toBe(404);
    expect(
      (await stack.post('/api/admin/clients/pats', { name: 'x', profileId: a.id, expiresInDays: 0 })).status,
    ).toBe(400);
  });
});

describe('proposals', () => {
  async function propose(label: string) {
    const profile =
      stack.policy.store.getProfileByLabel(label) ??
      stack.policy.commands.createProfile('owner', { label, kind: 'claude', scope: 'propose' });
    const pat = stack.services.pats.create({ name: label, profileId: profile.id });
    const r = await engine().run(
      'replaceDocumentBlocks',
      {
        path: { resourceId: 'res1', documentId: 'd_res1' },
        body: { blocks: [{ kind: 'paragraph', content: [{ text: `By ${label}` }] }] },
      },
      {
        project: PROJECT,
        origin: {
          kind: 'mcp',
          tool: 'lk_api_write',
          principal: { principalId: pat.pat.id, profile: label, label },
        },
      },
    );
    expect(r.status).toBe('proposal_captured');
    return (r as { proposalId: string }).proposalId;
  }

  it('lists pending proposals with the proposer and a diff, approves one through the command layer', async () => {
    const id = await propose('Scribe');
    const list = await stack.get('/api/admin/proposals?group=pending');
    const row = list.json.proposals.find((p: any) => p.id === id);
    // v3 F2: when the repository tree knows the page has a Last Major Revision row (it depends on what earlier tests
    // left in it), the proposal also carries that row's decision and write.
    expect(row).toMatchObject({ state: 'pending', profile: 'Scribe' });
    expect([1, 3]).toContain(row.opCount);
    const detail = (await stack.get(`/api/admin/proposals/${id}`)).json.proposal;
    expect(detail.ops[0]).toMatchObject({ op: 'replaceDocumentBlocks' });
    expect(detail.ops[0].changes.length).toBeGreaterThan(0);
    expect(detail.ops[0].preState).toBeDefined();
    expect((await stack.get('/api/admin/proposals/counts')).json.counts.pending).toBeGreaterThanOrEqual(1);

    const { result } = await audited('proposal.approve', id, () =>
      stack.post(`/api/admin/proposals/${id}/approve`),
    );
    expect(['executing', 'executed']).toContain(result.json.proposal.state);
    await until(() => stack.policy.proposals.state(id) === 'executed');
    expect(model.docs.get('d_res1')?.blocks[0]).toMatchObject({ content: [{ text: 'By Scribe' }] });
  });

  it('rejects with a reason the agent can read', async () => {
    const id = await propose('Scribe');
    const { result } = await audited('proposal.reject', id, () =>
      stack.post(`/api/admin/proposals/${id}/reject`, { reason: 'Not that page' }),
    );
    expect(result.json.proposal).toMatchObject({ state: 'rejected', rejectReason: 'Not that page' });
    expect(stack.policy.proposals.state(id)).toBe('rejected');
  });

  it('applies bulk approve and bulk reject, with a result per proposal', async () => {
    const ids = [await propose('Scribe'), await propose('Scribe')];
    const rej = await stack.post('/api/admin/proposals/bulk', { action: 'reject', ids, reason: 'Batch no' });
    expect(rej.json.results).toHaveLength(2);
    expect(rej.json.results.every((r: any) => r.ok && r.state === 'rejected')).toBe(true);
    expect(stack.audit('proposal.reject').length).toBeGreaterThanOrEqual(3);

    const more = [await propose('Scribe')];
    const bad = [...more, 'prop_missing'];
    const app = await stack.post('/api/admin/proposals/bulk', { action: 'approve', ids: bad });
    expect(app.json.results[0].ok).toBe(true);
    expect(app.json.results[1]).toMatchObject({ ok: false, error: { code: 'PROPOSAL_NOT_FOUND' } });
  });

  it('bulk accept as canon: needs confirm: true, takes at most 100 ids, needs the owner session and CSRF', async () => {
    const id = await propose('Scribe');
    const url = '/api/admin/proposals/bulk';
    for (const body of [
      { action: 'approve-as-canon', ids: [id] },
      { action: 'approve-as-canon', ids: [id], confirm: false },
      { action: 'approve-as-canon', ids: [id], confirm: 'yes' },
    ]) {
      const r = await stack.post(url, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe('INVALID_INPUT');
    }
    // The cap is the same as the other bulk actions: v3 F5a (ADR 0067, H4) raised it from 100 to 1,000 (a selection
    // may span pages): 1,000 are taken, 1,001 are refused, for every action.
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `prop_none${i}`);
    for (const extra of [
      { action: 'approve-as-canon', confirm: true },
      { action: 'approve' },
      { action: 'reject' },
    ]) {
      expect((await stack.post(url, { ...extra, ids: ids(1001) })).status, extra.action).toBe(400);
      expect((await stack.post(url, { ...extra, ids: ids(1000) })).status, extra.action).toBe(200);
    }
    expect((await stack.post(url, { action: 'approve-as-canon', confirm: true, ids: [] })).status).toBe(400);
    // Nothing was decided by any of those refusals.
    expect(stack.policy.proposals.state(id)).toBe('pending');
    // Owner only: no session, no CSRF token, or another site is refused before anything runs.
    const body = { action: 'approve-as-canon', confirm: true, ids: [id] };
    expect((await stack.post(url, body, { cookie: null })).status).toBe(401);
    const noCsrf = await stack.post(url, body, { csrf: null });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.error.code).toBe('BAD_CSRF');
    expect((await stack.post(url, body, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect(stack.policy.proposals.state(id)).toBe('pending');
    stack.policy.commands.reject('owner', id);
  });

  it('bulk accept as canon refuses an ordinary proposal ("use Approve") and leaves it pending; no canon audit row', async () => {
    const id = await propose('Scribe');
    const rows = stack.audit('proposal.approve_as_canon').length;
    const r = await stack.post('/api/admin/proposals/bulk', {
      action: 'approve-as-canon',
      confirm: true,
      ids: [id, 'prop_missing'],
    });
    expect(r.status).toBe(200);
    expect(r.json.results[0]).toEqual({
      id,
      ok: false,
      state: 'pending',
      error: { code: 'NOT_CANONICAL', message: 'ordinary proposal; use Approve' },
    });
    expect(r.json.results[1]).toMatchObject({ ok: false, error: { code: 'PROPOSAL_NOT_FOUND' } });
    expect(stack.policy.proposals.state(id)).toBe('pending');
    expect(stack.audit('proposal.approve_as_canon').length).toBe(rows);
    // The ordinary Approve still works for it.
    const ok = await stack.post('/api/admin/proposals/bulk', { action: 'approve', ids: [id] });
    expect(ok.json.results[0]).toMatchObject({ id, ok: true });
  });

  it('shows a conflicted proposal and offers reject only', async () => {
    const id = await propose('Scribe');
    // Someone edits the document in LegendKeeper after the capture.
    const doc = model.docs.get('d_res1')!;
    doc.version += 1;
    doc.blocks = [{ kind: 'paragraph', content: [{ text: 'Edited elsewhere' }] }];
    const r = await stack.post(`/api/admin/proposals/${id}/approve`);
    expect(r.json.proposal.state).toBe('conflicted');
    expect(r.json.proposal.conflict).toMatchObject({ index: 0, op: 'replaceDocumentBlocks' });
    const again = await stack.post(`/api/admin/proposals/${id}/approve`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('INVALID_TRANSITION');
  });

  it('answers an unknown proposal with 404', async () => {
    expect((await stack.get('/api/admin/proposals/prop_nope')).status).toBe(404);
    expect((await stack.post('/api/admin/proposals/prop_nope/reject', {})).status).toBe(404);
  });
});
