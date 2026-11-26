/**
 * Where an owner page may live (v3 F3b, ADR 0052; the owner-approved design docs/design/F3b-owner-tools.md, sections
 * 1.1 to 1.3). Every home is recognised by the index's own name and place in the repository tree, never invented:
 *
 * - `<Continent> <Category>`: an index named so whose nearest ancestor index named `<Continent>` is not a nation
 *   (`Salahad Polities`, and `Salahad Conflicts` beneath `Salahad Historical Events`);
 * - `<Nation> <Category>`: the same beneath a nation index (`Menkhet Institutions`);
 * - `<worldPrefix> <Category>`: a world-level category (`Arkonan Cultures`);
 * - a nation index: an index directly in a `<Continent> Polities` index (`Al-Tibr`);
 * - a named index, an index under a named one, one index by id (the Bestiary), and the race roster's own pages.
 *
 * It also finds a nation (its index, or the compact Reference that is all it has), resolves a home given as a path, and
 * ranks the suitable homes nearest a refused one. Reads nothing: the repository tree only.
 */
import { cleanPrefixes } from '../../registry/names.js';
import type { RepoCtx } from '../../mcp/tools/repo.js';
import { nameKey, type TreeNode } from '../../tree/index.js';
import type { HomeRule, OwnerKind, OwnerKindName, OwnersRules } from '../types.js';

/**
 * v3 F6c (ADR 0080; design T4, C5): the registry's structural entries and role bindings, as placement reads them. Once
 * the Territory type is seeded, `<Continent> <Category>` and the Polities that hold nations are its entries' bound
 * roles; once the Nation type is seeded, a nation is a Nation entry and `<Nation> <Category>` its bound role (by the
 * binding, so a short name such as Cantha needs no ancestor of that name). While a type is not seeded the name rules
 * below stay in force, unchanged.
 */
