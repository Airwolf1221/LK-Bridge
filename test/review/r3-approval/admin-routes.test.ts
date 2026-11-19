/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies */
/**
 * CR-2026-11 round 3 (approval): "Approve selected", "Propose these again" and Resume through the dashboard's admin API
 * (src/admin/routes/policy.ts, src/admin/routes/jobs.ts), against the admin stack's mock LegendKeeper. The attempts: an
 * agent's personal access token as a bearer; the owner's session without its CSRF token; a selection with unknown,
 * duplicated or foreign item ids, an empty selection, a selection on a proposal not made of items, a selection through
 * the canonical route of an ordinary proposal. The safe behaviour: refused, and the proposal stays pending; a
 * duplicated id approves that item once and nothing else.
 *
 * Modelled: the itemized proposal is captured through the engine as a bridge tool captures one (`internal`,
 * `forceProposal`, `proposal.items`, each step naming its item), with two independent creates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PatService } from '../../../src/auth/pats.js';
import { AuthStore } from '../../../src/auth/store.js';
import { PROJECT, startAdminStack, type AdminStack } from '../../admin/helpers.js';

let s: AdminStack;
let pat: string;
beforeAll(async () => {
  s = await startAdminStack();
  await s.runtime.ready;
  const profile = s.policy.commands.createProfile('owner', {
    label: 'r3-admin-agent',
    kind: 'other',
    scope: 'write',
  });
  pat = new PatService({
    store: new AuthStore(s.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  }).create({ name: 'r3 admin agent', profileId: profile.id }).token;
});
afterAll(async () => {
  await s?.close();
});

const item = (id: string) => ({
  id,
  kind: 'new_page',
  group: 'New pages',
  label: `New page ${id}`,
  dependsOn: [],
  selected: true,
});

/** A pending proposal of two independent creates, items `a` and `b` (or none: not itemized). */
async function itemized(tag: string, items = true): Promise<string> {
  const r = (await s.runtime.engine.submit({
    project: PROJECT,
    kind: 'batch_ops',
    title: `r3 ${tag}`,
    origin: { kind: 'ui', client: 'r3', tool: 'r3_package' },
    onError: 'stop',
    internal: true,
    forceProposal: true,
    steps: [
      {
        op: 'createResource',
        params: { body: { name: `${tag} A` } },
        ...(items ? { items: [`${tag}:a`] } : {}),
      },
      {
        op: 'createResource',
        params: { body: { name: `${tag} B` } },
        ...(items ? { items: [`${tag}:b`] } : {}),
      },
    ],
    proposal: {
      summary: `r3 ${tag}`,
      ...(items ? { items: [item(`${tag}:a`), item(`${tag}:b`)] } : {}),
    },
  } as never)) as { proposalId?: string; jobId?: string };
  expect(r.proposalId, JSON.stringify(r)).toBeTruthy();
  return r.proposalId!;
}

const state = (id: string) => s.runtime.policy.proposals.get(id)!.state;
/** The names the approved job of a proposal creates (its steps as they ran). */
const created = (id: string): string[] => {
  const jobId = s.runtime.policy.proposals.get(id)!.jobId!;
  return s.runtime.engine.queries
    .getJob(PROJECT, jobId)!
    .steps.filter((st) => st.opId === 'createResource' && st.status === 'succeeded')
    .map((st) => String((st.params as { body?: { name?: unknown } }).body?.name));
};

