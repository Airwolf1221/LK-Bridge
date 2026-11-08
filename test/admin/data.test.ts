/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON replies and mock data in tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInterimBudgetSampler } from '../../src/admin/index.js';
import { systemClock } from '../../src/lk/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { startAdminStack, until, type AdminStack } from './helpers.js';

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});
let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ respond: model.respond });
});
afterAll(() => stack.close());

const engine = () => stack.runtime.engine;
const mcpOrigin = (principalId: string, profile: string) =>
  ({ kind: 'mcp', tool: 'lk_api_batch', principal: { principalId, profile, label: profile } }) as const;

describe('overview', () => {
  it('reports health, controls, jobs, errors, proposals and the headline gauges', async () => {
    const r = await stack.get('/api/admin/overview?refresh=true');
    expect(r.status).toBe(200);
    const o = r.json;
    expect(o.health).toMatchObject({ reachable: true, plan: 'ok' });
    expect(o.controls).toMatchObject({
      readOnly: false,
      writesPaused: false,
      draining: false,
      writersMax: 2,
    });
    expect(o.writes.state).toBe('running');
    expect(o.activeJobs).toMatchObject({ total: 0 });
    expect(o.errorsLastHour).toEqual({ count: 0, capped: false });
    expect(o.pendingProposals).toBe(0);
    expect(o.budget.gauges.map((g: any) => g.tier)).toEqual([
      'write-min',
      'key-min',
      'key-hour',
      'project-hour',
    ]);
    expect(o.budget.queues).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
  });

  it('reads the key’s role from what LegendKeeper shows of the members (emails are visible to ADMIN keys only)', async () => {
    const m = new LkModel(() => systemClock.now());
    m.members.set('m1', { id: 'm1', email: 'someone@example.invalid', role: 'ADMIN' });
    const admin = await startAdminStack({ respond: m.respond });
    try {
      const h = (await admin.get('/api/admin/overview?refresh=true')).json.health;
      expect(h).toMatchObject({ reachable: true, plan: 'ok', keyRole: 'ADMIN', note: null });
    } finally {
      await admin.close();
    }
    const m2 = new LkModel(() => systemClock.now());
    m2.members.set('m1', { id: 'm1', role: 'MEMBER' }); // no email: a MEMBER key
    const member = await startAdminStack({ respond: m2.respond });
    try {
      expect((await member.get('/api/admin/overview?refresh=true')).json.health.keyRole).toBe('MEMBER');
    } finally {
      await member.close();
    }
  });

  it('shows paused and draining writes', async () => {
    await stack.post('/api/admin/writes/pause');
    expect((await stack.get('/api/admin/overview')).json.writes.state).toBe('paused');
    await stack.post('/api/admin/writes/resume');
    await stack.post('/api/admin/writes/drain');
    expect((await stack.get('/api/admin/overview')).json.writes.state).toBe('draining');
    await stack.post('/api/admin/writes/undrain');
  });

  it('reports an unreachable or unpaid LegendKeeper without throwing', async () => {
    const down = await startAdminStack({
      respond: () => ({
        status: 402,
        body: { message: 'Paid plan required', code: 'PAID_PLAN_REQUIRED', requestId: 'r' },
      }),
    });
    try {
      const o = (await down.get('/api/admin/overview')).json;
      expect(o.health).toMatchObject({ plan: 'unpaid', reachable: true });
      expect(o.health.note).toMatch(/paid plan/);
    } finally {
      await down.close();
    }
  });
});

