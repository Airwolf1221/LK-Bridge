/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F5c (ADR 0069, H6): `arkona_identity_reconcile` end to end, against the mock LegendKeeper and the Menkheti world
 * (test/packs/identity-world.ts, never fetched): the dry run's preview and the run that matches it; an unmapped culture,
 * a Canonical Display Name and a protected fact each refusing only their item; a hold-type tag result writing the facts
 * and holding the tags; grammar order with a supplementary tag kept; an [INDEX] resolving to its Core and a Compact
 * Reference; Last Major Revision set by the owner's rule; a consistency follow-up; no write outside the sidebar and tags.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BULK, M, PROJECT, bulkName, identityWorld, pageNow, type IdentityWorld } from './identity-world.js';
import { londonDate } from '../../src/jobs/internal-steps.js';

vi.setConfig({ testTimeout: 180_000 });

let w: IdentityWorld;
beforeAll(async () => {
  w = await identityWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const MENKHETI_SPLIT = [
  { character: 'Al-Mansur XII', facts: { 'Naming Culture': 'Ancient Menkheti' } },
  { character: 'Arin al-Jamail', facts: { 'Naming Culture': 'Orzheni' } },
  { character: 'Azar al-Nafir', facts: { 'Naming Culture': 'Khayali' } },
  { character: 'Zahira al-Rachid', facts: { 'Naming Culture': 'Khayali' } },
  { character: '[INDEX] Daryan Sefet', facts: { 'Naming Culture': 'Orzheni' } },
  { character: 'Khepri Nadu', facts: { 'naming culture': 'Ancient Menkhet' } },
  { character: 'Arin al-Jamail', facts: { 'Canonical Display Name': 'Arin al-Jamail of Orzh' } },
  { character: 'Khepri Nadu', facts: { Status: 'Working' } },
];

const byChar = (items: any[]) =>
  new Map<string, any>(items.map((i) => [`${i.character}|${i.item ?? ''}`, i]));
const find = (items: any[], name: string, n = 0) => items.filter((i) => i.character === name)[n];

describe('the Menkheti split', () => {
  let preview: any;

  it('dry run: the full itemised preview, nothing written', async () => {
    const before = w.requests();
    const r = await w.call('arkona_identity_reconcile', {
      project: 'test',
      items: MENKHETI_SPLIT,
      dryRun: true,
      workstream: 'Menkheti culture split',
    });
    expect(r.isError, r.text).toBe(false);
    preview = r.body;
    expect(w.requests().writes).toBe(before.writes);
    expect(r.body).toMatchObject({
      status: 'dry_run',
      workstream: 'Menkheti culture split',
      reconcileTags: true,
    });
    const items = r.body.items as any[];
    void byChar;
    expect(find(items, 'Al-Mansur XII')).toMatchObject({
      status: 'planned',
      page: { id: M.mansur },
      facts: [{ key: 'Naming Culture', before: 'Menkheti', after: 'Ancient Menkheti', change: 'changed' }],
      tags: {
        status: 'write',
        current: ['CANON', 'Character', 'Human', 'Menkheti'],
        proposed: ['CANON', 'Character', 'Human', 'Ancient Menkheti'],
      },
    });
    expect(find(items, 'Al-Mansur XII').nameCheck).toMatchObject({ value: 'Ancient Menkheti', mapped: true });
    // Grammar order, the supplementary tag kept after the grammar's slots.
    expect(find(items, 'Azar al-Nafir').tags).toMatchObject({
      status: 'write',
      proposed: ['CANON', 'Character', 'Genie', 'Khayali', 'Cosmology'],
    });
    // A race with no token: the tags are a hold, the facts still planned.
    expect(find(items, 'Zahira al-Rachid')).toMatchObject({ status: 'planned', tags: { status: 'held' } });
    expect(find(items, 'Zahira al-Rachid').tags.reason).toMatch(/Shadeborn/);
    // An [INDEX] resolves to its Core; a Compact Reference is the identity page.
    expect(find(items, 'Daryan Sefet').page).toMatchObject({ id: M.daryan, role: 'Character Core' });
    // Refusals, each for its item only.
    expect(find(items, 'Khepri Nadu', 0)).toMatchObject({
      status: 'refused',
      page: { id: M.khepri, role: 'Compact Character Reference' },
      refusal: { code: 'UNMAPPED_VALUE' },
    });
    expect(find(items, 'Arin al-Jamail', 1)).toMatchObject({
      status: 'refused',
      refusal: { code: 'USE_ARKONA_RENAME' },
    });
    expect(find(items, 'Khepri Nadu', 1)).toMatchObject({
      status: 'refused',
      refusal: { code: 'PROTECTED_FACT' },
    });
    expect(r.body.counts).toMatchObject({ items: 8, planned: 5, refused: 3, tagsWritten: 4, tagsHeld: 1 });
  });

  it('the run matches the preview; each item done and verified, the hold partly done; a consistency follow-up', async () => {
    const before = w.stack.mock.calls.length;
    const r = await w.call('arkona_identity_reconcile', {
      project: 'test',
      items: MENKHETI_SPLIT,
      workstream: 'Menkheti culture split',
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ status: 'finished', workstream: 'Menkheti culture split' });
    const items = r.body.items as any[];
    for (const name of ['Al-Mansur XII', 'Arin al-Jamail', 'Azar al-Nafir', 'Daryan Sefet'])
      expect(find(items, name), name).toMatchObject({
        status: 'done',
        facts: { written: true, verified: true },
        tags: { status: 'written', verified: true },
      });
    expect(find(items, 'Zahira al-Rachid')).toMatchObject({
      status: 'partly_done',
      facts: { written: true, verified: true },
      tags: { status: 'held' },
    });
    expect(items.filter((i) => i.status === 'refused')).toHaveLength(3);
    // The run did what the preview said.
    for (const p of preview.items.filter((x: any) => x.tags?.status === 'write')) {
      expect(pageNow(w, p.page.id).tags, p.character).toEqual(p.tags.proposed);
      expect(pageNow(w, p.page.id).rows['Naming Culture']).toBe(p.facts[0].after);
    }
    expect(pageNow(w, M.zahira).tags).toEqual(['CANON', 'Character', 'Menkheti']);
    expect(pageNow(w, M.zahira).rows['Naming Culture']).toBe('Khayali');
    expect(pageNow(w, M.khepri).rows['Naming Culture']).toBe('Menkheti');
    // Last Major Revision, by the owner's rule (a real fact change).
    expect(pageNow(w, M.mansur).rows['Last Major Revision']).toBe(londonDate(Date.now()));
    // No write outside the identity pages' sidebars and tags.
    const writes = w.stack.mock.calls.slice(before).filter((c) => c.method !== 'GET');
    for (const c of writes)
      expect(c.path, c.path).toMatch(
        /\/resources\/(mkmansur|mkarin01|mkazar01|mkzahira|mkdaryan)(\/properties\/[^/]+\/rows(\/[^/]+)?)?\/?$/,
      );
    const journal = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
      jobId: r.body.jobId,
      limit: 100,
    }) as any[];
    expect(journal.length).toBeGreaterThan(0);
    for (const j of journal) {
      expect(['updatePropertyRow', 'createPropertyRow', 'updateResource'], j.opId).toContain(j.opId);
      if (j.opId === 'updateResource') expect(Object.keys(j.params?.body ?? {})).toEqual(['tags']);
    }
    // The consistency follow-up: the Biography still says Menkheti.
    const mansur = find(items, 'Al-Mansur XII');
    expect(mansur.followUps?.length, JSON.stringify(mansur)).toBeGreaterThan(0);
    expect(JSON.stringify(mansur.followUps)).toMatch(/Menkheti/);
    // The record can be read back, free.
    const again = await w.call('arkona_identity_reconcile', { project: 'test', report: r.body.reconcileId });
    expect(again.body).toMatchObject({ reconcileId: r.body.reconcileId, state: 'finished', cost: 'none' });
  });
});

