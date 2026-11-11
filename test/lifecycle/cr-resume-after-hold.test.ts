/**
 * CR-2026-11, finding CR-06: a job that holds its page's lock (a job-level lock) checks the page with `bridge.expect`
 * inside the lock, then writes. When the job is held (writes paused, read-only) or parked for budget AFTER the check and
 * BEFORE its first write, it releases the lock; an edit made meanwhile must not be overwritten when it resumes. The
 * check runs again when the job takes the lock again, as long as nothing has been written yet.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
beforeAll(async () => {
  w = await lifecycleWorld();
});
afterAll(async () => w.close());

/** The bridge's own work (the system principal), so the policy gate lets the internal steps through. */
const origin = { kind: 'system' as const, tool: 'test_cr06' };

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

it('a job held between its check and its first write checks again before writing (an outside edit is not lost)', async () => {
  const engine = w.stack.runtime.engine;
  const page = w.repo.res.get(L.harbour)!;
  const tagsAtPlan = [...page.tags];
  // While the check reads the page, the owner pauses writes (the read itself is answered as usual).
  w.sidebars.after(new RegExp(`^GET /resources/${L.harbour}/?$`), 0, () =>
    engine.controls.pauseWrites('test'),
  );
  const r = await engine.submit({
    kind: 'batch_ops',
    project: PROJECT,
    origin,
    internal: true,
    holdLock: { resourceId: L.harbour },
    steps: [
      {
        op: 'bridge.expect',
        params: {
          body: {
            checks: [{ label: 'Old Harbour', kind: 'resource', resourceId: L.harbour, tags: tagsAtPlan }],
          },
        },
      },
      {
        op: 'updateResource',
        params: { path: { resourceId: L.harbour }, body: { tags: [...tagsAtPlan, 'from-the-plan'] } },
      },
    ],
  });
  const jobId = (r as { jobId: string }).jobId;
  // The check ran, then the write was held: the job waits, queued, without its lock.
  await until(() => engine.queries.getJob(PROJECT, jobId)?.waitReason?.held === 'writes_paused');
  expect(engine.queries.getJob(PROJECT, jobId)?.status).toBe('queued');
  // Meanwhile someone edits the page's tags in the app.
  page.tags = [...page.tags, 'added-in-the-app'];
  engine.controls.resumeWrites('test');
  const done = await engine.wait(PROJECT, jobId, 5000);
  // The tags the app added are still there: either the job stopped on the check (nothing written), or it kept them.
  expect(page.tags).toContain('added-in-the-app');
  expect(done.status).toBe('failed');
  expect(done.lastError?.code).toBe('VERSION_CONFLICT');
});

it('when nothing changed while it was held, the job checks again and writes as planned', async () => {
  const engine = w.stack.runtime.engine;
  const page = w.repo.res.get(L.guild)!;
  const tagsAtPlan = [...page.tags];
  const reads = () => w.seen.filter((l) => l === `GET /resources/${L.guild}`).length;
  w.sidebars.after(new RegExp(`^GET /resources/${L.guild}/?$`), 0, () => engine.controls.pauseWrites('test'));
  const r = await engine.submit({
    kind: 'batch_ops',
    project: PROJECT,
    origin,
    internal: true,
    holdLock: { resourceId: L.guild },
    steps: [
      {
        op: 'bridge.expect',
        params: {
          body: { checks: [{ label: 'Guild', kind: 'resource', resourceId: L.guild, tags: tagsAtPlan }] },
        },
      },
      {
        op: 'updateResource',
        params: { path: { resourceId: L.guild }, body: { tags: [...tagsAtPlan, 'planned'] } },
      },
    ],
  });
  const jobId = (r as { jobId: string }).jobId;
  await until(() => engine.queries.getJob(PROJECT, jobId)?.waitReason?.held === 'writes_paused');
  const before = reads();
  engine.controls.resumeWrites('test');
  const done = await engine.wait(PROJECT, jobId, 5000);
  expect(done.status).toBe('succeeded');
  expect(page.tags).toEqual([...tagsAtPlan, 'planned']);
  // The check read the page again on resuming (and the write read it for its pre-image).
  expect(reads() - before).toBeGreaterThanOrEqual(2);
});
