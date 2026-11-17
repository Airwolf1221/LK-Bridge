/**
 * Where an uploaded image goes (v2 D3, ADR 0041; PLAN-v2 section 9, the old bridge's folder rules), from the asset tree
 * and the type registry. A pure plan: no request, no write. The upload or placement job then creates what it says.
 *
 * - `folder`: an asset folder id, or a path from the library's root (`Characters / Beastkin / Qishen / Mehrana`).
 * - `for_character` (a name and race, the rules of `create_character`): `Characters / Group / Race / Character`, or
 *   `Characters / Race / Character` for a race with no group, the names from the taxonomy's asset folder field, and only
 *   that exact path (ADR 0057 decision 8: a folder named after the character elsewhere is never used; an ambiguous or
 *   blocked path is `ART_FOLDER_AMBIGUOUS`). An unknown
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
import { RegistryError, type NodeRef, type ProjectTypes } from '../registry/index.js';

export interface DestinationInput {
  readonly folder?: string | readonly string[] | undefined;
  readonly for_page?: string | undefined;
  readonly for_character?:
    | { readonly name: string; readonly race?: string | null | undefined; readonly type?: string | undefined }
    | undefined;
  /** A list of folder names, or one path string (`"Wardrobe / Qipao"`): see {@link parseSubfolders}. */
  readonly subfolders?: string | readonly string[] | undefined;
  /**
   * v2 E3b (ADR 0045): set only by the tool layer, after ONE live read of the character's Core or Reference, when the
   * repository tree did not hold its Race / Species fact (`RACE_NOT_READ`). Never part of a destination as given or kept.
   */
  readonly pageRace?: { readonly core: string; readonly race: string | null } | undefined;
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
    if (input.folder === undefined) {
      // A character page under the Characters index: the race is read from where the page is (its ancestry).
      if (role) {
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
          // A Working or Archived page (or a Core outside the Characters index): its race is its Race / Species fact.
          return planFromCharacterFact(projectId, page, pageNote, input, subfolders, deps);
        }
        return fromPlan(r, { for_page: pageNote, ...(subfolders.length ? { subfolders } : {}) });
      }
      // Any other page: a character's index under Working or Archived, or a specialist page of a character.
      return planFromCharacterFact(projectId, page, pageNote, input, subfolders, deps);
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
  return planForCharacter(projectId, input.for_character!, subfolders, deps, null);
}

/**
 * The rules of `create_character` for a declared name and race: Characters / Group / Race / Name, that exact path only
 * (ADR 0057 decision 8). An unknown or omitted race goes to `Undetermined / Unknown`; a declared
 * race that does not resolve fails and never falls back. `from` (for_page) is the page the character was found from.
 */
function planForCharacter(
  projectId: string,
  fc: NonNullable<DestinationInput['for_character']>,
  subfolders: readonly string[],
  deps: DestinationDeps,
  from: { readonly page: Record<string, unknown>; readonly raceNote: string } | null,
): DestinationResult {
  let raceLabels: readonly string[] | null;
  const notes: string[] = from ? [from.raceNote] : [];
  let race: Record<string, unknown>;
  try {
    const r = deps.types(projectId).raceFolders(fc.race ?? null, fc.type);
    raceLabels = r.unknown ? null : r.folders;
    race = r.unknown
      ? { given: fc.race ?? null, unknown: true }
      : { given: fc.race, matched: r.race.plural, by: r.race.matchedBy };
    if (!r.unknown) notes.push(...r.notes);
  } catch (e) {
    if (e instanceof RegistryError) {
      const err = registryError(e);
      // The race came from the character's own page: say what to pass instead (nothing is guessed).
      return from
        ? {
            ok: false,
            error: {
              ...err,
              message: `${err.message} (the race was read from ${from.raceNote.replace(/^The race /, '')}) Pass for_character { name: "${fc.name}", race } with the right race, or a folder.`,
            },
          }
        : { ok: false, error: err };
    }
    throw e;
  }
  const r = planAssetDestination(
    projectId,
    { characterName: fc.name, raceLabels, ...(subfolders.length ? { subfolders: [...subfolders] } : {}) },
    deps.plan,
  );
  const described = {
    ...(from ? { for_page: from.page } : {}),
    for_character: { name: fc.name, race },
    ...(subfolders.length ? { subfolders: [...subfolders] } : {}),
  };
  if (r.ok && notes.length) {
    return { ok: true, plan: { ...r.plan, notes: [...r.plan.notes, ...notes] }, described };
  }
  return fromPlan(r, described);
}

