/**
 * v3 F3d amendment (ADR 0058, C): steering agents to `arkona_rename`. Asked to rename a character "with the new bridge
 * tools", an agent first reached for `update_resource`, which renames one page and nothing that refers to it.
 *
 * On a project with an APPROVED setting pack, a plain rename (`update_resource`, or `updateResource` through
 * `lk_api_write`, `lk_api_batch` or `lk_op_updateResource`) that changes the SUBJECT part of a page's name is refused
 * with `USE_ARKONA_RENAME` and a hint naming `arkona_rename` and what it does that a plain rename does not. The subject
 * part is the text before " - " (the whole name of an index). It applies to a page of a character's set, a page with a
 * Subject fact, a pack owner (a page tagged with an owner type's primary tag), and (CR-2026-11-R3, R3-48) the index that
 * heads such a subject's set.
 *
 * - `plainRename: { reason }` lets it through (to fix a typo in a descriptor, say): the reason is shown with the
 *   proposal, or on the Review page (the job's title and journal carry it).
 * - Renaming only the descriptor (after " - ") is never refused.
 * - CR-2026-11-R3 (R3-58): a Subject fact is judged on the page's sidebar read live (`update_resource` always reads it;
 *   the low-level tools read it, once, when the tree has not read it yet and the answer turns on it:
 *   `subjectRenameNeedsFacts`).
 */
import type { TreeNode } from '../../tree/types.js';
import { classifyName } from '../../tree/classify.js';
import { textKey } from '../engine/text.js';
import type { Packs } from '../service.js';

export const USE_ARKONA_RENAME = 'USE_ARKONA_RENAME';

/** What a plain rename does not do, for the hint. */
export const ARKONA_RENAME_HINT =
  'Use arkona_rename { subject, newName } instead: it renames the subject everywhere it is referred to (every page of its set, its identity facts and aliases, index routing lines, chronology rows and their events, its art, and each restatement in other pages), as ONE proposal the owner approves item by item; a plain rename changes one page’s name and leaves every reference to the old one. If this really is only a plain rename (a typo, say), pass plainRename: { reason } and the reason is shown to the owner.';

/** The subject part of a page's display name: the text before " - ", or the whole name of an index. */
export function subjectPart(displayName: string, isIndex: boolean): string {
  const d = displayName.trim();
  if (isIndex) return d;
  const at = d.indexOf(' - ');
  return (at < 0 ? d : d.slice(0, at)).trim();
}

export interface SubjectRenameContext {
  readonly packs: Pick<Packs, 'forProject'> | undefined;
  readonly projectId: string;
  readonly node: Pick<TreeNode, 'id' | 'kind' | 'displayName' | 'tags'>;
  /** The new name, raw or display (a prefix is ignored). */
  readonly newName: string;
  /** The character a page belongs to, when it does. */
  readonly characterOf: (pageId: string) => boolean;
  /**
   * The page's sidebar keys (any key-value rows), live or as the tree holds them; null when not known (taken as none:
   * `subjectRenameNeedsFacts` says when the answer would turn on them).
   */
  readonly factKeys: readonly string[] | null;
  /**
   * CR-2026-11-R3 (R3-48): the pages directly under an index, as the tree holds them: an index that heads a subject's
   * set (an owner's or a character's own index, "[INDEX] Velaran") is the subject's too.
   */
  readonly childrenOf?: (
    indexId: string,
  ) => readonly Pick<TreeNode, 'id' | 'kind' | 'displayName' | 'tags'>[];
}

/** The refusal body when the rename changes a subject's name on a pack project, else null. */
export function subjectRenameRefusal(c: SubjectRenameContext): {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly [k: string]: unknown;
} | null {
  const packs = c.packs?.forProject(c.projectId).filter((p) => p.approved !== null) ?? [];
  if (packs.length === 0) return null;
  const isIndex = c.node.kind === 'index';
  const before = subjectPart(c.node.displayName, isIndex);
  const after = subjectPart(classifyName(c.newName).displayName, isIndex);
  if (before === after) return null; // the descriptor only (or nothing of the name)
  const primaries = new Set(
    packs.flatMap((p) => (p.rules.owners?.types ?? []).map((t) => t.primary.toLowerCase())),
  );
  // An index heads a subject's set when a page under it has the index's own name as its subject and is that
  // subject's (a pack owner, or a page of a character's set): renaming the index alone half-renames the set.
  const heads = (): boolean =>
    isIndex &&
    (c.childrenOf?.(c.node.id) ?? []).some(
      (ch) =>
        ch.kind !== 'index' &&
        textKey(subjectPart(ch.displayName, false)) === textKey(before) &&
        (c.characterOf(ch.id) || ch.tags.some((t) => primaries.has(t.toLowerCase()))),
    );
  const why = c.characterOf(c.node.id)
    ? 'a page of a character’s set'
    : (c.factKeys ?? []).some((k) => textKey(k) === 'subject')
      ? 'a page with a Subject fact'
      : c.node.tags.some((t) => primaries.has(t.toLowerCase()))
        ? 'a pack owner'
        : heads()
          ? 'the index of a subject’s set'
          : null;
  if (why === null) return null;
  return {
    code: USE_ARKONA_RENAME,
    message: `Renaming “${before}” to “${after}” changes the subject of ${why} on a project with a setting pack: a plain rename would leave every reference to “${before}” behind. Nothing was written.`,
    hint: ARKONA_RENAME_HINT,
    useTool: 'arkona_rename',
    subject: { id: c.node.id, from: before, to: after },
  };
}

/**
 * CR-2026-11-R3 (R3-58): true when the answer turns on the page's facts while they are not known (`factKeys` null: the
 * tree holds a page's sidebar only once its properties pass has read it). The rename changes a subject's name on a pack
 * project and nothing else known refuses it (a page of a character's set, a pack owner, the index of a subject's set),
 * but a Subject fact would. The caller then reads the page's sidebar live, once, and asks again with what it read.
 */
export function subjectRenameNeedsFacts(c: SubjectRenameContext): boolean {
  if (c.factKeys !== null || subjectRenameRefusal(c) !== null) return false;
  return subjectRenameRefusal({ ...c, factKeys: ['Subject'] }) !== null;
}
