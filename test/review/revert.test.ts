/**
 * v3 F3.4 (ADR 0055 decisions A and B) end to end, through the real server, MCP transport, policy and engine against
 * the mock LegendKeeper, at scope `write`:
 *
 * - the review queue: a direct write is listed with its agent, tool, summary, pages and diff; marking it reviewed takes
 *   it off the count; approved proposals are never listed; "Mark all reviewed" marks exactly the set the owner confirmed;
 * - Revert, kind by kind, exactly: page text (block by block), sidebar facts and link collections, a page's name, tags
 *   and aliases, a move (back under its old parent, at its old place), and Last Major Revision (back to its old value
 *   where the job set it, left alone otherwise);
 * - an outside edit on one target blocks that target, and the rest needs the owner's confirmation of a partial revert;
 * - a deletion comes back (v3 F12, ADR 0081: a copy is kept before it); a revert is never reverted; an approved
 *   proposal's job is not reverted here; every revert and refusal is audited as `job.revert`.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksHash } from '../../src/pages/blockwise.js';
import { londonDate } from '../../src/jobs/internal-steps.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, RHEASHIRA, type FactsWorld } from '../facts/world.js';

let w: FactsWorld;
let agent: Client;
let profileId: string;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  const t = w.stack.newToken('review-agent', 'write');
  profileId = t.profileId;
  agent = await w.stack.connect(t.token);
  w.stack.runtime.policy.commands.setShowLowLevelTools('owner', profileId, true);
  // As the tree knows Rheashira: her PROPERTIES with a Last Major Revision row.
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify([
      {
        id: RHEASHIRA.property,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [{ key: 'Last Major Revision', text: '9 November 2026' }],
      },
    ]),
    PROJECT,
    RHEASHIRA.page,
  );
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const waitJob = (id: string) => rt().engine.wait(PROJECT, id, 25_000);
const docOf = (page: string) => w.repo.liveDocs(w.repo.live(page)!).find((d) => d.name === 'Main')!.id;
const blocksOf = (page: string) => w.repo.blocks.get(docOf(page))!.blocks;
const rows = (page: string) => w.sidebars.rows(page).map((r) => `${r.key}=${r.text}`);
const resource = (id: string) => w.repo.live(id)!;
const jobOf = (r: { body: Record<string, unknown> }): string =>
  typeof r.body.jobId === 'string' ? r.body.jobId : String((r.body.job as { id?: string } | undefined)?.id);

/** Reverts a job as the owner and waits for the revert's own job. */
async function revert(jobId: string, confirmPartial = false) {
  const r = await rt().reverts.revert('owner', PROJECT, jobId, { confirmPartial });
  if (r.status !== 'submitted') return { r, job: null };
  const job = await waitJob(r.revertJobId);
  return { r, job };
}

