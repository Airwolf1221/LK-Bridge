/**
 * v3 F2 (ADR 0049 decision 9; the owner's report of 16 November 2026): folders are found or created when the job runs,
 * not when it is planned, under the project's asset-folder lock. Two placements planned while their folder chain was
 * missing used to create it twice (LegendKeeper accepts two folders of one name under one parent).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_PRINCIPAL } from '../../src/jobs/index.js';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const CHAIN = ['Characters', 'Beastkin', 'Qishen', 'Newcomer'];
const folders = (world: ImagesWorld, name: string, parent?: string | null) =>
  [...world.assets.assets.values()].filter(
    (a) => a.type === 'FOLDER' && a.name === name && (parent === undefined || a.folderId === parent),
  );
const call = async (world: ImagesWorld, args: Record<string, unknown>, token?: string) =>
  world.stack.call(await world.stack.connect(token), 'upload_image', { project: 'test', ...args });
const stage = async (world: ImagesWorld, file: string, name: string) =>
  String(
    (await call(world, { data_base64: fixture(file).toString('base64'), name, stage: true })).body.staged_id,
  );
const approve = async (world: ImagesWorld, id: string) => {
  const pol = world.stack.runtime.policy;
  await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 300 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  return pol.proposals.get(id)!.state;
};

describe('one chain, however many placements', () => {
  it('two proposals to the same missing chain, approved one after the other, give one chain holding both images', async () => {
    w = await imagesWorld();
    const a = await stage(w, 'alpha.png', 'First');
    const b = await stage(w, 'already.webp', 'Second');
    const { token } = w.stack.newToken('proposer', 'propose');
    const dest = { folder: CHAIN.join(' / ') };
    const pa = await call(w, { staged_id: a, destination: dest }, token);
    const pb = await call(w, { staged_id: b, destination: dest }, token);
    // Both proposals honestly say the folder will be created: that is the plan when they are written.
    expect(pa.body.destination).toMatchObject({
      createsFolders: ['Characters / Beastkin / Qishen / Newcomer'],
    });
    expect(pb.body.destination).toMatchObject({
      createsFolders: ['Characters / Beastkin / Qishen / Newcomer'],
    });
    expect(await approve(w, String(pa.body.proposalId))).toBe('executed');
    expect(await approve(w, String(pb.body.proposalId))).toBe('executed');
    expect(folders(w, 'Newcomer')).toHaveLength(1);
    const folder = folders(w, 'Newcomer')[0]!.id;
    const rows = [a, b].map((id) => w!.stack.runtime.images.store.upload(PROJECT, id)!);
    expect(rows.map((r) => w!.assets.assets.get(r.assetId!)!.folderId)).toEqual([folder, folder]);
    // The second job says it found the folder; the journal says so too.
    const second = w.stack.runtime.engine.queries.getJob(PROJECT, rows[1]!.placementJobId ?? '');
    const job =
      second ?? w.stack.runtime.engine.queries.listJobs(PROJECT, {}).find((j) => j.title.includes('Second'))!;
    expect(job.result?.foldersUsed).toEqual([
      expect.objectContaining({ name: 'Newcomer', outcome: 'found existing folder', id: folder }),
    ]);
    const entries = w.stack.runtime.engine.queries
      .journalLookup(PROJECT, { opId: 'createAssetFolder', limit: 20 })
      .map((e) => (e as { operation?: Record<string, unknown> }).operation?.folder);
    expect(entries).toEqual(expect.arrayContaining(['created folder', 'found existing folder']));
  });

  it('two jobs started together at write scope give one chain; the second found it', async () => {
    w = await imagesWorld();
    const dest = { folder: CHAIN.join(' / ') };
    const engine = w.stack.runtime.engine;
    // Both planned while the chain is missing (writes paused: both are queued), then run together.
    engine.controls.pauseWrites('test');
    const [r1, r2] = await Promise.all([
      call(w, {
        data_base64: fixture('alpha.png').toString('base64'),
        name: 'One',
        destination: dest,
        waitSeconds: 0,
      }),
      call(w, {
        data_base64: fixture('already.webp').toString('base64'),
        name: 'Two',
        destination: dest,
        waitSeconds: 0,
      }),
    ]);
    for (const r of [r1, r2])
      expect(r.body.destination, r.text).toMatchObject({ createsFolders: [expect.any(String)] });
    engine.controls.resumeWrites('test');
    const jobs = await Promise.all([r1, r2].map((r) => engine.wait(PROJECT, String(r.body.jobId), 20_000)));
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    expect(folders(w, 'Newcomer')).toHaveLength(1);
    const outcomes = jobs.map(
      (j) =>
        (j.result?.foldersUsed as { name: string; outcome: string }[]).find((f) => f.name === 'Newcomer')!
          .outcome,
    );
    expect(outcomes.sort()).toEqual(['created folder', 'found existing folder']);
  });

  it('one batch with two placements to one missing path makes one chain', async () => {
    w = await imagesWorld();
    const parent = w.assets.at('Characters', 'Beastkin', 'Qishen');
    const chain = (n: number) => [
      { op: 'createAssetFolder', params: { body: { name: 'Twice', folderId: parent } }, findOrCreate: true },
      {
        op: 'createAssetFolder',
        params: { body: { name: 'Deeper' } },
        findOrCreate: true,
        bindFrom: { step: n, to: 'body.folderId' as const },
      },
    ];
    const r = await w.stack.runtime.engine.submit({
      kind: 'batch_ops',
      project: PROJECT,
      internal: true,
      steps: [...chain(1), ...chain(3)],
      origin: { kind: 'ui', tool: 'test', principal: SYSTEM_PRINCIPAL },
    });
    const job = await w.stack.runtime.engine.wait(PROJECT, (r as { jobId: string }).jobId, 20_000);
    expect(job.status).toBe('succeeded');
    expect(folders(w, 'Twice', parent)).toHaveLength(1);
    expect(folders(w, 'Deeper')).toHaveLength(1);
    expect((job.result?.foldersUsed as { outcome: string }[]).map((f) => f.outcome)).toEqual([
      'created folder',
      'created folder',
      'found existing folder',
      'found existing folder',
    ]);
  });

  it('names are byte-exact: a folder differing only in case or a trailing space is another folder', async () => {
    w = await imagesWorld();
    const parent = w.assets.at('Characters', 'Beastkin', 'Qishen');
    const c = await w.stack.connect();
    for (const name of ['newcomer', 'Newcomer '])
      await w.stack.call(c, 'lk_api_write', {
        project: 'test',
        operationId: 'createAssetFolder',
        params: { body: { name, folderId: parent } },
      });
    const dry = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Exact',
      destination: { folder: CHAIN.join(' / ') },
      dryRun: true,
    });
    expect(dry.body.destination).toMatchObject({
      createsFolders: ['Characters / Beastkin / Qishen / Newcomer'],
    });
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Exact',
      destination: { folder: CHAIN.join(' / ') },
    });
    expect(r.body.status, r.text).toBe('uploaded');
    expect(folders(w, 'Newcomer', parent)).toHaveLength(1);
    expect(folders(w, 'newcomer', parent)).toHaveLength(1);
    expect(folders(w, 'Newcomer ', parent)).toHaveLength(1);
  });

  it('a parent deleted between planning and running fails cleanly and creates nothing', async () => {
    w = await imagesWorld();
    const a = await stage(w, 'alpha.png', 'Orphaned');
    const { token } = w.stack.newToken('proposer', 'propose');
    const p = await call(w, { staged_id: a, destination: { folder: CHAIN.join(' / ') } }, token);
    const qishen = w.assets.at('Characters', 'Beastkin', 'Qishen');
    w.assets.assets.delete(qishen); // gone in the app
    const before = w.assets.assets.size;
    expect(await approve(w, String(p.body.proposalId))).toBe('failed');
    expect(folders(w, 'Newcomer')).toHaveLength(0);
    expect(w.assets.assets.size).toBe(before);
    expect(w.stack.runtime.images.store.upload(PROJECT, a)!.staged).toBe(true);
  });
});
