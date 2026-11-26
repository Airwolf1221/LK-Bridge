/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- the service's seams and the mock's state */
/**
 * v3 F5b.1 (ADR 0068 amendment 1): automation paces itself instead of stopping on a short budget wait, and the caps are
 * settings.
 *
 * - a short wait (the minute tier) is slept through and the run carries on with the same page; the pause is in the log;
 * - a wait over AUTOMATION_BUDGET_MAX_WAIT_SECONDS, or any day-tier wait, stops the run, the reason naming the tier;
 * - an Apply job waiting for budget is waited for, and stops the run only past the limit;
 * - a stop during a pause ends it at once, the item recorded; "Run automation now" joins a pausing run;
 * - the whole-run ceiling;
 * - the caps are settings (no pack change); the paragraphs' old wording is accepted until amended, once, without drift.
 *
 * Runs against the REAL stack on the mock LegendKeeper; the governor's estimate and the sleep are the seams.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { automationWorld, PROJECT, type AutomationWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let w: AutomationWorld;
beforeAll(async () => {
  w = await automationWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const a = () => w.stack.runtime.automation;
const d = () => (a() as any).d;
const on = (code: string, mode: 'propose' | 'apply' | 'off') => a().setMode('owner', PROJECT, code, mode);
const items = (runId: string) => a().store.items(runId);
const SETTINGS = { capPerCode: 25, capPerRun: 100, budgetMaxWaitSeconds: 600, runMaxMinutes: 120 };

const tier = (id: string, timeMs: number, windowMs = 60_000) => ({ tier: id, windowMs, timeMs });
/** A governor whose estimate answers from `waits` (one entry per call; the last repeats), then clears. */
function fakeGovernor(waits: (ReturnType<typeof tier> | null)[], repeatLast = false) {
  const gov = w.stack.runtime.projects.anyClient(PROJECT)!.governor as any;
  let n = 0;
  return vi.spyOn(gov, 'estimate').mockImplementation(() => {
    const t = waits[Math.min(n++, repeatLast ? waits.length - 1 : Infinity)] ?? null;
    return { tiers: t ? [t] : [], operationTiers: [] };
  });
}
const restore: (() => void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of restore.splice(0)) r();
  for (const code of ['out_of_order', 'blank_paragraphs', 'em_dash_text']) await on(code, 'off');
});
const seams = (o: {
  settings?: Partial<typeof SETTINGS>;
  sleep?: (ms: number, s: AbortSignal) => Promise<void>;
}) => {
  const dd = d();
  const before = { settings: dd.settings, sleep: dd.sleep };
  dd.settings = () => ({ ...SETTINGS, ...o.settings });
  dd.sleep = o.sleep;
  restore.push(() => Object.assign(dd, before));
};

