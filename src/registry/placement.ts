/**
 * Character placement (v2 A3, PLAN-v2 section 9) as a pure plan: no write, no request. It says which race index a
 * Core or Compact page goes under, whether a character index is reused or must be made, which existing page would be
 * returned rather than duplicated, what to write as Race / Species, and the ordering slot of each new page.
 * Refuses rather than guesses: an undeclared race goes to the one unknown-race index; a declared race that does not
 * resolve, or resolves twice, is a typed error.
 */
import { isPageKind, type TreeNode } from '../tree/index.js';
import { RACE_SEARCH_DEPTH } from './classify.js';
import { cleanPrefixes, fillName, key, subjectOf } from './names.js';
import { slotAmong } from './ordering.js';
import type { RegistryStore } from './store.js';
import type { ProjectTree } from './tree-view.js';
import {
  RegistryError,
  type CharacterPlacementConfig,
  type NodeRef,
  type RegistryType,
  type Slot,
  type TaxonomyEntry,
} from './types.js';
import type { TreeMeta } from '../tree/index.js';

export interface CharacterPlacementInput {
  readonly characterName: string;
  readonly race?: string | null | undefined;
  readonly kind: 'core' | 'compact';
  /** The type to place under, when the project has more than one `character` type. */
  readonly type?: string | undefined;
  /**
   * v2 C2c (ADR 0035): a Working character. The whole set goes under this index (the project's `[INDEX] Working`): a
   * Core gets `[INDEX] {name}` there with `[BWRK] {name} - Character Core` beneath it; a compact page goes directly
   * under it. The race is still resolved (a declared race that does not resolve fails) and Race / Species written as
   * given; the page goes under the race index only when it is promoted. Existing pages are looked for under both.
   */
  readonly working?: { readonly indexId: string } | undefined;
  /**
   * v2 C2c: the project's `[INDEX] Working`, searched for an existing page of the character whatever the status (so an
   * Authoritative request returns a Working page that exists, and the reverse).
   */
  readonly lookUnder?: string | undefined;
}

export type PagePlan =
  | {
      readonly action: 'create';
      /** The page's parent: an existing node id, or null for the character index this plan creates. */
      readonly parentId: string | null;
      readonly rawName: string;
      readonly displayName: string;
      readonly templateRole: 'core' | 'compact';
      readonly templateId: string;
      readonly referenceType: string;
      readonly slot: Slot;
    }
  | { readonly action: 'return_existing'; readonly node: NodeRef };

export type IndexPlan =
  | { readonly action: 'reuse'; readonly node: NodeRef }
  | {
      readonly action: 'create';
      readonly parentId: string;
      readonly rawName: string;
      readonly displayName: string;
      readonly templateId: string;
      readonly slot: Slot;
    };

export interface CharacterPlacementPlan {
  readonly type: { readonly id: string; readonly singular: string; readonly plural: string };
  readonly kind: 'core' | 'compact';
  readonly characterName: string;
  readonly race: {
    readonly given: string | null;
    readonly unknown: boolean;
    readonly entry: { readonly id: string; readonly plural: string; readonly singular: string } | null;
    readonly matchedBy: 'plural' | 'singular' | 'alias' | null;
  };
  readonly raceIndex: NodeRef;
  /** Write this as Race / Species: the value as given, or the unknown value. Never rewritten otherwise. */
  readonly species: { readonly row: string; readonly value: string };
  /** Core only: the character's own index. Null for a compact page. */
  readonly characterIndex: IndexPlan | null;
  /** v2 C2c: where the set goes: the race index, or `[INDEX] Working` for a Working character. */
  readonly home: NodeRef;
  /** v2 C2c: the page's prefix: `[BSRC] ` normally, `[BWRK] ` for a Working character. */
  readonly working: boolean;
  readonly page: PagePlan;
  readonly existing: { readonly core: NodeRef | null; readonly compact: NodeRef | null };
  readonly warnings: readonly string[];
  readonly tree: TreeMeta;
}

