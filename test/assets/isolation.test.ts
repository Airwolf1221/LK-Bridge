/**
 * v2 A4: two projects in one bridge never mix. Each has its own asset model (even with the same asset ids), its own
 * status, build, refresh, after-write updates and queries; a row cannot refer to a folder of another project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetRig, buildAssets, expectAssetsMatchModel, origin, type AssetRig } from './helpers.js';

let rig: AssetRig;
afterEach(async () => rig?.close());

const A = () => rig.p.alpha!;
const B = () => rig.p.beta!;
const store = () => rig.i.assets.store;

beforeEach(async () => {
  rig = await assetRig({ projects: ['alpha', 'beta'] });
  // Both libraries use the SAME ids for different things.
  const a = A().model;
  const b = B().model;
  a.folder('Characters', null, 'same0001');
  a.folder('Elves', 'same0001', 'same0002');
  a.image('Alpha portrait', 'same0002', { id: 'same0003' });
  b.folder('Maps', null, 'same0001');
  b.folder('Dungeons', 'same0001', 'same0002');
  b.image('Beta map', 'same0002', { id: 'same0003' });
  b.image('Beta only', 'same0001', { id: 'betaonly' });
});

describe('two projects', () => {
  it('build separately, with the same ids holding different things', async () => {
    await buildAssets(rig, 'alpha');
    expect(rig.i.assets.meta(A().id).status).toBe('ready');
    expect(rig.i.assets.meta(B().id).status).toBe('not_built'); // alpha's build is not beta's
    expect(store().countFolders(B().id)).toBe(0);
    await buildAssets(rig, 'beta');
    expectAssetsMatchModel(rig, 'alpha');
    expectAssetsMatchModel(rig, 'beta');
    expect(store().folder(A().id, 'same0001')!.name).toBe('Characters');
    expect(store().folder(B().id, 'same0001')!.name).toBe('Maps');
    expect(store().item(A().id, 'same0003')!.name).toBe('Alpha portrait');
    expect(store().item(B().id, 'same0003')!.name).toBe('Beta map');
  });

  it('answer queries from their own project only', async () => {
    await buildAssets(rig, 'alpha');
    await buildAssets(rig, 'beta');
    const q = rig.i.assets.queries;
    expect(q.findFoldersByName(A().id, 'Maps').data).toEqual([]);
    expect(q.findFoldersByName(B().id, 'Maps').data).toHaveLength(1);
    expect(q.foldersByPath(A().id, ['Characters', 'Elves']).data).toHaveLength(1);
    expect(q.foldersByPath(B().id, ['Characters', 'Elves']).data).toEqual([]);
    expect(q.assetsIn(A().id, null).data.total).toBe(0);
    expect(q.assetsIn(B().id, 'same0001').data.assets.map((x) => x.name)).toEqual(['Beta only']);
    expect(q.counts(A().id).data).toMatchObject({ folders: 2, assets: 1 });
    expect(q.counts(B().id).data).toMatchObject({ folders: 2, assets: 2 });
    expect(q.subtree(A().id, null).data.folders.map((f) => f.folder.name)).toEqual(['Characters', 'Elves']);
  });

  it('follow their own writes: a write to one leaves the other untouched', async () => {
    await buildAssets(rig, 'alpha');
    await buildAssets(rig, 'beta');
    const before = JSON.stringify(store().children(B().id, null));
    await rig.settle(
      rig.i.engine.run(
        'createAssetFolder',
        { body: { name: 'Dwarves', folderId: 'same0001' } },
        { project: A().id, origin },
      ),
    );
    await rig.settle(
      rig.i.engine.run(
        'updateAsset',
        { path: { assetId: 'same0003' }, body: { name: 'Alpha renamed' } },
        { project: A().id, origin },
      ),
    );
    expect(store().item(A().id, 'same0003')!.name).toBe('Alpha renamed');
    expect(store().item(B().id, 'same0003')!.name).toBe('Beta map');
    expect(JSON.stringify(store().children(B().id, null))).toBe(before);
    expect(rig.p.beta!.model.mutations).toEqual([]);
    expectAssetsMatchModel(rig, 'alpha');
    expectAssetsMatchModel(rig, 'beta');
  });

  it('refresh, check and status are per project', async () => {
    await buildAssets(rig, 'alpha');
    await buildAssets(rig, 'beta');
    B().model.outsideRename('same0002', 'Dungeons and more');
    await rig.settle(rig.i.assets.refresh(A().id, 'manual'));
    expect(store().folder(B().id, 'same0002')!.name).toBe('Dungeons'); // alpha's refresh never touched beta
    await rig.settle(rig.i.assets.check(B().id, 'manual'));
    expect(store().folder(B().id, 'same0002')!.name).toBe('Dungeons and more');
    expect(store().folder(A().id, 'same0002')!.name).toBe('Elves');
    // A stale row in one project does not make the other stale.
    store().markStale(B().id, ['same0003'], 'test');
    expect(rig.i.assets.meta(B().id).status).toBe('stale');
    expect(rig.i.assets.meta(A().id).status).toBe('ready');
    expect(
      store()
        .listLog(A().id, { limit: 50 })
        .some((e) => e.itemName === 'Dungeons and more'),
    ).toBe(false);
  });

  it('cannot hold a row that points at a folder of another project', async () => {
    await buildAssets(rig, 'alpha');
    await buildAssets(rig, 'beta');
    B().model.folder('Only in beta', null, 'betafold');
    await rig.settle(rig.i.assets.refresh(B().id, 'manual'));
    // The database refuses an asset in alpha that names beta's folder, and a folder under it.
    expect(() =>
      rig.i.db
        .prepare(`UPDATE asset_items SET folder_id = 'betafold' WHERE project_id = ? AND id = 'same0003'`)
        .run(A().id),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      rig.i.db
        .prepare(`UPDATE asset_folders SET parent_id = 'betafold' WHERE project_id = ? AND id = 'same0002'`)
        .run(A().id),
    ).toThrow(/FOREIGN KEY/);
  });

  it('one project’s build can be running while the other is ready', async () => {
    await buildAssets(rig, 'alpha');
    rig.i.assets.prepareBuild(B().id, { trigger: 'test' });
    await rig.drive(() => store().activePass(B().id)?.status === 'awaiting_confirmation');
    expect(rig.i.assets.meta(A().id).status).toBe('ready');
    expect(rig.i.assets.meta(B().id).status).toBe('not_built');
    // Alpha can refresh while beta waits for its owner.
    await expect(rig.settle(rig.i.assets.refresh(A().id, 'manual'))).resolves.toMatchObject({
      changed: false,
    });
    rig.i.assets.cancelBuild(B().id);
  });
});
