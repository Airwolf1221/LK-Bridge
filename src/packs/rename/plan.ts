/**
 * v3 F3d (renames), ADR 0058: `arkona_rename`'s plan (the owner-approved design docs/design/F3d-renames.md, section 1).
 *
 * The subject (a character, by any page of its set; or an owner: a culture, a polity, a place, a race), its old and new
 * names, and ONE package of ITEMS, each an edit the owner can approve or leave out, found through the full-text index
 * (A1) and the references the snapshots hold (A3), then read live where an edit is planned:
 *
 * | Item kind | What it changes |
 * | --- | --- |
 * | page names | the subject's own pages (index, Core or Reference, every `<Old> - …` child, every relationship naming it); ids kept |
 * | identity facts | Subject and Canonical Display Name; Given and Family only as supplied; Aliases gains the old name |
 * | resource aliases | the old name added to the pages' search aliases |
 * | index routing | lines in an index's routing section that name the subject |
 * | chronology | table rows naming the subject, their timeline events kept in step (the chronology tools' path) |
 * | taxonomy and art | a race's taxonomy entry; the art folder and the asset names holding the old name |
 * | identity token | a culture's or race's token map (a new pack version for the owner), and every character's fact and tag |
 * | textual restatements | each plain-text occurrence elsewhere, one per item, with its sentence; D1 (a) decides the ticks |
 *
 * Archived pages, the Legacy Canon Archive and the Design References are never edited: listed as "left as historical"
 * (D2). AU pages are included and labelled AU. Name parts are never inferred (D4: `NAME_PARTS_REQUIRED`).
 *
 * The amendment of 18 November 2026 (ADR 0058, A to D): REVIEW ONLY, never items (`review`): the old name's parts on their
 * own and the old aliases, and every mention whose custom label holds the old name (LegendKeeper's API cannot change a
 * custom label; a plain mention shows the new name by itself). Each write rebases itself on a conflict (`rebase`), or
 * its item is skipped; core items (the set's page names and identity facts) stop the job instead.
 *
 * The job (always a canonical proposal, ADR 0057 decision 5): one `bridge.expect` first (the subject still has its old
 * name; each page of its set as planned; each block's edits re-applied to it as it is, or skipped), then the names, the
 * facts and everything that points at them, each write under its own page's lock only, Last Major Revision by ADR 0051's
 * rule per page (measured when it runs, from what was approved and not skipped), and the read-back of every page it
 * touched.
 */
import { randomBytes } from 'node:crypto';
import { buildJob, rowKey, type WriteContext } from '../../chronology/plan.js';
import { readAgeTable, sortKey, type AgeRow } from '../../chronology/table.js';
import type { TargetWrite } from '../../chronology/store.js';
import { expandFacts } from '../../facts/expand.js';
import { planFacts, FactsPlanError } from '../../facts/plan.js';
import { sidebarFrom, type SidebarProperty } from '../../facts/sidebar.js';
import {
  EXPECT_STEP,
  LMR_STEP,
  RECORD_STEP,
  VERIFY_STEP,
  type ExpectCheck,
  type VerifyTarget,
} from '../../jobs/internal-steps.js';
import type { PlanItem } from '../../jobs/items.js';
import type { LmrMode } from '../../jobs/lmr-hook.js';
import { opMeta } from '../../jobs/op-meta.js';
import { stateHash } from '../../jobs/sidebar-state.js';
import { getOperation } from '../../lk/registry.js';
import type { ItemPartShape, StepSpec } from '../../jobs/types.js';
import { liveRead } from '../../mcp/tools/repo.js';
import type { McpToolContext, McpToolResult } from '../../mcp/server.js';
import type { ProjectDeps } from '../../mcp/tools/shape.js';
import { cleanPrefixes } from '../../registry/names.js';
import { SiblingSim } from '../../resources/plan.js';
import { classifyName, nameKey } from '../../tree/classify.js';
import type { TreeNode } from '../../tree/index.js';
import type { Labels } from '../../appraisal/scope.js';
import { shiftStep } from '../engine/job.js';
import { nameProblem, replaceDashes, textKey, type Replacement } from '../engine/text.js';
import type { PackBasis } from '../run.js';
import type { PackRules } from '../types.js';
import { reviewList, reviewParts, type ReviewList, type ReviewOccurrence } from './review.js';
import {
  blockKey,
  RENAME_CHECKS,
  RENAME_REBASERS,
  type DocumentEditsInput,
  type HistoryCheckInput,
  runsValue,
  type FactChangeInput,
} from './checks.js';
import {
  blockOccurrences,
  d1Why,
  deepText,
  occurrences,
  fingerprint,
  namePattern,
  occurrencesWithSentences,
  names as namesIn,
  plainText,
  replaceName,
  runsOf,
  sentenceAround,
  textOf,
  walkBlocks,
  writable,
  renameTextRuns,
  type PlannedEdit,
} from './text.js';

type Obj = Record<string, unknown>;
type Change = { what: string; before: string | null; after: string | null };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A step's document id (X5: chronology rows are keyed by document and row), or '' when it has none. */
const docIdOf = (v: unknown): string => str(v) ?? '';

export const RENAME_TOOL = 'arkona_rename';

/** The item groups, in the order the plan lists them (the design's table). */
export const GROUPS = {
  names: 'Page names',
  facts: 'Identity facts',
  aliases: 'Resource aliases',
  /** No longer planned (ADR 0058 amendment D): kept for proposals made before it. */
  labels: 'Mention labels',
  routing: 'Index routing',
  chronology: 'Chronology',
  art: 'Taxonomy and art',
  token: 'Identity token',
  restatements: 'Textual restatements',
} as const;

export interface RenameInput {
  /** The subject: a page (id, name, alias or path) of the character's set, or the owner page. */
  readonly subject: string;
  readonly newName: string;
  /** For people: the new name parts where they change (never inferred). */
  readonly given?: string | undefined;
  readonly family?: string | undefined;
  /** Default true: the old name becomes an alias (the Aliases fact and the pages' search aliases). */
  readonly keepOldAsAlias?: boolean | undefined;
  /** D1 (a): chronology rows dated before it start unticked (a date of the project's calendar). */
  readonly effectiveDate?: string | undefined;
  /** A culture's or race's new tag token, when its old token is not its value (`Draconic (True Dragons)` → `Draconic`). */
  readonly token?: string | undefined;
  /** A follow-up: the old name, when the subject already has the new one (what a rename left is planned again). */
  readonly from?: string | undefined;
  readonly lastMajorRevision?: LmrMode | undefined;
}

export interface Issue {
  readonly code: string;
  readonly message: string;
  readonly [k: string]: unknown;
}

export interface RenamePlan {
  readonly renameId: string;
  readonly subject: {
    readonly id: string;
    readonly name: string;
    readonly kind: 'character' | 'owner' | 'culture' | 'race';
    readonly indexId: string | null;
  };
  readonly oldName: string;
  readonly newName: string;
  readonly followUp: boolean;
  readonly items: PlanItem[];
  readonly steps: StepSpec[];
  readonly labels: string[];
  /** D2: occurrences left as historical (Archived pages, the Legacy Canon Archive, the Design References). */
  readonly historical: {
    readonly page: { id: string; name: string };
    readonly why: string;
    readonly snippet: string | null;
  }[];
  /** Occurrences found but not planned, and why (the owner edits them by hand, or a later run plans them). */
  readonly notPlanned: {
    readonly page: { id: string; name: string } | null;
    readonly why: string;
    readonly snippet: string | null;
  }[];
  readonly refusals: Issue[];
  readonly warnings: Issue[];
  readonly notes: string[];
  readonly replacements: Replacement[];
  /** A culture's or race's token change: comes in as a new pack version the owner approves (D3). */
  readonly token: {
    readonly packId: string;
    readonly map: 'culture' | 'race';
    readonly from: string;
    readonly to: string;
    readonly oldToken: string;
    readonly newToken: string;
    readonly item: string;
  } | null;
  /** Reads the plan made (besides the pack's governance). */
  readonly reads: number;
  /** The read-back's and checks' reads and the writes, as planned with every item ticked. */
  readonly cost: { readonly planReads: number; readonly jobWrites: number; readonly jobReads: number };
  /**
   * Last Major Revision: the pages it is measured on when the job runs (`pages`), the pages known at planning to change
   * only by names (`minor`: no steps), and whether the project's switch for setting-pack tools is off.
   */
  readonly lmr: {
    readonly mode: LmrMode;
    readonly pages: number;
    readonly minor: number;
    readonly switchedOff: boolean;
  };
  readonly summary: string;
  /** For the proposal: the reads the plan made, so capture does not repeat them. */
  readonly prefetched: { op: string; path: Record<string, string>; body: unknown }[];
  /**
   * ADR 0058 amendment (B, D): REVIEW ONLY, never items: the old name's parts on their own (and the old aliases), and
   * the custom mention labels holding the old name, for the owner to look at.
   */
  readonly review: ReviewList;
}

export interface RenameEnv {
  readonly pd: ProjectDeps;
  readonly mctx: McpToolContext;
  readonly basis: PackBasis;
  /** The overlay's pages and labels, and the full-text index (A1, A3). */
  readonly appraisal: NonNullable<NonNullable<ProjectDeps['services']>['appraisal']>;
}

const issue = (code: string, message: string, more: Obj = {}): Issue => ({ code, message, ...more });

/** The display name of a renamed page: the old subject replaced where the page's name carries it. */
export function renamedDisplay(display: string, oldName: string, newName: string): string {
  if (textKey(display) === textKey(oldName)) return newName;
  for (const sep of [' - ', ' & ', ' ']) {
    if (display.startsWith(`${oldName}${sep}`)) return `${newName}${display.slice(oldName.length)}`;
  }
  const rel = /^(.+?) & (.+?) - (.+)$/.exec(display);
  if (rel) {
    const a = rel[1] === oldName ? newName : rel[1]!;
    const b = rel[2] === oldName ? newName : rel[2]!;
    return `${a} & ${b} - ${rel[3]}`;
  }
  return display;
}

/** Whether a page's display name belongs to the subject's set (its own name, a child, a subindex, a relationship). */
function namedFor(display: string, name: string): boolean {
  if (textKey(display) === textKey(name)) return true;
  if (display.startsWith(`${name} - `) || display.startsWith(`${name} & `)) return true;
  return new RegExp(` & ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} - `).test(display);
}

/**
 * A fact row's runs with the old name renamed in its text. A mention's custom label is kept as it is: LegendKeeper's API
 * cannot change one (ADR 0058 amendment, D); it is listed for review instead.
 */
function renamedRuns(content: readonly Obj[], oldName: string, newName: string): Obj[] {
  return content.map((r) =>
    typeof r.text === 'string' ? { ...r, text: replaceName(r.text, oldName, newName) } : r,
  );
}

const valueOf = (content: readonly Obj[]): string =>
  content
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : isObj(r.mention)
          ? (str(r.mention.text) ?? str(r.mention.name) ?? '')
          : '',
    )
    .join('');

export async function planRename(
  env: RenameEnv,
  input: RenameInput,
): Promise<
  { ok: true; plan: RenamePlan } | { ok: false; result: McpToolResult; partial?: Partial<RenamePlan> }
