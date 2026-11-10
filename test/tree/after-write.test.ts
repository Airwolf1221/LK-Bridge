/**
 * v2 A2: updates after the bridge's own writes. For every operation that can change what the tree holds, the engine's
 * job re-reads the affected resource(s) with getResource and the tree is updated from LegendKeeper's answer; after
 * each, the whole tree is compared with the model. Page content writes do not touch the tree. A failed re-read leaves
 * the node stale and is retried; a crash between a write and its re-read is caught up at the next start.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpParams, RunOptions } from '../../src/jobs/index.js';
import { TREE_FOLLOWED_OPS } from '../../src/tree/index.js';
import { build, expectTreeMatchesModel, origin, seenAt, treeRig, type TreeRig } from './helpers.js';
import { newId, seedWorld, type Res } from './model.js';

let rig: TreeRig;
let rootId: string;
let ids: string[];
let tpl: Res;
let outsideFolder: Res;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const node = (id: string) => rig.i.tree.queries.node(P().id, id).data;
const gets = () => seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/);
const run = (op: string, params: OpParams, o: Partial<RunOptions> = {}) =>
  rig.settle(rig.i.engine.run(op, params, { project: P().id, origin, ...o }));
/** An index of the seeded world that has children (and a parent that is not the root). */
const indexWithChildren = () =>
  [...P().model.res.values()].find(
    (r) =>
      r.name.startsWith('[INDEX] Group') && P().model.children(r.id).length >= 3 && r.parentId !== rootId,
  )!;
const leaf = () =>
  [...P().model.res.values()].find(
    (r) =>
      r.name.startsWith('[BSRC] Source') && P().model.children(r.id).length === 0 && r.deletedAt === null,
  )!;

beforeEach(async () => {
  rig = await treeRig();
  const m = P().model;
  ({ rootId, ids } = seedWorld(m, { nodes: 80, depth: 5, outside: 2 }));
  // A template outside the root, with two levels of children, and a folder outside the root.
  tpl = m.seed({
    name: '[BSRC] AI Character Core Template',
    parentId: null,
    referenceType: 'Character Core',
  });
  const tc = m.seed({ name: '[INDEX] Template child', parentId: tpl.id });
  m.seed({ name: '[BSRC] Template grandchild', parentId: tc.id });
  outsideFolder = m.seed({ name: 'Archive', parentId: null });
  const kept = m.seed({ name: '[INDEX] Kept outside', parentId: outsideFolder.id });
  m.seed({ name: '[BSRC] Kept child', parentId: kept.id });
  rig.setRoot('alpha', rootId);
  await build(rig, 'alpha');
  expectTreeMatchesModel(rig, 'alpha', { withProps: true });
});