describe('a short budget wait is slept through', () => {
  it('pauses 20 s twice (the minute tier), then carries on and finishes; the pauses are in the run’s log', async () => {
    const slept: number[] = [];
    seams({ sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    // The minute tier says wait 20 s until the run has paused twice, then clears.
    const gov = w.stack.runtime.projects.anyClient(PROJECT)!.governor as any;
    vi.spyOn(gov, 'estimate').mockImplementation(() => ({
      tiers: slept.length < 2 ? [tier('write-min', 20_000)] : [],
      operationTiers: [],
    }));
    await on('out_of_order', 'apply');
    const run = await a().run(PROJECT, 'manual');
    expect(run.state, run.summary ?? '').toBe('succeeded');
    expect(slept).toEqual([20_000, 20_000]);
    expect(run.summary).toMatch(/paused 20 s for the minute tier; paused 20 s for the minute tier/);
    expect(items(run.id).some((i) => i.outcome === 'applied')).toBe(true);
    expect(items(run.id).every((i) => i.outcome !== 'stopped')).toBe(true);
  });
});

describe('a wait that must stop the run', () => {
  it('a 2 h wait stops it, the reason naming the tier and the wait; the page is recorded as stopped', async () => {
    const slept: number[] = [];
    seams({ sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    fakeGovernor([tier('write-hour', 7_200_000, 3_600_000)], true);
    await on('out_of_order', 'apply');
    const run = await a().run(PROJECT, 'manual');
    expect(run.state).toBe('stopped');
    expect(run.stopReason).toMatch(/hour tier says wait 2 h/);
    expect(run.summary).toMatch(/Stopped: the hour tier says wait 2 h.*the rest waits for the next run/);
    expect(slept).toEqual([]);
    expect(items(run.id).find((i) => i.outcome === 'stopped')).toMatchObject({ reasonCode: 'BUDGET' });
  });

  it('a day-tier wait stops it, however short, naming the day floor', async () => {
    const slept: number[] = [];
    seams({ sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    fakeGovernor([tier('key-day', 5_000, 86_400_000)], true);
    await on('out_of_order', 'apply');
    const run = await a().run(PROJECT, 'manual');
    expect(run.state).toBe('stopped');
    expect(run.stopReason).toMatch(/day tier says wait 5 s.*RESERVE_DAY_FLOOR_MAINTENANCE/);
    expect(slept).toEqual([]);
  });
});

describe('the whole-run ceiling', () => {
  it('stops the run with the time-limit reason', async () => {
    seams({
      settings: { runMaxMinutes: 0.001 }, // 60 ms
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 120))),
    });
    fakeGovernor([tier('write-min', 20_000)], true);
    await on('out_of_order', 'apply');
    const run = await a().run(PROJECT, 'manual');
    expect(run.state).toBe('stopped');
    expect(run.stopReason).toBe('the run’s time limit was reached');
    expect(run.summary).toMatch(/the run’s time limit was reached; the rest waits for the next run/);
  });
});

describe('an Apply job waiting for budget', () => {
  /** The job reads waiting_budget for its first `n` reads (the bridge's own governance jobs excepted). */
  const waitingFor = (n: number) => {
    const q = d().engine.queries as {
      getJob: (p: string, id: string) => Record<string, unknown> | undefined;
    };
    const real = q.getJob.bind(q);
    let left = n;
    vi.spyOn(q, 'getJob').mockImplementation((p, id) => {
      const j = real(p, id);
      if (!j || a().isGovernanceJob(p, id) || left <= 0) return j;
      left--;
      return { ...j, status: 'waiting_budget' };
    });
  };

  it('is waited for, then judged: the run goes on', async () => {
    seams({ sleep: () => Promise.resolve() });
    fakeGovernor([null]);
    await on('blank_paragraphs', 'apply');
    waitingFor(3);
    const run = await a().run(PROJECT, 'manual');
    expect(run.state, run.summary ?? '').toBe('succeeded');
    expect(items(run.id).find((i) => i.outcome === 'applied')).toBeDefined();
    expect(items(run.id).some((i) => i.reasonCode === 'BUDGET')).toBe(false);
  });

  it('stops the run past the limit, the item recorded as before', async () => {
    seams({ settings: { budgetMaxWaitSeconds: 0 }, sleep: () => Promise.resolve() });
    fakeGovernor([null]);
    await on('em_dash_text', 'apply');
    waitingFor(1_000);
    const run = await a().run(PROJECT, 'manual');
    expect(run.state).toBe('stopped');
    expect(run.stopReason).toMatch(/still waiting for budget/);
    expect(items(run.id).find((i) => i.reasonCode === 'BUDGET')).toMatchObject({ outcome: 'stopped' });
  });
});

describe('the caps are settings', () => {
  const live = () => w.stack.runtime.configSettings.live;

  it('caps() reads them, and a change applies to the next call with no pack change', async () => {
    expect(a().caps()).toEqual({ perCode: 25, perRun: 100 });
    const pack = w.stack.runtime.packs.get('arkona')!;
    live().set('AUTOMATION_CAP_PER_CODE', 7, 'test', Date.now());
    live().set('AUTOMATION_CAP_PER_RUN', 9, 'test', Date.now());
    try {
      expect(a().caps()).toEqual({ perCode: 7, perRun: 9 });
      expect(w.stack.runtime.packs.get('arkona')!.version).toBe(pack.version);
      expect((await a().governanceState(PROJECT)).ok).toBe(true);
      expect(w.stack.runtime.packs.get('arkona')!.rules.automation).not.toHaveProperty('perCode');
    } finally {
      live().set('AUTOMATION_CAP_PER_CODE', 25, 'test', Date.now());
      live().set('AUTOMATION_CAP_PER_RUN', 100, 'test', Date.now());
    }
  });

  it('the paragraphs name no numbers; the old wording is accepted until amended, once, and the approval is carried', async () => {
    seams({});
    await on('blank_paragraphs', 'propose');
    const rec = a().store.paragraph(PROJECT, 'blank_paragraphs')!;
    expect(rec.text).toContain('within the automation caps set on the Settings page');
    expect(rec.text).not.toMatch(/at most \d+ pages/);
    // A paragraph written before F5b.1: the old wording, recorded and in the page, the pack approved over it.
    const OLD = 'at most 25 pages a run for this code and 100 for every code together';
    const oldText = rec.text.replace('within the automation caps set on the Settings page', OLD);
    w.editAutomationPage((blocks) => {
      const b = blocks.find((x) => x.id === rec.blockId)!;
      b.content = [{ text: oldText }];
    });
    a().store.setParagraph({ ...rec, text: oldText });
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    expect((await a().governanceState(PROJECT)).ok, 'the checker accepts the old wording').toBe(true);

    // The next run amends it once, through the paragraph path (a job), the approval carried: no drift.
    const run = await a().run(PROJECT, 'manual');
    expect(run.state, run.summary ?? '').not.toBe('failed');
    const amended = a().store.paragraph(PROJECT, 'blank_paragraphs')!;
    expect(amended.text).toContain('within the automation caps set on the Settings page');
    expect(amended.text).not.toContain(OLD);
    expect(amended.jobId).not.toBe(rec.jobId);
    expect(a().isGovernanceJob(PROJECT, amended.jobId!)).toBe(true);
    expect((await a().governanceState(PROJECT)).ok, 'both wordings read, now the new').toBe(true);
    expect((await w.stack.runtime.packs.governance('arkona')).state).toBe('current');
    // Once: the next run writes no further governance job.
    await a().run(PROJECT, 'manual');
    expect(a().store.paragraph(PROJECT, 'blank_paragraphs')!.jobId).toBe(amended.jobId);
  });
});

// Last: the stop leaves the service stopped.
describe('a stop during a pause', () => {
  it('ends it at once, records the item, and "Run automation now" joins a pausing run', async () => {
    seams({}); // the real, abortable sleep
    fakeGovernor([tier('write-min', 30_000)], true);
    await on('out_of_order', 'apply');
    const first = a().run(PROJECT, 'manual');
    await vi.waitFor(() => expect(a().pausing(PROJECT)).not.toBeNull(), { timeout: 60_000, interval: 25 });
    expect(a().pausing(PROJECT)).toMatchObject({ label: 'minute tier', seconds: 30 });
    expect(a().run(PROJECT, 'manual')).toBe(first); // joined, not a second run
    const t0 = Date.now();
    await a().stop();
    const run = await first;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(run.state).toBe('stopped');
    expect(run.stopReason).toBe('the bridge is stopping');
    expect(items(run.id).find((i) => i.outcome === 'stopped')).toMatchObject({ reasonCode: 'STOPPED' });
    expect(a().pausing(PROJECT)).toBeNull();
  });
});
