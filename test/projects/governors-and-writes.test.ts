/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- parsed JSON tool and dashboard results */
/**
 * v2 A1: each project has its own governor (its own key, so its own tiers), the writer pool is shared fairly, a write
 * must name its project when several are served (REQUIRE_PROJECT_FOR_WRITES), and the per-project read-only flag
 * stops one project's writes only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WriterPool, type SlotInfo } from '../../src/jobs/writers.js';
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { IDS, startTwoProjects, type TwoProjects } from './helpers.js';

const create = (name: string, project?: string) => ({
  operationId: 'createResource',
  params: { body: { name } },
  ...(project !== undefined ? { project } : {}),
});

describe('each project has its own governor', () => {
  let t: TwoProjects;
  beforeAll(async () => {
    // A tiny write tier, the same limit for both projects (LK_TIER_LIMITS is bridge-wide; the counts are not).
    t = await startTwoProjects({ env: { LK_TIER_LIMITS: '{"write-min":3}' } });
  });
  afterAll(() => t.close());

  it('exhausting alpha’s write tier queues alpha’s writes and does not slow beta at all', async () => {
    const { client } = await t.connect('governors', 'write');
    const statuses: string[] = [];
    for (let i = 0; i < 6 && !statuses.includes('queued'); i++) {
      const r = await t.call(client, 'lk_api_write', create(`alpha ${i}`, 'alpha'));
      expect(r.isError, r.text).toBe(false);
      statuses.push(r.body.status);
    }
    // Some alpha writes went through, then alpha's tier was full and the next one queued (nothing was refused at LK).
    expect(statuses[0]).toBe('succeeded');
    expect(statuses.at(-1)).toBe('queued');
    expect(t.mocks.alpha.stats.genuine429).toBe(0);
    const alpha = t.stack.runtime.projects.anyClient(IDS.alpha)!.governor;
    const beta = t.stack.runtime.projects.anyClient(IDS.beta)!.governor;
    expect(beta.snapshot().tiers['write-min'].used).toBe(0);

    // Beta's writes go straight through, as fast as if alpha did not exist.
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      const r = await t.call(client, 'lk_api_write', create(`beta ${i}`, 'beta'));
      expect(r.body.status, r.text).toBe('succeeded');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.footer).toMatch(new RegExp(`^budget \\(beta\\): writes ${i + 1}/3·min`));
    }
    expect(beta.snapshot().tiers['write-min'].used).toBe(2);
    expect(alpha.snapshot().tiers['write-min'].used).toBe(statuses.filter((s) => s === 'succeeded').length);
    expect([...t.models.beta.resources.values()].map((r) => r.name)).toEqual(
      expect.arrayContaining(['beta 0', 'beta 1']),
    );
    // Alpha's queued job is still waiting on alpha's budget.
    const waiting = t.stack.runtime.engine.queries
      .listJobs(IDS.alpha, { status: ['queued', 'waiting_budget'] })
      .map((j) => j.projectId);
    expect(waiting.length).toBeGreaterThan(0);
    expect(
      t.stack.runtime.engine.queries.listJobs(IDS.beta, { status: ['queued', 'waiting_budget'] }),
    ).toEqual([]);
  });

  it('a 429 that blocks one project’s tier leaves the other project’s tier open', async () => {
    const { client } = await t.connect('governors', 'write');
    t.mocks.alpha.inject((c) => c.method === 'GET' && /\/resources\/?$/.test(c.path), {
      kind: 'rate-limit',
      tier: 'key-min',
      retryAfterS: 120,
    });
    const a = await t.call(client, 'lk_api_read', { operationId: 'listResources', project: 'alpha' });
    expect(a.body.error).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(a.footer).toMatch(/^budget \(alpha\): .*blocked key-min/);
    const started = Date.now();
    const b = await t.call(client, 'lk_api_read', { operationId: 'listResources', project: 'beta' });
    expect(b.isError, b.text).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(b.footer).not.toMatch(/blocked/);
    const betaTiers = t.stack.runtime.projects.anyClient(IDS.beta)!.governor.snapshot().tiers;
    expect(Object.values(betaTiers).every((x) => x.blockedUntilMs === null)).toBe(true);
  });
});

describe('the writer pool is shared fairly across projects', () => {
  const info = (projectId: string, n: number): SlotInfo => ({
    projectId,
    jobId: `${projectId}-${n}`,
    stepNo: 1,
    opId: 'createResource',
    lockKey: null,
    resourceId: null,
    documentId: null,
  });

  it('a project with a long queue cannot keep another project’s write waiting for more than one turn', async () => {
    const pool = new WriterPool(1, () => 0);
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const take = (i: SlotInfo) =>
      void pool.acquire(i).then((release) => {
        order.push(i.jobId);
        releases.push(release);
      });
    for (let n = 1; n <= 4; n++) take(info(IDS.alpha, n));
    take(info(IDS.beta, 1));
    take(info(IDS.beta, 2));
    const drain = async () => {
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
        await Promise.resolve();
        releases.shift()?.();
      }
      await Promise.resolve();
    };
    await drain();
    expect(order).toEqual([
      `${IDS.alpha}-1`,
      `${IDS.beta}-1`,
      `${IDS.alpha}-2`,
      `${IDS.beta}-2`,
      `${IDS.alpha}-3`,
      `${IDS.alpha}-4`,
    ]);
  });

  it('WRITERS_MAX is bridge-wide: two slots are shared by both projects', () => {
    const pool = new WriterPool(2, () => 0);
    void pool.acquire(info(IDS.alpha, 1));
    void pool.acquire(info(IDS.alpha, 2));
    void pool.acquire(info(IDS.beta, 1));
    const v = pool.view();
    expect(v.busy).toBe(2);
    expect(v.slots.map((s) => (s.state === 'busy' ? s.projectId : null))).toEqual([IDS.alpha, IDS.alpha]);
    expect(v.waiting.map((w) => w.projectId)).toEqual([IDS.beta]);
  });
});

describe('REQUIRE_PROJECT_FOR_WRITES', () => {
  let t: TwoProjects;
  beforeAll(async () => {
    t = await startTwoProjects();
  });
  afterAll(() => t.close());

  it('with two projects, a write without project is refused before anything is sent or recorded', async () => {
    const { client } = await t.connect('needs-project', 'write');
    const before = t.writesAt('alpha') + t.writesAt('beta');
    for (const [tool, args] of [
      ['lk_api_write', create('nowhere')],
      ['lk_api_batch', { calls: [create('nowhere')] }],
      ['bridge_job_cancel', { jobId: 'j_none' }],
    ] as const) {
      const r = await t.call(client, tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.body.error, tool).toMatchObject({ code: 'PROJECT_REQUIRED', registered: ['alpha', 'beta'] });
      expect(r.body.error.message, tool).toMatch(/must name one/);
    }
    expect(t.writesAt('alpha') + t.writesAt('beta')).toBe(before);
    expect(t.stack.runtime.engine.queries.listJobs(ALL_PROJECTS, {})).toEqual([]);
    expect(t.stack.policy.commands.listProposals('owner', { project: IDS.alpha, limit: 10 })).toEqual([]);
  });

  it('a proposal-scope write without project is refused too (no proposal is captured in a guessed project)', async () => {
    const { client } = await t.connect('needs-project-propose', 'propose');
    const r = await t.call(client, 'lk_api_write', create('nowhere'));
    expect(r.body.error).toMatchObject({ code: 'PROJECT_REQUIRED' });
    for (const id of Object.values(IDS)) {
      expect(t.stack.policy.commands.listProposals('owner', { project: id, limit: 10 })).toEqual([]);
    }
  });

  it('reads without project use the default project', async () => {
    const { client } = await t.connect('needs-project', 'write');
    const r = await t.call(client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'alpha_root' } },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.project).toBe('alpha');
    expect(t.mocks.beta.calls.filter((c) => c.path.includes('/resources'))).toEqual([]);
  });

  it('when turned off, a write without project goes to the default project', async () => {
    const off = await startTwoProjects({ env: { REQUIRE_PROJECT_FOR_WRITES: 'false' } });
    try {
      const { client } = await off.connect('no-need', 'write');
      const r = await off.call(client, 'lk_api_write', create('to the default'));
      expect(r.body.status, r.text).toBe('succeeded');
      expect(r.body.project).toBe('alpha');
      expect([...off.models.alpha.resources.values()].map((x) => x.name)).toContain('to the default');
      expect(off.writesAt('beta')).toBe(0);
      const info = await off.call(client, 'list_projects');
      expect(info.body.writesNeedProject).toBe(false);
    } finally {
      await off.close();
    }
  });

  it('with one project, a write without project is allowed', async () => {
    const one = await startTwoProjects({
      env: { LK_PROJECTS: 'alpha', LK_PROJECT_BETA_API_KEY: '', LK_DEFAULT_PROJECT: '' },
    });
    try {
      const { client } = await one.connect('only-one', 'write');
      const r = await one.call(client, 'lk_api_write', create('the only project'));
      expect(r.body.status, r.text).toBe('succeeded');
      expect(r.body.project).toBe('alpha');
      const list = await one.call(client, 'list_projects');
      expect(list.body).toMatchObject({ count: 1, default: 'alpha', writesNeedProject: false });
      // Beta is not configured, so naming it is refused with the one registered name.
      const beta = await one.call(client, 'lk_api_read', { operationId: 'listResources', project: 'beta' });
      expect(beta.body.error).toMatchObject({ code: 'UNKNOWN_PROJECT', registered: ['alpha'] });
    } finally {
      await one.close();
    }
  });
});

describe('the per-project read-only flag', () => {
  let t: TwoProjects;
  beforeAll(async () => {
    t = await startTwoProjects();
  });
  afterAll(() => t.close());

  it('stops one project’s writes only, is audited, and shows in list_projects and bridge_info', async () => {
    const { client } = await t.connect('read-only', 'write');
    // The dashboard change needs a confirmation.
    expect((await t.admin.put('/projects/beta/read-only', { value: true })).status).toBe(400);
    const set = await t.admin.put('/projects/beta/read-only', { value: true, confirm: true });
    expect(set.status, set.text).toBe(200);
    const audit = t.stack.audit('project.set_read_only');
    expect(audit[0]).toMatchObject({ action: 'project.set_read_only', target: 'beta' });

    const b = await t.call(client, 'lk_api_write', create('blocked', 'beta'));
    expect(b.body.error, b.text).toMatchObject({ code: 'READ_ONLY' });
    expect(t.writesAt('beta')).toBe(0);
    const a = await t.call(client, 'lk_api_write', create('allowed', 'alpha'));
    expect(a.body.status, a.text).toBe('succeeded');
    // Reads of the read-only project still work.
    const r = await t.call(client, 'lk_api_read', { operationId: 'listResources', project: 'beta' });
    expect(r.isError, r.text).toBe(false);

    const list = await t.call(client, 'list_projects');
    expect(list.body.projects.map((p: { name: string; readOnly: boolean }) => [p.name, p.readOnly])).toEqual([
      ['alpha', false],
      ['beta', true],
    ]);
    const info = await t.call(client, 'bridge_info', { project: 'beta' });
    expect(info.body.readOnly).toMatchObject({ effective: true, project: true, bridge: false });
    expect(info.body.writes.canWrite).toBe(false);
    const infoA = await t.call(client, 'bridge_info', { project: 'alpha' });
    expect(infoA.body.readOnly).toMatchObject({ effective: false, project: false });

    // And it can be turned off again.
    await t.admin.put('/projects/beta/read-only', { value: false, confirm: true });
    const again = await t.call(client, 'lk_api_write', create('allowed again', 'beta'));
    expect(again.body.status, again.text).toBe('succeeded');
  });

  it('the flag survives a restart (it is stored on the project row)', () => {
    const row = t.stack.db.prepare('SELECT read_only FROM projects WHERE id = ?').get(IDS.alpha) as {
      read_only: number;
    };
    expect(row.read_only).toBe(0);
    t.stack.runtime.projects.setReadOnly(IDS.alpha, true);
    expect(
      (
        t.stack.db.prepare('SELECT read_only FROM projects WHERE id = ?').get(IDS.alpha) as {
          read_only: number;
        }
      ).read_only,
    ).toBe(1);
    t.stack.runtime.projects.setReadOnly(IDS.alpha, false);
  });
});
