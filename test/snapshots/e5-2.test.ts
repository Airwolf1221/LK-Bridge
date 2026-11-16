/**
 * v2 E5.2 (ADR 0041, ADR 0042, ADR 0046 decision 11), Arkona's first full snapshot and first rehearsal:
 *
 * - the map's image is served from `assets2` (a 302 from `assets`): the snapshot follows it and comes out complete,
 *   recording the URL the page holds.
 *
 * E5.2's label-size mapping (`small` → `sm`) was replaced in E5.4 (writing any label size makes the map unreadable
 * through the API): see e5-4.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

type Obj = Record<string, unknown>;

describe('a map image LegendKeeper serves from assets2 (E5.2)', () => {
  it('the full snapshot follows the 302 and comes out complete; the page’s URL is what it records', async () => {
    w = await snapshotsWorld();
    w.movedToAssets2.add(S.imgMap);
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.complete, JSON.stringify(snaps.index.snapshot(m.id))).toBe(true);
    expect(snaps.index.snapshot(m.id)).toMatchObject({ state: 'complete' });
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    const img = atlas.images!.find((i) => i.url === w!.url(S.imgMap))!;
    // The reference is the URL the page holds (on `assets`), never rewritten; the bytes are the final ones.
    expect(img.url).toMatch(/^https:\/\/assets\.test:/);
    expect(img.sha256).toBe(w.sha(S.imgMap));
    expect(m.library!.images.find((i) => i.assetId === S.imgMap)!.sha256).toBe(w.sha(S.imgMap));
    const hops = w.assetRequests.filter((x) => x.path.includes(S.imgMap));
    expect(hops.map((x) => x.host).slice(0, 2)).toEqual(['assets.test', 'assets2.test']);
    for (const x of w.assetRequests) {
      expect(x.headers.authorization).toBeUndefined();
      expect(x.headers.cookie).toBeUndefined();
    }
  });

  it('an image URL already on assets2 is recognised as an asset image by the snapshot', async () => {
    w = await snapshotsWorld();
    const onAssets2 = w.url(S.imgSea).replace('https://assets.test:', 'https://assets2.test:');
    const main = w.repo.blocks.get(w.d.main)!;
    (main.blocks as Obj[]).find((b) => b.id === 'aimg')!.url = onAssets2;
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.complete).toBe(true);
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    expect(atlas.images!.find((i) => i.url === onAssets2)?.sha256).toBe(w.sha(S.imgSea));
  });
});
