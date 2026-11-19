/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3f (ADR 0060): `arkona_retag_audit` and `arkona_retag_apply` end to end, against the mock LegendKeeper and the
 * retag world's fixtures (never fetched): the audit's dispositions and rationale at zero reads; the apply's batch cap,
 * items and proposal; the policy check; a conflicted page never rebased; a held page; the read-back; every disposition
 * recorded; Last Major Revision never set; Revert restoring the exact array.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from './world.js';
import { EXPECTED, PROJECT, R, retagWorld, type RetagWorld } from './retag-world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: RetagWorld;
let runId: string;
let firstJob: string;
beforeAll(async () => {
  w = await retagWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const audit = async (args: Record<string, unknown>) => {
  const r = await w.callRead('arkona_retag_audit', { project: 'test', limit: 200, ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const byId = (body: any) => new Map<string, any>((body.pages as any[]).map((p) => [p.pageId, p]));

describe('the audit', () => {
  it('gives every fixture its disposition, with a rationale per slot, at zero LegendKeeper reads', async () => {
    const before = w.requests();
    const body = await audit({ under: R.desk });
    expect(w.requests()).toEqual(before);
    runId = body.runId;
    expect(body.policy).toMatchObject({ packId: 'arkona', label: 'v1.8' });
    expect(body.policy.digest).toMatch(/^[0-9a-f]{64}$/);
    const pages = byId(body);
    for (const [id, d] of Object.entries(EXPECTED)) expect(pages.get(id)?.disposition, id).toBe(d);
    expect(pages.get(R.order)).toMatchObject({ current: ['Polity', 'CANON'], proposed: ['CANON', 'Polity'] });
    expect(pages.get(R.missing).proposed).toEqual(['CANON', 'Character', 'Foxian', 'Fujimatsuan']);
    expect(pages.get(R.au).proposed).toEqual(['AU', 'Polity']);
    expect(pages.get(R.routine)).toMatchObject({
      proposed: ['CANON', 'Polity'],
      removals: [{ tag: 'Imported' }],
    });
    expect(pages.get(R.twoPrimaries).holds[0].reason).toMatch(
      /^uncertain category; owner classification needed/,
    );
    expect(pages.get(R.otheiralth).rationale.map((s: any) => [s.slot, s.tag])).toEqual([
      ['status', 'CANON'],
      ['primary', 'Character'],
      ['race', 'Therian'],
      ['culture', 'Therian'],
    ]);
    expect(pages.get(R.ok).policy).toMatch(/^pack version \d+, digest [0-9a-f]{16}$/);
    // Outside the grammar: the Working page (lifecycle only), the Legacy page, the indexes.
    expect(pages.get(R.working)).toMatchObject({ scope: 'lifecycle', disposition: null });
    expect(pages.get(R.working).lifecycle).toMatch(/lifecycle_tag_not_leading/);
    expect(pages.get(R.legacy)).toMatchObject({ scope: 'excluded' });
    expect(pages.get(R.desk)).toMatchObject({ scope: 'excluded' });
    expect(body.counts).toMatchObject({
      compliant: 2,
      correction: 8,
      hold: 2,
      exception: 1,
      lifecycleOnly: 1,
    });
    expect(body.cost).toBe('none');
  });

  it('the existing tags audit agrees: its tag findings come from the same engine (codes kept)', async () => {
    const rt = w.stack.runtime;
    await rt.audits.run(PROJECT, 'manual');
    const found = rt.audits.list(PROJECT, { category: ['tags'], limit: 500 }) as unknown as {
      findings: { code: string; pageId: string | null }[];
    };
    const codes = (id: string) =>
      found.findings
        .filter((f) => f.pageId === id)
        .map((f) => f.code)
        .sort();
    expect(codes(R.ok)).toEqual([]);
    expect(codes(R.otheiralth)).toEqual([]);
    expect(codes(R.order)).toEqual(['tags_out_of_order']);
    expect(codes(R.missing)).toEqual(['missing_required_tags']);
    expect(codes(R.routine)).toEqual(['tags_outside_definition']);
    expect(codes(R.extra)).toEqual(['tags_outside_definition']);
    expect(codes(R.twoPrimaries)).toEqual(['tags_held']);
    expect(codes(R.unestablished)).toEqual(['tags_held']);
    // Outside the grammar: nothing from the tags audit (the Working page is the lifecycle check's).
    expect(codes(R.working)).toEqual([]);
    expect(codes(R.legacy)).toEqual([]);
    const lifecycle = rt.audits.list(PROJECT, {
      code: ['lifecycle_tag_not_leading'],
      limit: 50,
    }) as unknown as {
      findings: { pageId: string | null }[];
    };
    expect(lifecycle.findings.some((f) => f.pageId === R.working)).toBe(true);
  });

  it('live: true re-reads the pages concerned, one read each', async () => {
    const before = w.requests();
    const body = await audit({ page: R.order, live: true });
    expect(w.requests().all - before.all).toBe(1);
    expect(w.requests().writes).toBe(before.writes);
    expect(body.pages[0]).toMatchObject({ pageId: R.order, disposition: 'correction' });
  });

  it('a stored run reads again, a page at a time, filtered', async () => {
    const body = await audit({ runId, filter: 'hold' });
    expect((body.pages as any[]).map((p) => p.pageId).sort()).toEqual(
      [R.twoPrimaries, R.unestablished].sort(),
    );
  });

  it('an agent’s suggestion is kept for the owner and never used', async () => {
    const body = await audit({
      suggest: { page: R.twoPrimaries, primary: 'Culture', reason: 'its Scope reads as a culture' },
    });
    expect(body.suggested).toMatchObject({ primary: 'Culture', specialist: null });
    expect(w.stack.runtime.retag.store.classification(PROJECT, R.twoPrimaries)).toBeNull();
    const again = await audit({ page: R.twoPrimaries });
    expect(again.pages[0].disposition).toBe('hold');
  });
});

describe('the apply', () => {
  it('holds and exceptions can never be applied; a batch is capped', async () => {
    const r = await w.call('arkona_retag_apply', {
      project: 'test',
      runId,
      pages: [R.order, R.twoPrimaries, R.extra],
    });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('RETAG_NOT_DETERMINISTIC');
    const many = await w.call('arkona_retag_apply', {
      project: 'test',
      runId,
      pages: Array.from({ length: 26 }, (_, i) => `rtpage${String(i).padStart(2, '0')}`),
    });
    expect(many.body.error.code).toBe('RETAG_BATCH_TOO_LARGE');
  });

  it('is always ONE proposal (even at scope write), each page an item; nothing written until approved', async () => {
    const before = w.requests();
    const r = await w.call('arkona_retag_apply', {
      project: 'test',
      runId,
      pages: [R.order, R.routine, R.missing, R.au],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(w.requests().writes).toBe(before.writes);
    const items = w.stack.runtime.policy.proposals.itemsOf(r.body.proposalId)?.items ?? [];
    expect(items.map((i: any) => i.id).sort()).toEqual(
      [R.order, R.routine, R.missing, R.au].map((id) => `page:${id}`).sort(),
    );
    // Selective approval: the AU page left out.
    // Meanwhile someone edits the routine page's tags in the app: it must be conflicted, never rebased.
    w.repo.outside.setTags(R.routine, ['CANON', 'Polity', 'Imported', 'Harbour']);
    const policy = w.stack.runtime.policy;
    await policy.commands.approve('owner', r.body.proposalId, {
      items: [R.order, R.routine, R.missing].map((id) => `page:${id}`),
    });
    let done;
    for (let i = 0; i < 500; i++) {
      const p = policy.proposals.get(r.body.proposalId)!;
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        done = job;
        break;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(done?.status).toBe('succeeded');
    if (!done) throw new Error('the job did not finish');
    firstJob = done.id;
    const batch = w.stack.runtime.retag.store.batchByProposal(r.body.proposalId)!;
    expect(batch.state).toBe('done');
    expect(batch.dispositions).toMatchObject({
      [R.order]: { outcome: 'applied', verified: true },
      [R.missing]: { outcome: 'applied', verified: true },
      [R.routine]: { outcome: 'conflicted' },
    });
    expect(batch.dispositions![R.au]).toBeUndefined(); // left out by the owner: still remaining
    expect(w.repo.res.get(R.order)!.tags).toEqual(['CANON', 'Polity']);
    expect(w.repo.res.get(R.missing)!.tags).toEqual(['CANON', 'Character', 'Foxian', 'Fujimatsuan']);
    // Never rebased: the edited page keeps the app's tags.
    expect(w.repo.res.get(R.routine)!.tags).toEqual(['CANON', 'Polity', 'Imported', 'Harbour']);
    // Last Major Revision is never set by a retag.
    const steps = w.stack.runtime.engine.stepRecords(PROJECT, done.id)!;
    expect(steps.some((s) => s.opId === 'bridge.lmr')).toBe(false);
    expect(w.repo.res.get(R.order)!.props[0]!.rows.some((x: any) => x.key === 'Last Major Revision')).toBe(
      false,
    );
    // No status tag added or removed: CANON is only moved first.
    const writes = steps.filter((s) => s.opId === 'updateResource');
    expect(writes).toHaveLength(3);
  });

  it('Revert restores the exact prior array, only where nothing changed since', async () => {
    const rt = w.stack.runtime;
    // One of the two pages is edited in the app since: Revert refuses to overwrite it, and asks before a partial revert.
    w.repo.outside.setTags(R.missing, ['CANON', 'Character', 'Foxian', 'Fujimatsuan', 'Harbour']);
    const first = await rt.reverts.revert('owner', PROJECT, firstJob);
    expect(first).toMatchObject({ status: 'refused', code: 'PARTIAL_REVERT_NEEDS_CONFIRMATION' });
    const r = await rt.reverts.revert('owner', PROJECT, firstJob, { confirmPartial: true });
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    const revertJob =
      (r as { revertJobId?: string; jobId?: string }).revertJobId ?? (r as { jobId?: string }).jobId;
    await rt.engine.wait(PROJECT, revertJob!, 25_000);
    expect(w.repo.res.get(R.order)!.tags).toEqual(['Polity', 'CANON']);
    expect(w.repo.res.get(R.missing)!.tags).toEqual([
      'CANON',
      'Character',
      'Foxian',
      'Fujimatsuan',
      'Harbour',
    ]);
  });

  it('a page already compliant at the fresh read, a held page and an inaccessible page are recorded so', async () => {
    const body = await audit({ under: R.desk });
    const fresh = body.runId;
    const r = await w.call('arkona_retag_apply', { project: 'test', runId: fresh, pages: [R.au] });
    expect(r.body.status, r.text).toBe('proposal_captured');
    // The page is fixed in the app before the owner approves: already compliant at the fresh read.
    w.repo.outside.setTags(R.au, ['AU', 'Polity']);
    const done = await approve(w, r.body.proposalId);
    expect(done.job?.status).toBe('succeeded');
    const b = w.stack.runtime.retag.store.batchByProposal(r.body.proposalId)!;
    expect(b.dispositions![R.au]).toMatchObject({ outcome: 'already_compliant' });
  });

  it('a page whose facts changed since the audit is held; a page gone is inaccessible', async () => {
    const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages: [R.held, R.gone] });
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.repo.outside.setRow(R.held, 'Reference Type', 'Historical Polity Reference');
    w.repo.outside.delete(R.gone);
    const done = await approve(w, r.body.proposalId);
    expect(done.job?.status).toBe('succeeded');
    const b = w.stack.runtime.retag.store.batchByProposal(r.body.proposalId)!;
    expect(b.dispositions![R.held]).toMatchObject({ outcome: 'held', verified: null });
    expect(b.dispositions![R.held]!.reason).toMatch(
      /Reference Type: Polity Reference → Historical Polity Reference/,
    );
    expect(b.dispositions![R.gone]).toMatchObject({ outcome: 'inaccessible' });
    expect(w.repo.res.get(R.held)!.tags).toEqual(['Polity', 'CANON']);
  });

  it('a batch that stops part-way resumes from where it stopped, never writing a page twice', async () => {
    const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages: [R.resumeA, R.resumeB] });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const writes = () =>
      w.stack.mock.calls.filter(
        (c) => c.method === 'PATCH' && /\/resources\/rtres00[12]$/.test(c.path.replace(/\/$/, '')),
      ).length;
    w.failNext('PATCH', /\/resources\/rtres002$/, 0);
    const done = await approve(w, r.body.proposalId);
    expect(done.job?.status).toBe('failed');
    const rt = w.stack.runtime;
    expect(rt.resume.view(PROJECT, done.jobId!).resumable).toBe(true);
    const out = await rt.resume.resume(PROJECT, done.jobId!, { kind: 'owner' }, {
      kind: 'ui',
      client: 'owner',
      tool: 'job.resume',
      principal: { principalId: 'system', profile: 'owner', label: 'owner' },
    } as never);
    expect(out.status).toBe('resumed');
    for (let i = 0; i < 500; i++) {
      const j = rt.engine.queries.getJob(PROJECT, done.jobId!)!;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(rt.engine.queries.getJob(PROJECT, done.jobId!)!.status).toBe('succeeded');
    expect(writes()).toBe(3); // A once, B twice (the failed send and its retry)
    const b = rt.retag.store.batchByProposal(r.body.proposalId)!;
    expect(b.dispositions).toMatchObject({
      [R.resumeA]: { outcome: 'applied', verified: true },
      [R.resumeB]: { outcome: 'applied', verified: true },
    });
  });

  it('a policy change since the audit stops the whole job before any write', async () => {
    await w.snapshot();
    const body = await audit({ under: R.desk });
    const r = await w.call('arkona_retag_apply', { project: 'test', runId: body.runId, pages: [R.routine] });
    // The routine page conflicted earlier; this audit sees its new array: it is an exception now (Harbour).
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('RETAG_NOT_DETERMINISTIC');
    w.repo.outside.setTags(R.order, ['Polity', 'CANON']);
    await w.snapshot();
    const again = await audit({ under: R.desk });
    const p = await w.call('arkona_retag_apply', { project: 'test', runId: again.runId, pages: [R.order] });
    expect(p.body.status, p.text).toBe('proposal_captured');
    w.approveRetag({ routine: ['Imported', 'Draft'] }); // a new approved version: another policy
    const before = w.requests().writes;
    const done = await approve(w, p.body.proposalId);
    expect(done.job?.status).toBe('failed');
    expect(done.job?.lastError?.code).toBe('RETAG_POLICY_CHANGED');
    expect(done.job?.lastError?.message).toMatch(/policy changed since the audit; audit again/);
    expect(w.requests().writes).toBe(before);
    expect(w.repo.res.get(R.order)!.tags).toEqual(['Polity', 'CANON']);
  });
});
