/**
 * Where an uploaded image goes (v2 D3, ADR 0041; PLAN-v2 section 9, the old bridge's folder rules), from the asset tree
 * and the type registry. A pure plan: no request, no write. The upload or placement job then creates what it says.
 *
 * - `folder`: an asset folder id, or a path from the library's root (`Characters / Beastkin / Qishen / Mehrana`).
 * - `for_character` (a name and race, the rules of `create_character`): a folder named after the character is reused
 *   wherever it is (several: refused, listed); otherwise `Characters / Group / Race / Character`, or
 *   `Characters / Race / Character` for a race with no group, the names from the taxonomy's asset folder field. An unknown
 *   or omitted race is `Undetermined / Unknown`; a declared race that does not resolve fails and never falls back.
 * - `for_page`: the character of a character page (Core, Reference or the character's index), by the same rules with
 *   the race read from where the page is; any other page needs an explicit `folder`.
 * - `subfolders`: literal folder names appended to the derived path, as a list or as ONE path written like the folder chain
 *   (`Wardrobe`, `Wardrobe / Qipao`): split on `/`, each part trimmed; an empty part, `.` and `..` are refused
 *   ({@link parseSubfolders}). The folder rules are unchanged: reuse what exists, create what is missing in order, a
 *   non-folder with the same name is a conflict.
 *
 * Missing folders are created in order; folders are never moved; a non-folder asset with a needed folder's name is a
 * conflict (refused).
 */
import {
  planAssetDestination,
  planUnderFolder,
  splitFolderPath,
  UNKNOWN_RACE_FOLDER,
  type AssetPlan,
  type PlanDeps,
  type PlanError,
} from '../assets/plan.js';
import { RegistryError, type ProjectTypes } from '../registry/index.js';

export interface DestinationInput {
  readonly folder?: string | readonly string[] | undefined;
  readonly for_page?: string | undefined;
  readonly for_character?:
    | { readonly name: string; readonly race?: string | null | undefined; readonly type?: string | undefined }
    | undefined;
  /** A list of folder names, or one path string (`"Wardrobe / Qipao"`): see {@link parseSubfolders}. */
  readonly subfolders?: string | readonly string[] | undefined;
}

export interface DestinationDeps {
  readonly plan: PlanDeps;
  readonly types: (projectId: string) => ProjectTypes;
}

export interface DestinationError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type DestinationResult =
  | {
      readonly ok: true;
      readonly plan: AssetPlan;
      /** What was asked and how it was read, for the answer and the proposal. */
      readonly described: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: DestinationError };

const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SUBFOLDERS = 10;

const badSubfolder = (message: string): { ok: false; error: DestinationError } => ({
  ok: false,
  error: { code: 'INVALID_SUBFOLDER', message },
});

/**
 * The subfolder path as a list of folder names, for the existing `subfolders` list. A string is split on `/` and each part
 * trimmed (`"Wardrobe / Qipao"` is `["Wardrobe", "Qipao"]`); a list is taken as it is, each name trimmed. An empty part (a
 * slash at either end, two in a row, a blank name), `.` and `..` are refused with a message that says which and shows how to
 * write it. A name's length and characters are checked by the planner, as for any folder name. Used by every route in (the
 * MCP tool, the dashboard, a stored intended destination), so they all read it the same way.
 */
export function parseSubfolders(
  input: string | readonly string[] | undefined,
):
  { readonly ok: true; readonly names: string[] } | { readonly ok: false; readonly error: DestinationError } {
  if (input === undefined) return { ok: true, names: [] };
  const given = typeof input === 'string' ? input : null;
  if (given !== null && given.trim() === '') {
    return badSubfolder(
      'The subfolder is empty. Write it like the folder chain, for example “Wardrobe” or “Wardrobe / Qipao”, or leave it out.',
    );
  }
  const parts = (given !== null ? given.split('/') : [...(input as readonly string[])]).map((p) =>
    typeof p === 'string' ? p.trim() : p,
  );
  const shown = given ?? parts.join(' / ');
  const names: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') return badSubfolder('A subfolder must be text.');
    if (part === '') {
      return badSubfolder(
        `The subfolder path “${shown.trim()}” has an empty part (a slash at the start or the end, two slashes in a row, or a blank name). Write it like “Wardrobe / Qipao”.`,
      );
    }
    if (part === '.' || part === '..') {
      return badSubfolder(
        `“${part}” is not a folder name: a subfolder path goes down from the destination, never to “.” or “..”. Write it like “Wardrobe / Qipao”.`,
      );
    }
    names.push(part);
  }
  if (names.length > MAX_SUBFOLDERS) {
    return badSubfolder(`At most ${MAX_SUBFOLDERS} subfolder levels; ${names.length} given.`);
  }
  return { ok: true, names };
}

const fromPlan = (
  r: ReturnType<typeof planAssetDestination>,
  described: Record<string, unknown>,
): DestinationResult =>
  r.ok ? { ok: true, plan: r.plan, described } : { ok: false, error: planError(r.error) };

