/**
 * v2 E5.1 (the owner's first Arkona consistency check, 15 November 2026: "0 added, 0 removed, 4 corrected", eight
 * correction rows for four pages, each pair swapping the same documents between two orders). `listResources` gives a
 * page's documents by name (the spec's `ListedDocument`), `getResource` in tab order with a `rank` (`Document.rank`);
 * the tree stored whichever it read last and compared in order, so each pass "corrected" the other's work.
 *
 * Now the documents are compared as a set of `{ id, name, type }` (no correction for an order alone), and stored in one
 * order, LegendKeeper's tab order: a getResource read sorts by `rank`; a listing keeps the stored order when the set is
 * unchanged, and when it changed keeps the stored order for the documents still there and adds new ones after them.
 *
 * The regression fixture has the four pages' shapes with synthetic names: the root (14 documents), a chronology page
 * (13: Main, six tables, six timelines), a page with Main and a map, a page with Main and a lexicon.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observationFromListItem, observationFromResource } from '../../src/tree/classify.js';
import { documentsToStore } from '../../src/tree/store.js';
import { build, treeRig, type TreeRig } from './helpers.js';
import { seedWorld, type Res } from './model.js';

let rig: TreeRig;
let rootId: string;
let chrono: Res;
let geo: Res;
let lang: Res;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const node = (id: string) => rig.i.tree.queries.node(P().id, id).data!;
const names = (id: string) => node(id).documents.map((d) => d.name);
/** The tab order: the model's documents in rank order, as getResource gives them. */
const tabOrder = (r: Res) =>
  P()
    .model.liveDocs(r)
    .map((d) => d.name);
const AGES = ['Sixth', 'Fifth', 'Fourth', 'Third', 'Second', 'First'].map((x) => `${x} Synthetic Age`);

const passLog = (kind: 'sweep' | 'check') => {
  const pass = rig.i.tree.store.lastPass(P().id, kind)!;
  return { pass, log: rig.i.tree.store.listLog(P().id, { limit: 500, passId: pass.id }) };
};

beforeEach(async () => {
  rig = await treeRig();
  const m = P().model;
  ({ rootId } = seedWorld(m, { nodes: 20, depth: 3 }));
  const root = m.res.get(rootId)!;
  // The root: Main and 13 more, in a tab order that is not the names' order.
  for (let i = 13; i >= 1; i--) m.outside.addDocument(root.id, `Ledger ${String(i).padStart(2, '0')}`);
  // A chronology page: Main, then the six tables, then the six timelines (Main first; "Archon…" sorts before "Main").
  chrono = m.seed({ name: '[BSRC] Synthetic Chronology', parentId: rootId });
  for (const a of AGES) m.outside.addDocument(chrono.id, `${a} - Table`);
  for (const a of AGES) m.outside.addDocument(chrono.id, `${a} - Timeline`, 'time');
  // Main and a map named before it; Main and a lexicon named before it.
  geo = m.seed({ name: '[BSRC] Synthetic Land - Geography', parentId: rootId });
  m.outside.addDocument(geo.id, 'Atlas', 'map');
  lang = m.seed({ name: '[BSRC] Synthetic Tongue - Language and Naming', parentId: rootId });
  m.outside.addDocument(lang.id, 'Lexicon');
  rig.setRoot('alpha', rootId);
  await build(rig, 'alpha');
});

