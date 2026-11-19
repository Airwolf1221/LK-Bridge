/**
 * v3 F3e (ADR 0059): steering agents away from splitting an owner by hand, as F3d.1 steers renames (ADR 0058 amendment
 * C). A manual split is new pages made with copied text, then the text cut from the old page with `write_page`: nothing
 * checks that every block went somewhere exactly once, the old page keeps no interface summary, nothing that depended on
 * it is remapped, and nothing is verified before the material leaves.
 *
 * On a project whose APPROVED pack has split rules, a `write_page` edit that would take `splits.guardWords` words of text
 * or more off a pack page (a page of a character's set, a page with a Subject fact, or a pack owner: the rename guard's
 * own test) is refused with `USE_ARKONA_SPLIT` and a hint naming `arkona_split_appraisal` and `arkona_split_owner`.
 * `plainEdit: { reason }` lets it through (a page's own revision that removes material on purpose): the reason is shown
 * with the proposal, or on the Review page (the job's title and journal carry it).
 */
import type { TreeNode } from '../../tree/types.js';
import type { Packs } from '../service.js';
import { textKey } from '../engine/text.js';
import { blockText } from './blocks.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const USE_ARKONA_SPLIT = 'USE_ARKONA_SPLIT';

export const ARKONA_SPLIT_HINT =
  'To split material out of an owner page, use arkona_split_appraisal { page } first (the split triggers, a draft destination map and the Anti-Fragmentation note), bring it to the owner, and then, only if the owner asks for the split, arkona_split_owner with the destination map: it moves every block verbatim to exactly one new or existing owner, keeps an interface summary with an exact link in the old page, remaps what depended on it and verifies all of it, as ONE proposal the owner approves. If this edit is not a split (the page’s own revision removes the material on purpose), pass plainEdit: { reason } and the reason is shown to the owner.';

const words = (blocks: readonly unknown[]): number =>
  blocks
    .filter(isObj)
    .map((b) => blockText(b))
    .join(' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export interface ManualSplitContext {
  readonly packs: Pick<Packs, 'forProject'> | undefined;
  readonly projectId: string;
  readonly node: Pick<TreeNode, 'id' | 'kind' | 'displayName' | 'tags'>;
  readonly before: readonly unknown[];
  readonly after: readonly unknown[];
  readonly characterOf: (pageId: string) => boolean;
  readonly factKeys: readonly string[] | null;
}

/** The refusal body when an edit takes substantial material off a pack page, else null. */
export function manualSplitRefusal(c: ManualSplitContext): {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly [k: string]: unknown;
} | null {
  const packs = c.packs?.forProject(c.projectId).filter((p) => p.approved !== null && p.rules.splits) ?? [];
  if (packs.length === 0 || c.node.kind === 'index') return null;
  const limit = Math.min(...packs.map((p) => p.rules.splits!.guardWords));
  const removed = words(c.before) - words(c.after);
  if (removed < limit) return null;
  const primaries = new Set(
    packs.flatMap((p) => (p.rules.owners?.types ?? []).map((t) => textKey(t.primary))),
  );
  const why = c.characterOf(c.node.id)
    ? 'a page of a character’s set'
    : (c.factKeys ?? []).some((k) => textKey(k) === 'subject')
      ? 'a page with a Subject fact'
      : c.node.tags.some((t) => primaries.has(textKey(t)))
        ? 'a pack owner'
        : null;
  if (why === null) return null;
  return {
    code: USE_ARKONA_SPLIT,
    message: `This edit takes ${removed} words off “${c.node.displayName}”, ${why} on a project with a setting pack (the pack's threshold is ${limit}). Moving material out of an owner is a split, which is planned, verified and approved as one (Character Architecture: “do not discard a valid item”). Nothing was written.`,
    hint: ARKONA_SPLIT_HINT,
    useTool: 'arkona_split_owner',
    removedWords: removed,
  };
}
