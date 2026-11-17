/**
 * R2-revert, attack (f): Revert writing into LegendKeeper's `LK-Bridge staging` folder.
 *
 * ADR 0051 decision 3 and ADR 0055 B5: "Nothing is ever written to LegendKeeper's staging folder". An asset moved OUT of
 * the staging folder by a plain `updateAsset` (no staged record placed by that job) is an "ordinary asset move", which
 * Revert puts back where it came from, unless src/review/targets.ts recognises the folder it came from as the staging
 * folder: `isStagingFolder` (src/review/service.ts) compares the NAME the bridge's own asset tree holds for that folder
 * id with the project's staging folder name. Nothing is read live, so when the asset tree does not hold the folder (the
 * tree not built yet, or the folder made in the app since its last pass) or the staging folder's name setting has been
 * changed since, the check fails OPEN and the revert moves the asset back into the staging folder.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../../src/projects/index.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';
import { PROJECT, jobOf, revertAndWait } from './helpers.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** An image staged the old way: hidden in LegendKeeper's staging folder (made by the bridge's old staging path). */
async function stagedTheOldWay(world: ImagesWorld): Promise<{ assetId: string; staging: string }> {
  const svc = world.stack.runtime.images;
  const plan = svc.planStaging(PROJECT);
  if (!plan.ok) throw new Error(plan.error.message);
  const started = await svc.startUpload({
    projectId: PROJECT,
    image: await svc.convert(fixture('alpha.png')),
    name: 'Old draft',
    plan: plan.plan,
    staged: true,
    stageIn: 'legendkeeper',
    source: 'data_base64',
    origin: { kind: 'test' },
  });
  await world.stack.runtime.engine.wait(PROJECT, started.row!.jobId!, 20_000);
  const old = svc.settle(svc.store.upload(PROJECT, started.row!.id)!);
  const staging = world.assets.at('LK-Bridge staging');
  expect(world.assets.assets.get(old.assetId!)).toMatchObject({ folderId: staging, isHidden: true });
  return { assetId: old.assetId!, staging };
}

/** The agent moves it out with a raw updateAsset (the default test profile: rails off, as the owner may set them). */
async function rawMoveOut(world: ImagesWorld, assetId: string): Promise<string> {
  const c = await world.stack.connect();
  const to = world.assets.at('Characters');
  const r = await world.stack.call(c, 'lk_api_write', {
    project: 'test',
    operationId: 'updateAsset',
    params: { path: { assetId }, body: { folderId: to, isHidden: false } },
  });
  expect(r.isError, r.text).toBe(false);
  const jobId = jobOf(r);
  const job = await world.stack.runtime.engine.wait(PROJECT, jobId, 25_000);
  expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  expect(world.assets.assets.get(assetId)!.folderId).toBe(to);
  return jobId;
}

describe('Revert never writes into the staging folder', () => {
  it('the asset tree knows the staging folder: the move out is not revertible (control)', async () => {
    w = await imagesWorld();
    const { assetId, staging } = await stagedTheOldWay(w);
    const jobId = await rawMoveOut(w, assetId);
    const { r } = await revertAndWait(w.stack, jobId);
    expect(r.status).toBe('refused');
    expect(w.assets.assets.get(assetId)!.folderId).not.toBe(staging);
  });

  it('the asset tree does not hold the staging folder: the revert must still not move the asset back into it', async () => {
    w = await imagesWorld();
    const { assetId, staging } = await stagedTheOldWay(w);
    const jobId = await rawMoveOut(w, assetId);
    // The bridge's asset tree has not seen the folder (not built yet for the project, or made since its last pass).
    w.stack.db.prepare('DELETE FROM asset_folders WHERE project_id = ? AND id = ?').run(PROJECT, staging);
    const { r, job } = await revertAndWait(w.stack, jobId);
    expect(
      { folder: w.assets.assets.get(assetId)!.folderId === staging ? 'LK-Bridge staging' : 'elsewhere' },
      `revert ${r.status}, job ${job?.status ?? '-'}`,
    ).toEqual({ folder: 'elsewhere' });
  });

  it('the project’s staging folder name was changed since: the old LK-Bridge staging folder is still never written', async () => {
    w = await imagesWorld();
    const { assetId, staging } = await stagedTheOldWay(w);
    const jobId = await rawMoveOut(w, assetId);
    new ProjectStore(w.stack.db).setSetting(PROJECT, 'imageStagingFolder', 'Bridge drafts');
    const { r, job } = await revertAndWait(w.stack, jobId);
    expect(
      { folder: w.assets.assets.get(assetId)!.folderId === staging ? 'LK-Bridge staging' : 'elsewhere' },
      `revert ${r.status}, job ${job?.status ?? '-'}`,
    ).toEqual({ folder: 'elsewhere' });
  });
});
