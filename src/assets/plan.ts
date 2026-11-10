/**
 * Placement planning (v2 A4, PLAN-v2 sections 4.6 and 9): where an image of a character belongs in the asset tree.
 *
 * `planAssetDestination` is a PURE PLANNING function: it reads the stored asset tree and repository tree (no request to
 * LegendKeeper) and writes nothing. It returns which folders already exist (reused) and which would have to be created,
 * in order, or a typed refusal. D3's image pipeline creates what the plan says; folders are NEVER moved.
 *
 * The old bridge's rules, exactly:
 *   1. A folder named exactly after the character is reused WHEREVER it already is, if there is exactly one.
 *   2. Otherwise the destination is `Characters / Group / Race / Character`, or `Characters / Race / Character` when the
 *      race sits directly under Characters. The labels come from the character page's ancestry in the repository tree
 *      (display names, so the `[INDEX]` / `[BSRC]` prefixes are gone). "Characters" is the type registry's asset root
 *      folder name when A3's data exists, otherwise the literal "Characters".
 *   3. An unknown race uses the literal folder `Undetermined / Unknown`.
 *   4. Then the literal `subfolders` (plain names, never a slash path).
 *   5. A non-folder asset with the same name where a folder is needed is a conflict; more than one folder with the
 *      character's name is an ambiguity. Neither is guessed at.
 *
 * Names match exactly (Unicode NFC, ignoring case, like the repository tree's lookups): "inae mikumo" is the folder
 * "Inae Mikumo". The plan says so in its notes when the case differs.
 */
import { RACE_SEARCH_DEPTH } from '../registry/classify.js';
import type { TreeQueries } from '../tree/queries.js';
import type { TreeNode } from '../tree/types.js';
import { nameKey } from './classify.js';
import type { AssetQueries } from './queries.js';
import type { AssetFolder, AssetMeta } from './types.js';

/** The literal folder (and index) for an unknown race: one folder whose name contains " / ". */
export const UNKNOWN_RACE_FOLDER = 'Undetermined / Unknown';
/** The asset root folder of characters when the type registry does not say otherwise. */
export const DEFAULT_CHARACTER_ASSET_ROOT = 'Characters';
/** LegendKeeper's folder-name limit. */
const NAME_MAX = 200;
const DEFAULT_CORE_REFERENCE_TYPE = 'Character Core';

export type PlanRequest =
  | {
      readonly characterResourceId?: string | undefined;
      readonly characterName?: string | undefined;
      /** Literal folder names under the character's folder, in order. */
      readonly subfolders?: readonly string[] | undefined;
      readonly folderPath?: undefined;
    }
  | {
      /** A literal path from the library's root, one folder name per entry. */
      readonly folderPath: readonly string[];
      readonly characterResourceId?: undefined;
      readonly characterName?: undefined;
      readonly subfolders?: undefined;
    };

/** The parts of A3's character type that placement planning uses. */
export interface CharacterTypeInfo {
  /** The asset root folder (default "Characters"). */
  readonly assetRootFolder?: string | null;
  /** The Characters index page of the repository tree (used when the project has no `charactersRootId` setting). */
  readonly rootIndexId?: string | null;
  /** The index (and asset folder) unknown races go to (default "Undetermined / Unknown"). */
  readonly unknownIndexName?: string | null;
  /** The Reference Type of a Character Core page (default "Character Core"). */
  readonly coreReferenceType?: string | null;
}

/** What the plan goes by, resolved once from the type registry and the old bridge's literals. */
interface Rules {
  readonly rootName: string;
  readonly unknownFolder: string;
  readonly coreReferenceType: string;
  readonly typeRootId: string | null;
}

const clean = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null);

function rulesFor(projectId: string, deps: PlanDeps): Rules {
  const t = deps.characterType?.(projectId) ?? null;
  return {
    rootName: clean(t?.assetRootFolder) ?? DEFAULT_CHARACTER_ASSET_ROOT,
    unknownFolder: clean(t?.unknownIndexName) ?? UNKNOWN_RACE_FOLDER,
    coreReferenceType: clean(t?.coreReferenceType) ?? DEFAULT_CORE_REFERENCE_TYPE,
    typeRootId: clean(t?.rootIndexId),
  };
}