export interface RoleView {
  readonly territorySeeded: boolean;
  readonly nationSeeded: boolean;
  /** Territory entries by their index's id. */
  readonly territories: ReadonlyMap<string, { readonly entryId: string; readonly name: string }>;
  /** Nation entries by their index's id. */
  readonly nations: ReadonlyMap<
    string,
    { readonly entryId: string; readonly name: string; readonly shortName: string | null }
  >;
  /** Every bound node: whose role it is (`owner` the territory's or the nation's index). */
  readonly bound: ReadonlyMap<
    string,
    { readonly kind: 'territory' | 'nation'; readonly owner: string; readonly role: string }
  >;
  /** An entry's index → role → bound node. */
  readonly bindings: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The nation role a nation-level category names (C2's matching), or null. */
  roleForCategory(category: string): string | null;
}

/** The tree as the owner planner reads it, with every lookup cached for the call. */
export interface HomeTree {
  node(id: string): TreeNode | null;
  children(id: string): TreeNode[];
  /** Every index of the project. */
  indexes(): TreeNode[];
  /** The race roster's root page (Races of Arkona), by id, else by name; null when the project has none. */
  racesRoot(): TreeNode | null;
  readonly owners: OwnersRules;
  /** The Species type's kinds (the race roster's name patterns). */
  readonly kinds: Partial<Record<OwnerKindName, OwnerKind>>;
  /** v3 F6c: the registry's roles (absent, or a type not seeded: the name rules). */
  readonly roles?: RoleView | null;
}

/** v3 F6c: a home tree over any source of nodes (the snapshots' model, for the audits). */
export function homeTreeOf(
  src: {
    node(id: string): TreeNode | null;
    children(id: string): TreeNode[];
    indexes(): TreeNode[];
    byDisplayName(name: string): TreeNode[];
  },
  owners: OwnersRules,
  roles?: RoleView | null,
): HomeTree {
  const nodes = new Map<string, TreeNode | null>();
  const kids = new Map<string, TreeNode[]>();
  let all: TreeNode[] | null = null;
  let roster: TreeNode | null | undefined;
  const node = (id: string): TreeNode | null => {
    if (!nodes.has(id)) nodes.set(id, src.node(id));
    return nodes.get(id)!;
  };
  return {
    owners,
    kinds: owners.types.find((t) => t.kinds)?.kinds ?? {},
    roles: roles ?? null,
    node,
    children(id) {
      if (!kids.has(id)) kids.set(id, src.children(id));
      return kids.get(id)!;
    },
    indexes() {
      all ??= src.indexes();
      return all;
    },
    racesRoot() {
      if (roster !== undefined) return roster;
      const byId = node(owners.races.root.id);
      if (byId) return (roster = byId);
      const hits = src.byDisplayName(owners.races.root.name).filter((n) => n.kind === 'bsrc');
      return (roster = hits.length === 1 ? hits[0]! : null);
    },
  };
}

export function homeTree(ctx: RepoCtx, owners: OwnersRules, roles?: RoleView | null): HomeTree {
  const nodes = new Map<string, TreeNode | null>();
  const kids = new Map<string, TreeNode[]>();
  let all: TreeNode[] | null = null;
  let roster: TreeNode | null | undefined;
  const node = (id: string): TreeNode | null => {
    if (!nodes.has(id)) nodes.set(id, ctx.tree.node(ctx.projectId, id).data);
    return nodes.get(id)!;
  };
  const kinds = owners.types.find((t) => t.kinds)?.kinds ?? {};
  return {
    owners,
    kinds,
    roles: roles ?? null,
    node,
    children(id) {
      if (!kids.has(id)) kids.set(id, ctx.tree.children(ctx.projectId, id).data);
      return kids.get(id)!;
    },
    indexes() {
      all ??= ctx.tree.byKind(ctx.projectId, 'index').data;
      return all;
    },
    racesRoot() {
      if (roster !== undefined) return roster;
      const byId = node(owners.races.root.id);
      if (byId) return (roster = byId);
      const hits = ctx.tree
        .findByDisplayName(ctx.projectId, owners.races.root.name)
        .data.map((m) => m.node)
        .filter((n) => n.kind === 'bsrc');
      return (roster = hits.length === 1 ? hits[0]! : null);
    },
  };
}

const k = (s: string) => nameKey(cleanPrefixes(s).name.replace(/\s+/g, ' ').trim());

/** The suffix of a name pattern after `{Name}` (`{Name} - Core Information` → ` - Core Information`). */
const suffixOf = (pattern: string) => pattern.replace(/^\{Name\}/, '');

/**
 * Whether an index is a `<Continent> Polities` index (the category that holds nations). v3 F6c: once the Territory type
 * is seeded, the node bound as a territory's Polities role.
 */
export function isPolities(t: HomeTree, n: TreeNode | null): boolean {
  if (!n || n.kind !== 'index') return false;
  if (t.roles?.territorySeeded) {
    const b = t.roles.bound.get(n.id);
    return b?.kind === 'territory' && k(b.role) === k(t.owners.nations);
  }
  const want = ` ${k(t.owners.nations)}`;
  const name = k(n.displayName);
  return name.endsWith(want) && name.length > want.length;
}

/**
 * Whether an index is a nation's own index: directly in a Polities index. v3 F6c: once the Nation type is seeded, a
 * Nation entry's index.
 */
export function isNation(t: HomeTree, n: TreeNode | null): boolean {
  if (!n || n.kind !== 'index') return false;
  if (t.roles?.nationSeeded) return t.roles.nations.has(n.id);
  if (!n.parentId) return false;
  return isPolities(t, t.node(n.parentId));
}

/** v3 F6c (ADR 0080, T4): which level of placement a home was found at, and why. */
export type HomeLevel = 'role' | 'nation' | 'territory' | 'name';
export interface HomeMatch {
  readonly rule: HomeRule;
  readonly level: HomeLevel;
  readonly why: string;
}

/**
 * Whether a node is a home the rule allows, and at which level (v3 F6c, C5):
 *
 * - `<Continent> <Category>` once the Territory type is seeded: a territory's bound role of that category;
 * - `<Nation> <Category>` once the Nation type is seeded, T4's three governed levels: the nation's bound role (`role`);
 *   else the nation index itself, when the nation has no index bound for that role (`nation`); else the territory's bound
 *   category of the same name (`territory`);
 * - `nation` once the Nation type is seeded: a Nation entry's index;
 * - everything else, and every rule while its type is not seeded: the name rules (`name`).
 */
export function homeMatch(t: HomeTree, n: TreeNode, rule: HomeRule): HomeMatch | null {
  const r = t.roles;
  if (rule.kind === 'category' && rule.level === 'continent' && r?.territorySeeded) {
    const b = r.bound.get(n.id);
    if (b?.kind === 'territory' && k(b.role) === k(rule.category))
      return {
        rule,
        level: 'role',
        why: `bound as ${t.node(b.owner)?.displayName ?? b.owner}’s ${b.role} (the registry’s Territory roles)`,
      };
    return null;
  }
  if (rule.kind === 'category' && rule.level === 'nation' && r?.nationSeeded) {
    const role = r.roleForCategory(rule.category);
    const b = r.bound.get(n.id);
    if (role && b?.kind === 'nation' && k(b.role) === k(role))
      return {
        rule,
        level: 'role',
        why: `bound as ${t.node(b.owner)?.displayName ?? b.owner}’s ${b.role} (the nation’s bound role)`,
      };
    const nat = r.nations.get(n.id);
    if (nat && (!role || !r.bindings.get(n.id)?.has(role)))
      return {
        rule,
        level: 'nation',
        why: role
          ? `${nat.name} has no ${role} subindex bound, so the nation index itself is the home (T4’s second level)`
          : `“${rule.category}” is not one of a nation’s roles, so the nation index itself is the home (T4’s second level)`,
      };
    if (b?.kind === 'territory' && k(b.role) === k(rule.category))
      return {
        rule,
        level: 'territory',
        why: `bound as ${t.node(b.owner)?.displayName ?? b.owner}’s ${b.role} (T4’s third level: the territory’s bound category)`,
      };
    return null;
  }
  if (rule.kind === 'nation' && r?.nationSeeded)
    return isNation(t, n) ? { rule, level: 'role', why: 'a Nation entry’s index (the registry)' } : null;
  return matchesHomeByName(t, n, rule)
    ? { rule, level: 'name', why: 'recognised by its name and place (the registry’s type is not seeded)' }
    : null;
}

/** The first rule of `rules` a node fits, with its level, or null. */
export function homeMatchAmong(t: HomeTree, n: TreeNode, rules: readonly HomeRule[]): HomeMatch | null {
  for (const rule of rules) {
    const m = homeMatch(t, n, rule);
    if (m) return m;
  }
  return null;
}

/**
 * v3 F6c (T4): where a nation-level category of ONE nation goes: the nation's bound role; else the nation index; else
 * (a nation with no index, only its Reference in its territory's Polities) the territory's bound category. Null when
 * the Nation type is not seeded, or nothing fits.
 */
export function nationCategoryHome(
  t: HomeTree,
  nation: TreeNode,
  category: string,
): { readonly node: TreeNode; readonly level: HomeLevel; readonly why: string } | null {
  const r = t.roles;
  if (!r?.nationSeeded) return null;
  const role = r.roleForCategory(category);
  const nat = r.nations.get(nation.id);
  if (nat) {
    const bound = role ? r.bindings.get(nation.id)?.get(role) : undefined;
    const node = bound ? t.node(bound) : null;
    if (node) return { node, level: 'role', why: `${nat.name}’s bound ${role} subindex` };
    return {
      node: nation,
      level: 'nation',
      why: role ? `${nat.name} has no ${role} subindex bound` : `“${category}” is not a nation role`,
    };
  }
  // A compact polity (its Reference in a Polities index): the territory's bound category.
  const polities = nation.parentId ? t.node(nation.parentId) : null;
  const terr = polities ? r.bound.get(polities.id) : undefined;
  if (terr?.kind !== 'territory') return null;
  const cat = r.bindings.get(terr.owner);
  for (const [c, id] of cat ?? [])
    if (k(c) === k(category)) {
      const node = t.node(id);
      if (node)
        return {
          node,
          level: 'territory',
          why: `${nation.displayName} has no index of its own: its territory’s bound ${c}`,
        };
    }
  return null;
}

/** `<Prefix> <category>` read from an index's name, or null when the name does not end with the category. */
function prefixOf(n: TreeNode, category: string): string | null {
  const name = n.displayName.replace(/\s+/g, ' ').trim();
  const c = ` ${category}`;
  if (name.length <= c.length || !nameKey(name).endsWith(nameKey(c))) return null;
  return name.slice(0, name.length - c.length).trim() || null;
}

/** The nearest ancestor index named exactly `name` (the continent or nation a category index belongs to). */
function ancestorNamed(t: HomeTree, n: TreeNode, name: string): TreeNode | null {
  const ids = n.path.ids;
  for (let i = ids.length - 2; i >= 0; i--) {
    const a = t.node(ids[i]!);
    if (a && a.kind === 'index' && k(a.displayName) === k(name)) return a;
  }
  return null;
}

/** The level (`continent` or `nation`) and owner of a `<Prefix> <category>` index, or null when it is neither. */
export function categoryLevel(
  t: HomeTree,
  n: TreeNode,
  category: string,
): { level: 'continent' | 'nation' | 'world'; owner: string } | null {
  if (n.kind !== 'index') return null;
  const p = prefixOf(n, category);
  if (!p) return null;
  if (k(p) === k(t.owners.worldPrefix)) return { level: 'world', owner: p };
  const a = ancestorNamed(t, n, p);
  if (!a) return null;
  return { level: isNation(t, a) ? 'nation' : 'continent', owner: a.displayName };
}

/** Whether a node of the tree is a home this rule allows (v3 F6c: by role once the type is seeded; `homeMatch`). */
export function matchesHome(t: HomeTree, n: TreeNode, rule: HomeRule): boolean {
  return homeMatch(t, n, rule) !== null;
}

/** The name rules (F3b), as they were before F6c: in force while the registry's type is not seeded. */
function matchesHomeByName(t: HomeTree, n: TreeNode, rule: HomeRule): boolean {
  switch (rule.kind) {
    case 'category': {
      const c = categoryLevel(t, n, rule.category);
      return c !== null && c.level === rule.level;
    }
    case 'nation':
      return isNation(t, n);
    case 'named':
      return n.kind === 'index' && k(n.displayName) === k(rule.name);
    case 'under': {
      if (n.kind !== 'index' || !n.parentId) return false;
      const p = t.node(n.parentId);
      return p !== null && p.kind === 'index' && k(p.displayName) === k(rule.parent);
    }
    case 'index': {
      const byId = t.node(rule.id);
      if (byId) return n.id === byId.id;
      return n.kind === 'index' && k(n.displayName) === k(rule.name);
    }
    case 'races': {
      const root = t.racesRoot();
      if (!root) return false;
      if (rule.as === 'root') return n.id === root.id;
      if (n.kind !== 'bsrc' || !n.parentId) return false;
      const group = t.kinds.racialGroup;
      const race = t.kinds.race;
      const isGroup = (x: TreeNode) =>
        x.kind === 'bsrc' &&
        x.parentId === root.id &&
        group !== undefined &&
        (k(x.displayName).endsWith(k(suffixOf(group.name))) ||
          (group.referenceType !== null && k(x.referenceType ?? '') === k(group.referenceType)));
      if (rule.as === 'group') return isGroup(n);
      const parent = t.node(n.parentId);
      const placed = n.parentId === root.id || (parent !== null && isGroup(parent));
      return (
        placed &&
        race !== undefined &&
        (k(n.displayName).endsWith(k(suffixOf(race.name))) ||
          (race.referenceType !== null && k(n.referenceType ?? '') === k(race.referenceType)))
      );
    }
  }
}

/** A home rule in words, for refusals and the preview. */
export function describeHome(t: Pick<HomeTree, 'owners' | 'kinds'>, rule: HomeRule): string {
  switch (rule.kind) {
    case 'category':
      return rule.level === 'world'
        ? `${t.owners.worldPrefix} ${rule.category}`
        : `<${rule.level === 'continent' ? 'Continent' : 'Nation'}> ${rule.category}`;
    case 'nation':
      return `a nation index (directly in a <Continent> ${t.owners.nations} index)`;
    case 'named':
      return rule.name;
    case 'under':
      return rule.label;
    case 'index':
      return `[INDEX] ${rule.name}`;
    case 'races':
      return rule.as === 'root'
        ? t.owners.races.root.name
        : rule.as === 'group'
          ? `a racial group's ${(t.kinds.racialGroup?.name ?? '{Name} - Racial Group Reference').replace('{Name}', '<Group>')} (in ${t.owners.races.root.name})`
          : `a race's ${(t.kinds.race?.name ?? '{Name} - Core Information').replace('{Name}', '<Race>')}`;
  }
}

/** Steps between two nodes of the tree (through their nearest common ancestor). */
function distance(a: TreeNode | null, b: TreeNode): number {
  if (!a) return b.path.ids.length;
  const x = a.path.ids;
  const y = b.path.ids;
  let c = 0;
  while (c < x.length && c < y.length && x[c] === y[c]) c++;
  return x.length - c + (y.length - c);
}

export interface HomeSuggestion {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** Which allowed home it is. */
  readonly fits: string;
}

/** The suitable homes nearest `from` (or the root), at most `limit`, closest first. */
export function suggestHomes(
  t: HomeTree,
  rules: readonly HomeRule[],
  from: TreeNode | null,
  limit = 5,
): HomeSuggestion[] {
  const candidates: TreeNode[] = [...t.indexes()];
  if (rules.some((r) => r.kind === 'races')) {
    const root = t.racesRoot();
    if (root) {
      candidates.push(root);
      for (const c of t.children(root.id)) {
        candidates.push(c);
        if (c.kind === 'bsrc') candidates.push(...t.children(c.id));
      }
    }
  }
  const seen = new Set<string>();
  const hits: { n: TreeNode; fits: string; d: number }[] = [];
  for (const n of candidates) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const rule = rules.find((r) => matchesHome(t, n, r));
    if (rule) hits.push({ n, fits: describeHome(t, rule), d: distance(from, n) });
  }
  hits.sort((a, b) => a.d - b.d || a.n.path.names.join('/').localeCompare(b.n.path.names.join('/')));
  return hits.slice(0, limit).map((h) => ({
    id: h.n.id,
    name: h.n.rawName,
    path: h.n.path.names.join(' / '),
    fits: h.fits,
  }));
}

