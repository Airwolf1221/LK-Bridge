/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON tool and dashboard results */
/**
 * v2 A1, the core promise: two LegendKeeper projects with different keys served by one bridge at once, and NOTHING of
 * one — data, job, journal entry, proposal, budget counter, error, mapping set — ever appears in the other's queries,
 * MCP tools or dashboard views. Each surface is tested for each kind of record, in both directions.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { IDS, KEYS, NAMES, startTwoProjects, type Name, type TwoProjects } from './helpers.js';

let t: TwoProjects;
let writer: { client: Client; patId: string };
let proposer: { client: Client; patId: string };
/** What each project did, for the checks below. */
const made: Record<Name, { jobId: string; resourceName: string; failedJobId?: string; proposalId?: string }> =
  {
    alpha: { jobId: '', resourceName: 'Made in alpha' },
    beta: { jobId: '', resourceName: 'Made in beta' },
  };
const other = (n: Name): Name => (n === 'alpha' ? 'beta' : 'alpha');

beforeAll(async () => {
  t = await startTwoProjects();
  writer = await t.connect('two-projects-writer', 'write');
  proposer = await t.connect('two-projects-proposer', 'propose');

  for (const name of NAMES) {
    // A write that succeeds (a job and a journal entry), and one that fails at LegendKeeper (an error).
    const ok = await t.call(writer.client, 'lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: made[name].resourceName } },
      project: name,
    });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.body.status, ok.text).toBe('succeeded');
    made[name].jobId = ok.body.jobId;
    const bad = await t.call(writer.client, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: `${name}_missing` }, body: { name: 'x' } },
      project: name,
    });
    expect(bad.isError, bad.text).toBe(true);
    expect(bad.body.error.lkCode, bad.text).toBe('NOT_FOUND');
    made[name].failedJobId = bad.body.error.jobId;
    // A proposal (a write held for the owner).
    const p = await t.call(proposer.client, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: `${name}_root` }, body: { name: `${name} root, renamed` } },
      project: name,
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    made[name].proposalId = p.body.proposalId;
  }
  // A mapping set in alpha only, through the dashboard.
  const set = await t.admin.post('/mappings/sets?project=alpha', { name: 'Alpha taxonomy' });
  expect(set.status, set.text).toBe(201);
  // A budget sample of every governor.
  await t.stack.runtime.maintenance.commands.runNow('owner', 'budget-sampler').done;
});
afterAll(() => t?.close());

describe('the projects are registered and checked', () => {
  it('both keys proved their projects at start-up; list_projects shows both, never a key or the sandbox flag', async () => {
    const r = await t.call(writer.client, 'list_projects');
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ count: 2, default: 'alpha', writesNeedProject: true });
    expect(r.body.projects).toEqual([
      expect.objectContaining({
        name: 'alpha',
        id: IDS.alpha,
        default: true,
        readOnly: false,
        available: true,
      }),
      expect.objectContaining({
        name: 'beta',
        id: IDS.beta,
        default: false,
        readOnly: false,
        available: true,
      }),
    ]);
    for (const p of r.body.projects) expect(Object.keys(p)).not.toContain('isSandbox');
    expect(r.text).not.toContain(KEYS.alpha);
    expect(r.text).not.toContain(KEYS.beta);
    expect(r.text).not.toMatch(/sandbox|API_KEY/i);
  });

  it('each project was sent to LegendKeeper with its own key only', () => {
    // MultiMockLk routes by key: every request a mock project saw carried that project's key.
    for (const name of NAMES) {
      const own = t.mocks[name].calls;
      expect(own.length).toBeGreaterThan(0);
      for (const c of own) expect(c.path.startsWith(`/api/v3/projects`), c.path).toBe(true);
      for (const c of own.filter((x) => /^\/api\/v3\/projects\/[^/]+\//.test(x.path))) {
        expect(c.path, `${name} got a request for the other project`).toContain(`/projects/${IDS[name]}/`);
      }
    }
  });
});

