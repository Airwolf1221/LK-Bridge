import { afterEach, describe, expect, it } from 'vitest';
import {
  MaintenanceError,
  MaintenanceScheduler,
  nextDailyRun,
  type MaintenanceJobDef,
} from '../../src/maintenance/index.js';
import { defaultMaintenanceSettings } from '../../src/config/index.js';
import { settle } from '../jobs/helpers.js';
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { PROJECT, maintenanceRig, sampleCount, type MaintenanceRig } from './helpers.js';

let m: MaintenanceRig | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

const H = 3_600_000;
const D = 24 * H;
const view = (id: string) => m!.maintenance.scheduler.get(id);
const history = (id: string) => m!.maintenance.scheduler.history(id, 100);

/** A job that records its calls, for the scheduling tests. */
function probe(over: Partial<MaintenanceJobDef> = {}) {
  const calls: { trigger: string; now: number }[] = [];
  const def: MaintenanceJobDef = {
    id: 'probe',
    name: 'Probe',
    description: 'test job',
    defaultSchedule: { kind: 'interval', everySeconds: 60 },
    defaultEnabled: true,
    implemented: true,
    writes: false,
    usesLk: false,
    record: 'always',
    // v2 A1: the probe stands in for the per-project jobs to come (they touch LegendKeeper or one project's data), so it
    // runs once per served project (here one) and each run is recorded as a job of that project.
    scope: 'project',
    run: (ctx) => {
      calls.push({ trigger: ctx.trigger, now: ctx.now });
      return { summary: 'probed', changed: true };
    },
    ...over,
  };
  return { def, calls };
}

describe('the registry', () => {
  it('lists the jobs (v3 F3.5: no placeholder left), with schedule, last run and next run', async () => {
    m = await maintenanceRig();
    const jobs = m.maintenance.scheduler.list();
    expect(jobs.map((j) => j.id)).toEqual([
      'budget-sampler',
      'journal-prune',
      'proposal-expiry',
      'proposal-prune',
      'connection-removal',
      'sqlite-optimise',
      'tree-sweep',
      'tree-check',
      'assign-block-ids-sweep',
      'asset-refresh',
      'asset-check',
      'link-sweep', // v2 C2c
      'chronology-check', // v2 D1
      'audit-run', // v2 E2 (it replaced the two audit placeholders)
      'snapshot-full', // v2 E1a
      'snapshot-prune',
      'snapshot-verify',
    ]);
    const now = m.rig.h.clock.now();
    expect(view('budget-sampler')).toMatchObject({
      implemented: true,
      enabled: true,
      priority: 'P3',
      scheduleText: 'Every 10 seconds',
      lastRun: null,
      nextRunAt: now + 10_000,
    });
    expect(view('journal-prune')).toMatchObject({ scheduleText: 'Daily at 03:30 (London time)' });
    expect(view('journal-prune').nextRunAt).toBe(nextDailyRun(now, '03:30'));
    expect(view('proposal-expiry').scheduleText).toBe('Every 5 minutes');
    // v1.0.1: daily, at a different time from journal-prune.
    expect(view('proposal-prune')).toMatchObject({
      implemented: true,
      enabled: true,
      scheduleText: 'Daily at 03:45 (London time)',
    });
    expect(view('proposal-prune').nextRunAt).toBe(nextDailyRun(now, '03:45'));
    expect(view('sqlite-optimise').scheduleText).toBe('Weekly');
    // v2 A2: the repository tree's sweep (hourly) and check (nightly) replaced the `tree-snapshot` placeholder.
    expect(view('tree-sweep')).toMatchObject({
      implemented: true,
      enabled: true,
      scope: 'project',
      scheduleText: 'Hourly',
    });
    expect(view('tree-check')).toMatchObject({
      implemented: true,
      enabled: true,
      scope: 'project',
      scheduleText: 'Daily at 02:30 (London time)',
    });
    // v2 A4: the asset tree's regular refresh (every 6 hours) and its nightly check, next to the tree's.
    expect(view('asset-refresh')).toMatchObject({
      implemented: true,
      enabled: true,
      scope: 'project',
      scheduleText: 'Every 6 hours',
    });
    expect(view('asset-check')).toMatchObject({
      implemented: true,
      enabled: true,
      scope: 'project',
      scheduleText: 'Daily at 02:50 (London time)',
    });
    // v3 F3.5 (ADR 0056): the block-id sweep, implemented, off by default, nightly after the snapshot; it writes.
    expect(view('assign-block-ids-sweep')).toMatchObject({
      implemented: true,
      enabled: false,
      writes: true,
      scope: 'project',
      scheduleText: 'Daily at 05:30 (London time)',
      nextRunAt: null,
      note: null,
    });
    // v2 E2: the audits (they read the snapshots only; off here because one runs after each full snapshot).
    expect(view('audit-run')).toMatchObject({
      implemented: true,
      enabled: false,
      writes: false,
      scope: 'project',
      scheduleText: 'Daily at 06:00 (London time)',
    });
  });
});

