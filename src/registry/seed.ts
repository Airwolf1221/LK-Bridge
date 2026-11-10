/**
 * Seeding (v2 A3): the Character type from the tree and the project's templates, and a type's taxonomy from its root
 * index. Both run only on the owner's request. The taxonomy is seeded once per type; afterwards "add missing" only
 * creates entries for new indexes and never changes existing ones. Anything the seed cannot be sure of is marked
 * `needs_review`, with the reason.
 */
import type { ProjectSettings } from '../projects/index.js';
import { classifyType } from './classify.js';
import { key, singularFor, templateBaseKey } from './names.js';
import { CHARACTER_SEED } from './seed-data.js';
import type { NewType, RegistryStore } from './store.js';
import type { ProjectTree } from './tree-view.js';
import {
  RegistryError,
  type CharacterSeedInput,
  type NodeRef,
  type RegistryType,
  type ReviewReason,
  type TaxonomyEntry,
  type TemplatesSnapshot,
} from './types.js';

const reason = (code: string, message: string): ReviewReason => ({ code, message });

/** The one template whose name (the word "Template" ignored, as LegendKeeper's copies drop it) is `name`. */
export function matchTemplate(
  snapshot: TemplatesSnapshot,
  name: string,
): { id: string | null; problem: string | null } {
  if (snapshot.readAt === null) {
    return {
      id: null,
      problem: `The project's templates could not be read${snapshot.error ? ` (${snapshot.error})` : ''}, so “${name}” was not looked for.`,
    };
  }
  const want = templateBaseKey(name);
  const hits = snapshot.templates.filter((t) => templateBaseKey(t.name) === want);
  if (hits.length === 1) return { id: hits[0]!.id, problem: null };
  if (hits.length === 0) return { id: null, problem: `No template is named “${name}”.` };
  return {
    id: null,
    problem: `${hits.length} templates are named “${name}” (${hits.map((h) => h.id).join(', ')}); choose one.`,
  };
}

/** The Character type, as found in the tree and the templates. Every value the seed could not find is flagged. */
export function characterTypeFromTree(
  tree: ProjectTree,
  snapshot: TemplatesSnapshot,
  input: CharacterSeedInput,
  settings: ProjectSettings,
): NewType {
  const d = {
    singular: input.singular ?? CHARACTER_SEED.singular,
    plural: input.plural ?? CHARACTER_SEED.plural,
    rootIndexName: input.rootIndexName ?? CHARACTER_SEED.rootIndexName,
    indexTemplateName: input.indexTemplateName ?? CHARACTER_SEED.indexTemplateName,
    pageTemplates: input.pageTemplates ?? CHARACTER_SEED.pageTemplates,
    assetRootFolder: input.assetRootFolder ?? CHARACTER_SEED.assetRootFolder,
  };
  const review: ReviewReason[] = [];
  const root = tree.root();
  let rootIndexId: string | null = null;
  if (!root) {
    review.push(
      reason('root_not_found', 'The repository tree has no root yet, so the root index was not looked for.'),
    );
  } else {
    const want = key(d.rootIndexName);
    const hits = tree.children(root.id).filter((c) => c.kind === 'index' && key(c.displayName) === want);
    if (hits.length === 1) rootIndexId = hits[0]!.id;
    else if (hits.length === 0) {
      review.push(
        reason('root_not_found', `No “[INDEX] ${d.rootIndexName}” is directly under ${root.displayName}.`),
      );
    } else {
      review.push(
        reason(
          'root_ambiguous',
          `${hits.length} “[INDEX] ${d.rootIndexName}” indexes are directly under ${root.displayName} (${hits.map((h) => h.id).join(', ')}); choose one.`,
        ),
      );
    }
  }
  if (rootIndexId && settings.charactersRootId && settings.charactersRootId !== rootIndexId) {
    review.push(
      reason(
        'root_setting_differs',
        `The project setting “Characters root” is ${settings.charactersRootId}, but the tree's “[INDEX] ${d.rootIndexName}” is ${rootIndexId}.`,
      ),
    );
  }
  const index = matchTemplate(snapshot, d.indexTemplateName);
  if (index.problem) review.push(reason('template_not_found', `Index template: ${index.problem}`));
  const pageTemplates = d.pageTemplates.map((t) => {
    const m = matchTemplate(snapshot, t.templateName);
    if (m.problem) review.push(reason('template_not_found', `The “${t.role}” template: ${m.problem}`));
    return { role: t.role, templateId: m.id };
  });
  return {
    singular: d.singular,
    plural: d.plural,
    rootIndexId,
    indexTemplateId: index.id,
    pageTemplates,
    assetRootFolder: d.assetRootFolder,
    placementKind: 'character',
    placementConfig: {},
    status: review.length > 0 ? 'needs_review' : 'ok',
    review,
    notes: '',
  };
}

