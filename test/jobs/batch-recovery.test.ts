/**
 * createManyResources is not atomic (LK's SDK guide): items created before a failure remain, and a retry gets
 * 409 DUPLICATE_ID for them. After an ambiguous outcome the engine verifies EVERY minted id and re-submits only the
 * missing items, with their same ids, as a new step that runs next.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JobView } from '../../src/jobs/index.js';
import { harness, origin, queue, seen, settle, type Harness, type Wire } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const terminal = (j: JobView | undefined) =>
  j !== undefined && ['succeeded', 'failed', 'cancelled'].includes(j.status);
const isBatch = (w: Wire) => w.method === 'POST' && /\/resources\/batch\/?$/.test(new URL(w.url).pathname);
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `Item ${i}`, parentId: 'rparent1' }));

describe('createManyResources recovery', () => {
  it('a half-created batch at a crash: every id is verified, only the missing items are re-submitted, in order', async () => {
    h = await harness();
    h.model.seedResource('rparent1');
    h.model.batchFailAfter = 3; // LK creates 3 of 6, then fails
    const e1 = h.newEngine();
    const killed = e1.killAfter(isBatch); // ...and the bridge dies before it sees the answer
    const { jobId } = await queue(e1.engine, {
      kind: 'batch_ops',
      origin,
      steps: [
        { op: 'createManyResources', params: { body: { resources: items(6) } } },
        {
          op: 'updateResource',
          params: { path: { resourceId: 'rparent1' }, body: { name: 'After the batch' } },
        },
      ],
    });
    await h.drive(e1, () => e1.killed());
    await killed;
    e1.crash();
    expect(h.model.count('createResource')).toBe(3);

    const e2 = h.newEngine();
    await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
    const job = e2.engine.queries.getJob(jobId)!;
    expect(job.status).toBe('succeeded');
    const minted = job.steps[0]!.clientIds;
    expect(minted).toHaveLength(6);
    // Every id exists exactly once at LK.
    expect(h.model.count('createResource')).toBe(6);
    for (const id of minted) expect(h.model.resources.has(id), id).toBe(true);
    // Six verification reads, one per minted id.
    for (const id of minted) expect(seen(h.mock, 'GET', new RegExp(`/resources/${id}$`)), id).toHaveLength(1);
    // The continuation ran next (step 2), with only the missing items and their same ids; the update moved to 3.
    expect(job.steps.map((s) => [s.opId, s.status])).toEqual([
      ['createManyResources', 'succeeded'],
      ['createManyResources', 'succeeded'],
      ['updateResource', 'succeeded'],
    ]);
    expect(job.steps[0]!.resultSummary).toMatchObject({
      verified: true,
      value: { partial: true, missing: minted.slice(3), continuedInStep: 2 },
    });
    expect(job.steps[1]!.clientIds).toEqual(minted.slice(3));
    expect(job.steps[1]!.idempotencyKey).toBe(`lkb.${jobId}.2.0`);
    expect(job.steps[2]!.idempotencyKey).toBeNull(); // PATCH: no key
    const batches = h.mock.calls.filter((c) => c.method === 'POST' && /\/batch\/?$/.test(c.path));
    expect(batches).toHaveLength(2);
    expect(batches[1]!.idempotencyKey).toBe(`lkb.${jobId}.2.0`);
    expect(h.model.resources.get('rparent1')!.name).toBe('After the batch');
  });

  it('a batch that fails part-way while running is recovered the same way, and run() returns every resource', async () => {
    h = await harness();
    h.model.seedResource('rparent1');
    h.model.batchFailAfter = 2;
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run('createManyResources', { body: { resources: items(5) } }, { origin }),
    );
    expect(r.error).toBeUndefined();
    const v = r.value as { status: string; jobId: string; result: { resources: { id: string }[] } };
    expect(v.status).toBe('succeeded');
    expect(v.result.resources).toHaveLength(5);
    expect(h.model.count('createResource')).toBe(5);
    const job = e.engine.queries.getJob(v.jobId)!;
    expect(new Set(v.result.resources.map((x) => x.id))).toEqual(new Set(job.steps[0]!.clientIds));
    expect(job.steps).toHaveLength(2);
  });

  it('a batch that fully applied is recognised without re-sending anything', async () => {
    h = await harness();
    h.model.seedResource('rparent1');
    const e1 = h.newEngine();
    const killed = e1.killAfter(isBatch);
    const { jobId } = await queue(e1.engine, {
      kind: 'batch_ops',
      origin,
      steps: [{ op: 'createManyResources', params: { body: { resources: items(4) } } }],
    });
    await h.drive(e1, () => e1.killed());
    await killed;
    e1.crash();
    const e2 = h.newEngine();
    await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
    const job = e2.engine.queries.getJob(jobId)!;
    expect(job.status).toBe('succeeded');
    expect(job.steps).toHaveLength(1);
    expect(h.mock.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(h.model.count('createResource')).toBe(4);
  });

  it('marks the step uncertain only when verification itself cannot complete', async () => {
    h = await harness();
    h.model.seedResource('rparent1');
    h.model.batchFailAfter = 1;
    const e = h.newEngine();
    // The batch fails part-way, and then LK fails the verification reads too.
    h.mock.inject((c) => c.method === 'GET', { kind: 'status', status: 500, code: 'INTERNAL' }, 100);
    const { jobId } = await queue(e.engine, {
      kind: 'batch_ops',
      origin,
      steps: [{ op: 'createManyResources', params: { body: { resources: items(3) } } }],
    });
    await h.drive(e, () => terminal(e.engine.queries.getJob(jobId)));
    const job = e.engine.queries.getJob(jobId)!;
    expect(job).toMatchObject({ status: 'failed', uncertain: true });
    expect(job.steps[0]!.status).toBe('uncertain');
    expect(job.steps).toHaveLength(1);
    expect(h.model.count('createResource')).toBe(1); // nothing re-sent on a guess
  });
});
