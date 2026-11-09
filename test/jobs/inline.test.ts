/** engine.run: inline reads and writes, versioned writes, typed conflicts, request ids, errors table. */
import { afterEach, describe, expect, it } from 'vitest';
import { LkOperationError, VersionConflictError, isClientId } from '../../src/jobs/index.js';
import { harness, origin, seen, settle, type Harness, PROJECT } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('engine.run inline path', () => {
  it('runs a single read inline without recording a job', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run('getResource', { path: { resourceId: 'r1' } }, { project: PROJECT, origin }),
    );
    expect(r.error).toBeUndefined();
    expect(r.value).toMatchObject({ status: 'succeeded', jobId: null, result: { id: 'r1' } });
    expect(e.engine.queries.listJobs(PROJECT)).toHaveLength(0);
  });

  it('runs a single write inline, recorded as a one-step job, with a minted client id sent', async () => {
    h = await harness();
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run('createResource', { body: { name: 'Aster' } }, { project: PROJECT, origin }),
    );
    expect(r.error).toBeUndefined();
    const v = r.value as { status: string; jobId: string; result: { id: string } };
    expect(v.status).toBe('succeeded');
    expect(isClientId(v.result.id)).toBe(true);
    expect(h.model.resources.get(v.result.id)?.name).toBe('Aster');
    const job = e.engine.queries.getJob(PROJECT, v.jobId)!;
    expect(job).toMatchObject({
      kind: 'single_op',
      status: 'succeeded',
      progress: { stepsDone: 1, stepsTotal: 1 },
    });
    expect(job.steps[0]).toMatchObject({
      status: 'succeeded',
      clientIds: [v.result.id],
      idempotencyKey: `lkb.${v.jobId}.1.0`,
    });
    expect(job.steps[0]!.requestIds).toEqual([`lkb.${v.jobId}.1.0.1`]);
    const post = seen(h.mock, 'POST', /\/resources$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.idempotencyKey).toBe(`lkb.${v.jobId}.1.0`);
  });

  it('reads the version immediately before a versioned write and sends it as If-Match', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', {
      blocks: [{ id: 'p1', kind: 'paragraph', content: [] }],
    });
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        {
          path: { resourceId, documentId },
          body: { blocks: [{ kind: 'paragraph', content: [{ text: 'hi' }] }] },
        },
        { project: PROJECT, origin },
      ),
    );
    expect(r.error).toBeUndefined();
    const reads = seen(h.mock, 'GET', /\/blocks$/);
    const puts = seen(h.mock, 'PUT', /\/blocks$/);
    expect(reads).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.ifMatch).toBe('v1');
    expect(h.model.docs.get(documentId)!.version).toBe(2);
  });

  it('uses a caller-supplied version, and returns a typed conflict on 412 without retrying', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', { blocks: [] });
    h.model.outsideEdit(documentId, (b) => b.push({ id: 'x', kind: 'paragraph', content: [] }));
    const e = h.newEngine();
    // The guard read sees v2 and refuses before writing.
    const r = await settle(
      h,
      e,
      e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId, documentId }, ifMatch: 'v1', body: { blocks: [] } },
        { project: PROJECT, origin },
      ),
    );
    expect(r.error).toBeInstanceOf(VersionConflictError);
    expect(r.error).toMatchObject({ sentVersion: 'v1', currentVersion: 'v2' });
    expect(typeof (r.error as VersionConflictError).jobId).toBe('string');
    expect(seen(h.mock, 'PUT', /\/blocks$/)).toHaveLength(0);

    // A non-guarded versioned write (updateBlock): the stale version reaches LK, 412 comes back typed, once.
    h.model.outsideEdit(documentId, () => {});
    const r2 = await settle(
      h,
      e,
      e.engine.run(
        'updateBlock',
        { path: { resourceId, documentId, blockId: 'x' }, ifMatch: 'v2', body: { content: [] } },
        { project: PROJECT, origin },
      ),
    );
    expect(r2.error).toBeInstanceOf(VersionConflictError);
    expect(r2.error).toMatchObject({ sentVersion: 'v2', currentVersion: 'v3' });
    expect(seen(h.mock, 'PATCH', /\/blocks\/x$/)).toHaveLength(1);
  });

  it('records failed calls in the errors table, grouped by fingerprint', async () => {
    h = await harness();
    const e = h.newEngine();
    for (let i = 0; i < 3; i++) {
      const r = await settle(
        h,
        e,
        e.engine.run('getResource', { path: { resourceId: 'nope' } }, { project: PROJECT, origin }),
      );
      expect(r.error).toBeInstanceOf(LkOperationError);
      expect((r.error as LkOperationError).status).toBe(404);
    }
    const groups = e.engine.queries.listErrorGroups(PROJECT);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ opId: 'getResource', code: 'NOT_FOUND', count: 3, resolved: false });
    const one = e.engine.queries.listErrors(PROJECT, { fingerprint: groups[0]!.fingerprint })[0]!;
    expect(one).toMatchObject({
      status: 404,
      classification: 'user_fixable',
      retryable: false,
    });
    expect(typeof one.requestId).toBe('string');
    expect(e.engine.queries.resolveErrorGroup(PROJECT, groups[0]!.fingerprint)).toBe(3);
    expect(e.engine.queries.listErrorGroups(PROJECT, { resolved: false })).toHaveLength(0);
    await settle(
      h,
      e,
      e.engine.run('getResource', { path: { resourceId: 'nope' } }, { project: PROJECT, origin }),
    );
    expect(e.engine.queries.listErrorGroups(PROJECT, { resolved: false })[0]?.count).toBe(4);
  });
});