export type NationLookup =
  | { readonly kind: 'index'; readonly node: TreeNode }
  | { readonly kind: 'reference'; readonly node: TreeNode; readonly polities: TreeNode }
  | { readonly kind: 'ambiguous'; readonly nodes: readonly TreeNode[] }
  | null;

/**
 * A nation by its name (design 1.3): its own index (a nation index of that name), else the compact Reference that is
 * all it has (a `[BSRC] <Nation> - …` page directly in a Polities index).
 */
export function findNation(t: HomeTree, name: string): NationLookup {
  const want = k(name);
  // v3 F6c: once the Nation type is seeded, a Nation entry by its index's name or its short name.
  const short = t.roles?.nationSeeded
    ? [...t.roles.nations.entries()].filter(([, e]) => e.shortName !== null && k(e.shortName) === want)
    : [];
  const indexes = [
    ...t.indexes().filter((n) => k(n.displayName) === want && isNation(t, n)),
    ...short.map(([id]) => t.node(id)).filter((n): n is TreeNode => n !== null),
  ].filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i);
  if (indexes.length === 1) return { kind: 'index', node: indexes[0]! };
  if (indexes.length > 1) return { kind: 'ambiguous', nodes: indexes };
  const refs: { node: TreeNode; polities: TreeNode }[] = [];
  for (const p of t.indexes().filter((n) => isPolities(t, n)))
    for (const c of t.children(p.id))
      if (c.kind === 'bsrc' && k(c.displayName).startsWith(`${want} - `)) refs.push({ node: c, polities: p });
  if (refs.length === 1) return { kind: 'reference', ...refs[0]! };
  if (refs.length > 1) return { kind: 'ambiguous', nodes: refs.map((r) => r.node) };
  return null;
}

/** The nation an index belongs to: itself, or the nearest nation index above it; null for none. */
export function nationOf(t: HomeTree, n: TreeNode): TreeNode | null {
  if (isNation(t, n)) return n;
  const ids = n.path.ids;
  for (let i = ids.length - 2; i >= 0; i--) {
    const a = t.node(ids[i]!);
    if (a && isNation(t, a)) return a;
  }
  return null;
}

/**
 * A home given as a path (`Salahad / Salahad Polities`): the nodes whose path ends with these names. Null when the
 * text is not a path.
 */
export function nodesByPath(ctx: RepoCtx, path: string): TreeNode[] | null {
  if (!path.includes('/')) return null;
  const parts = path
    .split('/')
    .map((s) => k(s))
    .filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  const hits = ctx.tree
    .findByDisplayName(ctx.projectId, cleanPrefixes(path.split('/').pop()!).name.trim())
    .data.map((m) => m.node);
  return hits.filter((n) => {
    const names = n.path.names.map((x) => k(x));
    if (names[names.length - 1] !== last) return false;
    const tail = names.slice(-parts.length);
    return tail.length === parts.length && tail.every((x, i) => x === parts[i]);
  });
}
