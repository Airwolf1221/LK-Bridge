/**
 * Restart-resume (PLAN §11.1 chunk 2): the process dies right after LK committed a write but before the bridge saw
 * the response. A new engine on the same database file must finish the job with NO duplicates at the mock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchSubmit, JobView } from '../../src/jobs/index.js';
import { harness, origin, seen, settle, type EngineHandle, type Harness, type Wire } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const terminal = (j: JobView | undefined) =>
  j !== undefined && ['succeeded', 'failed', 'cancelled'].includes(j.status);

function setup(hh: Harness) {
  const a = hh.model.seedResource('raaaaaaa', { blocks: [{ id: 'p1', kind: 'paragraph', content: [] }] });
  hh.model.seedResource('rbbbbbbb');
  hh.model.seedResource('rccccccc', { parentId: 'raaaaaaa' });
  const batch: BatchSubmit = {
    kind: 'batch_ops',
    origin,
    steps: [
      { op: 'createResource', params: { body: { name: 'New one', parentId: 'raaaaaaa' } } },
      {
        op: 'createLane',
        params: {
          path: { resourceId: a.resourceId, documentId: a.documentId },
          body: { name: 'L', rank: 'a', size: 'sm' },
        },
      },
      {
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: a.resourceId, documentId: a.documentId },
          body: { blocks: [{ kind: 'paragraph', content: [{ text: 'rewritten' }] }] },
        },
      },
      { op: 'deleteResource', params: { path: { resourceId: 'rbbbbbbb' } } },
      {
        op: 'createDocument',
        params: { path: { resourceId: a.resourceId }, body: { name: 'Notes', type: 'page' } },
      },
      { op: 'updateResource', params: { path: { resourceId: a.resourceId }, body: { name: 'Renamed' } } },
    ],
  };
  return { a, batch };
}

const cases: { op: string; method: string; path: RegExp; resent: boolean }[] = [
  { op: 'createResource', method: 'POST', path: /\/resources$/, resent: false },
  { op: 'createLane', method: 'POST', path: /\/lanes$/, resent: false },
  { op: 'replaceDocumentBlocks', method: 'PUT', path: /\/blocks$/, resent: false },
  { op: 'deleteResource', method: 'DELETE', path: /\/resources\/rbbbbbbb$/, resent: false },
  // No client id: re-sent with the same Idempotency-Key, and LK replays the stored response.
  { op: 'createDocument', method: 'POST', path: /\/docs$/, resent: true },
  { op: 'updateResource', method: 'PATCH', path: /\/resources\/raaaaaaa$/, resent: false },
];

const matches = (method: string, path: RegExp) => (w: Wire) =>
  w.method === method && path.test(new URL(w.url).pathname.replace(/\/$/, ''));

async function crashDuring(
  hh: Harness,
  method: string,
  path: RegExp,
): Promise<{ jobId: string; e1: EngineHandle }> {
  const { batch } = setup(hh);
  const e1 = hh.newEngine();
  const killed = e1.killAfter(matches(method, path));
  const { jobId } = e1.engine.submit(batch);
  await hh.drive(e1, () => e1.killed());
  await killed;
  e1.crash(); // no clean shutdown; the job row still says "running"
  return { jobId, e1 };
}

describe('crash-resume', () => {
  it.each(cases)(
    'process dies after LK committed $op: resumes with no duplicate',
    async ({ op, method, path, resent }) => {
      h = await harness();
      const { jobId } = await crashDuring(h, method, path);
      expect(h.model.count(op)).toBe(1);
      const sentBefore = seen(h.mock, method, path).length;
      expect(sentBefore).toBe(1);

      const e2 = h.newEngine();
      await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
      const job = e2.engine.queries.getJob(jobId)!;
      expect(job.status).toBe('succeeded');
      expect(job.steps.map((s) => s.status)).toEqual(Array(6).fill('succeeded'));
      // Exactly one of every write reached LK's state.
      for (const c of cases) expect(h.model.count(c.op), c.op).toBe(1);
      // Verified writes were not re-sent; the key-only POST was, and LK replayed it.
      expect(seen(h.mock, method, path).length).toBe(resent ? 2 : 1);
      if (resent) {
        expect(h.mock.stats.replays).toBe(1);
        const calls = seen(h.mock, method, path);
        expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
      }
      const crashed = job.steps.find((s) => s.opId === op)!;
      if (!resent) expect(crashed.resultSummary).toMatchObject({ verified: true });
      // Journalled writes end "applied", with one pre-image per step even though the step ran twice.
      const journal = e2.engine.queries.journalLookup({ jobId });
      for (const entry of journal) expect(entry.outcome, entry.opId).toBe('applied');
      expect(journal.filter((x) => x.opId === op).length).toBeLessThanOrEqual(1);
    },
  );

  it('a client id minted before the first send survives the restart and is reused', async () => {
    h = await harness();
    const { jobId } = await crashDuring(h, 'POST', /\/resources$/);
    const e2 = h.newEngine();
    await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
    const step = e2.engine.queries.getJob(jobId)!.steps[0]!;
    expect(step.clientIds).toHaveLength(1);
    expect(h.model.resources.has(step.clientIds[0]!)).toBe(true);
    expect(seen(h.mock, 'GET', new RegExp(`/resources/${step.clientIds[0]}$`))).toHaveLength(1); // the verify read
  });

  it('beyond the idempotency window a key-only POST is marked uncertain, never re-sent', async () => {
    h = await harness();
    const { jobId } = await crashDuring(h, 'POST', /\/docs$/);
    await h.clock.advance(25 * 3_600_000);
    const e2 = h.newEngine();
    await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
    const job = e2.engine.queries.getJob(jobId)!;
    expect(job.status).toBe('failed');
    expect(job.uncertain).toBe(true);
    expect(job.lastError).toMatchObject({ code: 'UNCERTAIN_OUTCOME' });
    expect(job.steps[4]!.status).toBe('uncertain');
    expect(job.steps[5]!.status).toBe('pending'); // stopOnError: nothing after it ran
    expect(seen(h.mock, 'POST', /\/docs$/)).toHaveLength(1);
    expect(h.model.count('createDocument')).toBe(1);
  });

  it('a versioned write changed by someone else after the crash is uncertain, not overwritten', async () => {
    h = await harness();
    const { jobId } = await crashDuring(h, 'PUT', /\/blocks$/);
    // After our replace applied, someone edits the page in the LK app.
    h.model.outsideEdit('d_raaaaaaa', (b) => b.push({ id: 'z', kind: 'paragraph', content: [] }));
    const e2 = h.newEngine();
    await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
    const job = e2.engine.queries.getJob(jobId)!;
    expect(job.steps[2]!.status).toBe('uncertain');
    expect(job.uncertain).toBe(true);
    expect(seen(h.mock, 'PUT', /\/blocks$/)).toHaveLength(1);
  });

  it('a write that never left before the crash is sent once after restart', async () => {
    h = await harness();
    const { batch } = setup(h);
    const e1 = h.newEngine();
    // Kill on the read before step 3's PUT: the PUT was never sent.
    const killed = e1.killAfter(matches('GET', /\/blocks$/));
    const { jobId } = e1.engine.submit(batch);
    await h.drive(e1, () => e1.killed());
    await killed;
    e1.crash();
    expect(seen(h.mock, 'PUT', /\/blocks$/)).toHaveLength(0);
    const e2 = h.newEngine();
    await h.drive(e2, () => terminal(e2.engine.queries.getJob(jobId)));
    expect(e2.engine.queries.getJob(jobId)!.status).toBe('succeeded');
    expect(seen(h.mock, 'PUT', /\/blocks$/)).toHaveLength(1);
    expect(h.model.count('replaceDocumentBlocks')).toBe(1);
  });
});

describe('verify after an ambiguous retry (PLAN §5.3, governor verify hooks)', () => {
  it('412 after a dropped PUT that had applied: re-read matches the intent, so it is a success', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', {
      blocks: [{ id: 'p1', kind: 'paragraph', content: [] }],
    });
    const e = h.newEngine();
    h.mock.inject((c) => c.method === 'PUT', { kind: 'drop-after-commit' });
    const r = await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        {
          path: { resourceId, documentId },
          body: { blocks: [{ kind: 'paragraph', content: [{ text: 'new' }] }] },
        },
        { origin },
      ),
    );
    expect(r.error).toBeUndefined();
    expect(h.mock.calls.filter((c) => c.method === 'PUT').map((c) => c.outcome)).toEqual([
      'dropped-after-commit',
      'status-412',
    ]);
    expect(h.model.count('replaceDocumentBlocks')).toBe(1);
    expect(seen(h.mock, 'GET', /\/blocks$/)).toHaveLength(2); // the pre-read and the verify read
  });

  it('DUPLICATE_ID after a dropped create that had applied: GET by the minted id finds it, so it is a success', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1');
    const e = h.newEngine();
    // The first attempt is dropped; LK applied it but kept no idempotency record (the worst case).
    h.mock.inject((c) => c.method === 'POST', { kind: 'drop' });
    const p = e.engine.run(
      'createLane',
      { path: { resourceId, documentId }, body: { name: 'L', rank: 'a', size: 'sm' } },
      { origin },
    );
    await h.until(() => h!.mock.calls.some((c) => c.outcome === 'dropped'));
    const job = e.engine.queries.listJobs()[0]!;
    const laneId = e.engine.queries.getJob(job.id)!.steps[0]!.clientIds[0]!;
    h.model.docs.get(documentId)!.lanes.set(laneId, { id: laneId, name: 'L', rank: 'a', size: 'sm' });
    const r = await settle(h, e, p);
    expect(r.error).toBeUndefined();
    expect(r.value).toMatchObject({ status: 'succeeded', result: { id: laneId } });
    expect(h.mock.calls.filter((c) => c.method === 'POST').map((c) => c.outcome)).toEqual([
      'dropped',
      'status-409',
    ]);
    expect(seen(h.mock, 'GET', new RegExp(`/lanes/${laneId}$`))).toHaveLength(1);
  });
});

describe('retrying a step that may have applied', () => {
  it('keeps the idempotency key, so LK replays instead of creating twice; force re-runs as new work', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    // Every attempt dropped after LK committed: the governor gives up with a transient error.
    h.mock.inject((c) => c.method === 'POST', { kind: 'drop-after-commit' }, 1);
    h.mock.inject((c) => c.method === 'POST', { kind: 'drop' }, 3);
    const { jobId } = e.engine.submit({
      kind: 'batch_ops',
      origin,
      steps: [
        { op: 'createDocument', params: { path: { resourceId: 'r1' }, body: { name: 'N', type: 'page' } } },
      ],
    });
    await h.drive(e, () => terminal(e.engine.queries.getJob(jobId)));
    let step = e.engine.queries.getJob(jobId)!.steps[0]!;
    expect(step).toMatchObject({ status: 'failed', maybeSent: true });
    expect(h.model.count('createDocument')).toBe(1);

    e.engine.controls.retryStep(jobId, 1);
    await h.drive(e, () => e.engine.queries.getJob(jobId)?.status === 'succeeded');
    step = e.engine.queries.getJob(jobId)!.steps[0]!;
    expect(step).toMatchObject({ status: 'succeeded', attempt0: 0, idempotencyKey: `lkb.${jobId}.1.0` });
    expect(h.mock.stats.replays).toBe(1);
    expect(h.model.count('createDocument')).toBe(1);
  });
});
