/** BudgetWaitError parking and resumption (PLAN §5.3), including across a restart; the >20 s queued path. */
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExhaustedError, type JobView } from '../../src/jobs/index.js';
import { harness, origin, seen, settle, type Harness, queue, PROJECT } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const status = (j: JobView | undefined) => j?.status;
const injectLong429 = (hh: Harness, method = 'POST') =>
  hh.mock.inject((c) => c.method === method, { kind: 'rate-limit', tier: 'write-min', retryAfterS: 120 });

describe('budget waits', () => {
  it('parks a job in waiting_budget with a persisted resume time and resumes it automatically', async () => {
    h = await harness();
    const e = h.newEngine();
    injectLong429(h);
    const t0 = h.clock.now();
    const { jobId } = await queue(e.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      steps: [{ op: 'createResource', params: { body: { name: 'A' } } }],
    });
    await h.drive(e, () => status(e.engine.queries.getJob(PROJECT, jobId)) === 'waiting_budget');
    const parked = e.engine.queries.getJob(PROJECT, jobId)!;
    expect(parked.resumeAt).toBe(t0 + 120_000);
    expect(parked.waitReason).toMatchObject({ tier: 'write-min', opId: 'createResource' });
    expect(parked.steps[0]).toMatchObject({ status: 'pending', maybeSent: false });
    await h.drive(e, () => status(e.engine.queries.getJob(PROJECT, jobId)) === 'succeeded');
    expect(h.clock.now()).toBeGreaterThanOrEqual(t0 + 120_000);
    expect(h.mock.stats.ignoredRetryAfter).toBe(0);
    expect(h.model.count('createResource')).toBe(1);
    const posts = seen(h.mock, 'POST', /\/resources$/);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey);
  });

  it('resumes a parked job after a restart', async () => {
    h = await harness();
    const e1 = h.newEngine();
    injectLong429(h);
    const t0 = h.clock.now();
    const { jobId } = await queue(e1.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      steps: [{ op: 'createResource', params: { body: { name: 'A' } } }],
    });
    await h.drive(e1, () => status(e1.engine.queries.getJob(PROJECT, jobId)) === 'waiting_budget');
    e1.crash();

    const e2 = h.newEngine();
    expect(e2.engine.queries.getJob(PROJECT, jobId)).toMatchObject({
      status: 'waiting_budget',
      resumeAt: t0 + 120_000,
    });
    await h.drive(e2, () => status(e2.engine.queries.getJob(PROJECT, jobId)) === 'succeeded');
    expect(h.model.count('createResource')).toBe(1);
  });

  it('resumes at once when the resume time passed while the bridge was down', async () => {
    h = await harness();
    const e1 = h.newEngine();
    injectLong429(h);
    const { jobId } = await queue(e1.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      steps: [{ op: 'createResource', params: { body: { name: 'A' } } }],
    });
    await h.drive(e1, () => status(e1.engine.queries.getJob(PROJECT, jobId)) === 'waiting_budget');
    e1.crash();
    await h.clock.advance(10 * 60_000);
    const e2 = h.newEngine();
    await h.drive(e2, () => status(e2.engine.queries.getJob(PROJECT, jobId)) === 'succeeded');
    expect(h.model.count('createResource')).toBe(1);
  });

  it('an inline write that meets a long wait comes back as a waiting_budget job; an inline read as BudgetExhaustedError', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    injectLong429(h, 'PATCH');
    const w = await settle(
      h,
      e,
      e.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'x' } },
        { project: PROJECT, origin },
      ),
    );
    expect(w.value).toMatchObject({ status: 'waiting_budget', reason: 'budget' });
    expect(typeof (w.value as { jobId: unknown }).jobId).toBe('string');
    const { jobId } = w.value as { jobId: string };
    await h.drive(e, () => status(e.engine.queries.getJob(PROJECT, jobId)) === 'succeeded');

    h.mock.inject((c) => c.method === 'GET', { kind: 'rate-limit', tier: 'key-min', retryAfterS: 300 });
    const r = await settle(
      h,
      e,
      e.engine.run('getResource', { path: { resourceId: 'r1' } }, { project: PROJECT, origin }),
    );
    expect(r.error).toBeInstanceOf(BudgetExhaustedError);
    expect(r.error).toMatchObject({ tier: 'key-min', code: 'BUDGET_EXHAUSTED' });
  });

  it('queues instead of running inline when the estimate is over 20 s, and engine.wait is bounded', async () => {
    h = await harness();
    h.model.seedResource('r1');
    // write-min of 3: P1 may use 2 per minute, so after two writes the next is 30 s away.
    const e = h.newEngine({ governor: { tierLimits: { 'write-min': 3 } as never, writeSpacingMs: 0 } });
    for (const n of ['a', 'b']) {
      const r = await settle(
        h,
        e,
        e.engine.run(
          'updateResource',
          { path: { resourceId: 'r1' }, body: { name: n } },
          { project: PROJECT, origin },
        ),
      );
      expect(r.value).toMatchObject({ status: 'succeeded' });
    }
    const q = await settle(
      h,
      e,
      e.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'c' } },
        { project: PROJECT, origin },
      ),
    );
    expect(q.value).toMatchObject({
      status: 'queued',
      reason: 'estimate',
    });
    const { jobId, eta } = q.value as { jobId: string; eta: number };
    expect(eta - h.clock.now()).toBeGreaterThan(20_000);

    // wait() gives up after at most 25 s, then the job finishes on its own.
    const t0 = h.clock.now();
    const waited = await settle(h, e, e.engine.wait(PROJECT, jobId, 60_000));
    expect(h.clock.now() - t0).toBeLessThanOrEqual(25_000);
    expect(['queued', 'running', 'waiting_budget']).toContain((waited.value as JobView).status);
    const finished = await settle(
      h,
      e,
      e.engine
        .wait(PROJECT, jobId, 25_000)
        .then(async (j) => (j.status === 'succeeded' ? j : e.engine.wait(PROJECT, jobId, 25_000))),
    );
    expect((finished.value as JobView).status).toBe('succeeded');
    expect(h.mock.stats.genuine429).toBe(0);
  });
});
