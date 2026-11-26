/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON results */
/**
 * set_facts and the protected canonical facts with two projects (v2 A1's rules, v2 C2a), through the REAL server, the
 * official MCP client and the dashboard's admin API: a write names its project and touches that project only; a
 * proposal, its canonical approval and the canon rules belong to their project.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetModel } from '../assets/model.js';
import { buildModels } from '../discover/world.js';
import { IDS, NAMES, startTwoProjects, type Name, type TwoProjects } from '../projects/helpers.js';
import { TreeModel } from '../tree/model.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { SidebarModel } from './world.js';

/** The project mock's own router (private there): the sidebar model answers first. */
type Route = (req: MockRequest, parts: string[]) => MockResponse | undefined;

let t: TwoProjects;
let writer: Client;
let proposer: Client;
const sidebars = {} as Record<Name, SidebarModel>;
const status = (name: Name) => sidebars[name].rows(`${name}page1`).find((r) => r.key === 'Status')!.text;

beforeAll(async () => {
  t = await startTwoProjects();
  for (const name of NAMES) {
    // The bridge's tree of each project: an AI REPOSITORY with "Shared Page" in both.
    const m = new TreeModel(() => Date.now());
    const root = m.seed({ id: `${name}root1`, name: 'AI REPOSITORY' });
    const page = m.seed({ id: `${name}page1`, name: '[BSRC] Shared Page', parentId: root.id });
    buildModels(t.stack, m, new AssetModel(() => Date.now()), IDS[name], root.id);
    // LegendKeeper's side: the page's sidebar, answered before the project's own mock model.
    const sb = new SidebarModel(() => undefined);
    sb.page(page.id, [
      SidebarModel.kv(`${name}kv001`, 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Outline'],
        ['Scope', `${name} scope`],
      ]),
    ]);
    sidebars[name] = sb;
    const lk = t.models[name] as unknown as { route: Route };
    const route: Route = lk.route.bind(lk);
    lk.route = (req, parts) =>
      sb.respond(req, (id) => {
        const r = m.live(id);
        return r ? m.resourceView(r) : undefined;
      }) ?? route(req, parts);
  }
  writer = (await t.connect('facts-two-writer', 'write')).client;
  proposer = (await t.connect('facts-two-proposer', 'propose')).client;
});
afterAll(() => t.close());