describe('jobs', () => {
  it('lists active and history separately and filters by status, origin and principal', async () => {
    await engine()
      .submit({
        kind: 'batch_ops',
        title: 'By Alice',
        origin: mcpOrigin('pat_alice', 'Alice'),
        steps: [{ op: 'createResource', params: { body: { name: 'A' } } }],
      })
      .catch(() => undefined);
    // Alice's profile does not exist, so the gate refuses her: use the owner's own work instead.
    const mine = (await engine().submit({
      kind: 'batch_ops',
      title: 'By the dashboard',
      origin: { kind: 'ui', tool: 'x' },
      steps: [{ op: 'createResource', params: { body: { name: 'B' } } }],
    })) as { jobId: string };
    await until(() => engine().queries.getJob(mine.jobId)?.status === 'succeeded');

    const history = await stack.get('/api/admin/jobs?view=history');
    expect(history.json.jobs.some((j: any) => j.id === mine.jobId)).toBe(true);
    expect(
      (await stack.get('/api/admin/jobs?view=active')).json.jobs.some((j: any) => j.id === mine.jobId),
    ).toBe(false);
    expect((await stack.get('/api/admin/jobs?status=succeeded,failed')).json.jobs.length).toBeGreaterThan(0);
    expect(
      (await stack.get('/api/admin/jobs?origin=mcp')).json.jobs.every((j: any) => j.origin.kind === 'mcp'),
    ).toBe(true);
    expect(
      (await stack.get('/api/admin/jobs?principalId=system')).json.jobs.some((j: any) => j.id === mine.jobId),
    ).toBe(true);
    expect((await stack.get('/api/admin/jobs?principalId=pat_nobody')).json.jobs).toEqual([]);
    expect((await stack.get('/api/admin/jobs?status=bogus')).status).toBe(400);
    expect((await stack.get('/api/admin/jobs?limit=0')).status).toBe(400);
  });

  it('filters by an agent principal and profile', async () => {
    const profile = stack.policy.commands.createProfile('owner', {
      label: 'Writer bot',
      kind: 'claude',
      scope: 'write',
    });
    const pat = stack.services.pats.create({ name: 'bot', profileId: profile.id });
    const r = (await engine().submit({
      kind: 'batch_ops',
      title: 'Bot batch',
      origin: mcpOrigin(pat.pat.id, 'Writer bot'),
      steps: [{ op: 'createResource', params: { body: { name: 'C' } } }],
    })) as { jobId: string };
    await until(() => engine().queries.getJob(r.jobId)?.status === 'succeeded');
    const byPrincipal = (await stack.get(`/api/admin/jobs?principalId=${pat.pat.id}`)).json.jobs;
    expect(byPrincipal.map((j: any) => j.id)).toEqual([r.jobId]);
    expect(byPrincipal[0]).toMatchObject({
      profile: 'Writer bot',
      origin: { kind: 'mcp', tool: 'lk_api_batch' },
    });
    expect((await stack.get('/api/admin/jobs?profile=Writer%20bot')).json.jobs).toHaveLength(1);
  });

  it('shows a job with its steps, attempts, request ids, the uncertain flag and artefacts', async () => {
    const r = (await engine().submit({
      kind: 'batch_ops',
      title: 'Detail',
      origin: { kind: 'ui', tool: 'x' },
      steps: [{ op: 'createResource', params: { body: { name: 'D' } } }],
    })) as { jobId: string };
    await until(() => engine().queries.getJob(r.jobId)?.status === 'succeeded');
    const job = (await stack.get(`/api/admin/jobs/${r.jobId}`)).json.job;
    expect(job).toMatchObject({
      id: r.jobId,
      status: 'succeeded',
      uncertain: false,
      progress: { stepsDone: 1, stepsTotal: 1 },
    });
    expect(job.steps[0]).toMatchObject({ opId: 'createResource', status: 'succeeded', attempts: 1 });
    expect(job.steps[0].requestIds.length).toBeGreaterThan(0);
    expect(job.steps[0].clientIds).toHaveLength(1);
    expect((await stack.get('/api/admin/jobs/job_missing')).status).toBe(404);
  });

  it('flags an uncertain job and warns before a forced retry', async () => {
    const r = (await engine().submit({
      kind: 'batch_ops',
      title: 'Uncertain',
      origin: { kind: 'ui', tool: 'x' },
      steps: [{ op: 'createResource', params: { body: { name: 'U' } } }],
    })) as { jobId: string };
    await until(() => engine().queries.getJob(r.jobId)?.status === 'succeeded');
    // Make the stored state look like a step that may have applied (what a crash leaves behind).
    stack.db.prepare("UPDATE steps SET status = 'uncertain' WHERE job_id = ?").run(r.jobId);
    stack.db.prepare("UPDATE jobs SET status = 'failed', uncertain = 1 WHERE id = ?").run(r.jobId);
    const job = (await stack.get(`/api/admin/jobs/${r.jobId}`)).json.job;
    expect(job.uncertain).toBe(true);
    expect(job.steps[0].retry).toMatchObject({ allowed: true, ambiguous: true });
    expect(job.steps[0].retry.warning).toMatch(/Force/);
    const list = (await stack.get('/api/admin/jobs?view=history')).json.jobs.find(
      (j: any) => j.id === r.jobId,
    );
    expect(list.uncertain).toBe(true);
  });

  it('never shows signed-URL material or image bytes, in job views, artefacts or lists', async () => {
    const rec = engine().recordResult({
      opId: 'createImageUpload',
      params: { body: { name: 'x.png' } },
      value: {
        uploadUrl: 'https://storage.example/put?sig=SUPERSECRETSIG',
        uploadKey: 'KEYKEYKEY',
        headers: { authorization: 'Bearer HDRSECRET' },
        dataBase64: 'QUFBQQ==',
        fine: 'visible',
      },
      origin: { kind: 'ui', tool: 'x' },
    });
    const all = [
      (await stack.get(`/api/admin/jobs/${rec.jobId}`)).text,
      (await stack.get(`/api/admin/jobs/${rec.jobId}/artifacts/${rec.artifactId}`)).text,
      (await stack.get('/api/admin/jobs?view=history')).text,
    ].join('\n');
    expect(all).toContain('visible');
    for (const secret of ['SUPERSECRETSIG', 'KEYKEYKEY', 'HDRSECRET', 'QUFBQQ=='])
      expect(all).not.toContain(secret);
    expect((await stack.get(`/api/admin/jobs/${rec.jobId}/artifacts/art_other`)).status).toBe(404);
  });

  it('shortens very long values instead of flooding the page', async () => {
    const rec = engine().recordResult({
      opId: 'getDocumentBlocks',
      params: {},
      value: { text: 'x'.repeat(50_000) },
      origin: { kind: 'ui', tool: 'x' },
    });
    const body = (await stack.get(`/api/admin/jobs/${rec.jobId}/artifacts/${rec.artifactId}`)).text;
    expect(body.length).toBeLessThan(10_000);
    expect(body).toMatch(/more characters/);
  });
});

