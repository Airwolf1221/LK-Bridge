/**
 * v2 E1a (ADR 0042): the full snapshot against the mock world: every page under the AI REPOSITORY and the asset library,
 * stored once by hash; resumable after an interruption at any page; giving way to agents' work; and its measured cost.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const pagesUnderRoot = (world: SnapshotsWorld) => world.repo.subtree('airepo01').length;

describe('the full snapshot', () => {
  it('takes every page (the root and the lifecycle indexes included) and the library, and writes one manifest', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    expect(r.changed, r.summary).toBe(true);
    const m = (await snaps.manifest(r.snapshotId!))!;
    expect(m.kind).toBe('full');
    expect(m.complete).toBe(true);
    expect(m.pages.length).toBe(pagesUnderRoot(w));
    const ids = new Set(m.pages.map((p) => p.id));
    for (const id of ['airepo01', 'working1', 'archive1', S.atlas]) expect(ids.has(id)).toBe(true);
    const atlas = m.pages.find((p) => p.id === S.atlas)!;
    expect(atlas.documents!.map((d) => d.type).sort()).toEqual(['blank', 'board', 'map', 'page', 'time']);
    // The image block's image and the map's image.
    expect(atlas.images!.map((i) => i.url)).toEqual([w.url(S.imgMap), w.url(S.imgSea)].sort());
    for (const i of atlas.images!) expect(i.sha256).toBe(w.sha(i.url.split('/a/')[1]!.replace('.webp', '')));
    expect(m.library!.images.map((i) => i.assetId).sort()).toEqual([S.imgCrest, S.imgMap, S.imgSea].sort());
    for (const i of m.library!.images) expect(i.sha256).toBe(w.sha(i.assetId));
    // Every piece is in the store, whole.
    for (const p of m.pages) {
      for (const sha of [p.resource?.sha256, p.sidebar?.sha256, ...(p.documents ?? []).map((d) => d.sha256)])
        if (sha) expect(await snaps.store.check(sha)).toBe('ok');
    }
    expect(snaps.index.snapshot(m.id)).toMatchObject({
      kind: 'full',
      state: 'complete',
      pages: m.pages.length,
    });
  });

  it('a second full snapshot of an unchanged world takes no extra space (every piece is already stored)', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    const first = await snaps.full(PROJECT, 'manual');
    const usage1 = await snaps.store.usage();
    const getsAfterFirst = w.gets.length;
    const second = await snaps.full(PROJECT, 'manual');
    const usage2 = await snaps.store.usage();
    expect(usage2.objects).toBe(usage1.objects);
    expect(usage2.objectBytes).toBe(usage1.objectBytes);
    expect(snaps.index.snapshot(second.snapshotId!)!.newObjects).toBe(0);
    // The images are not downloaded again: their hashes are known and their bytes stored.
    expect(w.gets.length).toBe(getsAfterFirst);
    expect(first.snapshotId).not.toBe(second.snapshotId);
  });

  it('resumes after an interruption at any page, never restarting, and the manifest is written only at the end', async () => {
    w = await snapshotsWorld();
    const total = pagesUnderRoot(w);
    for (const stopAt of [1, Math.floor(total / 2), total]) {
      let n = 0;
      const snaps = w.stack.runtime.snapshots;
      (snaps.o as { afterPage?: unknown }).afterPage = () => {
        n++;
        if (n === stopAt) throw new Error('interrupted');
      };
      await expect(snaps.full(PROJECT, 'manual')).rejects.toThrow('interrupted');
      const run = snaps.index.runningRun(PROJECT, 'full')!;
      expect(run.done).toBe(stopAt);
      const before = snaps.index.snapshots(PROJECT, { kind: 'full' }).length;
      (snaps.o as { afterPage?: unknown }).afterPage = undefined;
      const reads0 = run.reads;
      const r = await snaps.full(PROJECT, 'resume');
      expect(r.summary).toMatch(/Resumed and finished/);
      expect(snaps.index.snapshots(PROJECT, { kind: 'full' }).length).toBe(before + 1);
      const m = (await snaps.manifest(r.snapshotId!))!;
      expect(m.pages.length).toBe(total);
      // The pages done before the interruption were not read again.
      const done = snaps.index.run(run.id)!;
      expect(done.reads - reads0).toBeLessThan(total * 3);
    }
  });

  it('gives way while agents’ work is queued (P1 or P2), and reads at P3', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    let busy = 3;
    const waits: number[] = [];
    (snaps.o as { busy?: unknown }).busy = () => busy-- > 0;
    (snaps.o as { sleep?: unknown }).sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    await snaps.full(PROJECT, 'manual');
    expect(waits.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses with a dashboard notice when the disk would be left under the minimum free space', async () => {
    w = await snapshotsWorld({ snapshots: { minFreeBytes: 1e18 } });
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    expect(r.skipped).toBe(true);
    expect(r.summary).toMatch(/Refused: .* under the minimum/);
    expect(snaps.index.notices(PROJECT)[0]).toMatchObject({ code: 'SNAPSHOT_DISK', level: 'error' });
    expect(snaps.index.runs(PROJECT)[0]).toMatchObject({ state: 'refused' });
    expect(snaps.index.snapshots(PROJECT).filter((s) => s.kind === 'full')).toHaveLength(0);
  });

  it('measures its cost: reads per page, and the library walk', async () => {
    w = await snapshotsWorld();
    const snaps = w.stack.runtime.snapshots;
    const r = await snaps.full(PROJECT, 'manual');
    const m = (await snaps.manifest(r.snapshotId!))!;
    const docs = m.pages.reduce((n, p) => n + (p.documents?.length ?? 0), 0);
    // One getResource per page; a page document 1, a map 2, a timeline 3 (one page of events), a board 1, a blank 0;
    // the library: one listing per folder level (the root and its two folders).
    const byType = m.pages
      .flatMap((p) => p.documents ?? [])
      .reduce<Record<string, number>>((acc, d) => ((acc[d.type] = (acc[d.type] ?? 0) + 1), acc), {});
    // v2 E2 (ADR 0044): the project's templates are taken too: one listing, then each template as a page.
    const tdocs = (m.templates ?? []).flatMap((t) => t.documents ?? []);
    const tByType = tdocs.reduce<Record<string, number>>(
      (a, d) => ((a[d.type] = (a[d.type] ?? 0) + 1), a),
      {},
    );
    const templateReads =
      1 +
      (m.templates ?? []).length +
      (tByType.page ?? 0) +
      2 * (tByType.map ?? 0) +
      3 * (tByType.time ?? 0) +
      (tByType.board ?? 0);
    expect(m.templates!.length).toBeGreaterThan(0);
    const expected =
      m.pages.length +
      (byType.page ?? 0) +
      2 * (byType.map ?? 0) +
      3 * (byType.time ?? 0) +
      (byType.board ?? 0) +
      3 +
      templateReads;
    expect(m.counts.reads).toBe(expected);
    expect(m.counts.downloads).toBe(3);
    process.stdout.write(
      `full snapshot (mock): ${m.pages.length} pages, ${docs} documents, ${m.counts.reads} reads (${(m.counts.reads / m.pages.length).toFixed(2)} per page), ${m.counts.downloads} downloads, ${m.counts.newObjects} objects, ${m.counts.newBytes} bytes stored, ${m.counts.logicalBytes} bytes of pieces\n`,
    );
  });
});
