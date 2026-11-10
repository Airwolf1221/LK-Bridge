/**
 * v2 A2: two projects' trees are fully isolated. Both worlds use the SAME resource ids (a copied project would not, but
 * that makes any leak visible): each tree holds only its own project's data, a write in one re-reads only in that one,
 * a pass of one never touches the other, and settings, statuses, logs and owed re-reads are per project.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { build, expectTreeMatchesModel, origin, seenAt, treeRig, type TreeRig } from './helpers.js';
import { seedWorld } from './model.js';

let rig: TreeRig;
afterEach(async () => rig?.close());

describe('two projects', () => {
  it('are fully isolated: data, writes, passes, settings, status and logs', async () => {
    rig = await treeRig({ projects: ['alpha', 'beta'] });
    const a = rig.p.alpha!;
    const b = rig.p.beta!;
    const wa = seedWorld(a.model, { nodes: 70, depth: 4 });
    const wb = seedWorld(b.model, { nodes: 90, depth: 6 });
    expect(wa.rootId).toBe(wb.rootId); // the same ids in both projects
    for (const id of wb.ids)
      b.model.outside.rename(id, b.model.res.get(id)!.name.replace(/(\d+)$/, 'beta $1'));

    // Only alpha is configured: beta's tree does nothing.
    rig.setRoot('alpha', wa.rootId);
    await build(rig, 'alpha');
    expect(rig.i.tree.meta(b.id).status).toBe('not_configured');
    expect(seenAt(rig, 'beta', 'GET', /^\/resources/)).toBe(0);

    rig.setRoot('beta', wb.rootId);
    await build(rig, 'beta');
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    expectTreeMatchesModel(rig, 'beta', { withProps: true });
    expect(rig.i.tree.queries.counts(a.id).data.total).toBe(71);
    expect(rig.i.tree.queries.counts(b.id).data.total).toBe(91);
    const shared = wa.ids[10]!;
    expect(rig.i.tree.queries.node(a.id, shared).data!.rawName).not.toBe(
      rig.i.tree.queries.node(b.id, shared).data!.rawName,
    );
    expect(rig.i.tree.queries.findByDisplayName(a.id, 'Source beta 30').data).toEqual([]);

    // A write in alpha re-reads in alpha only, and changes alpha's tree only.
    const betaGets = seenAt(rig, 'beta', 'GET', /^\/resources\/[^/]+$/);
    await rig.settle(
      rig.i.engine.run(
        'updateResource',
        { path: { resourceId: shared }, body: { name: '[BSRC] Alpha only' } },
        {
          project: a.id,
          origin,
        },
      ),
    );
    expect(rig.i.tree.queries.node(a.id, shared).data!.rawName).toBe('[BSRC] Alpha only');
    expect(rig.i.tree.queries.node(b.id, shared).data!.rawName).not.toBe('[BSRC] Alpha only');
    expect(seenAt(rig, 'beta', 'GET', /^\/resources\/[^/]+$/)).toBe(betaGets);

    // An outside change in beta: alpha's sweep does not see it, beta's does; each logs in its own project.
    b.model.outside.rename(shared, '[BSRC] Beta renamed');
    const betaLists = seenAt(rig, 'beta', 'GET', /^\/resources$/);
    await rig.settle(rig.i.tree.sweep(a.id));
    expect(seenAt(rig, 'beta', 'GET', /^\/resources$/)).toBe(betaLists);
    expect(rig.i.tree.queries.node(b.id, shared).data!.rawName).not.toBe('[BSRC] Beta renamed');
    await rig.settle(rig.i.tree.sweep(b.id));
    expect(rig.i.tree.queries.node(b.id, shared).data!.rawName).toBe('[BSRC] Beta renamed');
    expect(rig.i.tree.store.listLog(a.id, { limit: 50 })).toEqual([]);
    expect(rig.i.tree.store.listLog(b.id, { limit: 50 }).map((e) => e.nodeId)).toEqual([shared]);

    // Settings are per project: switching beta's sweep off leaves alpha's on.
    rig.setSetting('beta', 'treeSweepEnabled', false);
    expect(await rig.i.tree.sweep(b.id)).toMatchObject({ skipped: true });
    expect(await rig.settle(rig.i.tree.sweep(a.id))).toMatchObject({ changed: false });

    // A failed re-read makes only that project's tree stale.
    let n = 0;
    a.mock.inject(
      (c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${shared}`) && ++n > 1,
      { kind: 'status', status: 500, code: 'INTERNAL' },
      1,
    );
    await rig.settle(
      rig.i.engine.run(
        'updateResource',
        { path: { resourceId: shared }, body: { tags: ['x'] } },
        { project: a.id, origin },
      ),
    );
    expect(rig.i.tree.meta(a.id).status).toBe('stale');
    expect(rig.i.tree.meta(b.id).status).toBe('ready');
    expect(rig.i.tree.store.pending(b.id)).toEqual([]);

    // Every stored row is its own project's.
    const rows = (t: string) =>
      rig.i.db
        .prepare(`SELECT project_id, COUNT(*) AS n FROM ${t} GROUP BY project_id ORDER BY project_id`)
        .all();
    expect(rows('tree_nodes')).toEqual([
      { project_id: a.id, n: 71 },
      { project_id: b.id, n: 91 },
    ]);
    expect(rows('tree_names').map((r) => (r as { project_id: string }).project_id)).toEqual([a.id, b.id]);

    // Changing alpha's root discards alpha's tree only.
    rig.setRoot('alpha', wa.ids[0]!);
    expect(rig.i.tree.meta(a.id).status).toBe('not_built');
    expect(rig.i.tree.queries.counts(b.id).data.total).toBe(91);
  }, 60_000);
});
