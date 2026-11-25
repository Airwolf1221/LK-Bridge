/**
 * v3 F6b (ADR 0079; design T11): navigation and subject indexes, the pure rules.
 *
 * - **The rule in force for a project**: the APPROVED pack version's `indexTaxonomy` (never the current version's: the
 *   ordering, the tag codes and the creation tools follow only what the owner approved). Null: no `[NAV]` rule, and
 *   everything behaves as before F6b.
 * - **The tag rule**: a `[NAV]` carries exactly the navigation tag; an `[INDEX]` exactly its subject's primary category;
 *   neither carries CANON. While the version's section is a draft, the seed's rule is used by the classification report
 *   (to show what an approval would propose) but the `index_tags` audit reports nothing: the old rules stay in force
 *   until the owner's reviewer publishes the Tagging Standard's "Navigation and Subject Index Tags" section.
 * - **The section's form** (`parseIndexTagSection`): one paragraph per kind of index, `<Kind> index[ (…)]: <Tag>`;
 *   anything else in the section is prose. Read exactly or not at all.
 */
import type { IndexRole } from '../../tree/classify.js';
import type { IndexTaxonomyRules, Pack, PackRules } from '../types.js';
import { approvedRulesOf } from '../governance-audit.js';
import { runsText } from '../sections.js';

type Obj = Record<string, unknown>;