describe('LegendKeeper data stays in its project', () => {
  it('each write reached its own project only', () => {
    for (const name of NAMES) {
      const names = [...t.models[name].resources.values()].map((r) => r.name);
      expect(names).toContain(made[name].resourceName);
      expect(names).not.toContain(made[other(name)].resourceName);
    }
  });

  it('reads see their own project: a read without project goes to the default (alpha)', async () => {
    const def = await t.call(writer.client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'alpha_root' } },
    });
    expect(def.isError, def.text).toBe(false);
    expect(def.body.project).toBe('alpha');
    expect(def.footer).toMatch(/^budget \(alpha\): /);
    const cross = await t.call(writer.client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'alpha_root' } },
      project: 'beta',
    });
    expect(cross.isError).toBe(true);
    expect(cross.body.project).toBe('beta');
    expect(cross.footer).toMatch(/^budget \(beta\): /);
  });

  it('a project may be named by its LegendKeeper id, and an unknown one is refused with the registered names', async () => {
    const byId = await t.call(writer.client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'beta_root' } },
      project: IDS.beta,
    });
    expect(byId.isError, byId.text).toBe(false);
    expect(byId.body.project).toBe('beta');
    const before = t.mocks.alpha.calls.length + t.mocks.beta.calls.length;
    for (const tool of [
      'lk_api_read',
      'lk_api_write',
      'bridge_budget',
      'bridge_job_status',
      'bridge_proposals_mine',
    ]) {
      const r = await t.call(writer.client, tool, {
        ...(tool.startsWith('lk_api') ? { operationId: 'listResources' } : {}),
        project: 'gamma',
      });
      expect(r.isError, tool).toBe(true);
      expect(r.body.error, tool).toMatchObject({ code: 'UNKNOWN_PROJECT', registered: ['alpha', 'beta'] });
      // Like every result, it ends with a budget line: the default project's, where a read would go.
      expect(r.footer, tool).toMatch(/^budget \(alpha\): /);
    }
    const unknown = await t.call(writer.client, 'lk_api_read', {
      operationId: 'listResources',
      project: 'gamma',
    });
    expect(unknown.body.error).toMatchObject({ code: 'UNKNOWN_PROJECT', registered: ['alpha', 'beta'] });
    expect(t.mocks.alpha.calls.length + t.mocks.beta.calls.length).toBe(before);
  });
});

describe('jobs', () => {
  it('queries: each project lists its own jobs only, and finds no job of the other', () => {
    const q = t.stack.runtime.engine.queries;
    for (const name of NAMES) {
      const ids = q.listJobs(IDS[name], {}).map((j) => j.id);
      expect(ids).toContain(made[name].jobId);
      expect(ids).not.toContain(made[other(name)].jobId);
      expect(q.getJob(IDS[name], made[other(name)].jobId)).toBeUndefined();
      for (const j of q.listJobs(IDS[name], {})) expect(j.projectId).toBe(IDS[name]);
    }
    // "All projects" is an explicit choice, and sees both.
    const all = q.listJobs(ALL_PROJECTS, {}).map((j) => j.id);
    expect(all).toEqual(expect.arrayContaining([made.alpha.jobId, made.beta.jobId]));
  });

  it('tools: bridge_job_status finds a job in its own project only', async () => {
    for (const name of NAMES) {
      const own = await t.call(writer.client, 'bridge_job_status', {
        jobId: made[name].jobId,
        project: name,
      });
      expect(own.isError, own.text).toBe(false);
      expect(own.body.project).toBe(name);
      const cross = await t.call(writer.client, 'bridge_job_status', {
        jobId: made[name].jobId,
        project: other(name),
      });
      expect(cross.isError, cross.text).toBe(true);
      const listed = await t.call(writer.client, 'bridge_job_status', { project: other(name) });
      expect(JSON.stringify(listed.body)).not.toContain(made[name].jobId);
    }
  });

  it('dashboard: /jobs and /jobs/:id are scoped by ?project=', async () => {
    for (const name of NAMES) {
      const list = await t.admin.get(`/jobs?project=${name}`);
      expect(list.status, list.text).toBe(200);
      expect(list.json.project).toMatchObject({ id: IDS[name], name });
      const ids = list.json.jobs.map((j: { id: string }) => j.id);
      expect(ids).toContain(made[name].jobId);
      expect(ids).not.toContain(made[other(name)].jobId);
      expect((await t.admin.get(`/jobs/${made[name].jobId}?project=${name}`)).status).toBe(200);
      expect((await t.admin.get(`/jobs/${made[name].jobId}?project=${other(name)}`)).status).toBe(404);
      // A job control acts within the page's project: the other project's job is "not found".
      expect((await t.admin.post(`/jobs/${made[name].jobId}/cancel?project=${other(name)}`)).status).toBe(
        404,
      );
    }
  });
});