describe('a page’s documents in two orders', () => {
  it('the four pages’ shapes: the check and the sweep, both ways round, correct nothing, and the stored order is the tab order', async () => {
    const pages = [P().model.res.get(rootId)!, chrono, geo, lang];
    expect(pages.map((r) => P().model.liveDocs(r).length)).toEqual([14, 13, 2, 2]);
    // The orders really differ (the listing's is by name).
    for (const r of pages)
      expect(tabOrder(r)).not.toEqual([...tabOrder(r)].sort((a, b) => a.localeCompare(b)));

    // A check (listing then getResource of every page), a sweep (listing only), a check again, a sweep again.
    for (const kind of ['check', 'sweep', 'check', 'sweep'] as const) {
      const r = await rig.settle(kind === 'check' ? rig.i.tree.check(P().id) : rig.i.tree.sweep(P().id));
      const { pass, log } = passLog(kind);
      expect(pass, kind).toMatchObject({ status: 'succeeded', corrected: 0 });
      expect(
        log.filter((e) => e.field === 'documents'),
        kind,
      ).toEqual([]);
      expect(r.changed, kind).toBe(false);
      for (const p of pages) expect(names(p.id), `${kind} ${p.name}`).toEqual(tabOrder(p));
    }
    expect(names(chrono.id)[0]).toBe('Main');
  });

  it('a document added, removed or renamed is still one correction, and the order settles on the tab order', async () => {
    const m = P().model;
    // Added: the sweep (a listing) logs it once and puts it after the stored ones; the check keeps the tab order.
    const added = m.outside.addDocument(lang.id, 'Appendix');
    await rig.settle(rig.i.tree.sweep(P().id));
    let { pass, log } = passLog('sweep');
    expect(pass.corrected).toBe(1);
    expect(log.filter((e) => e.nodeId === lang.id && e.field === 'documents')).toHaveLength(1);
    expect(names(lang.id)).toEqual(['Main', 'Lexicon', 'Appendix']);
    await rig.settle(rig.i.tree.check(P().id));
    ({ pass } = passLog('check'));
    expect(pass.corrected).toBe(0);
    expect(names(lang.id)).toEqual(tabOrder(lang));

    // Renamed: one correction, the order kept.
    m.docs.get(added.id)!.name = 'Addendum';
    await rig.settle(rig.i.tree.check(P().id));
    ({ pass, log } = passLog('check'));
    expect(pass.corrected).toBe(1);
    const renamed = log.filter((e) => e.nodeId === lang.id && e.field === 'documents');
    expect(renamed).toHaveLength(1);
    expect(names(lang.id)).toEqual(['Main', 'Lexicon', 'Addendum']);

    // Removed: one correction.
    m.outside.deleteDocument(added.id);
    await rig.settle(rig.i.tree.sweep(P().id));
    ({ pass, log } = passLog('sweep'));
    expect(pass.corrected).toBe(1);
    expect(log.filter((e) => e.nodeId === lang.id && e.field === 'documents')).toHaveLength(1);
    expect(names(lang.id)).toEqual(['Main', 'Lexicon']);
  });
});

describe('the rule itself', () => {
  const doc = (id: string, name: string, rank?: string) => ({
    id,
    name,
    type: 'page',
    ...(rank !== undefined ? { rank } : {}),
  });

  it('a getResource observation is in tab order (by rank), whatever order the response used; a listing’s is as given', () => {
    const res = {
      id: 'page0001',
      name: 'A page',
      documents: [doc('d2', 'Archon', 'a2'), doc('d3', 'Zeta', 'a3'), doc('d1', 'Main', 'a1')],
      properties: [],
    };
    expect(observationFromResource(res)!.documents.map((d) => d.name)).toEqual(['Main', 'Archon', 'Zeta']);
    const listed = { id: 'page0001', name: 'A page', documents: [doc('d2', 'Archon'), doc('d1', 'Main')] };
    expect(observationFromListItem(listed)!.documents.map((d) => d.name)).toEqual(['Archon', 'Main']);
  });

  it('a listing keeps the stored order for the same set, and adds new documents after the stored ones', () => {
    const stored = [doc('d1', 'Main'), doc('d2', 'Archon')];
    expect(documentsToStore(stored, [doc('d2', 'Archon'), doc('d1', 'Main')], false)).toEqual(stored);
    expect(
      documentsToStore(stored, [doc('d0', 'Aardvark'), doc('d2', 'Archon'), doc('d1', 'Main')], false).map(
        (d) => d.id,
      ),
    ).toEqual(['d1', 'd2', 'd0']);
    expect(documentsToStore(stored, [doc('d2', 'Archive')], false)).toEqual([doc('d2', 'Archive')]);
    // A getResource read is stored as it came (already in tab order).
    expect(documentsToStore(stored, [doc('d2', 'Archon'), doc('d1', 'Main')], true).map((d) => d.id)).toEqual(
      ['d2', 'd1'],
    );
  });
});
