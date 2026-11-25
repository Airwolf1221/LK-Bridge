/**
 * v3 F6b (ADR 0079; design T11): the tree knows [NAV]. `classifyName` gives `[NAV] ` kind `index` with role `nav`; the
 * role is stored (migration 4700, `tree_nodes.index_role`), read back on every node, and survives a rename that keeps the
 * prefix (it is always the raw name's prefix); a rename to `[INDEX] ` makes it `subject`. Every other result of
 * `classifyName` is exactly as before (no `role` key), so the existing suites stand untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyName,
  indexRawNames,
  indexRoleOf,
  indexRoleOfName,
  roleOfClassified,
} from '../../src/tree/index.js';
import { cleanPrefixes } from '../../src/registry/names.js';
import { build, treeRig, type TreeRig } from '../tree/helpers.js';

let rig: TreeRig;
afterEach(async () => rig?.close());

describe('classifyName and the index role', () => {
  it('[NAV] is an index with role nav; [INDEX] is unchanged (subject); pages have no role', () => {
    expect(classifyName('[NAV] Humans')).toEqual({ kind: 'index', displayName: 'Humans', role: 'nav' });
    expect(classifyName('[NAV]  Two spaces')).toEqual({
      kind: 'index',
      displayName: 'Two spaces',
      role: 'nav',
    });
    expect(classifyName('[INDEX] Miyubi Sakura')).toEqual({ kind: 'index', displayName: 'Miyubi Sakura' });
    expect(roleOfClassified(classifyName('[INDEX] Miyubi Sakura'))).toBe('subject');
    expect(roleOfClassified(classifyName('[NAV] Humans'))).toBe('nav');
    expect(roleOfClassified(classifyName('[BSRC] Page'))).toBeNull();
    // Strict, as every prefix: case, the space after it.
    expect(classifyName('[nav] Humans').kind).toBe('unclassified');
    expect(classifyName('[NAV]Humans').kind).toBe('unclassified');
    expect(indexRoleOfName('[NAV] Humans')).toBe('nav');
    expect(indexRoleOfName('[INDEX] Humans')).toBe('subject');
    expect(indexRoleOfName('[BSRC] Humans')).toBeNull();
    expect(indexRoleOf({ kind: 'index', rawName: '[NAV] Humans' })).toBe('nav');
    expect(indexRoleOf({ kind: 'bsrc', rawName: '[NAV] Humans' })).toBeNull();
    expect(indexRawNames('Humans')).toEqual(['[INDEX] Humans', '[NAV] Humans']);
  });

  it('a stray [NAV] is cleaned like any prefix, and a query "[NAV] X" asks for an index', () => {
    expect(cleanPrefixes('[NAV] Humans')).toEqual({ name: 'Humans', prefix: 'index', rawPrefix: '[NAV] ' });
    expect(cleanPrefixes('[nav]  [INDEX] Humans')).toMatchObject({ name: 'Humans', prefix: 'index' });
  });
});

describe('the stored role', () => {
  it('is stored from the prefix, read back on every node, and survives a rename that keeps the prefix', async () => {
    rig = await treeRig();
    const m = rig.p.alpha!.model;
    const pid = rig.p.alpha!.id;
    const root = m.seed({ id: 'nroot000', name: 'AI REPOSITORY' });
    const chars = m.seed({ id: 'nchars00', name: '[NAV] Characters', parentId: root.id });
    const humans = m.seed({ id: 'nhumans0', name: '[NAV] Humans', parentId: chars.id });
    const miyubi = m.seed({ id: 'nmiyubi0', name: '[INDEX] Miyubi Sakura', parentId: humans.id });
    m.seed({ id: 'nmiycore', name: '[BSRC] Miyubi Sakura - Character Core', parentId: miyubi.id });
    rig.setRoot('alpha', root.id);
    await build(rig, 'alpha');
    const q = rig.i.tree.queries;
    expect(q.node(pid, humans.id).data).toMatchObject({
      kind: 'index',
      displayName: 'Humans',
      indexRole: 'nav',
    });
    expect(q.node(pid, miyubi.id).data).toMatchObject({ kind: 'index', indexRole: 'subject' });
    expect(q.node(pid, 'nmiycore').data).toMatchObject({ kind: 'bsrc', indexRole: null });
    const row = rig.i.db
      .prepare('SELECT index_role FROM tree_nodes WHERE project_id = ? AND id = ?')
      .get(pid, humans.id) as { index_role: string };
    expect(row.index_role).toBe('nav');
    // The display name looked up as usual; the raw name exactly.
    expect(q.findByName(pid, 'Humans').data.map((x) => x.node.id)).toContain(humans.id);
    expect(q.findByRawName(pid, '[NAV] Humans').data.map((x) => x.node.id)).toEqual([humans.id]);
    // A light scan carries the role too.
    expect(q.nodeScan(pid).find((n) => n.id === humans.id)).toMatchObject({
      indexRole: 'nav',
      kind: 'index',
    });

    // A rename that keeps the prefix keeps the role; one to [INDEX] makes it subject.
    m.outside.rename(humans.id, '[NAV] Human Peoples');
    m.outside.rename(chars.id, '[INDEX] Characters');
    await rig.settle(rig.i.tree.sweep(pid));
    await rig.settle(rig.i.tree.check(pid));
    expect(q.node(pid, humans.id).data).toMatchObject({ displayName: 'Human Peoples', indexRole: 'nav' });
    expect(q.node(pid, chars.id).data).toMatchObject({ displayName: 'Characters', indexRole: 'subject' });
  });

  it('a tree stored before F6b (a [NAV] name held as unclassified) is re-classified once, with no reads', async () => {
    rig = await treeRig();
    const m = rig.p.alpha!.model;
    const pid = rig.p.alpha!.id;
    const root = m.seed({ id: 'oroot000', name: 'AI REPOSITORY' });
    const nav = m.seed({ id: 'onav0000', name: '[NAV] Humans', parentId: root.id });
    rig.setRoot('alpha', root.id);
    await build(rig, 'alpha');
    // As an older bridge stored it.
    rig.i.db
      .prepare(
        "UPDATE tree_nodes SET kind = 'unclassified', display_name = raw_name, index_role = NULL WHERE project_id = ? AND id = ?",
      )
      .run(pid, nav.id);
    rig.i.db.prepare('UPDATE tree_state SET catalogue_key = ? WHERE project_id = ?').run('old', pid);
    const before = rig.i.sent.length;
    expect(rig.i.tree.queries.node(pid, nav.id).data).toBeTruthy();
    const n = rig.i.tree.store.reclassify(pid);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(rig.i.tree.queries.node(pid, nav.id).data).toMatchObject({
      kind: 'index',
      indexRole: 'nav',
      displayName: 'Humans',
    });
    expect(rig.i.sent.length).toBe(before);
  });
});
