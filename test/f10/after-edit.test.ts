/**
 * v3 F10 (ADR 0078, C3): the chronology repaired soon after an edit.
 *
 * - a change snapshot touching an age table schedules ONE check 10 minutes after it (fake clock); a burst of edits gives
 *   one check, 10 minutes after the last; a change of any other document, or the chronology's own job, schedules none;
 * - the automation's chronology codes run on the check's findings straight after it (with the edit's workstream);
 * - one run at a time per project (an edit during a run gives exactly one more run after it), and a stop awaits it;
 * - the scheduled check is nightly at 05:00, chained after the night's full snapshot and its audit; a stored next run
 *   from the old weekly default is brought forward at start.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundRunner } from '../../src/background.js';
import { createAfterEdit, chronologyDocumentsTouched } from '../../src/chronology/after-edit.js';
import { DEFAULT_CHRONOLOGY, type ChronologyConfig } from '../../src/chronology/settings.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import { builtinJobs, nightChainBusy } from '../../src/maintenance/jobs.js';
import { MaintenanceScheduler } from '../../src/maintenance/scheduler.js';
import type { MaintenanceContext, MaintenanceJobDef, RunTrigger } from '../../src/maintenance/types.js';
import { defaultMaintenanceSettings } from '../../src/config/index.js';
import type { ChangeTaken } from '../../src/snapshots/service.js';
import { maintenanceRig, type MaintenanceRig } from '../maintenance/helpers.js';

const PROJECT = 'proj_test';
const MIN = 60_000;

const config: ChronologyConfig = {
  ...DEFAULT_CHRONOLOGY,
  problem: null,
  confirmed: true,
  resourceId: 'chrono01',
  mainDocumentId: 'main0001',
  calendarId: 'cal00001',
  ages: [
    {
      name: 'Fourth Arkonan Age',
      eraId: 'era4',
      tableDocumentId: 'table004',
      timelineDocumentId: 'tline004',
      laneId: 'lane0004',
      laneName: 'Historical Events',
      mainRowId: 'mrow0004',
    },
  ],
};

const change = (documents: readonly string[] | 'all', o: Partial<ChangeTaken> = {}): ChangeTaken => ({
  snapshotId: 'snap',
  jobId: o.jobId ?? 'job1',
  tool: o.tool ?? 'write_page',
  pages: o.pages ?? [{ pageId: 'chrono01', documents }],
});

function rig(o: { checkMs?: number; workstream?: string | null } = {}) {
  const background = new BackgroundRunner();
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const gates: (() => void)[] = [];
  const chronology = {
    readiness: () => ({ ok: true as const, config }),
    check: async (_p: string, trigger: string) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      calls.push(`check ${trigger}`);
      if (o.checkMs !== undefined) await new Promise<void>((r) => gates.push(r));
      running--;
      return { summary: 'ok' };
    },
  };
  const seen: (string | null)[] = [];
  const automation = {
    runChronology: (_p: string, x?: { workstreamOf?: (age: string) => string | null }) => {
      calls.push('automation');
      seen.push(x?.workstreamOf?.('Fourth Arkonan Age') ?? null);
      return Promise.resolve();
    },
  };
  let delay = 10 * MIN;
  const hook = createAfterEdit({
    chronology,
    automation,
    background,
    delayMs: () => delay,
    workstreamOfJob: () => o.workstream ?? null,
  });
  return {
    background,
    calls,
    seen,
    hook,
    release: () => gates.splice(0).forEach((g) => g()),
    maxRunning: () => maxRunning,
    setDelay: (ms: number) => (delay = ms),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the check after an edit (C3)', () => {
  it('which documents count: the Main table, an age table, an age timeline, or the whole page', () => {
    expect(chronologyDocumentsTouched(config, change(['table004']))).toEqual(['Fourth Arkonan Age - Table']);
    expect(chronologyDocumentsTouched(config, change(['tline004']))).toEqual([
      'Fourth Arkonan Age - Timeline',
    ]);
    expect(chronologyDocumentsTouched(config, change(['main0001']))).toEqual(['Main']);
    expect(chronologyDocumentsTouched(config, change('all'))).toHaveLength(3);
    expect(chronologyDocumentsTouched(config, change(['other001']))).toEqual([]);
    expect(
      chronologyDocumentsTouched(
        config,
        change(['table004'], { pages: [{ pageId: 'elsewhere', documents: 'all' }] }),
      ),
    ).toEqual([]);
  });

  it('one check 10 minutes after the edit, then the automation on its findings', async () => {
    vi.useFakeTimers();
    const r = rig();
    expect(r.hook(PROJECT, change(['table004']))).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toEqual(['check after-edit', 'automation']);
    await r.background.stop();
  });

  it('a burst of edits gives one check, 10 minutes after the last; the delay is read on each use', async () => {
    vi.useFakeTimers();
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.hook(PROJECT, change(['table004'], { jobId: `job${i}` }));
      await vi.advanceTimersByTimeAsync(2 * MIN);
    }
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(8 * MIN);
    expect(r.calls).toEqual(['check after-edit', 'automation']);
    r.setDelay(MIN);
    r.hook(PROJECT, change(['main0001']));
    await vi.advanceTimersByTimeAsync(MIN);
    expect(r.calls.filter((c) => c.startsWith('check'))).toHaveLength(2);
    await r.background.stop();
  });

  it('another document, or the chronology’s own job, schedules nothing', async () => {
    vi.useFakeTimers();
    const r = rig();
    expect(r.hook(PROJECT, change(['other001']))).toBe(false);
    expect(r.hook(PROJECT, change(['table004'], { tool: 'sync_timeline_event' }))).toBe(false);
    expect(r.hook(PROJECT, change(['table004'], { tool: 'automation.chronology_wrong_kcy' }))).toBe(false);
    expect(r.hook(PROJECT, change(['table004'], { tool: 'create_timeline_event' }))).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(r.calls).toEqual([]);
    await r.background.stop();
  });

  it('one run at a time: an edit during a run gives exactly one more run after it', async () => {
    vi.useFakeTimers();
    const r = rig({ checkMs: 1 });
    r.hook(PROJECT, change(['table004']));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.calls).toEqual(['check after-edit']); // running, held
    r.hook(PROJECT, change(['table004']));
    r.hook(PROJECT, change(['tline004']));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    r.release();
    await vi.advanceTimersByTimeAsync(0);
    r.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.filter((c) => c.startsWith('check'))).toHaveLength(2);
    expect(r.maxRunning()).toBe(1);
    await r.background.stop();
  });

  it('a stop awaits the running check', async () => {
    const r = rig({ checkMs: 1 });
    r.background.trigger('x', 'noop', () => Promise.resolve(), { debounceMs: 0 });
    r.hook(PROJECT, change(['table004']));
    // Run it now rather than wait ten minutes: the same trigger with no delay.
    r.setDelay(1);
    r.hook(PROJECT, change(['table004']));
    await new Promise((res) => setTimeout(res, 20));
    expect(r.calls).toEqual(['check after-edit']);
    let stopped = false;
    const stop = r.background.stop(5_000).then(() => (stopped = true));
    await new Promise((res) => setTimeout(res, 20));
    expect(stopped).toBe(false);
    r.release();
    await stop;
    expect(stopped).toBe(true);
  });

  it('the repairs go to the workstream of the table edit that caused them (C5)', async () => {
    vi.useFakeTimers();
    const r = rig({ workstream: 'fourth-age-cleanup' });
    r.hook(PROJECT, change(['table004']));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.seen).toEqual(['fourth-age-cleanup']);
    await r.background.stop();
  });
});

describe('the nightly check, chained (C3)', () => {
  const ctx = (trigger: RunTrigger, now: number): MaintenanceContext => ({
    jobId: 'x',
    trigger,
    now,
    db: {} as never,
    project: { id: PROJECT, name: 'test' },
    run: () => Promise.reject(new Error('not used')),
  });
  const jobsWith = (state: { snapshot: boolean }, clock: FakeClock, calls: string[]) =>
    builtinJobs({
      engine: {} as never,
      projects: { activeIds: () => [PROJECT], anyClient: () => undefined },
      db: {} as never,
      proposals: { expireDue: () => 0, pruneFinished: () => ({ removed: 0, cutoff: 0 }) },
      proposalRetentionMs: 1,
      expirySweepMs: 300_000,
      chronology: {
        check: () => {
          calls.push(`check at ${clock.now()}`);
          return Promise.resolve({ summary: 'No findings.', changed: false });
        },
      },
      chain: {
        busy: nightChainBusy(
          {
            full: () => Promise.resolve({ summary: '' }),
            prune: () => Promise.resolve({ removed: 0, gc: { removed: 0, freed: 0, kept: 0 } }),
            verify: () => Promise.resolve({ summary: '', missing: 0, corrupt: 0, badManifests: 0 }),
            fullInProgress: () => state.snapshot,
          },
          { run: () => Promise.resolve({ summary: '', changed: false }), running: () => false },
        ),
        clock,
      },
    }).find((j) => j.id === 'chronology-check')!;

  it('nightly at 05:00 at P3 (it was weekly)', () => {
    const job = jobsWith({ snapshot: false }, new FakeClock(), []);
    expect(job.defaultSchedule).toEqual({ kind: 'daily', time: '05:00' });
    expect(job.budgetClass ?? 'P3').toBe('P3');
  });

  it('a scheduled run waits for the night’s full snapshot; a manual one goes at once', async () => {
    const clock = new FakeClock();
    const t0 = clock.now();
    const state = { snapshot: true };
    const calls: string[] = [];
    const job = jobsWith(state, clock, calls);
    let result: { summary: string } | undefined;
    const p = Promise.resolve(job.run!(ctx('schedule', t0))).then((r) => (result = r));
    await clock.advance(20 * MIN);
    expect(calls).toEqual([]);
    state.snapshot = false;
    await clock.advance(MIN);
    await p;
    expect(calls).toHaveLength(1);
    expect(result!.summary).toMatch(
      /^Waited \d+ min \(the night’s full snapshot was still running\)\. No findings\./,
    );
    state.snapshot = true;
    await job.run!(ctx('manual', clock.now()));
    expect(calls).toHaveLength(2);
  });
});

describe('a default schedule that comes round sooner', () => {
  let m: MaintenanceRig | undefined;
  afterEach(async () => {
    await m?.close();
    m = undefined;
  });
  it('a stored next run from the old weekly default is brought forward to the new default at start', async () => {
    m = await maintenanceRig({ start: false });
    const def = (schedule: MaintenanceJobDef['defaultSchedule']): MaintenanceJobDef => ({
      id: 'f10probe',
      name: 'Probe',
      description: 'A probe.',
      defaultSchedule: schedule,
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'bridge',
      run: () => ({ summary: 'ok' }),
    });
    const clock = m.rig.h.clock;
    const mk = (d: MaintenanceJobDef) =>
      new MaintenanceScheduler({
        db: m!.rig.db,
        engine: m!.rig.e.engine,
        projects: { activeIds: () => [], anyClient: () => undefined } as never,
        clock,
        settings: defaultMaintenanceSettings(),
        jobs: [d],
      });
    const weekly = mk(def({ kind: 'interval', everySeconds: 7 * 86_400 }));
    weekly.start();
    const before = weekly.list().find((j) => j.id === 'f10probe')!.nextRunAt!;
    await weekly.stop();
    expect(before - clock.now()).toBeGreaterThan(6 * 86_400_000);
    const nightly = mk(def({ kind: 'interval', everySeconds: 86_400 }));
    nightly.start();
    const after = nightly.list().find((j) => j.id === 'f10probe')!.nextRunAt!;
    await nightly.stop();
    expect(after - clock.now()).toBeLessThanOrEqual(86_400_000);
  });
});
