/** Controls (PLAN §6.2): pause all writes, drain, cancel, pause/resume a job, retry a failed step. */
import { afterEach, describe, expect, it } from 'vitest';
import { DrainingError, InvalidControlError, type JobView } from '../../src/jobs/index.js';
import { harness, origin, seen, settle, type Harness, type Wire } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const isPatch = (w: Wire) => w.method === 'PATCH';
const status = (j: JobView | undefined) => j?.status;

function threeRenames(hh: Harness) {
  for (const id of ['r1', 'r2', 'r3']) hh.model.seedResource(id);
  return {
    kind: 'batch_ops' as const,
    origin,
    steps: ['r1', 'r2', 'r3'].map((id) => ({
      op: 'updateResource',
      params: { path: { resourceId: id }, body: { name: `${id}!` } },
    })),
  };
}

describe('pause all writes', () => {
  it('lets the in-flight step finish, starts no new write, persists, and resumes', async () => {
    h = await harness();
    const e = h.newEngine({ governor: { writeSpacingMs: 0 } });
    const release = e.hold(isPatch);
    const { jobId } = e.engine.submit(threeRenames(h));
    await h.until(() => e.sent.filter(isPatch).length === 1);
    e.engine.controls.pauseWrites('owner');
    release();
    await h.drive(e, () => e.engine.queries.getJob(jobId)?.waitReason?.held === 'writes_paused');
    expect(h.model.count('updateResource')).toBe(1); // the in-flight one finished
    expect(e.engine.queries.getJob(jobId)).toMatchObject({ status: 'queued', progress: { stepsDone: 1 } });

    // A new inline write is accepted but queued, not sent.
    const r = await settle(
      h,
      e,
      e.engine.run('updateResource', { path: { resourceId: 'r1' }, body: { name: 'x' } }, { origin }),
    );
    expect(r.value).toMatchObject({ status: 'queued', reason: 'writes_paused', eta: null });
    // Reads still run.
    expect(
      (await settle(h, e, e.engine.run('getResource', { path: { resourceId: 'r1' } }, { origin }))).error,
    ).toBeUndefined();

    // Persisted across a restart.
    await e.engine.stop();
    const e2 = h.newEngine();
    expect(e2.engine.queries.controls().writesPaused).toBe(true);
    await h.drive(e2, () => true);
    expect(h.model.count('updateResource')).toBe(1);
    e2.engine.controls.resumeWrites();
    await h.drive(e2, () => status(e2.engine.queries.getJob(jobId)) === 'succeeded');
    await h.drive(e2, () => e2.engine.queries.listJobs({ status: 'succeeded' }).length === 2);
    expect(h.model.count('updateResource')).toBe(4);
  });
});

describe('drain', () => {
  it('finishes running jobs and accepts none', async () => {
    h = await harness();
    const e = h.newEngine({ governor: { writeSpacingMs: 0 } });
    const release = e.hold(isPatch);
    const { jobId } = e.engine.submit(threeRenames(h));
    await h.until(() => e.sent.filter(isPatch).length === 1);
    let drained = false;
    void e.engine.controls.drain().then(() => (drained = true));
    expect(e.engine.queries.controls().draining).toBe(true);
    expect(() => e.engine.submit(threeRenames(h!))).toThrow(DrainingError);
    await expect(
      e.engine.run('updateResource', { path: { resourceId: 'r1' }, body: { name: 'y' } }, { origin }),
    ).rejects.toBeInstanceOf(DrainingError);
    expect(drained).toBe(false);
    release();
    await h.drive(e, () => drained);
    expect(status(e.engine.queries.getJob(jobId))).toBe('succeeded');
    e.engine.controls.undrain();
    expect(e.engine.queries.controls().draining).toBe(false);
  });
});