function characterType(store: RegistryStore, name: string | undefined): RegistryType {
  if (name !== undefined) {
    const t = store.typeByName(name);
    if (!t) throw new RegistryError('UNKNOWN_TYPE', `No type named “${name}”.`);
    if (t.placementKind !== 'character') {
      throw new RegistryError(
        'NO_CHARACTER_TYPE',
        `The type ${t.singular} does not use character placement.`,
      );
    }
    return t;
  }
  const all = store.listTypes().filter((t) => t.placementKind === 'character');
  if (all.length === 0) {
    throw new RegistryError(
      'NO_CHARACTER_TYPE',
      'This project has no type with character placement. Seed or create one on the Repository Mappings page.',
    );
  }
  if (all.length > 1) {
    throw new RegistryError(
      'CHARACTER_TYPE_AMBIGUOUS',
      `Several types use character placement (${all.map((t) => t.singular).join(', ')}); name one.`,
      { types: all.map((t) => t.singular) },
    );
  }
  return all[0]!;
}

function isUnknownRace(race: string | null | undefined, p: CharacterPlacementConfig): boolean {
  if (race === null || race === undefined || race.trim() === '') return true;
  const k = key(race);
  return p.unknownRaceValues.some((v) => key(v) === k);
}

export function planCharacterPlacement(
  tree: ProjectTree,
  store: RegistryStore,
  input: CharacterPlacementInput,
): CharacterPlacementPlan {
  const meta = tree.requireUsable();
  const characterName = cleanPrefixes(
    typeof input.characterName === 'string' ? input.characterName : '',
  ).name;
  if (characterName === '' || characterName.length > 200) {
    throw new RegistryError('INVALID_INPUT', 'A character name (1 to 200 characters) is required.');
  }
  if (input.kind !== 'core' && input.kind !== 'compact') {
    throw new RegistryError('INVALID_INPUT', 'The kind is core or compact.');
  }
  const type = characterType(store, input.type);
  const p = type.placement!;
  const root = type.rootIndexId ? tree.node(type.rootIndexId) : null;
  if (!root) {
    throw new RegistryError(
      'TYPE_ROOT_MISSING',
      `The type ${type.singular} has no root index in the repository tree${type.rootIndexId ? ` (${type.rootIndexId} is not in it)` : ''}.`,
      { typeId: type.id },
    );
  }
  const warnings: string[] = [];
  const given = input.race ?? null;
  const unknown = isUnknownRace(given, p);

  let raceNode: TreeNode;
  let entry: TaxonomyEntry | null = null;
  let matchedBy: 'plural' | 'singular' | 'alias' | null = null;
  if (unknown) {
    const want = key(p.unknownIndexName);
    const hits = tree.children(root.id).filter((c) => c.kind === 'index' && key(c.displayName) === want);
    if (hits.length === 0) {
      throw new RegistryError(
        'UNKNOWN_INDEX_MISSING',
        `There is no “[INDEX] ${p.unknownIndexName}” directly under ${root.displayName}; it is never made automatically.`,
      );
    }
    if (hits.length > 1) {
      throw new RegistryError(
        'UNKNOWN_INDEX_AMBIGUOUS',
        `There are ${hits.length} “[INDEX] ${p.unknownIndexName}” indexes directly under ${root.displayName}; exactly one is expected.`,
        { candidates: hits.map((h) => tree.ref(h)) },
      );
    }
    raceNode = hits[0]!;
  } else {
    const r = resolveRace(tree, store, type, root, given!);
    raceNode = r.node;
    entry = r.entry;
    matchedBy = r.matchedBy;
    if (key(raceNode.displayName) !== key(entry.plural)) {
      warnings.push(
        `The taxonomy entry “${entry.plural}” points at an index now named “${raceNode.displayName}” (see the drift report).`,
      );
    }
  }

  // v2 C2c: a Working character's set goes under [INDEX] Working instead of the race index.
  let workingNode: TreeNode | null = null;
  if (input.working) {
    workingNode = tree.node(input.working.indexId);
    if (!workingNode || workingNode.kind !== 'index') {
      throw new RegistryError(
        'WORKING_INDEX_MISSING',
        `The project's Working index (${input.working.indexId}) is not an index in the repository tree; the owner confirms it again on the Projects page (Lifecycle).`,
      );
    }
  }
  const home = workingNode ?? raceNode;
  const prefix = workingNode ? '[BWRK] ' : '[BSRC] ';

  // What already exists for this character under the race (and under its index, when it has one); v2 C2c: and under
  // [INDEX] Working (and the character's index there), whichever status is asked for.
  const nameKey = key(characterName);
  const indexNamed = (parent: TreeNode) => {
    const hits = tree.children(parent.id).filter((c) => c.kind === 'index' && key(c.displayName) === nameKey);
    if (hits.length > 1) {
      throw new RegistryError(
        'CHARACTER_INDEX_AMBIGUOUS',
        `There are ${hits.length} indexes named “${characterName}” under ${parent.displayName}.`,
        { candidates: hits.map((h) => tree.ref(h)) },
      );
    }
    return hits[0] ?? null;
  };
  const raceKids = tree.children(raceNode.id);
  const raceCharIndex = indexNamed(raceNode);
  const lookNode = workingNode ?? (input.lookUnder ? tree.node(input.lookUnder) : null);
  const workingCharIndex = lookNode && lookNode.kind === 'index' ? indexNamed(lookNode) : null;
  const charIndex = workingNode ? workingCharIndex : raceCharIndex;
  const homeKids = tree.children(home.id);
  const pool = [
    ...raceKids,
    ...(raceCharIndex ? tree.children(raceCharIndex.id) : []),
    ...(lookNode && lookNode.kind === 'index' ? tree.children(lookNode.id) : []),
    ...(workingCharIndex ? tree.children(workingCharIndex.id) : []),
  ];
  const pagesOf = (referenceType: string) => {
    const hits = pool.filter(
      (c) =>
        isPageKind(c.kind) &&
        c.referenceType !== null &&
        key(c.referenceType) === key(referenceType) &&
        key(subjectOf(c.displayName, tree.rowValue(c.id, p.subjectRow))) === nameKey,
    );
    if (hits.length > 1) {
      throw new RegistryError(
        'EXISTING_PAGE_AMBIGUOUS',
        `There are ${hits.length} ${referenceType} pages for “${characterName}” under ${raceNode.displayName}${lookNode ? ` and ${lookNode.displayName}` : ''}.`,
        { candidates: hits.map((h) => tree.ref(h)) },
      );
    }
    return hits[0] ? tree.ref(hits[0]) : null;
  };
  tree.preload(pool.map((c) => c.id));
  const existing = { core: pagesOf(p.referenceTypes.core), compact: pagesOf(p.referenceTypes.compact) };

  // Elsewhere under the type root, for the owner's information (never used to place anything).
  const elsewhere = tree
    .findByName(characterName)
    .filter(
      (m) =>
        m.node.path.ids.includes(root.id) &&
        m.node.parentId !== raceNode.id &&
        m.node.parentId !== raceCharIndex?.id &&
        m.node.id !== raceCharIndex?.id,
    );
  if (elsewhere.length > 0) {
    warnings.push(
      `Pages with this name exist elsewhere under ${root.displayName}: ${[...new Set(elsewhere.map((m) => m.node.path.names.join(' / ')))].join('; ')}.`,
    );
  }

  const template = (role: 'core' | 'compact') => {
    const id = type.pageTemplates.find((t) => t.role === role)?.templateId ?? null;
    if (!id) {
      throw new RegistryError(
        'TEMPLATE_NOT_CONFIGURED',
        `The type ${type.singular} has no “${role}” page template; set it on the Repository Mappings page.`,
      );
    }
    return id;
  };
  const pageName = fillName(input.kind === 'core' ? p.pageNames.core : p.pageNames.compact, characterName);
  const referenceType = input.kind === 'core' ? p.referenceTypes.core : p.referenceTypes.compact;

  let characterIndex: IndexPlan | null = null;
  let page: PagePlan;
  const pageKind = workingNode ? 'bwrk' : 'bsrc';
  if (input.kind === 'core') {
    if (existing.core) {
      page = { action: 'return_existing', node: existing.core };
      const parentId = tree.node(existing.core.id)?.parentId ?? null;
      const holder = parentId ? tree.node(parentId) : null;
      characterIndex =
        holder && holder.kind === 'index' && key(holder.displayName) === nameKey
          ? { action: 'reuse', node: tree.ref(holder) }
          : charIndex
            ? { action: 'reuse', node: tree.ref(charIndex) }
            : null;
    } else if (workingNode && raceCharIndex) {
      // v2 C2c: the character already has an index under its race; a Working set under [INDEX] Working would clash
      // with it at promotion. Refused rather than guessed (flagged for the owner).
      throw new RegistryError(
        'CHARACTER_INDEX_ELSEWHERE',
        `“${characterName}” already has an index under ${raceNode.displayName} (${raceCharIndex.path.names.join(' / ')}), so a Working Core under ${workingNode.displayName} would clash with it when promoted. Create the Core as authoritative there, or ask the owner.`,
        { existing: tree.ref(raceCharIndex) },
      );
    } else if (charIndex) {
      characterIndex = { action: 'reuse', node: tree.ref(charIndex) };
      page = {
        action: 'create',
        parentId: charIndex.id,
        rawName: `${prefix}${pageName}`,
        displayName: pageName,
        templateRole: 'core',
        templateId: template('core'),
        referenceType,
        slot: slotAmong(tree.children(charIndex.id), pageName, pageKind),
      };
    } else {
      if (!type.indexTemplateId) {
        throw new RegistryError(
          'TEMPLATE_NOT_CONFIGURED',
          `The type ${type.singular} has no index template; set it on the Repository Mappings page.`,
        );
      }
      characterIndex = {
        action: 'create',
        parentId: home.id,
        rawName: `[INDEX] ${characterName}`,
        displayName: characterName,
        templateId: type.indexTemplateId,
        slot: slotAmong(homeKids, characterName, 'index'),
      };
      page = {
        action: 'create',
        parentId: null,
        rawName: `${prefix}${pageName}`,
        displayName: pageName,
        templateRole: 'core',
        templateId: template('core'),
        referenceType,
        slot: {},
      };
    }
    if (existing.compact) {
      warnings.push(`A Compact Character Reference for “${characterName}” exists: ${existing.compact.path}.`);
    }
  } else {
    if (existing.compact) {
      page = { action: 'return_existing', node: existing.compact };
    } else {
      page = {
        action: 'create',
        parentId: home.id,
        rawName: `${prefix}${pageName}`,
        displayName: pageName,
        templateRole: 'compact',
        templateId: template('compact'),
        referenceType,
        slot: slotAmong(homeKids, pageName, pageKind),
      };
    }
    if (existing.core)
      warnings.push(`“${characterName}” already has a Character Core: ${existing.core.path}.`);
    if (charIndex) {
      warnings.push(
        `An index “${characterName}” exists under ${home.displayName}; a compact reference still goes directly under ${workingNode ? 'it' : 'the race'}.`,
      );
    }
  }

  return {
    type: { id: type.id, singular: type.singular, plural: type.plural },
    kind: input.kind,
    characterName,
    race: {
      given,
      unknown,
      entry: entry ? { id: entry.id, plural: entry.plural, singular: entry.singular } : null,
      matchedBy,
    },
    raceIndex: tree.ref(raceNode),
    home: tree.ref(home),
    working: workingNode !== null,
    species: { row: p.speciesRow, value: unknown ? p.unknownSpeciesValue : given! },
    characterIndex,
    page,
    existing,
    warnings,
    tree: meta,
  };
}

