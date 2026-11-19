/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3f (ADR 0060): resumable reconciliation and the owner's classification. A named reconciliation keeps its record
 * across batches; resuming it audits what remains afresh and proposes the next batch (capped); the owner's
 * classification resolves an "uncertain category" hold for the next audit; a page whose facts change in the snapshots
 * is marked stale and audited again (a completed run is never current truth).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from './world.js';
import { PROJECT, R, retagWorld, type RetagWorld } from './retag-world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: RetagWorld;
beforeAll(async () => {
  w = await retagWorld();
  w.approveRetag({ batchSize: 3 });
  await w.snapshot();
});
afterAll(async () => w?.close());

const rt = () => w.stack.runtime;

describe('reconciliation', () => {
  it('starts with a free audit of its scope, then resumes batch by batch after a fresh audit of what remains', async () => {
    const before = w.requests();
    const start = await w.callRead('arkona_retag_audit', {
      project: 'test',
      reconciliation: 'First pass',
      under: R.desk,
      limit: 1,
    });
    expect(start.isError, start.text).toBe(false);
    expect(start.body.reconciliation).toMatchObject({ name: 'First pass', created: true });
    expect(w.requests()).toEqual(before); // free
    const rec = rt().retag.store.reconciliationByName(PROJECT, 'First pass')!;
    const v0 = await rt().retag.view(PROJECT, rec.id);
    expect(v0.counts).toMatchObject({ corrections: 8, holds: 2, exceptions: 1, remaining: 8 });

    const next = await w.call('arkona_retag_apply', { project: 'test', reconciliation: 'First pass' });
    expect(next.body.status, next.text).toBe('proposed');
    expect(next.body.pages).toHaveLength(3); // the pack's batch size
    expect(next.body.proposalId).toMatch(/^prop_/);
    const done = await approve(w, next.body.proposalId);
    expect(done.job?.status).toBe('succeeded');
    const v1 = await rt().retag.view(PROJECT, rec.id);
    expect(v1.counts.applied).toBe(3);
    expect(v1.counts.remaining).toBe(5);
    expect(v1.batches).toHaveLength(1);
    // An applied page is not stale once the snapshots show the array it was given.
    await w.snapshot();
    const v2 = await rt().retag.view(PROJECT, rec.id);
    expect(v2.counts.stale).toBe(0);
  });

  it('the owner’s classification resolves an uncertain-category hold; the next audit uses it', async () => {
    const hold = await w.callRead('arkona_retag_audit', { project: 'test', page: R.twoPrimaries });
    expect(hold.body.pages[0].disposition).toBe('hold');
    rt().retag.classify('owner', PROJECT, {
      pageId: R.twoPrimaries,
      pageName: '[BSRC] Harrow Pact - Reference',
      primary: 'Culture',
      specialist: null,
      reason: 'a culture page; Polity was added by mistake',
    });
    const after = await w.callRead('arkona_retag_audit', { project: 'test', page: R.twoPrimaries });
    expect(after.body.pages[0]).toMatchObject({
      disposition: 'correction',
      current: ['CANON', 'Culture', 'Polity'],
      proposed: ['CANON', 'Culture'],
    });
    expect(after.body.pages[0].rationale[1].source).toMatch(/the owner’s classification/);
    // The reconciliation sees its inputs changed (the classification): stale, audited again on resume.
    const rec = rt().retag.store.reconciliationByName(PROJECT, 'First pass')!;
    const v = await rt().retag.view(PROJECT, rec.id);
    expect(v.pages.find((p) => p.pageId === R.twoPrimaries)!.stale).toBe(true);
  });

  it('a page whose facts change in the snapshots is marked stale and re-audited next time', async () => {
    const rec = rt().retag.store.reconciliationByName(PROJECT, 'First pass')!;
    const ok = (await rt().retag.view(PROJECT, rec.id)).pages.find((p) => p.pageId === R.ok)!;
    expect(ok).toMatchObject({ disposition: 'compliant', stale: false });
    w.repo.outside.setRow(R.ok, 'Reference Type', 'Character Core');
    await w.snapshot();
    const v = await rt().retag.view(PROJECT, rec.id);
    expect(v.pages.find((p) => p.pageId === R.ok)!.stale).toBe(true);
    expect(v.remaining).toContain(R.ok);
    const next = await w.call('arkona_retag_apply', { project: 'test', reconciliation: 'First pass' });
    expect(next.body.status, next.text).toBe('proposed');
    const after = await rt().retag.view(PROJECT, rec.id);
    const page = after.pages.find((p) => p.pageId === R.ok)!;
    expect(page).toMatchObject({ stale: false, disposition: 'hold' });
    // The re-classified page is now a correction, proposed in this batch.
    expect(next.body.pages.map((p: any) => p.id)).toContain(R.twoPrimaries);
  });
});