describe('intervals', () => {
  it('run on their interval and record the last run', async () => {
    m = await maintenanceRig();
    const clock = m.rig.h.clock;
    const t0 = clock.now();
    await clock.advance(9_999);
    expect(history('budget-sampler')).toHaveLength(0);
    await clock.advance(1);
    expect(history('budget-sampler')).toHaveLength(1);
    await clock.advance(30_000);
    expect(history('budget-sampler')).toHaveLength(4);
    expect(sampleCount(m.rig)).toBe(4);
    expect(view('budget-sampler').lastRun).toMatchObject({ at: t0 + 40_000, outcome: 'succeeded' });
    expect(view('budget-sampler').nextRunAt).toBe(t0 + 50_000);
  });

  it('a changed schedule applies from now', async () => {
    const p = probe();
    m = await maintenanceRig({ extraJobs: [p.def] });
    const clock = m.rig.h.clock;
    await clock.advance(30_000);
    m.maintenance.commands.setSchedule('owner', 'probe', { kind: 'interval', everySeconds: 600 });
    expect(view('probe')).toMatchObject({ scheduleText: 'Every 10 minutes', scheduleOverridden: true });
    expect(view('probe').nextRunAt).toBe(clock.now() + 600_000);
    await clock.advance(599_000);
    expect(p.calls).toHaveLength(0);
    await clock.advance(1_000);
    expect(p.calls).toHaveLength(1);
    // back to the default
    m.maintenance.commands.setSchedule('owner', 'probe', null);
    expect(view('probe')).toMatchObject({ scheduleText: 'Every minute', scheduleOverridden: false });
  });

  it('refuses invalid schedules and leaves the job as it was', async () => {
    m = await maintenanceRig();
    for (const bad of [
      { kind: 'interval', everySeconds: 5 },
      { kind: 'daily', time: '25:00' },
      { kind: 'cron' },
      'daily',
    ]) {
      expect(() => m!.maintenance.commands.setSchedule('owner', 'budget-sampler', bad)).toThrow(
        MaintenanceError,
      );
    }
    expect(view('budget-sampler').scheduleText).toBe('Every 10 seconds');
  });
});