describe('the write journal', () => {
  it('queries and tools: each project shows its own writes only', async () => {
    for (const name of NAMES) {
      const entries = t.stack.runtime.engine.queries.journalLookup(IDS[name], { limit: 100 });
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(e.jobId === null || e.jobId !== made[other(name)].jobId).toBe(true);
      expect(JSON.stringify(entries)).not.toContain(made[other(name)].resourceName);
      const tool = await t.call(writer.client, 'bridge_journal_lookup', { project: name });
      expect(tool.isError, tool.text).toBe(false);
      expect(tool.body.project).toBe(name);
      expect(tool.body.count).toBe(entries.length);
      expect(JSON.stringify(tool.body)).not.toContain(made[other(name)].jobId);
      expect(JSON.stringify(tool.body)).not.toContain(`${other(name)}_root`);
    }
  });

  it('dashboard: /journal and /journal/:id are scoped', async () => {
    const alpha = await t.admin.get('/journal?project=alpha');
    const beta = await t.admin.get('/journal?project=beta');
    expect(alpha.status).toBe(200);
    const alphaIds = alpha.json.entries.map((e: { id: number }) => e.id);
    const betaIds = beta.json.entries.map((e: { id: number }) => e.id);
    expect(alphaIds.length).toBeGreaterThan(0);
    expect(betaIds.length).toBeGreaterThan(0);
    expect(alphaIds.filter((id: number) => betaIds.includes(id))).toEqual([]);
    expect((await t.admin.get(`/journal/${alphaIds[0]}?project=alpha`)).status).toBe(200);
    expect((await t.admin.get(`/journal/${alphaIds[0]}?project=beta`)).status).toBe(404);
  });
});

describe('errors', () => {
  it('queries: each project has its own failure only', () => {
    for (const name of NAMES) {
      const rows = t.stack.runtime.engine.queries.listErrors(IDS[name], { limit: 100 });
      const jobs = rows.map((r) => r.jobId);
      expect(jobs).toContain(made[name].failedJobId);
      expect(jobs).not.toContain(made[other(name)].failedJobId);
      for (const r of rows) expect(r.projectId).toBe(IDS[name]);
      const groups = t.stack.runtime.engine.queries.listErrorGroups(IDS[name], { limit: 100 });
      expect(groups.map((g) => g.lastJobId)).not.toContain(made[other(name)].failedJobId);
    }
  });

  it('tools: bridge_errors_recent shows the asked project’s errors only', async () => {
    for (const name of NAMES) {
      const r = await t.call(writer.client, 'bridge_errors_recent', { project: name, grouped: false });
      expect(r.isError, r.text).toBe(false);
      expect(r.body.project).toBe(name);
      expect(r.text).toContain(made[name].failedJobId);
      expect(r.text).not.toContain(made[other(name)].failedJobId);
    }
  });

  it('dashboard: /errors and /errors/group are scoped', async () => {
    for (const name of NAMES) {
      const r = await t.admin.get(`/errors?project=${name}`);
      expect(r.status).toBe(200);
      expect(r.text).toContain(made[name].failedJobId);
      expect(r.text).not.toContain(made[other(name)].failedJobId);
      const fingerprint = r.json.groups.find(
        (g: { lastJobId: string }) => g.lastJobId === made[name].failedJobId,
      ).fingerprint as string;
      // Both projects failed the same way, so both have this fingerprint: each group holds its own occurrences only.
      const group = async (p: Name) =>
        (await t.admin.get(`/errors/group?fingerprint=${encodeURIComponent(fingerprint)}&project=${p}`)).json;
      const own = await group(name);
      const cross = await group(other(name));
      const jobsOf = (g: { occurrences: { jobId: string }[] }) => g.occurrences.map((o) => o.jobId);
      expect(jobsOf(own)).toContain(made[name].failedJobId);
      expect(jobsOf(own)).not.toContain(made[other(name)].failedJobId);
      expect(jobsOf(cross)).not.toContain(made[name].failedJobId);
      expect(own.group.count).toBe(1);
    }
  });
});