/**
 * A declared race: the taxonomy entries of the type whose index is the root's child or grandchild (Group / Race),
 * matched by plural, singular or alias (any case). Exactly one entry, or a typed error.
 */
function resolveRace(
  tree: ProjectTree,
  store: RegistryStore,
  type: RegistryType,
  root: TreeNode,
  race: string,
): { node: TreeNode; entry: TaxonomyEntry; matchedBy: 'plural' | 'singular' | 'alias' } {
  const k = key(cleanPrefixes(race).name);
  const reachable: { entry: TaxonomyEntry; node: TreeNode }[] = [];
  const missing: TaxonomyEntry[] = [];
  for (const e of store.entries(type.id)) {
    const n = tree.node(e.sourceNodeId);
    if (!n) {
      missing.push(e);
      continue;
    }
    const rel = n.path.ids.indexOf(root.id);
    if (rel < 0) continue;
    const depth = n.path.ids.length - 1 - rel;
    if (depth >= 1 && depth <= RACE_SEARCH_DEPTH) reachable.push({ entry: e, node: n });
  }
  const hits: { entry: TaxonomyEntry; node: TreeNode; by: 'plural' | 'singular' | 'alias' }[] = [];
  for (const r of reachable) {
    const by =
      key(r.entry.plural) === k
        ? 'plural'
        : key(r.entry.singular) === k
          ? 'singular'
          : r.entry.aliases.some((a) => key(a) === k)
            ? 'alias'
            : null;
    if (by) hits.push({ ...r, by });
  }
  if (hits.length === 0) {
    const gone = missing.find(
      (e) => key(e.plural) === k || key(e.singular) === k || e.aliases.some((a) => key(a) === k),
    );
    if (gone) {
      throw new RegistryError(
        'RACE_SOURCE_MISSING',
        `The taxonomy entry “${gone.plural}” matches “${race}”, but its index (${gone.sourceNodeId}) is no longer in the tree.`,
        { entryId: gone.id },
      );
    }
    const labels = [
      ...new Set(reachable.flatMap((r) => [r.entry.plural, r.entry.singular, ...r.entry.aliases])),
    ].sort((a, b) => a.localeCompare(b));
    throw new RegistryError(
      'RACE_NOT_FOUND',
      `No race “${race}” under ${root.displayName}. It is never created automatically. Available: ${labels.join(', ') || 'none (seed the taxonomy first)'}.`,
      { available: labels },
    );
  }
  if (hits.length > 1) {
    throw new RegistryError(
      'RACE_AMBIGUOUS',
      `“${race}” matches ${hits.length} races: ${hits.map((h) => h.node.path.names.join(' / ')).join('; ')}.`,
      { candidates: hits.map((h) => ({ ...tree.ref(h.node), entryId: h.entry.id, matchedBy: h.by })) },
    );
  }
  const hit = hits[0]!;
  if (hit.entry.status === 'needs_review') {
    throw new RegistryError(
      'RACE_NEEDS_REVIEW',
      `The race “${hit.entry.plural}” is waiting for review on the Repository Mappings page (${hit.entry.review.map((r) => r.message).join(' ')}).`,
      { entryId: hit.entry.id, review: hit.entry.review },
    );
  }
  return { node: hit.node, entry: hit.entry, matchedBy: hit.by };
}