function planError(e: PlanError): DestinationError {
  return { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
}

function registryError(e: RegistryError): DestinationError {
  return {
    code: e.code,
    message: e.message,
    ...(e.details ? { details: e.details } : {}),
  };
}

/** Plans the destination (see the module comment). */
export function planDestination(
  projectId: string,
  input: DestinationInput,
  deps: DestinationDeps,
): DestinationResult {
  const parsed = parseSubfolders(input.subfolders);
  if (!parsed.ok) return parsed;
  const subfolders = parsed.names;
  const given = [input.folder !== undefined, input.for_page !== undefined, input.for_character !== undefined];
  if (input.for_character !== undefined && (input.folder !== undefined || input.for_page !== undefined)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_DESTINATION',
        message: 'for_character cannot be combined with folder or for_page.',
      },
    };
  }
  if (!given.some(Boolean)) {
    return {
      ok: false,
      error: {
        code: 'DESTINATION_REQUIRED',
        message: 'Give a destination: folder, for_page or for_character (or stage: true to stage the image).',
      },
    };
  }

  // ---- for_page: a character page gives the character; any other page needs a folder.
  let pageNote: Record<string, unknown> | null = null;
  if (input.for_page !== undefined) {
    const types = deps.types(projectId);
    let page;
    try {
      page = types.resolveOne(input.for_page);
    } catch (e) {
      if (e instanceof RegistryError) return { ok: false, error: registryError(e) };
      throw e;
    }
    const role = types.characterRole(page.id);
    pageNote = {
      id: page.id,
      name: page.displayName,
      ...(role ? { role: role.role, character: role.subject } : {}),
    };
    if (role && input.folder === undefined) {
      // The race is read from where the page is (its ancestry under Characters).
      const r = planAssetDestination(
        projectId,
        {
          characterResourceId: page.id,
          ...(role.role === 'compact' ? { subjectName: role.subject } : {}),
          ...(subfolders.length ? { subfolders } : {}),
        },
        deps.plan,
      );
      if (!r.ok && r.error.code === 'NOT_A_CHARACTER') {
        return {
          ok: false,
          error: {
            code: 'PAGE_NOT_UNDER_CHARACTERS',
            message:
              `“${page.displayName}” is a ${role.role} page of “${role.subject}”, but it is not under the Characters index ` +
              '(a Working or Archived page), so its race cannot be read from where it is. Give for_character with the ' +
              'name and race, or a folder.',
            details: { page: pageNote },
          },
        };
      }
      return fromPlan(r, { for_page: pageNote, ...(subfolders.length ? { subfolders } : {}) });
    }
    if (input.folder === undefined) {
      return {
        ok: false,
        error: {
          code: 'FOLDER_REQUIRED',
          message: `“${page.displayName}” is not a character page (Core, Reference or a character's index), so no folder can be derived from it. Give a folder as well.`,
          details: { page: pageNote },
        },
      };
    }
  }

  // ---- folder: an id, or a path.
  if (input.folder !== undefined) {
    const f = input.folder;
    const described = {
      folder: f,
      ...(pageNote ? { for_page: pageNote } : {}),
      ...(subfolders.length ? { subfolders } : {}),
    };
    if (
      typeof f === 'string' &&
      FOLDER_ID.test(f.trim()) &&
      deps.plan.assets.folder(projectId, f.trim()).data
    ) {
      return fromPlan(planUnderFolder(projectId, f.trim(), subfolders, deps.plan), described);
    }
    const names = typeof f === 'string' ? splitFolderPath(f, unknownFolderOf(projectId, deps)) : [...f];
    if (names.length === 0) {
      return {
        ok: false,
        error: { code: 'INVALID_DESTINATION', message: 'The folder path names no folder.' },
      };
    }
    return fromPlan(
      planAssetDestination(projectId, { folderPath: [...names, ...subfolders] }, deps.plan),
      described,
    );
  }

  // ---- for_character: the rules of create_character.
  const fc = input.for_character!;
  let raceLabels: readonly string[] | null;
  const notes: string[] = [];
  let race: Record<string, unknown>;
  try {
    const r = deps.types(projectId).raceFolders(fc.race ?? null, fc.type);
    raceLabels = r.unknown ? null : r.folders;
    race = r.unknown
      ? { given: fc.race ?? null, unknown: true }
      : { given: fc.race, matched: r.race.plural, by: r.race.matchedBy };
    if (!r.unknown) notes.push(...r.notes);
  } catch (e) {
    if (e instanceof RegistryError) return { ok: false, error: registryError(e) };
    throw e;
  }
  const r = planAssetDestination(
    projectId,
    { characterName: fc.name, raceLabels, ...(subfolders.length ? { subfolders } : {}) },
    deps.plan,
  );
  if (r.ok && notes.length) {
    return {
      ok: true,
      plan: { ...r.plan, notes: [...r.plan.notes, ...notes] },
      described: { for_character: { name: fc.name, race }, ...(subfolders.length ? { subfolders } : {}) },
    };
  }
  return fromPlan(r, {
    for_character: { name: fc.name, race },
    ...(subfolders.length ? { subfolders } : {}),
  });
}

/** The project's staging folder, found by name in the library's root or to be created. */
export function planStaging(projectId: string, folderName: string, deps: DestinationDeps): DestinationResult {
  return fromPlan(planUnderFolder(projectId, null, [folderName], deps.plan), { staging: folderName });
}

function unknownFolderOf(projectId: string, deps: DestinationDeps): string {
  const n = deps.plan.characterType?.(projectId)?.unknownIndexName;
  return n && n.trim() ? n.trim() : UNKNOWN_RACE_FOLDER;
}