/**
 * v2 E3b (ADR 0045): a page that is not under the Characters index leads to its character anyway: a Working or Archived
 * Core or Reference, a character's index, or a specialist page (`{name} - Art`: its subject is the character). The race is
 * the Race / Species fact of the character's Core or Reference, read from the repository tree; when the tree holds none,
 * `RACE_NOT_READ` asks the tool layer for ONE live read of that page and plans again with it (`pageRace`). Only when no
 * route works is the page refused, and the message says exactly what to pass.
 */
function planFromCharacterFact(
  projectId: string,
  page: NodeRef,
  pageNote: Record<string, unknown>,
  input: DestinationInput,
  subfolders: readonly string[],
  deps: DestinationDeps,
): DestinationResult {
  const types = deps.types(projectId);
  const c = types.characterOfPage(page.id);
  if (!c.ok) {
    const name = c.subject ?? page.displayName;
    if (c.reason === 'several') {
      return {
        ok: false,
        error: {
          code: 'CHARACTER_AMBIGUOUS',
          message:
            `“${page.displayName}” belongs to “${name}”, but ${c.candidates.length} Character Cores or References of that name ` +
            `could be its character (${c.candidates.map((x) => `${x.displayName} (${x.id})`).join('; ')}). ` +
            `Pass for_character { name: "${name}", race } with the character's race, or a folder.`,
          details: {
            page: pageNote,
            candidates: c.candidates.map((x) => ({ id: x.id, name: x.displayName })),
          },
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'FOLDER_REQUIRED',
        message:
          `“${page.displayName}” is not a character page, and no Character Core or Reference was found for “${name}”, so no ` +
          `folder can be derived from it. Pass for_character { name: "${name}", race } with the character's race, or a folder.`,
        details: { page: pageNote },
      },
    };
  }
  const { core, subject, via } = c.value;
  const mine = input.pageRace && input.pageRace.core === core.id ? input.pageRace : null;
  const race = mine ? mine.race : c.value.race;
  const where =
    via === 'page'
      ? `its Race / Species fact`
      : via === 'index'
        ? `the Race / Species fact on its ${c.value.role === 'core' ? 'Character Core' : 'Character Reference'} “${core.displayName}”`
        : `the Race / Species fact on “${subject}”’s ${c.value.role === 'core' ? 'Character Core' : 'Character Reference'} “${core.displayName}”`;
  const note = {
    ...pageNote,
    character: subject,
    via:
      via === 'page'
        ? 'its own Race / Species fact'
        : via === 'index'
          ? 'its Core or Reference'
          : 'its subject',
    core: { id: core.id, name: core.displayName },
  };
  if (race === null && !mine) {
    // The tree has no value for it: the tool layer reads that one page live and asks again.
    return {
      ok: false,
      error: {
        code: 'RACE_NOT_READ',
        message:
          `The repository tree holds no Race / Species fact for “${core.displayName}”, the page that holds “${subject}”’s race. ` +
          `Pass for_character { name: "${subject}", race } with the character's race, or a folder.`,
        details: { page: pageNote, core: { id: core.id, name: core.displayName }, character: subject },
      },
    };
  }
  if (race === null || race.trim() === '') {
    return {
      ok: false,
      error: {
        code: 'RACE_NOT_FOUND',
        message:
          `“${core.displayName}” has no Race / Species fact to read, so “${subject}”’s race is not known from the page. ` +
          `Pass for_character { name: "${subject}", race } with the character's race (an unknown race goes to Undetermined / Unknown), or a folder.`,
        details: { page: pageNote, core: { id: core.id, name: core.displayName }, character: subject },
      },
    };
  }
  return planForCharacter(projectId, { name: subject, race: race.trim() }, subfolders, deps, {
    page: note,
    raceNote: `The race “${race.trim()}” was read from ${where}.`,
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