export interface TaxonomySeedResult {
  readonly created: readonly TaxonomyEntry[];
  /** Indexes recognised as character indexes (not entries). */
  readonly characterIndexes: readonly NodeRef[];
  /** The unknown-race index(es), not entries. */
  readonly reserved: readonly NodeRef[];
  /** Indexes that already had an entry ("add missing" leaves them as they are). */
  readonly unchanged: number;
  /** Indexes inside character indexes, not walked. */
  readonly skipped: number;
  readonly needsReview: number;
  readonly warnings: readonly string[];
}

/**
 * Creates entries for the type's categories. `seed`: the first time only (refused once seeded). `add_missing`: only
 * for indexes with no entry yet; existing entries are never changed.
 */
export function seedTaxonomy(
  tree: ProjectTree,
  store: RegistryStore,
  type: RegistryType,
  mode: 'seed' | 'add_missing',
): TaxonomySeedResult {
  tree.requireUsable();
  if (mode === 'seed' && type.taxonomySeededAt !== null) {
    throw new RegistryError(
      'ALREADY_SEEDED',
      `The taxonomy of ${type.singular} was seeded already; use “Add missing” for new indexes.`,
    );
  }
  if (mode === 'add_missing' && type.taxonomySeededAt === null) {
    throw new RegistryError('NOT_SEEDED', `Seed the taxonomy of ${type.singular} first.`);
  }
  if (!type.rootIndexId || !tree.node(type.rootIndexId)) {
    throw new RegistryError(
      'TYPE_ROOT_MISSING',
      `The type ${type.singular} has no root index in the repository tree; set it first.`,
      { typeId: type.id },
    );
  }
  const c = classifyType(tree, type);
  return store.tx(() => {
    const created: TaxonomyEntry[] = [];
    let unchanged = 0;
    // Categories come top-down, so a parent's entry exists before its children's.
    for (const cat of c.categories) {
      const had = store.entryBySource(cat.node.id);
      if (had) {
        if (had.typeId !== type.id) {
          throw new RegistryError(
            'NAME_CLASH',
            `The index “${cat.node.displayName}” is already an entry of another type.`,
          );
        }
        unchanged++;
        continue;
      }
      const s = singularFor(cat.node.displayName);
      const reasons: ReviewReason[] = [...cat.reasons];
      if (s.source === 'rule') {
        reasons.unshift(
          reason('singular_guess', `The singular “${s.singular}” is a guess (${s.rule}); check it.`),
        );
      }
      const parent = cat.parentNodeId ? store.entryBySource(cat.parentNodeId) : undefined;
      created.push(
        store.insertEntry({
          typeId: type.id,
          plural: cat.node.displayName,
          singular: s.singular,
          singularSource: s.source,
          parentId: parent?.id ?? null,
          aliases: [...cat.node.aliases],
          sourceNodeId: cat.node.id,
          sourceParentNodeId: cat.node.parentId,
          assetFolder: cat.node.displayName,
          status: reasons.length > 0 ? 'needs_review' : 'ok',
          review: reasons,
          origin: mode,
        }),
      );
    }
    if (mode === 'seed') store.markTaxonomySeeded(type.id);
    return {
      created,
      characterIndexes: c.characterIndexes.map((x) => tree.ref(x.node)),
      reserved: c.reserved.map((x) => tree.ref(x)),
      unchanged,
      skipped: c.skipped,
      needsReview: created.filter((e) => e.status === 'needs_review').length,
      warnings: c.warnings,
    };
  });
}
