/**
 * v3 F6c (ADR 0080, C5): placement by role, the pure rules over a hand-made tree: T4's three levels for a nation-level
 * category (the nation's bound role; else the nation index; else the territory's bound category), a continent category
 * by its binding, a nation by its entry (its short name too), and today's name rules while a type is not seeded.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import {
  findNation,
  homeMatch,
  homeTreeOf,
  isNation,
  nationCategoryHome,
  type RoleView,
} from '../../src/packs/engine/homes.js';
import { roleForCategory } from '../../src/packs/nations/roles.js';
import type { HomeRule } from '../../src/packs/types.js';
import type { TreeNode } from '../../src/tree/index.js';

const owners = ARKONA_PACK.rules.owners!;
const tax = ARKONA_PACK.rules.indexTaxonomy!;

/** id → [name, parent] */
const SPEC: Record<string, [string, string | null]> = {
  root: ['AI REPOSITORY', null],
  zar: ['Zarvia', 'root'],
  zpol: ['Zarvia Polities', 'zar'],
  zcul: ['Zarvia Cultures', 'zar'],
  zset: ['Zarvia Settlements & Locations', 'zar'],
  can: ['Kingdom of Cantha', 'zpol'],
  cset: ['Settlements & Locations', 'can'],
  cinst: ['Cantha Institutions', 'can'],
  vash: ['Emirate of Vash - Polity Reference', 'zpol'],
};

function tree(roles: RoleView | null) {
  const nodes = new Map<string, TreeNode>();
  const pathOf = (id: string): string[] => {
    const p = SPEC[id]![1];
    return p ? [...pathOf(p), id] : [id];
  };
  for (const [id, [name, parentId]] of Object.entries(SPEC)) {
    const ids = pathOf(id);
    nodes.set(id, {
      id,
      rawName: id === 'vash' ? `[BSRC] ${name}` : `[INDEX] ${name}`,
      displayName: name,
      kind: id === 'vash' ? 'bsrc' : id === 'root' ? 'root' : 'index',
      parentId,
      path: { ids, names: ids.map((x) => SPEC[x]![0]) },
    } as unknown as TreeNode);
  }
  return homeTreeOf(
    {
      node: (id) => nodes.get(id) ?? null,
      children: (id) => [...nodes.values()].filter((n) => n.parentId === id),
      indexes: () => [...nodes.values()].filter((n) => n.kind === 'index'),
      byDisplayName: (name) => [...nodes.values()].filter((n) => n.displayName === name),
    },
    owners,
    roles,
  );
}

function view(o: { territory: boolean; nation: boolean; bindNationSettlements?: boolean }): RoleView {
  const bindings = new Map<string, Map<string, string>>([
    [
      'zar',
      new Map([
        ['Polities', 'zpol'],
        ['Cultures', 'zcul'],
        ['Settlements & Locations', 'zset'],
      ]),
    ],
    [
      'can',
      new Map(
        o.bindNationSettlements === false ? [] : [['Settlements & Locations', 'cset'] as [string, string]],
      ),
    ],
  ]);
  const bound = new Map<string, { kind: 'territory' | 'nation'; owner: string; role: string }>();
  for (const [owner, m] of bindings)
    for (const [role, node] of m)
      bound.set(node, { kind: owner === 'zar' ? 'territory' : 'nation', owner, role });
  return {
    territorySeeded: o.territory,
    nationSeeded: o.nation,
    territories: new Map([['zar', { entryId: 'e-zar', name: 'Zarvia' }]]),
    nations: new Map([['can', { entryId: 'e-can', name: 'Kingdom of Cantha', shortName: 'Cantha' }]]),
    bound,
    bindings,
    roleForCategory: (c) => roleForCategory(tax, c),
  };
}

const nationSettlements: HomeRule = {
  kind: 'category',
  level: 'nation',
  category: 'Settlements & Locations',
};
const nationCultures: HomeRule = { kind: 'category', level: 'nation', category: 'Cultures' };
const nationLaws: HomeRule = { kind: 'category', level: 'nation', category: 'Laws' };
const continentCultures: HomeRule = { kind: 'category', level: 'continent', category: 'Cultures' };

describe('before the types are seeded: the name rules, unchanged', () => {
  it('a bare “Settlements & Locations” in a nation is not <Nation> <Category> by name; Cantha Institutions under a nation named otherwise is not either', () => {
    const t = tree(null);
    const n = (id: string) => t.node(id)!;
    expect(homeMatch(t, n('cset'), nationSettlements)).toBeNull();
    expect(
      homeMatch(t, n('cinst'), { kind: 'category', level: 'nation', category: 'Institutions' }),
    ).toBeNull();
    expect(homeMatch(t, n('zcul'), continentCultures)).toMatchObject({ level: 'name' });
    expect(isNation(t, n('can'))).toBe(true);
    expect(findNation(t, 'Cantha')).toBeNull();
  });
});

describe('once seeded: by role, with the level and why', () => {
  it('level 1: the nation’s bound role', () => {
    const t = tree(view({ territory: true, nation: true }));
    const m = homeMatch(t, t.node('cset')!, nationSettlements);
    expect(m).toMatchObject({ level: 'role' });
    expect(m!.why).toMatch(/Kingdom of Cantha’s Settlements & Locations/);
    expect(nationCategoryHome(t, t.node('can')!, 'Settlements & Locations')).toMatchObject({
      node: { id: 'cset' },
      level: 'role',
    });
  });

  it('level 2: the nation index, when no index is bound for the role (or the category is no role)', () => {
    const t = tree(view({ territory: true, nation: true, bindNationSettlements: false }));
    expect(homeMatch(t, t.node('can')!, nationSettlements)).toMatchObject({ level: 'nation' });
    expect(homeMatch(t, t.node('can')!, nationLaws)).toMatchObject({ level: 'nation' });
    expect(homeMatch(t, t.node('cset')!, nationSettlements)).toBeNull();
    // With the role bound, the nation index is not a home for it.
    const bound = tree(view({ territory: true, nation: true }));
    expect(homeMatch(bound, bound.node('can')!, nationSettlements)).toBeNull();
  });

  it('level 3: the territory’s bound category (a compact polity’s home)', () => {
    const t = tree(view({ territory: true, nation: true }));
    expect(homeMatch(t, t.node('zcul')!, nationCultures)).toMatchObject({ level: 'territory' });
    expect(nationCategoryHome(t, t.node('vash')!, 'Cultures')).toMatchObject({
      node: { id: 'zcul' },
      level: 'territory',
    });
  });

  it('a continent category by its binding; a nation by its entry and its short name', () => {
    const t = tree(view({ territory: true, nation: true }));
    expect(homeMatch(t, t.node('zcul')!, continentCultures)).toMatchObject({ level: 'role' });
    expect(homeMatch(t, t.node('zset')!, continentCultures)).toBeNull();
    expect(homeMatch(t, t.node('can')!, { kind: 'nation' })).toMatchObject({ level: 'role' });
    expect(findNation(t, 'Cantha')).toMatchObject({ kind: 'index', node: { id: 'can' } });
  });

  it('only Territory seeded: the nation rules stay by name', () => {
    const t = tree(view({ territory: true, nation: false }));
    expect(homeMatch(t, t.node('cset')!, nationSettlements)).toBeNull();
    expect(homeMatch(t, t.node('zcul')!, continentCultures)).toMatchObject({ level: 'role' });
    expect(isNation(t, t.node('can'))).toBe(true);
  });
});