> {
  const { pd, mctx, basis } = env;
  const ctx = basis.ctx;
  const projectId = ctx.projectId;
  const rules: PackRules = basis.pack.rules;
  const refusals: Issue[] = [];
  const warnings: Issue[] = [];
  const notes: string[] = [];
  const replacements: Replacement[] = [];
  const historical: RenamePlan['historical'] = [];
  const notPlanned: RenamePlan['notPlanned'] = [];
  const prefetched: RenamePlan['prefetched'] = [];
  let reads = 0;
  const read = async (op: string, params: Record<string, unknown>): Promise<unknown> => {
    reads++;
    const r = await liveRead(pd, mctx, RENAME_TOOL, op, params);
    if (!r.ok) throw new PlanReadError(r.result);
    return r.value;
  };

  // ---------------------------------------------------------------------------------------------- the subject
  const q = cleanPrefixes(input.subject).name.trim() || input.subject.trim();
  let start: TreeNode | null = ctx.tree.node(projectId, input.subject.trim()).data;
  if (!start) {
    const r = ctx.types.resolve(q, {});
    if (r.status === 'ambiguous')
      return refused(pd, [
        issue(
          'SUBJECT_AMBIGUOUS',
          `“${input.subject}” names ${r.candidates.length} pages; pass the id of the one meant.`,
          { candidates: r.candidates.map((c) => ({ id: c.id, name: c.rawName })) },
        ),
      ]);
    if (r.status !== 'resolved')
      return refused(pd, [
        issue('SUBJECT_NOT_FOUND', `No page is named “${input.subject}” (by id, name, alias or path).`),
      ]);
    start = ctx.tree.node(projectId, r.node.id).data;
  }
  if (!start) return refused(pd, [issue('SUBJECT_NOT_FOUND', `No page ${input.subject}.`)]);

  let kind: RenamePlan['subject']['kind'] = 'owner';
  let identity: TreeNode = start;
  let index: TreeNode | null = null;
  let subjectName: string;
  const character = ctx.types.characterOfPage(start.id);
  if (character.ok) {
    kind = 'character';
    identity = ctx.tree.node(projectId, character.value.core.id).data ?? start;
    subjectName = character.value.subject || cleanPrefixes(identity.displayName).name.split(' - ')[0]!.trim();
    const parent = identity.parentId ? ctx.tree.node(projectId, identity.parentId).data : null;
    if (parent?.kind === 'index' && nameKey(parent.displayName) === nameKey(subjectName)) index = parent;
  } else {
    if (start.kind === 'index') {
      index = start;
      const own = ctx.tree
        .children(projectId, start.id)
        .data.find((c) => c.kind !== 'index' && c.displayName.startsWith(`${start.displayName} - `));
      identity = own ?? start;
    }
    subjectName = identity.displayName.split(' - ')[0]!.trim();
    if (!index && identity.parentId) {
      const parent = ctx.tree.node(projectId, identity.parentId).data;
      if (parent?.kind === 'index' && nameKey(parent.displayName) === nameKey(subjectName)) index = parent;
    }
    const tags = identity.tags.map((t) => t.toLowerCase());
    const raceKind = rules.owners?.types.find((t) => t.name.toLowerCase() === 'species')?.kinds?.race;
    if (tags.includes('culture')) kind = 'culture';
    else if (
      tags.includes('species') &&
      (identity.displayName.endsWith(' - Core Information') ||
        (raceKind?.referenceType && identity.referenceType === raceKind.referenceType))
    )
      kind = 'race';
  }
  if (identity.kind === 'barc')
    return refused(pd, [
      issue(
        'SUBJECT_ARCHIVED',
        `${identity.rawName} is Archived: an Archived page keeps its name (D2). Unarchive it first if it is to be renamed.`,
      ),
    ]);

  // ---------------------------------------------------------------------------------------------- the names
  const followUp = input.from !== undefined && input.from.trim() !== '';
  let newName = replaceDashes(input.newName.trim(), 'newName', 'name', replacements);
  newName = newName.replace(/\s+/g, ' ').trim();
  const oldName = followUp ? input.from.trim() : subjectName;
  if (newName === '') return refused(pd, [issue('INVALID_INPUT', 'newName is empty.')]);
  const problem = nameProblem(newName, rules);
  if (problem) return refused(pd, [issue(problem.code, problem.message)]);
  if (followUp) {
    if (textKey(subjectName) !== textKey(newName))
      return refused(pd, [
        issue(
          'FOLLOW_UP_MISMATCH',
          `A follow-up (from “${oldName}”) is for a subject that already has its new name; ${identity.rawName} is called “${subjectName}”, not “${newName}”.`,
        ),
      ]);
    // CR-2026-11-R3 (R3-32): `from` must be a name the subject had: one an earlier rename recorded for it, or one its
    // page keeps as an alias. A name part ("Nadira"), or another character's name, would rename text the owner never
    // asked to change (and take over another identity).
    const former = new Set<string>();
    for (const r of pd.services?.renames?.forSubject(projectId, identity.id, 100) ?? [])
      former.add(textKey(r.oldName));
    for (const a of ctx.tree.node(projectId, identity.id).data?.aliases ?? []) former.add(textKey(a));
    if (!former.has(textKey(oldName)))
      return refused(pd, [
        issue(
          'FROM_NOT_A_FORMER_NAME',
          `“${oldName}” is not a name ${identity.rawName} had: a follow-up plans what a rename left of the subject's own former name (one an earlier rename recorded, or one the page keeps as an alias). A name part or another character's name is never renamed this way; change such text by hand.`,
        ),
      ]);
  } else if (textKey(subjectName) === textKey(newName)) {
    return refused(pd, [
      issue(
        'NOTHING_TO_RENAME',
        `${identity.rawName} is already called “${newName}”. To plan what an earlier rename left, pass from: the old name.`,
      ),
    ]);
  }
  if (oldName.length < 3)
    return refused(pd, [issue('INVALID_INPUT', `“${oldName}” is too short to find safely in text.`)]);
  const keepAlias = input.keepOldAsAlias !== false;
  const renameId = `rn_${randomBytes(8).toString('hex')}`;

  // ---------------------------------------------------------------------------------------------- the set
  const lifecycleIds = new Set(
    [basis.lifecycle.workingIndexId, basis.lifecycle.archiveIndexId].filter((x): x is string => !!x),
  );
  const inArchive = (n: TreeNode) =>
    n.kind === 'barc' ||
    (basis.lifecycle.archiveIndexId !== null && n.path.ids.includes(basis.lifecycle.archiveIndexId));
  const setPages: TreeNode[] = [identity];
  const addSet = (n: TreeNode | null) => {
    if (!n || setPages.some((p) => p.id === n.id) || lifecycleIds.has(n.id)) return;
    setPages.push(n);
  };
  const currentName = followUp ? newName : oldName;
  if (index) {
    addSet(index);
    for (const c of ctx.tree.children(projectId, index.id).data) {
      if (namedFor(c.displayName, currentName)) addSet(c);
      if (namedFor(c.displayName, oldName)) addSet(c);
    }
  }
  // Relationships naming the subject anywhere (hosted under another participant's index too).
  for (const k of ['bsrc', 'bwrk', 'barc'] as const)
    for (const n of ctx.tree.byKind(projectId, k).data)
      if (
        / & .+ - /.test(n.displayName) &&
        (namedFor(n.displayName, oldName) || namedFor(n.displayName, currentName))
      )
        addSet(n);
  // A race's character navigation (Characters / … / <Race>).
  let raceNav: TreeNode | null = null;
  if (kind === 'race') {
    for (const name of followUp ? [currentName, oldName] : [currentName]) {
      try {
        const hit = ctx.types.raceIndex(name);
        if (!hit.unknown) {
          raceNav = ctx.tree.node(projectId, hit.node.id).data;
          break;
        }
      } catch {
        // No race index by that name (the registry is not set up, or the race has none): nothing to plan there.
      }
    }
    if (raceNav && raceNav.id !== index?.id) addSet(raceNav);
  }
  // D2: an Archived page of the set keeps the old name.
  for (const p of [...setPages]) {
    if (p.id !== identity.id && inArchive(p)) {
      setPages.splice(setPages.indexOf(p), 1);
      historical.push({
        page: { id: p.id, name: p.rawName },
        why: 'an Archived page keeps its name (D2)',
        snippet: null,
      });
    }
  }

  // ---------------------------------------------------------------------------------------------- name parts (D4)
  const set = new Map<string, { node: TreeNode; resource: Obj; sidebar: SidebarProperty[] }>();
  const loadPage = async (n: TreeNode) => {
    const had = set.get(n.id);
    if (had) return had;
    const body = (await read('getResource', { path: { resourceId: n.id } })) as Obj;
    prefetched.push({ op: 'getResource', path: { resourceId: n.id }, body });
    const sidebar = sidebarFrom({ data: Array.isArray(body.properties) ? body.properties : [] });
    const v = { node: n, resource: body, sidebar };
    set.set(n.id, v);
    return v;
  };
  let pages: { node: TreeNode; resource: Obj; sidebar: SidebarProperty[] }[];
  try {
    pages = [];
    for (const n of setPages) pages.push(await loadPage(n));
  } catch (e) {
    if (e instanceof PlanReadError) return { ok: false, result: e.result };
    throw e;
  }
  const prop = rules.sidebar.property;
  const rowOf = (sb: readonly SidebarProperty[], key: string) =>
    sb
      .find((p) => p.kind === 'keyValue' && textKey(p.title) === textKey(prop))
      ?.rows?.find((r) => textKey(r.key) === textKey(key)) ?? null;
  const identityPage = pages[0]!;
  const fieldKey = (f: string) => rules.types[0]?.identity.find((x) => x.field === f)?.key ?? null;
  const givenKey = fieldKey('givenName') ?? 'Personal / Given Name';
  const familyKey = fieldKey('surname') ?? 'Family / Surname';
  const parts: { key: string; value: string }[] = [];
  if (kind === 'character') {
    const need: string[] = [];
    for (const [k, given] of [
      [givenKey, input.given],
      [familyKey, input.family],
    ] as const) {
      const row = rowOf(identityPage.sidebar, k);
      const now = row ? valueOf(row.content).trim() : '';
      const placeholder =
        now === '' || rules.types[0]?.placeholders.some((p) => textKey(p) === textKey(now)) === true;
      const touched = !placeholder && !followUp && namesIn(oldName, now) && !namesIn(newName, now);
      if (given !== undefined && given.trim() !== '') {
        if (textKey(given) !== textKey(now)) parts.push({ key: k, value: given.trim() });
      } else if (touched) need.push(`${k} “${now}”`);
    }
    if (need.length > 0)
      return refused(pd, [
        issue(
          'NAME_PARTS_REQUIRED',
          `The rename changes a name part: ${need.join(' and ')} ${need.length === 1 ? 'is' : 'are'} in “${oldName}” but not in “${newName}”. Give ${need.length === 1 ? 'it' : 'them'} (given, family) as the owner decided; the bridge never infers a name part from the shape of a name.`,
          { parts: need },
        ),
      ]);
  } else if ((input.given ?? '').trim() !== '' || (input.family ?? '').trim() !== '') {
    return refused(pd, [
      issue('NAME_PARTS_NOT_APPLICABLE', `${identity.rawName} is not a character: it has no name parts.`),
    ]);
  }

  // ---------------------------------------------------------------------------------------------- the job's pieces
  const items: PlanItem[] = [];
  const nameItemOf = new Map<string, string>(); // page → its page-name item
  const pageItems = new Map<string, Set<string>>(); // page → every item that writes to it
  const pageWrites = new Map<string, number[]>(); // page → its write steps (local numbers, 1-based in `body`)
  const known = new Map<string, Obj[]>(); // page → Last Major Revision evidence the plan knows (with its item)
  const checks: ExpectCheck[] = [
    {
      label: 'subject',
      kind: 'registered',
      checker: RENAME_CHECKS.subject,
      input: {
        resourceId: identity.id,
        oldName: renamedRaw(identity.rawName, newName, oldName, followUp, 'old'),
        newName: renamedRaw(identity.rawName, newName, oldName, followUp, 'new'),
      },
    },
  ];
  const checkItems: string[][] = [[]];
  const checkParts: ItemPartShape[] = [];
  const body: StepSpec[] = []; // steps after the first check, numbered from 2
  const bodyLabels: string[] = [];
  const verify: VerifyTarget[] = [];
  const verifyItems: string[][] = [];
  const verifyParts: ItemPartShape[] = [];
  /** ADR 0058 amendment (D): custom mention labels naming the old name (never written; for review). */
  const customLabels: ReviewOccurrence[] = [];
  /** A row's (or a paragraph's) mentions whose custom label names the old name: listed for review, never written. */
  const labelsIn = (
    content: readonly Obj[],
    page: { id: string; name: string },
    section: string,
    sentence: string,
  ) => {
    for (const r of content) {
      const m = r.mention;
      if (!isObj(m) || typeof m.text !== 'string' || !namesIn(m.text, oldName)) continue;
      customLabels.push({
        kind: 'custom label',
        part: oldName,
        page,
        section,
        sentence: sentence.slice(0, 300),
        label: m.text,
        note: 'custom label: change it in the app if wanted',
      });
    }
  };
  const stepNo = () => body.length + 2; // the number the next step pushed will have
  const touch = (pageId: string, item: string) => {
    const s = pageItems.get(pageId) ?? new Set<string>();
    s.add(item);
    pageItems.set(pageId, s);
  };
  const wrote = (pageId: string, n: number) => pageWrites.set(pageId, [...(pageWrites.get(pageId) ?? []), n]);
  /** Pages whose text the job writes (blocks, chronology rows): measured for Last Major Revision when it runs. */
  const textPages = new Set<string>();
  const journal = (page: { id: string; name: string } | null, write: string): Obj => ({
    tool: RENAME_TOOL,
    pack: basis.pack.id,
    rename: renameId,
    ...(page ? { page } : {}),
    write,
  });
  const labelsOf = (pageId: string): Labels | null => {
    try {
      return readerLabels(pageId);
    } catch {
      return null;
    }
  };
  const { reader } = await env.appraisal.reader(projectId);
  const readerLabels = (pageId: string) => reader.labels(pageId);
  const auOf = async (pageId: string): Promise<boolean> => {
    const loaded = await reader.load(pageId).catch(() => null);
    const ct = loaded?.sidebar?.facts.get('continuity type')?.text ?? '';
    return textKey(ct) === 'au';
  };
  const identityName = followUp
    ? identity.rawName
    : renamedRaw(identity.rawName, newName, oldName, false, 'new');
  const rootItem = `name:${identity.id}`;
  /** The item every other depends on: the subject's own new name (none in a follow-up: it has it already). */
  const root = (): string[] => (items.some((i) => i.id === rootItem) ? [rootItem] : []);

  // 1. Page names (and each page's place among its siblings), then the in-lock check of each page. Every name of the
  // set changes at once in the simulation first, so a page is moved only when its place among its siblings (as they
  // will all be named) really changes: renaming a whole set keeps its own order.
  const sim = new SiblingSim((parentId) => ctx.tree.children(projectId, parentId).data);
  const renamed = new Map<string, { display: string; raw: string }>();
  for (const p of pages) {
    const n = p.node;
    const display = classifyName(n.rawName).displayName;
    const nextDisplay = renamedDisplay(display, oldName, newName);
    if (nextDisplay === display) continue;
    const prefix = n.rawName.slice(0, n.rawName.length - display.length);
    renamed.set(n.id, { display: nextDisplay, raw: `${prefix}${nextDisplay}` });
    if (n.parentId) {
      const list = sim.list(n.parentId);
      const at = list.findIndex((x) => x.id === n.id);
      if (at >= 0) list[at] = { ...list[at]!, displayName: nextDisplay };
    }
  }
  for (const p of pages) {
    const n = p.node;
    const next = renamed.get(n.id);
    if (!next) continue;
    const { display: nextDisplay, raw: nextRaw } = next;
    const tags = Array.isArray(p.resource.tags) ? (p.resource.tags as string[]) : [...n.tags];
    const parentId = n.parentId;
    if (parentId) {
      const twin = ctx.tree
        .children(projectId, parentId)
        .data.find(
          (s) =>
            s.id !== n.id &&
            s.kind === n.kind &&
            nameKey(renamed.get(s.id)?.display ?? s.displayName) === nameKey(nextDisplay),
        );
      if (twin)
        refusals.push(
          issue(
            'NAME_TAKEN',
            `${n.rawName} cannot be renamed to “${nextRaw}”: ${twin.rawName} is already beside it. Nothing is planned until the owner decides.`,
            { page: { id: n.id, name: n.rawName }, existing: { id: twin.id, name: twin.rawName } },
          ),
        );
    }
    const p2 = nameProblem(nextDisplay, rules);
    if (p2) refusals.push(issue(p2.code, p2.message, { page: { id: n.id, name: n.rawName } }));
    const item = `name:${n.id}`;
    nameItemOf.set(n.id, item);
    touch(n.id, item);
    const at = stepNo();
    body.push({
      op: 'updateResource',
      params: { path: { resourceId: n.id }, body: { name: nextRaw } },
      expectCurrent: { state: 'resource', hash: stateHash({ name: n.rawName, tags }), label: n.rawName },
      judgedInLock: true,
      deferTreeReread: true,
      items: [item],
      // ADR 0058 amendment (A): a core item. Its tags changed meanwhile: renamed all the same (the name is still the old
      // one); its name changed meanwhile: the job stops (resumable).
      rebase: {
        rebaser: RENAME_REBASERS.resource,
        input: { kind: 'name', from: n.rawName, to: nextRaw, item },
        core: true,
      },
      journalOperation: journal({ id: n.id, name: n.rawName }, `renamed to ${nextRaw}`),
    });
    bodyLabels.push(`rename ${n.rawName} to ${nextRaw}`);
    wrote(n.id, at);
    let moved = false;
    if (parentId) {
      const now = sim.neighbours(parentId, n.id);
      sim.remove(parentId, n.id);
      const slot = sim.slot(parentId, { displayName: nextDisplay, kind: n.kind });
      sim.insert(parentId, { id: n.id, displayName: nextDisplay, kind: n.kind }, slot);
      const then = sim.neighbours(parentId, n.id);
      if (now.after !== then.after || now.before !== then.before) {
        moved = true;
        wrote(n.id, stepNo());
        body.push({
          op: 'moveResource',
          params: { path: { resourceId: n.id }, body: { parentId, ...slot } },
          judgedInLock: true,
          deferTreeReread: true,
          items: [item],
          // CR-2026-11-R3 (R3-36): never moves back a page the owner moved since the plan; and a move LegendKeeper
          // refuses (its anchor gone meanwhile) does not stop the rename: the name is written, the place reported.
          rebase: { rebaser: RENAME_REBASERS.place, input: { parentId }, always: true },
          followUp: 'placement_failed',
          journalOperation: journal({ id: n.id, name: nextRaw }, 're-placed after the rename'),
        });
        bodyLabels.push(`re-place ${nextRaw} among its siblings`);
      }
    }
    items.push({
      id: item,
      kind: 'page_name',
      group: GROUPS.names,
      label: `${n.rawName} → ${nextRaw}${moved ? ' (re-placed alphabetically)' : ''}`,
      page: { id: n.id, name: n.rawName },
      diff: { before: n.rawName, after: nextRaw },
      dependsOn: [],
      selected: true,
      ...((await auOf(n.id)) ? { tags: ['AU'] } : {}),
    });
    verify.push({ kind: 'resource', label: `${nextRaw}: name`, resourceId: n.id, fields: { name: nextRaw } });
    verifyItems.push([item]);
  }
  // Every other page name needs the subject's own (a set renamed in part is not a rename).
  for (let i = 0; i < items.length; i++)
    if (items[i]!.id !== rootItem) items[i] = { ...items[i]!, dependsOn: root() };

  // 2. Identity facts (each page of the set: Subject, Canonical Display Name, any row naming it; the identity page: name
  // parts as given, the old name in Aliases).
  const aliasesKey = rules.types[0]?.identity.find((x) => x.field === 'aliases')?.key ?? 'Aliases';
  for (const p of pages) {
    const n = p.node;
    const kv = p.sidebar.find((x) => x.kind === 'keyValue' && textKey(x.title) === textKey(prop));
    if (!kv) continue;
    const facts: { key: string; value: Obj[] }[] = [];
    const changes: Change[] = [];
    for (const row of kv.rows ?? []) {
      const before = valueOf(row.content);
      if (!namesIn(before, oldName)) continue;
      if (textKey(row.key) === textKey(aliasesKey)) continue; // the Aliases fact keeps the old name
      labelsIn(row.content, { id: n.id, name: n.rawName }, `sidebar: ${row.key}`, before);
      const runs = renamedRuns(row.content, oldName, newName);
      facts.push({ key: row.key, value: runs });
      changes.push({ what: row.key, before, after: valueOf(runs) });
    }
    if (n.id === identity.id) {
      for (const part of parts) {
        facts.push({ key: part.key, value: [{ text: part.value }] });
        changes.push({
          what: part.key,
          before: valueOf(rowOf(p.sidebar, part.key)?.content ?? []),
          after: part.value,
        });
      }
      if (keepAlias && kind === 'character') {
        const row = rowOf(p.sidebar, aliasesKey);
        if (row) {
          const now = valueOf(row.content).trim();
          const list = now === '' ? [] : now.split(/\s*;\s*/);
          if (!list.some((a) => textKey(a) === textKey(oldName))) {
            const value = [...list, oldName].join('; ');
            facts.push({ key: aliasesKey, value: [{ text: value }] });
            changes.push({ what: aliasesKey, before: now === '' ? null : now, after: value });
          }
        }
      }
    }
    if (facts.length === 0) continue;
    const item = `facts:${n.id}`;
    const deps = nameItemOf.get(n.id) ? [nameItemOf.get(n.id)!] : root();
    const added = addFacts(p, facts, item, `${n.rawName}: identity facts`, true);
    if (!added) continue;
    items.push({
      id: item,
      kind: 'identity_facts',
      group: GROUPS.facts,
      label: `${n.rawName}: ${changes.map((c) => c.what).join(', ')}`,
      page: { id: n.id, name: n.rawName },
      diff: { changes },
      dependsOn: deps,
      selected: true,
    });
  }

  // 3. Resource aliases: each renamed page's old name among its search aliases.
  if (keepAlias) {
    for (const p of pages) {
      const n = p.node;
      const nameItem = nameItemOf.get(n.id);
      const display = classifyName(n.rawName).displayName;
      const oldDisplay = nameItem ? display : renamedDisplay(display, newName, oldName);
      if (textKey(oldDisplay) === textKey(display) && !nameItem) continue;
      const aliases = Array.isArray(p.resource.aliases) ? (p.resource.aliases as string[]) : [...n.aliases];
      if (aliases.some((a) => textKey(a) === textKey(oldDisplay))) continue;
      const next = [...aliases, oldDisplay];
      const item = `aliases:${n.id}`;
      const tags = Array.isArray(p.resource.tags) ? (p.resource.tags as string[]) : [...n.tags];
      const nowName = nameItem ? renamedRaw(n.rawName, newName, oldName, false, 'new') : n.rawName;
      touch(n.id, item);
      wrote(n.id, stepNo());
      body.push({
        op: 'updateResource',
        params: { path: { resourceId: n.id }, body: { aliases: next } },
        expectCurrent: { state: 'resource', hash: stateHash({ name: nowName, tags }), label: nowName },
        judgedInLock: true,
        deferTreeReread: true,
        items: [item],
        // ADR 0058 amendment (A): the alias is added to the page's aliases as they are when it runs (inside its lock).
        rebase: {
          rebaser: RENAME_REBASERS.resource,
          input: { kind: 'alias', alias: oldDisplay, item },
          always: true,
        },
        journalOperation: journal({ id: n.id, name: nowName }, `alias “${oldDisplay}” added`),
      });
      bodyLabels.push(`${nowName}: alias “${oldDisplay}”`);
      items.push({
        id: item,
        kind: 'resource_aliases',
        group: GROUPS.aliases,
        label: `${nowName}: search alias “${oldDisplay}”`,
        page: { id: n.id, name: n.rawName },
        diff: { before: aliases.join(', ') || null, after: next.join(', ') },
        dependsOn: nameItem ? [nameItem] : root(),
        selected: true,
      });
      verify.push({
        kind: 'resource',
        label: `${nowName}: aliases`,
        resourceId: n.id,
        fields: { aliases: next },
      });
      verifyItems.push([item]);
    }
  }
  // The pages' own state, checked inside the lock before anything is written.
  for (const p of pages) {
    const its = [...(pageItems.get(p.node.id) ?? [])];
    if (its.length === 0) continue;
    const n = p.node;
    // ADR 0058 amendment (A): a page of the set keeps its old name (or has the new one) until its rename runs: core.
    // Its aliases and tags are not compared here: each write that changes them works them out inside its own lock.
    checks.push({
      label: `page:${n.id}`,
      kind: 'registered',
      checker: RENAME_CHECKS.resource,
      resourceId: n.id,
      input: {
        resourceId: n.id,
        names: [n.rawName, renamedRaw(n.rawName, newName, oldName, followUp, 'new')],
      },
    });
    checkItems.push(its);
  }

  // 4. The text: found through the full-text index, each document read live (routing lines and restatements, each
  // occurrence its own item; custom mention labels listed for review).
  const chronologyReady = (() => {
    const ch = pd.services?.chronology;
    if (!ch) return null;
    const r = ch.readiness(projectId);
    return r.ok ? r.config : null;
  })();
  const ageTables = new Map<string, NonNullable<typeof chronologyReady>['ages'][number]>();
  for (const a of chronologyReady?.ages ?? []) if (a.tableDocumentId) ageTables.set(a.tableDocumentId, a);
  const hits = env.appraisal.fullText.search(projectId, [{ value: oldName, phrase: true }], { limit: 5000 });
  const docsToRead = new Map<string, { pageId: string; documentId: string; snippet: string }>();
  const factPages = new Set<string>();
  // The identity fact a culture's or race's characters name it in (Naming Culture, Race / Species).
  const tokenFactKey =
    kind === 'culture'
      ? (fieldKey('namingCulture') ?? 'Naming Culture')
      : kind === 'race'
        ? (fieldKey('race') ?? 'Race / Species')
        : null;
  const tokenFields = new Set(tokenFactKey ? [tokenFactKey.trim().toLowerCase()] : []);
  const tokenPages = new Set<string>();
  const setIds = new Set(pages.map((p) => p.node.id));
  for (const h of hits) {
    if (h.unit === 'name' || h.unit === 'alias') continue;
    const page = reader.page(h.pageId);
    const l = labelsOf(h.pageId);
    const name = page?.rawName ?? h.pageId;
    if (l && (l.area !== null || l.lifecycle === 'Archived')) {
      historical.push({
        page: { id: h.pageId, name },
        why:
          l.area === 'legacy'
            ? 'the Legacy Canon Archive keeps its record (D2)'
            : l.area === 'design'
              ? 'the Design References keep their record (D2)'
              : 'an Archived page keeps its record (D2)',
        snippet: h.snippet,
      });
      continue;
    }
    if (h.unit === 'fact') {
      if (setIds.has(h.pageId)) continue; // the set's own facts (identity facts above)
      if (h.field && tokenFields.has(h.field.trim().toLowerCase())) tokenPages.add(h.pageId);
      else if (!h.field || textKey(h.field) !== textKey(aliasesKey)) factPages.add(h.pageId);
      continue;
    }
    if (!h.documentId) continue;
    if (ageTables.has(h.documentId)) continue; // chronology rows (below)
    const k = `${h.pageId}:${h.documentId}`;
    if (!docsToRead.has(k))
      docsToRead.set(k, { pageId: h.pageId, documentId: h.documentId, snippet: h.snippet });
  }
  const routingHeading = rules.types[0]?.index.routing ?? 'How to Use This Index';
  const unresolved = rules.types[0]?.text.unresolved ?? 'Unresolved Material';
  // CR-2026-11-R3 (R3-26): the longer names that hold the old name (another character's "Nadira al-Khalid al-Sughra"
  // holds "Nadira al-Khalid"): an occurrence inside one is never renamed, nor a fact naming one.
  const subjectPart = (n: string) => n.split(' - ')[0]!.trim();
  const longerNames = [
    ...new Set(
      (typeof ctx.tree.namesContaining === 'function'
        ? ctx.tree.namesContaining(projectId, oldName)
        : []
      ).map(subjectPart),
    ),
  ].filter((n) => {
    if (n === oldName || n === newName || !namesIn(n, oldName) || namesIn(newName, n)) return false;
    // A relationship's name ("Nadira al-Khalid & Tarek Basri") is renamed with her: not another character's name.
    const rest = n.replace(namePattern(oldName), '').trim();
    return !rest.startsWith('&') && !rest.endsWith('&');
  });
  const insideLonger = (text: string, start: number, end: number): string | null => {
    for (const L of longerNames)
      for (const o of occurrences(text, L)) if (o.start <= start && o.end >= end) return L;
    return null;
  };
  const docEdits: {
    pageId: string;
    documentId: string;
    blocks: { block: Obj; edits: { edit: PlannedEdit; item: string }[]; where: string }[];
  }[] = [];
  try {
    for (const { pageId, documentId, snippet } of docsToRead.values()) {
      const node = ctx.tree.node(projectId, pageId).data;
      const pageName = node?.rawName ?? reader.page(pageId)?.rawName ?? pageId;
      const isIndex = node?.kind === 'index';
      const b = (await read('getDocumentBlocks', { path: { resourceId: pageId, documentId } })) as Obj;
      const au = await auOf(pageId);
      const lifecycle = labelsOf(pageId)?.lifecycle ?? null;
      const current = lifecycle === null || lifecycle === 'Authoritative' || lifecycle === 'Working';
      const out: (typeof docEdits)[number] = { pageId, documentId, blocks: [] };
      let unplanned = 0;
      for (const { block, section, inTable, parentKind } of walkBlocks(
        Array.isArray(b.blocks) ? (b.blocks as unknown[]) : [],
      )) {
        if (inTable || !runsOf(block) || typeof block.id !== 'string') {
          // A table's cells and a code block: not edited by the rename (reported once per document, below).
          if (!runsOf(block) && !Array.isArray(block.children) && namesIn(deepText(block), oldName))
            unplanned++;
          else if (inTable && runsOf(block) && namesIn(deepText(block), oldName)) unplanned++;
          continue;
        }
        const found = blockOccurrences(block, oldName, newName);
        const plain = plainText(block);
        // The name split by formatting (part of it bold, italic or a link): its runs do not hold it whole.
        if (occurrences(textOf(block), oldName).length > found.text.filter((o) => o.isOld).length)
          notPlanned.push({
            page: { id: pageId, name: pageName },
            why: 'the name is split by formatting (part of it bold, italic or linked): edit it by hand',
            snippet: plain.slice(0, 240),
          });
        const routing = isIndex && section.some((h) => textKey(h) === textKey(routingHeading));
        const where = `${pageName}${section.length ? ` › ${section.at(-1)}` : ''}`;
        const edits: { edit: PlannedEdit; item: string }[] = [];
        const text = textOf(block);
        let offset = 0;
        const runStarts: number[] = [];
        for (const r of runsOf(block) ?? []) {
          runStarts.push(offset);
          if (typeof r.text === 'string') offset += r.text.length;
        }
        found.text.forEach((o, k) => {
          if (!o.isOld) return;
          const start = runStarts[o.run]! + o.start;
          const id = `${routing ? 'routing' : 'text'}:${documentId}:${String(block.id)}:${k}`;
          const longer = insideLonger(text, start, start + oldName.length);
          if (longer) {
            notPlanned.push({
              page: { id: pageId, name: pageName },
              why: `part of another name (“${longer}”): never renamed`,
              snippet: sentenceAround(text, start, start + oldName.length).slice(0, 240),
            });
            return;
          }
          // CR-2026-11-R3 (R3-28): a paragraph inside a quote block is a quotation (D1 (a)), as one in quotation marks is.
          const quoted = parentKind === 'quote' || parentKind === 'blockquote';
          const why = routing
            ? null
            : quoted
              ? 'inside a quotation (a quote block): left as quoted'
              : d1Why(text, start, section, unresolved);
          const sentence = sentenceAround(text, start, start + oldName.length);
          edits.push({ edit: { kind: 'text', ordinal: k, item: id, sentence }, item: id });
          items.push({
            id,
            kind: routing ? 'index_routing' : 'restatement',
            group: routing ? GROUPS.routing : GROUPS.restatements,
            label: `${where}: “${sentence}”`,
            page: { id: pageId, name: pageName },
            diff: { before: sentence, after: replaceName(sentence, oldName, newName), context: sentence },
            dependsOn: root(),
            selected: current && why === null,
            ...(why ? { why } : !current ? { why: 'the page is not current' } : {}),
            ...(au ? { tags: ['AU'] } : {}),
          });
        });
        // ADR 0058 amendment (D): a mention's custom label cannot be changed through LegendKeeper's API (and Arkona's
        // repository does not use custom labels): never a write, listed for review ("change it in the app if wanted").
        found.mentions.forEach((m) => {
          if (!m.isOld) return;
          customLabels.push({
            kind: 'custom label',
            part: oldName,
            page: { id: pageId, name: pageName },
            section: section.at(-1) ?? null,
            sentence: plain.slice(0, 300),
            label: m.label,
            note: 'custom label: change it in the app if wanted',
          });
        });
        if (edits.length > 0) out.blocks.push({ block, edits, where });
      }
      if (unplanned > 0)
        notPlanned.push({
          page: { id: pageId, name: pageName },
          why: `${unplanned} occurrence${unplanned === 1 ? '' : 's'} in a table or a code block: the rename does not edit those; edit ${unplanned === 1 ? 'it' : 'them'} by hand`,
          snippet,
        });
      if (out.blocks.length > 0) docEdits.push(out);
    }
  } catch (e) {
    if (e instanceof PlanReadError) return { ok: false, result: e.result };
    throw e;
  }
  for (const d of docEdits) {
    const docItems = [...new Set(d.blocks.flatMap((b) => b.edits.map((e) => e.item)))];
    const input: DocumentEditsInput = {
      documentId: d.documentId,
      oldName,
      newName,
      blocks: d.blocks.map((b) => ({
        blockId: String(b.block.id),
        fingerprint: fingerprint(b.block, oldName, newName),
        edits: b.edits.map((e) => e.edit),
        // CR-2026-11-R3 (R3-25): every occurrence's sentence, ticked or not, so a rebase never takes one for another.
        sentences: occurrencesWithSentences(b.block, oldName, newName)
          .filter((o) => o.isOld)
          .map((o) => o.sentence),
        where: b.where,
      })),
    };
    const blockInput = (k: number) => input.blocks[k]!;
    const c = checks.length;
    checks.push({
      label: `doc:${d.documentId}`,
      kind: 'document',
      resourceId: d.pageId,
      documentId: d.documentId,
      checker: RENAME_CHECKS.document,
      input,
      // CR-2026-11-R3 (R3-39): a page deleted while the rename waits skips its items; the rest of the rename runs.
      skipItems: docItems,
    });
    checkItems.push(docItems);
    checkParts.push({
      path: `body.checks.${c}.input.blocks`,
      items: d.blocks.map((b) => [...new Set(b.edits.map((e) => e.item))]),
    });
    d.blocks.forEach((b, k) =>
      checkParts.push({
        path: `body.checks.${c}.input.blocks.${k}.edits`,
        items: b.edits.map((e) => [e.item]),
      }),
    );
    let prev: number | null = null;
    for (const [k, b] of d.blocks.entries()) {
      const its = [...new Set(b.edits.map((e) => e.item))];
      for (const it of its) touch(d.pageId, it);
      const at = stepNo();
      const planned = blockInput(k);
      body.push({
        op: 'replaceBlock',
        params: {
          path: { resourceId: d.pageId, documentId: d.documentId, blockId: String(b.block.id) },
          body: writable(b.block),
        },
        bindBody: { step: 1, key: blockKey(d.documentId, String(b.block.id)) },
        ifMatchFrom: prev === null ? { step: 1, key: `doc:${d.documentId}` } : { step: prev },
        judgedInLock: true,
        items: its,
        // ADR 0058 amendment (A): the document changed since the check (another writer, between this page's writes):
        // each occurrence is found again by its sentence and renamed there, or its item skipped.
        rebase: {
          rebaser: RENAME_REBASERS.block,
          input: {
            oldName,
            newName,
            fingerprint: planned.fingerprint,
            edits: planned.edits,
            ...(planned.sentences ? { sentences: planned.sentences } : {}),
            where: b.where,
          },
        },
        journalOperation: journal(
          { id: d.pageId, name: ctx.tree.node(projectId, d.pageId).data?.rawName ?? d.pageId },
          `${b.edits.length} occurrence(s) of “${oldName}” renamed`,
        ),
      });
      bodyLabels.push(`${b.where}: ${b.edits.length} occurrence(s) renamed`);
      wrote(d.pageId, at);
      textPages.add(d.pageId);
      prev = at;
    }
    const v = verify.length;
    verify.push({
      kind: 'checked',
      label: `${ctx.tree.node(projectId, d.pageId).data?.rawName ?? d.pageId}: text read back`,
      resourceId: d.pageId,
      documentId: d.documentId,
      checker: RENAME_CHECKS.documentVerify,
      input,
    });
    verifyItems.push(docItems);
    // The read-back of a block covers only its items that were approved and not skipped.
    verifyParts.push({
      path: `body.targets.${v}.input.blocks`,
      items: d.blocks.map((b) => [...new Set(b.edits.map((e) => e.item))]),
    });
    d.blocks.forEach((b, k) =>
      verifyParts.push({
        path: `body.targets.${v}.input.blocks.${k}.edits`,
        items: b.edits.map((e) => [e.item]),
      }),
    );
  }

  // 4b. Restatements in other pages' sidebar facts: each page one item (its rows are written in one checked chain).
  try {
    for (const pageId of factPages) {
      const node = ctx.tree.node(projectId, pageId).data;
      if (!node) continue;
      const p = await loadPage(node);
      const kv = p.sidebar.find((x) => x.kind === 'keyValue' && textKey(x.title) === textKey(prop));
      const facts: { key: string; value: Obj[] }[] = [];
      const changes: Change[] = [];
      let why: string | null = null;
      for (const row of kv?.rows ?? []) {
        const before = valueOf(row.content);
        if (!namesIn(before, oldName) || textKey(row.key) === textKey(aliasesKey)) continue;
        // CR-2026-11-R3 (R3-26): a fact naming a longer name that holds the old one (another character's identity
        // facts, say) is never planned: the row is renamed whole, so it would rename inside that name.
        const longer = longerNames.find((L) => namesIn(before, L));
        if (longer) {
          notPlanned.push({
            page: { id: pageId, name: node.rawName },
            why: `sidebar: ${row.key} names another name holding it (“${longer}”): never renamed`,
            snippet: before.slice(0, 240),
          });
          continue;
        }
        labelsIn(row.content, { id: pageId, name: node.rawName }, `sidebar: ${row.key}`, before);
        const runs = renamedRuns(row.content, oldName, newName);
        facts.push({ key: row.key, value: runs });
        changes.push({ what: row.key, before, after: valueOf(runs) });
        // CR-2026-11-R3 (R3-27): D1 (a) on every whole-name occurrence of the row (it is renamed whole), not the first
        // substring only: any quoted or "formerly" one unticks the item.
        for (const o of occurrences(before, oldName)) why ??= d1Why(before, o.start, [], unresolved);
      }
      if (facts.length === 0) continue;
      const item = `factText:${pageId}`;
      if (!addFacts(p, facts, item, `${node.rawName}: facts naming “${oldName}”`, false)) continue;
      const lifecycle = labelsOf(pageId)?.lifecycle ?? null;
      const current = lifecycle === null || lifecycle === 'Authoritative' || lifecycle === 'Working';
      items.push({
        id: item,
        kind: 'restatement',
        group: GROUPS.restatements,
        label: `${node.rawName}: ${changes.map((c) => c.what).join(', ')} (sidebar)`,
        page: { id: pageId, name: node.rawName },
        diff: { changes },
        dependsOn: root(),
        selected: current && why === null,
        ...(why ? { why } : !current ? { why: 'the page is not current' } : {}),
        ...((await auOf(pageId)) ? { tags: ['AU'] } : {}),
      });
    }
  } catch (e) {
    if (e instanceof PlanReadError) return { ok: false, result: e.result };
    throw e;
  }

  // 5. Chronology: rows naming the subject, each with its timeline event kept in step (the chronology tools' path).
  const chronologyHits = hits.filter((h) => h.documentId && ageTables.has(h.documentId));
  if (chronologyHits.length > 0 && !chronologyReady) {
    for (const h of chronologyHits)
      notPlanned.push({
        page: { id: h.pageId, name: reader.page(h.pageId)?.rawName ?? h.pageId },
        why: 'a chronology row: the chronology is not confirmed on this project, so its rows are not planned',
        snippet: h.snippet,
      });
  }
  if (chronologyHits.length > 0 && chronologyReady && pd.services?.chronology) {
    try {
      await planChronology(chronologyHits.map((h) => h.documentId!));
    } catch (e) {
      if (e instanceof PlanReadError) return { ok: false, result: e.result };
      throw e;
    }
  }

  async function planChronology(docIds: string[]): Promise<void> {
    const ch = pd.services!.chronology!;
    const config = chronologyReady!;
    let cal = ch.calendar(projectId, config.calendarId ?? undefined);
    if (!cal) {
      const r = (await read('listCalendars', {})) as { data?: unknown };
      const def = (Array.isArray(r.data) ? (r.data as Obj[]) : []).find((c) => c.id === config.calendarId);
      if (!def) {
        notes.push('The chronology’s calendar could not be read: its rows are not planned.');
        return;
      }
      cal = ch.remember(projectId, def);
    }
    let effective: number | null = null;
    if (input.effectiveDate) {
      try {
        effective = cal.parser.parse(input.effectiveDate, config.style.date).start;
      } catch {
        warnings.push(
          issue(
            'EFFECTIVE_DATE_UNREADABLE',
            `effectiveDate “${input.effectiveDate}” is not a date of the calendar; ignored.`,
          ),
        );
      }
    }
    const writes: TargetWrite[] = [];
    const rows: Record<string, WriteContext['rows'][string]> = {};
    const tableIds: Record<string, string> = {};
    const events: Record<string, Obj> = {};
    const writeItems: string[][] = [];
    const ages: string[] = [];
    const links = ch.store.links(projectId);
    /** Each row as planned (its block before the rename), for its write's rebase. */
    const planned = new Map<string, { block: Obj; description: string; where: string }>();
    for (const doc of [...new Set(docIds)]) {
      const age = ageTables.get(doc)!;
      const b = (await read('getDocumentBlocks', {
        path: { resourceId: config.resourceId!, documentId: doc },
      })) as Obj;
      const table = readAgeTable(
        Array.isArray(b.blocks) ? (b.blocks as unknown[]) : [],
        cal.parser,
        config.style.date,
        config.columns,
      );
      if (!table) continue;
      tableIds[doc] = table.table.id ?? '';
      for (const row of table.rows) {
        if (!row.id) continue;
        const runs = row.descriptionRuns as Obj[];
        const before = valueOf(runs);
        if (!namesIn(before, oldName)) continue;
        const chronologyPage = {
          id: config.resourceId!,
          name: ctx.tree.node(projectId, config.resourceId!).data?.rawName ?? 'Chronology',
        };
        // ADR 0058 amendment (D): a custom mention label is kept and listed for review; only the text is renamed.
        labelsIn(runs, chronologyPage, `${age.name} row “${row.dateText}”`, before);
        if (!namesIn(runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join(''), oldName)) continue;
        const after = valueOf(renamedRuns(runs, oldName, newName));
        const date = row.date ?? row.eventDate;
        if (!date) {
          notPlanned.push({
            page: {
              id: config.resourceId!,
              name: ctx.tree.node(projectId, config.resourceId!).data?.rawName ?? 'Chronology',
            },
            why: `the ${age.name} row “${row.dateText}”: its date cannot be read, so it is not planned`,
            snippet: before.slice(0, 240),
          });
          continue;
        }
        // X5: a row id is unique only within its table document (each age has its own).
        const item = `chronology:${rowKey(doc, row.id)}`;
        if (!ages.includes(age.name)) ages.push(age.name);
        const block = renameTextRuns(row.row.block, oldName, newName);
        planned.set(rowKey(doc, row.id), {
          block: row.row.block,
          description: before,
          where: `${age.name} row “${row.dateText}”`,
        });
        writes.push({
          kind: 'row.replace',
          age: age.name,
          resourceId: config.resourceId!,
          documentId: doc,
          rowId: row.id,
          before: { description: before, date: row.dateText, kcy: row.kcyText },
          texts: { description: after, date: row.dateText, kcy: row.kcyText },
          block,
        });
        writeItems.push([item]);
        rows[rowKey(doc, row.id)] = {
          sortKey: sortKey(date),
          date: { start: date.start, end: date.end, detail: date.detail },
          description: after,
        };
        // Its event, by the bridge's link (kept in step: its name renamed when it names the subject).
        const link = links.find((l) => l.tableDocumentId === doc && l.rowId === row.id);
        let eventNote =
          'its timeline event is not linked to it by the bridge: rename the event with sync_timeline_event if it names the subject';
        if (link) {
          const ev = (await read('getEvent', {
            path: {
              resourceId: config.resourceId!,
              documentId: link.timelineDocumentId,
              eventId: link.eventId,
            },
          }).catch(() => null)) as Obj | null;
          const evName = str(ev?.name);
          if (ev && evName) {
            events[link.eventId] = ev;
            if (namesIn(evName, oldName)) {
              writes.push({
                kind: 'event.update',
                age: age.name,
                resourceId: config.resourceId!,
                documentId: link.timelineDocumentId,
                eventId: link.eventId,
                fields: { name: replaceName(evName, oldName, newName) },
              });
              writeItems.push([item]);
              eventNote = `its event “${evName}” renamed with it`;
            } else eventNote = 'its event does not name the subject';
          }
        }
        const dated = effective !== null && date.start < effective;
        // CR-2026-11-R3 (R3-28): a row whose occurrence is quoted (or after "formerly"…) is left unticked, as D1 (a) asks
        // for every restatement (the row is renamed whole).
        let rowWhy: string | null = null;
        for (const o of occurrences(before, oldName)) rowWhy ??= d1Why(before, o.start, [], unresolved);
        const longerInRow = longerNames.find((L) => namesIn(before, L));
        if (longerInRow)
          rowWhy = `it also names another name holding it (“${longerInRow}”): check it by hand`;
        items.push({
          id: item,
          kind: 'chronology',
          group: GROUPS.chronology,
          label: `${age.name} row “${row.dateText}”: ${before.slice(0, 160)} (${eventNote})`,
          page: {
            id: config.resourceId!,
            name: ctx.tree.node(projectId, config.resourceId!).data?.rawName ?? 'Chronology',
          },
          diff: { before, after, context: row.dateText },
          dependsOn: root(),
          selected: !dated && rowWhy === null,
          ...(dated
            ? { why: `the row is dated before the rename’s effective date (${input.effectiveDate})` }
            : rowWhy
              ? { why: rowWhy }
              : {}),
        });
      }
    }
    if (writes.length === 0) return;
    const lanes: Record<string, { id: string; name: string }> = {};
    for (const a of config.ages) lanes[a.timelineDocumentId] = { id: a.laneId, name: a.laneName };
    const built = buildJob({
      tool: 'arkona_rename',
      config,
      target: { writes },
      writes,
      // CR-2026-11-R3 (R3-35): each row compared whole (its marks, links and icons), so a row edited since the plan in any
      // way is skipped, never written over from the plan (the option R2-16 made for Revert).
      ctx: {
        tableIds,
        mainTableId: '',
        rows,
        counts: {},
        lanes,
        events,
        rowBlocks: Object.fromEntries([...planned].map(([rowId, p]) => [rowId, p.block])),
      },
      record: { requestKey: `${RENAME_TOOL}:${renameId}`, ages, summary: `Rename ${oldName} to ${newName}` },
    });
    const base = stepNo() - 1;
    const chItems = [...new Set(writeItems.flat())];
    const itemOfWrite = (w: TargetWrite): string[] => {
      const i = writes.indexOf(w);
      return i >= 0 ? writeItems[i]! : [];
    };
    const itemOfRow = (documentId: string, rowId: string) => [`chronology:${rowKey(documentId, rowId)}`];
    const itemOfEvent = (eventId: string) => {
      const i = writes.findIndex((w) => w.kind === 'event.update' && w.eventId === eventId);
      return i >= 0 ? writeItems[i]! : [];
    };
    for (const [i, s] of built.steps.entries()) {
      const shifted = shiftStep(s, base);
      const label = built.labels[i] ?? s.op;
      const b = (s.params?.body ?? {}) as Obj;
      let its: string[] = chItems;
      const partsOut: ItemPartShape[] = [];
      let step: StepSpec = shifted;
      // CR-2026-11-R3 (R3-34): a linked event's rename judged inside its write's lock (renamed meanwhile: skipped).
      if (s.op === 'updateEvent') {
        const evId = String(s.params?.path?.eventId ?? '');
        const before = str(events[evId]?.name);
        const after = str(b.name);
        const item = itemOfEvent(evId)[0];
        if (before !== null && after !== null && item)
          step = {
            ...step,
            rebase: { rebaser: RENAME_REBASERS.event, input: { before, after, item }, always: true },
          };
      }
      if (s.op === EXPECT_STEP) {
        // ADR 0058 amendment (A): one check per row (and per event), each skipping only its own row's item when that
        // row (or its event) changed meanwhile. Every row's check keeps the table's label, so whichever rows are approved
        // (and not skipped), the chain reads the table's version under it.
        const cs: Obj[] = [];
        for (const c of (b.checks as Obj[]) ?? []) {
          const cin = isObj(c.input) ? c.input : null;
          if (c.kind === 'document' && cin && Array.isArray(cin.ops)) {
            const byRow = new Map<string, Obj[]>();
            const loose: Obj[] = [];
            for (const o of cin.ops as Obj[])
              if (typeof o.rowId === 'string') byRow.set(o.rowId, [...(byRow.get(o.rowId) ?? []), o]);
              else loose.push(o);
            if (byRow.size === 0) cs.push(c);
            [...byRow].forEach(([rowId, ops], k) =>
              cs.push({
                ...c,
                input: { ...cin, ops: k === 0 ? [...loose, ...ops] : ops },
                skipItems: itemOfRow(docIdOf(c.documentId), rowId),
              }),
            );
          } else if (c.kind === 'event' && itemOfEvent(String(c.eventId)).length > 0) {
            cs.push({ ...c, skipItems: itemOfEvent(String(c.eventId)) });
          } else cs.push(c);
        }
        step = { ...shifted, params: { ...shifted.params, body: { ...b, checks: cs } } };
        partsOut.push({
          path: 'body.checks',
          items: cs.map((c) => (Array.isArray(c.skipItems) ? (c.skipItems as string[]) : [])),
        });
      } else if (s.op === VERIFY_STEP) {
        const ts = (b.targets as Obj[]) ?? [];
        partsOut.push({
          path: 'body.targets',
          items: ts.map((t) =>
            t.kind === 'event'
              ? itemOfEvent(String(t.eventId))
              : isObj(t.input) && Array.isArray(t.input.rows)
                ? [
                    ...new Set(
                      (t.input.rows as Obj[]).flatMap((r) =>
                        typeof r.rowId === 'string' ? itemOfRow(docIdOf(t.documentId), r.rowId) : [],
                      ),
                    ),
                  ]
                : [],
          ),
        });
        ts.forEach((t, k) => {
          if (isObj(t.input) && Array.isArray(t.input.rows))
            partsOut.push({
              path: `body.targets.${k}.input.rows`,
              items: (t.input.rows as Obj[]).map((r) =>
                typeof r.rowId === 'string' ? itemOfRow(docIdOf(t.documentId), r.rowId) : [],
              ),
            });
        });
      } else if (s.op === RECORD_STEP && b.action === 'begin') {
        const rec = (b.record ?? {}) as Obj;
        const target = (rec.target ?? {}) as Obj;
        partsOut.push({
          path: 'body.record.target.writes',
          items: ((target.writes as TargetWrite[]) ?? []).map((w) => itemOfWrite(w)),
        });
      } else if (s.op === 'replaceBlock') {
        const rowId = String(s.params?.path?.blockId ?? '');
        const docId = String(s.params?.path?.documentId ?? '');
        its = itemOfRow(docId, rowId);
        const was = planned.get(rowKey(docId, rowId));
        // ADR 0058 amendment (A): the table changed since the check: the row renamed again on its text as it is, if that
        // text is exactly as planned; otherwise the row's item is skipped.
        if (was)
          step = {
            ...shifted,
            rebase: {
              rebaser: RENAME_REBASERS.row,
              input: {
                oldName,
                newName,
                fingerprint: fingerprint(was.block, oldName, newName),
                item: `chronology:${rowKey(docId, rowId)}`,
                before: was.description,
                where: was.where,
              },
            },
          };
      } else if (s.op === 'updateEvent') {
        its = itemOfEvent(String(s.params?.path?.eventId ?? ''));
      }
      const at = stepNo();
      body.push({ ...step, items: its, ...(partsOut.length > 0 ? { itemParts: partsOut } : {}) });
      bodyLabels.push(label);
      if (!s.op.startsWith('bridge.')) {
        wrote(config.resourceId!, at);
        textPages.add(config.resourceId!);
      }
    }
    for (const it of chItems) touch(config.resourceId!, it);
  }

  // 6. Taxonomy and art: the character's art folder (where its art is placed, F3b) and the asset names in it holding the
  // old name.
  const images = pd.services?.images;
  const assetQueries = pd.services?.assets?.queries;
  let artFolderId: string | null = null;
  if (images && assetQueries && kind === 'character') {
    const raceKey = fieldKey('race') ?? 'Race / Species';
    let race: string | null = valueOf(rowOf(identityPage.sidebar, raceKey)?.content ?? []).trim() || null;
    if (race !== null) {
      try {
        ctx.types.raceIndex(race);
      } catch {
        race = null;
      }
    }
    // The folder is named after the subject: by its old name (a follow-up: by either, the old first).
    for (const name of followUp ? [oldName, newName] : [oldName]) {
      const planned = images.plan(projectId, { for_character: { name, race } });
      if (planned.ok && planned.plan.wouldCreate.length === 0 && planned.plan.destination.folderId) {
        artFolderId = planned.plan.destination.folderId;
        break;
      }
    }
  }
  const assetsSvc = assetQueries ? { queries: assetQueries } : null;
  if (artFolderId) {
    const folder = assetsSvc!.queries.folder(projectId, artFolderId).data;
    if (folder && namesIn(folder.name, oldName)) {
      const nextName = replaceName(folder.name, oldName, newName);
      const twin = assetsSvc!.queries
        .children(projectId, folder.parentId)
        .data.find((f) => f.id !== folder.id && f.name === nextName);
      if (twin)
        notPlanned.push({
          page: null,
          why: `the art folder “${folder.name}”: a folder “${nextName}” is already beside it`,
          snippet: null,
        });
      else addAsset(folder.id, folder.name, nextName, folder.parentId, 'folder');
    }
    const folders = [
      artFolderId,
      ...assetsSvc!.queries.subtree(projectId, artFolderId).data.folders.map((f) => f.folder.id),
    ];
    for (const f of folders) {
      const list = assetsSvc!.queries.assetsIn(projectId, f, { limit: 2000 }).data.assets;
      for (const a of list) {
        if (!namesIn(a.name, oldName)) continue;
        const nextName = replaceName(a.name, oldName, newName);
        if (list.some((x) => x.id !== a.id && x.name === nextName)) {
          notPlanned.push({
            page: null,
            why: `the asset “${a.name}”: “${nextName}” is already in its folder`,
            snippet: null,
          });
          continue;
        }
        addAsset(a.id, a.name, nextName, a.folderId, 'asset');
      }
    }
  }
  // A race's taxonomy entry (the Character taxonomy places characters by it).
  if (kind === 'race' && raceNav) {
    const entry = pd.services?.registry?.forProject(projectId).store.entryBySource(raceNav.id);
    const navItem = nameItemOf.get(raceNav.id);
    if (!navItem && !followUp)
      notPlanned.push({
        page: { id: raceNav.id, name: raceNav.rawName },
        why: `the race's character navigation is named “${raceNav.displayName}”, not “${oldName}”: rename it (and its taxonomy entry) by hand if it should change`,
        snippet: null,
      });
    if (entry && navItem && textKey(entry.plural) === textKey(oldName)) {
      const item = `taxonomy:${entry.id}`;
      body.push({
        op: RECORD_STEP,
        params: {
          body: {
            action: 'complete',
            store: 'pack',
            record: { kind: 'taxonomy_rename', entryId: entry.id, plural: newName, from: oldName },
          },
        },
        items: [item],
      });
      bodyLabels.push(`the Character taxonomy: ${oldName} → ${newName}`);
      items.push({
        id: item,
        kind: 'taxonomy',
        group: GROUPS.art,
        label: `Character taxonomy entry “${entry.plural}” → “${newName}” (the old name kept as its alias; its asset folder “${entry.assetFolder}” kept)`,
        diff: { before: entry.plural, after: newName },
        dependsOn: [navItem],
        selected: true,
      });
    }
  }

  function addAsset(
    id: string,
    name: string,
    nextName: string,
    folderId: string | null,
    what: 'folder' | 'asset',
  ) {
    const item = `${what}:${id}`;
    checks.push({
      label: `asset:${id}`,
      kind: 'registered',
      checker: RENAME_CHECKS.asset,
      input: { assetId: id, names: [name, nextName], folderId, item },
    });
    checkItems.push([item]);
    body.push({
      op: 'updateAsset',
      params: { path: { assetId: id }, body: { name: nextName } },
      judgedInLock: true,
      items: [item],
      // CR-2026-11-R3 (R3-33): judged again inside the write's lock (the first check runs without locks).
      rebase: {
        rebaser: RENAME_REBASERS.asset,
        input: { names: [name, nextName], folderId, item },
        always: true,
      },
      journalOperation: journal(null, `${what} “${name}” renamed “${nextName}”`),
    });
    bodyLabels.push(`${what} “${name}” → “${nextName}”`);
    items.push({
      id: item,
      kind: what === 'folder' ? 'art_folder' : 'asset_name',
      group: GROUPS.art,
      label: `${what === 'folder' ? 'Art folder' : 'Asset'} “${name}” → “${nextName}”`,
      diff: { before: name, after: nextName },
      dependsOn: root(),
      selected: true,
    });
    verify.push({
      kind: 'registered',
      label: `${what} “${nextName}”`,
      checker: RENAME_CHECKS.assetVerify,
      input: { assetId: id, names: [nextName], folderId },
    });
    verifyItems.push([item]);
  }

  // 7. The identity token (D3): the pack's token map as a new version for the owner, and every character's fact and tag.
  let token: RenamePlan['token'] = null;
  if (kind === 'culture' || kind === 'race') {
    const map = kind;
    const tokens = rules.tags[map];
    const oldKey = Object.keys(tokens).find((k) => textKey(k) === textKey(oldName)) ?? null;
    if (oldKey) {
      const oldToken = tokens[oldKey]!;
      const newToken = input.token?.trim() || (textKey(oldToken) === textKey(oldKey) ? newName : null);
      if (!newToken) {
        refusals.push(
          issue(
            'TOKEN_REQUIRED',
            `The ${map} “${oldKey}” is tagged “${oldToken}”, which is not its name: give token (the new tag) as the owner decided; the bridge never infers a tag.`,
          ),
        );
      } else {
        const item = `token:${map}`;
        token = { packId: basis.pack.id, map, from: oldKey, to: newName, oldToken, newToken, item };
        checks.push({
          label: `token:${map}`,
          kind: 'registered',
          checker: RENAME_CHECKS.pack,
          input: { packId: basis.pack.id, map, value: newName, token: newToken },
        });
        checkItems.push([item]);
        items.push({
          id: item,
          kind: 'identity_token',
          group: GROUPS.token,
          label: `Pack token map: ${map} “${oldKey}” → “${newName}”, tag “${oldToken}” → “${newToken}” (a new pack version: you approve it on the Packs page, and this rename's job waits for that approval)`,
          diff: { before: `${oldKey} → ${oldToken}`, after: `${newName} → ${newToken}` },
          dependsOn: root(),
          selected: true,
        });
      }
    } else
      notes.push(`The ${map} “${oldName}” has no tag token in the pack: no tag changes, only the facts.`);
    const factKey = tokenFactKey!;
    try {
      for (const pageId of tokenPages) {
        const node = ctx.tree.node(projectId, pageId).data;
        if (!node || setIds.has(pageId)) continue;
        const p = await loadPage(node);
        const row = rowOf(p.sidebar, factKey);
        if (!row || textKey(valueOf(row.content)) !== textKey(oldName)) continue;
        const item = `character:${pageId}`;
        const tags = Array.isArray(p.resource.tags) ? (p.resource.tags as string[]) : [...node.tags];
        const nextTags = token ? tags.map((t) => (t === token!.oldToken ? token!.newToken : t)) : tags;
        if (
          !addFacts(
            p,
            [{ key: row.key, value: [{ text: newName }] }],
            item,
            `${node.rawName}: ${factKey}`,
            false,
          )
        )
          continue;
        const changes: Change[] = [{ what: factKey, before: valueOf(row.content), after: newName }];
        if (nextTags.join('\u0001') !== tags.join('\u0001')) {
          touch(pageId, item);
          wrote(pageId, stepNo());
          body.push({
            op: 'updateResource',
            params: { path: { resourceId: pageId }, body: { tags: nextTags } },
            expectCurrent: {
              state: 'resource',
              hash: stateHash({ name: node.rawName, tags }),
              label: node.rawName,
            },
            judgedInLock: true,
            deferTreeReread: true,
            items: [item],
            // ADR 0058 amendment (A): the tag swapped on the page's tags as they are when it runs (inside its lock).
            rebase: {
              rebaser: RENAME_REBASERS.resource,
              input: { kind: 'tags', from: token!.oldToken, to: token!.newToken, item },
              always: true,
            },
            journalOperation: journal(
              { id: pageId, name: node.rawName },
              `identity tag ${token!.oldToken} → ${token!.newToken}`,
            ),
          });
          bodyLabels.push(`${node.rawName}: tag ${token!.oldToken} → ${token!.newToken}`);
          changes.push({ what: 'tags', before: tags.join(', '), after: nextTags.join(', ') });
          verify.push({
            kind: 'resource',
            label: `${node.rawName}: tags`,
            resourceId: pageId,
            fields: { tags: nextTags },
          });
          verifyItems.push([item]);
        }
        items.push({
          id: item,
          kind: 'identity_token_character',
          group: GROUPS.token,
          label: `${node.rawName}: ${factKey} “${valueOf(row.content)}” → “${newName}”${changes.length > 1 ? `; tag ${token!.oldToken} → ${token!.newToken}` : ''}`,
          page: { id: pageId, name: node.rawName },
          diff: { changes },
          dependsOn: token ? [token.item] : root(),
          selected: true,
          ...((await auOf(pageId)) ? { tags: ['AU'] } : {}),
        });
      }
    } catch (e) {
      if (e instanceof PlanReadError) return { ok: false, result: e.result };
      throw e;
    }
  }

  /** A page's facts (one item: its rows written in one checked chain), as the facts tools plan them. */
  function addFacts(
    p: { node: TreeNode; sidebar: SidebarProperty[] },
    facts: { key: string; value: Obj[] }[],
    item: string,
    what: string,
    core: boolean,
  ): boolean {
    let plan;
    try {
      plan = planFacts({
        resourceId: p.node.id,
        sidebar: p.sidebar,
        propertyTitle: prop,
        facts: facts.map((f) => ({ key: f.key, value: f.value })),
        links: [],
        templateKeys: null,
      });
    } catch (e) {
      if (e instanceof FactsPlanError) {
        notPlanned.push({
          page: { id: p.node.id, name: p.node.rawName },
          why: `${what}: ${e.message}`,
          snippet: null,
        });
        return false;
      }
      throw e;
    }
    if (plan.empty) return false;
    const fx = expandFacts(plan, { id: p.node.id, name: p.node.rawName }, p.sidebar, { facts, links: null });
    const base = stepNo() - 1;
    // ADR 0058 amendment (A): each fact the rename changes must still hold its old value (or already its new one): a
    // page's other facts may change meanwhile. Core (the set's identity facts): a fact changed meanwhile stops the job;
    // otherwise the item is skipped.
    const changed = new Set(
      plan.facts.filter((f) => f.change === 'added' || f.change === 'changed').map((f) => textKey(f.key)),
    );
    const changes: FactChangeInput[] = facts
      .filter((f) => changed.has(textKey(f.key)))
      .map((f) => {
        const row = rowOf(p.sidebar, f.key);
        return { key: f.key, before: row ? runsValue(row.content) : null, after: runsValue(f.value) };
      });
    const propertyId = plan.property?.id ?? '';
    const kvLabel = plan.property ? plan.property.title : 'facts';
    const where = `${p.node.rawName} (sidebar)`;
    for (const s0 of fx.steps) {
      let s: StepSpec = s0;
      if (s.op === EXPECT_STEP) {
        s = {
          ...s,
          params: {
            body: {
              checks: [
                {
                  label: kvLabel,
                  kind: 'registered',
                  checker: RENAME_CHECKS.facts,
                  resourceId: p.node.id,
                  input: { resourceId: p.node.id, propertyId, facts: changes, core, item, where },
                },
              ],
            },
          },
        };
      } else if (s.op === VERIFY_STEP) {
        s = {
          ...s,
          params: {
            body: {
              targets: [
                {
                  kind: 'registered',
                  label: `${p.node.rawName}: facts`,
                  checker: RENAME_CHECKS.factsVerify,
                  input: { resourceId: p.node.id, propertyId, facts: changes },
                },
              ],
            },
          },
        };
      } else if (s.op === 'updatePropertyRow' || s.op === 'createPropertyRow') {
        const key = typeof s.journalOperation?.factKey === 'string' ? s.journalOperation.factKey : null;
        const change = changes.find((c) => key !== null && textKey(c.key) === textKey(key));
        if (change)
          s = {
            ...s,
            rebase: {
              rebaser: RENAME_REBASERS.factRow,
              input: { ...change, item, where },
              ...(core ? { core: true } : {}),
            },
          };
      }
      const at = stepNo();
      body.push({
        ...shiftStep(s, base),
        judgedInLock: s.op !== EXPECT_STEP && s.op !== VERIFY_STEP ? true : undefined,
        items: [item],
        ...(s.journalOperation
          ? { journalOperation: { ...s.journalOperation, tool: RENAME_TOOL, rename: renameId } }
          : {}),
      } as StepSpec);
      const write = (s.journalOperation as Obj | undefined)?.write;
      bodyLabels.push(
        s.op === EXPECT_STEP
          ? 'check'
          : s.op === VERIFY_STEP
            ? 'verify'
            : `${p.node.rawName}: ${typeof write === 'string' ? write : s.op}`,
      );
      if (s.op !== EXPECT_STEP && s.op !== VERIFY_STEP) wrote(p.node.id, at);
    }
    touch(p.node.id, item);
    // ADR 0051 with ADR 0058: a fact whose only change is the old name for the new one, a name part the owner gave or
    // the old name added to the Aliases fact is the page's name in another place: like the page name, it never counts.
    // Any other change of a fact is evidence for the rule (measured when the job runs, with what was approved).
    const ev = known.get(p.node.id) ?? [];
    for (const f of plan.facts) {
      if (f.change !== 'added' && f.change !== 'changed' && f.change !== 'removed') continue;
      const before = typeof f.before === 'string' ? f.before : null;
      const after = typeof f.after === 'string' ? f.after : null;
      const nameOnly =
        textKey(f.key) === textKey(aliasesKey) ||
        parts.some((x) => textKey(x.key) === textKey(f.key)) ||
        (before !== null && after !== null && replaceName(before, oldName, newName) === after);
      if (!nameOnly) ev.push({ kind: 'fact', key: f.key, before, after, item });
    }
    known.set(p.node.id, ev);
    return true;
  }

  // 8. Last Major Revision: per page, by ADR 0051's rule, measured when the job runs from what was approved.
  const lmrKey = basis.lifecycle.fields.lastMajorRevision;
  const mode: LmrMode = input.lastMajorRevision ?? 'auto';
  let lmrPages = 0;
  let lmrMinor = 0;
  if (mode !== 'skip' && basis.lmrOnChanges) {
    for (const [pageId, steps] of pageWrites) {
      const its = [...(pageItems.get(pageId) ?? [])];
      if (its.length === 0) continue;
      const node = ctx.tree.node(projectId, pageId).data;
      const sb = set.get(pageId)?.sidebar;
      if (sb && !rowOf(sb, lmrKey)) continue; // known to have no such row
      // ADR 0051: a page whose only changes are names (its name, aliases, tags, facts that only swap the name) is known
      // at planning not to be a major revision: no steps. Text and chronology rows are measured when the job runs.
      if (mode === 'auto' && !textPages.has(pageId) && (known.get(pageId) ?? []).length === 0) {
        lmrMinor++;
        continue;
      }
      const lmrStep = stepNo();
      body.push({
        op: LMR_STEP,
        params: {
          body: {
            resourceId: pageId,
            key: lmrKey,
            after: steps,
            page: (node?.rawName ?? pageId).slice(0, 500),
            why: mode === 'set' ? 'lastMajorRevision "set" was asked' : 'a rename (measured when it runs)',
            ...(mode === 'set' ? {} : { measure: { known: known.get(pageId) ?? [] } }),
          },
        },
        followUp: 'lmr_failed',
        items: its,
      });
      bodyLabels.push(`${lmrKey} of ${node?.rawName ?? pageId}`);
      body.push({
        op: 'updatePropertyRow',
        params: {
          path: { resourceId: pageId, propertyId: pageId, rowId: pageId },
          body: { content: [{ text: 'date of approval' }] },
        },
        decisionFrom: { step: lmrStep },
        ifMatchFrom: { step: lmrStep, key: 'lmr' },
        followUp: 'lmr_failed',
        judgedInLock: true,
        deferTreeReread: true,
        items: its,
        journalOperation: journal({ id: pageId, name: node?.rawName ?? pageId }, `${lmrKey}: today`),
      });
      bodyLabels.push(`${lmrKey} of ${node?.rawName ?? pageId}: today`);
      touch(pageId, its[0]!);
      lmrPages++;
    }
  }

  // ---------------------------------------------------------------------------------------------- review only (B, D)
  // ADR 0058 amendment: the old name's parts on their own and the old aliases, and the custom labels, for the owner to
  // look at; never items. A follow-up has no old parts to read (the identity facts hold the new ones by then).
  const plainValue = (key: string) => {
    const v = valueOf(rowOf(identityPage.sidebar, key)?.content ?? []).trim();
    return v === '' || rules.types[0]?.placeholders.some((x) => textKey(x) === textKey(v)) === true
      ? null
      : v;
  };
  const aliasValue = plainValue(aliasesKey);
  const review = reviewList(
    {
      projectId,
      search: (pid, value) => env.appraisal.fullText.search(pid, [{ value, phrase: true }], { limit: 5000 }),
      labels: (pageId) => labelsOf(pageId),
      pageName: (pageId) =>
        reader.page(pageId)?.rawName ?? ctx.tree.node(projectId, pageId).data?.rawName ?? null,
      characterOf: (pageId) => {
        try {
          const c = ctx.types.characterOfPage(pageId);
          return c.ok ? c.value.subject || null : null;
        } catch {
          return null;
        }
      },
    },
    {
      subjectName: followUp ? newName : oldName,
      oldName,
      parts: followUp
        ? []
        : reviewParts({
            oldName,
            newName,
            given: kind === 'character' ? plainValue(givenKey) : null,
            family: kind === 'character' ? plainValue(familyKey) : null,
            aliases: aliasValue ? aliasValue.split(/\s*;\s*/) : [],
          }),
      customLabels,
    },
  );

  // ---------------------------------------------------------------------------------------------- the job
  if (items.length === 0 && refusals.length === 0)
    refusals.push(
      issue(
        'NOTHING_TO_RENAME',
        followUp
          ? `Nothing of “${oldName}” is left to rename on current pages (as of the full-text index).`
          : `Nothing to rename was found for ${identity.rawName}.`,
      ),
    );
  // CR-2026-11-R3 (R3-29): history (D2) judged again when the job runs: a page with restatements archived, or filed
  // under the Legacy Canon Archive or the Design References, since the plan has its items skipped, never written.
  const restatementPages = new Map<string, { name: string; items: string[] }>();
  for (const it of items)
    if (it.kind === 'restatement' && it.page) {
      const e = restatementPages.get(it.page.id) ?? { name: it.page.name, items: [] };
      e.items.push(it.id);
      restatementPages.set(it.page.id, e);
    }
  if (restatementPages.size > 0) {
    const c = checks.length;
    const hp = [...restatementPages.entries()].map(([pageId, e]) => ({
      pageId,
      name: e.name,
      items: e.items,
    }));
    checks.push({
      label: 'history',
      kind: 'registered',
      checker: RENAME_CHECKS.history,
      input: {
        archiveIndexId: basis.lifecycle.archiveIndexId ?? null,
        pages: hp,
      } satisfies HistoryCheckInput,
    });
    checkItems.push([...new Set(hp.flatMap((x) => x.items))]);
    checkParts.push({ path: `body.checks.${c}.input.pages`, items: hp.map((x) => x.items) });
    hp.forEach((x, k) =>
      checkParts.push({ path: `body.checks.${c}.input.pages.${k}.items`, items: x.items.map((i) => [i]) }),
    );
  }
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: { body: { checks } },
      itemParts: [{ path: 'body.checks', items: checkItems }, ...checkParts],
    },
    ...body,
    {
      op: VERIFY_STEP,
      params: { body: { targets: verify } },
      itemParts: [{ path: 'body.targets', items: verifyItems }, ...verifyParts],
    },
  ];
  const labels = ['check', ...bodyLabels, 'verify'];
  if (verify.length === 0) {
    steps.pop();
    labels.pop();
  }
  const sorted = sortItems(items);
  const { writes, reads: jobReads } = jobCost(steps);
  const summary = `${RENAME_TOOL}: ${followUp ? `what is left of “${oldName}”` : `“${oldName}” → “${newName}”`} (${kind}): ${sorted.length} item${sorted.length === 1 ? '' : 's'}, ${sorted.filter((i) => i.selected).length} ticked`;
  notes.push(
    'Every edit is its own item: untick what should keep the old name; an item that needs an unticked one is dropped with it, and the page says which before you approve.',
  );
  if (token)
    notes.push(
      `This rename changes the pack's ${token.map} token map. Approved with that item, the bridge makes a new pack version (${token.from} → ${token.to}, tag ${token.oldToken} → ${token.newToken}) for you to approve on the Packs page; the rename's job waits for that approval, then runs.`,
    );
  return {
    ok: true,
    plan: {
      renameId,
      subject: { id: identity.id, name: identityName, kind, indexId: index?.id ?? null },
      oldName,
      newName,
      followUp,
      items: sorted,
      steps,
      labels,
      review,
      historical,
      notPlanned,
      refusals,
      warnings,
      notes,
      replacements,
      token,
      reads,
      cost: { planReads: reads, jobWrites: writes, jobReads },
      lmr: { mode, pages: lmrPages, minor: lmrMinor, switchedOff: !basis.lmrOnChanges },
      summary,
      prefetched,
    },
  };
}