describe('the dashboard’s approval routes', () => {
  it('AP-40 an agent’s bearer token approves, selects, reproposes and resumes nothing', async () => {
    const id = await itemized('ap40');
    const asAgent = { cookie: null, csrf: null, authorization: `Bearer ${pat}` } as const;
    const r1 = await s.call('POST', `/api/admin/proposals/${id}/approve`, {
      ...asAgent,
      body: { items: ['ap40:a'] },
    });
    const r2 = await s.call('POST', `/api/admin/proposals/${id}/approve`, { ...asAgent, body: {} });
    const r3 = await s.call('POST', `/api/admin/proposals/${id}/approve-as-canon`, {
      ...asAgent,
      body: { items: ['ap40:a'], confirm: true },
    });
    const r4 = await s.call('POST', `/api/admin/proposals/${id}/repropose`, {
      ...asAgent,
      body: { confirm: true },
    });
    const r5 = await s.call('POST', '/api/admin/jobs/j_nope/resume-stopped', {
      ...asAgent,
      body: { confirm: true },
    });
    const r6 = await s.call('POST', '/api/admin/proposals/bulk', {
      ...asAgent,
      body: { action: 'approve', ids: [id] },
    });
    expect([r1, r2, r3, r4, r5, r6].map((r) => r.status >= 400 && r.status < 500)).toEqual(
      Array(6).fill(true),
    );
    expect(state(id)).toBe('pending');
  });

  it('AP-41 the owner’s session without its CSRF token, or from another origin, approves nothing', async () => {
    const id = await itemized('ap41');
    const noCsrf = await s.post(`/api/admin/proposals/${id}/approve`, { items: ['ap41:a'] }, { csrf: null });
    const cross = await s.post(
      `/api/admin/proposals/${id}/approve`,
      { items: ['ap41:a'] },
      { origin: 'https://evil.example', headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect([noCsrf.status, cross.status].every((x) => x === 403 || x === 401)).toBe(true);
    expect(state(id)).toBe('pending');
  });

  it('AP-42 unknown, foreign or empty selections are refused and nothing is approved', async () => {
    const id = await itemized('ap42');
    const other = await itemized('ap42x');
    const unknown = await s.post(`/api/admin/proposals/${id}/approve`, { items: ['ap42:a', 'ap42:zzz'] });
    const foreign = await s.post(`/api/admin/proposals/${id}/approve`, { items: ['ap42x:a'] });
    const empty = await s.post(`/api/admin/proposals/${id}/approve`, { items: [] });
    const blank = await s.post(`/api/admin/proposals/${id}/approve`, { items: [''] });
    expect(unknown.json?.error?.code ?? unknown.status, unknown.text).toBe('UNKNOWN_ITEMS');
    expect(foreign.json?.error?.code ?? foreign.status, foreign.text).toBe('UNKNOWN_ITEMS');
    expect(empty.status).toBe(400);
    expect(blank.status).toBe(400);
    expect([state(id), state(other)]).toEqual(['pending', 'pending']);
  });

  it('AP-43 a selection on a proposal not made of items, or via the canonical route', async () => {
    const plain = await itemized('ap43p', false);
    const id = await itemized('ap43');
    const r1 = await s.post(`/api/admin/proposals/${plain}/approve`, { items: ['ap43p:a'] });
    const r2 = await s.post(`/api/admin/proposals/${id}/approve-as-canon`, {
      items: ['ap43:a'],
      confirm: true,
    });
    expect(r1.json?.error?.code, r1.text).toBe('NOT_ITEMIZED');
    expect(r2.json?.error?.code, r2.text).toBe('NOT_CANONICAL');
    expect([state(plain), state(id)]).toEqual(['pending', 'pending']);
  });

  it('AP-44 a duplicated id approves that item once, and the item left out is never created', async () => {
    const id = await itemized('ap44');
    const r = await s.post(`/api/admin/proposals/${id}/approve`, { items: ['ap44:a', 'ap44:a', 'ap44:a'] });
    expect(r.status, r.text).toBe(200);
    for (let i = 0; i < 300 && !['executed', 'failed'].includes(state(id)); i++)
      await new Promise((x) => setTimeout(x, 20));
    expect(state(id)).toBe('executed');
    expect(s.runtime.policy.proposals.itemsOf(id)).toMatchObject({
      approved: ['ap44:a'],
      omitted: ['ap44:b'],
    });
    expect(created(id)).toEqual(['ap44 A']);
  });
  it('AP-45 two approvals at once, different selections: one wins and runs what it recorded', async () => {
    const id = await itemized('ap45');
    const [x, y] = await Promise.all([
      s.post(`/api/admin/proposals/${id}/approve`, { items: ['ap45:a'] }),
      s.post(`/api/admin/proposals/${id}/approve`, { items: ['ap45:b'] }),
    ]);
    expect([x.status, y.status].filter((st) => st === 200)).toHaveLength(1);
    for (let i = 0; i < 300 && !['executed', 'failed'].includes(state(id)); i++)
      await new Promise((r) => setTimeout(r, 20));
    const rec = s.runtime.policy.proposals.itemsOf(id)!;
    expect(rec.approved).toHaveLength(1);
    expect(created(id)).toEqual([rec.approved![0] === 'ap45:a' ? 'ap45 A' : 'ap45 B']);
  });
});