describe('proposals', () => {
  it('queries: each project lists its own proposal only', () => {
    for (const name of NAMES) {
      const ids = t.stack.policy.commands
        .listProposals('owner', { project: IDS[name], limit: 100 })
        .map((p) => p.id);
      expect(ids).toEqual([made[name].proposalId]);
    }
  });

  it('tools: bridge_proposals_mine and bridge_proposal_status see the asked project only', async () => {
    for (const name of NAMES) {
      const mine = await t.call(proposer.client, 'bridge_proposals_mine', { project: name });
      expect(mine.isError, mine.text).toBe(false);
      expect(mine.text).toContain(made[name].proposalId!);
      expect(mine.text).not.toContain(made[other(name)].proposalId!);
      const own = await t.call(proposer.client, 'bridge_proposal_status', {
        proposalId: made[name].proposalId,
        project: name,
      });
      expect(own.isError, own.text).toBe(false);
      const cross = await t.call(proposer.client, 'bridge_proposal_status', {
        proposalId: made[name].proposalId,
        project: other(name),
      });
      expect(cross.isError).toBe(true);
      expect(cross.body.error).toContain(`project "${other(name)}"`);
    }
  });

  it('dashboard: /proposals, /proposals/:id and the counts are scoped', async () => {
    for (const name of NAMES) {
      const list = await t.admin.get(`/proposals?project=${name}`);
      expect(list.json.proposals.map((p: { id: string }) => p.id)).toEqual([made[name].proposalId]);
      expect((await t.admin.get(`/proposals/${made[name].proposalId}?project=${name}`)).status).toBe(200);
      expect((await t.admin.get(`/proposals/${made[name].proposalId}?project=${other(name)}`)).status).toBe(
        404,
      );
      const counts = await t.admin.get(`/proposals/counts?project=${name}`);
      expect(counts.json.counts.pending).toBe(1);
      expect(counts.json.byProject).toEqual({ alpha: 1, beta: 1 });
    }
  });

  it('approval runs against the proposal’s own project only, and cannot be done from the other', async () => {
    const wrong = await t.admin.post(`/proposals/${made.beta.proposalId}/approve?project=alpha`);
    expect(wrong.status).toBe(404);
    const alphaWritesBefore = t.writesAt('alpha');
    const ok = await t.admin.post(`/proposals/${made.beta.proposalId}/approve?project=beta`);
    expect(ok.status, ok.text).toBe(200);
    await expect
      .poll(() => t.stack.policy.commands.getProposal('owner', made.beta.proposalId!).state, {
        timeout: 5000,
      })
      .toBe('executed');
    expect(t.models.beta.resources.get('beta_root')!.name).toBe('beta root, renamed');
    expect(t.models.alpha.resources.get('alpha_root')!.name).toBe('alpha root');
    expect(t.writesAt('alpha')).toBe(alphaWritesBefore);
    // Its job and journal entry are beta's.
    const view = t.stack.policy.commands.getProposal('owner', made.beta.proposalId!);
    expect(view.projectId).toBe(IDS.beta);
    const jobId = view.jobId!;
    expect(t.stack.runtime.engine.queries.getJob(IDS.beta, jobId)).toBeDefined();
    expect(t.stack.runtime.engine.queries.getJob(IDS.alpha, jobId)).toBeUndefined();
  });
});