export interface PlanDeps {
  readonly assets: Pick<
    AssetQueries,
    'status' | 'children' | 'findFoldersByName' | 'findAssetsByName' | 'folder'
  >;
  readonly tree: Pick<TreeQueries, 'status' | 'node' | 'children' | 'findByName'>;
  /** The Characters root page (the project's `charactersRootId` setting), or null to look for it by name. */
  readonly charactersRootId?: (projectId: string) => string | null;
  /**
   * What the type registry (A3) says about the project's character type, or null when it has none: the runtime wires
   * it. Every field is optional; what is missing falls back to the old bridge's literals.
   */
  readonly characterType?: (projectId: string) => CharacterTypeInfo | null;
}

export interface PlanStep {
  readonly name: string;
  readonly action: 'reuse' | 'create';
  /** The existing folder's id; null for a folder that would be created. */
  readonly folderId: string | null;
  /**
   * The folder it is (or would be) in: null for the library's root, and also for a folder that would be created below
   * another folder that does not exist yet (its parent is the step before it; `path` says where).
   */
  readonly parentFolderId: string | null;
  /** From the root to this folder, both included. */
  readonly path: readonly string[];
}

export interface AssetPlan {
  readonly project: string;
  /** `existing_character_folder`: rule 1; `character_path`: rule 2 or 3; `folder_path`: a literal path. */
  readonly mode: 'existing_character_folder' | 'character_path' | 'folder_path';
  readonly character: {
    readonly name: string;
    /** The page the race labels came from (null when none was found, or the folder already existed). */
    readonly resourceId: string | null;
    /** Null when not needed (an existing folder was reused) or unknown. */
    readonly group: string | null;
    readonly race: string | null;
    readonly raceSource: 'page_ancestry' | 'unknown_race' | 'not_needed';
  } | null;
  /** Every folder from the root to the destination, in order. */
  readonly steps: readonly PlanStep[];
  readonly reused: readonly PlanStep[];
  readonly wouldCreate: readonly PlanStep[];
  readonly destination: {
    readonly path: readonly string[];
    /** The destination folder's id, or null when it would be created. */
    readonly folderId: string | null;
    readonly exists: boolean;
  };
  readonly notes: readonly string[];
  readonly assetTree: Pick<AssetMeta, 'status' | 'reason' | 'confirmedAt'>;
}

export type PlanErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_NAME'
  | 'ASSET_TREE_NOT_READY'
  | 'REPOSITORY_TREE_NOT_READY'
  | 'CHARACTER_NOT_FOUND'
  | 'NOT_A_CHARACTER'
  | 'CHARACTERS_ROOT_UNKNOWN'
  | 'CHARACTER_PAGE_AMBIGUOUS'
  | 'ANCESTRY_TOO_DEEP'
  /** More than one folder with that name where one is needed (the typed ambiguity). */
  | 'AMBIGUOUS_FOLDER'
  /** An asset that is not a folder has the name where a folder is needed (the typed conflict). */
  | 'ASSET_NAME_CONFLICT';

export interface PlanError {
  readonly code: PlanErrorCode;
  readonly message: string;
  /** Machine-readable detail: the candidates of an ambiguity, the assets of a conflict, and so on. */
  readonly details?: Record<string, unknown>;
}

export type PlanResult =
  { readonly ok: true; readonly plan: AssetPlan } | { readonly ok: false; readonly error: PlanError };

const fail = (code: PlanErrorCode, message: string, details?: Record<string, unknown>): PlanResult => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) },
});

