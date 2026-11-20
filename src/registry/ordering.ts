/**
 * Sibling order (v2 A3, PLAN-v2 4.5): `[INDEX]` pages first, then `[BSRC]` (with `[BWRK]` and `[BARC]`, v2 C2c), then
 * unclassified ones; alphabetical
 * within each group by display name, with `Intl.Collator('en', { sensitivity: 'base', numeric: true })` (case and
 * accents ignored, numbers by value). Pure functions, plus the tree-backed `placementFor` and `outOfOrder`. Nothing
 * here moves anything: it only says where a page belongs.
 */
import type { NodeKind, TreeNode } from '../tree/index.js';
import type { ProjectTree } from './tree-view.js';
import { RegistryError, type NodeRef, type ResolveKind, type Slot } from './types.js';

export const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

// v2 C2c: `[BWRK]` and `[BARC]` pages sort with `[BSRC]` ones (name handling treats them alike): by display name.
const GROUP: Readonly<Record<NodeKind, number>> = {
  index: 0,
  bsrc: 1,
  bwrk: 1,
  barc: 1,
  unclassified: 2,
  root: 3,
};

/** A sibling comparator: negative when `a` belongs before `b`. */
export type SiblingCompare = (
  a: Pick<Orderable, 'displayName' | 'kind'>,
  b: Pick<Orderable, 'displayName' | 'kind'>,
) => number;

export interface Orderable {
  readonly id: string;
  readonly displayName: string;
  readonly kind: NodeKind;
}

/** Negative when `a` belongs before `b`, 0 when the rule does not tell them apart. */
export function compareSiblings(
  a: Pick<Orderable, 'displayName' | 'kind'>,
  b: Pick<Orderable, 'displayName' | 'kind'>,
): number {
  return GROUP[a.kind] - GROUP[b.kind] || COLLATOR.compare(a.displayName, b.displayName);
}

/**
 * Where a new page goes among `siblings` (in their current order): right after the last sibling that belongs before
 * it or ties with it (by the rule, not by position), else right before the first that belongs after it, else nowhere
 * in particular (an empty parent). So the new page always lands next to its correct alphabetical neighbour, even when
 * other siblings are out of order.
 */
export function slotAmong(
  siblings: readonly Orderable[],
  displayName: string,
  kind: ResolveKind,
  /** v3 F4c (ADR 0065): the order of this parent (Narratives' own, E1); default the ordinary rule. */
  compare: SiblingCompare = compareSiblings,
): Slot {
  const me = { displayName, kind };
  let after: Orderable | null = null;
  let before: Orderable | null = null;
  for (const s of siblings) {
    const c = compare(s, me);
    if (c <= 0) {
      // The greatest sibling at or below the new page; among equals, the latest in the current order.
      if (after === null || compare(s, after) >= 0) after = s;
    } else if (before === null || compare(s, before) < 0) {
      before = s;
    }
  }
  if (after) return { after: after.id };
  if (before) return { before: before.id };
  return {};
}

export interface OutOfOrderSibling {
  readonly node: Orderable;
  /** Where it belongs: after this sibling, or first (null). */
  readonly belongsAfter: Orderable | null;
}

/**
 * The siblings that break the rule: those outside a longest run already in order (a longest non-decreasing
 * subsequence), so the list is the fewest pages that would have to move. Each with the sibling it belongs after.
 */
export function outOfOrderAmong(
  siblings: readonly Orderable[],
  compare: SiblingCompare = compareSiblings,
): OutOfOrderSibling[] {
  const n = siblings.length;
  if (n < 2) return [];
  // Longest non-decreasing subsequence, O(n log n), keeping predecessors.
  const tails: number[] = [];
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(siblings[tails[mid]!]!, siblings[i]!) <= 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1)!; i >= 0; i = prev[i]!) keep.add(i);
  const sorted = siblings.map((s, i) => ({ s, i })).sort((a, b) => compare(a.s, b.s) || a.i - b.i);
  const out: OutOfOrderSibling[] = [];
  sorted.forEach(({ s, i }, at) => {
    if (keep.has(i)) return;
    out.push({ node: s, belongsAfter: at === 0 ? null : sorted[at - 1]!.s });
  });
  return out.sort((a, b) => siblings.indexOf(a.node) - siblings.indexOf(b.node));
}

/**
 * The `after` / `before` neighbour for a page named `newDisplayName` of `kind` under `parentId`, for createResource,
 * createResourceFromTemplate and moveResource (one write, no extra request). `excludeId`: the page being moved or
 * renamed, left out of its own siblings.
 */
export function placementFor(
  tree: ProjectTree,
  parentId: string,
  newDisplayName: string,
  kind: ResolveKind,
  o: { excludeId?: string; compare?: SiblingCompare | null } = {},
): Slot {
  tree.requireUsable();
  if (!tree.node(parentId)) {
    throw new RegistryError('NOT_IN_TREE', `The parent ${parentId} is not in the repository tree.`, {
      parentId,
    });
  }
  const name = newDisplayName.trim();
  if (name === '') throw new RegistryError('INVALID_INPUT', 'A display name is required.');
  const siblings = tree.children(parentId).filter((c) => c.id !== o.excludeId);
  return slotAmong(siblings, name, kind, o.compare ?? compareSiblings);
}

export interface OutOfOrderParent {
  readonly parent: NodeRef;
  readonly siblings: number;
  readonly outOfOrder: readonly { readonly node: NodeRef; readonly belongsAfter: NodeRef | null }[];
}

/** Siblings that break the rule under one parent, or under every parent of the tree. Reports only; moves nothing. */
export function outOfOrder(
  tree: ProjectTree,
  parentId?: string,
  limit = 500,
  /** v3 F4c: a parent's own order (Narratives'), or null for the ordinary rule. */
  orderFor: (parentId: string) => SiblingCompare | null = () => null,
): OutOfOrderParent[] {
  tree.requireUsable();
  const parents: TreeNode[] = [];
  if (parentId !== undefined) {
    const p = tree.node(parentId);
    if (!p)
      throw new RegistryError('NOT_IN_TREE', `${parentId} is not in the repository tree.`, { parentId });
    parents.push(p);
  } else {
    const root = tree.root();
    if (root) for (const e of tree.subtree(root.id)) parents.push(e.node);
  }
  const out: OutOfOrderParent[] = [];
  for (const p of parents) {
    const kids = tree.children(p.id);
    if (kids.length < 2) continue;
    const bad = outOfOrderAmong(kids, orderFor(p.id) ?? compareSiblings);
    if (bad.length === 0) continue;
    out.push({
      parent: tree.ref(p),
      siblings: kids.length,
      outOfOrder: bad.map((b) => ({
        node: tree.ref(b.node as TreeNode),
        belongsAfter: b.belongsAfter ? tree.ref(b.belongsAfter as TreeNode) : null,
      })),
    });
    if (out.length >= limit) break;
  }
  return out;
}
