/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- tool JSON */
/**
 * R3-RETAG (pass 3): "holds and exceptions can never be applied" (ADR 0060 decision 3.1, the tool's description), and
 * the owner's classification as the only way out of an uncertain-category hold (decision 4): through stored runs, a
 * tampered or foreign run id, an agent's `suggest`, an owner classification arriving (or withdrawn, or changed) between
 * the audit and the apply, an older run used after a re-audit, a reconciliation's Resume and "Propose these again".
 *
 * The classification fixtures carry two primary categories (`CANON, Culture, Polity` on a General Source): a hold until
 * the owner classifies them; with the owner's Polity, a deterministic correction that removes Culture.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve, audit, batchOf, byId, PROJECT, propose, r3World, tagsOf, type R3World } from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

const P = {
  withdrawn: 'r3cls001',
  changed: 'r3cls002',
  oldRun: 'r3cls003',
  suggested: 'r3cls004',
  exception: 'r3exc001',
  reorder: 'r3ord001',
  leftOutA: 'r3pta001',
  leftOutB: 'r3pta002',
  recHold: 'r3rch001',
  recFix: 'r3rfx001',
  sticky: 'r3rcs001',
} as const;

const TWO = ['CANON', 'Culture', 'Polity'];

let w: R3World;
beforeAll(async () => {
  const two = (id: string, n: string) => ({
    id,
    name: `[BSRC] ${n} - Reference`,
    tags: [...TWO],
    referenceType: 'General Source',
  });
  w = await r3World([
    two(P.withdrawn, 'Aaa Withdrawn'),
    two(P.changed, 'Abb Changed'),
    two(P.oldRun, 'Acc Old Run'),
    two(P.suggested, 'Add Suggested'),
    { id: P.exception, name: '[BSRC] Aee Exception - Polity Reference', tags: ['CANON', 'Polity', 'Lore'] },
    { id: P.reorder, name: '[BSRC] Aff Reorder - Polity Reference', tags: ['Polity', 'CANON'] },
    { id: P.leftOutA, name: '[BSRC] Agg Left A - Polity Reference', tags: ['Polity', 'CANON'] },
    { id: P.leftOutB, name: '[BSRC] Ahh Left B - Polity Reference', tags: ['Polity', 'CANON'] },
    two(P.recHold, 'Rec Hold'),
    { id: P.recFix, name: '[BSRC] Rec Fix - Polity Reference', tags: ['Polity', 'CANON'] },
    { id: P.sticky, name: '[BSRC] Rec Sticky - Polity Reference', tags: ['Polity', 'CANON'] },
  ]);
  await w.snapshot();
});
afterAll(async () => w?.close());

const classify = (pageId: string, primary: string) =>
  w.stack.runtime.retag.classify('owner', PROJECT, {
    pageId,
    pageName: pageId,
    primary,
    specialist: null,
    reason: 'the owner checked the page',
  });
const unclassify = (pageId: string) => w.stack.runtime.retag.unclassify('owner', PROJECT, pageId);

describe('the owner’s classification and the apply', () => {
  it('RT-50: a classification withdrawn after the audit: the page (now a hold) is not written', async () => {
    classify(P.withdrawn, 'Polity');
    const body = await audit(w, { page: P.withdrawn });
    expect(body.pages[0]).toMatchObject({ disposition: 'correction', proposed: ['CANON', 'Polity'] });
    const p = await propose(w, body.runId, [P.withdrawn]);
    unclassify(P.withdrawn);
    const now = await audit(w, { page: P.withdrawn });
    expect(now.pages[0].disposition).toBe('hold'); // what the page is now: uncertain category
    const done = await approve(w, p.proposalId);
    const seen = { job: done.job?.status, disposition: batchOf(w, p.proposalId)!.dispositions };
    // SAFE: a hold is never applied; Culture is removed only on the owner's (current) classification.
    expect(tagsOf(w, P.withdrawn), JSON.stringify(seen)).toEqual(TWO);
  });

  it('RT-51: a classification changed (Polity → Culture) after the audit: the stale array is not written', async () => {
    classify(P.changed, 'Polity');
    const body = await audit(w, { page: P.changed });
    expect(body.pages[0]).toMatchObject({ disposition: 'correction', proposed: ['CANON', 'Polity'] });
    const p = await propose(w, body.runId, [P.changed]);
    classify(P.changed, 'Culture');
    const done = await approve(w, p.proposalId);
    const seen = { job: done.job?.status, disposition: batchOf(w, p.proposalId)!.dispositions };
    // SAFE: the owner now says Culture: an array that removes Culture is never written.
    expect(tagsOf(w, P.changed), JSON.stringify(seen)).toContain('Culture');
  });

  it('RT-52: an older run is refused once a re-audit shows the page’s verdict changed', async () => {
    classify(P.oldRun, 'Polity');
    const old = await audit(w, { page: P.oldRun });
    expect(old.pages[0].disposition).toBe('correction');
    unclassify(P.oldRun);
    const fresh = await audit(w, { page: P.oldRun });
    expect(fresh.pages[0].disposition).toBe('hold');
    // An agent proposes from the older run (its id is in its context).
    const r = await w.call('arkona_retag_apply', { project: 'test', runId: old.runId, pages: [P.oldRun] });
    const seen = { status: r.body.status ?? null, error: r.body.error?.code ?? null };
    // SAFE: the stored correction is no longer the page's verdict: refused, nothing proposed.
    expect(seen.status, JSON.stringify(seen)).not.toBe('proposal_captured');
  });

  it('RT-53: an agent’s suggestion never turns a hold into something the apply takes', async () => {
    const s = await w.callRead('arkona_retag_audit', {
      project: 'test',
      suggest: { page: P.suggested, primary: 'Polity', reason: 'it governs a coast' },
    });
    expect(s.isError, s.text).toBe(false);
    expect(w.stack.runtime.retag.store.classification(PROJECT, P.suggested)).toBeNull();
    const body = await audit(w, { page: P.suggested });
    expect(body.pages[0].disposition).toBe('hold');
    const r = await w.call('arkona_retag_apply', {
      project: 'test',
      runId: body.runId,
      pages: [P.suggested],
    });
    expect(r.body.error?.code).toBe('RETAG_NOT_DETERMINISTIC');
    // The read-scope connection cannot propose at all.
    const read = await w.callRead('arkona_retag_apply', {
      project: 'test',
      runId: body.runId,
      pages: [P.reorder],
    });
    expect(read.isError).toBe(true);
  });
});

describe('stored runs: tampered, foreign, holds, exceptions, the cap', () => {
  let runId: string;
  beforeAll(async () => {
    runId = (await audit(w, { under: w.desk })).runId as string;
  });

  it('RT-54: a well-formed but unknown run id, and a malformed one, are refused', async () => {
    const unknown = await w.call('arkona_retag_apply', {
      project: 'test',
      runId: 'rtg_0123456789abcdef',
      pages: [P.reorder],
    });
    expect(unknown.body.error?.code).toBe('RUN_NOT_FOUND');
    const bad = await w.call('arkona_retag_apply', {
      project: 'test',
      runId: `${runId}' OR 1=1`,
      pages: [P.reorder],
    });
    expect(bad.isError).toBe(true);
  });

  it('RT-55: another project’s run (same page ids, a correction there) is refused here', async () => {
    const store = w.stack.runtime.retag.store;
    const mine = store.run(runId)!;
    const verdict = store.verdict(runId, P.reorder)!;
    const foreign = store.saveRun(
      { ...mine, id: 'rtg_00000000000f0e19', projectId: 'proj_other', reconciliationId: null, actor: 'x' },
      [verdict],
    );
    const r = await w.call('arkona_retag_apply', { project: 'test', runId: foreign.id, pages: [P.reorder] });
    expect(r.body.error?.code).toBe('RUN_NOT_FOUND');
  });

  it('RT-56: a hold, an exception, an excluded page or a page not in the run is refused', async () => {
    for (const [pages, code] of [
      [[P.reorder, P.recHold], 'RETAG_NOT_DETERMINISTIC'],
      [[P.exception], 'RETAG_NOT_DETERMINISTIC'],
      [[w.desk], 'RETAG_NOT_DETERMINISTIC'],
      [['zzzzzzzz'], 'PAGE_NOT_IN_RUN'],
    ] as const) {
      const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages: [...pages] });
      expect(r.body.error?.code, JSON.stringify(pages)).toBe(code);
    }
  });

  it('RT-57: 26 distinct ids are refused; one id 30 times counts once', async () => {
    const many = await w.call('arkona_retag_apply', {
      project: 'test',
      runId,
      pages: Array.from({ length: 26 }, (_, i) => `r3pg${String(i).padStart(4, '0')}`),
    });
    expect(many.body.error?.code).toBe('RETAG_BATCH_TOO_LARGE');
    const same = await w.call('arkona_retag_apply', {
      project: 'test',
      runId,
      pages: Array.from({ length: 30 }, () => P.reorder),
    });
    expect(same.body.status, same.text).toBe('proposal_captured');
    expect(same.body.pages).toHaveLength(1);
    // RT-58: a page already in an open batch is refused.
    const again = await w.call('arkona_retag_apply', { project: 'test', runId, pages: [P.reorder] });
    expect(again.body.error?.code).toBe('RETAG_PAGE_IN_BATCH');
    w.stack.runtime.policy.commands.reject('owner', same.body.proposalId as string, 'test');
  });
});

describe('one page, one open batch', () => {
  it('RT-58: two applies of the same page sent at once never make two open batches', async () => {
    const body = await audit(w, { page: P.reorder });
    // Two connections (two agents at scope write), each sending the same apply at the same moment.
    const t1 = w.stack.newToken('r3-race-1', 'write').token;
    const t2 = w.stack.newToken('r3-race-2', 'write').token;
    const [c1, c2] = await Promise.all([w.stack.connect(t1), w.stack.connect(t2)]);
    const args = { project: 'test', runId: body.runId, pages: [P.reorder] };
    const [a, b] = await Promise.all([
      w.stack.call(c1, 'arkona_retag_apply', args),
      w.stack.call(c2, 'arkona_retag_apply', args),
    ]);
    const captured = [a, b].filter((r) => r.body.status === 'proposal_captured');
    const open = w.stack.runtime.retag.store
      .openBatches(PROJECT)
      .filter((x) => x.state === 'proposed' && x.pages.some((pg) => pg.pageId === P.reorder));
    for (const r of captured)
      w.stack.runtime.policy.commands.reject('owner', r.body.proposalId as string, 'test');
    // SAFE: one of the two is refused (RETAG_PAGE_IN_BATCH).
    expect({ captured: captured.length, open: open.length }).toEqual({ captured: 1, open: 1 });
  });

  it('RT-94: no MCP tool sets a classification (agents only suggest)', async () => {
    const client = await w.stack.connect();
    const list = await client.listTools();
    // A tool that could set one: its name, or one of its input's properties, names a classification.
    const offenders = list.tools
      .filter((t) => {
        const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
        return /classif/i.test(t.name) || props.some((k) => /classif|owner/i.test(k));
      })
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });
});

describe('selective approval: "Propose these again"', () => {
  it('RT-59: a left-out page proposed again is a tracked retag batch (busy, recorded, revertible)', async () => {
    const body = await audit(w, { under: w.desk });
    const p = await propose(w, body.runId, [P.leftOutA, P.leftOutB]);
    await w.stack.runtime.policy.commands.approve('owner', p.proposalId as string, {
      items: [`page:${P.leftOutA}`],
    });
    for (let i = 0; i < 500; i++) {
      const pv = w.stack.runtime.policy.proposals.get(p.proposalId as string)!;
      const job = pv.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, pv.jobId) : undefined;
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    // CR-2026-11-R3 (R3-15, fixed): the pages left out of a retag batch are not proposed again from the old audit (the
    // re-proposal was an untracked job: no batch, the page not busy, Revert refused WAS_A_PROPOSAL); a fresh audit and
    // apply makes them a tracked batch like any other.
    await expect(
      w.stack.runtime.policy.commands.reproposeOmitted(
        'owner',
        p.proposalId as string,
        {
          kind: 'ui',
          client: 'owner',
          tool: 'proposal.repropose',
          detail: `repropose:${p.proposalId as string}`,
        } as never,
      ),
    ).rejects.toMatchObject({ code: 'REPROPOSE_REFUSED' });
    const fresh = await audit(w, { page: P.leftOutB });
    const next = await w.call('arkona_retag_apply', {
      project: 'test',
      runId: fresh.runId,
      pages: [P.leftOutB],
    });
    expect(next.body.status, next.text).toBe('proposal_captured');
    // While it is open, another batch of the same page is refused (the page is busy).
    const again = await audit(w, { page: P.leftOutB });
    const dup = await w.call('arkona_retag_apply', {
      project: 'test',
      runId: again.runId,
      pages: [P.leftOutB],
    });
    const done = await approve(w, next.body.proposalId as string);
    const tracked = {
      batch: batchOf(w, next.body.proposalId as string) !== null,
      busyRefused: dup.body.error?.code === 'RETAG_PAGE_IN_BATCH',
      revertible: done.jobId ? w.stack.runtime.retag.isApplyJob(PROJECT, done.jobId) : null,
    };
    // SAFE: what reaches the page is a retag batch like any other: recorded (dispositions), its page busy while it is
    // open, its job revertible (ADR 0060 decision 3.6).
    expect(tracked, JSON.stringify(tracked)).toMatchObject({
      batch: true,
      busyRefused: true,
      revertible: true,
    });
  });
});

describe('reconciliation', () => {
  it('RT-60: a reconciliation’s Resume never proposes a hold or an exception, only its corrections', async () => {
    const start = await w.callRead('arkona_retag_audit', {
      project: 'test',
      reconciliation: 'R3 pass',
      under: w.desk,
      limit: 1,
    });
    expect(start.isError, start.text).toBe(false);
    const next = await w.call('arkona_retag_apply', { project: 'test', reconciliation: 'R3 pass' });
    expect(next.isError, next.text).toBe(false);
    const ids = ((next.body.pages ?? []) as { id: string }[]).map((x) => x.id);
    const run = w.stack.runtime.retag.store.latestRun(PROJECT)!;
    const verdicts = byId({ pages: w.stack.runtime.retag.store.verdicts(run.id) });
    for (const id of ids) expect(verdicts.get(id)?.disposition, id).toBe('correction');
    expect(ids).not.toContain(P.recHold);
    expect(ids).not.toContain(P.exception);
    if (next.body.proposalId)
      w.stack.runtime.policy.commands.reject('owner', next.body.proposalId as string, 'test');
  });

  it('RT-61: another project’s reconciliation is never viewed or resumed here', async () => {
    const rec = w.stack.runtime.retag.store.reconciliationByName(PROJECT, 'R3 pass')!;
    await expect(w.stack.runtime.retag.view('proj_other', rec.id)).rejects.toThrow(/No reconciliation/);
    const r = await w.call('arkona_retag_apply', { project: 'test', reconciliation: 'No Such Pass' });
    expect(r.body.error?.code).toBe('RECONCILIATION_NOT_FOUND');
  });
});

describe('reconciliation records and the owner’s views', () => {
  it('RT-62: a page applied, edited back in the app, whose next batch the owner rejects, still remains', async () => {
    const start = await w.callRead('arkona_retag_audit', {
      project: 'test',
      reconciliation: 'R3 sticky',
      page: P.sticky,
    });
    expect(start.isError, start.text).toBe(false);
    const rt = w.stack.runtime;
    const rec = rt.retag.store.reconciliationByName(PROJECT, 'R3 sticky')!;
    const first = await w.call('arkona_retag_apply', { project: 'test', reconciliation: 'R3 sticky' });
    expect(first.body.status, first.text).toBe('proposed');
    expect((await approve(w, first.body.proposalId as string)).job?.status).toBe('succeeded');
    expect(tagsOf(w, P.sticky)).toEqual(['CANON', 'Polity']);
    // Someone puts the old order back in the app; the snapshots see it.
    w.repo.outside.setTags(P.sticky, ['Polity', 'CANON']);
    await w.snapshot();
    const second = await w.call('arkona_retag_apply', { project: 'test', reconciliation: 'R3 sticky' });
    expect(second.body.status, second.text).toBe('proposed');
    rt.policy.commands.reject('owner', second.body.proposalId as string, 'not now');
    const v = await rt.retag.view(PROJECT, rec.id);
    const page = v.pages.find((x) => x.pageId === P.sticky);
    // SAFE: the page needs the correction again and nothing applied it: it remains for the next Resume.
    expect(v.remaining, JSON.stringify({ page, counts: v.counts })).toContain(P.sticky);
  });

  it('RT-95: one agent’s suggestions never push the other agents’ suggestions off the owner’s Holds view', () => {
    const rt = w.stack.runtime;
    rt.retag.suggest('pat_other_agent', PROJECT, {
      pageId: P.recHold,
      primary: 'Culture',
      specialist: null,
      reason: 'a careful suggestion',
    });
    for (let i = 0; i < 520; i++)
      rt.retag.suggest('pat_noisy_agent', PROJECT, {
        pageId: P.suggested,
        primary: 'Polity',
        specialist: null,
        reason: `noise ${i}`,
      });
    // The Holds tab lists the project's suggestions (src/admin/routes/tagging.ts: suggestions(p.id), then per page).
    const shown = rt.retag.store.suggestions(PROJECT).filter((x) => x.pageId === P.recHold);
    expect(shown.map((x) => x.reason)).toContain('a careful suggestion');
  });
});
