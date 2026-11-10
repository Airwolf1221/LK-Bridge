/**
 * v2 A2: regression tests for the independent review of the repository tree. Each case is a way the tree could have
 * ended up wrong, stuck or busy: a listing that skips a page's new parent, a restart between confirming a build and
 * its reconciliation, the root reading as 404 after a write, a pass on a project that stops being served, and failed
 * re-reads of a project that is not served (no busy loop).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { build, expectTreeMatchesModel, origin, treeRig, type TreeRig } from './helpers.js';
import { seedWorld } from './model.js';

let rig: TreeRig;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const node = (id: string) => rig.i.tree.queries.node(P().id, id).data;

async function world(nodes = 40) {
  rig = await treeRig();
  const w = seedWorld(P().model, { nodes, depth: 4 });
  rig.setRoot('alpha', w.rootId);
  await build(rig, 'alpha');
  return w;
}

describe('review regressions', () => {
  it('a page moved under a new folder the listing skipped is kept, and its new place found', async () => {
    const { rootId } = await world();
    const m = P().model;
    const ix = m.children(rootId).find((r) => r.name.startsWith('[INDEX]'))!;
    const moved = m.children(ix.id).find((r) => m.children(r.id).length > 0) ?? m.children(ix.id)[0]!;
    const below = rig.i.tree.store.subtreeIds(P().id, moved.id);
    const folder = m.outside.create('[INDEX] New folder', rootId);
    m.outside.move(moved.id, folder.id);
    m.hiddenFromListing.add(folder.id); // the listing skips the new folder
    await rig.settle(rig.i.tree.sweep(P().id));
    // Not removed as "moved outside the root": read, its parent chain followed, and placed.
    expect(node(folder.id)).toMatchObject({ parentId: rootId });
    expect(node(moved.id)).toMatchObject({ parentId: folder.id, stale: false });
    for (const id of below) expect(node(id)).not.toBeNull();
    const pass = rig.i.tree.store.lastPass(P().id, 'sweep')!;
    expect(
      rig.i.tree.store.listLog(P().id, { limit: 50, passId: pass.id }).filter((e) => e.change === 'removed'),
    ).toEqual([]);
    m.hiddenFromListing.clear();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('a restart after the build was confirmed but before its listing was applied still applies it', async () => {
    rig = await treeRig();
    const { rootId } = seedWorld(P().model, { nodes: 60, depth: 4 });
    rig.setRoot('alpha', rootId);
    rig.i.tree.prepareBuild(P().id, { trigger: 'test' });
    await rig.drive(() => rig.i.tree.store.activePass(P().id)?.status === 'awaiting_confirmation');
    // What confirmBuild records before the reconciliation runs; then the process dies.
    const pass = rig.i.tree.store.activePass(P().id)!;
    rig.i.tree.store.updatePass(pass.id, { status: 'reading' });
    rig.crash();
    rig.start();
    await rig.drive(() => rig.i.tree.store.activePass(P().id) === undefined);
    expect(rig.i.tree.store.lastPass(P().id, 'build')).toMatchObject({ status: 'succeeded', readOk: 61 });
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('the root reading as 404 after a write never wipes the tree', async () => {
    const { rootId } = await world();
    let n = 0;
    P().mock.inject(
      (c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${rootId}`) && ++n > 1,
      { kind: 'status', status: 404, code: 'NOT_FOUND' },
      1,
    );
    await rig.settle(
      rig.i.engine.run(
        'updateResource',
        { path: { resourceId: rootId }, body: { tags: ['x'] } },
        { project: P().id, origin },
      ),
    );
    expect(rig.i.tree.queries.counts(P().id).data.total).toBe(41);
    expect(rig.i.tree.meta(P().id)).toMatchObject({ status: 'stale', staleNodes: 1 });
  });

  it('a sweep of a project that stops being served ends instead of waiting for ever', async () => {
    const { rootId } = await world();
    const added = P().model.outside.create('[BSRC] Made in the app', rootId); // the sweep has to read it
    const held = rig.holdResponse((w) => w.method === 'GET' && /\/resources\/?\?/.test(w.url));
    const sweep = rig.i.tree.sweep(P().id);
    await rig.drive(() => held.arrived());
    rig.i.projects.setUnavailable(P().id, 'the key is being checked again');
    held.release();
    await rig.settle(sweep);
    expect(rig.i.tree.store.activePass(P().id)).toBeUndefined();
    expect(rig.i.tree.store.lastPass(P().id, 'sweep')).toMatchObject({ status: 'succeeded', readFailed: 1 });
    expect(node(added.id)).toMatchObject({
      stale: true,
      staleReason: expect.stringMatching(/PROJECT_UNAVAILABLE/) as string,
    });
  });

  it('owed re-reads of a project that is not served wait quietly (no busy loop), and run once it is back', async () => {
    const { ids } = await world();
    let n = 0;
    P().mock.inject(
      (c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${ids[3]!}`) && ++n > 1,
      { kind: 'status', status: 500, code: 'INTERNAL' },
      1,
    );
    await rig.settle(
      rig.i.engine.run(
        'updateResource',
        { path: { resourceId: ids[3]! }, body: { tags: ['y'] } },
        { project: P().id, origin },
      ),
    );
    expect(rig.i.tree.meta(P().id).status).toBe('stale');
    rig.i.projects.setUnavailable(P().id, 'stopped for the test');
    const before = rig.i.sent.length;
    await rig.clock.advance(10 * 60_000);
    // Nothing armed for a project that is not served, so nothing spins and nothing is sent.
    expect(rig.clock.nextTimerAt() === undefined || rig.clock.nextTimerAt()! > rig.clock.now()).toBe(true);
    expect(rig.i.sent.length).toBe(before);
    rig.i.projects.setUnavailable(P().id, null);
    await rig.drive(() => rig.i.tree.meta(P().id).status === 'ready');
    expect(node(ids[3]!)).toMatchObject({ tags: ['y'], stale: false });
  });
});