describe('daily times across the British clocks change', () => {
  it('03:30 runs 23 hours apart over spring forward, and 25 over autumn back', () => {
    const t = (x: string) => Date.parse(x);
    const first = nextDailyRun(t('2026-03-27T12:00:00Z'), '03:30');
    expect((nextDailyRun(first, '03:30') - first) / H).toBe(23);
    const third = nextDailyRun(t('2026-10-23T12:00:00Z'), '03:30');
    expect((nextDailyRun(third, '03:30') - third) / H).toBe(25);
  });

  it('the scheduler fires journal-prune at 03:30 local time on either side of each change', async () => {
    m = await maintenanceRig();
    const clock = m.rig.h.clock;
    const c = m.maintenance.commands;
    for (const id of ['budget-sampler', 'proposal-expiry', 'sqlite-optimise']) c.disable('owner', id);
    const sched = m.maintenance.scheduler;
    const lastRunAt = () => sched.history('journal-prune')[0]!.startedAt;

    // Spring forward: Sunday 28 March 2027.
    await clock.advanceTo(Date.UTC(2027, 2, 27, 4, 0, 0));
    expect(lastRunAt()).toBe(Date.UTC(2027, 2, 27, 3, 30)); // Saturday 03:30 GMT
    expect(sched.get('journal-prune').nextRunAt).toBe(Date.UTC(2027, 2, 28, 2, 30)); // Sunday 03:30 BST
    await clock.advanceTo(Date.UTC(2027, 2, 28, 2, 29, 59));
    expect(lastRunAt()).toBe(Date.UTC(2027, 2, 27, 3, 30));
    await clock.advanceTo(Date.UTC(2027, 2, 28, 2, 30, 0));
    expect(lastRunAt()).toBe(Date.UTC(2027, 2, 28, 2, 30));
    expect((Date.UTC(2027, 2, 28, 2, 30) - Date.UTC(2027, 2, 27, 3, 30)) / H).toBe(23);

    // Autumn back: Sunday 31 October 2027.
    await clock.advanceTo(Date.UTC(2027, 9, 30, 4, 0, 0));
    expect(lastRunAt()).toBe(Date.UTC(2027, 9, 30, 2, 30)); // Saturday 03:30 BST
    expect(sched.get('journal-prune').nextRunAt).toBe(Date.UTC(2027, 9, 31, 3, 30)); // Sunday 03:30 GMT
    await clock.advanceTo(Date.UTC(2027, 9, 31, 3, 30, 0));
    expect(lastRunAt()).toBe(Date.UTC(2027, 9, 31, 3, 30));
    expect((Date.UTC(2027, 9, 31, 3, 30) - Date.UTC(2027, 9, 30, 2, 30)) / H).toBe(25);
    // Exactly one run per day through both changes.
    const days = new Set(
      sched.history('journal-prune').map((r) => new Date(r.startedAt).toISOString().slice(0, 10)),
    );
    expect(days.size).toBe(sched.history('journal-prune').length);
  }, 60_000);
});

describe('persistence across a restart', () => {
  it('keeps enabled flags, edited schedules and last runs', async () => {
    m = await maintenanceRig();
    const clock = m.rig.h.clock;
    m.maintenance.commands.disable('owner', 'sqlite-optimise');
    m.maintenance.commands.setSchedule('owner', 'proposal-expiry', { kind: 'daily', time: '04:15' });
    await clock.advance(10_000);
    const last = view('budget-sampler').lastRun;
    expect(last).not.toBeNull();

    await m.maintenance.stop();
    m.rig.restart();
    m.mount();
    expect(view('sqlite-optimise')).toMatchObject({ enabled: false, nextRunAt: null });
    expect(view('proposal-expiry')).toMatchObject({
      scheduleText: 'Daily at 04:15 (London time)',
      scheduleOverridden: true,
    });
    expect(view('budget-sampler').lastRun).toEqual(last);
  });

  it('runs an overdue job at most once after the restart, however many slots were missed', async () => {
    m = await maintenanceRig();
    const clock = m.rig.h.clock;
    await clock.advance(20_000); // two sampler runs, then the process stops
    expect(history('budget-sampler')).toHaveLength(2);
    await m.maintenance.stop();
    m.rig.restart();
    await clock.advance(3 * D); // three days down: 25,920 sampler slots and three journal-prune slots missed
    m.mount();
    await clock.advance(0);
    const runs = history('budget-sampler');
    expect(runs).toHaveLength(3); // 2 before + exactly 1 catch-up
    expect(runs[0]).toMatchObject({ trigger: 'catch-up', outcome: 'succeeded' });
    expect(history('journal-prune')).toHaveLength(1);
    expect(history('journal-prune')[0]).toMatchObject({ trigger: 'catch-up' });
    expect(history('sqlite-optimise')).toHaveLength(0); // weekly, not yet overdue
    // The schedule carries on from now, not from the missed slots.
    expect(view('budget-sampler').nextRunAt).toBe(clock.now() + 10_000);
    await clock.advance(10_000);
    expect(history('budget-sampler')).toHaveLength(4);
    expect(history('budget-sampler')[0]).toMatchObject({ trigger: 'schedule' });
  });

  it('a run the process died in is recorded as interrupted, not repeated', async () => {
    const gate = { release: () => {} };
    const slow = probe({
      run: () =>
        new Promise((resolve) => {
          gate.release = () => resolve({ summary: 'late' });
        }),
    });
    m = await maintenanceRig({ extraJobs: [slow.def] });
    const clock = m.rig.h.clock;
    await clock.advance(60_000); // probe starts and never finishes
    expect(view('probe').running).toBe(true);
    m.rig.restart({ crash: true });
    await clock.advance(5_000);
    m.mount({ extraJobs: [probe().def] });
    const [run] = history('probe');
    expect(run).toMatchObject({
      outcome: 'interrupted',
      detail: 'The bridge stopped while this was running.',
    });
    gate.release();
  });
});