describe('cancel', () => {
  it('lets the in-flight step complete, then stops; nothing further is sent', async () => {
    h = await harness();
    const e = h.newEngine({ governor: { writeSpacingMs: 0 } });
    const release = e.hold(isPatch);
    const { jobId } = e.engine.submit(threeRenames(h));
    await h.until(() => e.sent.filter(isPatch).length === 1);
    expect(e.engine.controls.cancel(jobId).cancelRequested).toBe(true);
    release();
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'cancelled');
    const job = e.engine.queries.getJob(jobId)!;
    expect(job.steps.map((s) => s.status)).toEqual(['succeeded', 'cancelled', 'cancelled']);
    expect(seen(h.mock, 'PATCH', /./)).toHaveLength(1);
  });

  it('cancels a queued job at once', async () => {
    h = await harness();
    const e = h.newEngine();
    e.engine.controls.pauseWrites();
    const { jobId } = e.engine.submit(threeRenames(h));
    expect(e.engine.controls.cancel(jobId).status).toBe('cancelled');
    e.engine.controls.resumeWrites();
    await h.drive(e, () => true);
    expect(h.mock.calls).toHaveLength(0);
  });
});

describe('pause and resume a job', () => {
  it('pauses after the in-flight step and resumes from the next one', async () => {
    h = await harness();
    const e = h.newEngine({ governor: { writeSpacingMs: 0 } });
    const release = e.hold(isPatch);
    const { jobId } = e.engine.submit(threeRenames(h));
    await h.until(() => e.sent.filter(isPatch).length === 1);
    e.engine.controls.pauseJob(jobId);
    release();
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'paused');
    expect(e.engine.queries.getJob(jobId)!.steps.map((s) => s.status)).toEqual([
      'succeeded',
      'pending',
      'pending',
    ]);
    expect(() => e.engine.controls.retryStep(jobId, 2)).toThrow(InvalidControlError);
    e.engine.controls.resumeJob(jobId);
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'succeeded');
    expect(h.model.count('updateResource')).toBe(3);
  });
});

describe('retry a failed step', () => {
  it('re-runs the failed step with a new idempotency key, then continues the job', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    const { jobId } = e.engine.submit({
      kind: 'batch_ops',
      origin,
      onError: 'stop',
      steps: [
        {
          op: 'createDocument',
          params: { path: { resourceId: 'rmissing' }, body: { name: 'N', type: 'page' } },
        },
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'after' } } },
      ],
    });
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'failed');
    let job = e.engine.queries.getJob(jobId)!;
    expect(job.steps.map((s) => s.status)).toEqual(['failed', 'pending']);
    expect(job.lastError).toMatchObject({ code: 'LK_ERROR', lk: { status: 404, code: 'NOT_FOUND' } });
    expect(job.steps[0]!.idempotencyKey).toBe(`lkb.${jobId}.1.0`);

    h.model.seedResource('rmissing');
    e.engine.controls.retryStep(jobId, 1);
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'succeeded');
    job = e.engine.queries.getJob(jobId)!;
    expect(job.steps[0]).toMatchObject({
      status: 'succeeded',
      attempt0: 1,
      idempotencyKey: `lkb.${jobId}.1.1`,
    });
    expect(seen(h.mock, 'POST', /\/docs$/).map((c) => c.idempotencyKey)).toEqual([
      `lkb.${jobId}.1.0`,
      `lkb.${jobId}.1.1`,
    ]);
    expect(h.model.count('createDocument')).toBe(1);
    expect(h.model.count('updateResource')).toBe(1);
  });

  it('continue mode runs every step and fails the job if any failed', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    const { jobId } = e.engine.submit({
      kind: 'batch_ops',
      origin,
      onError: 'continue',
      steps: [
        { op: 'updateResource', params: { path: { resourceId: 'nope' }, body: { name: 'a' } } },
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'b' } } },
      ],
    });
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'failed');
    const job = e.engine.queries.getJob(jobId)!;
    expect(job.steps.map((s) => s.status)).toEqual(['failed', 'succeeded']);
    expect(job.progress).toEqual({ stepsDone: 1, stepsTotal: 2, stepsFailed: 1 });
  });
});