/**
 * What the job costs with every item approved, from the engine's own rules (src/jobs/op-meta.ts): one read per check
 * and per read-back target (a pack token check reads nothing), one read before each write that keeps a pre-image or is
 * guarded (unless the plan supplies it), one before a versioned write with no If-Match of its own, and at most two for
 * each Last Major Revision that is set (the row and its version). The tests pin the measured figures.
 */
export function jobCost(steps: readonly StepSpec[]): { writes: number; reads: number } {
  let writes = 0;
  let reads = 0;
  for (const s of steps) {
    const b = (s.params?.body ?? {}) as Obj;
    if (s.op === EXPECT_STEP) {
      for (const c of (b.checks as Obj[] | undefined) ?? [])
        if (!(c.kind === 'registered' && c.checker === RENAME_CHECKS.pack)) reads++;
      continue;
    }
    if (s.op === VERIFY_STEP) {
      reads += ((b.targets as unknown[] | undefined) ?? []).length;
      continue;
    }
    if (s.op === LMR_STEP) {
      reads += 2;
      continue;
    }
    if (s.op.startsWith('bridge.')) continue;
    writes++;
    const meta = opMeta(s.op);
    const def = getOperation(s.op);
    const chained = s.ifMatchFrom !== undefined;
    if (
      meta.guard !== undefined ||
      (meta.journal === 'pre-image' && s.journalPreImage === undefined) ||
      (def?.versioned === true && !chained) ||
      (s.expectCurrent !== undefined && !chained)
    )
      reads++;
  }
  return { writes, reads };
}

