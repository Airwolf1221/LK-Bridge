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
}

export function homeTree(ctx: RepoCtx, owners: OwnersRules): HomeTree {
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

/** Whether an index is a `<Continent> Polities` index (the category that holds nations). */
export function isPolities(t: HomeTree, n: TreeNode | null): boolean {
  if (!n || n.kind !== 'index') return false;
  const want = ` ${k(t.owners.nations)}`;
  const name = k(n.displayName);
  return name.endsWith(want) && name.length > want.length;
}

/** Whether an index is a nation's own index: directly in a Polities index. */
export function isNation(t: HomeTree, n: TreeNode | null): boolean {
  if (!n || n.kind !== 'index' || !n.parentId) return false;
  return isPolities(t, t.node(n.parentId));
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

/** Whether a node of the tree is a home this rule allows. */
export function matchesHome(t: HomeTree, n: TreeNode, rule: HomeRule): boolean {
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
  const indexes = t.indexes().filter((n) => k(n.displayName) === want && isNation(t, n));
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
