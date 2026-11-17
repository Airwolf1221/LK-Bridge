/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3.4 (ADR 0055 decision B): Revert of an image placement. A staged image placed at scope `write` is a new asset in
 * its folder (made from the bytes kept on the bridge); reverting the placement moves it back to staging: into the
 * project's staging folder in LegendKeeper, hidden, and back on the Staging page. An asset is never deleted by a revert;
 * the folders the placement made stay. And an asset moved since the placement is not touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function placeOne(world: ImagesWorld) {
  const c = await world.stack.connect();
  const call = (args: Record<string, unknown>) => world.stack.call(c, 'upload_image', { project: 'test', ...args });
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
  const row = world.stack.runtime.images.staged(PROJECT, stagedId)!;
  return { stagedId, assetId: row.assetId!, jobId: row.placementJobId! };
}

describe('Revert of an image placement', () => {
  it('moves the asset to the staging folder, hidden; never deletes it; it is back on the Staging page', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    await rt.engine.wait(PROJECT, jobId, 25_000);
    const preview = await rt.reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`)).toEqual(['image:ready']);
    const callsBefore = w.stack.mock.calls.length;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    if (r.status !== 'submitted') return;
    const job = await rt.engine.wait(PROJECT, r.revertJobId, 25_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    const staging = w.assets.at('LK-Bridge staging');
    expect(w.assets.assets.get(assetId)).toMatchObject({ folderId: staging, isHidden: true });
    // Never deleted: no asset delete was sent, and the asset is still there.
    expect(w.stack.mock.calls.slice(callsBefore).filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(w.assets.assets.has(assetId)).toBe(true);
    // Back on the Staging page, to place again or discard.
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: true, assetId, folderId: staging });
    expect(rt.images.listStaged(PROJECT).some((x) => x.id === stagedId)).toBe(true);
  });

  it('an asset moved since the placement is not touched', async () => {
    w = await imagesWorld();
    const { assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    await rt.engine.wait(PROJECT, jobId, 25_000);
    // Someone moves it in the app.
    w.assets.assets.get(assetId)!.folderId = null;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r).toMatchObject({ status: 'refused', code: 'NOTHING_TO_REVERT' });
    expect((r as { readonly targets: readonly { state: string }[] }).targets[0]!.state).toBe('changed');
    expect(w.assets.assets.get(assetId)!.folderId).toBeNull();
  });
});
