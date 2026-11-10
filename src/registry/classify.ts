/**
 * Walks a type's root in the repository tree and tells its indexes apart (v2 A3): taxonomy categories (groups, races,
 * subraces…), character indexes (which are not categories), and the reserved unknown-race index. Seeding, "add
 * missing" and the drift report all use this one walk, so they always agree. Pure over the tree; no request.
 */
import type { TreeNode } from '../tree/index.js';
import { key, subjectOf } from './names.js';
import type { ProjectTree } from './tree-view.js';
import type { RegistryType, ReviewReason } from './types.js';

export interface CategoryCandidate {
  readonly node: TreeNode;
  /** The nearest ancestor that is a category (its node id), or null when none is between it and the type root. */
  readonly parentNodeId: string | null;
  /** 1 for the type root's children. */
  readonly relativeDepth: number;
  /** Why the walk could not be sure (empty when it was). */
  readonly reasons: readonly ReviewReason[];
}

export interface CharacterIndex {
  readonly node: TreeNode;
  /** The page that makes it one: a Core or Compact page about the index's own name. */
  readonly page: { readonly id: string; readonly displayName: string; readonly referenceType: string };
  /** Indexes directly under it (not walked: a character index holds no categories). */
  readonly childIndexes: number;
}

export interface Classification {
  readonly root: TreeNode | null;
  readonly categories: readonly CategoryCandidate[];
  readonly characterIndexes: readonly CharacterIndex[];
  /** The unknown-race index(es) directly under the root (character types only); exactly one is expected. */
  readonly reserved: readonly TreeNode[];
  /** Indexes inside character indexes, not walked. */
  readonly skipped: number;
  /** Things the owner should know that are not about one category. */
  readonly warnings: readonly string[];
}

const reason = (code: string, message: string): ReviewReason => ({ code, message });

/** The deepest relative level the character race search reaches (the root's children and grandchildren). */
export const RACE_SEARCH_DEPTH = 2;

/**
 * Whether `index` is a character index: it DIRECTLY contains a `[BSRC]` page whose Reference Type is one of the
 * character page types and whose subject (its Subject row, or its display name before " - ") equals the index's
 * display name. Returns that page, or null.
 */
export function characterPageOf(
  tree: ProjectTree,
  index: TreeNode,
  children: readonly TreeNode[],
  type: RegistryType,
): CharacterIndex['page'] | null {
  const p = type.placement;
  if (!p) return null;
  const kinds = new Set([key(p.referenceTypes.core), key(p.referenceTypes.compact)]);
  const want = key(index.displayName);
  for (const c of children) {
    if (c.kind !== 'bsrc' || c.referenceType === null || !kinds.has(key(c.referenceType))) continue;
    if (key(subjectOf(c.displayName, tree.rowValue(c.id, p.subjectRow))) === want) {
      return { id: c.id, displayName: c.displayName, referenceType: c.referenceType };
    }
  }
  return null;
}

export function classifyType(tree: ProjectTree, type: RegistryType): Classification {
  const root = type.rootIndexId ? tree.node(type.rootIndexId) : null;
  if (!root)
    return { root: null, categories: [], characterIndexes: [], reserved: [], skipped: 0, warnings: [] };
  const entries = tree.subtree(root.id);
  const childrenOf = new Map<string, TreeNode[]>();
  for (const e of entries) {
    const pid = e.node.parentId;
    if (pid === null) continue;
    const l = childrenOf.get(pid) ?? [];
    l.push(e.node);
    childrenOf.set(pid, l);
  }
  tree.preload(entries.filter((e) => e.node.kind === 'bsrc').map((e) => e.node.id));
  const isCharacterType = type.placementKind === 'character' && type.placement !== null;
  const unknownKey = type.placement ? key(type.placement.unknownIndexName) : null;

  const categories: CategoryCandidate[] = [];
  const characterIndexes: CharacterIndex[] = [];
  const reserved: TreeNode[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  const walk = (parent: TreeNode, parentCategory: string | null, depth: number, underUnknown: boolean) => {
    for (const n of childrenOf.get(parent.id) ?? []) {
      if (n.kind !== 'index') continue;
      const kids = childrenOf.get(n.id) ?? [];
      if (isCharacterType && depth === 1 && unknownKey !== null && key(n.displayName) === unknownKey) {
        reserved.push(n);
        walk(n, null, depth + 1, true);
        continue;
      }
      const page = isCharacterType ? characterPageOf(tree, n, kids, type) : null;
      if (page) {
        const childIndexes = kids.filter((k) => k.kind === 'index').length;
        characterIndexes.push({ node: n, page, childIndexes });
        if (childIndexes > 0) {
          warnings.push(
            `“${n.path.names.join(' / ')}” is a character index with ${childIndexes} ${childIndexes === 1 ? 'index' : 'indexes'} under it; they were not treated as categories.`,
          );
        }
        skipped += countIndexes(n.id, childrenOf);
        continue;
      }
      const reasons: ReviewReason[] = [];
      if (isCharacterType && depth > RACE_SEARCH_DEPTH) {
        reasons.push(
          reason(
            'deep',
            `It is ${depth} levels below the type root; the race search reaches only the root's children and grandchildren (Group / Race), so placement cannot use it as a race.`,
          ),
        );
      }
      if (n.propertiesPending || kids.some((k) => k.kind === 'bsrc' && k.propertiesPending)) {
        reasons.push(
          reason(
            'unread',
            "The properties of it or of pages directly under it have not been read yet, so it cannot be told apart from a character index. The tree's next check reads them.",
          ),
        );
      }
      if (kids.length === 0) {
        reasons.push(
          reason('empty', 'It is empty: it may be a character index whose Core page has not been made yet.'),
        );
      }
      if (underUnknown) {
        reasons.push(
          reason(
            'under_unknown',
            `It is under “${type.placement!.unknownIndexName}”, which holds characters of unknown race.`,
          ),
        );
      }
      categories.push({ node: n, parentNodeId: parentCategory, relativeDepth: depth, reasons });
      walk(n, n.id, depth + 1, underUnknown);
    }
  };
  walk(root, null, 1, false);

  if (isCharacterType && reserved.length > 1) {
    warnings.push(
      `There are ${reserved.length} “${type.placement?.unknownIndexName ?? ''}” indexes directly under the type root; exactly one is expected, so unknown races cannot be placed.`,
    );
  }
  // The same display name twice is ambiguous for every lookup by name.
  const byName = new Map<string, CategoryCandidate[]>();
  for (const c of categories) {
    const k = key(c.node.displayName);
    byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  const out = categories.map((c) => {
    const same = byName.get(key(c.node.displayName))!;
    if (same.length < 2) return c;
    const others = same.filter((o) => o !== c).map((o) => o.node.path.names.join(' / '));
    return {
      ...c,
      reasons: [
        ...c.reasons,
        reason(
          'duplicate_name',
          `Another index under the type root has the same name: ${others.join('; ')}.`,
        ),
      ],
    };
  });
  return { root, categories: out, characterIndexes, reserved, skipped, warnings };
}

function countIndexes(id: string, childrenOf: ReadonlyMap<string, TreeNode[]>): number {
  let n = 0;
  for (const c of childrenOf.get(id) ?? []) {
    if (c.kind === 'index') n += 1 + countIndexes(c.id, childrenOf);
    else n += countIndexes(c.id, childrenOf);
  }
  return n;
}
