/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any) in object literals */
/**
 * v2 A2: the structural sweep and the daily consistency check. The sweep detects every structural change made outside
 * the bridge (create, rename, move into / out of / within the root, delete, tags, aliases, documents) with a listing
 * and reads properties only of new and stale nodes; the check also detects property changes. Both record each
 * correction (old and new value, which pass) in the correction log. The concurrency rule: a sweep or check never
 * undoes an after-write update made after its snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpParams } from '../../src/jobs/index.js';
import { build, expectTreeMatchesModel, origin, seenAt, treeRig, type TreeRig } from './helpers.js';
import { newId, seedWorld, type Res } from './model.js';

let rig: TreeRig;
let rootId: string;
let outsideFolder: Res;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const node = (id: string) => rig.i.tree.queries.node(P().id, id).data;
const gets = () => seenAt(rig, 'alpha', 'GET', /^\/resources\/[^/]+$/);
const lists = () => seenAt(rig, 'alpha', 'GET', /^\/resources$/);
const run = (op: string, params: OpParams) =>
  rig.settle(rig.i.engine.run(op, params, { project: P().id, origin }));
const live = (pred: (r: Res) => boolean) =>
  [...P().model.res.values()].filter((r) => r.deletedAt === null && pred(r));
const indexes = () =>
  live((r) => r.name.startsWith('[INDEX] Group') && r.parentId !== null && r.id !== rootId);
const leaves = () => live((r) => r.name.startsWith('[BSRC] Source') && P().model.children(r.id).length === 0);

beforeEach(async () => {
  rig = await treeRig();
  const m = P().model;
  ({ rootId } = seedWorld(m, { nodes: 120, depth: 5 }));
  outsideFolder = m.seed({ name: 'Archive', parentId: null });
  const kept = m.seed({ name: '[INDEX] Old notes', parentId: outsideFolder.id });
  m.seed({ name: '[BSRC] Old note', parentId: kept.id });
  rig.setRoot('alpha', rootId);
  await build(rig, 'alpha');
});

describe('the structural sweep', () => {
  it('detects every structural change made outside the bridge, reading only new nodes', async () => {
    const m = P().model;
    const out = m.outside;
    const [ixA, ixB, ixC] = indexes();
    const [l1, l2, l3, l4, l5] = leaves();
    const created = out.create('[BSRC] Made in the app', ixA!.id, { tags: ['app'] });
    const l1Old = l1!.name;
    out.rename(l1!.id, '[BSRC] Renamed in the app');
    out.move(l2!.id, ixB!.id); // within the root
    const subOfC = rig.i.tree.store.subtreeIds(P().id, ixC!.id);
    out.move(ixC!.id, outsideFolder.id); // out of the root, with its subtree
    const keptIx = m.children(outsideFolder.id).find((r) => r.name === '[INDEX] Old notes')!;
    out.move(keptIx.id, ixA!.id); // into the root, with its child
    out.delete(l3!.id);
    out.setTags(l4!.id, ['canon', 'arkona']);
    out.setAliases(l4!.id, ['Another name']);
    const doc = out.addDocument(l5!.id, 'Map', 'map');
    out.deleteDocument(m.liveDocs(l5!)[0]!.id);
    // A property change is not something a sweep looks at.
    out.setRow(l4!.id, 'Reference Type', 'Changed quietly');

    const g0 = gets();
    const l0 = lists();
    const r = await rig.settle(rig.i.tree.sweep(P().id));
    expect(r.changed).toBe(true);
    // One listing (about one request per 100 resources), and getResource only for the three nodes it had never seen,
    // plus one for the page the listing no longer showed (a 404 confirms it was deleted).
    expect(lists() - l0).toBe(Math.ceil(m.res.size / 100));
    expect(gets() - g0).toBe(3 + 1);

    expect(node(created.id)).toMatchObject({
      rawName: '[BSRC] Made in the app',
      tags: ['app'],
      lastReadBy: 'sweep',
    });
    expect(node(l1!.id)).toMatchObject({ displayName: 'Renamed in the app' });
    expect(node(l2!.id)).toMatchObject({ parentId: ixB!.id });
    for (const id of subOfC) expect(node(id)).toBeNull();
    expect(node(keptIx.id)).toMatchObject({ parentId: ixA!.id });
    expect(rig.i.tree.queries.children(P().id, keptIx.id).data).toHaveLength(1);
    expect(node(l3!.id)).toBeNull();
    expect(node(l4!.id)).toMatchObject({ tags: ['canon', 'arkona'], aliases: ['Another name'] });
    expect(node(l4!.id)!.referenceType).not.toBe('Changed quietly');
    expect(node(l5!.id)!.documents.map((d) => d.id)).toEqual([doc.id]);

    // The correction log: what changed, old and new, found by this sweep.
    const pass = rig.i.tree.store.lastPass(P().id, 'sweep')!;
    expect(pass).toMatchObject({ status: 'succeeded', added: 3, removed: subOfC.length + 1 });
    const log = rig.i.tree.store.listLog(P().id, { limit: 500, passId: pass.id });
    expect(log.every((e) => e.source === 'sweep')).toBe(true);
    const entry = (nodeId: string, change: string, field?: string) =>
      log.find(
        (e) => e.nodeId === nodeId && e.change === change && (field === undefined || e.field === field),
      );
    expect(entry(created.id, 'added')).toBeDefined();
    expect(entry(l1!.id, 'updated', 'name')).toMatchObject({
      oldValue: l1Old,
      newValue: '[BSRC] Renamed in the app',
    });
    expect(entry(l2!.id, 'updated', 'parentId')).toMatchObject({ newValue: ixB!.id });
    expect(entry(ixC!.id, 'removed')).toMatchObject({ detail: 'moved outside the root' });
    expect(entry(l3!.id, 'removed')).toMatchObject({ detail: 'deleted' });
    expect(entry(keptIx.id, 'added')).toBeDefined();
    expect(entry(l4!.id, 'updated', 'tags')).toMatchObject({ oldValue: [], newValue: ['canon', 'arkona'] });
    expect(entry(l4!.id, 'updated', 'aliases')).toMatchObject({ newValue: ['Another name'] });
    expect(entry(l5!.id, 'updated', 'documents')).toBeDefined();

    // Everything but the quiet property change matches LegendKeeper; the check then finds that too.
    out.setRow(l4!.id, 'Reference Type', node(l4!.id)!.referenceType!);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    expect(rig.i.tree.meta(P().id)).toMatchObject({ status: 'ready', confirmedBy: 'sweep' });
  });

  it('an unchanged project is swept with the listing alone, and nothing is logged', async () => {
    const g0 = gets();
    const r = await rig.settle(rig.i.tree.sweep(P().id));
    expect(r).toMatchObject({ changed: false });
    expect(gets()).toBe(g0);
    const pass = rig.i.tree.store.lastPass(P().id, 'sweep')!;
    expect(rig.i.tree.store.listLog(P().id, { limit: 10, passId: pass.id })).toEqual([]);
  });

  it('can be switched off for a project', async () => {
    rig.setSetting('alpha', 'treeSweepEnabled', false);
    const l0 = lists();
    expect(await rig.i.tree.sweep(P().id)).toMatchObject({
      skipped: true,
      summary: expect.stringMatching(/switched off/),
    });
    expect(lists()).toBe(l0);
    // The daily check still runs.
    expect(await rig.settle(rig.i.tree.check(P().id))).toMatchObject({ changed: false });
  });

  it('fails, changing nothing, when the root has gone', async () => {
    P().model.outside.delete(rootId);
    await expect(rig.settle(rig.i.tree.sweep(P().id))).rejects.toThrow(/root .* is gone/);
    expect(rig.i.tree.queries.counts(P().id).data.total).toBe(121);
    expect(rig.i.tree.store.lastPass(P().id, 'sweep')!.status).toBe('failed');
  });
});

describe('the daily consistency check', () => {
  it('detects property changes (and structure), and logs each correction with old and new values', async () => {
    const out = P().model.outside;
    const [l1, l2, l3] = leaves();
    out.setRow(l1!.id, 'Reference Type', 'Character Core');
    out.setRow(l2!.id, 'Canonical Display Name', 'Asagiri Miyabi');
    out.setLocked(l3!.id, true);
    out.rename(l3!.id, '[BSRC] Asagiri');
    const g0 = gets();
    const r = await rig.settle(rig.i.tree.check(P().id));
    expect(r.changed).toBe(true);
    // A full pass: every node's properties.
    expect(gets() - g0).toBe(121);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    expect(
      rig.i.tree.queries.findByCanonicalName(P().id, 'Asagiri Miyabi').data.map((x) => x.node.id),
    ).toEqual([l2!.id]);
    const pass = rig.i.tree.store.lastPass(P().id, 'check')!;
    expect(pass).toMatchObject({ status: 'succeeded', corrected: 3, readOk: 121 });
    const log = rig.i.tree.store.listLog(P().id, { limit: 100, passId: pass.id });
    expect(log.find((e) => e.nodeId === l1!.id && e.field === 'referenceType')).toMatchObject({
      source: 'check',
      change: 'updated',
      oldValue: 'General Source',
      newValue: 'Character Core',
    });
    expect(log.find((e) => e.nodeId === l2!.id && e.field === 'canonicalDisplayName')).toMatchObject({
      oldValue: null,
      newValue: 'Asagiri Miyabi',
    });
    expect(log.find((e) => e.nodeId === l3!.id && e.field === 'isLocked')).toMatchObject({
      oldValue: false,
      newValue: true,
    });
    expect(log.find((e) => e.nodeId === l3!.id && e.field === 'name')).toMatchObject({
      newValue: '[BSRC] Asagiri',
    });
    expect(rig.i.tree.meta(P().id)).toMatchObject({ status: 'ready', confirmedBy: 'check' });
  });
});

describe('concurrency: a pass never undoes a newer after-write update', () => {
  it('a sweep that listed before a rename, a create and a delete by the bridge keeps all three', async () => {
    const [l1, l2] = leaves();
    const [ix] = indexes();
    const held = rig.holdResponse((w) => w.method === 'GET' && /\/resources\/?\?/.test(w.url));
    const sweep = rig.i.tree.sweep(P().id);
    await rig.drive(() => held.arrived()); // LegendKeeper has answered the listing: the snapshot is taken
    const T = rig.i.tree.store.activePass(P().id)!.snapshotAt!;
    await rig.clock.advance(1000);

    await run('updateResource', {
      path: { resourceId: l1!.id },
      body: { name: '[BSRC] Renamed by the bridge' },
    });
    const id = newId('y');
    await run('createResource', { body: { id, name: '[BSRC] Created by the bridge', parentId: ix!.id } });
    await run('deleteResource', { path: { resourceId: l2!.id } });
    expect(node(l1!.id)).toMatchObject({ rawName: '[BSRC] Renamed by the bridge', lastReadBy: 'write' });
    expect(node(l1!.id)!.lastReadAt).toBeGreaterThan(T);

    held.release();
    await rig.settle(sweep);
    // The listing showed the old name, no new page and the deleted one: none of that is applied.
    expect(node(l1!.id)).toMatchObject({ rawName: '[BSRC] Renamed by the bridge' });
    expect(node(id)).not.toBeNull();
    expect(node(l2!.id)).toBeNull();
    const pass = rig.i.tree.store.lastPass(P().id, 'sweep')!;
    expect(pass).toMatchObject({ added: 0, removed: 0, corrected: 0 });
    expect(rig.i.tree.store.listLog(P().id, { limit: 10, passId: pass.id })).toEqual([]);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('a check that read a page before the bridge changed its properties keeps the newer values', async () => {
    const [l1] = leaves();
    const kv = () =>
      P()
        .model.res.get(l1!.id)!
        .props.find((p) => p.title === 'PROPERTIES')!;
    const scopeRow = kv().rows.find((r) => r.key === 'Scope')!;
    const held = rig.holdResponse(
      (w) => w.method === 'GET' && w.url.replace(/\/$/, '').endsWith(`/resources/${l1!.id}`),
    );
    const check = rig.i.tree.check(P().id);
    await rig.drive(() => held.arrived()); // the check's read of l1 has its (old) answer
    await rig.clock.advance(1000);
    await run('updatePropertyRow', {
      path: { resourceId: l1!.id, propertyId: kv().id, rowId: scopeRow.id },
      body: { text: 'Changed by the bridge' },
    });
    expect(node(l1!.id)).toMatchObject({ scope: 'Changed by the bridge', lastReadBy: 'write' });
    held.release();
    await rig.settle(check);
    expect(node(l1!.id)).toMatchObject({ scope: 'Changed by the bridge' });
    const pass = rig.i.tree.store.lastPass(P().id, 'check')!;
    expect(rig.i.tree.store.listLog(P().id, { limit: 10, passId: pass.id })).toEqual([]);
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });

  it('updates of one project are applied in order, one at a time', async () => {
    // Several writes at once to the same project: every re-read is applied, none lost.
    const ls = leaves().slice(0, 6);
    await rig.settle(
      Promise.all(
        ls.map((l, i) =>
          rig.i.engine.run(
            'updateResource',
            { path: { resourceId: l.id }, body: { tags: [`t${i}`] } },
            {
              project: P().id,
              origin,
            },
          ),
        ),
      ),
    );
    ls.forEach((l, i) => expect(node(l.id)!.tags).toEqual([`t${i}`]));
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
  });
});
