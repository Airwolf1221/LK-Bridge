/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- the mock's state */
/**
 * v3 F5b (ADR 0068, H5): the engine, against the REAL stack on the mock LegendKeeper.
 *
 * - Apply writes as the Automation principal, reads the page back, and the job is on the Review page and Revertible;
 * - Propose makes ONE proposal per code, an item per page;
 * - a finding no longer present is skipped and recorded (FIX_STALE); three skips in a row for one reason pause the code;
 * - the caps per code and per run are honoured;
 * - the first failed verification switches the code off, with the reason, and its paragraph says so;
 * - at Apply an Authoritative page's change runs directly (the owner's ruling, F6d follow-up); a guard's refusal pauses
 *   the code and proposes nothing;
 * - nothing runs while automation is paused, writes are paused or draining, or the project is read-only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { P } from '../appraisal/world.js';
import { R } from '../packs/retag-world.js';
import {
  automationWorld,
  DASH_ROLE,
  DASH_STRAY,
  DASH_WORKING,
  PROJECT,
  type AutomationWorld,
} from './world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: AutomationWorld;
beforeAll(async () => {
  w = await automationWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const a = () => w.stack.runtime.automation;
const on = (code: string, mode: 'propose' | 'apply' | 'off') => a().setMode('owner', PROJECT, code, mode);
const blocks = (id: string) => w.repo.blocks.get(w.mainOf(id))!.blocks as any[];
const items = (runId: string, code?: string) =>
  a()
    .store.items(runId)
    .filter((i) => code === undefined || i.code === code);
const texts = () =>
  w
    .governanceBlocks()
    .map((b) => ((b.content as { text?: string }[] | undefined) ?? []).map((r) => r.text ?? '').join(''));
const setCaps = (perCode: number, perRun: number) => {
  // v3 F5b.1: the caps are settings, read on each run: no pack change, no approval.
  const live = w.stack.runtime.configSettings.live;
  live.set('AUTOMATION_CAP_PER_CODE', perCode, 'test', Date.now());
  live.set('AUTOMATION_CAP_PER_RUN', perRun, 'test', Date.now());
};

describe('Apply automatically', () => {
  it('writes as the Automation principal, reads the page back, and the job is on the Review page and Revertible', async () => {
    const before = structuredClone(blocks(P.blanks));
    expect(before.some((b) => b.kind === 'paragraph' && (b.content ?? []).length === 0)).toBe(true);
    await on('blank_paragraphs', 'apply');
    const run = await a().run(PROJECT, 'manual');
    expect(run.state, run.summary ?? '').toBe('succeeded');
    const [item] = items(run.id, 'blank_paragraphs');
    expect(item).toMatchObject({
      outcome: 'applied',
      pageId: P.blanks,
      reason: 'written, read back and verified',
    });
    // Only the blank paragraphs are gone; every other block is exactly as it was.
    const after = blocks(P.blanks);
    expect(after).toEqual(before.filter((b) => !(b.kind === 'paragraph' && (b.content ?? []).length === 0)));
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, item!.jobId!)!;
    expect(job.principalId).toBe('automation');
    expect(job.origin).toMatchObject({ kind: 'maintenance', tool: 'automation.blank_paragraphs' });
    expect(job.priority).toBe('P3');
    const journal = w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId: job.id, limit: 20 });
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((e: any) => e.principalId === 'automation')).toBe(true);
    // On the Review page, as the Automation principal's direct write.
    const review = w.stack.runtime.review.store.get(PROJECT, job.id);
    expect(review).toMatchObject({ principalId: 'automation' });
    // Revertible: the blank paragraphs come back.
    const r = await w.stack.runtime.reverts.revert('owner', PROJECT, job.id);
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    await w.stack.runtime.engine.wait(PROJECT, (r as { revertJobId: string }).revertJobId, 20_000);
    expect(blocks(P.blanks).map((b) => b.id)).toEqual(before.map((b) => b.id));
    await on('blank_paragraphs', 'off');
  });

  it('a finding no longer present is skipped and recorded (FIX_STALE), and nothing is written', async () => {
    // The dashes are taken out in the LegendKeeper app after the night's snapshot.
    for (const b of blocks(P.dashText))
      if (Array.isArray(b.content))
        b.content = b.content.map((r: any) =>
          typeof r.text === 'string' ? { ...r, text: r.text.replace(/[—–]/g, '-') } : r,
        );
    w.repo.blocks.get(w.mainOf(P.dashText))!.version++;
    await on('em_dash_text', 'apply');
    const writes = w.requests().writes;
    const run = await a().run(PROJECT, 'manual');
    expect(items(run.id, 'em_dash_text')).toEqual([
      expect.objectContaining({ outcome: 'skipped', reasonCode: 'FIX_STALE', pageId: P.dashText }),
    ]);
    expect(w.requests().writes).toBe(writes);
    expect(a().store.setting(PROJECT, 'em_dash_text')).toMatchObject({
      skipReason: 'FIX_STALE',
      skipStreak: 1,
    });
    await on('em_dash_text', 'off');
  });

  it('the cap per code and the cap per run are honoured; the rest waits for the next run', async () => {
    setCaps(2, 3);
    try {
      await on('retag_correction', 'apply');
      await on('out_of_order', 'apply');
      // The fixed order: sibling order first (its cap: 2 pages), then the retag corrections (what the run's cap leaves: 1).
      const run = await a().run(PROJECT, 'manual');
      expect(items(run.id, 'out_of_order')).toHaveLength(2);
      const retag = items(run.id, 'retag_correction');
      expect(retag).toHaveLength(1);
      expect(run, run.summary ?? '').toMatchObject({ state: 'stopped', stopReason: 'cap' });
      expect(run.summary).toMatch(/The cap of 3 pages a run was reached/);
      // The next run takes the next pages.
      const next = await a().run(PROJECT, 'manual');
      const again = items(next.id, 'retag_correction');
      expect(again.length).toBeGreaterThanOrEqual(1);
      expect(again.map((i) => i.pageId)).not.toContain(retag[0]!.pageId);
    } finally {
      await on('retag_correction', 'off');
      await on('out_of_order', 'off');
      setCaps(25, 100);
    }
  });

  it('the first failed verification switches the code off, with the reason; its paragraph says so', async () => {
    // A change made in the app between the write and the read-back: the document no longer reads as planned.
    const doc = w.mainOf(P.headingLink);
    w.overrides.set(new RegExp(`/docs/${doc}/blocks/`), (req) => {
      if (req.method === 'PUT') {
        const b = w.repo.blocks.get(doc)!;
        b.blocks.push({ id: 'intruder', kind: 'paragraph', content: [{ text: 'Added in the app.' }] });
      }
      return undefined;
    });
    try {
      await on('heading_links', 'apply');
      const run = await a().run(PROJECT, 'manual');
      expect(items(run.id, 'heading_links')).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          reasonCode: 'VERIFICATION_FAILED',
          pageId: P.headingLink,
        }),
      ]);
      const s = a().store.setting(PROJECT, 'heading_links')!;
      expect(s.mode).toBe('off');
      expect(s.stoppedReason).toMatch(/VERIFICATION_FAILED on “.*”/);
      expect(a().store.changes(PROJECT, 'heading_links')[0]).toMatchObject({
        to: 'off',
        principal: 'automation',
      });
      const p = texts().find((t) => t.startsWith('Bridge automation heading_links:'))!;
      expect(p).toMatch(/Setting: Off since .* \(switched off by the bridge: VERIFICATION_FAILED/);
      expect((await w.stack.runtime.packs.governance('arkona')).state).toBe('current');
      expect(
        a()
          .codes(PROJECT)
          .find((c) => c.code === 'heading_links')!.stopped,
      ).not.toBeNull();
    } finally {
      w.overrides.delete([...w.overrides.keys()].find((k) => k.source.includes(doc))!);
    }
  });

  it('at Apply an Authoritative page’s rename runs directly (the owner’s ruling), read back, on the Review page', async () => {
    // F6d follow-up (ADR 0057 decision 5 and ADR 0081 amended): the owner's Apply setting is the approval.
    await on('em_dash_name', 'apply');
    const run = await a().run(PROJECT, 'manual', { onlyPages: new Set([DASH_ROLE]) });
    const item = items(run.id, 'em_dash_name').find((i) => i.pageId === DASH_ROLE)!;
    expect(item, JSON.stringify(item)).toMatchObject({
      outcome: 'applied',
      reason: 'written, read back and verified',
    });
    expect(item.proposalId).toBeNull();
    expect((w.repo as any).res.get(DASH_ROLE).name).toMatch(/^\[BSRC\] Varn Harbour - Toll Ledger.*Annex$/);
    expect((w.repo as any).res.get(DASH_ROLE).name).not.toContain('\u2014');
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, item.jobId!)!;
    expect(job.principalId).toBe('automation');
    expect(job.origin).toMatchObject({ automationApply: true });
    expect(w.stack.runtime.review.store.get(PROJECT, job.id)).toMatchObject({ principalId: 'automation' });
    expect(a().store.setting(PROJECT, 'em_dash_name')!.pausedAt ?? null).toBeNull();
    await on('em_dash_name', 'off');
  });

  it('a guard refusing a change pauses the code (it stays on, nothing is written, nothing is proposed)', async () => {
    await on('em_dash_name', 'apply');
    const run = await a().run(PROJECT, 'manual');
    const got = items(run.id, 'em_dash_name');
    expect(got.find((i) => i.pageId === DASH_WORKING)).toMatchObject({ outcome: 'applied' });
    const stray = got.find((i) => i.pageId === DASH_STRAY)!;
    expect(stray).toMatchObject({ outcome: 'guarded', reasonCode: 'GUARDED' });
    expect(stray.reason).toMatch(/lifecycle state/);
    const s = a().store.setting(PROJECT, 'em_dash_name')!;
    expect(s.mode).toBe('apply');
    expect(s.pausedReason).toMatch(/a guard refused it/);
    expect((w.repo as any).res.get(DASH_STRAY).name).toMatch(/\u2014Stray$/);
    // The owner's ruling: Apply never turns into a proposal; a refusal is a refusal.
    expect(stray.proposalId).toBeNull();
    a().resume('owner', PROJECT, 'em_dash_name');
    await on('em_dash_name', 'off');
  });

  it('three skips in a row for the same reason pause the code', async () => {
    await on('em_dash_text', 'apply');
    const s0 = a().store.setting(PROJECT, 'em_dash_text')!;
    expect(s0.skipStreak).toBe(0); // a mode change starts the streak afresh
    for (let i = 0; i < 3; i++) await a().run(PROJECT, 'manual');
    const s = a().store.setting(PROJECT, 'em_dash_text')!;
    expect(s.pausedReason ?? '').toMatch(/3 findings skipped in a row for the same reason \(FIX_STALE/);
    await on('em_dash_text', 'off');
  });
});

describe('Propose automatically', () => {
  it('ONE proposal per code per run, an item per page, which the owner approves in whole or in part', async () => {
    await on('retag_correction', 'propose');
    const run = await a().run(PROJECT, 'manual');
    const proposed = items(run.id, 'retag_correction');
    expect(proposed.length).toBeGreaterThan(1);
    expect(new Set(proposed.map((i) => i.outcome))).toEqual(new Set(['proposed']));
    const ids = new Set(proposed.map((i) => i.proposalId));
    expect(ids.size).toBe(1);
    const p = w.stack.runtime.policy.proposals.detail([...ids][0]!)!;
    expect(p.principalId).toBe('automation');
    expect(p.itemPlan?.items.length).toBe(proposed.length);
    w.stack.runtime.policy.commands.reject('owner', p.id, 'test');
    await on('retag_correction', 'off');
  });

  it('an audit code’s pages are gathered into one proposal with an item each; the owner approves some of them', async () => {
    await w.snapshot();
    await on('out_of_order', 'propose');
    const run = await a().run(PROJECT, 'manual');
    const proposed = items(run.id, 'out_of_order').filter((i) => i.outcome === 'proposed');
    expect(proposed.length, JSON.stringify(items(run.id))).toBeGreaterThan(1);
    const ids = new Set(proposed.map((i) => i.proposalId));
    expect(ids.size).toBe(1);
    const p = w.stack.runtime.policy.proposals.detail([...ids][0]!)!;
    const planned = p.itemPlan?.items ?? [];
    expect(planned.map((x: any) => x.page?.id).sort()).toEqual(proposed.map((i) => i.pageId).sort());
    // In part: one item approved, the rest left out.
    const first = planned[0]!;
    const before = w.requests().writes;
    void w.stack.runtime.policy.commands.approve('owner', p.id, { items: [first.id] });
    await vi.waitFor(
      () => expect(['executed', 'failed']).toContain(w.stack.runtime.policy.proposals.get(p.id)!.state),
      { timeout: 20_000 },
    );
    expect(w.stack.runtime.policy.proposals.get(p.id)!.state).toBe('executed');
    expect(w.requests().writes - before).toBe(1);
    await on('out_of_order', 'off');
  });
});

describe('the brakes: nothing runs', () => {
  const quiet = async (why: RegExp) => {
    const writes = w.requests().writes;
    const run = await a().run(PROJECT, 'manual');
    expect(run.state).toBe('skipped');
    expect(run.summary).toMatch(why);
    expect(w.requests().writes).toBe(writes);
  };
  beforeAll(async () => {
    await on('lifecycle_tag_not_leading', 'apply');
  });

  it('while Pause all automation is on', async () => {
    a().setGlobalPause('owner', true);
    await quiet(/Pause all automation is on/);
    a().setGlobalPause('owner', false);
  });

  it('while writes are paused', async () => {
    w.stack.runtime.engine.controls.pauseWrites('owner');
    await quiet(/writes are paused/);
    w.stack.runtime.engine.controls.resumeWrites('owner');
  });

  it('while the bridge is draining', async () => {
    await w.stack.runtime.engine.controls.drain();
    await quiet(/draining/);
    w.stack.runtime.engine.controls.undrain();
  });

  it('while the project (or the bridge) is read-only', async () => {
    w.stack.runtime.engine.controls.setReadOnly(true, 'owner');
    await quiet(/read-only/);
    w.stack.runtime.engine.controls.setReadOnly(null, 'owner');
  });

  it('and once released, it runs', async () => {
    const run = await a().run(PROJECT, 'manual');
    expect(run.state).toBe('succeeded');
    void R;
  });
});
