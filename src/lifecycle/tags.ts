/**
 * v3 F3d (ADR 0053): where the lifecycle tag goes, and which status tag an Authoritative page carries, per project.
 *
 * Two rules come from the setting pack attached to a project (pack data, versioned and approved with the pack; the
 * resolver is `Packs.lifecycleRules`), never from code:
 *
 * - **`position`** (`lifecycleTagPosition` in the pack, per project name): `"append"` (the default, ADR 0035 decision
 *   8: the outgoing status tag removed, the incoming one added last) or `"lead"` (the Controlled Native Tagging
 *   Standard's order: the lifecycle or status tag FIRST, every other tag kept in its original relative order after it).
 * - **`au`** (the pack's `tags.au`, the owner's AU ruling of 16 November 2026, ADR 0052 decision 6): an Authoritative
 *   page whose Continuity Type is AU carries `AU` as its status tag in place of `CANON`. Without the ruling, `CANON`.
 *
 * A project with no attached, approved pack gets the defaults: `append`, no AU ruling (exactly ADR 0035).
 */
import type { LifecycleConfig } from './settings.js';

export type TagPosition = 'lead' | 'append';

export interface LifecycleTagRules {
  /** Where the lifecycle tools put the incoming tag. */
  readonly position: TagPosition;
  /** The AU ruling: Continuity Type `continuityType` → status tag `tag` (in place of CANON), or null (no ruling). */
  readonly au: { readonly continuityType: string; readonly tag: string } | null;
  /** The pack version the rules come from (null: the defaults). */
  readonly source: { readonly pack: string; readonly version: number } | null;
}

export const DEFAULT_TAG_RULES: LifecycleTagRules = Object.freeze({
  position: 'append',
  au: null,
  source: null,
});

const fold = (t: string | null | undefined) => (t ?? '').trim().toLocaleLowerCase('en-GB');

/** Whether two tags are the same (without case or surrounding spaces). */
export const sameTag = (a: string | null | undefined, b: string | null | undefined) => fold(a) === fold(b);

/** Whether a page whose Continuity Type is `continuityType` is an AU page under the ruling. */
export function isAuPage(r: LifecycleTagRules, continuityType: string | null | undefined): boolean {
  return r.au !== null && fold(continuityType) !== '' && fold(continuityType) === fold(r.au.continuityType);
}

/** The status tag an Authoritative page carries: AU for an AU page under the ruling, else the canon tag. */
export function statusTagFor(
  c: Pick<LifecycleConfig, 'tags'>,
  r: LifecycleTagRules,
  continuityType: string | null | undefined,
): string {
  return isAuPage(r, continuityType) ? r.au!.tag : c.tags.canon;
}

/** Every status tag of the Authoritative state: the canon tag, and AU under the ruling. */
export function authoritativeTags(c: Pick<LifecycleConfig, 'tags'>, r: LifecycleTagRules): string[] {
  return r.au !== null && !sameTag(r.au.tag, c.tags.canon) ? [c.tags.canon, r.au.tag] : [c.tags.canon];
}

/**
 * `tags` with `remove` taken out (any case) and `add` put in:
 *
 * - `append` (ADR 0035, unchanged): each added tag that is missing goes last; a tag already there stays where it is;
 * - `lead` (ADR 0053): the added tags go first, in their order (taken out of wherever they were), and every other tag
 *   keeps its original relative order after them.
 */
export function placeTags(
  tags: readonly string[],
  remove: readonly string[],
  add: readonly string[],
  position: TagPosition = 'append',
): string[] {
  const r = new Set(remove.map(fold));
  if (position === 'lead') {
    const a = new Set(add.map(fold));
    const head: string[] = [];
    for (const t of add) if (!head.some((x) => sameTag(x, t))) head.push(t);
    return [...head, ...tags.filter((t) => !r.has(fold(t)) && !a.has(fold(t)))];
  }
  const out = tags.filter((t) => !r.has(fold(t)));
  for (const t of add) if (!out.some((x) => sameTag(x, t))) out.push(t);
  return out;
}

/**
 * For a `lead` project's audit (ADR 0053): what is wrong with a Working or Archived page's tags, or null. `lifecycleTag`
 * is the page's own (`Working` or `Archived`); `statusTags` are the Authoritative ones (CANON, and AU under the ruling).
 * `reordered` is the fix: the lifecycle tag first, every other tag in its order (status tags included: the fix only
 * reorders), or null when the lifecycle tag is missing or already first.
 */
export function leadingProblem(
  tags: readonly string[],
  lifecycleTag: string,
  statusTags: readonly string[],
): { readonly notFirst: boolean; readonly statusTags: string[]; readonly reordered: string[] | null } | null {
  const at = tags.findIndex((t) => sameTag(t, lifecycleTag));
  const notFirst = at > 0;
  const still = tags.filter((t) => statusTags.some((s) => sameTag(s, t)));
  if (!notFirst && still.length === 0) return null;
  return {
    notFirst,
    statusTags: still,
    reordered: notFirst ? [tags[at]!, ...tags.filter((_, i) => i !== at)] : null,
  };
}
