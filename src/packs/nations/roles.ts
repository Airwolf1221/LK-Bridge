/**
 * v3 F6c (ADR 0080; design T3 to T5 as amended; the owner's rulings of 26 November 2026): the nation roles and the
 * unified subindex names, the pure rules.
 *
 * - **The roles** are pack data (`indexTaxonomy.nationRoles`, ten, in order), and so are the approved variants of their
 *   names (`nationRoleVariants`, each mapping to a role).
 * - **The unified name** of a nation's subindex is `<Nation> <Role>`: the Nation entry's short name, else the nation
 *   index's display name (`Cantha Settlements & Locations`, `Jabal al-Noor Military & Technology`).
 * - **Matching a nation's child** to a role: its display name (the prefix aside), compared without case or accents, in
 *   any of the three forms found live: bare (`Military & Technology`), `<Nation> <word>` (`Al-Muqaddas Government &
 *   Administration`) and `<Nation or short name> - <word>` (`Cantha - Government & Administration`), against each role
 *   name and each variant; the owner's own mapping of a name (the Nation Subindexes page) first. No match: the child is
 *   unmatched, and never guessed (the owner's ruling): it goes to the owner.
 *
 * Nothing here reads the tree or the database.
 */
import type { IndexTaxonomyRules } from '../types.js';

/** The comparison key: case, accents, spacing and the dash forms aside. */
export const roleKey = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-GB');

/** The nation roles of the rules, in order (none for a version without them). */
export const nationRolesOf = (rules: IndexTaxonomyRules | null | undefined): readonly string[] =>
  rules?.nationRoles ?? [];

/** Whether the rules carry the nation roles (F6c's data). */
export const hasNationRoles = (rules: IndexTaxonomyRules | null | undefined): boolean =>
  (rules?.nationRoles?.length ?? 0) > 0;

/**
 * The nation subindex words F6b's classifier reads: the role names and the approved variants (derived, so F6b's
 * classification and F6c agree). A version without nation roles keeps F6b's own list.
 */
export function nationSubindexWords(rules: IndexTaxonomyRules): string[] {
  if (!hasNationRoles(rules)) return [...rules.structural.nationSubindexes];
  const out: string[] = [];
  for (const w of [...rules.nationRoles!, ...(rules.nationRoleVariants ?? []).map((v) => v.variant)])
    if (!out.some((x) => roleKey(x) === roleKey(w))) out.push(w);
  return out;
}

export type MatchVia = 'role' | 'variant' | 'mapping';
export type MatchForm = 'bare' | 'nation' | 'dash' | 'exact';

export interface RoleMatch {
  readonly role: string;
  readonly via: MatchVia;
  readonly form: MatchForm;
  /** The role name or variant the name matched (for a mapping: the name itself). */
  readonly word: string;
}

/** An owner's mapping of a child's exact name (the display name) to a role. */
export interface NameMapping {
  readonly name: string;
  readonly role: string;
}

/** The canonical spelling of a role name, or null when the rules have no such role. */
export function canonicalRole(rules: IndexTaxonomyRules, role: string): string | null {
  const k = roleKey(role);
  return nationRolesOf(rules).find((r) => roleKey(r) === k) ?? null;
}

/**
 * The role a nation's child matches, or null (unmatched). `nationNames`: the nation index's display name and the
 * entry's short name (when it has one). `mappings`: the owner's mappings by exact name, read first.
 */
export function matchNationChild(
  rules: IndexTaxonomyRules,
  displayName: string,
  nationNames: readonly string[],
  mappings: readonly NameMapping[] = [],
): RoleMatch | null {
  const k = roleKey(displayName);
  for (const m of mappings)
    if (roleKey(m.name) === k) {
      const role = canonicalRole(rules, m.role);
      if (role) return { role, via: 'mapping', form: 'exact', word: m.name };
    }
  const table: { word: string; role: string; via: MatchVia }[] = [
    ...nationRolesOf(rules).map((r) => ({ word: r, role: r, via: 'role' as const })),
    ...(rules.nationRoleVariants ?? []).map((v) => ({
      word: v.variant,
      role: canonicalRole(rules, v.role) ?? v.role,
      via: 'variant' as const,
    })),
  ];
  const nations = [...new Set(nationNames.map(roleKey).filter((x) => x !== ''))];
  for (const t of table) {
    const w = roleKey(t.word);
    if (k === w) return { role: t.role, via: t.via, form: 'bare', word: t.word };
    for (const n of nations) {
      if (k === `${n} ${w}`) return { role: t.role, via: t.via, form: 'nation', word: t.word };
      if (k === `${n} - ${w}`) return { role: t.role, via: t.via, form: 'dash', word: t.word };
    }
  }
  return null;
}

/** The unified name (owner, 26 November 2026): `<Nation> <Role>`, the short name first. */
export function unifiedName(
  nation: { readonly displayName: string; readonly shortName?: string | null },
  role: string,
): string {
  const n = nation.shortName?.trim() || nation.displayName.trim();
  return `${n} ${role}`;
}

/** The territory category name: `<Territory> <Category>`. */
export const territoryCategoryName = (territory: string, category: string): string =>
  `${territory.trim()} ${category}`;

/**
 * The roles a matched word names in its parts (`Government & Institutions` names Government & Administration and
 * Institutions). Two or more: the index's content may span two roles, so the report lists its pages for the owner.
 */
export function rolesNamedBy(rules: IndexTaxonomyRules, word: string): string[] {
  const parts = (s: string) =>
    s
      .split(/\s+&\s+|\s+and\s+/i)
      .map(roleKey)
      .filter((x) => x !== '');
  const firsts = nationRolesOf(rules).map((r) => ({ r, all: roleKey(r), first: parts(r)[0] ?? '' }));
  const out: string[] = [];
  for (const p of parts(word)) {
    const hit = firsts.find((f) => f.all === p || f.first === p);
    if (hit && !out.includes(hit.r)) out.push(hit.r);
  }
  return out;
}

/** The category a territory category sits in (`Conflicts` → `Historical Events`), or null for its territory. */
export function categoryParentOf(rules: IndexTaxonomyRules, category: string): string | null {
  const k = roleKey(category);
  for (const [c, p] of Object.entries(rules.categoryParents ?? {})) if (roleKey(c) === k) return p;
  return null;
}

/** The territory categories (the pack's `continentCategories`, the one source), in order. */
export const territoryCategoriesOf = (rules: IndexTaxonomyRules): readonly string[] =>
  rules.structural.continentCategories;

/**
 * The REQUIRED territory categories (`requiredTerritoryCategories`, the governance's list), in order: only
 * `territory_category_missing` reads these. A version without the list requires every recognised category.
 */
export const requiredTerritoryCategoriesOf = (rules: IndexTaxonomyRules): readonly string[] =>
  rules.requiredTerritoryCategories ?? rules.structural.continentCategories;

/**
 * The nation role a home rule's nation-level category names (`Institutions` → Institutions, `Government &
 * Administration` → itself, a variant to its role), or null when it names none (`Laws`, `History`).
 */
export function roleForCategory(rules: IndexTaxonomyRules, category: string): string | null {
  const m = matchNationChild(rules, category, []);
  return m?.role ?? null;
}
