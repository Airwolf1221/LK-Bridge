/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any, expect.stringMatching) in object literals */
/**
 * v2 A4: the first build of the asset tree. It lists the library's root level and stops to show the estimate; after
 * the owner confirms it walks every folder (listAssets returns one folder level at a time, paged), at P3. The test
 * world has the shape the phase 0 spike found: 18 folders and 559 images. A restart continues where it stopped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assetRig, buildAssets, expectAssetsMatchModel, seenAt, type AssetRig } from './helpers.js';

let rig: AssetRig;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const store = () => rig.i.assets.store;
const active = () => store().activePass(P().id);

describe('the first build', () => {
  it('lists the root level, shows an estimate, and walks nothing more until it is confirmed', async () => {
    rig = await assetRig();
    P().model.testWorld();
    expect(rig.i.assets.meta(P().id)).toMatchObject({ status: 'not_built' });

    const pass = rig.i.assets.prepareBuild(P().id, { trigger: 'test' });
    expect(pass).toMatchObject({ kind: 'build', status: 'preparing' });
    await rig.drive(() => active()?.status === 'awaiting_confirmation');

    // Only the root level was listed: one request, and the three top-level folders are known.
    expect(P().model.listCalls).toHaveLength(1);
    const waiting = active()!;
    expect(waiting.estimate).toMatchObject({
      rootFolders: 3,
      rootAssets: 6,
      requestsSoFar: 1,
      minRequestsRemaining: 3,
      likelyRequestsRemaining: 3,
      basis: 'root level only',
      previousFolders: null,
    });
    expect(waiting.estimate!.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(rig.i.assets.meta(P().id)).toMatchObject({ status: 'not_built' });
    expect(rig.i.assets.meta(P().id).reason).toMatch(/waiting for you to confirm/);
    // Time passing does not start the walk.
    await rig.clock.advance(3_600_000);
    expect(P().model.listCalls).toHaveLength(1);

    rig.i.assets.confirmBuild(P().id);
    await rig.drive(() => active() === undefined);
    await rig.settle(rig.i.assets.whenIdle());

    const done = store().lastPass(P().id, 'build')!;
    expect(done).toMatchObject({ status: 'succeeded', foldersFound: 18, foldersDone: 18, foldersFailed: 0 });
    expectAssetsMatchModel(rig, 'alpha');
    expect(store().counts(P().id)).toMatchObject({
      folders: 18,
      assets: 559,
      byType: { IMAGE: 559 },
      withHash: 0,
    });
    expect(rig.i.assets.meta(P().id)).toMatchObject({ status: 'ready', confirmedBy: 'build' });
    expect(done.summary).toMatch(/18 folders and 559 assets/);
  });

  it('costs one request per folder, plus one for every further 100 items (22 on the test world)', async () => {
    rig = await assetRig();
    P().model.testWorld();
    await buildAssets(rig, 'alpha');
    // 1 root + 17 folders = 18 first pages... plus the root's own: 19 lists, +2 (Recovery has 262 items) +1 (150 images).
    expect(P().model.listCalls).toHaveLength(22);
    expect(seenAt(rig, 'alpha', 'GET', /^\/assets$/)).toBe(22);
    expect(store().lastPass(P().id, 'build')!.requests).toBe(22);
    // Page sizes are the API's maximum, and every page after the first carries the cursor.
    expect(new Set(P().model.listCalls.map((c) => c.limit))).toEqual(new Set([100]));
    const recovery = P().model.at('Recovery originals 2026-11');
    expect(
      P()
        .model.listCalls.filter((c) => c.folderId === recovery)
        .map((c) => c.cursor !== null),
    ).toEqual([false, true, true]);
    // Nothing but listings: the build never reads a single asset or writes.
    expect(seenAt(rig, 'alpha', 'GET', /^\/assets\/[^/]+$/)).toBe(0);
    expect(P().model.mutations).toEqual([]);
  });

  it('records the finished build as a job, and the walk is breadth first', async () => {
    rig = await assetRig();
    P().model.testWorld();
    await buildAssets(rig, 'alpha');
    const pass = store().lastPass(P().id, 'build')!;
    expect(pass.jobId).toBeTruthy();
    expect(rig.i.engine.queries.getJob(P().id, pass.jobId!)).toMatchObject({ title: 'Asset tree: build' });
    // The root, then the top-level folders, then their children.
    const order = P()
      .model.listCalls.filter((c) => c.cursor === null)
      .map((c) => c.folderId);
    expect(order[0]).toBeNull();
    const topLevel = new Set([
      P().model.at('Characters'),
      P().model.at('Maps to get started'),
      P().model.at('Recovery originals 2026-11'),
    ]);
    expect(new Set(order.slice(1, 4))).toEqual(topLevel);
  });

  it('can be cancelled; what was stored stays and the tree is not built', async () => {
    rig = await assetRig();
    P().model.testWorld();
    rig.i.assets.prepareBuild(P().id, { trigger: 'test' });
    await rig.drive(() => active()?.status === 'awaiting_confirmation');
    rig.i.assets.cancelBuild(P().id);
    expect(active()).toBeUndefined();
    expect(rig.i.assets.meta(P().id).status).toBe('not_built');
    expect(store().counts(P().id).folders).toBe(3); // the root level
    expect(() => rig.i.assets.confirmBuild(P().id)).toThrow(/No build is waiting/);
    expect(() => rig.i.assets.cancelBuild(P().id)).toThrow(/No build is running/);
  });

  it('a rebuild bases its estimate on the previous inventory', async () => {
    rig = await assetRig();
    P().model.testWorld();
    await buildAssets(rig, 'alpha');
    rig.i.assets.prepareBuild(P().id, { trigger: 'test' });
    await rig.drive(() => active()?.status === 'awaiting_confirmation');
    const e = active()!.estimate!;
    expect(e).toMatchObject({
      basis: 'the previous inventory',
      previousFolders: 18,
      previousAssets: 559,
      rootFolders: 3,
    });
    // 18 folders + 6 pages of 100 assets, less the request already made.
    expect(e.likelyRequestsRemaining).toBe(18 + 6 - 1);
    expect(e.likelyRequestsRemaining).toBeGreaterThan(e.minRequestsRemaining);
  });

  it('only one pass runs at a time, and the maintenance passes wait for the first build', async () => {
    rig = await assetRig();
    P().model.testWorld();
    rig.i.assets.prepareBuild(P().id, { trigger: 'test' });
    expect(rig.i.assets.prepareBuild(P().id).id).toBe(active()!.id); // the running build is returned
    await expect(rig.settle(rig.i.assets.refresh(P().id, 'manual'))).resolves.toMatchObject({
      skipped: true,
      summary: expect.stringMatching(/being built|not built/),
    });
    await expect(rig.settle(rig.i.assets.check(P().id, 'manual'))).resolves.toMatchObject({ skipped: true });
    expect(P().model.listCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('a restart in the middle of a build', () => {
  it('continues where it stopped: finished folders are not listed again, and the stored cursor is used', async () => {
    rig = await assetRig();
    P().model.testWorld();
    const recovery = P().model.at('Recovery originals 2026-11');
    // The process dies while the second page of the biggest folder is being read.
    const second = (w: { method: string; url: string }) =>
      w.method === 'GET' && w.url.includes(`folderId=${recovery}`) && w.url.includes('cursor=');
    const release = rig.holdRequest(second);
    rig.i.assets.prepareBuild(P().id, { trigger: 'test', autoConfirm: true });
    await rig.drive(() => rig.i.sent.some(second));
    rig.crash();
    release(); // the dead process never sends it; the new one may
    const before = P().model.listCalls.length;

    rig.start();
    await rig.drive(() => active() === undefined);
    await rig.settle(rig.i.assets.whenIdle());

    expect(store().lastPass(P().id, 'build')).toMatchObject({ status: 'succeeded' });
    expectAssetsMatchModel(rig, 'alpha');
    const after = P()
      .model.listCalls.slice(before)
      .filter((c) => c !== undefined);
    // The root, Characters and Maps were finished before the crash; they are not listed again.
    expect(after.some((c) => c.folderId === null)).toBe(false);
    expect(after.some((c) => c.folderId === P().model.at('Characters'))).toBe(false);
    // Recovery continues from its cursor: its first page (no cursor) is not read again.
    expect(after.filter((c) => c.folderId === recovery).every((c) => c.cursor !== null)).toBe(true);
    // Every folder was listed exactly once overall (the interrupted page counts once: it never completed).
    const firstPages = P().model.listCalls.filter((c) => c.cursor === null);
    expect(new Set(firstPages.map((c) => c.folderId)).size).toBe(firstPages.length);
  });

  it('a build waiting for the owner survives a restart and still waits', async () => {
    rig = await assetRig();
    P().model.testWorld();
    rig.i.assets.prepareBuild(P().id, { trigger: 'test' });
    await rig.drive(() => active()?.status === 'awaiting_confirmation');
    rig.crash();
    rig.start();
    await rig.clock.advance(60_000);
    expect(active()).toMatchObject({ status: 'awaiting_confirmation' });
    expect(P().model.listCalls).toHaveLength(1);
    rig.i.assets.confirmBuild(P().id);
    await rig.drive(() => active() === undefined);
    expect(store().lastPass(P().id, 'build')).toMatchObject({ status: 'succeeded' });
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('a cursor that no longer works restarts that folder from its first page', async () => {
    rig = await assetRig();
    P().model.testWorld();
    P().model.rejectNextCursor = true;
    await buildAssets(rig, 'alpha');
    expectAssetsMatchModel(rig, 'alpha');
    const recovery = P().model.at('Recovery originals 2026-11');
    // Page 1, page 2 (refused), page 1 again, 2, 3.
    expect(P().model.listCalls.filter((c) => c.folderId === recovery)).toHaveLength(5);
  });
});

describe('pacing, failures and budgets', () => {
  it('pauses after each listing request', async () => {
    rig = await assetRig({ assets: { paceMs: 2000 } });
    P().model.testWorld();
    const t0 = rig.clock.now();
    await buildAssets(rig, 'alpha');
    // 22 requests, a pause after each.
    expect(rig.clock.now() - t0).toBeGreaterThanOrEqual(22 * 2000);
  });

  it('a folder that cannot be listed is marked stale and the rest of the build goes on', async () => {
    rig = await assetRig();
    P().model.testWorld();
    const dwarves = P().model.at('Characters', 'Dwarves');
    P().model.listFailures.set(dwarves, { status: 503, code: 'UNAVAILABLE', times: 4 });
    await buildAssets(rig, 'alpha');
    const meta = rig.i.assets.meta(P().id);
    expect(meta.status).toBe('stale');
    expect(meta.reason).toMatch(/could not be confirmed/);
    expect(store().lastPass(P().id, 'build')).toMatchObject({ foldersFailed: 1 });
    expect(store().folder(P().id, dwarves)).toMatchObject({ stale: 1 });
    expect(store().children(P().id, dwarves).items).toHaveLength(0); // never listed
    expect(store().listLog(P().id, { limit: 5 })[0]).toMatchObject({
      change: 'reread_failed',
      itemId: dwarves,
    });
    // The next refresh lists it and settles everything.
    await rig.settle(rig.i.assets.refresh(P().id, 'manual'));
    expect(rig.i.assets.meta(P().id).status).toBe('ready');
    expectAssetsMatchModel(rig, 'alpha');
  });

  it('an unauthorised key fails the build instead of marking every folder stale', async () => {
    rig = await assetRig();
    P().model.testWorld();
    P().model.listFailures.set(null, { status: 403, code: 'FORBIDDEN', times: 1 });
    rig.i.assets.prepareBuild(P().id, { trigger: 'test', autoConfirm: true });
    await rig.drive(() => active() === undefined);
    expect(store().lastPass(P().id, 'build')).toMatchObject({ status: 'failed' });
    expect(rig.i.assets.meta(P().id).status).toBe('not_built');
  });
});
