/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies */
/**
 * v2 E5.1 (the owner's report of 15 November 2026): a per-project maintenance job (`scope: 'project'`) runs once per
 * served project, one after another. Run now with Arkona selected ran `test` first and Arkona second, and the page showed
 * `test`'s result and job link while Arkona's pass was still running. Now:
 *
 * - Run now with a project runs that project only (and leaves the schedule, which covers every project, alone);
 * - without one, it runs every project, as before; a bridge-wide job ignores a project;
 * - the view shows each project's last run and which project is running now;
 * - each run's job link carries its own project (the run's `projectId`, the history rows' `projectId`);
 * - the scheduled run still covers every project.
 *
 * Two mock projects (`alpha`, `beta`) behind one real bridge; a test job that waits until released, so "running" can be
 * seen. No live system.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMaintenanceSettings } from '../../src/config/index.js';
import { systemClock, type Clock } from '../../src/lk/index.js';
import { MaintenanceScheduler, type MaintenanceJobDef } from '../../src/maintenance/index.js';
import { IDS, startTwoProjects, type TwoProjects } from '../projects/helpers.js';

let t: TwoProjects;
beforeAll(async () => {
  t = await startTwoProjects();
});
afterAll(async () => t.close());

/** A per-project job that records each project it ran for, and waits for `release` when `hold` is set. */
function heldJob(id: string, scope: 'project' | 'bridge' = 'project') {
  const ran: (string | null)[] = [];
  let hold = false;
  const waiting: (() => void)[] = [];
  const def: MaintenanceJobDef = {
    id,
    name: `Held job ${id}`,
    description: 'A test job.',
    defaultSchedule: { kind: 'interval', everySeconds: 3600 },
    defaultEnabled: false,
    implemented: true,
    writes: false,
    usesLk: false,
    scope,
    record: 'always',
    run: async (ctx) => {
      ran.push(ctx.project?.id ?? null);
      if (hold) await new Promise<void>((r) => waiting.push(r));
      return { summary: `ran for ${ctx.project?.name ?? 'the bridge'}` };
    },
  };
  return {
    def,
    ran,
    holdNext: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const r of waiting.splice(0)) r();
    },
    waitingCount: () => waiting.length,
  };
}

/** A clock that can be moved forward (timers are the system's). */
function shiftingClock(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => systemClock.now() + offset,
    setTimeout: (fn, ms) => systemClock.setTimeout(fn, ms),
    clearTimeout: (h) => systemClock.clearTimeout(h),
    advance: (ms) => {
      offset += ms;
    },
  };
}

