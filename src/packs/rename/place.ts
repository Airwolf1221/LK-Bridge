/**
 * CR-2026-11-R3 (R3-56): a rename's re-placing moves, in sequence (ADR 0058 decision 1.8, as amended).
 *
 * A rename writes its page names one at a time, each followed by that page's re-placing move. So each move follows the
 * names actually written by then: once renamed, the page belongs among its SETTLED siblings, those whose names are
 * final (a page the rename does not touch, one whose rename the owner left out, and one this job has renamed already),
 * after the last of them its new name sorts after (or with) and before the first it sorts before. A sibling the job
 * renames later is not anchored on: its name is still to change. The page moves only when it stands outside that place;
 * then it goes right beside that neighbour. So the settled pages stay in order with each rename, and when the pages the
 * rename does not touch are in order among themselves, the parent ends in order; a whole set already in order moves
 * none of its pages.
 *
 * Worked out on the parent's children as the plan read them (the repository tree: no request), the job's renames under
 * that parent replayed in the job's order. The planner works out the whole selection's moves with it; each move works
 * out its own again inside its lock when the job runs, from the renames the owner approved (the item filter trims
 * `renames` to the approved items, src/jobs/items.ts), so a name left out is never taken as written.
 * "Propose these again": the renames the approved part wrote are `done`, replayed first as that part's job made them.
 */
import { compareSiblings, type SiblingCompare } from '../../registry/ordering.js';
import type { Slot } from '../../registry/types.js';
import type { NodeKind } from '../../tree/types.js';

/** One child of the parent, as the plan read it (in position order). */
export interface PlaceSibling {
  readonly id: string;
  /** Its display name (no prefix). */
  readonly name: string;
  readonly kind: NodeKind;
}

/** One rename of a child of the parent, in the job's order. */
export interface PlaceRename {
  readonly id: string;
  /** Its new display name. */
  readonly to: string;
  /** The item that renames it (the owner may leave it out). */
  readonly item: string;
  /** "Propose these again": written already, by the approved part (replayed before the rest). */
  readonly done?: boolean;
}

export interface Placement {
  /**
   * Where the page goes, beside one settled sibling; when it does not move, beside its neighbour where it stands (a body
   * that, sent, leaves it there; `{}` only for a page with no sibling).
   */
  readonly slot: Slot;
  /** Whether it stands outside its place (a move is sent only then). */
  readonly moves: boolean;
}

interface Node {
  readonly id: string;
  readonly displayName: string;
  readonly kind: NodeKind;
}

/** Each renamed page's place, the renames replayed in sequence (the `done` ones first, as their own job made them). */
export function placeInSequence(
  siblings: readonly PlaceSibling[],
  renames: readonly PlaceRename[],
  compare: SiblingCompare = compareSiblings,
): Map<string, Placement> {
  const list: Node[] = siblings.map((s) => ({ id: s.id, displayName: s.name, kind: s.kind }));
  const out = new Map<string, Placement>();
  for (const phase of [renames.filter((x) => x.done === true), renames.filter((x) => x.done !== true)]) {
    // The pages of this phase still to be renamed: not settled, never anchored on.
    const later = new Set(phase.map((x) => x.id));
    for (const r of phase) {
      later.delete(r.id);
      const at = list.findIndex((x) => x.id === r.id);
      if (at < 0) continue;
      const me: Node = { ...list[at]!, displayName: r.to };
      list[at] = me;
      // Its neighbours by the rule among the settled siblings (as A3's slotAmong chooses them): the last that sorts
      // before it or with it, and the first that sorts after it.
      let after: Node | null = null;
      let before: Node | null = null;
      for (const s of list) {
        if (s === me || later.has(s.id)) continue;
        const c = compare(s, me);
        if (c <= 0) {
          if (after === null || compare(s, after) >= 0) after = s;
        } else if (before === null || compare(s, before) < 0) before = s;
      }
      const fits =
        (after === null || list.indexOf(after) < at) && (before === null || at < list.indexOf(before));
      if (fits) {
        const prev = list[at - 1];
        const next = list[at + 1];
        out.set(r.id, {
          slot: prev ? { after: prev.id } : next ? { before: next.id } : {},
          moves: false,
        });
        continue;
      }
      list.splice(at, 1);
      const anchor = list.indexOf((after ?? before)!);
      list.splice(after ? anchor + 1 : anchor, 0, me);
      out.set(r.id, { slot: after ? { after: after.id } : { before: before!.id }, moves: true });
    }
  }
  return out;
}