describe('writers', () => {
  it('shows busy slots with job, op and document, the held lock and the wait queue', async () => {
    const release = stack.hold((m, u) => m === 'PUT' && /\/docs\/d_res1\/blocks/.test(u));
    const write = (title: string) =>
      engine().submit({
        kind: 'batch_ops',
        title,
        origin: { kind: 'ui', tool: 'x' },
        steps: [
          {
            op: 'replaceDocumentBlocks',
            params: {
              path: { resourceId: 'res1', documentId: 'd_res1' },
              body: { blocks: [{ kind: 'paragraph', content: [{ text: title }] }] },
            },
          },
        ],
      }) as Promise<{ jobId: string }>;
    const first = await write('First writer');
    const second = await write('Second writer');
    await until(
      () =>
        engine().queries.writers().busy === 1 &&
        engine()
          .queries.locks()
          .some((l) => l.waiting.length > 0),
    );
    const w = (await stack.get('/api/admin/writers')).json;
    const busy = w.writers.slots.filter((s: any) => s.state === 'busy');
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({
      opId: 'replaceDocumentBlocks',
      documentId: 'd_res1',
      jobId: first.jobId,
    });
    expect(w.writers.slots.some((s: any) => s.state === 'idle')).toBe(true);
    expect(w.locks[0]).toMatchObject({ key: 'doc:d_res1' });
    expect(w.locks[0].holder.jobId).toBe(first.jobId);
    expect(w.locks[0].waiting[0].jobId).toBe(second.jobId);
    expect(w.jobs[first.jobId].title).toBe('First writer');
    expect(w.jobs[second.jobId].status).toBe('waiting_lock');
    expect(w.writesPerMinute).toBeTypeOf('number');
    release();
    await until(() => engine().queries.getJob(second.jobId)?.status === 'succeeded');
    const idle = (await stack.get('/api/admin/writers')).json;
    expect(idle.writers.busy).toBe(0);
    expect(idle.locks).toEqual([]);
  });
});

