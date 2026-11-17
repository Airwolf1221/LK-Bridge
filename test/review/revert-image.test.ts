/**
 * v3 F3.4 (ADR 0055 decision B5): Revert of an image placement. Nothing is ever written to LegendKeeper's staging folder
 * (`LK-Bridge staging`), and the revert itself never deletes an asset:
 *
 * - the placed asset's file is copied back into the bridge's server staging (one download from the asset host) BEFORE
 *   the revert job, so the image is back on the Staging page once the job succeeds, to place again or discard;
 * - deleting the placed asset is ONE proposal for the owner (by the bridge, never run before the owner approves it);
 * - the revert job itself only checks, inside its lock, that the asset is still as the placement left it.
 *
 * Both kinds of placement: an image staged on the bridge's server (an upload into its folder), and one staged the old
 * way in LegendKeeper's staging folder (a move out of it). An asset moved since is not touched; a file that cannot be
 * saved refuses the revert, writing nothing. An agent with the default rails places the image again directly (a
 * placement is not an asset move), while a plain asset move is still proposed by the rail.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const writesSince = (world: ImagesWorld, n: number) =>
  world.stack.mock.calls.slice(n).filter((c) => c.method !== 'GET' && c.method !== 'HEAD');
const stagingFolders = (world: ImagesWorld) =>
  [...world.assets.assets.values()].filter((a) => a.type === 'FOLDER' && a.name === 'LK-Bridge staging');

async function placeOne(world: ImagesWorld) {
  const c = await world.stack.connect();
  const call = (args: Record<string, unknown>) =>
    world.stack.call(c, 'upload_image', { project: 'test', ...args });
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
  await world.stack.runtime.engine.wait(PROJECT, row.placementJobId!, 25_000);
  return { stagedId, assetId: row.assetId!, jobId: row.placementJobId! };
}

/** An image staged the old way (hidden in LegendKeeper's staging folder), then placed by an agent (a move out of it). */
async function placeTheOldWay(world: ImagesWorld) {
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
  const c = await world.stack.connect();
  const placed = await world.stack.call(c, 'upload_image', {
    project: 'test',
    staged_id: old.id,
    destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
  });
  expect(placed.body.status, placed.text).toBe('placed');
  const row = svc.staged(PROJECT, old.id)!;
  await world.stack.runtime.engine.wait(PROJECT, row.placementJobId!, 25_000);
  return { stagedId: old.id, assetId: old.assetId!, jobId: row.placementJobId! };
}

/** Reverts as the owner, waits for the revert job and then for the bridge's follow-up (the deletion proposal). */
async function revert(world: ImagesWorld, jobId: string, stagedId: string) {
  const rt = world.stack.runtime;
  const r = await rt.reverts.revert('owner', PROJECT, jobId);
  expect(r.status, JSON.stringify(r)).toBe('submitted');
  if (r.status !== 'submitted') throw new Error('not submitted');
  const job = await rt.engine.wait(PROJECT, r.revertJobId, 25_000);
  expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  let proposalId: string | null = null;
  for (let i = 0; i < 200 && !proposalId; i++) {
    const a = rt.policy.store.listAudit({ action: 'job.revert', limit: 20 }).find((x) => {
      const after = x.after as { outcome?: string } | null;
      return x.target === jobId && after?.outcome === 'images';
    });
    const images = (
      a?.after as { images?: { stagedId: string; deletionProposalId: string | null }[] } | undefined
    )?.images;
    proposalId = images?.find((x) => x.stagedId === stagedId)?.deletionProposalId ?? null;
    if (!proposalId) await sleep(25);
  }
  expect(proposalId, 'the deletion proposal').toMatch(/^prop_/);
  return { revertJobId: r.revertJobId, message: r.message, proposalId: proposalId! };
}