describe('budget counters', () => {
  it('each governor counted its own project’s calls only', () => {
    for (const name of NAMES) {
      const s = t.stack.runtime.projects.anyClient(IDS[name])!.governor.snapshot();
      const writes = t.mocks[name].counted.filter((c) => c.tiers.includes('write-min')).length;
      expect(s.tiers['write-min'].used, name).toBe(writes);
    }
    expect(t.writesAt('alpha')).not.toBe(t.writesAt('beta'));
  });

  it('tools: bridge_budget and every footer show the asked project’s numbers, naming it', async () => {
    for (const name of NAMES) {
      const r = await t.call(writer.client, 'bridge_budget', { project: name });
      expect(r.body.project).toBe(name);
      const used = r.body.tiers.find((x: { tier: string }) => x.tier === 'write-min').used;
      expect(used).toBe(
        t.stack.runtime.projects.anyClient(IDS[name])!.governor.snapshot().tiers['write-min'].used,
      );
      expect(r.footer).toMatch(new RegExp(`^budget \\(${name}\\): writes ${used}/`));
    }
    const all = await t.call(writer.client, 'bridge_budget', { allProjects: true });
    expect(all.body.allProjects.map((p: { name: string }) => p.name)).toEqual(['alpha', 'beta']);
    const usedOf = (n: Name) =>
      all.body.allProjects
        .find((p: { name: string }) => p.name === n)
        .budget.tiers.find((x: { tier: string }) => x.tier === 'write-min').used;
    expect(usedOf('alpha')).not.toBe(usedOf('beta'));
  });

  it('queries and dashboard: budget samples are per project, and /budgets/all shows both side by side', async () => {
    const q = t.stack.runtime.engine.queries;
    for (const name of NAMES) {
      const samples = q.listBudgetSamples(IDS[name], { since: 0, until: Date.now() + 1000, limit: 100 });
      expect(samples.length).toBe(1);
      const r = await t.admin.get(`/budgets?project=${name}`);
      expect(r.status).toBe(200);
      expect(r.json.project).toMatchObject({ id: IDS[name], name });
      expect(r.json.samples.count).toBe(1);
      expect(r.json.snapshot.tiers['write-min'].used).toBe(
        t.stack.runtime.projects.anyClient(IDS[name])!.governor.snapshot().tiers['write-min'].used,
      );
    }
    expect(
      q.listBudgetSamples(ALL_PROJECTS, { since: 0, until: Date.now() + 1000, limit: 100 }),
    ).toHaveLength(2);
    const all = await t.admin.get('/budgets/all');
    expect(all.json.projects.map((p: { project: { name: string } }) => p.project.name)).toEqual([
      'alpha',
      'beta',
    ]);
    for (const p of all.json.projects) expect(p.samples.count).toBe(1);
  });
});

describe('mapping sets', () => {
  it('a set made in alpha is not in beta (store and dashboard)', async () => {
    const a = await t.admin.get('/mappings?project=alpha');
    const b = await t.admin.get('/mappings?project=beta');
    expect(a.json.sets.map((s: { name: string }) => s.name)).toEqual(['Alpha taxonomy']);
    expect(b.json.sets).toEqual([]);
    const id = a.json.sets[0].id as string;
    expect((await t.admin.get(`/mappings/sets/${id}?project=alpha`)).status).toBe(200);
    expect((await t.admin.get(`/mappings/sets/${id}?project=beta`)).status).toBe(404);
    expect(t.stack.runtime.mappings.forProject(IDS.beta).store.listSets()).toEqual([]);
  });
});

describe('the Overview and the Projects page', () => {
  it('Overview counts the asked project’s jobs, errors and proposals only', async () => {
    const alpha = await t.admin.get('/overview?project=alpha');
    expect(alpha.status, alpha.text).toBe(200);
    expect(alpha.json.project).toEqual({ id: IDS.alpha, name: 'alpha' });
    expect(alpha.json.pendingProposals).toBe(1);
    expect(alpha.json.projects.map((p: { name: string; status: string }) => [p.name, p.status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'active'],
    ]);
    const beta = await t.admin.get('/overview?project=beta');
    expect(beta.json.pendingProposals).toBe(0); // beta's was approved above
  });

  it('the Projects page shows both, with key presence and validity but never a key', async () => {
    const r = await t.admin.get('/projects');
    expect(r.status).toBe(200);
    expect(
      r.json.projects.map((p: Record<string, unknown>) => [p.name, p.id, p.keyPresent, p.keyValid]),
    ).toEqual([
      ['alpha', IDS.alpha, true, true],
      ['beta', IDS.beta, true, true],
    ]);
    expect(r.json.projects.map((p: { keyVariable: string }) => p.keyVariable)).toEqual([
      'LK_PROJECT_ALPHA_API_KEY',
      'LK_PROJECT_BETA_API_KEY',
    ]);
    expect(r.text).not.toContain(KEYS.alpha);
    expect(r.text).not.toContain(KEYS.beta);
  });

  it('an unknown ?project= is refused by every scoped route', async () => {
    for (const path of ['/jobs', '/errors', '/journal', '/proposals', '/budgets', '/mappings', '/overview']) {
      const r = await t.admin.get(`${path}?project=gamma`);
      expect(r.status, path).toBe(400);
      expect(r.json.error?.code ?? r.json.code, path).toBe('UNKNOWN_PROJECT');
    }
  });
});
