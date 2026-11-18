/**
 * v3 F3b (ADR 0052; design 1.1a): the character navigation an owner package makes for a new race or racial group
 * (`Characters / <Group> / <Race>`) is what lets `arkona_create_character` place anyone in it. The character tool places
 * by the registry's Character taxonomy (A3), so the job that makes the navigation index also records ONE taxonomy entry
 * for it, exactly as the Repository Mappings page's "Add missing" would (its singular from the same rules, its parent
 * entry, its asset folder), on the owner's approval of the proposal that names it. Nothing else of the taxonomy changes;
 * an index that already has an entry, or a taxonomy never seeded, is left alone (and the result says why).
 */
import { singularFor } from '../registry/names.js';
import type { RegistryStore } from '../registry/store.js';

export interface TaxonomyRecord {
  /** The new navigation index. */
  readonly resourceId: string;
  /** Its name (the race or racial group, as the index is named). */
  readonly plural: string;
  /** The index it was made in (the racial group's navigation, or Characters). */
  readonly parentNodeId: string;
}

export function addPackTaxonomyEntry(
  store: RegistryStore,
  r: TaxonomyRecord,
  audit: (actor: string, action: string, target: string | null, before?: unknown, after?: unknown) => void,
  actor: string,
): Record<string, unknown> {
  const types = store.listTypes().filter((t) => t.placementKind === 'character');
  const type = types.find((t) => t.rootIndexId !== null) ?? types[0];
  if (!type) return { recorded: null, why: 'no character type in the registry' };
  if (type.taxonomySeededAt === null)
    return {
      recorded: null,
      why: `the taxonomy of ${type.singular} is not seeded yet (Repository Mappings)`,
    };
  const had = store.entryBySource(r.resourceId);
  if (had) return { recorded: null, why: 'the index already has a taxonomy entry', entryId: had.id };
  const s = singularFor(r.plural);
  const parent = store.entryBySource(r.parentNodeId);
  const entry = store.insertEntry({
    typeId: type.id,
    plural: r.plural,
    singular: s.singular,
    singularSource: s.source,
    parentId: parent?.id ?? null,
    aliases: [],
    sourceNodeId: r.resourceId,
    sourceParentNodeId: r.parentNodeId,
    assetFolder: r.plural,
    status: s.source === 'rule' ? 'needs_review' : 'ok',
    review:
      s.source === 'rule'
        ? [
            {
              code: 'singular_guess',
              message: `The singular “${s.singular}” is a guess (${s.rule ?? 'a rule'}); check it.`,
            },
          ]
        : [],
    origin: 'add_missing',
  });
  audit(actor, 'registry.taxonomy_add_entry', type.id, undefined, {
    entryId: entry.id,
    plural: entry.plural,
    singular: entry.singular,
    sourceNodeId: r.resourceId,
    by: 'pack navigation',
  });
  return { recorded: 'taxonomy_entry', entryId: entry.id, plural: entry.plural, singular: entry.singular };
}

/**
 * v3 F3d (renames), ADR 0058: an approved race rename renames the race's taxonomy entry with its navigation index: the
 * plural becomes the new name, the singular is worked out again by the same rules (an owner's own singular is kept and
 * flagged for review), and the old plural and singular are kept as aliases (a character whose Race / Species still says
 * the old name is still placed). The asset folder is left as it is (the race's art stays where it is). A resumed job
 * that finds the entry renamed already leaves it alone.
 */
export function renamePackTaxonomyEntry(
  store: RegistryStore,
  r: { readonly entryId: string; readonly from: string; readonly plural: string },
  audit: (actor: string, action: string, target: string | null, before?: unknown, after?: unknown) => void,
  actor: string,
): Record<string, unknown> {
  const e = store.entry(r.entryId);
  if (!e) return { recorded: null, why: 'the taxonomy entry is gone' };
  if (e.plural === r.plural) return { recorded: 'taxonomy_rename', entryId: e.id, unchanged: true };
  if (e.plural !== r.from)
    return { recorded: null, why: `the entry is now named “${e.plural}”, not “${r.from}”`, entryId: e.id };
  const keepOwner = e.singularSource === 'owner';
  const s = keepOwner ? { singular: e.singular, source: 'owner' as const, rule: null } : singularFor(r.plural);
  const aliases = [...e.aliases];
  for (const a of [e.plural, e.singular])
    if (a !== r.plural && a !== s.singular && !aliases.some((x) => x.toLowerCase() === a.toLowerCase())) aliases.push(a);
  const review = [
    ...e.review.filter((x) => x.code !== 'singular_guess' && x.code !== 'renamed'),
    ...(keepOwner
      ? [
          {
            code: 'renamed',
            message: `Renamed from “${e.plural}”: the singular “${e.singular}” was yours and is kept; check it.`,
          },
        ]
      : s.source === 'rule'
        ? [
            {
              code: 'singular_guess',
              message: `The singular “${s.singular}” is a guess (${s.rule ?? 'a rule'}); check it.`,
            },
          ]
        : []),
  ];
  const next = store.renameEntry(e.id, {
    plural: r.plural,
    singular: s.singular,
    singularSource: s.source,
    aliases,
    status: review.length > 0 ? 'needs_review' : e.status,
    review,
  });
  audit(actor, 'registry.taxonomy_rename_entry', e.typeId, { plural: e.plural, singular: e.singular }, {
    entryId: e.id,
    plural: next.plural,
    singular: next.singular,
    aliases: next.aliases,
    by: 'arkona_rename',
  });
  return { recorded: 'taxonomy_rename', entryId: e.id, plural: next.plural, singular: next.singular };
}
