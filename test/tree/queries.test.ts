/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any) in object literals */
/**
 * v2 A2: the query layer later sessions build on (A3 name resolution and ordering, B2 the Discover tools), and the pure
 * helpers: classification by prefix, the catalogue fields, the configurable property and row names.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogueFrom,
  classifyName,
  nameKey,
  summariseSidebar,
  treeSettingsFrom,
} from '../../src/tree/index.js';
import { build, treeRig, type TreeRig } from './helpers.js';

let rig: TreeRig;
afterEach(async () => rig?.close());

describe('classification', () => {
  it('kind and display name come from the exact prefix', () => {
    expect(classifyName('[INDEX] Characters')).toEqual({ kind: 'index', displayName: 'Characters' });
    expect(classifyName('[BSRC] Asagiri Miyabi')).toEqual({ kind: 'bsrc', displayName: 'Asagiri Miyabi' });
    expect(classifyName('[INDEX]  Two spaces')).toEqual({ kind: 'index', displayName: 'Two spaces' });
    expect(classifyName('[index] Lower case')).toEqual({
      kind: 'unclassified',
      displayName: '[index] Lower case',
    });
    expect(classifyName('[INDEX]NoSpace')).toEqual({ kind: 'unclassified', displayName: '[INDEX]NoSpace' });
    expect(classifyName('Notes')).toEqual({ kind: 'unclassified', displayName: 'Notes' });
    expect(nameKey('Ｅcole É')).toBe(nameKey('ｅcole É'));
  });

  it('reads the catalogue fields from the configured key-value property and rows', () => {
    const sidebar = summariseSidebar([
      { id: 'p0', kind: 'keyValue', title: 'Other', rows: [{ key: 'Reference Type', text: 'Wrong block' }] },
      {
        id: 'p1',
        kind: 'keyValue',
        title: ' properties ',
        rows: [
          { key: 'Reference Type', text: 'Character Core' },
          { key: 'scope', content: [{ text: 'Fourth ' }, { text: 'Age' }] },
          { key: 'Index Scope', text: '   ' },
          { key: 'Canonical Display Name', content: [{ mention: { resourceId: 'x', text: 'Mehrana' } }] },
          { key: 'Facts', content: [{ text: 'a' }, { break: true }, { text: 'b' }] },
        ],
      },
      { id: 'p2', kind: 'unsupported', title: 'TAGS' },
    ]);
    const t = treeSettingsFrom({});
    expect(catalogueFrom(sidebar, t)).toEqual({
      referenceType: 'Character Core',
      scope: 'Fourth Age',
      indexScope: null,
      canonicalDisplayName: 'Mehrana',
      propertiesFound: true,
    });
    // Configurable names: another property and other row keys.
    const custom = treeSettingsFrom({ treePropertiesName: 'Other', treeReferenceTypeRow: 'Reference Type' });
    expect(catalogueFrom(sidebar, custom)).toMatchObject({ referenceType: 'Wrong block', scope: null });
    expect(catalogueFrom([], t)).toEqual({
      referenceType: null,
      scope: null,
      indexScope: null,
      canonicalDisplayName: null,
      propertiesFound: false,
    });
  });
});

describe('the query layer', () => {
  it('answers from the stored tree, stating status and confirmation, with exact-name lookups returning all matches', async () => {
    rig = await treeRig();
    const m = rig.p.alpha!.model;
    const pid = rig.p.alpha!.id;
    const root = m.seed({ id: 'qroot000', name: 'AI REPOSITORY' });
    const chars = m.seed({
      id: 'qchars00',
      name: '[INDEX] Characters',
      parentId: root.id,
      aliases: ['People'],
    });
    const humans = m.seed({ id: 'qhumans0', name: '[INDEX] Humans', parentId: chars.id });
    const a1 = m.seed({
      id: 'qasagiri',
      name: '[BSRC] Asagiri Miyabi',
      parentId: humans.id,
      canonical: 'Miyabi',
    });
    const a2 = m.seed({
      id: 'qasagir2',
      name: '[INDEX] Asagiri Miyabi',
      parentId: humans.id,
      aliases: ['miyabi'],
    });
    const loose = m.seed({ id: 'qloose00', name: 'Loose notes', parentId: chars.id });
    const deep = m.seed({ id: 'qdeep000', name: '[BSRC] Deep', parentId: a2.id });
    m.seed({ id: 'qoutside', name: '[BSRC] Asagiri Miyabi', parentId: null }); // outside the root: never found

    // Before configuration: nothing is answered, and the status says why.
    const before = rig.i.tree.queries.findByName(pid, 'Asagiri Miyabi');
    expect(before).toEqual({ tree: expect.objectContaining({ status: 'not_configured' }), data: [] });

    rig.setRoot('alpha', root.id);
    await build(rig, 'alpha');
    const q = rig.i.tree.queries;

    const kids = q.children(pid, humans.id);
    expect(kids.tree).toMatchObject({ status: 'ready', projectId: pid, rootId: root.id });
    expect(kids.tree.confirmedAt).toEqual(expect.any(Number));
    expect(kids.data.map((n) => n.id)).toEqual([a1.id, a2.id]); // LegendKeeper's sibling order (rank)

    expect(q.root(pid).data).toMatchObject({ id: root.id, kind: 'root', depth: 0, parentId: null });
    expect(q.path(pid, deep.id).data.map((p) => p.displayName)).toEqual([
      'AI REPOSITORY',
      'Characters',
      'Humans',
      'Asagiri Miyabi',
      'Deep',
    ]);
    expect(q.node(pid, deep.id).data).toMatchObject({ depth: 4, path: { names: expect.any(Array) } });
    expect(q.documents(pid, a1.id).data).toEqual([{ id: expect.any(String), name: 'Main', type: 'page' }]);
    expect(q.documents(pid, 'qoutside').data).toBeNull();

    const sub = q.subtree(pid, chars.id, { maxDepth: 1 }).data;
    expect(sub.entries.map((e) => [e.node.id, e.relativeDepth])).toEqual([
      [chars.id, 0],
      [humans.id, 1],
      [loose.id, 1],
    ]);
    const all = q.subtree(pid, chars.id).data;
    expect(all.entries.map((e) => e.node.id)).toEqual([chars.id, humans.id, a1.id, a2.id, deep.id, loose.id]);
    expect(q.subtree(pid, chars.id, { limit: 2 }).data).toMatchObject({ truncated: true });

    expect(q.byKind(pid, 'index').data.map((n) => n.id)).toEqual([chars.id, humans.id, a2.id]);
    expect(q.unclassified(pid).data.map((n) => n.id)).toEqual([loose.id]);

    // Exact names: every match, through any of the four names, case-insensitive by default.
    const byName = q.findByName(pid, 'asagiri miyabi').data;
    expect(byName.map((x) => [x.node.id, x.field])).toEqual([
      [a2.id, 'display'],
      [a1.id, 'display'],
    ]);
    expect(q.findByName(pid, 'asagiri miyabi', { caseSensitive: true }).data).toEqual([]);
    expect(q.findByRawName(pid, '[BSRC] Asagiri Miyabi').data.map((x) => x.node.id)).toEqual([a1.id]);
    expect(q.findByDisplayName(pid, 'Asagiri Miyabi').data).toHaveLength(2);
    expect(q.findByAlias(pid, 'PEOPLE').data.map((x) => x.node.id)).toEqual([chars.id]);
    const miyabi = q.findByName(pid, 'Miyabi').data.map((x) => [x.node.id, x.field]);
    expect(miyabi).toEqual([
      [a2.id, 'alias'],
      [a1.id, 'canonical'],
    ]);
    expect(q.findByCanonicalName(pid, 'miyabi').data.map((x) => x.node.id)).toEqual([a1.id]);
    expect(q.findByName(pid, 'Asagiri').data).toEqual([]); // no partial or fuzzy matching

    // Changing the row names re-derives the catalogue fields without a single read.
    const gets = rig.p.alpha!.mock.calls.length;
    rig.setSetting('alpha', 'treeCanonicalNameRow', 'Scope');
    expect(q.node(pid, a1.id).data!.canonicalDisplayName).toBe('Arkona');
    expect(q.findByCanonicalName(pid, 'Arkona').data.length).toBeGreaterThan(1);
    expect(rig.p.alpha!.mock.calls.length).toBe(gets);
  });
});