/** The kinds of subject an `[INDEX]` is about (T11), each with its primary category tag. */
export const SUBJECT_KINDS = ['character', 'polity', 'culture', 'religion', 'place', 'story'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** What the packs offer this module (the runtime's `Packs`, or a test's). */
export interface IndexTaxonomyPacks {
  forProject(projectId: string): readonly Pack[];
  readonly store: { rulesAt(packId: string, version: number): PackRules | null };
}

/** The approved index taxonomy of a project: the first attached pack (by id) whose APPROVED rules carry it, or null. */
export function approvedIndexTaxonomy(
  packs: IndexTaxonomyPacks | null | undefined,
  projectId: string,
): { readonly pack: Pack; readonly rules: IndexTaxonomyRules } | null {
  if (!packs) return null;
  for (const pack of [...packs.forProject(projectId)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const r = approvedRulesOf(pack, (id, v) => packs.store.rulesAt(id, v));
    if (r?.indexTaxonomy) return { pack, rules: r.indexTaxonomy };
  }
  return null;
}

/** Whether T11's ordering is in force (the approved version carries it). */
export function navOrderingInForce(rules: IndexTaxonomyRules | null | undefined): boolean {
  return rules?.ordering === 'nav-index-sources';
}

/** The tags an index of this role (and, for `[INDEX]`, this subject) must carry, exactly; null when unknown. */
export function expectedIndexTags(
  rules: IndexTaxonomyRules,
  role: IndexRole,
  subject: SubjectKind | null,
): string[] | null {
  if (role === 'nav') return [rules.navTag];
  if (!subject) return null;
  return [rules.subjectTags[subject]];
}

/** The subject kind whose tag this is (an `[INDEX]`'s current tag read back), or null. */
export function subjectOfTag(rules: IndexTaxonomyRules, tag: string): SubjectKind | null {
  const k = tag.trim().toLowerCase();
  for (const s of SUBJECT_KINDS) if (rules.subjectTags[s].trim().toLowerCase() === k) return s;
  return null;
}

/** The template name of a role (resolved by name in each project). */
export function templateNameOf(rules: IndexTaxonomyRules | null | undefined, role: IndexRole): string {
  if (rules) return role === 'nav' ? rules.templates.nav : rules.templates.subject;
  return role === 'nav' ? NAV_TEMPLATE : SUBJECT_TEMPLATE;
}

/** The two templates' names (T11): the owner makes "[NAV] AI Navigation" as a copy of "[INDEX] AI Index". */
export const NAV_TEMPLATE = '[NAV] AI Navigation';
export const SUBJECT_TEMPLATE = '[INDEX] AI Index';

// ============================================================================================ the governance section

/** One paragraph of the section: `<Kind> index[ (words)]: <Tag>[.]` */
const LINE =
  /^\s*(Navigation|Character|Polity|Culture|Religion|Place|Story)\s+index(?:\s*\([^)]*\))?\s*:\s*(.+?)\s*\.?\s*$/i;

export type IndexTagSectionParse =
  | {
      readonly ok: true;
      readonly navTag: string;
      readonly subjectTags: Readonly<Record<SubjectKind, string>>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The tag rule the "Navigation and Subject Index Tags" section states, from its paragraphs. Fails (never guesses) when a
 * kind is missing, stated twice, or its tag does not read as one tag.
 */
export function parseIndexTagSection(section: readonly Obj[] | null): IndexTagSectionParse {
  if (!section) return { ok: false, reason: 'the section is not in the document exactly once' };
  const found = new Map<string, string>();
  for (const b of section) {
    if (b.kind === 'heading') continue;
    for (const line of runsText(b).split(/\n/)) {
      const m = LINE.exec(line);
      if (!m) continue;
      const kind = m[1]!.toLowerCase();
      if (found.has(kind))
        return {
          ok: false,
          reason: `the ${kind} index's tag is stated more than once; which one governs cannot be told`,
        };
      const tag = m[2]!.trim();
      if (tag === '' || tag.length > 100 || /[,;:]/.test(tag))
        return { ok: false, reason: `“${tag}” (the ${kind} index's tag) does not read as one tag` };
      found.set(kind, tag);
    }
  }
  const need = ['navigation', ...SUBJECT_KINDS];
  const missing = need.filter((k) => !found.has(k));
  if (missing.length > 0)
    return {
      ok: false,
      reason: `the section does not state the tag of: ${missing.join(', ')} (one paragraph each, “Character index: Character.”); the bridge reads nothing it cannot read exactly`,
    };
  return {
    ok: true,
    navTag: found.get('navigation')!,
    subjectTags: Object.fromEntries(SUBJECT_KINDS.map((k) => [k, found.get(k)!])) as Record<
      SubjectKind,
      string
    >,
  };
}

/** The section's text as the owner's reviewer writes it (the report gives it; the parser reads exactly this form). */
export function indexTagSectionText(rules: IndexTaxonomyRules): string[] {
  const t = rules.subjectTags;
  return [
    'An index is one of two kinds. A navigation index, [NAV] <name>, only groups or routes: it carries exactly one tag, the navigation tag. A subject index, [INDEX] <name>, is about one subject: it carries exactly that subject’s primary category tag. Neither carries CANON, and neither carries a lifecycle, specialist or identity tag.',
    `Navigation index ([NAV]): ${rules.navTag}.`,
    `Character index: ${t.character}.`,
    `Polity index (a nation or polity): ${t.polity}.`,
    `Culture index (a culture family): ${t.culture}.`,
    `Religion index (a religion family): ${t.religion}.`,
    `Place index (a continent, a Realmship or a named Divine Realm): ${t.place}.`,
    `Story index: ${t.story}.`,
    'In every parent, [NAV] indexes come first, then [INDEX] indexes, then sources, each group in alphabetical order; inside a story the narrative number order applies.',
  ];
}

/**
 * The template of a role in a project's template list (as last read), by NAME (T11: never by id): its prefix, a
 * trailing "Template" and case aside. Null when no template, or more than one, has that name.
 */
export function templateIdByName(
  templates: readonly { readonly id: string; readonly name: string | null }[],
  name: string,
  base: (s: string) => string,
): string | null {
  const want = base(name);
  const hits = templates.filter((t) => t.name && base(t.name) === want);
  return hits.length === 1 ? hits[0]!.id : null;
}

/** The refusal a creation tool gives when the `[NAV]` template is missing (T11). */
export function templateMissingMessage(rules: IndexTaxonomyRules | null | undefined): string {
  return `The template “${templateNameOf(rules, 'nav')}” is missing, so no [NAV] index can be made. The owner makes it as a copy of “${templateNameOf(rules, 'subject')}”; until then nothing is created.`;
}