function scheduler(jobs: MaintenanceJobDef[], clock: Clock = systemClock) {
  return new MaintenanceScheduler({
    db: t.stack.db,
    engine: t.stack.runtime.engine,
    projects: t.stack.runtime.projects,
    clock,
    settings: defaultMaintenanceSettings({ enabled: true }),
    jobs,
  });
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('Run now for one project', () => {
  it('runs only that project, shows it as running, then its result, and leaves the schedule alone', async () => {
    const j = heldJob('held-one');
    const s = scheduler([j.def]);
    s.setEnabled(j.def.id, true);
    const nextBefore = s.get(j.def.id).nextRunAt;
    j.holdNext();
    const { done, projectId } = s.runNow(j.def.id, IDS.beta);
    expect(projectId).toBe(IDS.beta);
    await until(() => j.waitingCount() === 1);
    const running = s.get(j.def.id);
    expect(running).toMatchObject({ running: true, runningProjectId: IDS.beta });
    expect(running.projects?.find((p) => p.projectId === IDS.beta)).toMatchObject({
      project: 'beta',
      running: true,
    });
    expect(running.projects?.find((p) => p.projectId === IDS.alpha)).toMatchObject({ running: false });
    // A second Run now while it runs is refused.
    expect(() => s.runNow(j.def.id, IDS.alpha)).toThrow(/already running/);
    j.release();
    const r = await done;
    expect(j.ran).toEqual([IDS.beta]);
    expect(r).toMatchObject({ projectId: IDS.beta, outcome: 'succeeded' });
    const after = s.get(j.def.id);
    expect(after).toMatchObject({ running: false, runningProjectId: null });
    expect(after.lastRun).toMatchObject({ projectId: IDS.beta, detail: 'ran for beta' });
    expect(after.lastRun?.jobId).toBeTruthy();
    const beta = after.projects!.find((p) => p.projectId === IDS.beta)!;
    expect(beta.lastRun).toMatchObject({ projectId: IDS.beta, outcome: 'succeeded', detail: 'ran for beta' });
    expect(after.projects!.find((p) => p.projectId === IDS.alpha)!.lastRun).toBeNull();
    // The run's engine job belongs to beta, and the history narrowed to beta has it; alpha's has nothing.
    expect(t.stack.runtime.engine.queries.getJob(IDS.beta, beta.lastRun!.jobId!)).toBeTruthy();
    expect(t.stack.runtime.engine.queries.getJob(IDS.alpha, beta.lastRun!.jobId!)).toBeFalsy();
    expect(s.history(j.def.id, 20, IDS.beta)).toHaveLength(1);
    expect(s.history(j.def.id, 20, IDS.alpha)).toHaveLength(0);
    // The schedule, which covers every project, is not moved by a run for one project.
    expect(after.nextRunAt).toBe(nextBefore);
    await s.stop();
  });

  it('without a project runs every project, one after another, as before; each project shows its own result', async () => {
    const j = heldJob('held-all');
    const s = scheduler([j.def]);
    j.holdNext();
    const { done, projectId } = s.runNow(j.def.id);
    expect(projectId).toBeNull();
    await until(() => j.waitingCount() === 1);
    // The first project (alpha) is the one running; beta waits its turn.
    expect(s.get(j.def.id).runningProjectId).toBe(IDS.alpha);
    j.release();
    await done;
    expect(j.ran).toEqual([IDS.alpha, IDS.beta]);
    const v = s.get(j.def.id);
    expect(v.projects!.map((p) => [p.project, p.lastRun?.detail])).toEqual([
      ['alpha', 'ran for alpha'],
      ['beta', 'ran for beta'],
    ]);
    // The history of every project names each run's project.
    expect(s.history(j.def.id).map((h) => h.projectId)).toEqual([IDS.beta, IDS.alpha]);
    await s.stop();
  });

  it('a bridge-wide job ignores the project', async () => {
    const j = heldJob('held-bridge', 'bridge');
    const s = scheduler([j.def]);
    const { done, projectId } = s.runNow(j.def.id, IDS.beta);
    expect(projectId).toBeNull();
    await done;
    expect(j.ran).toEqual([null]);
    expect(s.get(j.def.id).projects).toBeUndefined();
    await s.stop();
  });

  it('refuses a project the bridge does not serve', async () => {
    const j = heldJob('held-unknown');
    const s = scheduler([j.def]);
    expect(() => s.runNow(j.def.id, 'lkp_nowhere')).toThrow(/not served/);
    expect(j.ran).toEqual([]);
    await s.stop();
  });

  it('the scheduled run is unchanged: it covers every project', async () => {
    const clock = shiftingClock();
    const j = heldJob('held-scheduled');
    const s = scheduler([j.def], clock);
    s.setEnabled(j.def.id, true);
    clock.advance(3_600_000 + 1000);
    await s.tick();
    await s.whenIdle();
    expect(j.ran).toEqual([IDS.alpha, IDS.beta]);
    expect(s.history(j.def.id).map((h) => h.trigger)).toEqual(['schedule', 'schedule']);
    expect(s.get(j.def.id).nextRunAt!).toBeGreaterThan(clock.now());
    await s.stop();
  });
});

describe('the dashboard routes', () => {
  it('Run now with a project runs that project only; the audit names it; GET /maintenance shows each project', async () => {
    // chronology-check is per project and, with no chronology confirmed, finishes at once (skipped) without a request.
    const r = await t.admin.post('/maintenance/chronology-check/run', { project: 'beta' });
    expect(r.status, r.text).toBe(202);
    await t.stack.runtime.maintenance.scheduler.whenIdle();
    const runs = t.stack.runtime.maintenance.scheduler.history('chronology-check');
    expect(runs.map((x) => x.projectId)).toEqual([IDS.beta]);
    const audit = t.stack.runtime.policy.store.listAudit({ action: 'maintenance.run_now' });
    expect(audit[0]).toMatchObject({
      target: 'chronology-check',
      after: { project: 'beta', projectId: IDS.beta },
    });

    const list = await t.admin.get('/maintenance');
    const job = (list.json.jobs as Record<string, unknown>[]).find((x) => x.id === 'chronology-check')!;
    expect(job).toMatchObject({ scope: 'project', running: false, runningProjectId: null });
    expect(job.lastRun).toMatchObject({ projectId: IDS.beta });
    const lines = job.projects as { project: string; lastRun: unknown }[];
    expect(lines.map((l) => l.project)).toEqual(['alpha', 'beta']);
    expect(lines.find((l) => l.project === 'alpha')!.lastRun).toBeNull();
    expect(lines.find((l) => l.project === 'beta')!.lastRun).toMatchObject({ projectId: IDS.beta });
  });

  it('without a project, every project; the history narrows to the selected project, or names each row', async () => {
    const r = await t.admin.post('/maintenance/chronology-check/run');
    expect(r.status, r.text).toBe(202);
    await t.stack.runtime.maintenance.scheduler.whenIdle();
    const all = await t.admin.get('/maintenance/chronology-check');
    const rows = all.json.job.history as { projectId: string }[];
    expect(rows.map((x) => x.projectId)).toEqual([IDS.beta, IDS.alpha, IDS.beta]);
    const alpha = await t.admin.get('/maintenance/chronology-check?project=alpha');
    expect((alpha.json.job.history as { projectId: string }[]).map((x) => x.projectId)).toEqual([IDS.alpha]);
    const audit = t.stack.runtime.policy.store.listAudit({ action: 'maintenance.run_now' });
    expect(audit[0]).toMatchObject({ after: { project: 'all' } });
  });

  it('refuses an unknown project, and a bridge-wide job ignores a project', async () => {
    const bad = await t.admin.post('/maintenance/chronology-check/run', { project: 'nowhere' });
    expect(bad.status).toBe(400);
    const bridge = await t.admin.post('/maintenance/sqlite-optimise/run', { project: 'beta' });
    expect(bridge.status, bridge.text).toBe(202);
    await t.stack.runtime.maintenance.scheduler.whenIdle();
    expect(t.stack.runtime.maintenance.scheduler.history('sqlite-optimise', 1)[0]!.projectId).toBe('*');
  });
});