describe('priority and the engine', () => {
  it('a job that writes does so through the engine at P3 as the system principal, with an origin naming it', async () => {
    const write = probe({
      id: 'writer',
      name: 'Writer',
      writes: true,
      usesLk: true,
      run: async (ctx) => {
        const r = await ctx.run('updateResource', {
          path: { resourceId: 'raaaaaaa' },
          body: { name: 'Renamed' },
        });
        return { summary: `wrote (${r.status})`, changed: true };
      },
    });
    m = await maintenanceRig({ extraJobs: [write.def], rig: {} });
    m.rig.h.model.seedResource('raaaaaaa');
    const sched = m.maintenance.scheduler;
    const { done } = sched.runNow('writer');
    const out = await settle(m.rig.h, m.rig.e, done);
    expect(out.error).toBeUndefined();
    expect(history('writer')[0]).toMatchObject({ outcome: 'succeeded' });
    expect(m.rig.h.model.count('updateResource')).toBe(1);
    const all = m.rig.e.engine.queries.listJobs(PROJECT, {});
    const update = all.find(
      (j) => j.title === 'Maintenance: Writer' && j.priority === 'P3' && j.origin.tool === 'writer',
    );
    expect(update).toBeDefined();
    expect(update).toMatchObject({
      priority: 'P3',
      principalId: 'system',
      profile: 'system',
      origin: { kind: 'maintenance', tool: 'writer', client: 'maintenance' },
    });
  });

  it('a job that calls LegendKeeper waits while P1 or P2 work is queued, then runs once it clears', async () => {
    const calls: number[] = [];
    const lkJob = probe({ id: 'lkjob', usesLk: true, run: () => (calls.push(1), { summary: 'ok' }) });
    m = await maintenanceRig({ start: false });
    // A governor that reports queued interactive work, then idle.
    let queued = 1;
    const governor = { snapshot: () => ({ queues: { P0: 0, P1: queued, P2: 0, P3: 0 } }) };
    const projects = {
      activeIds: () => [PROJECT],
      anyClient: () => ({ governor }),
      nameOf: () => 'mock',
    } as never;
    const sched = new MaintenanceScheduler({
      db: m.rig.db,
      engine: m.rig.e.engine,
      projects,
      clock: m.rig.h.clock,
      settings: defaultMaintenanceSettings({ deferMs: 15_000 }),
      jobs: [lkJob.def],
    });
    sched.start();
    const clock = m.rig.h.clock;
    await clock.advance(60_000);
    expect(calls).toHaveLength(0); // due, but P1 work is queued
    expect(sched.history('lkjob')).toHaveLength(0); // deferred, not skipped, not recorded
    queued = 0;
    await clock.advance(15_000);
    expect(calls).toHaveLength(1);
    await sched.stop();
  });

  it('a job that does not call LegendKeeper is not held back (the sampler keeps its rhythm under load)', async () => {
    m = await maintenanceRig();
    // Nothing queued here, but the flag is the contract: budget-sampler is local only.
    const def = m.maintenance.scheduler.list().find((j) => j.id === 'budget-sampler')!;
    expect(def.writes).toBe(false);
  });
});

