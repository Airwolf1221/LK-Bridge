/**
 * R2-revert, attack (g): the same job reverted twice at once.
 *
 * src/review/revert.ts `revert()`: the eligibility check (a `job_reverts` row `submitted` or `succeeded` refuses) runs
 * first, then the plan awaits its reads, the images' files are copied, the job is submitted, and only THEN the
 * `job_reverts` row is inserted. Two requests at once (a double click, two tabs, a retry after a slow answer) both pass
 * the check.
 *
 * - page text: the second revert job's check fails, but its `failed` row is the newest, so the Review page shows the
 *   revert as failed although the job was reverted, and Revert is offered again;
 * - an image placement (the revert job writes nothing in LegendKeeper): BOTH revert jobs succeed, the staged record is
 *   restaged twice and the owner gets two proposals to delete the same asset.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { blocksHash } from '../../../src/pages/blockwise.js';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';
import { PROJECT, jobOf, until, writeAgent } from './helpers.js';

describe('two reverts of one job at once', () => {
  let w: FactsWorld;
  beforeAll(async () => {
    w = await factsWorld({
      env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
      limits: { 'key-min': 5000, 'write-min': 2000 },
    });
  });
  afterAll(async () => w.close());

  it('page text: exactly one is submitted; the other is refused (REVERT_RUNNING)', async () => {
    const { client } = await writeAgent(w.stack, 'r2-double-agent');
    const rt = w.stack.runtime;
    const doc = w.repo.liveDocs(w.repo.live(P.miyabi)!).find((d) => d.name === 'Main')!.id;
    const before = blocksHash(w.repo.blocks.get(doc)!.blocks);
    const r = await w.stack.call(client, 'write_page', {
      project: 'test',
      page: P.miyabi,
      mode: 'append',
      markdown: 'She kept the shrine lamps lit through the long winter.',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt.engine.wait(PROJECT, jobId, 25_000);
    const [a, b] = await Promise.all([
      rt.reverts.revert('owner', PROJECT, jobId),
      rt.reverts.revert('owner', PROJECT, jobId),
    ]);
    for (const x of [a, b])
      if (x.status === 'submitted') await rt.engine.wait(PROJECT, x.revertJobId, 25_000);
    expect(blocksHash(w.repo.blocks.get(doc)!.blocks)).toBe(before); // reverted once
    const rows = w.stack.db
      .prepare('SELECT state FROM job_reverts WHERE job_id = ? ORDER BY id')
      .all(jobId) as { state: string }[];
    const item = rt.review.list(PROJECT, { state: 'all' }).find((i) => i.jobId === jobId)!;
    expect({
      statuses: [a.status, b.status].sort(),
      records: rows.map((x) => x.state),
      shown: item.revert?.state,
    }).toEqual({ statuses: ['refused', 'submitted'], records: ['succeeded'], shown: 'succeeded' });
  });
});

describe('two reverts of one image placement at once', () => {
  let w: ImagesWorld | undefined;
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  it('exactly one is submitted, and the owner gets ONE proposal to delete the placed asset', async () => {
    w = await imagesWorld();
    const c = await w.stack.connect();
    const call = (args: Record<string, unknown>) =>
      w!.stack.call(c, 'upload_image', { project: 'test', ...args });
    const staged = await call({
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Draft.png',
      stage: true,
      destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
    });
    expect(staged.body.status, staged.text).toBe('staged');
    const stagedId = String(staged.body.staged_id);
    const placed = await call({ staged_id: stagedId, name: 'Miyabi at the shrine.png' });
    expect(placed.body.status, placed.text).toBe('placed');
    const rt = w.stack.runtime;
    const row = rt.images.staged(PROJECT, stagedId)!;
    const jobId = row.placementJobId!;
    const assetId = row.assetId!;
    await rt.engine.wait(PROJECT, jobId, 25_000);

    const pendingDeletes = () =>
      rt.policy.proposals
        .list({ project: PROJECT, state: 'pending' })
        .filter((p) =>
          (rt.policy.proposals.detail(p.id)?.ops ?? []).some(
            (o) =>
              o.op === 'deleteAsset' &&
              (o.params as { path?: { assetId?: string } }).path?.assetId === assetId,
          ),
        ).length;
    const [a, b] = await Promise.all([
      rt.reverts.revert('owner', PROJECT, jobId),
      rt.reverts.revert('owner', PROJECT, jobId),
    ]);
    for (const x of [a, b])
      if (x.status === 'submitted') await rt.engine.wait(PROJECT, x.revertJobId, 25_000);
    await until(() => pendingDeletes() >= 1);
    await until(() => pendingDeletes() >= 2, 1500); // give a second follow-up time to appear, if there is one
    expect({ statuses: [a.status, b.status].sort(), deletionProposals: pendingDeletes() }).toEqual({
      statuses: ['refused', 'submitted'],
      deletionProposals: 1,
    });
  });
});