/**
 * v3 F3a (ADR 0050): the race index a DECLARED race resolves to (the same rules as `create_character`: the type root's
 * children and grandchildren, by plural, singular or alias; refused when ambiguous, waiting for review or gone), or the
 * one unknown-race index for an unknown or omitted race. A declared race that does not resolve throws `RACE_NOT_FOUND`;
 * the caller decides whether to fall back (a setting pack does, with a warning). No request, no write.
 */
export function resolveRaceIndex(
  tree: ProjectTree,
  store: RegistryStore,
  input: { readonly race: string | null | undefined; readonly type?: string | undefined },
): {
  readonly unknown: boolean;
  readonly node: NodeRef;
  readonly entry: { readonly id: string; readonly plural: string; readonly singular: string } | null;
  readonly matchedBy: 'plural' | 'singular' | 'alias' | null;
} {
  tree.requireUsable();
  const type = characterType(store, input.type);
  const p = type.placement!;
  const root = type.rootIndexId ? tree.node(type.rootIndexId) : null;
  if (!root) {
    throw new RegistryError(
      'TYPE_ROOT_MISSING',
      `The type ${type.singular} has no root index in the repository tree${type.rootIndexId ? ` (${type.rootIndexId} is not in it)` : ''}.`,
      { typeId: type.id },
    );
  }
  if (isUnknownRace(input.race, p)) {
    const want = key(p.unknownIndexName);
    const hits = tree.children(root.id).filter((c) => c.kind === 'index' && key(c.displayName) === want);
    if (hits.length !== 1) {
      throw new RegistryError(
        hits.length === 0 ? 'UNKNOWN_INDEX_MISSING' : 'UNKNOWN_INDEX_AMBIGUOUS',
        hits.length === 0
          ? `There is no “[INDEX] ${p.unknownIndexName}” directly under ${root.displayName}; it is never made automatically.`
          : `There are ${hits.length} “[INDEX] ${p.unknownIndexName}” indexes directly under ${root.displayName}; exactly one is expected.`,
        hits.length > 1 ? { candidates: hits.map((h) => tree.ref(h)) } : {},
      );
    }
    return { unknown: true, node: tree.ref(hits[0]!), entry: null, matchedBy: null };
  }
  const r = resolveRace(tree, store, type, root, input.race!);
  return {
    unknown: false,
    node: tree.ref(r.node),
    entry: { id: r.entry.id, plural: r.entry.plural, singular: r.entry.singular },
    matchedBy: r.matchedBy,
  };
}

