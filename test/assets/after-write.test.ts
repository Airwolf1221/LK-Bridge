/**
 * v2 A4: updates after the bridge's own asset writes. For each of createAssetFolder, createImageAsset, updateAsset and
 * deleteAsset the engine's job re-reads the affected asset with getAsset (in the same job) and the asset tree is
 * updated from LegendKeeper's answer, never from the request; after each, the whole tree is compared with the model.
 * A failed re-read leaves the row stale and is retried; a crash between a write and its re-read is caught up at the
 * next start.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_FOLLOWED_OPS } from '../../src/assets/index.js';
import type { OpParams, RunOptions } from '../../src/jobs/index.js';
import { assetRig, buildAssets, expectAssetsMatchModel, origin, seenAt, type AssetRig } from './helpers.js';
import type { World } from './model.js';

let rig: AssetRig;
let w: World;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const store = () => rig.i.assets.store;
const gets = () => seenAt(rig, 'alpha', 'GET', /^\/assets\/[^/]+$/);
const lists = () => seenAt(rig, 'alpha', 'GET', /^\/assets$/);
const run = <T = unknown>(op: string, params: OpParams, o: Partial<RunOptions> = {}) =>
  rig.settle(rig.i.engine.run(op, params, { project: P().id, origin, ...o })) as Promise<{ result: T }>;
const folderRow = (id: string) => rig.i.assets.queries.folder(P().id, id).data;

beforeEach(async () => {
  rig = await assetRig();
  w = P().model.testWorld();
  await buildAssets(rig, 'alpha');
  expectAssetsMatchModel(rig, 'alpha');
});

describe('every followed operation', () => {
  it('follows exactly the four asset writes of the bridge', () => {
    expect([...ASSET_FOLLOWED_OPS].sort()).toEqual(
      ['createAssetFolder', 'createImageAsset', 'deleteAsset', 'updateAsset'].sort(),
    );
  });

  it('createAssetFolder: the new folder is read back, and what LegendKeeper answers is stored', async () => {
    P().model.nameFilter = (n) => n.toUpperCase(); // LegendKeeper changes the name it was given
    const g = gets();
    const r = await run<{ id: string }>('createAssetFolder', {
      body: { name: 'Gnomes', folderId: w.characters },
    });
    expect(gets() - g).toBe(1);
    expect(folderRow(r.result.id)).toMatchObject({ name: 'GNOMES', parentId: w.characters, depth: 2 });
    expect(folderRow(r.result.id)!.path.names).toEqual(['Characters', 'GNOMES']);
    expectAssetsMatchModel(rig, 'alpha');
    expect(store().pending()).toEqual([]);
    expect(store().lastPass(P().id, 'build')!.corrected).toBe(0);
  });

  it('createAssetFolder in the root, and createImageAsset in a folder and in the root', async () => {
    const root = await run<{ id: string }>('createAssetFolder', { body: { name: 'Fresh top level' } });
    const inFolder = await run<{ id: string }>('createImageAsset', {
      body: { uploadKey: 'key-1', name: 'New portrait', folderId: w.mehrana },
    });
    const inRoot = await run<{ id: string }>('createImageAsset', {
      body: { uploadKey: 'key-2', name: 'Loose new' },
    });
    expect(folderRow(root.result.id)).toMatchObject({ parentId: null, depth: 1 });
    expect(store().item(P().id, inFolder.result.id)).toMatchObject({
      name: 'New portrait',
      folder_id: w.mehrana,
      type: 'IMAGE',
      width: 512,
      height: 768,
      last_read_by: 'write',
    });
    expect(store().item(P().id, inRoot.result.id)).toMatchObject({ folder_id: null });
    expectAssetsMatchModel(rig, 'alpha');
    expect(store().counts(P().id)).toMatchObject({ folders: 19, assets: 561 });
  });

  it('updateAsset: a rename, a move and hiding are read back (the response has no body)', async () => {
    const img = P().model.byName('Qishen 001', w.qishen)[0]!.id;
    const g = gets();
    await run('updateAsset', { path: { assetId: img }, body: { name: 'Qishen, renamed' } });
    await run('updateAsset', { path: { assetId: img }, body: { folderId: w.foxians } });
    await run('updateAsset', { path: { assetId: img }, body: { isHidden: true } });
    expect(gets() - g).toBe(3);
    expect(store().item(P().id, img)).toMatchObject({
      name: 'Qishen, renamed',
      folder_id: w.foxians,
      is_hidden: 1,
    });
    await run('updateAsset', { path: { assetId: img }, body: { folderId: null } });
    expect(store().item(P().id, img)).toMatchObject({ folder_id: null });
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('updateAsset on a folder: its subtree follows, every path is recomputed', async () => {
    await run('updateAsset', { path: { assetId: w.qishen }, body: { name: 'Qishen Clan' } });
    expect(folderRow(w.mehrana)!.path.names).toEqual([
      'Characters',
      'Beastkin',
      'Qishen Clan',
      'Mehrana al-Khalid',
    ]);
    await run('updateAsset', { path: { assetId: w.moonElves }, body: { folderId: w.qishen } });
    expect(folderRow(w.inae)!.path.names).toEqual([
      'Characters',
      'Beastkin',
      'Qishen Clan',
      'Moon Elves',
      'Inae Mikumo',
    ]);
    expect(folderRow(w.inae)!.depth).toBe(5);
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('a move into a folder the bridge has not seen reads the folders above it', async () => {
    const m = P().model;
    const outside = m.folder('Made in the app', w.maps);
    const inner = m.folder('Inner', outside);
    const img = m.byName('Starter map 001', w.maps)[0]!.id;
    const g = gets();
    await run('updateAsset', { path: { assetId: img }, body: { folderId: inner } });
    expect(gets() - g).toBe(3); // the asset, then the two folders above it
    expect(folderRow(inner)!.path.names).toEqual(['Maps to get started', 'Made in the app', 'Inner']);
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('deleteAsset: an image, then a folder with everything inside it', async () => {
    const img = P().model.byName('Foxian 001', w.foxians)[0]!.id;
    const g = gets();
    await run('deleteAsset', { path: { assetId: img } });
    // CR-2026-11 (CR-01): the delete's own read of the asset (its journal pre-image), then the asset tree's re-read.
    expect(gets() - g).toBe(2);
    expect(store().item(P().id, img)).toBeUndefined();
    // LegendKeeper's deleteAsset deletes a folder's contents at any depth; the folder reads as 404.
    await run('deleteAsset', { path: { assetId: w.beastkin } });
    for (const gone of [w.beastkin, w.qishen, w.mehrana, w.foxians]) expect(folderRow(gone)).toBeNull();
    expect(store().counts(P().id)).toMatchObject({ folders: 14, assets: 559 - 1 - 12 - 3 - 19 });
    expectAssetsMatchModel(rig, 'alpha');
    // An older listing cannot bring it back (a tombstone remembers when it was seen gone).
    expect(store().tombstone(P().id, w.mehrana)).toBeDefined();
  });

  it('writes the tree does not follow cost nothing', async () => {
    const g = gets();
    const l = lists();
    await rig.settle(rig.i.engine.run('listAssets', { query: {} }, { project: P().id, origin }));
    await rig.settle(
      rig.i.engine.run('getAsset', { path: { assetId: w.mehrana } }, { project: P().id, origin }),
    );
    expect(gets() - g).toBe(1); // only the agent's own read
    expect(lists() - l).toBe(1);
    expect(store().pending()).toEqual([]);
  });

  it('records how and when each row was last read', async () => {
    const img = P().model.byName('Foxian 002', w.foxians)[0]!.id;
    expect(store().item(P().id, img)!.last_read_by).toBe('build');
    await rig.clock.advance(5000);
    await run('updateAsset', { path: { assetId: img }, body: { name: 'Foxian, again' } });
    expect(store().item(P().id, img)).toMatchObject({ last_read_by: 'write' });
    expect(store().item(P().id, img)!.last_read_at).toBeGreaterThan(rig.i.assets.meta(P().id).confirmedAt!);
  });
});

describe('before the first build, and during it', () => {
  it('nothing is read after a write while the tree has never been built', async () => {
    const other = await assetRig({ projects: ['beta'] });
    try {
      const m = other.p.beta!.model;
      const f = m.testWorld();
      const g = seenAt(other, 'beta', 'GET', /^\/assets\/[^/]+$/);
      await other.settle(
        other.i.engine.run(
          'createAssetFolder',
          { body: { name: 'New', folderId: f.characters } },
          { project: other.p.beta!.id, origin },
        ),
      );
      expect(seenAt(other, 'beta', 'GET', /^\/assets\/[^/]+$/) - g).toBe(0);
      expect(other.i.assets.store.pending()).toEqual([]);
      expect(other.i.assets.store.countFolders(other.p.beta!.id)).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('writes made while a build is walking are followed, even into folders already walked', async () => {
    const other = await assetRig({ projects: ['beta'] });
    try {
      const b = other.p.beta!;
      const f = b.model.testWorld();
      // Pause the walk at the Recovery folder (the third top-level folder), after Characters has been listed.
      const release = other.holdRequest(
        (x) => x.method === 'GET' && x.url.includes(`folderId=${f.recovery}`),
      );
      other.i.assets.prepareBuild(b.id, { trigger: 'test', autoConfirm: true });
      await other.drive(() => other.i.sent.some((x) => x.url.includes(`folderId=${f.recovery}`)));
      await other.drive(() => other.i.assets.store.folder(b.id, f.beastkin) !== undefined);
      const made = (await other.settle(
        other.i.engine.run(
          'createAssetFolder',
          { body: { name: 'Late', folderId: f.characters } },
          { project: b.id, origin },
        ),
      )) as { result: { id: string } };
      release();
      await other.drive(() => other.i.assets.store.activePass(b.id) === undefined);
      expect(other.i.assets.store.folder(b.id, made.result.id)).toBeDefined();
      expectAssetsMatchModel(other, 'beta');
    } finally {
      await other.close();
    }
  });
});

describe('when a re-read cannot be made', () => {
  it('an uncertain create with no id in the response lists the folder it was put in', async () => {
    P().model.createWithoutBody = true;
    const l = lists();
    const r = await run<Record<string, never>>('createAssetFolder', {
      body: { name: 'Anonymous', folderId: w.elves },
    });
    expect(r.result).toEqual({});
    expect(lists() - l).toBe(1); // the folder it was put in, listed
    const made = P().model.byName('Anonymous', w.elves)[0]!;
    expect(folderRow(made.id)).toMatchObject({ name: 'Anonymous', parentId: w.elves });
    expectAssetsMatchModel(rig, 'alpha');
    expect(store().pending()).toEqual([]);
  });

  it('a failed re-read is recorded, the row is stale, and a retry settles it', async () => {
    // The create succeeds, but the re-read of the new folder fails every attempt (the governor retries a 503 three times).
    P().mock.inject(
      (c) =>
        c.method === 'GET' &&
        /\/assets\/[^/]+$/.test(c.path.replace(/\/$/, '')) &&
        !c.path.includes('uploads'),
      { kind: 'status', status: 503, code: 'UNAVAILABLE' },
      4,
    );
    const r = await run<{ id: string }>('createAssetFolder', { body: { name: 'Unread', folderId: w.elves } });
    expect(store().folder(P().id, r.result.id)).toBeUndefined();
    expect(rig.i.assets.meta(P().id)).toMatchObject({ status: 'stale', pendingRereads: 1 });
    expect(store().listLog(P().id, { limit: 5, source: 'write' })[0]).toMatchObject({
      change: 'reread_failed',
    });
    expect(rig.i.engine.queries.listErrors(P().id, {}).some((e) => e.opId === 'getAsset')).toBe(true);
    // The retry (a minute later, at P3) reads it and settles the tree.
    await rig.drive(() => store().folder(P().id, r.result.id) !== undefined);
    await rig.settle(rig.i.assets.whenIdle());
    expect(rig.i.assets.meta(P().id).status).toBe('ready');
    expect(store().pending()).toEqual([]);
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('a crash between a write and its re-read is caught up at the next start', async () => {
    const hold = (x: { method: string; url: string }) =>
      x.method === 'GET' && /\/assets\/[a-z0-9]+\/?$/.test(x.url);
    const release = rig.holdRequest(hold);
    rig.i.engine
      .run('createAssetFolder', { body: { name: 'Crashy', folderId: w.elves } }, { project: P().id, origin })
      .catch(() => undefined); // the "dead" process's call never completes
    await rig.drive(() => P().model.byName('Crashy').length === 1 && store().pending().length === 1);
    rig.crash();
    release();
    rig.start();
    const made = P().model.byName('Crashy')[0]!.id;
    await rig.drive(() => store().folder(P().id, made) !== undefined);
    expect(store().pending()).toEqual([]);
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('a write that failed without applying re-reads nothing', async () => {
    const g = gets();
    await expect(
      run('createAssetFolder', { body: { name: 'Nowhere', folderId: 'does-not-exist' } }),
    ).rejects.toMatchObject({ code: 'LK_ERROR' });
    expect(gets() - g).toBe(0);
    expect(store().pending()).toEqual([]);
    expect(P().model.byName('Nowhere')).toHaveLength(0);
  });
});
