/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any, expect.stringMatching) in object literals */
/**
 * v2 A4: the regular refresh and the nightly check. Both walk every folder (listAssets, one level at a time) at P3 and
 * correct the asset tree from what LegendKeeper shows, recording each correction. Absence from a listing is never
 * taken as proof of deletion (a getAsset confirms it), and a refresh never undoes what the bridge's own write changed
 * after the refresh's listing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetRig, buildAssets, expectAssetsMatchModel, origin, seenAt, type AssetRig } from './helpers.js';
import type { World } from './model.js';

let rig: AssetRig;
let w: World;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const store = () => rig.i.assets.store;
const refresh = (trigger = 'manual') => rig.settle(rig.i.assets.refresh(P().id, trigger));
const check = (trigger = 'manual') => rig.settle(rig.i.assets.check(P().id, trigger));
const log = (passKind: 'refresh' | 'check') => {
  const pass = store().lastPass(P().id, passKind)!;
  return store().listLog(P().id, { limit: 500, passId: pass.id });
};

beforeEach(async () => {
  rig = await assetRig();
  w = P().model.testWorld();
  await buildAssets(rig, 'alpha');
  expectAssetsMatchModel(rig, 'alpha');
});

describe('the regular refresh', () => {
  it('costs only the listings when nothing changed, and changes nothing', async () => {
    const lists = P().model.listCalls.length;
    const r = await refresh();
    expect(r).toMatchObject({ changed: false });
    expect(P().model.listCalls.length - lists).toBe(22);
    expect(seenAt(rig, 'alpha', 'GET', /^\/assets\/[^/]+$/)).toBe(0);
    expect(store().lastPass(P().id, 'refresh')).toMatchObject({
      status: 'succeeded',
      added: 0,
      removed: 0,
      corrected: 0,
    });
    expect(log('refresh')).toEqual([]);
    expect(rig.i.assets.meta(P().id)).toMatchObject({ status: 'ready', confirmedBy: 'refresh' });
  });

  it('finds what was changed outside: renames, moves, deletions, new folders and assets', async () => {
    const m = P().model;
    const mehranaImage = m.byName('Mehrana 001', w.mehrana)[0]!.id;
    const loose = m.byName('Loose image 001', null)[0]!.id;
    const original = m.byName('Original 001', w.recovery)[0]!.id;
    m.outsideRename(w.qishen, 'Qishen Clan'); // a folder with a folder inside it
    m.outsideMove(mehranaImage, w.dwarves); // an asset moved to another folder
    m.outsideMove(w.inae, w.elves); // a folder moved up one level, with its contents
    m.outsideDelete(loose); // an asset deleted
    m.outsideDelete(w.recoveryMaps); // a folder deleted with 40 images inside it
    const fresh = m.folder('Brand new', w.maps); // a new folder in a known folder
    const freshImage = m.image('In the new folder', fresh);
    const another = m.image('Added to the root', null);
    m.outsideHide(original);
    const pic = m.assets.get(m.byName('Dwarf 001', w.dwarves)[0]!.id)!;
    pic.url = 'https://assets.legendkeeper.com/replaced.webp';
    pic.width = 1024;
    pic.height = 1536;

    const r = await refresh();
    expect(r.changed).toBe(true);
    expectAssetsMatchModel(rig, 'alpha');

    const pass = store().lastPass(P().id, 'refresh')!;
    expect(pass).toMatchObject({ status: 'succeeded', added: 3, removed: 1 + 1 + 40 });
    expect(rig.i.assets.meta(P().id).status).toBe('ready');

    // The correction log says what, with old and new values.
    const entries = log('refresh');
    const field = (id: string, f: string) => entries.find((e) => e.itemId === id && e.field === f);
    expect(field(w.qishen, 'name')).toMatchObject({
      oldValue: 'Qishen',
      newValue: 'Qishen Clan',
      itemKind: 'folder',
      source: 'refresh',
    });
    expect(field(mehranaImage, 'folderId')).toMatchObject({
      oldValue: w.mehrana,
      newValue: w.dwarves,
      itemKind: 'asset',
    });
    expect(field(w.inae, 'folderId')).toMatchObject({ oldValue: w.moonElves, newValue: w.elves });
    expect(field(original, 'isHidden')).toMatchObject({ oldValue: false, newValue: true });
    expect(field(pic.id, 'url')).toMatchObject({ newValue: 'https://assets.legendkeeper.com/replaced.webp' });
    expect(field(pic.id, 'width')).toMatchObject({ oldValue: 512, newValue: 1024 });
    expect(entries.find((e) => e.itemId === loose)).toMatchObject({ change: 'removed', itemKind: 'asset' });
    expect(entries.find((e) => e.itemId === w.recoveryMaps)).toMatchObject({
      change: 'removed',
      itemKind: 'folder',
      detail: expect.stringContaining('40 rows inside it went with it'),
    });
    expect(
      entries
        .filter((e) => e.change === 'added')
        .map((e) => e.itemId)
        .sort(),
    ).toEqual([fresh, freshImage, another].sort());
    // Paths followed the renames and moves.
    expect(rig.i.assets.queries.folder(P().id, w.mehrana).data!.path.names).toEqual([
      'Characters',
      'Beastkin',
      'Qishen Clan',
      'Mehrana al-Khalid',
    ]);
    expect(rig.i.assets.queries.folder(P().id, w.inae).data!.path.names).toEqual([
      'Characters',
      'Elves',
      'Inae Mikumo',
    ]);
    // Rows that vanished from a listing were confirmed one by one, never assumed gone: the deleted asset and the
    // deleted folder. A move seen in its new place needs no confirming read (the row had already moved).
    expect(pass.verified).toBe(2);
  });

  it('a hash recorded for an image is kept, and dropped when the image is replaced', async () => {
    const a = P().model.byName('Mehrana 001', w.mehrana)[0]!;
    const b = P().model.byName('Mehrana 002', w.mehrana)[0]!;
    store()
      .db.prepare('UPDATE asset_items SET sha256 = ?, sha256_at = 1 WHERE project_id = ? AND id IN (?, ?)')
      .run('ab'.repeat(32), P().id, a.id, b.id);
    b.url = 'https://assets.legendkeeper.com/changed.webp';
    await refresh();
    expect(store().item(P().id, a.id)!.sha256).toBe('ab'.repeat(32));
    expect(store().item(P().id, b.id)!.sha256).toBeNull();
    expect(store().counts(P().id).withHash).toBe(1);
  });

  it('absence from a listing is not proof of deletion: a getAsset confirms, and a live asset stays', async () => {
    const m = P().model;
    const kept = m.byName('Inae 003', w.inae)[0]!;
    m.hiddenFromListing.add(kept.id); // a listing that skipped it
    const gone = m.byName('Inae 004', w.inae)[0]!.id;
    m.outsideDelete(gone);
    const before = seenAt(rig, 'alpha', 'GET', /^\/assets\/[^/]+$/);
    await refresh();
    expect(seenAt(rig, 'alpha', 'GET', /^\/assets\/[^/]+$/) - before).toBe(2); // one confirming read each
    expect(store().item(P().id, kept.id)).toBeDefined();
    expect(store().item(P().id, gone)).toBeUndefined();
    expect(store().lastPass(P().id, 'refresh')).toMatchObject({ removed: 1, verified: 2 });
  });

  it('a read that cannot confirm leaves the row stale, not deleted', async () => {
    const m = P().model;
    const item = m.byName('Inae 005', w.inae)[0]!;
    m.hiddenFromListing.add(item.id);
    P().mock.inject(
      (c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/assets/${item.id}`),
      { kind: 'status', status: 503, code: 'UNAVAILABLE' },
      4,
    );
    await refresh();
    expect(store().item(P().id, item.id)).toMatchObject({ stale: 1 });
    expect(rig.i.assets.meta(P().id).status).toBe('stale');
    expect(log('refresh').find((e) => e.itemId === item.id)).toMatchObject({ change: 'reread_failed' });
    m.hiddenFromListing.clear();
    await refresh(); // the next pass settles it
    expect(store().item(P().id, item.id)).toMatchObject({ stale: 0 });
    expect(rig.i.assets.meta(P().id).status).toBe('ready');
  });

  it('is skipped before the first build, and when switched off for the project (but a manual run goes ahead)', async () => {
    const other = await assetRig({ projects: ['beta'] });
    try {
      other.p.beta!.model.testWorld();
      await expect(other.settle(other.i.assets.refresh(other.p.beta!.id, 'schedule'))).resolves.toMatchObject(
        { skipped: true, summary: expect.stringMatching(/not built yet/) },
      );
      expect(other.p.beta!.model.listCalls).toHaveLength(0);
    } finally {
      await other.close();
    }
    rig.setSetting('alpha', 'assetRefreshEnabled', false);
    const lists = P().model.listCalls.length;
    await expect(refresh('schedule')).resolves.toMatchObject({
      skipped: true,
      summary: expect.stringMatching(/switched off/),
    });
    expect(P().model.listCalls.length).toBe(lists);
    // The nightly check still runs, and so does a refresh the owner asks for.
    await expect(check('schedule')).resolves.toMatchObject({ changed: false });
    expect(P().model.listCalls.length).toBe(lists + 22);
    await expect(refresh('manual')).resolves.toMatchObject({ changed: false });
    expect(P().model.listCalls.length).toBe(lists + 44);
    rig.setSetting('alpha', 'assetRefreshEnabled', null);
    await expect(refresh('schedule')).resolves.toMatchObject({ changed: false });
  });
});

describe('a refresh never undoes what the bridge itself changed after it listed', () => {
  const listingOf = (folder: string) => (x: { method: string; url: string }) =>
    x.method === 'GET' && /\/assets\/?\?/.test(x.url) && x.url.includes(`folderId=${folder}`);
  const run = (op: string, params: Record<string, unknown>) =>
    rig.settle(rig.i.engine.run(op, params, { project: P().id, origin }));

  it('keeps a rename, a new image and a deletion made after the folder was listed', async () => {
    const m = P().model;
    const renamed = m.byName('Mehrana 001', w.mehrana)[0]!.id;
    const removed = m.byName('Mehrana 002', w.mehrana)[0]!.id;
    // The listing of Mehrana's folder is answered, but its answer is held: it describes the state before the writes.
    const hold = rig.holdResponse(listingOf(w.mehrana));
    const pending = rig.i.assets.refresh(P().id, 'manual');
    await rig.drive(() => hold.arrived());

    await run('updateAsset', { path: { assetId: renamed }, body: { name: 'Renamed portrait' } });
    const created = (await run('createImageAsset', {
      body: { uploadKey: 'k1', name: 'Fresh portrait', folderId: w.mehrana },
    })) as {
      result: { id: string };
    };
    await run('deleteAsset', { path: { assetId: removed } });
    hold.release();
    await rig.settle(pending);

    // The old listing showed the old name, lacked the new image, and still showed the deleted one.
    expect(store().item(P().id, renamed)!.name).toBe('Renamed portrait');
    expect(store().item(P().id, created.result.id)).toMatchObject({ name: 'Fresh portrait' });
    expect(store().item(P().id, removed)).toBeUndefined();
    expectAssetsMatchModel(rig, 'alpha');
    expect(rig.i.assets.meta(P().id).status).toBe('ready');
  });

  it('keeps a folder the bridge created and one it deleted after the parent was listed', async () => {
    const m = P().model;
    const hold = rig.holdResponse(listingOf(w.characters));
    const pending = rig.i.assets.refresh(P().id, 'manual');
    await rig.drive(() => hold.arrived());
    const made = (await run('createAssetFolder', { body: { name: 'New race', folderId: w.characters } })) as {
      result: { id: string };
    };
    await run('deleteAsset', { path: { assetId: w.humans } });
    hold.release();
    await rig.settle(pending);
    expect(store().folder(P().id, made.result.id)).toBeDefined();
    expect(store().folder(P().id, w.humans)).toBeUndefined(); // the old listing still showed it
    expect(m.assets.has(w.humans)).toBe(false);
    expectAssetsMatchModel(rig, 'alpha');
  });
});

describe('the nightly check', () => {
  it('does what the refresh does, logs its corrections as the check, and audits the cached paths', async () => {
    const m = P().model;
    m.outsideRename(w.maps, 'Starter maps');
    store()
      .db.prepare(`UPDATE asset_folders SET path_names = '["Wrong"]' WHERE project_id = ? AND id = ?`)
      .run(P().id, w.moonElves);
    const r = await check();
    expect(r.changed).toBe(true);
    const pass = store().lastPass(P().id, 'check')!;
    expect(pass).toMatchObject({ status: 'succeeded', kind: 'check' });
    expect(pass.summary).toMatch(/1 cached path recomputed/);
    const entries = log('check');
    expect(entries.find((e) => e.itemId === w.maps)).toMatchObject({
      field: 'name',
      source: 'check',
      newValue: 'Starter maps',
    });
    expect(entries.find((e) => e.itemId === w.moonElves)).toMatchObject({
      field: 'path',
      itemKind: 'folder',
    });
    expect(rig.i.assets.queries.folder(P().id, w.moonElves).data!.path.names).toEqual([
      'Characters',
      'Elves',
      'Moon Elves',
    ]);
    expectAssetsMatchModel(rig, 'alpha');
    expect(rig.i.assets.meta(P().id)).toMatchObject({ confirmedBy: 'check' });
  });

  it('is interrupted by a stop and the next one starts afresh', async () => {
    const hold = rig.holdRequest(
      (x) => x.method === 'GET' && /\/assets\/?\?/.test(x.url) && x.url.includes(`folderId=${w.elves}`),
    );
    const pending = rig.i.assets.check(P().id, 'manual').catch(() => undefined);
    await rig.drive(() => rig.i.sent.some((x) => x.url.includes(`folderId=${w.elves}`)));
    rig.crash();
    hold();
    void pending;
    rig.start();
    expect(store().lastPass(P().id, 'check')).toMatchObject({ status: 'interrupted' });
    await expect(check()).resolves.toMatchObject({ changed: false });
    expect(store().lastPass(P().id, 'check')).toMatchObject({ status: 'succeeded' });
  });
});