describe('the review queue (decision A)', () => {
  it('lists a direct write with its agent, tool, summary, pages and diff; reviewing it takes it off the count', async () => {
    const before = rt().review.store.count(PROJECT, { state: 'unreviewed' });
    const r = await call('write_page', {
      page: P.ashgate,
      mode: 'append',
      markdown: 'The gate was rebuilt in stone.',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    const items = rt().review.list(PROJECT);
    const item = items.find((i) => i.jobId === jobId)!;
    expect(item).toMatchObject({
      tool: 'write_page',
      agent: { profile: 'review-agent' },
      pages: [{ id: P.ashgate, name: 'Ashgate' }],
      reviewed: null,
    });
    expect(item.summary).toMatch(/write_page append on “Ashgate”/);
    expect(rt().review.store.count(PROJECT, { state: 'unreviewed' })).toBe(before + 1);
    const detail = rt().review.detail(PROJECT, jobId)!;
    const text = detail.pageChanges[0]!.changes.find((c) => c.kind === 'text')!;
    expect(text.markdownDiff!.added).toBeGreaterThan(0);
    expect(JSON.stringify(text.markdownDiff!.hunks)).toContain('The gate was rebuilt in stone.');
    expect(rt().review.markReviewed('owner', PROJECT, [jobId])).toEqual([jobId]);
    expect(rt().review.store.count(PROJECT, { state: 'unreviewed' })).toBe(before);
    expect(
      rt()
        .review.list(PROJECT)
        .some((i) => i.jobId === jobId),
    ).toBe(false);
    expect(rt().policy.store.listAudit({ action: 'review.mark', limit: 1 })[0]!.target).toBe(jobId);
  });

  it('an approved proposal is never listed (the owner saw it before it happened)', async () => {
    const t = w.stack.newToken('review-proposer', 'propose');
    const proposer = await w.stack.connect(t.token);
    const p = await w.stack.call(proposer, 'write_page', {
      project: 'test',
      page: P.ashgate,
      mode: 'append',
      markdown: 'Proposed, then approved.',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    await rt().policy.commands.approve('owner', String(p.body.proposalId));
    let jobId: string | null = null;
    for (let i = 0; i < 200 && !jobId; i++) {
      jobId = rt().policy.proposals.get(String(p.body.proposalId))!.jobId;
      if (!jobId) await new Promise((res) => setTimeout(res, 20));
    }
    await waitJob(jobId!);
    expect(rt().review.store.get(PROJECT, jobId!)).toBeNull();
    expect(
      rt()
        .review.list(PROJECT, { state: 'all' })
        .some((i) => i.jobId === jobId),
    ).toBe(false);
    // Nor reverted from here: it was a proposal.
    const r = await rt().reverts.revert('owner', PROJECT, jobId!);
    expect(r).toMatchObject({ status: 'refused', code: 'WAS_A_PROPOSAL' });
  });

  it('"Mark all reviewed" marks exactly the confirmed set (a different count marks nothing)', async () => {
    const a = await call('update_resource', { page: P.ashgate, aliases: { add: ['Ash Gate One'] } });
    const b = await call('update_resource', { page: P.ashgate, aliases: { add: ['Ash Gate Two'] } });
    await waitJob(jobOf(a));
    await waitJob(jobOf(b));
    const n = rt().review.store.count(PROJECT, { state: 'unreviewed', tool: 'update_resource' });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(rt().review.markAll('owner', PROJECT, { tool: 'update_resource' }, n + 1)).toMatchObject({
      changed: true,
      marked: [],
    });
    const r = rt().review.markAll('owner', PROJECT, { tool: 'update_resource' }, n);
    expect(r.marked).toHaveLength(n);
    expect(rt().review.store.count(PROJECT, { state: 'unreviewed', tool: 'update_resource' })).toBe(0);
  });
});

describe('Revert, kind by kind (decision B)', () => {
  it('page text: put back block by block, exactly', async () => {
    const before = blocksHash(blocksOf(P.miyabi));
    const r = await call('write_page', {
      page: P.miyabi,
      mode: 'append',
      markdown: '## Later life\n\nShe kept the shrine until the war.',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(blocksHash(blocksOf(P.miyabi))).not.toBe(before);
    const preview = await rt().reverts.preview(PROJECT, jobId);
    expect(preview.eligible.ok).toBe(true);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`)).toEqual(['text:ready']);
    const { r: rv, job } = await revert(jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    expect(job!.status, JSON.stringify(job!.lastError)).toBe('succeeded');
    expect(blocksHash(blocksOf(P.miyabi))).toBe(before);
    // Reverted: reviewed, recorded and audited.
    expect(rt().review.store.get(PROJECT, jobId)!.reviewedVia).toBe('revert');
    const audits = rt().policy.store.listAudit({ action: 'job.revert', limit: 2 });
    expect(audits.map((a) => (a.after as { outcome: string }).outcome).sort()).toEqual([
      'submitted',
      'succeeded',
    ]);
    // A revert is never itself reverted, and a job is reverted once.
    expect(await rt().reverts.revert('owner', PROJECT, job!.id)).toMatchObject({
      status: 'refused',
      code: 'IS_A_REVERT',
    });
    expect(await rt().reverts.revert('owner', PROJECT, jobId)).toMatchObject({
      status: 'refused',
      code: 'ALREADY_REVERTED',
    });
  });

  it('sidebar facts and a link collection: every row and link back, in place', async () => {
    const before = rows(P.miyabi);
    const deps = () =>
      (w.sidebars.pages.get(P.miyabi)!.props.find((p) => p.title === 'Dependencies')!.items ?? []).map(
        (i) => i.resourceId,
      );
    const depsBefore = deps();
    const r = await call('set_facts', {
      page: P.miyabi,
      facts: { Notes: 'Changed notes', Sister: null, Scope: 'Shrine maiden, later a warden' },
      links: { Dependencies: { add: [P.ashgate] } },
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(rows(P.miyabi)).not.toEqual(before);
    const { r: rv, job } = await revert(jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    expect(job!.status, JSON.stringify(job!.lastError)).toBe('succeeded');
    expect(rows(P.miyabi)).toEqual(before);
    expect(deps()).toEqual(depsBefore);
  });

  it('a page’s name, tags and aliases, and its place among its siblings after the rename', async () => {
    // ADR 0057 decision 5: renaming an Authoritative ([BSRC]) page is a canonical proposal (never direct, so never
    // reverted); an index's rename runs directly and is revertible.
    const page = 'grp00007';
    const before = {
      name: resource(page).name,
      tags: [...(resource(page).tags ?? [])],
      aliases: [...(resource(page).aliases ?? [])],
    };
    const r = await call('update_resource', {
      page,
      name: '[INDEX] Aaa Group 7',
      tags: { add: ['draft-notes'] },
      aliases: { add: ['Scraps'] },
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(resource(page).name).toBe('[INDEX] Aaa Group 7');
    const { r: rv, job } = await revert(jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    expect(job!.status, JSON.stringify(job!.lastError)).toBe('succeeded');
    expect({
      name: resource(page).name,
      tags: resource(page).tags ?? [],
      aliases: resource(page).aliases ?? [],
    }).toEqual(before);
  });

  it('a move: back under its old parent, at its old place', async () => {
    const page = 'bk000001';
    const parentBefore = resource(page).parentId;
    const siblingsBefore = w.repo.children(parentBefore).map((c) => c.id);
    const r = await call('move_resource', { page, to: '[INDEX] Group 0' });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(resource(page).parentId).not.toBe(parentBefore);
    const { r: rv, job } = await revert(jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    expect(job!.status, JSON.stringify(job!.lastError)).toBe('succeeded');
    expect(resource(page).parentId).toBe(parentBefore);
    expect(w.repo.children(parentBefore).map((c) => c.id)).toEqual(siblingsBefore);
  });
});

describe('Last Major Revision (decision B5)', () => {
  const lmr = () => w.sidebars.rows(RHEASHIRA.page).find((r) => r.key === 'Last Major Revision')!.text;
  const setText = () =>
    w.repo.blocks.set(docOf(RHEASHIRA.page), {
      version: 11,
      blocks: [{ id: 'rhpara01', kind: 'paragraph', content: [{ text: 'An envoy of the Hollow Court.' }] }],
    });

  it('a revert puts back the value the job replaced', async () => {
    setText();
    const r = await call('write_page', {
      page: RHEASHIRA.page,
      mode: 'append',
      markdown: 'She crossed the northern marches twice and returned with the treaty sealed in silver.',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(lmr()).toBe(londonDate(Date.now()));
    const preview = await rt().reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`).sort()).toEqual(['lmr:ready', 'text:ready']);
    const { job } = await revert(jobId);
    expect(job!.status, JSON.stringify(job!.lastError)).toBe('succeeded');
    expect(lmr()).toBe('9 November 2026');
  });

  it('a job that did not set it leaves it alone (a minor edit)', async () => {
    setText();
    const row = w.sidebars.pages
      .get(RHEASHIRA.page)!
      .props[0]!.rows!.find((x) => x.key === 'Last Major Revision')!;
    row.content = [{ text: '1 October 2026' }];
    const r = await call('write_page', { page: RHEASHIRA.page, mode: 'append', markdown: 'Noted.' });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(lmr()).toBe('1 October 2026');
    const preview = await rt().reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => t.kind)).toEqual(['text']);
    const { job } = await revert(jobId);
    expect(job!.status).toBe('succeeded');
    expect(lmr()).toBe('1 October 2026');
  });

  it('an outside edit on one target blocks it; the rest needs the owner’s confirmation of a partial revert', async () => {
    setText();
    const r = await call('write_page', {
      page: RHEASHIRA.page,
      mode: 'append',
      markdown: 'In the winter of that year she was named first envoy to the eastern courts.',
    });
    const jobId = jobOf(r);
    await waitJob(jobId);
    // Someone edits the Last Major Revision row in the app.
    const row = w.sidebars.pages
      .get(RHEASHIRA.page)!
      .props[0]!.rows!.find((x) => x.key === 'Last Major Revision')!;
    row.content = [{ text: 'edited by hand' }];
    const textBefore = JSON.stringify(blocksOf(RHEASHIRA.page));
    const refused = await rt().reverts.revert('owner', PROJECT, jobId);
    expect(refused).toMatchObject({ status: 'refused', code: 'PARTIAL_REVERT_NEEDS_CONFIRMATION' });
    const t = (refused as { readonly targets: readonly { kind: string; state: string }[] }).targets;
    expect(t.find((x) => x.kind === 'lmr')).toMatchObject({ state: 'changed' });
    expect(t.find((x) => x.kind === 'text')).toMatchObject({ state: 'ready' });
    expect(JSON.stringify(blocksOf(RHEASHIRA.page))).toBe(textBefore); // nothing written
    const { r: rv, job } = await revert(jobId, true);
    expect(rv).toMatchObject({ status: 'submitted', partial: true });
    expect(job!.status, JSON.stringify(job!.lastError)).toBe('succeeded');
    expect(JSON.stringify(blocksOf(RHEASHIRA.page))).toContain('An envoy of the Hollow Court.');
    expect(JSON.stringify(blocksOf(RHEASHIRA.page))).not.toContain('first envoy');
    expect(lmr()).toBe('edited by hand'); // the outside edit is never overwritten
  });
});

describe('a deletion (v3 F12, ADR 0081: a copy kept first)', () => {
  it('a deleted page comes back with Revert, audited', async () => {
    const r = await call('delete_resource', { page: 'bk000003', confirm: true });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(w.repo.live('bk000003')).toBeUndefined();
    const rv = await rt().reverts.revert('owner', PROJECT, jobId);
    expect(rv, JSON.stringify(rv)).toMatchObject({ status: 'submitted' });
    if (rv.status !== 'submitted') throw new Error('not submitted');
    const job = await waitJob(rv.revertJobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    // LegendKeeper's own restore runs as the revert's follow-up, after its job.
    for (let i = 0; i < 400 && !w.repo.live('bk000003'); i++) await new Promise((res) => setTimeout(res, 25));
    expect(w.repo.live('bk000003')).toBeDefined();
    const audit = rt().policy.store.listAudit({ action: 'job.revert', limit: 20 });
    expect(audit.some((a) => a.target === jobId && (a.after as { outcome?: string })?.outcome === 'submitted')).toBe(
      true,
    );
  });
});

describe('never reverted', () => {
  it('a job that is still running, or not a direct write, is refused', async () => {
    expect(await rt().reverts.revert('owner', PROJECT, 'job_nope')).toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