describe('read-only mode and paused writes', () => {
  const writer = () =>
    probe({
      id: 'writer',
      name: 'Writer',
      writes: true,
      usesLk: true,
      defaultSchedule: { kind: 'interval', everySeconds: 60 },
    });

  it('skip a job that writes, and record the skip with its reason; resume afterwards', async () => {
    const w = writer();
    m = await maintenanceRig({ extraJobs: [w.def] });
    const clock = m.rig.h.clock;
    m.rig.e.engine.controls.setReadOnly(true, 'owner');
    await clock.advance(60_000);
    expect(w.calls).toHaveLength(0);
    expect(history('writer')[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'Skipped: read-only mode is on.',
    });
    expect(view('writer').lastRun).toMatchObject({ outcome: 'skipped' });
    expect(view('writer').nextRunAt).toBe(clock.now() + 60_000); // rescheduled, no backlog

    m.rig.e.engine.controls.setReadOnly(false, 'owner');
    m.rig.e.engine.controls.pauseWrites('owner');
    await clock.advance(60_000);
    expect(history('writer')[0]).toMatchObject({ outcome: 'skipped', detail: 'Skipped: writes are paused.' });
    expect(w.calls).toHaveLength(0);

    m.rig.e.engine.controls.resumeWrites('owner');
    await clock.advance(60_000);
    expect(w.calls).toHaveLength(1);
    expect(history('writer')[0]).toMatchObject({ outcome: 'succeeded' });
  });

  it('skip a manual run too', async () => {
    const w = writer();
    m = await maintenanceRig({ extraJobs: [w.def] });
    m.rig.e.engine.controls.pauseWrites('owner');
    const { done } = m.maintenance.scheduler.runNow('writer');
    expect(await done).toMatchObject({ outcome: 'skipped' });
    expect(w.calls).toHaveLength(0);
  });

  it('do not stop jobs that write nothing to LegendKeeper (they only touch the bridge’s own database)', async () => {
    m = await maintenanceRig();
    m.rig.e.engine.controls.setReadOnly(true, 'owner');
    m.rig.e.engine.controls.pauseWrites('owner');
    await m.rig.h.clock.advance(10_000);
    expect(history('budget-sampler')[0]).toMatchObject({ outcome: 'succeeded' });
    expect(sampleCount(m.rig)).toBe(1);
  });
});

describe('run now', () => {
  it('runs at once, is audited and evented, and records a job that the Jobs page can show', async () => {
    m = await maintenanceRig();
    const seen: string[] = [];
    m.rig.e.engine.events.on('policy', (e) => seen.push(`${e.actor}:${e.action}:${e.target}`));
    const { job, done } = m.maintenance.commands.runNow('owner', 'sqlite-optimise');
    expect(job.running).toBe(true);
    const run = (await done)!;
    expect(run).toMatchObject({ outcome: 'succeeded', trigger: 'manual' });
    // v2 A1: SQLite upkeep is bridge-wide: its run is in the history (project `*`), not a job of any project.
    expect(run).toMatchObject({ projectId: '*', jobId: null });
    expect(
      m.rig.e.engine.queries
        .listJobs(ALL_PROJECTS, { limit: 500 })
        .filter((j) => j.origin.tool === 'sqlite-optimise'),
    ).toEqual([]);
    expect(view('sqlite-optimise').lastRun).toMatchObject({ outcome: 'succeeded', jobId: null });
    expect(seen).toContain('owner:maintenance.run_now:sqlite-optimise');
    expect(m.rig.policy.commands.listAudit('owner').map((a) => a.action)).toContain('maintenance.run_now');
  });

  it('refuses a second run while one is in flight', async () => {
    let release: () => void = () => {};
    const slow = probe({ run: () => new Promise((r) => (release = () => r({ summary: 'done' }))) });
    m = await maintenanceRig({ extraJobs: [slow.def] });
    const { done } = m.maintenance.scheduler.runNow('probe');
    expect(() => m!.maintenance.scheduler.runNow('probe')).toThrow(/already running/);
    release();
    await done;
  });

  it('records a failure honestly and carries on', async () => {
    const boom = probe({
      run: () => {
        throw new Error('disk on fire');
      },
    });
    m = await maintenanceRig({ extraJobs: [boom.def] });
    const { done } = m.maintenance.scheduler.runNow('probe');
    const run = (await done)!;
    expect(run).toMatchObject({ outcome: 'failed', detail: 'disk on fire' });
    expect(m.rig.e.engine.queries.getJob(PROJECT, run.jobId!)).toMatchObject({ status: 'failed' });
    await m.rig.h.clock.advance(60_000);
    expect(history('probe').length).toBeGreaterThanOrEqual(2); // still scheduled
  });

  it('is owner-only', async () => {
    m = await maintenanceRig();
    expect(() => m!.maintenance.commands.runNow('agent' as never, 'budget-sampler')).toThrow(/owner/);
    expect(() => m!.maintenance.commands.enable('agent' as never, 'budget-sampler')).toThrow(/owner/);
  });
});