describe('set_facts with two projects', () => {
  it('refuses a write that does not name its project, before anything is read', async () => {
    const before = t.mocks.alpha.calls.length + t.mocks.beta.calls.length;
    const r = await t.call(writer, 'set_facts', { page: 'Shared Page', facts: { Scope: 'x' } });
    expect(r.body.error).toMatchObject({ code: 'PROJECT_REQUIRED' });
    expect(t.mocks.alpha.calls.length + t.mocks.beta.calls.length).toBe(before);
  });

  it('writes the named project’s page only', async () => {
    const beta = t.writesAt('beta');
    const r = await t.call(writer, 'set_facts', {
      project: 'alpha',
      page: 'Shared Page',
      facts: { Scope: 'Alpha only' },
    });
    expect(r.body, r.text).toMatchObject({
      project: 'alpha',
      status: 'written',
      verified: true,
      page: { id: 'alphapage1' },
    });
    expect(r.footer).toMatch(/^budget \(alpha\)/);
    expect(t.writesAt('beta')).toBe(beta);
    expect(sidebars.alpha.rows('alphapage1').find((x) => x.key === 'Scope')!.text).toBe('Alpha only');
    expect(sidebars.beta.rows('betapage1').find((x) => x.key === 'Scope')!.text).toBe('beta scope');
    const ja = t.stack.runtime.engine.queries.journalLookup(IDS.alpha, { jobId: r.body.jobId });
    const jb = t.stack.runtime.engine.queries.journalLookup(IDS.beta, { jobId: r.body.jobId });
    expect(ja).toHaveLength(1);
    expect(jb).toHaveLength(0);
  });

  it('a canonical proposal belongs to its project; ordinary approval is refused, accept-as-canon writes there only', async () => {
    const alpha = t.writesAt('alpha');
    const r = await t.call(proposer, 'set_facts', {
      project: 'beta',
      page: 'Shared Page',
      facts: { Status: 'Authoritative' },
    });
    expect(r.body, r.text).toMatchObject({
      project: 'beta',
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
    });
    const id = String(r.body.proposalId);
    const proposals = t.stack.runtime.policy.proposals;
    expect(proposals.list({ project: IDS.alpha }).map((p) => p.id)).not.toContain(id);
    // The dashboard, in the wrong project: not found; in its own: the ordinary Approve is refused.
    expect(
      (await t.admin.post(`/proposals/${id}/approve-as-canon?project=alpha`, { confirm: true })).status,
    ).toBe(404);
    const plain = await t.admin.post(`/proposals/${id}/approve?project=beta`);
    expect(plain.status).toBe(409);
    expect(plain.json.error.code).toBe('CANONICAL_APPROVAL_REQUIRED');
    expect((await t.admin.post(`/proposals/${id}/approve-as-canon?project=beta`, {})).status).toBe(400);
    const ok = await t.admin.post(`/proposals/${id}/approve-as-canon?project=beta`, { confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    for (let i = 0; i < 200 && proposals.get(id)!.state !== 'executed'; i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(proposals.get(id)).toMatchObject({ state: 'executed', canonicalApprovedBy: 'owner' });
    expect(status('beta')).toBe('Authoritative');
    expect(status('alpha')).toBe('Outline');
    expect(t.writesAt('alpha')).toBe(alpha);
    const audit = (await t.admin.get('/audit?limit=50')).json;
    expect(JSON.stringify(audit)).toContain('proposal.approve_as_canon');
  });

  it('the canon rules are per project, edited on the dashboard and audited', async () => {
    const before = await t.admin.get('/projects/alpha/canon');
    expect(before.json).toMatchObject({ project: 'alpha', defaults: true, agentDefaultStatus: 'Working' });
    expect(before.json.rules.map((r: { key: string }) => r.key)).toEqual([
      'Status',
      'Continuity Type',
      'Continuity',
      'Status', // v2 C2b: deleting an Authoritative page
      undefined, // v2 C2c: deleting a [BARC] page (by its prefix; no fact)
      'Status', // v2 C2c: deleting a map, timeline or board of an Authoritative page
      undefined, // C2d: the status tags (ADR 0036 decision 7; no fact)
    ]);
    // C2d (ADR 0036 decision 4): saving the rules needs the owner's step-up within the last 10 minutes (ADR 0062).
    t.stack.db.prepare('UPDATE auth_owner_sessions SET reauth_at = NULL').run(); // signed in, not stepped up
    const before403 = await t.admin.put('/projects/alpha/canon', { rules: null, confirm: true });
    expect(before403.status).toBe(403);
    expect(before403.json.error.code).toBe('REAUTH_REQUIRED');
    expect((await t.admin.post('/security/reauth', { password: t.stack.bridge.password })).status).toBe(200);
    const bad = await t.admin.put('/projects/alpha/canon', {
      rules: [{ id: 'x', key: 'Status', kind: 'value' }],
      confirm: true,
    });
    expect(bad.status).toBe(400);
    const put = await t.admin.put('/projects/alpha/canon', {
      rules: [{ id: 'scope', key: 'Scope', kind: 'change' }],
      agentDefaultStatus: 'Draft',
      confirm: true,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({ defaults: false, agentDefaultStatus: 'Draft' });
    // Alpha: Status is no longer protected, Scope is. Beta keeps the defaults. v3 F12 (ADR 0081): the rules decide what
    // is a CANONICAL proposal at scope propose (at scope write both changes would be direct).
    const a1 = await t.call(proposer, 'set_facts', {
      project: 'alpha',
      page: 'Shared Page',
      facts: { Status: 'Authoritative' },
    });
    expect(a1.body, a1.text).toMatchObject({ status: 'proposal_captured' });
    expect(a1.body.requiresCanonicalApproval).toBeFalsy();
    const a2 = await t.call(proposer, 'set_facts', {
      project: 'alpha',
      page: 'Shared Page',
      facts: { Scope: 'Changed' },
    });
    expect(a2.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    const b1 = await t.call(proposer, 'set_facts', {
      project: 'beta',
      page: 'Shared Page',
      facts: { Status: 'Outline' },
    });
    expect(b1.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    const audit = (await t.admin.get('/audit?limit=50')).json;
    expect(JSON.stringify(audit)).toContain('project.set_canonical_rules');
    const back = await t.admin.put('/projects/alpha/canon', { rules: null, confirm: true });
    expect(back.json).toMatchObject({ defaults: true });
  });
});