/** A page's raw name before (`old`) or after (`new`) the rename. */
function renamedRaw(
  raw: string,
  newName: string,
  oldName: string,
  followUp: boolean,
  which: 'old' | 'new',
): string {
  const c = classifyName(raw);
  const prefix = raw.slice(0, raw.length - c.displayName.length);
  if (followUp) {
    // The page already has its new name: its old one is the old subject in it.
    return which === 'new' ? raw : `${prefix}${renamedDisplay(c.displayName, newName, oldName)}`;
  }
  return which === 'old' ? raw : `${prefix}${renamedDisplay(c.displayName, oldName, newName)}`;
}

/** The items in the design's order: by group, then as found. */
function sortItems(items: PlanItem[]): PlanItem[] {
  const order: string[] = Object.values(GROUPS);
  return [...items].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

export class PlanReadError extends Error {
  constructor(readonly result: McpToolResult) {
    super('a read of the plan failed');
  }
}

function refused(pd: ProjectDeps, refusals: Issue[]): { ok: false; result: McpToolResult } {
  return { ok: false, result: refusalResult(pd, refusals) };
}

/** The refusal of a plan, as the pack tools give one: the first one's code and message, every one listed. */
export function refusalResult(pd: ProjectDeps, refusals: readonly Issue[], extra: Obj = {}): McpToolResult {
  // Imported late to keep this module's surface small.

  const first = refusals[0]!;
  const { code, message, ...details } = first;
  return renderError(pd, {
    ...details,
    code,
    message:
      refusals.length === 1
        ? message
        : `${message} (and ${refusals.length - 1} more refusal${refusals.length === 2 ? '' : 's'}: see refusals)`,
    refusals,
    ...extra,
  });
}

let renderError: (pd: ProjectDeps, body: Obj) => McpToolResult = () => ({
  content: [{ type: 'text', text: '' }],
  isError: true,
});

/** Set once by the tool module (avoids an import cycle with the MCP shape helpers). */
export function setRenameErrorRenderer(fn: (pd: ProjectDeps, body: Obj) => McpToolResult): void {
  renderError = fn;
}

export type { AgeRow };