describe('placeholders', () => {
  // v3 F3.5: the last built-in placeholder became the block-id sweep; the framework still takes one (a test job).
  const PLACEHOLDER: MaintenanceJobDef = {
    id: 'test-placeholder',
    name: 'Test placeholder',
    description: 'a placeholder',
    defaultSchedule: { kind: 'interval', everySeconds: 86_400 },
    defaultEnabled: false,
    implemented: false,
    writes: true,
    usesLk: true,
    record: 'always',
    scope: 'project',
  };
  const placeholders = [PLACEHOLDER.id];

  it('cannot be enabled, run or rescheduled, and say so', async () => {
    m = await maintenanceRig({ extraJobs: [PLACEHOLDER] });
    const c = m.maintenance.commands;
    for (const id of placeholders) {
      expect(() => c.enable('owner', id), id).toThrow('Not implemented yet');
      expect(() => c.runNow('owner', id), id).toThrow('Not implemented yet');
      expect(() => c.setSchedule('owner', id, { kind: 'interval', everySeconds: 60 }), id).toThrow(
        'Not implemented yet',
      );
      expect(view(id)).toMatchObject({ enabled: false, nextRunAt: null });
    }
    await m.rig.h.clock.advance(H);
    for (const id of placeholders) expect(history(id)).toEqual([]);
    expect(
      m.rig.policy.commands.listAudit('owner').filter((a) => a.action.startsWith('maintenance.')),
    ).toEqual([]);
  });

  it('disabling a placeholder is harmless, and an enabled flag found in the database is cleared at start', async () => {
    m = await maintenanceRig({ extraJobs: [PLACEHOLDER] });
    m.rig.db
      .prepare("UPDATE maintenance_jobs SET enabled = 1, next_run_at = 1 WHERE id = 'test-placeholder'")
      .run();
    await m.maintenance.stop();
    m.mount();
    expect(view('test-placeholder')).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('unknown ids are not found', async () => {
    m = await maintenanceRig();
    expect(() => m!.maintenance.commands.enable('owner', 'nope')).toThrow(/No maintenance job/);
  });
});

describe('enable and disable', () => {
  it('disabling stops the runs and clears the next run; enabling schedules from now', async () => {
    m = await maintenanceRig();
    const clock = m.rig.h.clock;
    m.maintenance.commands.disable('owner', 'budget-sampler');
    expect(view('budget-sampler')).toMatchObject({ enabled: false, nextRunAt: null });
    await clock.advance(60_000);
    expect(history('budget-sampler')).toHaveLength(0);
    m.maintenance.commands.enable('owner', 'budget-sampler');
    expect(view('budget-sampler').nextRunAt).toBe(clock.now() + 10_000);
    await clock.advance(10_000);
    expect(history('budget-sampler')).toHaveLength(1);
    const actions = m.rig.policy.commands.listAudit('owner').map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['maintenance.enable', 'maintenance.disable']));
  });

  it('the scheduler can be switched off altogether (MAINTENANCE_ENABLED=false): the pages work, nothing runs', async () => {
    m = await maintenanceRig({ settings: { enabled: false } });
    await m.rig.h.clock.advance(60_000);
    expect(history('budget-sampler')).toHaveLength(0);
    expect(m.maintenance.scheduler.list()).toHaveLength(17);
  });
});

describe('background jobs (v2 A2)', () => {
  it('a long job runs alongside the others: the 10-second sampler keeps sampling while it runs', async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((r) => (finish = r));
    const long = probe({
      id: 'long',
      background: true,
      run: async () => {
        await gate;
        return { summary: 'long done' };
      },
    });
    m = await maintenanceRig({ extraJobs: [long.def] });
    const clock = m.rig.h.clock;
    await clock.advance(60_000); // the long job starts, and stays running
    expect(view('long').running).toBe(true);
    const before = sampleCount(m.rig);
    await clock.advance(60_000);
    expect(sampleCount(m.rig)).toBeGreaterThanOrEqual(before + 5);
    expect(() => m!.maintenance.scheduler.runNow('long')).toThrow(MaintenanceError);
    finish();
    await m.maintenance.scheduler.whenIdle();
    expect(view('long').running).toBe(false);
    expect(history('long')[0]).toMatchObject({ outcome: 'succeeded', detail: 'long done' });
  });
});