describe('every followed operation', () => {
  it('follows exactly the operations that can change the tree', () => {
    expect([...TREE_FOLLOWED_OPS].sort()).toEqual(
      [
        'createResource',
        'createManyResources',
        'createResourceFromTemplate',
        'updateResource',
        'moveResource',
        'deleteResource',
        'restoreResource',
        'createProperty',
        'updateProperty',
        'deleteProperty',
        'createPropertyRow',
        'updatePropertyRow',
        'deletePropertyRow',
        'createDocument',
        'updateDocument',
        'deleteDocument',
        'restoreDocument',
      ].sort(),
    );
  });

  it('createResource: the new page, with the rank and document LegendKeeper gave it', async () => {
    const parent = indexWithChildren();
    const first = P().model.children(parent.id)[0]!;
    const before = gets();
    const r = await run('createResource', {
      body: { name: '[BSRC] New page', parentId: parent.id, after: first.id, tags: ['new'] },
    });
    const id = (r as { result: { id: string } }).result.id;
    expect(gets() - before).toBe(1); // one re-read, in the same job
    expect(node(id)).toMatchObject({
      kind: 'bsrc',
      displayName: 'New page',
      parentId: parent.id,
      tags: ['new'],
    });
    expect(node(id)!.rank! > first.rank).toBe(true);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    // A page created outside the root is not stored.
    const out = await run('createResource', { body: { name: 'Elsewhere', parentId: outsideFolder.id } });
    expect(node((out as { result: { id: string } }).result.id)).toBeNull();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('createManyResources: nested pages created in one batch, and none outside the root', async () => {
    const parent = indexWithChildren();
    const a = newId('m');
    const b = newId('m');
    const c = newId('m');
    await run('createManyResources', {
      body: {
        resources: [
          { id: a, name: '[INDEX] Batch index', parentId: parent.id },
          { id: b, name: '[BSRC] Batch child', parentId: a },
          { id: c, name: 'Batch outside', parentId: outsideFolder.id },
        ],
      },
    });
    expect(node(a)).toMatchObject({ kind: 'index', depth: node(parent.id)!.depth + 1 });
    expect(node(b)).toMatchObject({ parentId: a, depth: node(parent.id)!.depth + 2 });
    expect(node(b)!.path.names.slice(-2)).toEqual(['Batch index', 'Batch child']);
    expect(node(c)).toBeNull();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('createResourceFromTemplate: the copy and, with includeChildren, its copied descendants', async () => {
    const parent = indexWithChildren();
    const r = await run('createResourceFromTemplate', {
      body: { templateId: tpl.id, name: '[BSRC] Mehrana', parentId: parent.id, includeChildren: true },
    });
    const id = (r as { result: { id: string } }).result.id;
    expect(node(id)).toMatchObject({ referenceType: 'Character Core', propertiesFound: true });
    // The descendants the copy brought along were found by listing, and read.
    expect(rig.i.tree.queries.children(P().id, id).data).toHaveLength(1);
    expect(rig.i.tree.queries.subtree(P().id, id).data.entries).toHaveLength(3);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    await run('createResourceFromTemplate', { body: { templateId: tpl.id, parentId: parent.id } });
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('updateResource: names (and the cached paths below), tags, aliases, hidden and locked', async () => {
    const ix = indexWithChildren();
    const child = P().model.children(ix.id)[0]!;
    // LegendKeeper collapses double spaces: the tree stores what it answered, not what was asked.
    P().model.nameFilter = (n) => n.replace(/ {2,}/g, ' ');
    await run('updateResource', { path: { resourceId: ix.id }, body: { name: '[INDEX]  Renamed  index' } });
    expect(node(ix.id)).toMatchObject({ rawName: '[INDEX] Renamed index', displayName: 'Renamed index' });
    expect(node(child.id)!.path.names).toContain('Renamed index');
    await run('updateResource', {
      path: { resourceId: ix.id },
      body: { tags: ['a', 'b'], aliases: ['Alias one'], isHidden: true, isLocked: true },
    });
    expect(node(ix.id)).toMatchObject({
      tags: ['a', 'b'],
      aliases: ['Alias one'],
      isHidden: true,
      isLocked: true,
    });
    // A rename that drops the prefix makes the page unclassified.
    await run('updateResource', { path: { resourceId: ix.id }, body: { name: 'No prefix' } });
    expect(node(ix.id)).toMatchObject({ kind: 'unclassified', displayName: 'No prefix' });
    expect(rig.i.tree.queries.unclassified(P().id).data.map((n) => n.id)).toContain(ix.id);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    // A page outside the root is not re-read.
    const before = gets();
    await run('updateResource', { path: { resourceId: outsideFolder.id }, body: { name: 'Archive 2' } });
    expect(gets() - before).toBe(1); // the journal's pre-image read only
  });

  it('moveResource: within the root, out of it (its subtree leaves), and into it (its subtree is found)', async () => {
    const ix = indexWithChildren();
    const sub = rig.i.tree.store.subtreeIds(P().id, ix.id);
    const target = [...P().model.res.values()].find(
      (r) => r.name.startsWith('[INDEX]') && r.id !== ix.id && !sub.includes(r.id) && r.id !== rootId,
    )!;
    await run('moveResource', { path: { resourceId: ix.id }, body: { parentId: target.id } });
    expect(node(ix.id)).toMatchObject({ parentId: target.id, depth: node(target.id)!.depth + 1 });
    for (const d of sub) expect(node(d)!.path.ids).toContain(target.id);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    await run('moveResource', { path: { resourceId: ix.id }, body: { parentId: outsideFolder.id } });
    for (const d of sub) expect(node(d)).toBeNull();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    const kept = P()
      .model.children(outsideFolder.id)
      .find((r) => r.name === '[INDEX] Kept outside')!;
    await run('moveResource', { path: { resourceId: kept.id }, body: { parentId: rootId } });
    expect(node(kept.id)).toMatchObject({ depth: 1 });
    expect(rig.i.tree.queries.children(P().id, kept.id).data.map((n) => n.rawName)).toEqual([
      '[BSRC] Kept child',
    ]);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    // Reordering among siblings changes only the rank.
    const sibs = P().model.children(rootId);
    await run('moveResource', { path: { resourceId: sibs.at(-1)!.id }, body: { before: sibs[0]!.id } });
    expect(rig.i.tree.queries.children(P().id, rootId).data[0]!.id).toBe(sibs.at(-1)!.id);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('deleteResource (with its cascaded subtree) and restoreResource (the subtree comes back)', async () => {
    const l = leaf();
    await run('deleteResource', { path: { resourceId: l.id } });
    expect(node(l.id)).toBeNull();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    const ix = indexWithChildren();
    const sub = rig.i.tree.store.subtreeIds(P().id, ix.id);
    expect(sub.length).toBeGreaterThan(3);
    await run(
      'deleteResource',
      { path: { resourceId: ix.id }, query: { cascade: true } },
      { confirm: 'cascade' },
    );
    for (const d of sub) expect(node(d)).toBeNull();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });

    await run('restoreResource', { path: { resourceId: ix.id } });
    for (const d of sub) expect(node(d)).not.toBeNull();
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    await run('restoreResource', { path: { resourceId: l.id } });
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('property and property-row writes: the catalogue fields follow', async () => {
    const l = leaf();
    const kv = () =>
      P()
        .model.res.get(l.id)!
        .props.find((p) => p.kind === 'keyValue' && p.title === 'PROPERTIES')!;
    const propertyId = kv().id;
    await run('createPropertyRow', {
      path: { resourceId: l.id, propertyId },
      body: { key: 'Canonical Display Name', text: 'Mehrana al-Khalid' },
    });
    expect(node(l.id)).toMatchObject({ canonicalDisplayName: 'Mehrana al-Khalid' });
    expect(
      rig.i.tree.queries.findByCanonicalName(P().id, 'mehrana AL-khalid').data.map((m) => m.node.id),
    ).toEqual([l.id]);
    const scopeRow = kv().rows.find((r) => r.key === 'Scope')!;
    await run('updatePropertyRow', {
      path: { resourceId: l.id, propertyId, rowId: scopeRow.id },
      body: { text: 'Fourth Age' },
    });
    expect(node(l.id)).toMatchObject({ scope: 'Fourth Age' });
    await run('deletePropertyRow', { path: { resourceId: l.id, propertyId, rowId: scopeRow.id } });
    expect(node(l.id)).toMatchObject({ scope: null });
    await run('updateProperty', {
      path: { resourceId: l.id, propertyId },
      body: { rows: [{ key: 'Reference Type', text: 'Character Core' }] },
    });
    expect(node(l.id)).toMatchObject({ referenceType: 'Character Core', canonicalDisplayName: null });
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    await run('deleteProperty', { path: { resourceId: l.id, propertyId } });
    expect(node(l.id)).toMatchObject({ propertiesFound: false, referenceType: null });
    await run('createProperty', {
      path: { resourceId: l.id },
      body: {
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [{ key: 'Reference Type', text: 'Relationship' }],
      },
    });
    expect(node(l.id)).toMatchObject({ propertiesFound: true, referenceType: 'Relationship' });
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('document writes: the documents list follows', async () => {
    const l = leaf();
    const r = await run('createDocument', {
      path: { resourceId: l.id },
      body: { name: 'Timeline', type: 'time' },
    });
    const docId = (r as { result: { id: string } }).result.id;
    expect(node(l.id)!.documents).toContainEqual({ id: docId, name: 'Timeline', type: 'time' });
    await run('updateDocument', {
      path: { resourceId: l.id, documentId: docId },
      body: { name: 'Chronology' },
    });
    expect(rig.i.tree.queries.documents(P().id, l.id).data).toContainEqual({
      id: docId,
      name: 'Chronology',
      type: 'time',
    });
    await run('deleteDocument', { path: { resourceId: l.id, documentId: docId } });
    expect(node(l.id)!.documents.map((d) => d.id)).not.toContain(docId);
    await run('restoreDocument', { path: { resourceId: l.id, documentId: docId } });
    expect(node(l.id)!.documents.map((d) => d.id)).toContain(docId);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('page content writes do not touch the tree', async () => {
    const l = leaf();
    const docId = P().model.liveDocs(P().model.res.get(l.id)!)[0]!.id;
    const before = gets();
    const lastRead = node(l.id)!.lastReadAt;
    await run('replaceDocumentBlocks', {
      path: { resourceId: l.id, documentId: docId },
      body: { blocks: [] },
    });
    expect(P().model.mutations.at(-1)).toEqual({ op: 'replaceDocumentBlocks', id: docId });
    expect(gets()).toBe(before);
    expect(node(l.id)!.lastReadAt).toBe(lastRead);
    expect(rig.i.tree.store.pending()).toEqual([]);
  });

  it('records how and when each node was last read', async () => {
    const l = leaf();
    expect(node(l.id)!.lastReadBy).toBe('build');
    await rig.clock.advance(5000);
    await run('updateResource', { path: { resourceId: l.id }, body: { tags: ['x'] } });
    expect(node(l.id)).toMatchObject({ lastReadBy: 'write' });
    expect(node(l.id)!.lastReadAt).toBeGreaterThan(rig.i.tree.meta(P().id).confirmedAt!);
  });
});

describe('when a re-read cannot be made', () => {
  it('a failed re-read is recorded, the tree is stale, and a retry settles it', async () => {
    const parent = indexWithChildren();
    const id = newId('f');
    P().mock.inject(
      (c) => c.method === 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${id}`),
      { kind: 'status', status: 503, code: 'UNAVAILABLE' },
      4, // the governor retries a 503 three times: every attempt fails
    );
    await run('createResource', { body: { id, name: '[BSRC] Unread', parentId: parent.id } });
    expect(node(id)).toBeNull();
    const meta = rig.i.tree.meta(P().id);
    expect(meta).toMatchObject({ status: 'stale', pendingRereads: 1 });
    expect(rig.i.tree.store.listLog(P().id, { limit: 5, source: 'write' })[0]).toMatchObject({
      change: 'reread_failed',
      nodeId: id,
    });
    // The error is in the errors table too.
    expect(rig.i.engine.queries.listErrors(P().id, {}).some((e) => e.opId === 'getResource')).toBe(true);
    // The retry (a minute later, at P3) reads it and settles the tree.
    await rig.drive(() => node(id) !== null);
    await rig.settle(rig.i.tree.whenIdle());
    expect(rig.i.tree.meta(P().id).status).toBe('ready');
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('a crash between a write and its re-read is caught up at the next start', async () => {
    const parent = indexWithChildren();
    const id = newId('k');
    // The re-read is held, so the process "dies" after LegendKeeper applied the create but before the tree saw it.
    const release = rig.holdRequest(
      (w) => w.method === 'GET' && w.url.replace(/\/$/, '').endsWith(`/resources/${id}`),
    );
    rig.i.engine
      .run(
        'createResource',
        { body: { id, name: '[BSRC] Crash', parentId: parent.id } },
        { project: P().id, origin },
      )
      .catch(() => undefined); // the "dead" process's call never completes
    await rig.drive(() => P().model.live(id) !== undefined && rig.i.tree.store.pending().length === 1);
    rig.crash();
    release(); // the dead process never sends it; the new one may
    expect(P().model.live(id)).toBeDefined();
    rig.start();
    await rig.drive(() => node(id) !== null);
    expect(rig.i.tree.store.pending()).toEqual([]);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('a write that failed without applying re-reads nothing', async () => {
    const before = gets();
    await expect(
      run('createResource', { body: { name: '[BSRC] Orphan', parentId: 'zzzzzzzz' } }),
    ).rejects.toMatchObject({ code: 'LK_ERROR' });
    expect(gets()).toBe(before);
    expect(rig.i.tree.store.pending()).toEqual([]);
    expect(ids.length).toBeGreaterThan(0);
  });
});