/** A name as a folder name: spaces at the ends removed; empty, too long, control characters and slashes refused. */
function cleanName(
  raw: unknown,
  what: string,
  slashOk: string,
): { ok: true; name: string } | { ok: false; error: PlanError } {
  if (typeof raw !== 'string') {
    return { ok: false, error: { code: 'INVALID_NAME', message: `${what} must be text.` } };
  }
  const name = raw.trim();
  if (name === '' || name.length > NAME_MAX) {
    return {
      ok: false,
      error: { code: 'INVALID_NAME', message: `${what} must be 1 to ${NAME_MAX} characters.` },
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return {
      ok: false,
      error: { code: 'INVALID_NAME', message: `${what} must not contain control characters.` },
    };
  }
  if (name.includes('/') && name !== slashOk) {
    return {
      ok: false,
      error: {
        code: 'INVALID_NAME',
        message: `${what} “${name}” contains a slash. Give one plain folder name per entry, never a slash path.`,
      },
    };
  }
  return { ok: true, name };
}

/**
 * Plans where an asset for a character (or a literal folder path) goes. Reads the stored models only; never writes and
 * never calls LegendKeeper. Domain outcomes (ambiguity, conflict, unknown character) are returned, not thrown.
 */
export function planAssetDestination(projectId: string, request: PlanRequest, deps: PlanDeps): PlanResult {
  const meta = deps.assets.status(projectId);
  if (meta.status === 'not_built' || meta.status === 'building') {
    return fail(
      'ASSET_TREE_NOT_READY',
      `The asset tree of this project is ${meta.status === 'building' ? 'still being built' : 'not built yet'}, so no folder can be told from one that is missing. ${meta.reason ?? ''}`.trim(),
    );
  }
  const assetTree = { status: meta.status, reason: meta.reason, confirmedAt: meta.confirmedAt };
  const notes: string[] = [];
  const rules = rulesFor(projectId, deps);
  if (meta.status === 'stale')
    notes.push(`The asset tree is stale: ${meta.reason ?? 'it has not been confirmed lately'}`);

  // ---- a literal path
  if (request.folderPath !== undefined) {
    if (
      request.characterResourceId !== undefined ||
      request.characterName !== undefined ||
      request.subfolders !== undefined
    ) {
      return fail(
        'INVALID_REQUEST',
        'folderPath cannot be combined with characterResourceId, characterName or subfolders.',
      );
    }
    if (!Array.isArray(request.folderPath) || request.folderPath.length === 0) {
      return fail('INVALID_REQUEST', 'folderPath must list at least one folder name.');
    }
    const names: string[] = [];
    for (const [i, raw] of request.folderPath.entries()) {
      const c = cleanName(raw, `folderPath[${i}]`, rules.unknownFolder);
      if (!c.ok) return { ok: false, error: c.error };
      names.push(c.name);
    }
    const walk = walkPath(projectId, deps, null, [], names, notes);
    if (!walk.ok) return walk.result;
    return done(projectId, 'folder_path', null, walk.value, notes, assetTree);
  }

  // ---- a character
  const hasId = request.characterResourceId !== undefined;
  const hasName = request.characterName !== undefined;
  if (hasId === hasName) {
    return fail(
      'INVALID_REQUEST',
      'Give either characterResourceId or characterName (exactly one), or a folderPath.',
    );
  }
  const subfolders: string[] = [];
  for (const [i, raw] of (request.subfolders ?? []).entries()) {
    const c = cleanName(raw, `subfolders[${i}]`, rules.unknownFolder);
    if (!c.ok) return { ok: false, error: c.error };
    subfolders.push(c.name);
  }

  // The character's name, and (when the request names a page) the race labels from its ancestry.
  let name: string;
  let page: PageRace | null = null;
  if (hasId) {
    const r = characterFromPage(projectId, deps, request.characterResourceId, rules);
    if (!r.ok) return r.result;
    page = r.value;
    name = page.name;
  } else {
    const c = cleanName(request.characterName, 'characterName', rules.unknownFolder);
    if (!c.ok) return { ok: false, error: c.error };
    name = c.name;
  }

  // Rule 1: a folder named exactly after the character, wherever it is.
  const existing = deps.assets.findFoldersByName(projectId, name).data;
  if (existing.length > 1) {
    return fail(
      'AMBIGUOUS_FOLDER',
      `${existing.length} folders are named “${name}” (${existing.map((f) => f.path.names.join(' / ')).join('; ')}). Say which one by giving a folderPath. Nothing was guessed.`,
      { name, candidates: existing.map((f) => ({ id: f.id, path: f.path.names })) },
    );
  }
  if (existing.length === 1) {
    const f = existing[0]!;
    if (f.name !== name) notes.push(`The folder is named “${f.name}”; names are compared ignoring case.`);
    const steps: PlanStep[] = f.path.ids.map((id, i) => ({
      name: f.path.names[i]!,
      action: 'reuse',
      folderId: id,
      parentFolderId: i === 0 ? null : f.path.ids[i - 1]!,
      path: f.path.names.slice(0, i + 1),
    }));
    const walk = walkPath(projectId, deps, f.id, f.path.names, subfolders, notes);
    if (!walk.ok) return walk.result;
    return done(
      projectId,
      'existing_character_folder',
      {
        name,
        resourceId: page?.resourceId ?? null,
        group: null,
        race: null,
        raceSource: 'not_needed',
      },
      [...steps, ...walk.value],
      notes,
      assetTree,
    );
  }

  // Rule 2 and 3: Characters / Group / Race / Character, or the unknown-race folder.
  if (page === null) {
    const r = characterFromName(projectId, deps, name, rules);
    if (!r.ok) return r.result;
    page = r.value;
  }
  let labels: string[];
  let raceSource: 'page_ancestry' | 'unknown_race';
  if (page.chain === null) {
    labels = [rules.unknownFolder];
    raceSource = 'unknown_race';
    notes.push(page.reason ?? 'The race is unknown.');
  } else if (page.chain.length === 0) {
    labels = [rules.unknownFolder];
    raceSource = 'unknown_race';
    notes.push('The character page sits directly under the Characters index, so no race is known.');
  } else if (page.chain.length <= RACE_SEARCH_DEPTH) {
    labels = [...page.chain];
    raceSource = 'page_ancestry';
  } else {
    return fail(
      'ANCESTRY_TOO_DEEP',
      `The character page is ${page.chain.length} levels below Characters (${page.chain.join(' / ')}); the rules know a group and a race only. Give a folderPath.`,
      { chain: page.chain },
    );
  }
  const walk = walkPath(projectId, deps, null, [], [rules.rootName, ...labels, name, ...subfolders], notes);
  if (!walk.ok) return walk.result;
  const group = raceSource === 'page_ancestry' && labels.length === 2 ? labels[0]! : null;
  const race = raceSource === 'page_ancestry' ? labels.at(-1)! : rules.unknownFolder;
  return done(
    projectId,
    'character_path',
    { name, resourceId: page.resourceId, group, race, raceSource },
    walk.value,
    notes,
    assetTree,
  );
}

function done(
  projectId: string,
  mode: AssetPlan['mode'],
  character: AssetPlan['character'],
  steps: readonly PlanStep[],
  notes: readonly string[],
  assetTree: AssetPlan['assetTree'],
): PlanResult {
  const last = steps.at(-1)!;
  return {
    ok: true,
    plan: {
      project: projectId,
      mode,
      character,
      steps,
      reused: steps.filter((s) => s.action === 'reuse'),
      wouldCreate: steps.filter((s) => s.action === 'create'),
      destination: { path: last.path, folderId: last.folderId, exists: last.action === 'reuse' },
      notes,
      assetTree,
    },
  };
}

type Walked = { ok: true; value: PlanStep[] } | { ok: false; result: PlanResult };

/**
 * Goes down `segments` from a folder (null: the root), reusing a folder of each name where there is exactly one and
 * planning to create it where there is none. From the first folder that would be created on, nothing below it exists.
 * Several folders of one name in one place, or a non-folder asset where a folder is needed, stop the walk.
 */
function walkPath(
  projectId: string,
  deps: PlanDeps,
  startFolderId: string | null,
  startPath: readonly string[],
  segments: readonly string[],
  notes: string[],
): Walked {
  const steps: PlanStep[] = [];
  let parentId = startFolderId;
  let path = [...startPath];
  let creating = false;
  for (const seg of segments) {
    path = [...path, seg];
    if (creating) {
      steps.push({ name: seg, action: 'create', folderId: null, parentFolderId: null, path });
      continue;
    }
    const matches = deps.assets
      .children(projectId, parentId)
      .data.filter((f: AssetFolder) => f.name === seg || nameKey(f.name) === nameKey(seg));
    if (matches.length > 1) {
      return {
        ok: false,
        result: fail(
          'AMBIGUOUS_FOLDER',
          `${matches.length} folders named “${seg}” are in “${path.slice(0, -1).join(' / ') || 'the root'}”. Nothing was guessed.`,
          {
            name: seg,
            in: path.slice(0, -1),
            candidates: matches.map((f: AssetFolder) => ({ id: f.id, path: f.path.names })),
          },
        ),
      };
    }
    if (matches.length === 1) {
      const f = matches[0]!;
      if (f.name !== seg)
        notes.push(`The folder “${f.name}” is used for “${seg}”; names are compared ignoring case.`);
      steps.push({
        name: f.name,
        action: 'reuse',
        folderId: f.id,
        parentFolderId: parentId,
        path: [...path.slice(0, -1), f.name],
      });
      parentId = f.id;
      path = [...path.slice(0, -1), f.name];
      continue;
    }
    const blockers = deps.assets.findAssetsByName(projectId, seg, { folderId: parentId }).data;
    if (blockers.length > 0) {
      return {
        ok: false,
        result: fail(
          'ASSET_NAME_CONFLICT',
          `“${seg}” is needed as a folder in “${path.slice(0, -1).join(' / ') || 'the root'}”, but ${blockers.length === 1 ? 'an asset' : `${blockers.length} assets`} with that name (${blockers.map((b) => `${b.type.toLowerCase()} ${b.id}`).join(', ')}) ${blockers.length === 1 ? 'is' : 'are'} there. Nothing was moved or renamed.`,
          {
            name: seg,
            in: path.slice(0, -1),
            assets: blockers.map((b) => ({ id: b.id, name: b.name, type: b.type })),
          },
        ),
      };
    }
    steps.push({ name: seg, action: 'create', folderId: null, parentFolderId: parentId, path });
    creating = true;
  }
  return { ok: true, value: steps };
}

// ================================================================================================ the character page

/** What the repository tree says about a character page's place. */
interface PageRace {
  readonly name: string;
  readonly resourceId: string | null;
  /** The labels between the Characters index and the character (group, race), or null when no page was found. */
  readonly chain: string[] | null;
  readonly reason?: string;
}

type Found<T> = { ok: true; value: T } | { ok: false; result: PlanResult };

function treeUsable(deps: PlanDeps, projectId: string): PlanResult | null {
  const t = deps.tree.status(projectId);
  if (t.status === 'not_configured' || t.status === 'not_built' || t.status === 'building') {
    return fail(
      'REPOSITORY_TREE_NOT_READY',
      `The repository tree of this project is ${t.status.replace('_', ' ')}, so a character's race cannot be read from it. ${t.reason ?? ''}`.trim(),
    );
  }
  return null;
}

/** The Characters index page: the `charactersRootId` setting, or the one `[INDEX]` page of that name under the root. */
function charactersRoot(projectId: string, deps: PlanDeps, rules: Rules): Found<TreeNode> {
  const rootName = rules.rootName;
  // The project's own setting wins; then the type registry's root index page; then the one [INDEX] page of that name.
  const id = deps.charactersRootId?.(projectId) ?? rules.typeRootId;
  if (id) {
    const n = deps.tree.node(projectId, id).data;
    if (!n) {
      return {
        ok: false,
        result: fail(
          'CHARACTERS_ROOT_UNKNOWN',
          `The Characters root ${id} (the project's charactersRootId setting, or the character type's root index) is not in the repository tree.`,
        ),
      };
    }
    return { ok: true, value: n };
  }
  const repoRoot = deps.tree.status(projectId).rootId;
  const candidates = repoRoot
    ? deps.tree
        .children(projectId, repoRoot)
        .data.filter((n) => n.kind === 'index' && nameKey(n.displayName) === nameKey(rootName))
    : [];
  if (candidates.length !== 1) {
    return {
      ok: false,
      result: fail(
        'CHARACTERS_ROOT_UNKNOWN',
        candidates.length === 0
          ? `No [INDEX] page named “${rootName}” is directly under the AI REPOSITORY. Set the project's charactersRootId.`
          : `${candidates.length} [INDEX] pages named “${rootName}” are directly under the AI REPOSITORY. Set the project's charactersRootId.`,
      ),
    };
  }
  return { ok: true, value: candidates[0]! };
}

/**
 * A character page's name and the labels between the Characters index and the character, from the page's ancestry.
 * A Character Core page sits below the character's own `[INDEX]` page: that index gives the name and is not a label.
 */
function raceOfPage(
  projectId: string,
  deps: PlanDeps,
  node: TreeNode,
  rootId: string,
  rules: Rules,
): PageRace | null {
  const at = node.path.ids.indexOf(rootId);
  if (at < 0 || node.id === rootId) return null;
  const below = node.path.names.slice(at + 1); // ends with the page itself
  let name = node.displayName;
  let chain = below.slice(0, -1);
  if (node.referenceType === rules.coreReferenceType && chain.length > 0 && node.parentId !== null) {
    const parent = deps.tree.node(projectId, node.parentId).data;
    if (parent && parent.kind === 'index') {
      name = parent.displayName;
      chain = chain.slice(0, -1);
    }
  }
  return { name, resourceId: node.id, chain };
}

function characterFromPage(
  projectId: string,
  deps: PlanDeps,
  resourceId: string,
  rules: Rules,
): Found<PageRace> {
  const unusable = treeUsable(deps, projectId);
  if (unusable) return { ok: false, result: unusable };
  const node = deps.tree.node(projectId, resourceId).data;
  if (!node) {
    return {
      ok: false,
      result: fail('CHARACTER_NOT_FOUND', `No page ${resourceId} is in the repository tree of this project.`),
    };
  }
  const root = charactersRoot(projectId, deps, rules);
  if (!root.ok) return root;
  const r = raceOfPage(projectId, deps, node, root.value.id, rules);
  if (!r) {
    return {
      ok: false,
      result: fail(
        'NOT_A_CHARACTER',
        `“${node.displayName}” (${node.id}) is not under the Characters index.`,
        {
          path: node.path.names,
        },
      ),
    };
  }
  return { ok: true, value: r };
}

/**
 * The race labels for a character known by name only: every page under the Characters index that answers to the name
 * (exactly, by any of its names) is looked at; all must agree. No page at all means the race is unknown.
 */
function characterFromName(projectId: string, deps: PlanDeps, name: string, rules: Rules): Found<PageRace> {
  const unusable = treeUsable(deps, projectId);
  if (unusable) return { ok: false, result: unusable };
  const root = charactersRoot(projectId, deps, rules);
  if (!root.ok) return root;
  const seen = new Map<string, PageRace>();
  for (const m of deps.tree.findByName(projectId, name).data) {
    const r = raceOfPage(projectId, deps, m.node, root.value.id, rules);
    if (r && r.chain) seen.set(JSON.stringify(r.chain), { ...r, name });
  }
  if (seen.size === 0) {
    return {
      ok: true,
      value: {
        name,
        resourceId: null,
        chain: null,
        reason: `No page named “${name}” is under the Characters index, so the race is unknown.`,
      },
    };
  }
  if (seen.size > 1) {
    return {
      ok: false,
      result: fail(
        'CHARACTER_PAGE_AMBIGUOUS',
        `Pages named “${name}” sit in different places under Characters (${[...seen.values()].map((p) => p.chain!.join(' / ') || '(directly under Characters)').join('; ')}). Give characterResourceId.`,
        { name, places: [...seen.values()].map((p) => ({ resourceId: p.resourceId, chain: p.chain })) },
      ),
    };
  }
  return { ok: true, value: [...seen.values()][0]! };
}
