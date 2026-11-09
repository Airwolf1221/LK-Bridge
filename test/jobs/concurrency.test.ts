/** Writer pool and locks (PLAN §6.2): serialised per document, parallel across documents, slot limits, live WRITERS_MAX. */
import { afterEach, describe, expect, it } from 'vitest';
import { LockManager, WriterPool, lockKeyFor, type JobView } from '../../src/jobs/index.js';
import { requireOperation } from '../../src/lk/registry.js';
import { harness, origin, type Harness, type Wire, queue, PROJECT } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const isPatchBlock = (w: Wire) => w.method === 'PATCH' && /\/blocks\/[^/]+\/?$/.test(new URL(w.url).pathname);
const done = (j: JobView | undefined) => j?.status === 'succeeded';

function seedTwoDocs(hh: Harness) {
  const a = hh.model.seedResource('r1', { blocks: [{ id: 'p1', kind: 'paragraph', content: [] }] });
  const b = hh.model.seedResource('r2', { blocks: [{ id: 'q1', kind: 'paragraph', content: [] }] });
  return { a, b };
}

const updateBlock = (resourceId: string, documentId: string, blockId: string, text: string) => ({
  kind: 'batch_ops' as const,
  project: PROJECT,
  origin,
  steps: [
    {
      op: 'updateBlock',
      params: { path: { resourceId, documentId, blockId }, body: { content: [{ text }] } },
    },
  ],
});

describe('locks', () => {
  it('serialises two writers on the same document and runs different documents in parallel', async () => {
    h = await harness();
    const { a, b } = seedTwoDocs(h);
    const e = h.newEngine({ governor: { writeSpacingMs: 0 } });
    const release = e.hold(isPatchBlock);
    const j1 = (await queue(e.engine, updateBlock(a.resourceId, a.documentId, 'p1', 'one'))).jobId;
    const j2 = (await queue(e.engine, updateBlock(a.resourceId, a.documentId, 'p1', 'two'))).jobId;
    const j3 = (await queue(e.engine, updateBlock(b.resourceId, b.documentId, 'q1', 'three'))).jobId;

    // j1 and j3 are in flight together (two documents, two slots); j2 waits for d_r1's lock.
    await h.until(
      () =>
        e.sent.filter(isPatchBlock).length === 2 &&
        e.engine.queries.getJob(PROJECT, j2)?.status === 'waiting_lock',
    );
    // v2 A1: locks are per project and per entity, so the key carries the project id.
    expect(e.engine.queries.getJob(PROJECT, j2)!.waitReason).toMatchObject({
      lockKey: `${PROJECT}:doc:d_r1`,
    });
    expect(
      e.engine.queries
        .locks()
        .map((l) => ({ key: l.key, holder: l.holder.jobId, waiting: l.waiting.map((w) => w.jobId) })),
    ).toEqual([
      { key: `${PROJECT}:doc:d_r1`, holder: j1, waiting: [j2] },
      { key: `${PROJECT}:doc:d_r2`, holder: j3, waiting: [] },
    ]);
    const writers = e.engine.queries.writers();
    expect(writers).toMatchObject({ max: 2, busy: 2 });
    expect(writers.slots.map((s) => s.documentId).sort()).toEqual(['d_r1', 'd_r2']);
    expect(writers.slots[0]).toMatchObject({ state: 'busy', opId: 'updateBlock' });

    release();
    await h.drive(e, () => [j1, j2, j3].every((j) => done(e.engine.queries.getJob(PROJECT, j))));
    // j2 read the version after j1 wrote, so no 412 storm: three PATCHes, three versions.
    const patches = h.mock.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(3);
    expect(patches.every((c) => c.outcome === 'ok')).toBe(true);
    expect(h.model.docs.get('d_r1')!.blocks[0]!.content).toEqual([{ text: 'two' }]);
    expect(e.engine.queries.locks()).toEqual([]);
  });

  it('is fair: waiters are served in arrival order, and an aborted wait leaves the queue', async () => {
    const order: string[] = [];
    const locks = new LockManager(
      () => 0,
      (ev) => ev.type === 'acquired' && order.push(ev.owner.jobId),
    );
    const r1 = await locks.acquire('doc:x', { jobId: 'a', stepNo: 1 });
    const p2 = locks.acquire('doc:x', { jobId: 'b', stepNo: 1 });
    const ac = new AbortController();
    const p3 = locks.acquire('doc:x', { jobId: 'c', stepNo: 1 }, ac.signal);
    const p4 = locks.acquire('doc:x', { jobId: 'd', stepNo: 1 });
    ac.abort(new Error('cancelled'));
    await expect(p3).rejects.toThrow('cancelled');
    r1();
    (await p2)();
    (await p4)();
    expect(order).toEqual(['a', 'b', 'd']);
    expect(locks.state()).toEqual([]);
  });

  it('derives lock keys: document ops lock the document, resource ops the resource, creates the parent', () => {
    const k = (op: string, params: object) => lockKeyFor(requireOperation(op), params);
    expect(k('replaceDocumentBlocks', { path: { resourceId: 'r', documentId: 'd' } })).toBe('doc:d');
    expect(k('createEvent', { path: { resourceId: 'r', documentId: 'd' } })).toBe('doc:d');
    expect(k('updateResource', { path: { resourceId: 'r' } })).toBe('res:r');
    expect(k('deleteResource', { path: { resourceId: 'r' } })).toBe('res:r');
    expect(k('createPropertyRow', { path: { resourceId: 'r', propertyId: 'p' } })).toBe('res:r');
    expect(k('createResource', { body: { name: 'n', parentId: 'parent' } })).toBe('res:parent');
    expect(k('createResource', { body: { name: 'n' } })).toBe('res:@root');
    expect(
      k('createManyResources', {
        body: {
          resources: [
            { id: 'aaaaaaaa', name: 'a', parentId: 'p' },
            { name: 'b', parentId: 'aaaaaaaa' },
          ],
        },
      }),
    ).toBe('res:p');
    expect(k('updateCalendar', { path: { calendarId: 'c' } })).toBe('cal:c');
    expect(k('getDocumentBlocks', { path: { resourceId: 'r', documentId: 'd' } })).toBeNull();
  });
});

