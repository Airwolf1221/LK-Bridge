/**
 * v2 E1a follow-up (ADR 0042 decision 4): a nightly full snapshot must not download the whole library again. A library
 * asset whose id and URL are as a stored snapshot had them is recorded from that snapshot's hash, without a download;
 * only a new asset, or one replaced (LegendKeeper gives a replaced image a new URL), is downloaded.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const webp = (r: number, g: number, b: number) =>
  sharp({ create: { width: 8, height: 4, channels: 3, background: { r, g, b } } })
    .webp()
    .toBuffer();

describe('a second full snapshot does not download the library again', () => {
  it('nothing changed: zero downloads, the same image hashes, little new data', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    const first = await snaps.full(PROJECT, 'manual');
    expect(first.changed).toBe(true);
    const library = [...w.assets.assets.values()].filter(
      (a) => (a as { type?: string }).type !== 'FOLDER',
    ).length;
    expect(library).toBe(3);
    expect(w.gets.length).toBe(library); // the first run downloads every image once
    w.gets.length = 0;
    const second = await snaps.full(PROJECT, 'manual');
    expect(second.changed).toBe(true);
    expect(w.gets).toEqual([]); // zero downloads
    const run = snaps.index.run(second.runId!)!;
    expect(run.downloads).toBe(0);
    expect(run.newObjects).toBe(0); // nothing changed, so nothing new is stored (not even a new object for a page)
    const a = (await snaps.manifest(first.snapshotId!))!;
    const b = (await snaps.manifest(second.snapshotId!))!;
    expect(b.library?.images.map((i) => [i.assetId, i.url, i.sha256])).toEqual(
      a.library?.images.map((i) => [i.assetId, i.url, i.sha256]),
    );
    expect(b.library?.images.every((i) => i.sha256)).toBe(true);
    process.stdout.write(
      `second full snapshot (mock, nothing changed): ${run.reads} reads, ${run.downloads} downloads, ${run.newObjects} new objects, ${run.newBytes} new bytes (first: ${snaps.index.run(first.runId!)!.downloads} downloads)\n`,
    );
  });

  it('a new asset is downloaded; a replaced asset (new URL, same id) is downloaded; the rest are not', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    await snaps.full(PROJECT, 'manual');
    // A new image in the library.
    const fresh = w.addImage('Fresh', S.folderA, await webp(1, 2, 3), 'imgnew01');
    // A replaced image: LegendKeeper keeps the id and gives the new content a new URL.
    const replacedBytes = await webp(200, 200, 10);
    w.served.set(`${S.imgCrest}-v2`, replacedBytes);
    (w.assets.assets.get(S.imgCrest) as unknown as Record<string, unknown>).url =
      `${w.url(`${S.imgCrest}-v2`)}`;
    w.gets.length = 0;
    const r = await snaps.full(PROJECT, 'manual');
    expect(r.changed).toBe(true);
    expect(w.gets.sort()).toEqual([`/a/${fresh}.webp`, `/a/${S.imgCrest}-v2.webp`].sort());
    const m = (await snaps.manifest(r.snapshotId!))!;
    const by = new Map(m.library!.images.map((i) => [i.assetId, i]));
    expect(by.get(S.imgCrest)!.sha256).toBe(createHash('sha256').update(replacedBytes).digest('hex'));
    expect(by.get(fresh)!.sha256).toBeTruthy();
    expect(by.get(S.imgSea)!.sha256).toBe(w.sha(S.imgSea));
  });

  it('an asset whose stored bytes are known to be damaged is downloaded again (verify’s finding repairs it)', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    await snaps.full(PROJECT, 'manual');
    const sha = w.sha(S.imgSea);
    snaps.index.addFinding?.({ sha256: sha, problem: 'corrupt', detail: 'test', snapshots: [] });
    w.gets.length = 0;
    await snaps.full(PROJECT, 'manual');
    expect(w.gets).toEqual([`/a/${S.imgSea}.webp`]);
  });
});