describe('Revert of an image placement (ADR 0055 decision B5)', () => {
  it('a placement from the bridge’s server: the image back on the Staging page, its deletion proposed; nothing written to the staging folder', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    const placedFolder = w.assets.assets.get(assetId)!.folderId;
    const preview = await rt.reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`)).toEqual(['image:ready']);
    expect(preview.targets[0]!.detail).toMatch(
      /Staging page.*proposed to you; nothing is written to the staging folder/,
    );
    const callsBefore = w.stack.mock.calls.length;
    const { message, proposalId } = await revert(w, jobId, stagedId);
    expect(message).toMatch(/back to the Staging page.*proposed to you on the Proposals page/);
    // Nothing written to LegendKeeper by the revert: no move, no hiding, no staging folder, no delete.
    expect(writesSince(w, callsBefore)).toEqual([]);
    expect(stagingFolders(w)).toEqual([]);
    expect(w.assets.assets.get(assetId)).toMatchObject({ folderId: placedFolder, isHidden: false });
    // Back on the Staging page, its file on the bridge's server: exactly the file that was staged.
    const row = rt.images.staged(PROJECT, stagedId)!;
    expect(row).toMatchObject({ staged: true, state: 'uploaded', assetId: null, placementJobId: null });
    expect(row.serverSha256).toBe(row.webp.sha256);
    expect(sha((await rt.images.stagedImage(PROJECT, stagedId))!)).toBe(row.webp.sha256);
    expect(rt.images.listStaged(PROJECT).some((x) => x.id === stagedId)).toBe(true);
    // ONE proposal, by the bridge, to delete the placed asset; nothing deleted before the owner approves it.
    const p = rt.policy.proposals.detail(proposalId)!;
    expect(p.state).toBe('pending');
    expect(p.principalId).toBe('system');
    expect(
      p.ops.map((o) => `${o.op} ${(o.params as { path?: { assetId?: string } }).path?.assetId}`),
    ).toEqual([`deleteAsset ${assetId}`]);
    expect(w.assets.assets.has(assetId)).toBe(true);
    // Approved, the asset goes (its bytes kept first, as for every asset delete).
    await rt.policy.commands.approve('owner', proposalId);
    for (let i = 0; i < 300 && w.assets.assets.has(assetId); i++) await sleep(20);
    expect(w.assets.assets.has(assetId)).toBe(false);
    // And the staged image can be placed again: a new asset.
    const c = await w.stack.connect();
    const again = await w.stack.call(c, 'upload_image', { project: 'test', staged_id: stagedId });
    expect(again.body.status, again.text).toBe('placed');
    const placedAgain = rt.images.staged(PROJECT, stagedId)!;
    await rt.engine.wait(PROJECT, placedAgain.placementJobId!, 25_000);
    const newAsset = rt.images.staged(PROJECT, stagedId)!.assetId;
    expect(newAsset).toBeTruthy();
    expect(newAsset).not.toBe(assetId);
  });

  it('a placement of an image staged the old way (in LegendKeeper’s staging folder): nothing moved back there either', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeTheOldWay(w);
    const rt = w.stack.runtime;
    const staging = w.assets.at('LK-Bridge staging');
    const placedFolder = w.assets.assets.get(assetId)!.folderId;
    expect(placedFolder).not.toBe(staging);
    const preview = await rt.reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`)).toEqual(['image:ready']);
    const callsBefore = w.stack.mock.calls.length;
    const { proposalId } = await revert(w, jobId, stagedId);
    expect(writesSince(w, callsBefore)).toEqual([]);
    // Not moved back into the staging folder, not hidden: left where it is until the owner approves the delete.
    expect(w.assets.assets.get(assetId)).toMatchObject({ folderId: placedFolder, isHidden: false });
    expect(
      [...w.assets.assets.values()].filter((a) => a.folderId === staging && a.type !== 'FOLDER'),
    ).toEqual([]);
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: true, assetId: null });
    expect(rt.policy.proposals.detail(proposalId)!.ops.map((o) => o.op)).toEqual(['deleteAsset']);
  });

  it('an agent with the default rails places it again directly: a placement is not an asset move (ADR 0055 F)', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    await revert(w, jobId, stagedId);
    // A profile as the owner will raise it: scope write, the default rails (asset deletes and moves proposed).
    const t = w.stack.newToken('image-agent-default-rails', 'write');
    const agent = await w.stack.connect(t.token);
    const again = await w.stack.call(agent, 'upload_image', {
      project: 'test',
      staged_id: stagedId,
      name: 'Miyabi at the shrine.png',
    });
    expect(again.body.status, again.text).toBe('placed');
    expect(again.body.proposedBecause).toBeUndefined();
    const row = rt.images.staged(PROJECT, stagedId)!;
    await rt.engine.wait(PROJECT, row.placementJobId!, 25_000);
    const placed = rt.images.staged(PROJECT, stagedId)!.assetId!;
    expect(w.assets.assets.get(placed)).toMatchObject({ isHidden: false });
    // An asset move that is not a placement is still proposed by the rail.
    const move = await w.stack.call(agent, 'lk_api_write', {
      project: 'test',
      operationId: 'updateAsset',
      params: { path: { assetId }, body: { folderId: null } },
    });
    expect(move.body.status, move.text).toBe('proposal_captured');
    expect(move.body.proposedBecause).toBe('proposed because: asset move (to another folder)');
  });

  it('an asset moved since the placement is not touched, and nothing is copied', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    // Someone moves it in the app.
    w.assets.assets.get(assetId)!.folderId = null;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r).toMatchObject({ status: 'refused', code: 'NOTHING_TO_REVERT' });
    expect((r as { readonly targets: readonly { state: string }[] }).targets[0]!.state).toBe('changed');
    expect(w.assets.assets.get(assetId)!.folderId).toBeNull();
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: false, assetId });
  });

  it('a file that cannot be saved to the bridge refuses the revert: nothing written, no job, no proposal', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    w.failDownload.set(assetId, 500);
    const pending = rt.policy.proposals.list({ project: PROJECT, state: 'pending' }).length;
    const callsBefore = w.stack.mock.calls.length;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r).toMatchObject({ status: 'refused', code: 'IMAGE_NOT_SAVED' });
    expect(writesSince(w, callsBefore)).toEqual([]);
    expect(rt.policy.proposals.list({ project: PROJECT, state: 'pending' })).toHaveLength(pending);
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: false, assetId });
    expect(rt.policy.store.listAudit({ action: 'job.revert', limit: 1 })[0]!.after).toMatchObject({
      outcome: 'refused',
      code: 'IMAGE_NOT_SAVED',
    });
    // Once the file can be read again, the revert goes ahead.
    w.failDownload.delete(assetId);
    await revert(w, jobId, stagedId);
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: true, assetId: null });
  });
});
