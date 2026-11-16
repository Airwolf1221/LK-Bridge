/**
 * v3 F3a (ADR 0050): the job engine's generic additions for setting packs, on the mock LegendKeeper:
 *
 * - `bridge.expect` and `bridge.verify` checks of kind `registered`, judged by an asynchronous checker the bridge
 *   registered (a typed refusal stops the job before any write with its own code; a difference is a conflict, or a
 *   mismatch in a verify step; a verify target gets earlier steps' results and shares reads with the other targets);
 * - `StepOptions.fill`: a write whose blocks are worked out inside the lock from the document as it is then;
 * - `bindFrom` with `documents.main.id`: the main page document of a page the same job created.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mainDocumentId } from '../../src/jobs/engine.js';
import type { RegisteredCheckContext } from '../../src/jobs/internal-steps.js';
import { harness, origin, PROJECT, settle, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

async function runJob(
  hh: Harness,
  e: ReturnType<Harness['newEngine']>,
  steps: Parameters<ReturnType<Harness['newEngine']>['engine']['submit']>[0] extends infer R
    ? R extends { steps: infer S }
      ? S
      : never
    : never,
) {
  const sub = await e.engine.submit({ project: PROJECT, kind: 'batch_ops', origin, steps, internal: true });
  if (!('jobId' in sub)) throw new Error('expected a job');
  const done = await settle(hh, e, e.engine.wait(PROJECT, sub.jobId, 60_000));
  if (done.error) throw done.error instanceof Error ? done.error : new Error(JSON.stringify(done.error));
  return e.engine.queries.getJob(PROJECT, sub.jobId)!;
}

describe('registered checks (v3 F3a)', () => {
  it('a refusal stops the job before any write, with its own code and details', async () => {
    h = await harness();
    h.model.seedResource('r1', { name: 'Page' });
    const e = h.newEngine();
    const seenInputs: unknown[] = [];
    e.engine.registerAsyncChecker('test.absent', async (ctx) => {
      seenInputs.push(ctx.input);
      const r = await ctx.read('getResource', { path: { resourceId: 'r1' } });
      return r.exists
        ? {
            differences: [],
            refusal: { code: 'CHARACTER_EXISTS', message: 'It exists now.', details: { existing: 'r1' } },
          }
        : { differences: [] };
    });
    const job = await runJob(h, e, [
      {
        op: 'bridge.expect',
        params: {
          body: { checks: [{ label: 'absent', kind: 'registered', checker: 'test.absent', input: 1 }] },
        },
      },
      { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'Renamed' } } },
    ]);
    expect(job.status).toBe('failed');
    expect(job.lastError).toMatchObject({
      code: 'CHARACTER_EXISTS',
      message: 'It exists now.',
      existing: 'r1',
    });
    expect(seenInputs).toEqual([1]);
    expect(h.model.count('updateResource')).toBe(0);
    expect(h.model.resources.get('r1')!.name).toBe('Page');
  });

  it('a difference is a conflict; no difference lets the writes run', async () => {
    h = await harness();
    h.model.seedResource('r1', { name: 'Page' });
    const e = h.newEngine();
    let differ = true;
    e.engine.registerAsyncChecker('test.same', () =>
      Promise.resolve({
        differences: differ ? [{ path: 'name', expected: 'Page', actual: 'Other' }] : [],
        observed: { checked: true },
      }),
    );
    const steps = [
      {
        op: 'bridge.expect',
        params: {
          body: { checks: [{ label: 'same', kind: 'registered', checker: 'test.same', input: null }] },
        },
      },
      { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'Renamed' } } },
    ];
    const failed = await runJob(h, e, steps);
    expect(failed.status).toBe('failed');
    expect(failed.lastError?.code).toBe('VERSION_CONFLICT');
    expect(h.model.count('updateResource')).toBe(0);
    differ = false;
    const ok = await runJob(h, e, steps);
    expect(ok.status).toBe('succeeded');
    expect(h.model.resources.get('r1')!.name).toBe('Renamed');
  });

  it('a missing checker stops the job before its writes', async () => {
    h = await harness();
    h.model.seedResource('r1', { name: 'Page' });
    const e = h.newEngine();
    const job = await runJob(h, e, [
      {
        op: 'bridge.expect',
        params: { body: { checks: [{ label: 'x', kind: 'registered', checker: 'nobody', input: null }] } },
      },
      { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'Renamed' } } },
    ]);
    expect(job.status).toBe('failed');
    expect(h.model.count('updateResource')).toBe(0);
  });

  it('verify targets get earlier results, share one read per step, and record a mismatch', async () => {
    h = await harness();
    h.model.seedResource('r1', { name: 'Page' });
    const e = h.newEngine();
    const contexts: RegisteredCheckContext[] = [];
    e.engine.registerAsyncChecker('test.name', async (ctx) => {
      contexts.push(ctx);
      const r = await ctx.read('getResource', { path: { resourceId: 'r1' } });
      const name = (r.body as { name?: string }).name;
      const want = (ctx.input as { name: string }).name;
      return {
        differences: name === want ? [] : [{ path: `${ctx.label} name`, expected: want, actual: name }],
      };
    });
    const before = h.mock.calls.filter(
      (c) => c.method === 'GET' && /\/resources\/r1\/?$/.test(c.path),
    ).length;
    const job = await runJob(h, e, [
      { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'Renamed' } } },
      {
        op: 'bridge.verify',
        params: {
          body: {
            targets: [
              {
                kind: 'registered',
                label: 'first',
                checker: 'test.name',
                input: { name: 'Renamed' },
                inputFrom: [{ step: 1, as: 'rename' }],
              },
              {
                kind: 'registered',
                label: 'second',
                checker: 'test.name',
                input: { name: 'Something else' },
              },
            ],
          },
        },
      },
    ]);
    expect(job.status).toBe('succeeded');
    const res = job.result as {
      verified?: boolean;
      verification?: { targets?: { label: string; status: string }[] };
    };
    expect(res.verified).toBe(false);
    expect(res.verification?.targets?.map((t) => [t.label, t.status])).toEqual(
      expect.arrayContaining([
        ['first', 'verified'],
        ['second', 'mismatch'],
      ]),
    );
    expect(contexts[0]!.phase).toBe('verify');
    expect(contexts[0]!.from.rename).toMatchObject({ name: 'Renamed' });
    const after = h.mock.calls.filter((c) => c.method === 'GET' && /\/resources\/r1\/?$/.test(c.path)).length;
    // updateResource reads once in its own lock (its pre-image); the two targets share ONE read.
    expect(after - before).toBeLessThanOrEqual(2);
  });
});

describe('fill (v3 F3a)', () => {
  it('works out the blocks inside the lock from the document as it is then, and keeps what it must', async () => {
    h = await harness();
    const unsupported = { id: 'u1', kind: 'unsupported' };
    const { documentId } = h.model.seedResource('r1', {
      name: 'Copy',
      blocks: [para('t1', 'Template text'), unsupported],
    });
    const e = h.newEngine();
    const seen: unknown[] = [];
    e.engine.registerFiller('test.keep', (ctx) => {
      seen.push(ctx.current.blocks);
      const kept = (ctx.current.blocks as { kind?: string }[]).filter((b) => b.kind === 'unsupported');
      return { blocks: [...ctx.planned, ...kept], note: { kept: kept.length } };
    });
    const job = await runJob(h, e, [
      {
        op: 'replaceDocumentBlocks',
        params: { path: { resourceId: 'r1', documentId }, body: { blocks: [para('n1', 'New text')] } },
        fill: { filler: 'test.keep' },
        verifyAfterWrite: true,
      },
    ]);
    expect(job.status).toBe('succeeded');
    expect(seen).toHaveLength(1);
    const stored = h.model.docs.get(documentId)!.blocks;
    expect(stored.map((b) => b.id)).toEqual(['n1', 'u1']);
    expect((job.result as { verified?: boolean }).verified).toBe(true);
  });

  it('a filler that throws stops the write (nothing is sent)', async () => {
    h = await harness();
    const { documentId } = h.model.seedResource('r1', { name: 'Copy', blocks: [para('t1', 'Template')] });
    const e = h.newEngine();
    e.engine.registerFiller('test.refuse', () => {
      throw new Error('not a template copy');
    });
    const job = await runJob(h, e, [
      {
        op: 'replaceDocumentBlocks',
        params: { path: { resourceId: 'r1', documentId }, body: { blocks: [para('n1', 'New')] } },
        fill: { filler: 'test.refuse' },
      },
    ]);
    expect(job.status).toBe('failed');
    expect(h.model.docs.get(documentId)!.blocks.map((b) => b.id)).toEqual(['t1']);
  });

  it('documents.main.id binds the main page document of a page the job created', async () => {
    h = await harness();
    h.model.seedResource('parent', { name: 'Parent' });
    const e = h.newEngine();
    e.engine.registerFiller('test.plain', (ctx) => ({ blocks: [...ctx.planned] }));
    const job = await runJob(h, e, [
      { op: 'createResource', params: { body: { id: 'newpg001', name: 'New page', parentId: 'parent' } } },
      {
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: 'newpg001', documentId: 'pending' },
          body: { blocks: [para('n1', 'Hi')] },
        },
        bindFrom: { step: 1, to: 'path.documentId', from: 'documents.main.id' },
        fill: { filler: 'test.plain' },
      },
    ]);
    expect(job.status).toBe('succeeded');
    expect(h.model.docs.get('d_newpg001')!.blocks.map((b) => b.id)).toEqual(['n1']);
  });

  it('mainDocumentId picks Main of type page or blank, else the only page document', () => {
    expect(
      mainDocumentId([
        { id: 'm1', name: 'Map', type: 'map' },
        { id: 'd1', name: 'Main', type: 'page' },
      ]),
    ).toBe('d1');
    expect(mainDocumentId([{ id: 'd2', name: 'Notes', type: 'page' }])).toBe('d2');
    expect(
      mainDocumentId([
        { id: 'd2', name: 'Notes', type: 'page' },
        { id: 'd3', name: 'Lore', type: 'page' },
      ]),
    ).toBeUndefined();
    expect(mainDocumentId(undefined)).toBeUndefined();
  });
});
