/**
 * Helpers for the whole-set lifecycle tests (C2d, ADR 0037): a character set seeded in the lifecycle test world, in a
 * given state, with four pages and a nested index:
 *
 *   [INDEX] {name}                        (the root)
 *     [INDEX] {name} Art                  (a nested index)
 *       [BSRC|BWRK] {name} - Portraits
 *     [BSRC|BWRK] {name} - Character Core
 *
 * Content pages carry every lifecycle fact (so no template is needed), the status tag and a Main page with one block;
 * indexes carry an Index property (no Status), the status tag and a Main page. The tree learns them by a sweep.
 */
import { PROJECT } from '../tools/helpers.js';
import { facts, SidebarModel } from '../resources/world.js';
import { LIFECYCLE, textOf, type LifecycleWorld } from './world.js';

export interface SetIds {
  readonly name: string;
  readonly root: string;
  readonly art: string;
  readonly core: string;
  readonly portraits: string;
  readonly all: readonly string[];
}

let seq = 0;

/** Seeds a set: Authoritative under `parent` (default Locations), or Working under [INDEX] Working. */
export async function seedSet(
  w: LifecycleWorld,
  state: 'authoritative' | 'working',
  o: {
    name?: string;
    parent?: string;
    /** More content pages directly under the root (for costs). */ extra?: number;
  } = {},
): Promise<SetIds> {
  seq++;
  const tag = state === 'working' ? 'Working' : 'CANON';
  const prefix = state === 'working' ? '[BWRK] ' : '[BSRC] ';
  const n = (s: string) => `k${seq.toString(36).padStart(3, '0')}${s}`;
  const ids = { root: n('root'), art: n('artx'), core: n('core'), portraits: n('port') };
  const name = o.name ?? `Kaito ${seq}`;
  const parent = o.parent ?? (state === 'working' ? LIFECYCLE.working : 'locs0001');
  w.repo.seed({ id: ids.root, name: `[INDEX] ${name}`, parentId: parent, tags: [tag] });
  w.repo.seed({ id: ids.art, name: `[INDEX] ${name} Art`, parentId: ids.root, tags: [tag] });
  w.repo.seed({
    id: ids.core,
    name: `${prefix}${name} - Character Core`,
    parentId: ids.root,
    tags: [tag, 'hero'],
  });
  w.repo.seed({ id: ids.portraits, name: `${prefix}${name} - Portraits`, parentId: ids.art, tags: [tag] });
  for (const id of [ids.root, ids.art]) {
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id.slice(0, 6)}`, 'PROPERTIES', [
        ['Reference Type', 'Index'],
        ['Index Scope', `Scope of ${id}`],
      ]),
    ]);
    w.repo.blocks.set(w.main(id), {
      version: 2,
      blocks: [{ id: `${id}b1`, kind: 'paragraph', content: [{ text: `Index ${id}.` }] }],
    });
  }
  for (const id of [ids.core, ids.portraits]) {
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id.slice(0, 6)}`, 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', state === 'working' ? 'Working' : 'Authoritative'],
        ['Continuity Type', state === 'working' ? 'AU' : 'CANON'],
        ['Scope', `Scope of ${id}`],
        ['Temporal Scope', 'Fourth Age'],
        ['Last Major Revision', '2026-10-01'],
      ]),
    ]);
    w.repo.blocks.set(w.main(id), {
      version: 2,
      blocks: [{ id: `${id}b1`, kind: 'paragraph', content: [{ text: `Body of ${id}.` }] }],
    });
  }
  const extra: string[] = [];
  for (let i = 0; i < (o.extra ?? 0); i++) {
    const id = n(`e${i.toString(36).padStart(3, '0')}`);
    extra.push(id);
    w.repo.seed({ id, name: `${prefix}${name} - Extra ${i}`, parentId: ids.root, tags: [tag] });
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id.slice(0, 6)}`, 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', state === 'working' ? 'Working' : 'Authoritative'],
        ['Continuity Type', state === 'working' ? 'AU' : 'CANON'],
        ['Scope', `Scope of ${id}`],
        ['Temporal Scope', 'Fourth Age'],
        ['Last Major Revision', '2026-10-01'],
      ]),
    ]);
    w.repo.blocks.set(w.main(id), {
      version: 2,
      blocks: [{ id: `${id}b1`, kind: 'paragraph', content: [{ text: `Body of ${id}.` }] }],
    });
  }
  await w.stack.runtime.tree.sweep(PROJECT);
  return { name, ...ids, all: [ids.root, ids.art, ids.core, ids.portraits, ...extra] };
}

/** The first block's text of a page's Main document. */
export const firstText = (w: LifecycleWorld, id: string) => textOf(w.blocks(w.main(id))[0]);

/** A page's fact value (rank order), or undefined. */
export const fact = (w: LifecycleWorld, id: string, key: string) =>
  facts(w, id)
    .find((f) => f.startsWith(`${key}=`))
    ?.slice(key.length + 1);

/** The names of a parent's live children, in rank order. */
export const kids = (w: LifecycleWorld, parentId: string) =>
  [...w.repo.res.values()]
    .filter((r) => r.parentId === parentId && r.deletedAt === null)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((r) => r.name);

/** Whether a list of sibling names is in the bridge's order: indexes first, then pages, each alphabetical. */
export function inSiblingOrder(names: readonly string[]): boolean {
  const key = (n: string) => [
    n.startsWith('[INDEX]') ? 0 : 1,
    n.replace(/^\[[A-Z]+\]\s*/, '').toLocaleLowerCase('en-GB'),
  ];
  for (let i = 1; i < names.length; i++) {
    const a = key(names[i - 1]!);
    const b = key(names[i]!);
    if (a[0]! > b[0]! || (a[0] === b[0] && (a[1] as string).localeCompare(b[1] as string, 'en-GB') > 0))
      return false;
  }
  return true;
}

/** Makes the `k`-th LegendKeeper write from now fail with a 500 (never retried), once. Returns a disarm function. */
export function failWrite(w: LifecycleWorld, k: number): () => void {
  let seen = 0;
  const re = /.*/;
  const before = [...w.overrides];
  w.overrides.clear();
  w.overrides.set(re, (req) => {
    if (req.method === 'GET') return undefined;
    if (seen++ !== k) return undefined;
    return { status: 500, body: { code: 'INTERNAL', message: 'injected fault', requestId: 'fault-set' } };
  });
  for (const [key, v] of before) w.overrides.set(key, v);
  return () => w.overrides.delete(re);
}

/**
 * Whether `name` sits in its alphabetical place among its siblings: the neighbour before it sorts before it and the one
 * after it after it (indexes first, then pages, each alphabetical). Only its own neighbours count, so siblings that were
 * already out of order elsewhere in the list do not matter.
 */
export function placedAmong(names: readonly string[], name: string): boolean {
  const i = names.indexOf(name);
  if (i < 0) return false;
  const pair = (a: string | undefined, b: string | undefined) =>
    a === undefined || b === undefined || inSiblingOrder([a, b]);
  return pair(names[i - 1], name) && pair(name, names[i + 1]);
}
