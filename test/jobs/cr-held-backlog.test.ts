/**
 * CR-2026-11, finding CR-04: while writes are paused (or the project is read-only), the scheduler looked only at the
 * first `maxActiveJobs + 100` queued jobs. With that many held write jobs ahead of it, a job whose next step is a read
 * was never started: reads must keep running while writes are held (PLAN §6.2), however long the held queue is.
 */
import { afterEach, expect, it } from 'vitest';
import { harness, origin, PROJECT, queue, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it('a read job behind more held write jobs than the scheduler used to look at still runs', async () => {
  h = await harness();
  h.model.seedResource('r1', { blocks: [] });
  const e = h.newEngine({ settings: { maxActiveJobs: 2 } });
  e.engine.controls.pauseWrites('owner');
  // 2 + 100 + 10 held write jobs, all queued ahead of the read.
  for (let i = 0; i < 112; i++) {
    await queue(e.engine, {
      kind: 'batch_ops',
      project: PROJECT,
      origin,
      steps: [{ op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: `n${i}` } } }],
    });
  }
  const { jobId } = await queue(e.engine, {
    kind: 'batch_ops',
    project: PROJECT,
    origin,
    steps: [{ op: 'getResource', params: { path: { resourceId: 'r1' } } }],
  });
  await h.drive(e, () => e.engine.queries.getJob(PROJECT, jobId)?.status === 'succeeded', 60_000);
  expect(e.engine.queries.getJob(PROJECT, jobId)?.status).toBe('succeeded');
  expect(h.model.count('updateResource')).toBe(0);
});
