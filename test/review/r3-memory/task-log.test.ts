/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers in object literals */
/**
 * CR-2026-11-R3, R3-65 (the owner's follow-up): the live bridge's memory stepped up by 74 MB between 17:15 and 17:20 with
 * no request logged, and nothing said which background task ran then. Every scheduled or background task now logs its
 * start and finish at info with the memory (`src/maintenance/task-log.ts`); one that runs every minute or more often
 * only when memory moved or it failed. On the reviewed code a maintenance run logged nothing at all (its record was in
 * the database, without the memory). Mocks only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultMaintenanceSettings } from '../../../src/config/index.js';
import { systemClock } from '../../../src/lk/index.js';
import { MaintenanceScheduler, type MaintenanceJobDef } from '../../../src/maintenance/index.js';
import { loggedTask } from '../../../src/maintenance/task-log.js';
import { IDS, startTwoProjects, type TwoProjects } from '../../projects/helpers.js';

type Line = { obj: Record<string, unknown>; msg: string };
const logger = () => {
  const lines: Line[] = [];
  return {
    lines,
    info: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg: `warn: ${msg}` }),
  };
};

describe('R3-65: background tasks log their start and finish with the memory', () => {
  it('a task: started and finished, each with heapUsedMb and rssMb; the finish with ms, outcome and delta', async () => {
    const log = logger();
    const r = await loggedTask(log, 'a test task', { project: 'p1' }, () => Promise.resolve(42));
    expect(r).toBe(42);
    expect(log.lines.map((l) => l.msg)).toEqual(['task started', 'task finished']);
    const [start, finish] = log.lines;
    expect(start!.obj).toMatchObject({ task: 'a test task', project: 'p1' });
    expect(start!.obj.memory).toEqual({ heapUsedMb: expect.any(Number), rssMb: expect.any(Number) });
    expect(finish!.obj).toMatchObject({ task: 'a test task', project: 'p1', outcome: 'succeeded' });
    expect(finish!.obj.ms).toEqual(expect.any(Number));
    expect(finish!.obj.delta).toEqual({ heapUsedMb: expect.any(Number), rssMb: expect.any(Number) });
  });

  it('a failure is logged as failed, and still thrown', async () => {
    const log = logger();
    await expect(loggedTask(log, 'failing', {}, () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(log.lines.at(-1)!.obj).toMatchObject({ task: 'failing', outcome: 'failed' });
  });

  it('a quiet task logs only when memory moved by 1 MB or more, or it failed', async () => {
    const log = logger();
    const mem = { rss: 500 * 1048576, heapUsed: 200 * 1048576 };
    const spy = vi
      .spyOn(process, 'memoryUsage')
      .mockImplementation(() => ({ ...mem, heapTotal: 0, external: 0, arrayBuffers: 0 }));
    try {
      await loggedTask(log, 'quiet still', {}, () => undefined, { quiet: true });
      expect(log.lines).toEqual([]);
      await loggedTask(
        log,
        'quiet moved',
        {},
        () => {
          mem.rss += 5 * 1048576;
        },
        { quiet: true },
      );
      expect(log.lines.map((l) => l.msg)).toEqual(['task finished']);
      expect(log.lines[0]!.obj).toMatchObject({
        task: 'quiet moved',
        delta: { heapUsedMb: 0, rssMb: 5 },
        before: { heapUsedMb: 200, rssMb: 500 },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

let t: TwoProjects;
beforeAll(async () => {
  t = await startTwoProjects();
});
afterAll(async () => t.close());

describe('R3-65: a maintenance run is a background task', () => {
  it('Run now logs its start and finish, with the job, the project and the memory', async () => {
    const log = logger();
    const def: MaintenanceJobDef = {
      id: 'r365-logged',
      name: 'A logged job',
      description: 'A test job.',
      defaultSchedule: { kind: 'interval', everySeconds: 3600 },
      defaultEnabled: false,
      implemented: true,
      writes: false,
      usesLk: false,
      scope: 'project',
      record: 'always',
      run: () => Promise.resolve({ summary: 'ran' }),
    };
    const s = new MaintenanceScheduler({
      db: t.stack.db,
      engine: t.stack.runtime.engine,
      projects: t.stack.runtime.projects,
      clock: systemClock,
      settings: defaultMaintenanceSettings({ enabled: true }),
      jobs: [def],
      log,
    });
    const { done } = s.runNow(def.id, IDS.alpha);
    await done;
    const mine = log.lines.filter((l) => l.obj.task === 'maintenance:r365-logged');
    // On the reviewed code: nothing logged.
    expect(mine.map((l) => l.msg)).toEqual(['task started', 'task finished']);
    expect(mine[0]!.obj).toMatchObject({ project: IDS.alpha, trigger: 'manual' });
    expect(mine[1]!.obj).toMatchObject({ outcome: 'succeeded', memory: { heapUsedMb: expect.any(Number) } });
    await s.stop();
  });
});
