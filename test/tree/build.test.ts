/**
 * v2 A2: the first build of the repository tree, on a realistic world (thousands of nodes, nine levels deep, resources
 * outside the root that must be left out): the estimate shown first, the result compared with the model, resuming
 * after a crash in the listing and in the reading, budget priority (the build never runs below the P3 floor and never
 * starves P1 work), and the tree's status transitions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { expectTreeMatchesModel, origin, seenAt, treeRig, type TreeRig } from './helpers.js';
import { seedWorld } from './model.js';

let rig: TreeRig;
afterEach(async () => rig?.close());

const isList = (w: { method: string; url: string }) => w.method === 'GET' && /\/resources\/?\?/.test(w.url);
const isGet = (w: { method: string; url: string }) =>
  w.method === 'GET' && /\/resources\/[^/?]+$/.test(w.url);

describe('first build on a realistic world', () => {
  it('shows the estimate first, then reads every node under the root and nothing outside it', async () => {
    rig = await treeRig();
    const a = rig.p.alpha!;
    const { rootId } = seedWorld(a.model, { nodes: 1999, depth: 9, outside: 14, unclassified: 3 });
    rig.setRoot('alpha', rootId);
    const total = a.model.res.size; // 2,000 under the root (root included) + 14 templates + 5 template children
    expect(total).toBe(2000 + 14 + 5);

    const tree = rig.i.tree;
    tree.prepareBuild(a.id, { trigger: 'test' });
    expect(tree.meta(a.id).status).toBe('building');
    await rig.drive(() => tree.store.activePass(a.id)?.status === 'awaiting_confirmation');
    const waiting = tree.store.activePass(a.id)!;
    // The estimate: one getResource per node under the root, after a listing of ceil(total / 100) pages.
    expect(waiting.estimate).toMatchObject({
      listed: total,
      subtree: 2000,
      reads: 2000,
      listingRequests: 21,
    });
    expect(waiting.estimate!.wallClockMs).toBeGreaterThan(0);
    expect(waiting.estimate!.fitsInDailyBudget).toBe(true);
    // Nothing is read before the owner confirms.
    expect(seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/)).toBe(0);
    expect(tree.meta(a.id)).toMatchObject({ status: 'not_built' });
    expect(tree.meta(a.id).reason).toMatch(/confirm/);

    tree.confirmBuild(a.id);
    await rig.drive(() => tree.store.activePass(a.id) === undefined);
    const done = tree.store.lastPass(a.id, 'build')!;
    expect(done.status).toBe('succeeded');
    expect(done).toMatchObject({ subtree: 2000, readOk: 2000, readFailed: 0, pages: 21 });
    // Exactly one getResource per node under the root; none for the templates outside it.
    expect(seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/)).toBe(2000);
    for (const r of a.model.res.values()) {
      if (r.name.includes('Template')) expect(tree.queries.node(a.id, r.id).data).toBeNull();
    }
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    const meta = tree.meta(a.id);
    expect(meta.status).toBe('ready');
    expect(meta.confirmedAt).toBe(done.snapshotAt);
    const counts = tree.queries.counts(a.id).data;
    expect(counts.total).toBe(2000);
    expect(counts.byKind.root).toBe(1);
    expect(counts.byKind.unclassified).toBe(3);
    expect(counts.byKind.index + counts.byKind.bsrc + 3 + 1).toBe(2000);
    expect(counts.maxDepth).toBe(9);
    expect(counts.propertiesPending).toBe(0);
    // A finished build is recorded as a job of its project.
    expect(rig.i.engine.queries.getJob(a.id, done.jobId!)).toMatchObject({ status: 'succeeded' });
  }, 120_000);

  it('resumes after a crash in the reading: no node is read twice except the ones in flight', async () => {
    rig = await treeRig();
    const a = rig.p.alpha!;
    const { rootId } = seedWorld(a.model, { nodes: 1199, depth: 9, outside: 14 });
    rig.setRoot('alpha', rootId);
    rig.i.tree.prepareBuild(a.id, { trigger: 'test', autoConfirm: true });
    await rig.drive(() => (rig.i.tree.store.activePass(a.id)?.readOk ?? 0) >= 500);
    const before = rig.i.tree.store.activePass(a.id)!;
    expect(before.status).toBe('reading');
    rig.crash();

    // A new process on the same database continues where the old one stopped.
    rig.start();
    const tree = rig.i.tree;
    await rig.drive(() => tree.store.activePass(a.id) === undefined);
    expect(tree.store.lastPass(a.id, 'build')!.status).toBe('succeeded');
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    // The listing was not repeated, and only the reads in flight at the crash (at most 4) were made twice.
    const gets = seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/);
    expect(gets).toBeGreaterThanOrEqual(1200);
    expect(gets).toBeLessThanOrEqual(1200 + 4);
    expect(seenAt(rig, 'alpha', 'GET', /^\/resources$/)).toBe(Math.ceil(a.model.res.size / 100));
    expect(rig.i.sent.filter(isList)).toHaveLength(0);
    expect(rig.i.sent.filter(isGet).length).toBeLessThanOrEqual(1200 - 500 + 4);
  }, 120_000);

  it('resumes after a crash in the listing, from the stored cursor', async () => {
    rig = await treeRig();
    const a = rig.p.alpha!;
    const { rootId } = seedWorld(a.model, { nodes: 999, depth: 9, outside: 14 });
    rig.setRoot('alpha', rootId);
    rig.i.tree.prepareBuild(a.id, { trigger: 'test', autoConfirm: true });
    await rig.drive(() => (rig.i.tree.store.activePass(a.id)?.pages ?? 0) >= 4);
    rig.crash();
    rig.start();
    const tree = rig.i.tree;
    await rig.drive(() => tree.store.activePass(a.id) === undefined);
    expect(tree.store.lastPass(a.id, 'build')!.status).toBe('succeeded');
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    const pages = Math.ceil(a.model.res.size / 100);
    // At most the page in flight at the crash was listed twice.
    expect(seenAt(rig, 'alpha', 'GET', /^\/resources$/)).toBeLessThanOrEqual(pages + 1);
    expect(seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/)).toBe(1000);
  }, 120_000);
});

describe('budget priority', () => {
  it('never runs below the P3 floor, and P1 work is served at once while it runs', async () => {
    // A tight key-minute tier (40): P3 may use 20 of it (50% floor); P1 work keeps the rest.
    rig = await treeRig({ limits: { 'key-min': 40 } });
    const a = rig.p.alpha!;
    const { rootId, ids } = seedWorld(a.model, { nodes: 159, depth: 5 });
    rig.setRoot('alpha', rootId);
    rig.i.tree.prepareBuild(a.id, { trigger: 'test', autoConfirm: true });
    await rig.drive(() => (rig.i.tree.store.activePass(a.id)?.readOk ?? 0) >= 40);

    // An agent's read in the middle of the build: answered without waiting for the build.
    const t0 = rig.clock.now();
    const r = await rig.settle(
      rig.i.engine.run(
        'getResource',
        { path: { resourceId: ids[3]! } },
        { project: a.id, origin, priority: 'P1' },
      ),
    );
    expect(r.status).toBe('succeeded');
    expect(rig.clock.now() - t0).toBeLessThan(1000);

    await rig.drive(() => rig.i.tree.store.activePass(a.id) === undefined);
    expect(rig.i.tree.store.lastPass(a.id, 'build')!.status).toBe('succeeded');
    // The build's own requests never used more than its floor allows in any minute: 20, plus the one P1 read.
    const times = a.mock.counted.map((c) => c.at).sort((x, y) => x - y);
    let max = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i]! - times[j]! >= 60_000) j++;
      max = Math.max(max, i - j + 1);
    }
    expect(max).toBeLessThanOrEqual(21);
    expect(a.mock.stats.genuine429).toBe(0);
  }, 120_000);
});

describe('status transitions', () => {
  it('not configured → not built → building → not built (waiting) → building → ready → stale → ready', async () => {
    rig = await treeRig();
    const a = rig.p.alpha!;
    const tree = rig.i.tree;
    const { rootId, ids } = seedWorld(a.model, { nodes: 60, depth: 4 });

    expect(tree.meta(a.id).status).toBe('not_configured');
    // An unconfigured tree does nothing: no queries are answered, writes are not followed, passes skip.
    expect(tree.queries.children(a.id, rootId).data).toEqual([]);
    expect(await tree.sweep(a.id)).toMatchObject({ skipped: true });
    await rig.settle(
      rig.i.engine.run(
        'updateResource',
        { path: { resourceId: ids[0]! }, body: { name: 'X' } },
        { project: a.id, origin },
      ),
    );
    // Only the journal's pre-image read (the engine's own); the tree re-read nothing and owes nothing.
    expect(seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/)).toBe(1);
    expect(tree.store.pending()).toEqual([]);
    a.model.outside.rename(ids[0]!, '[INDEX] Spine 1');

    rig.setRoot('alpha', rootId);
    expect(tree.meta(a.id).status).toBe('not_built');
    expect(await tree.check(a.id)).toMatchObject({ skipped: true });

    const held = rig.holdResponse((w) => isList(w));
    tree.prepareBuild(a.id, { trigger: 'test' });
    await rig.drive(() => held.arrived());
    expect(tree.meta(a.id).status).toBe('building');
    held.release();
    await rig.drive(() => tree.store.activePass(a.id)?.status === 'awaiting_confirmation');
    expect(tree.meta(a.id).status).toBe('not_built');
    tree.confirmBuild(a.id);
    expect(tree.meta(a.id).status).toBe('building');
    await rig.drive(() => tree.store.activePass(a.id) === undefined);
    expect(tree.meta(a.id).status).toBe('ready');

    // 26 hours without a completed pass: stale. A sweep confirms it again.
    await rig.clock.advance(27 * 3_600_000);
    expect(tree.meta(a.id)).toMatchObject({ status: 'stale' });
    expect(tree.meta(a.id).reason).toMatch(/26 hours/);
    await rig.settle(tree.sweep(a.id));
    expect(tree.meta(a.id).status).toBe('ready');

    // A re-read after a write that fails leaves the node stale (never silently wrong).
    // The engine's own pre-image read goes through; the tree's re-read after it fails.
    let gets = 0;
    a.mock.inject(
      (c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${ids[5]!}`) && ++gets > 1,
      { kind: 'status', status: 500, code: 'INTERNAL' },
      1,
    );
    await rig.settle(
      rig.i.engine.run(
        'updateResource',
        { path: { resourceId: ids[5]! }, body: { name: '[BSRC] Renamed' } },
        { project: a.id, origin },
      ),
    );
    const meta = tree.meta(a.id);
    expect(meta.status).toBe('stale');
    expect(meta.staleNodes).toBe(1);
    expect(tree.queries.node(a.id, ids[5]!).data).toMatchObject({ stale: true });
    expect(tree.queries.node(a.id, ids[5]!).data!.staleReason).toMatch(/re-read after updateResource failed/);
    const log = tree.store.listLog(a.id, { limit: 10, source: 'write' });
    expect(log[0]).toMatchObject({ change: 'reread_failed', nodeId: ids[5]! });
    // The next sweep reads the stale node and settles it.
    await rig.settle(tree.sweep(a.id));
    expect(tree.meta(a.id).status).toBe('ready');
    expect(tree.queries.node(a.id, ids[5]!).data).toMatchObject({ stale: false, rawName: '[BSRC] Renamed' });
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    // Changing the root discards the tree; clearing it makes the tree "not configured" again.
    rig.setRoot('alpha', ids[0]!);
    expect(tree.meta(a.id).status).toBe('not_built');
    expect(tree.queries.counts(a.id).data.total).toBe(0);
    rig.setRoot('alpha', null);
    expect(tree.meta(a.id).status).toBe('not_configured');
  }, 60_000);
});