/** v2 D3 (ADR 0041): a character's race as the image pipeline needs it, by the same rules as `create_character`. */
export type CharacterRaceFolders =
  | { readonly unknown: true; readonly type: string }
  | {
      readonly unknown: false;
      readonly type: string;
      readonly race: { readonly plural: string; readonly matchedBy: 'plural' | 'singular' | 'alias' };
      /** The asset folder names below the type's asset root: `[group, race]`, or `[race]` when the race has no group. */
      readonly folders: readonly string[];
      readonly notes: readonly string[];
    };

/**
 * v2 D3 (ADR 0041): resolves a DECLARED race to its asset folder names, from the taxonomy's asset folder field (the
 * race's entry, and its group's entry when the race sits under a group). An unknown or omitted race (null, blank or one
 * of the type's unknown values) is `unknown`; a race that does not resolve throws (`RACE_NOT_FOUND`, and the other
 * refusals of `create_character`), never falling back. Makes no request and writes nothing.
 */
export function resolveCharacterRaceFolders(
  tree: ProjectTree,
  store: RegistryStore,
  input: { readonly race: string | null | undefined; readonly type?: string | undefined },
): CharacterRaceFolders {
  tree.requireUsable();
  const type = characterType(store, input.type);
  const p = type.placement!;
  if (isUnknownRace(input.race, p)) return { unknown: true, type: type.singular };
  const root = type.rootIndexId ? tree.node(type.rootIndexId) : null;
  if (!root) {
    throw new RegistryError(
      'TYPE_ROOT_MISSING',
      `The type ${type.singular} has no root index in the repository tree${type.rootIndexId ? ` (${type.rootIndexId} is not in it)` : ''}.`,
      { typeId: type.id },
    );
  }
  const r = resolveRace(tree, store, type, root, input.race!);
  const notes: string[] = [];
  const raceFolder = r.entry.assetFolder.trim() || r.entry.plural;
  if (!r.entry.assetFolder.trim())
    notes.push(`The race “${r.entry.plural}” has no asset folder name; its plural is used.`);
  const folders: string[] = [];
  if (r.node.parentId !== null && r.node.parentId !== root.id) {
    const groupNode = tree.node(r.node.parentId);
    const groupEntry = store.entries(type.id).find((e) => e.sourceNodeId === r.node.parentId) ?? null;
    const groupFolder =
      groupEntry?.assetFolder.trim() || groupEntry?.plural || groupNode?.displayName || null;
    if (groupFolder === null) {
      throw new RegistryError(
        'RACE_SOURCE_MISSING',
        `The group of the race “${r.entry.plural}” is not in the tree.`,
      );
    }
    if (!groupEntry) notes.push(`The group “${groupFolder}” has no taxonomy entry; its index name is used.`);
    folders.push(groupFolder);
  }
  folders.push(raceFolder);
  return {
    unknown: false,
    type: type.singular,
    race: { plural: r.entry.plural, matchedBy: r.matchedBy },
    folders,
    notes,
  };
}