describe('journal', () => {
  it('lists entries without pre-images and shows one with its pre-image as data', async () => {
    const r = await engine().run(
      'replaceDocumentBlocks',
      {
        path: { resourceId: 'res1', documentId: 'd_res1' },
        body: { blocks: [{ kind: 'paragraph', content: [{ text: 'Journal me' }] }] },
      },
      { origin: { kind: 'ui', tool: 'x' } },
    );
    expect(r.status).toBe('succeeded');
    const list = (await stack.get('/api/admin/journal?opId=replaceDocumentBlocks&limit=5')).json;
    expect(list.entries.length).toBeGreaterThan(0);
    const entry = list.entries[0];
    expect(entry).toMatchObject({
      opId: 'replaceDocumentBlocks',
      principalId: 'system',
      profile: 'system',
      documentId: 'd_res1',
      outcome: 'applied',
    });
    expect(entry).not.toHaveProperty('preImage');
    const detail = (await stack.get(`/api/admin/journal/${entry.id}`)).json.entry;
    expect(detail.preImage).toBeTruthy();
    expect(JSON.stringify(detail.preImage)).toContain('paragraph');
    expect((await stack.get('/api/admin/journal/999999')).status).toBe(404);
    expect((await stack.get('/api/admin/journal/abc')).status).toBe(400);
    expect((await stack.get('/api/admin/journal?principalId=nobody')).json.entries).toEqual([]);
    expect(
      (await stack.get('/api/admin/journal?documentId=d_res1&sinceMinutes=5')).json.entries.length,
    ).toBeGreaterThan(0);
  });

  it('is view only: there is no route that changes it', () => {
    const journal = stack.routes.filter((r) => r.url.startsWith('/api/admin/journal'));
    expect(journal.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('budgets', () => {
  it('shows every tier, the queues, reserve floors, drift and a 24 hour history in buckets', async () => {
    for (let i = 0; i < 3; i++) engine().recordBudgetSample(stack.runtime.lk.governor.snapshot());
    const b = (await stack.get('/api/admin/budgets')).json;
    expect(Object.keys(b.snapshot.tiers)).toEqual(
      expect.arrayContaining([
        'write-min',
        'write-hour',
        'key-min',
        'key-hour',
        'key-day',
        'project-hour',
        'items-min',
        'items-hour',
        'upload',
      ]),
    );
    expect(b.snapshot.tiers.upload).toMatchObject({ reactiveOnly: true, limit: null });
    expect(b.snapshot.queues).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
    expect(b.reserveFloors.current).toEqual({ interactive: 0.1, job: 0.25, maintenance: 0.5 });
    expect(b.projectDrift === null || typeof b.projectDrift.delta === 'number').toBe(true);
    expect(b.samples.count).toBeGreaterThanOrEqual(3);
    expect(b.samples.points.length).toBeGreaterThanOrEqual(1);
    expect(b.samples.points[0].tiers['write-min']).toMatchObject({ limit: 120 });
    expect(b.samples.bucketMs).toBeGreaterThanOrEqual(10_000);
    expect((await stack.get('/api/admin/budgets?hours=99')).status).toBe(400);
  });

  it('keeps at most the requested number of points however many samples there are', async () => {
    const { bucketSamples } = await import('../../src/admin/routes/budgets.js');
    const samples = Array.from({ length: 8640 }, (_, i) => ({
      at: 1_000_000 + i * 10_000,
      tiers: { 'write-min': { used: i % 100, limit: 120 } },
      queues: { P1: i % 3 },
      inFlight: 0,
    })) as unknown as Parameters<typeof bucketSamples>[0];
    const out = bucketSamples(samples, 1_000_000, 1_000_000 + 8640 * 10_000, 288);
    expect(out.points.length).toBeLessThanOrEqual(289);
    expect(Math.max(...out.points.map((p) => p.tiers['write-min']!.used))).toBe(99); // spikes survive
  });
});

describe('the interim budget sampler', () => {
  it('records samples on a timer and stops cleanly', async () => {
    const count = () => engine().queries.listBudgetSamples({}).length;
    const before = count();
    const stop = startInterimBudgetSampler(engine(), stack.runtime.lk, 20);
    await until(() => count() >= before + 3);
    stop();
    await new Promise((r) => setTimeout(r, 30));
    const settled = count();
    await new Promise((r) => setTimeout(r, 100));
    expect(count()).toBe(settled);
  });

  it('does not start when disabled, and never throws out of the timer', async () => {
    const stop = startInterimBudgetSampler(engine(), stack.runtime.lk, 0);
    stop();
    const errors: unknown[] = [];
    const broken = {
      recordBudgetSample: () => {
        throw new Error('db closed');
      },
    } as unknown as typeof stack.runtime.engine;
    const stop2 = startInterimBudgetSampler(broken, stack.runtime.lk, 10, (e) => errors.push(e));
    await until(() => errors.length >= 2);
    stop2();
  });

  it('runs inside the runtime and stops on shutdown', async () => {
    const s = await startAdminStack({ admin: { budgetSampleMs: 30 } });
    try {
      const count = () => s.runtime.engine.queries.listBudgetSamples({}).length;
      await until(() => count() >= 3);
      await s.runtime.shutdown(200);
      const settled = count();
      await new Promise((r) => setTimeout(r, 120));
      expect(count()).toBe(settled);
    } finally {
      await s.close();
    }
  });
});

describe('clients and access view', () => {
  it('lists profiles with their kind and scope, grants and PATs with profile and last use, and the default scope', async () => {
    const c = (await stack.get('/api/admin/clients')).json;
    expect(c.defaultScope).toBe('read');
    expect(c.kinds).toEqual(['claude', 'chatgpt', 'claude-code', 'other']);
    expect(c.scopes).toEqual(['read', 'propose', 'write']);
    const bot = c.profiles.find((p: any) => p.label === 'Writer bot');
    expect(bot).toMatchObject({ kind: 'claude', scope: 'write', connections: 1 });
    const conn = c.connections.find((x: any) => x.label === 'bot');
    expect(conn).toMatchObject({ type: 'pat', profile: 'Writer bot', scope: 'write', active: true });
    expect(conn).toHaveProperty('lastUsedAt');
    expect(JSON.stringify(c)).not.toMatch(/lkb_pat_/);
  });
});

describe('audit', () => {
  it('lists the owner commands newest first', async () => {
    const a = (await stack.get('/api/admin/audit?limit=5')).json.entries;
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].at).toBeGreaterThanOrEqual(a.at(-1).at);
    expect(a.every((x: any) => x.actor === 'owner' || x.actor === 'system')).toBe(true);
    expect(
      (await stack.get('/api/admin/audit?action=profile.create')).json.entries.every(
        (x: any) => x.action === 'profile.create',
      ),
    ).toBe(true);
  });
});

describe('secrets and the log', () => {
  it('never writes a token, cookie or CSRF value to the log while the owner creates and revokes access', async () => {
    const s = await startAdminStack({ respond: model.respond, captureLogs: true });
    try {
      const profile =
        s.policy.commands.listProfiles('owner')[0] ??
        s.policy.commands.createProfile('owner', { label: 'Logged', kind: 'other' });
      const made = await s.post('/api/admin/clients/pats', { name: 'Log check', profileId: profile.id });
      const token: string = made.json.token;
      await s.get('/api/admin/clients');
      await s.post(`/api/admin/clients/connections/${made.json.pat.id}/revoke`);
      await s.post('/api/admin/writes/pause');
      await s.post('/api/admin/writes/resume');
      const log = s.logs.join('\n');
      expect(log).toContain('/api/admin/clients/pats'); // requests are logged...
      for (const secret of [token.slice('lkb_pat_'.length), s.sessionToken, s.csrf]) {
        expect(log).not.toContain(secret); // ...but no secret is
      }
      expect(log).not.toMatch(/query|\?/); // and query strings are never logged
    } finally {
      await s.close();
    }
  });
});