describe('writer pool', () => {
  it('respects the slot limit, lets reads through, and a live WRITERS_MAX change takes effect without a restart', async () => {
    h = await harness();
    const { a, b } = seedTwoDocs(h);
    const e = h.newEngine({ settings: { writersMax: 1 }, governor: { writeSpacingMs: 0 } });
    const release = e.hold(isPatchBlock);
    const j1 = (await queue(e.engine, updateBlock(a.resourceId, a.documentId, 'p1', 'one'))).jobId;
    const j2 = (await queue(e.engine, updateBlock(b.resourceId, b.documentId, 'q1', 'two'))).jobId;
    await h.until(
      () => e.sent.filter(isPatchBlock).length === 1 && e.engine.queries.writers().waiting.length === 1,
    );
    expect(e.engine.queries.writers()).toMatchObject({ max: 1, busy: 1, waiting: [{ jobId: j2 }] });

    // A read needs no slot.
    const read = e.engine.run('getResource', { path: { resourceId: 'r1' } }, { project: PROJECT, origin });
    await h.until(() =>
      h!.mock.calls.some(
        (c) => c.method === 'GET' && c.path.startsWith('/api/v3/projects/proj_mock/resources/r1'),
      ),
    );
    await expect(read).resolves.toMatchObject({ status: 'succeeded' });

    // Raise to 2 at runtime: j2's write starts while j1's is still held.
    e.engine.controls.setWritersMax(2, 'owner');
    await h.until(() => e.sent.filter(isPatchBlock).length === 2);
    expect(e.engine.queries.writers()).toMatchObject({ max: 2, busy: 2, waiting: [] });
    release();
    await h.drive(e, () => [j1, j2].every((j) => done(e.engine.queries.getJob(PROJECT, j))));

    // Persisted: a new engine starts with 2 even though its env default says 1.
    await e.engine.stop();
    const e2 = h.newEngine({ settings: { writersMax: 1 } });
    expect(e2.engine.queries.controls().writersMax).toBe(2);
    expect(() => e2.engine.controls.setWritersMax(9)).toThrow(RangeError);
    expect(() => e2.engine.controls.setWritersMax(0)).toThrow(RangeError);
  });

  it('lowering WRITERS_MAX lets busy slots finish and admits nobody new until it fits', async () => {
    let t = 0;
    const pool = new WriterPool(2, () => t++);
    const info = (jobId: string) => ({
      projectId: PROJECT,
      jobId,
      stepNo: 1,
      opId: 'x',
      lockKey: null,
      resourceId: null,
      documentId: null,
    });
    const r1 = await pool.acquire(info('a'));
    const r2 = await pool.acquire(info('b'));
    pool.setMax(1);
    let got = false;
    const p3 = pool.acquire(info('c')).then((r) => {
      got = true;
      return r;
    });
    r1();
    await Promise.resolve();
    expect(got).toBe(false); // still 1 busy = max
    r2();
    (await p3)();
    expect(got).toBe(true);
    expect(pool.view()).toMatchObject({ max: 1, busy: 0 });
  });
});