describe('the approval boundaries and isolation', () => {
  const bulk = (n: number, from = 0, culture = 'Orzheni') =>
    Array.from({ length: n }, (_, i) => ({
      character: bulkName(from + i),
      facts: { 'Naming Culture': culture },
    }));

  it('at scope write with the default rails: 10 pages run directly, 11 become ONE proposal with an item each', async () => {
    const t = w.stack.newToken('identity-agent', 'write');
    const agent = await w.stack.connect(t.token);
    const ten = await w.stack.call(agent, 'arkona_identity_reconcile', { project: 'test', items: bulk(10) });
    expect(ten.isError, ten.text).toBe(false);
    expect(ten.body.status).toBe('finished');
    expect((ten.body.items as any[]).every((i) => i.status === 'done')).toBe(true);
    const eleven = await w.stack.call(agent, 'arkona_identity_reconcile', {
      project: 'test',
      items: bulk(11, 0, 'Khayali'),
      workstream: 'bulk rail',
    });
    expect(eleven.isError, eleven.text).toBe(false);
    expect(eleven.body.status).toBe('proposal_captured');
    expect(eleven.body.proposedBecause).toMatch(/bulk change \(11 pages > 10\)/);
    const p = w.stack.runtime.policy.proposals.get(eleven.body.proposalId)!;
    expect(p.items?.total).toBe(11);
    expect(p.workstream).toBe('bulk rail');
    for (const id of BULK.slice(0, 11)) expect(pageNow(w, id).rows['Naming Culture']).not.toBe('Khayali');

    // Partial approval: the owner approves three characters.
    const detail = w.stack.runtime.policy.proposals.detail(eleven.body.proposalId) as any;
    const keep = (detail.itemPlan?.items ?? detail.items ?? []).slice(0, 3).map((i: any) => i.id);
    expect(keep).toHaveLength(3);
    await w.stack.runtime.policy.commands.approve('owner', eleven.body.proposalId, { items: keep });
    const done = await approveWait(eleven.body.proposalId);
    expect(done.state).toBe('executed');
    expect(
      BULK.slice(0, 11).filter((id) => pageNow(w, id).rows['Naming Culture'] === 'Khayali'),
    ).toHaveLength(3);
    const report = await w.stack.call(agent, 'arkona_identity_reconcile', {
      project: 'test',
      report: eleven.body.reconcileId,
    });
    const items = report.body.items as any[];
    expect(items.filter((i) => i.status === 'done')).toHaveLength(3);
    expect(items.filter((i) => i.status === 'excluded')).toHaveLength(8);
  });

  it('a stale factsVersion conflicts only its item (a proposal approved after one character changed)', async () => {
    const t = w.stack.newToken('identity-proposer', 'propose');
    const agent = await w.stack.connect(t.token);
    const r = await w.stack.call(agent, 'arkona_identity_reconcile', {
      project: 'test',
      items: [
        { character: 'Arin al-Jamail', facts: { 'Life State': 'Deceased' } },
        { character: 'Daryan Sefet', facts: { 'Life State': 'Deceased' } },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.repo.outside.setRow(M.arin, 'Temporal Scope', '5A 900'); // an edit in the app meanwhile
    await w.stack.runtime.policy.commands.approve('owner', r.body.proposalId);
    const done = await approveWait(r.body.proposalId);
    expect(done.state).toBe('executed');
    const report = await w.call('arkona_identity_reconcile', { project: 'test', report: r.body.reconcileId });
    const items = report.body.items as any[];
    expect(find(items, 'Arin al-Jamail')).toMatchObject({ status: 'skipped' });
    expect(find(items, 'Arin al-Jamail').reason).toMatch(/FACTS_STALE/);
    expect(find(items, 'Daryan Sefet')).toMatchObject({ status: 'done' });
    expect(pageNow(w, M.arin).rows['Life State']).toBe('Alive');
    expect(pageNow(w, M.daryan).rows['Life State']).toBe('Deceased');
  });

  it('a failed write fails only its item; the job resumes and finishes it, nothing written twice', async () => {
    w.failNext('PATCH', /\/resources\/mkkhepri\/properties\/[^/]+\/rows\/[^/]+$/);
    const r = await w.call('arkona_identity_reconcile', {
      project: 'test',
      items: [
        { character: 'Khepri Nadu', facts: { 'Life State': 'Missing' } },
        { character: 'Azar al-Nafir', facts: { 'Life State': 'Bound' } },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ status: 'finished', jobStatus: 'failed' });
    const items = r.body.items as any[];
    expect(find(items, 'Khepri Nadu')).toMatchObject({ status: 'failed' });
    expect(find(items, 'Azar al-Nafir')).toMatchObject({ status: 'done' });
    expect(pageNow(w, M.azar).rows['Life State']).toBe('Bound');
    expect(pageNow(w, M.khepri).rows['Life State']).toBe('Alive');
    const writesBefore = w.requests().writes;
    const res = await w.call('bridge_job_resume', { project: 'test', jobId: r.body.jobId });
    expect(res.isError, res.text).toBe(false);
    for (let i = 0; i < 300; i++) {
      const j = w.stack.runtime.engine.queries.getJob(PROJECT, r.body.jobId)!;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
      await new Promise((x) => setTimeout(x, 20));
    }
    const after = await w.call('arkona_identity_reconcile', { project: 'test', report: r.body.reconcileId });
    const again = after.body.items as any[];
    expect(find(again, 'Khepri Nadu')).toMatchObject({ status: 'done' });
    expect(find(again, 'Azar al-Nafir')).toMatchObject({ status: 'done' });
    expect(pageNow(w, M.khepri).rows['Life State']).toBe('Missing');
    // Only Khepri's write (and its Last Major Revision, if the page had the row) was sent again: Azar's never.
    const resumed = w.stack.mock.calls.filter((c) => c.method !== 'GET').slice(writesBefore);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((c) => c.path.includes('mkkhepri'))).toBe(true);
  });
});

async function approveWait(id: string): Promise<{ state: string }> {
  for (let i = 0; i < 500; i++) {
    const p = w.stack.runtime.policy.proposals.get(id)!;
    if (['executed', 'failed', 'conflicted'].includes(p.state)) {
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        if (job) await w.stack.runtime.identity.conclude(PROJECT, job.id);
        return { state: p.state };
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not finish');
}
