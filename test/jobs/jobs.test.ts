/** Job kinds (batch_ops, paginate_all), artefacts, events, queries, budget samples and the per-op metadata. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_ID_PATTERN,
  InvalidParamsError,
  OP_META,
  READERS,
  UnknownOperationError,
  mintClientId,
  type JobEngineEvents,
  type JobView,
} from '../../src/jobs/index.js';
import { getOperation, operations } from '../../src/lk/registry.js';
import { harness, origin, settle, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const status = (j: JobView | undefined) => j?.status;

describe('registry metadata', () => {
  it('every one of the 89 operations has risk, concurrency and versioned, and job-engine metadata', () => {
    expect(operations).toHaveLength(89);
    for (const op of operations) {
      expect(['safe', 'destructive', 'admin'], op.operationId).toContain(op.risk);
      expect(['none', 'document', 'resource'], op.operationId).toContain(op.concurrency);
      expect(typeof op.versioned, op.operationId).toBe('boolean');
      const meta = OP_META[op.operationId];
      expect(meta, op.operationId).toBeDefined();
      if (op.kind === 'read') expect(meta!.verify, op.operationId).toBe('read');
      else expect(meta!.verify, op.operationId).not.toBe('read');
      if (meta!.reader) expect(getOperation(READERS[meta!.reader].op)?.kind, op.operationId).toBe('read');
      if (['state', 'gone', 'client-id'].includes(meta!.verify))
        expect(meta!.reader, op.operationId).toBeDefined();
      if (op.risk === 'destructive') expect(meta!.journal, op.operationId).toBeDefined();
      if (op.versioned) expect(meta!.reader, `${op.operationId} needs a version source`).toBeDefined();
    }
    expect(Object.keys(OP_META).sort()).toEqual(operations.map((o) => o.operationId).sort());
    for (const id of ['createResource', 'createLane', 'createEvent', 'createFeature']) {
      expect(OP_META[id]!.clientId, id).toBe('body.id');
    }
    expect(OP_META.replaceDocumentBlocks!.guard).toBe('document');
    expect(OP_META.replaceBlock!.guard).toBe('block');
  });

  it('mints cuid2-shaped ids LK accepts (8 or 24 chars, lowercase letter first)', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => mintClientId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(CLIENT_ID_PATTERN);
    expect(mintClientId(8)).toMatch(/^[a-z][0-9a-z]{7}$/);
  });
});

describe('batch_ops', () => {
  it('validates every step before queueing and runs them in order', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    expect(() => e.engine.submit({ kind: 'batch_ops', origin, steps: [{ op: 'nope' }] })).toThrow(
      UnknownOperationError,
    );
    expect(() =>
      e.engine.submit({
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'getResource', params: { path: { resourceId: 'r1' } } },
          { op: 'createResource', params: { body: {} } },
        ],
      }),
    ).toThrow(InvalidParamsError);
    expect(e.engine.queries.listJobs()).toHaveLength(0);

    const { jobId, eta } = e.engine.submit({
      kind: 'batch_ops',
      origin: { kind: 'mcp', client: 'claude', tool: 'lk_api_batch' },
      title: 'three things',
      steps: [
        { op: 'createResource', params: { body: { name: 'child', parentId: 'r1' } } },
        { op: 'getResource', params: { path: { resourceId: 'r1' } } },
        { op: 'listResources', params: { query: { parentId: 'r1' } } },
      ],
    });
    expect(eta).toBeGreaterThanOrEqual(h.clock.now());
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'succeeded');
    const job = e.engine.queries.getJob(jobId)!;
    expect(job).toMatchObject({
      title: 'three things',
      priority: 'P2',
      origin: { kind: 'mcp', tool: 'lk_api_batch' },
    });
    expect((job.steps[2]!.resultSummary as { data: unknown[] }).data).toHaveLength(1);
    expect(e.engine.queries.listJobs({ originKind: 'mcp' })).toHaveLength(1);
    expect(e.engine.queries.listJobs({ status: ['failed'] })).toHaveLength(0);
  });

  it('stores large params as an artefact', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', { blocks: [] });
    const e = h.newEngine({ settings: { largeParamsBytes: 1024 } });
    const blocks = Array.from({ length: 50 }, (_, i) => ({
      kind: 'paragraph',
      content: [{ text: `line ${i} `.repeat(5) }],
    }));
    const { jobId } = e.engine.submit({
      kind: 'batch_ops',
      origin,
      steps: [
        { op: 'replaceDocumentBlocks', params: { path: { resourceId, documentId }, body: { blocks } } },
      ],
    });
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'succeeded');
    const job = e.engine.queries.getJob(jobId)!;
    expect(job.steps[0]!.params).toBeNull();
    const art = e.engine.queries.readArtifact(job.steps[0]!.paramsArtifactId!)!;
    expect(art.artifact.kind).toBe('params');
    expect((art.data as { body: { blocks: unknown[] } }).body.blocks).toHaveLength(50);
    expect(h.model.docs.get(documentId)!.blocks).toHaveLength(50);
    // The (large) result went to a result artefact, with a summary on the step.
    expect(job.steps[0]!.resultSummary).toMatchObject({ truncated: true, blocks: 50, version: 'v2' });
  });
});

describe('paginate_all', () => {
  it('makes one governed call per page and stores every item in a pageable artefact', async () => {
    h = await harness();
    for (let i = 0; i < 250; i++) h.model.seedResource(`r${String(i).padStart(3, '0')}`);
    const e = h.newEngine();
    const { jobId } = e.engine.submit({ kind: 'paginate_all', origin, op: 'listResources' });
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'succeeded');
    const job = e.engine.queries.getJob(jobId)!;
    expect(job.steps).toHaveLength(3);
    expect(job.result).toMatchObject({ items: 250, pages: 3, truncated: false });
    expect(h.mock.calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    const artifactId = job.result!.artifactId as string;
    const p1 = e.engine.queries.readArtifact(artifactId, { offset: 0, limit: 100 })!;
    expect(p1.items).toHaveLength(100);
    expect(p1.nextOffset).toBe(100);
    const p3 = e.engine.queries.readArtifact(artifactId, { offset: 200, limit: 100 })!;
    expect(p3.items).toHaveLength(50);
    expect(p3.nextOffset).toBeNull();
    expect((p3.items![49] as { id: string }).id).toBe('r249');
  });

  it('stops at the size caps and marks the result truncated', async () => {
    h = await harness();
    for (let i = 0; i < 250; i++) h.model.seedResource(`r${String(i).padStart(3, '0')}`);
    const e = h.newEngine();
    const { jobId } = e.engine.submit({ kind: 'paginate_all', origin, op: 'listResources', maxItems: 120 });
    await h.drive(e, () => status(e.engine.queries.getJob(jobId)) === 'succeeded');
    const job = e.engine.queries.getJob(jobId)!;
    expect(job.result).toMatchObject({ items: 120, pages: 2, truncated: true });
    expect(e.engine.queries.readArtifact(job.result!.artifactId as string)!.artifact).toMatchObject({
      truncated: true,
      itemCount: 120,
    });
  });

  it('refuses operations that are not paged reads', async () => {
    h = await harness();
    const e = h.newEngine();
    expect(() =>
      e.engine.submit({
        kind: 'paginate_all',
        origin,
        op: 'getResource',
        params: { path: { resourceId: 'x' } },
      }),
    ).toThrow(InvalidParamsError);
  });
});

describe('events, queries and budget samples', () => {
  it('emits job, step, lock, writer, error and controls events', async () => {
    h = await harness();
    const { resourceId, documentId } = h.model.seedResource('r1', {
      blocks: [{ id: 'p1', kind: 'paragraph', content: [] }],
    });
    const e = h.newEngine();
    const seenEvents: Record<string, number> = {};
    const kinds: (keyof JobEngineEvents)[] = ['job', 'step', 'lock', 'writers', 'error', 'controls'];
    const offs = kinds.map((k) => e.engine.events.on(k, () => (seenEvents[k] = (seenEvents[k] ?? 0) + 1)));
    await settle(
      h,
      e,
      e.engine.run(
        'updateBlock',
        { path: { resourceId, documentId, blockId: 'p1' }, body: { content: [] } },
        { origin },
      ),
    );
    await settle(h, e, e.engine.run('getResource', { path: { resourceId: 'missing' } }, { origin }));
    e.engine.controls.pauseWrites();
    e.engine.controls.resumeWrites();
    for (const k of kinds) expect(seenEvents[k], k).toBeGreaterThan(0);
    offs.forEach((off) => off());
  });

  it('records budget samples for the sparklines', async () => {
    h = await harness();
    const e = h.newEngine();
    await settle(h, e, e.engine.run('listResources', {}, { origin }));
    e.engine.recordBudgetSample();
    await h.clock.advance(10_000);
    e.engine.recordBudgetSample();
    const samples = e.engine.queries.listBudgetSamples();
    expect(samples).toHaveLength(2);
    expect(samples[0]!.tiers['key-min']).toMatchObject({ used: 1, limit: 300 });
    expect(samples[1]!.at - samples[0]!.at).toBe(10_000);
  });
});
