/**
 * The lifecycle guard (v2 C2c, ADR 0035; Part 3, decided by the owner): lifecycle changes happen ONLY through the four
 * lifecycle tools (and the creation tools' `status`). It sits in the engine beside the protected canonical facts guard
 * (src/facts/canonical.ts), so every write path is judged: set_facts, `lk_api_write`, `lk_api_batch`, every `lk_op_*`,
 * the resource tools and an approved proposal. It refuses, naming the right tool:
 *
 * - a Status change to or from Working or Archived (and so from Working to Authoritative), by any sidebar write or a
 *   page created from a template that carries one;
 * - a rename that adds, removes or changes a `[BWRK]` or `[BARC]` prefix (turning either into `[BSRC]` included), and a
 *   page created with one;
 * - a move of a page into or out of `[INDEX] Working` or `[INDEX] Archived` (or between them), and a page created under
 *   either.
 *
 * The tools' own steps are allowed only through the job's lifecycle marker (`BatchSubmit.lifecycle`), which bridge code
 * alone sets and which names exactly the pages the job changes: an agent's body can never carry one. A marker of the four
 * lifecycle tools (`canonical`) also makes the request a proposal that only the owner's "Approve and accept as canon"
 * can run, at every scope; at execution the token is checked again, and every change is judged again inside the lock.
 *
 * CR-2026-11-R4 (ADR 0065 amendment 2): Narratives is an area the guard knows too (its one index, by id, as the
 * narrative tools resolve it). A page or subtree moved INTO Narratives (or created, copied or restored there) where no
 * narrative job declares it, or moved OUT of it, is a proposal at every scope; when any page of it carries a lifecycle
 * signal (src/narrative/signals.ts) it loses (or regains) its lifecycle, so only the owner's canonical approval runs
 * it, and the proposal names those pages. The narrative indexes' names are never given to a page, and the Narratives
 * index itself is never renamed by the tools. Judged at entry and again inside the lock.
 */
import { isCanonicalApproval } from '../policy/approval.js';
import { PolicyDeniedError, type JobEngine, LkOperationError } from '../jobs/index.js';
import { SYSTEM_PRINCIPAL, type LifecycleMarker, type OpParams } from '../jobs/types.js';
import { ownerForcedProposal } from '../jobs/write-guard.js';
import type {
  WriteGuard,
  WriteGuardEntry,
  WriteGuardInLock,
  WriteGuardVerdict,
} from '../jobs/write-guard.js';
import { canonConfigFrom, factKey, factValueKey, statusTagsGuarded } from '../facts/rules.js';
import {
  SIDEBAR_WRITE_OPS,
  applySidebarWrite,
  factRows,
  sidebarFrom,
  valueSignature,
  valueText,
  type SidebarProperty,
} from '../facts/sidebar.js';
import { CASCADE_READ_LIMIT, listSubtree } from '../facts/canonical.js';
import { classifyName, type TreeNode } from '../tree/index.js';
import { areaOf, lifecycleFrom, type LifecycleConfig } from './settings.js';
import type { LifecycleTagRules } from './tags.js';
import type { RestoreSet, RestoredWith } from './deleted.js';
import { lifecycleSignals } from '../narrative/signals.js';

type Obj = Record<string, unknown>;
type Area = 'working' | 'archived' | null;
type State = 'authoritative' | 'working' | 'archived';

/**
 * CR-2026-11-R4 (ADR 0065 amendment 2): Narratives as the guard knows it, from the approved pack's narrative rules and
 * the repository tree (the narrative tools' own resolution, by id).
 */
export interface NarrativeArea {
  /** The one Narratives index; null when it is missing or ambiguous (then no page is narrative: the lifecycle stays). */
  readonly rootId: string | null;
  /** The narrative indexes' names (Narratives, Continuities, Main CANON). */
  readonly indexNames: { readonly narratives: string; readonly continuities: string; readonly main: string };
  /** The narrative tag (`Narrative`) and the AU continuity's tag (`AU`). */
  readonly narrativeTag: string;
  readonly auTag: string;
}

/** A page moved, created or restored into or out of Narratives, with the pages of it that carry a lifecycle signal. */
interface NarrativeCrossing {
  readonly direction: 'into' | 'out';
  /** Each page that loses (into) or regains (out) its lifecycle, with its signals; any entry needs canonical approval. */
  readonly loses: readonly string[];
}

/** One lifecycle change a request would make. */
export interface LifecycleChange {
  readonly resourceId: string;
  readonly page: string;
  /**
   * What changes: the Status, the prefix, or the place. CR-2026-11: `index`, a lifecycle index itself (renamed, moved,
   * deleted, or a second page given its name), always refused; `canon`, a page made `[BSRC]` (Authoritative) by a create
   * or rename that no lifecycle tool or creation tool declares: a canonical proposal. C2d (ADR 0036 decision 7): `tag`,
   * a status tag added or removed.
   */
  readonly what: 'status' | 'prefix' | 'place' | 'create' | 'index' | 'canon' | 'tag' | 'narrative';
  /** The state it moves to, as far as the change tells. */
  readonly to: State | null;
  readonly text: string;
  /** The tool to use instead. */
  readonly tool: string;
  readonly stepIndex?: number;
  /**
   * CR-2026-11-R2 (R2-14): no lifecycle marker declares it (a page created outside the lifecycle area its own state or
   * its marker gives it, as LegendKeeper holds that area now).
   */
  readonly undeclarable?: true;
  /**
   * CR-2026-11-R4 (F2): the change is the first state of a page the same request (or job) creates: its name, place, and
   * the Status and tags its template gives it. A marker's `to: null` declares it; for a page that exists it declares only
   * where the page is placed.
   */
  readonly made?: true;
  /** CR-2026-11-R4 (F1): `what: 'narrative'`: the crossing, and the pages of it that carry a lifecycle signal. */
  readonly narrative?: NarrativeCrossing;
}

const TOOL_TO: Readonly<Record<State, string>> = {
  archived: 'archive_page',
  working: 'move_to_working',
  authoritative: 'promote_page',
};
const TOOL_FROM: Readonly<Record<'working' | 'archived', string>> = {
  archived: 'unarchive_page',
  working: 'promote_page (to make it Authoritative) or archive_page (to retire it)',
};

/** The lifecycle states the Status values name (`other` for anything else). */
function statusClass(c: LifecycleConfig, value: string): State | 'other' {
  const v = factValueKey(value);
  if (v === factValueKey(c.status.working)) return 'working';
  if (v === factValueKey(c.status.archived)) return 'archived';
  if (v === factValueKey(c.status.authoritative)) return 'authoritative';
  return 'other';
}

/**
 * The lifecycle change between a page's Status values before and after a write (pure): the number of Working or
 * Archived values changes. Null when there is none. `isNew`: the page is being created (the tool is then a create's).
 */
export function statusChange(
  c: LifecycleConfig,
  before: readonly string[],
  after: readonly string[],
  isNew = false,
): {
  readonly to: State | null;
  readonly from: 'working' | 'archived' | null;
  readonly tool: string;
  readonly text: string;
} | null {
  const count = (l: readonly string[], s: State) => l.filter((v) => statusClass(c, v) === s).length;
  for (const s of ['archived', 'working'] as const) {
    const b = count(before, s);
    const a = count(after, s);
    if (a === b) continue;
    const shown = (l: readonly string[]) =>
      l.length === 0 ? '(nothing)' : l.map((v) => `“${v}”`).join(', ');
    if (a > b) {
      return {
        to: s,
        from: null,
        tool: isNew
          ? s === 'working'
            ? 'create_resource with status "working"'
            : 'archive_page'
          : TOOL_TO[s],
        text: `Status would be set to ${c.status[s]} (it is ${shown(before)})`,
      };
    }
    const to = after.some((v) => statusClass(c, v) === 'authoritative') ? 'authoritative' : null;
    return {
      to,
      from: s,
      tool: s === 'working' && to === 'authoritative' ? 'promote_page' : TOOL_FROM[s],
      text: `Status would change from ${c.status[s]} to ${shown(after)}`,
    };
  }
  return null;
}

/** The lifecycle change of a prefix change (pure), or null: a `[BWRK]` or `[BARC]` prefix added, removed or changed. */
export function prefixChange(
  fromKind: string | null,
  toKind: string,
): { readonly to: State | null; readonly tool: string } | null {
  if (fromKind === toKind) return null;
  const lc = (k: string | null) => k === 'bwrk' || k === 'barc';
  if (!lc(fromKind) && !lc(toKind)) return null;
  if (toKind === 'barc') return { to: 'archived', tool: 'archive_page' };
  if (fromKind === 'barc') return { to: toKind === 'bsrc' ? 'authoritative' : null, tool: 'unarchive_page' };
  if (toKind === 'bwrk') return { to: 'working', tool: 'move_to_working' };
  return {
    to: toKind === 'bsrc' ? 'authoritative' : null,
    tool: toKind === 'bsrc' ? 'promote_page' : TOOL_FROM.working,
  };
}

/**
 * The status tags by the state each names: CANON, Working, Archived, and (v3 F3d, ADR 0053) the AU ruling's tag as a
 * second status tag of the Authoritative state, on a project whose approved pack carries the ruling.
 */
function statusTagKeys(c: LifecycleConfig, au: string | null): [State, string][] {
  return [
    ['authoritative', factKey(c.tags.canon)],
    ...(au !== null && factKey(au) !== factKey(c.tags.canon)
      ? [['authoritative', factKey(au)] as [State, string]]
      : []),
    ['working', factKey(c.tags.working)],
    ['archived', factKey(c.tags.archived)],
  ];
}

/**
 * C2d (ADR 0036 decision 7, the owner's): the status tags a tag list holds, by the state each names (the lifecycle
 * settings' tags compared without case, invisible characters and look-alikes, as CR-12 and CR-14 fold keys and
 * prefixes: `canon`, `ＣＡＮＯＮ` and a Cyrillic `С` read as CANON).
 */
function statusTagStates(
  c: LifecycleConfig,
  tags: readonly string[],
  au: string | null = null,
): Map<State, string> {
  const out = new Map<State, string>();
  const want = statusTagKeys(c, au);
  for (const t of tags) {
    const k = factKey(t);
    for (const [s, w] of want) if (k === w && !out.has(s)) out.set(s, t);
  }
  return out;
}

const TAG_TOOL_ADD: Readonly<Record<State, string>> = {
  authoritative: 'promote_page (or create_resource with status "authoritative")',
  working: 'move_to_working (or create_resource with status "working")',
  archived: 'archive_page',
};
const TAG_TOOL_REMOVE: Readonly<Record<State, string>> = {
  authoritative: 'move_to_working or archive_page',
  working: 'promote_page or archive_page',
  archived: 'unarchive_page',
};

/**
 * C2d (ADR 0036 decision 7): the status tags added or removed between two tag lists (pure). An added tag moves the page
 * to that tag's state; a removed one to no state the change tells (`to: null`).
 */
export function statusTagChanges(
  c: LifecycleConfig,
  before: readonly string[],
  after: readonly string[],
  /** v3 F3d (ADR 0053): the AU ruling's status tag, when the project's approved pack carries it. */
  au: string | null = null,
): { readonly tag: string; readonly added: boolean; readonly to: State | null; readonly tool: string }[] {
  const b = statusTagStates(c, before, au);
  const a = statusTagStates(c, after, au);
  const out: { tag: string; added: boolean; to: State | null; tool: string }[] = [];
  for (const s of ['authoritative', 'working', 'archived'] as const) {
    if (a.has(s) && !b.has(s)) out.push({ tag: a.get(s)!, added: true, to: s, tool: TAG_TOOL_ADD[s] });
    if (b.has(s) && !a.has(s)) out.push({ tag: b.get(s)!, added: false, to: null, tool: TAG_TOOL_REMOVE[s] });
  }
  // RV2-3: the fold catches a disguised status tag being ADDED; the exact spellings catch the genuine one being SWAPPED
  // for a disguise (a look-alike added beside CANON, then CANON removed). Any tag that folds to a status tag and is added
  // or removed by its exact spelling is a change, whatever else of that state the list still holds.
  for (const [s, k] of statusTagKeys(c, au)) {
    if (out.some((x) => (x.added ? x.to === s : false))) continue;
    const exact = (l: readonly string[]) => l.filter((t) => factKey(t) === k);
    const bs = exact(before);
    const as = exact(after);
    for (const t of as) if (!bs.includes(t)) out.push({ tag: t, added: true, to: s, tool: TAG_TOOL_ADD[s] });
    for (const t of bs)
      if (!as.includes(t) && !out.some((x) => !x.added && x.tag === t))
        out.push({ tag: t, added: false, to: null, tool: TAG_TOOL_REMOVE[s] });
  }
  return out;
}

/** The lifecycle change of a move (pure), or null: into or out of the Working or Archive area, or between them. */
export function placeChange(
  from: Area,
  to: Area,
): { readonly to: State | null; readonly tool: string } | null {
  if (from === to) return null;
  if (to === 'archived') return { to: 'archived', tool: 'archive_page' };
  if (from === 'archived') return { to: null, tool: 'unarchive_page' };
  if (to === 'working') return { to: 'working', tool: 'move_to_working' };
  return { to: null, tool: TOOL_FROM.working };
}

export interface LifecycleGuardDeps {
  /** A project's settings (its `lifecycle`). */
  readonly settings: (projectId: string) => Readonly<Record<string, unknown>> | undefined;
  /** Governed reads for the guard's own checks (the engine's `internalRead`). */
  readonly engine: Pick<JobEngine, 'internalRead'>;
  /** A node of the repository tree, or null. */
  readonly node: (projectId: string, id: string) => TreeNode | null;
  /**
   * v2 E4 (RV2-1): what the bridge recorded of a deleted page when it was deleted (the delete's journal entry): its
   * name, parent and tags. Null when it has no record (the page was deleted outside the bridge, or long ago).
   */
  readonly deletedPage?: (projectId: string, id: string) => DeletedPageRecord | null;
  /**
   * v3 F2 (ADR 0049 decision 5): a deleted page's state as the newest snapshot holding it took it (name, parent, tags),
   * for a page deleted in the app, of which the bridge holds no delete record. Null when no snapshot holds it.
   */
  readonly snapshotPage?: (projectId: string, id: string) => Promise<DeletedPageRecord | null>;
  /**
   * v3 F3d (ADR 0053): a project's lifecycle tag rules from its approved pack (`Packs.lifecycleRules`). The AU ruling's
   * tag is then a status tag of the Authoritative state, guarded as CANON is. Absent: no ruling.
   */
  readonly tagRules?: (projectId: string) => LifecycleTagRules;
  /**
   * CR-2026-11-R2 (R2-10): the pages a restore of a page may bring back with it (src/lifecycle/deleted.ts). Absent: only the
   * page itself is judged.
   */
  readonly restoreSet?: (projectId: string, id: string) => Promise<RestoreSet>;
  /**
   * CR-2026-11-R4 (ADR 0065 amendment 2): a project's Narratives (null: no approved narrative rules, so Narratives is
   * ordinary content). Absent: no page is narrative.
   */
  readonly narratives?: (projectId: string) => NarrativeArea | null;
  /**
   * CR-2026-11-R4 (F2): whether a job's own earlier step created this page (its client-minted id), read from the job's
   * stored steps, so a restarted job still knows its own pages. Absent: only what this process saw it create.
   */
  readonly createdByJob?: (projectId: string, jobId: string, resourceId: string) => boolean;
}

export interface DeletedPageRecord {
  readonly name: string;
  readonly parentId: string | null;
  readonly tags?: readonly string[];
}

/**
 * CR-2026-11 (CR-14): a name's kind as a reader sees it, which the guard judges by: the bracketed prefix in any case,
 * with or without the space after it, with spaces or invisible characters before it, in fullwidth or look-alike letters
 * (`factKey`'s fold). The tree classifies strictly (`[BARC] ` exactly); a name that only LOOKS like a lifecycle prefix
 * is still judged as one, so it cannot take a page out of its state unseen.
 */
export function looseKind(name: string): string {
  const m = /^\[\s*(bsrc|bwrk|barc|index|nav)\s*\]/.exec(factKey(name));
  // v3 F6b: `[NAV]` is an index, whatever its role.
  return m ? (m[1] === 'nav' ? 'index' : m[1]!) : classifyName(name).kind;
}

/** CR-2026-11-R4 (F2): a change marked as the first state of a page the request creates. */
const madeHere = (ch: LifecycleChange): LifecycleChange => ({ ...ch, made: true });

/** CR-2026-11-R4: a name with no lifecycle prefix (`[BSRC]`, `[BWRK]`, `[BARC]`), read loosely. */
const looseKindIsPlain = (name: string): boolean => !['bsrc', 'bwrk', 'barc'].includes(looseKind(name));

/** CR-2026-11 (CR-15): whether a name is (or looks like) one of the project's lifecycle index names. */
function isLifecycleIndexName(c: LifecycleConfig, name: string): boolean {
  if (looseKind(name) !== 'index') return false;
  const display = factKey(name).replace(/^\[\s*index\s*\]\s*/, '');
  return display === factKey(c.indexNames.working) || display === factKey(c.indexNames.archived);
}

/**
 * CR-2026-11-R4 (F4): which narrative index's name a name is, or looks like (as `isLifecycleIndexName` reads the
 * lifecycle indexes' names: an index, its name folded), or null. A second index of one of these names makes the
 * narrative layout ambiguous (Narratives is found by name), which switches every narrative rule off.
 */
export function narrativeIndexName(
  area: NarrativeArea | null,
  name: string,
): 'narratives' | 'continuities' | 'main' | null {
  if (!area || looseKind(name) !== 'index') return null;
  const display = factKey(name).replace(/^\[\s*index\s*\]\s*/, '');
  for (const k of ['narratives', 'continuities', 'main'] as const)
    if (display === factKey(area.indexNames[k])) return k;
  return null;
}

const NARRATIVE_INDEX_TOOL =
  'none: the owner names and renames the narrative indexes (Narratives, Continuities, Main CANON) by hand in LegendKeeper; the narrative audit’s “Propose a fix” proposes a missing continuity index';
const NARRATIVE_MOVE_TOOL =
  'nothing else: the owner decides on the proposal (narrative pages have no lifecycle, so moving a page into or out of Narratives is always the owner’s)';

const INDEX_TOOL =
  'none: the owner manages the lifecycle indexes by hand in LegendKeeper, then confirms them again on the dashboard';
const BSRC_TOOL = 'create_resource with status "authoritative", or promote_page';
const BSRC_LEAVE_TOOL =
  'archive_page or move_to_working to take a page out of canon (a rename that keeps the [BSRC] prefix is an ordinary edit)';

/**
 * CR-2026-11 (CR-16) and CR-2026-11-R2 (R2-12): a rename that no lifecycle prefix change covers but that makes a page
 * `[BSRC]` (Authoritative by its prefix), or takes the `[BSRC]` prefix off one (both read loosely, as `looseKind` does):
 * canon, so the owner's canonical approval. A rename that keeps `[BSRC]` stays an ordinary edit (ADR 0055).
 */
function canonRename(
  fromKind: string | null,
  toKind: string,
  name: string,
): { readonly to: State | null; readonly text: string; readonly tool: string } | null {
  if (toKind === 'bsrc' && fromKind !== 'bsrc')
    return { to: 'authoritative', text: `the page would be renamed to ${name}`, tool: BSRC_TOOL };
  if (fromKind === 'bsrc' && toKind !== 'bsrc')
    return {
      to: null,
      text: `the page would be renamed to ${name}, which takes the [BSRC] (Authoritative) prefix off it`,
      tool: BSRC_LEAVE_TOOL,
    };
  return null;
}

/** CR-2026-11 (CR-11): a Status written as a page mention, which shows that page's name (the bridge cannot judge it). */
function newStatusMention(
  c: LifecycleConfig,
  before: readonly SidebarProperty[],
  after: readonly SidebarProperty[],
) {
  const k = factKey(c.fields.status);
  const had = new Set(
    factRows(before)
      .filter((r) => factKey(r.key) === k)
      .map((r) => valueSignature(r.content)),
  );
  return factRows(after).some(
    (r) =>
      factKey(r.key) === k &&
      r.content.some((x) => typeof x.mention === 'object' && x.mention !== null) &&
      !had.has(valueSignature(r.content)),
  );
}

const statusValues = (c: LifecycleConfig, sb: readonly SidebarProperty[]) =>
  factRows(sb)
    .filter((r) => factKey(r.key) === factKey(c.fields.status))
    .map((r) => valueText(r.content))
    .filter((t) => t !== '');

/** The lifecycle guard (see the module comment). */
export class LifecycleGuard implements WriteGuard {
  constructor(private readonly d: LifecycleGuardDeps) {}

  private config(projectId: string): LifecycleConfig {
    return lifecycleFrom(this.d.settings(projectId));
  }

  /** v3 F3d (ADR 0053): the AU ruling's status tag on this project (its approved pack's), or null. */
  private auTag(projectId: string): string | null {
    try {
      return this.d.tagRules?.(projectId).au?.tag ?? null;
    } catch {
      return null;
    }
  }

  /** Where a page (or the parent a page goes under) is, in lifecycle terms; the index itself counts as inside. */
  private areaOfParent(c: LifecycleConfig, project: string, parentId: string | null): Area {
    if (parentId === null) return null;
    if (parentId === c.workingIndexId) return 'working';
    if (parentId === c.archiveIndexId) return 'archived';
    const n = this.d.node(project, parentId);
    if (!n) return null;
    return areaOf({ id: '', path: n.path }, c);
  }

  private areaOfPage(c: LifecycleConfig, project: string, id: string): Area {
    const n = this.d.node(project, id);
    return n ? areaOf(n, c) : null;
  }

  // ------------------------------------------------------------------ CR-2026-11-R4 (ADR 0065 amendment 2): Narratives

  /** The project's Narratives (null: none, or it cannot be told now). */
  private narrativesOf(project: string): NarrativeArea | null {
    try {
      return this.d.narratives?.(project) ?? null;
    } catch {
      return null;
    }
  }

  /** The AU tags a crossing counts as status tags: the AU ruling's and the narrative rules' own. */
  private auTags(project: string, area: NarrativeArea | null): string[] {
    const out = [this.auTag(project), area?.auTag ?? null].filter((t): t is string => t !== null);
    return out.filter((t, i) => out.findIndex((x) => factKey(x) === factKey(t)) === i);
  }

  /**
   * Whether a page under `parentId` is in Narratives (the Narratives index itself counts as inside): the tree for a
   * parent it knows (or one the same request made), else the parent's ancestors read one by one (at most 16);
   * `unknown` when it cannot be told.
   */
  private async inNarrativesUnder(
    area: NarrativeArea,
    project: string,
    parentId: string | null,
    read: (opId: string, params: OpParams) => Promise<unknown>,
    made?: ReadonlyMap<string, boolean | 'unknown'>,
  ): Promise<boolean | 'unknown'> {
    const root = area.rootId;
    if (root === null) return false;
    let id = parentId;
    for (let i = 0; i < 16; i++) {
      if (id === null) return false;
      if (id === root) return true;
      const m = made?.get(id);
      if (m !== undefined) return m;
      const n = this.d.node(project, id);
      if (n) return n.path.ids.includes(root);
      let r: unknown;
      try {
        r = await read('getResource', { path: { resourceId: id } });
      } catch {
        return 'unknown';
      }
      if (r === undefined || r === null) return false; // no such page: LegendKeeper refuses the write itself
      if (typeof r !== 'object') return 'unknown';
      const pid = (r as Obj).parentId;
      id = typeof pid === 'string' ? pid : null;
    }
    return 'unknown';
  }

  /** The same for a parent read live first (inside the lock: the owner may have moved it in the app since). */
  private async inNarrativesLive(
    area: NarrativeArea,
    project: string,
    parentId: string | null,
    read: (opId: string, params: OpParams) => Promise<unknown>,
  ): Promise<boolean | 'unknown'> {
    if (area.rootId === null || parentId === null) return false;
    if (parentId === area.rootId) return true;
    let r: unknown;
    try {
      r = await read('getResource', { path: { resourceId: parentId } });
    } catch {
      return 'unknown';
    }
    if (r === undefined || r === null) return false;
    if (typeof r !== 'object') return 'unknown';
    const pid = (r as Obj).parentId;
    return this.inNarrativesUnder(area, project, typeof pid === 'string' ? pid : null, read);
  }

  /**
   * The pages of a subtree (the page and every page under it, as LegendKeeper holds them now, listed as a cascade is)
   * that carry a lifecycle signal, each with its signals in words; when they cannot all be checked, one entry saying so
   * (so the move needs canonical approval: fail closed).
   */
  private async crossingSignals(
    c: LifecycleConfig,
    area: NarrativeArea,
    project: string,
    rid: string,
    top: { readonly name: string | null; readonly tags: readonly string[] | null },
    read: (opId: string, params: OpParams) => Promise<unknown>,
  ): Promise<string[]> {
    const au = this.auTags(project, area);
    let { name, tags } = top;
    if (name === null || tags === null) {
      try {
        const r = (await read('getResource', { path: { resourceId: rid } })) as Obj | undefined;
        if (r && typeof r === 'object') {
          name ??= typeof r.name === 'string' ? r.name : null;
          tags ??= Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
        }
      } catch {
        // judged below as unchecked
      }
    }
    const below = await listSubtree(read, rid, CASCADE_READ_LIMIT);
    if (name === null || tags === null || below === null || below.length > CASCADE_READ_LIMIT)
      return [
        `${name ?? rid} and the pages under it could not all be checked for a lifecycle signal${below && below.length > CASCADE_READ_LIMIT ? ` (more than ${CASCADE_READ_LIMIT} pages)` : ''}`,
      ];
    const out: string[] = [];
    for (const p of [
      { id: rid, name, tags },
      ...below.map((b) => ({ id: b.id, name: b.name ?? '', tags: b.tags })),
    ]) {
      let status: string[];
      try {
        status = statusValues(c, sidebarFrom(await read('listProperties', { path: { resourceId: p.id } })));
      } catch {
        out.push(`${p.name || p.id} (its Status could not be read)`);
        continue;
      }
      const s = lifecycleSignals(c, { name: p.name, tags: p.tags, status }, 'crossing', au);
      if (s.length > 0) out.push(`${p.name || p.id} (${s.join(', ')})`);
    }
    return out;
  }

  /** A page entering or leaving Narratives (and the pages of it that lose or regain a lifecycle). */
  private crossing(
    area: NarrativeArea,
    rid: string,
    page: string,
    direction: 'into' | 'out',
    loses: readonly string[],
    how: 'moved' | 'created' | 'copied with a template' | 'restored',
    o: { readonly stepIndex?: number; readonly made?: boolean } = {},
  ): LifecycleChange {
    const where = `[INDEX] ${area.indexNames.narratives}`;
    const listed = `${loses.slice(0, 5).join('; ')}${loses.length > 5 ? `; and ${loses.length - 5} more` : ''}`;
    const text =
      direction === 'into'
        ? `the page would be ${how} into ${where}, where pages have no lifecycle${loses.length > 0 ? `, and ${loses.length === 1 ? 'this loses its' : `${loses.length} pages lose their`} lifecycle: ${listed}` : ''}`
        : `the page would be ${how} out of ${where}${loses.length > 0 ? `, and ${loses.length === 1 ? 'this takes a lifecycle signal' : `${loses.length} pages take a lifecycle signal`} back into the repository: ${listed}` : ''}`;
    return {
      resourceId: rid,
      page,
      what: 'narrative',
      to: null,
      text,
      tool: NARRATIVE_MOVE_TOOL,
      narrative: { direction, loses },
      ...(o.stepIndex !== undefined ? { stepIndex: o.stepIndex } : {}),
      ...(o.made ? { made: true as const } : {}),
    };
  }

  /**
   * A restore that brings a page (and the pages deleted with it) back into Narratives, or a narrative page (tagged
   * Narrative) back outside it, as its delete record or newest snapshot says what it was and where it was deleted from.
   * A narrative page coming back into Narratives carrying no lifecycle signal crosses nothing. No record: the lifecycle
   * and canon guards' own rules judge it (they fail closed).
   */
  private async restoreCrossing(
    c: LifecycleConfig,
    area: NarrativeArea | null,
    project: string,
    rid: string,
    read: (opId: string, params: OpParams) => Promise<unknown>,
    stepIndex?: number,
  ): Promise<LifecycleChange | null> {
    if (!area?.rootId) return null;
    const rec =
      this.d.deletedPage?.(project, rid) ??
      (await this.d.snapshotPage?.(project, rid).catch(() => null)) ??
      null;
    if (!rec) return null;
    const landsIn =
      rec.parentId === null ? false : await this.inNarrativesUnder(area, project, rec.parentId, read);
    const set = this.d.restoreSet ? await this.d.restoreSet(project, rid).catch(() => null) : null;
    const au = this.auTags(project, area);
    const tagged = (tags: readonly string[]) => tags.some((t) => factKey(t) === factKey(area.narrativeTag));
    const statusOfRows = (rows: RestoredWith['rows']) =>
      (rows ?? [])
        .filter((r) => factKey(r.key) === factKey(c.fields.status))
        .map((r) => valueText(r.content as Obj[]))
        .filter((t) => t !== '');
    const pages = [
      { name: rec.name, tags: rec.tags ?? [], status: [] as string[] },
      ...(set?.pages ?? [])
        .filter((p) => !p.inTree)
        .map((p) => ({ name: p.name ?? p.id, tags: p.tags ?? [], status: statusOfRows(p.rows) })),
    ];
    const signalsOf = (reading: (p: (typeof pages)[number]) => 'inside' | 'crossing') =>
      pages.flatMap((p) => {
        const s = lifecycleSignals(c, p, reading(p), au);
        return s.length > 0 ? [`${p.name} (${s.join(', ')})`] : [];
      });
    const at = stepIndex !== undefined ? { stepIndex } : {};
    if (landsIn !== false) {
      const loses = signalsOf((p) => (tagged(p.tags) ? 'inside' : 'crossing'));
      if (landsIn === 'unknown') loses.push(`${rec.name} (where it comes back could not be told)`);
      if (loses.length === 0 && tagged(rec.tags ?? [])) return null; // a narrative page back where it was
      return this.crossing(area, rid, rec.name, 'into', loses, 'restored', at);
    }
    if (!tagged(rec.tags ?? [])) return null;
    return this.crossing(
      area,
      rid,
      rec.name,
      'out',
      signalsOf(() => 'crossing'),
      'restored',
      at,
    );
  }

  /** The narrative-index change of a page given a narrative index's name (or of the Narratives index renamed away). */
  private narrativeNameChange(
    area: NarrativeArea | null,
    rid: string,
    page: string,
    name: string,
    current: string | null,
    how: 'created' | 'copied with the template' | 'renamed',
    o: { readonly stepIndex?: number; readonly declaredMain?: boolean } = {},
  ): LifecycleChange | null {
    if (!area) return null;
    const nn = narrativeIndexName(area, name);
    const at = o.stepIndex !== undefined ? { stepIndex: o.stepIndex } : {};
    if (how === 'renamed' && area.rootId !== null && rid === area.rootId) {
      if (nn === 'narratives') return null;
      return {
        resourceId: rid,
        page,
        what: 'index',
        to: null,
        text: `[INDEX] ${area.indexNames.narratives} itself would be renamed to ${name}, which takes every page under it out of Narratives`,
        tool: NARRATIVE_INDEX_TOOL,
        ...at,
      };
    }
    if (nn === null) return null;
    // A page that already holds that name keeps it (a rename within one folded name is no new index).
    if (current !== null && narrativeIndexName(area, current) === nn) return null;
    // The narrative audit's "Propose a fix" makes a missing Main CANON (declared by its marker, directly under
    // Narratives); no other route gives a page a narrative index's name.
    if (nn === 'main' && o.declaredMain === true) return null;
    return {
      resourceId: rid,
      page,
      what: 'index',
      to: null,
      text: `a page would be ${how === 'renamed' ? 'renamed' : how} ${how === 'renamed' ? 'to' : 'named'} ${name}, a narrative index’s name (${area.indexNames[nn]})`,
      tool: NARRATIVE_INDEX_TOOL,
      ...at,
    };
  }

  /** Whether a page this job runs on was created by the job itself (inside the lock). */
  private createdHere(project: string, jobId: string, id: string): boolean {
    if (this.madeIn.has(`${jobId}\u0000${id}`)) return true;
    try {
      return this.d.createdByJob?.(project, jobId, id) === true;
    } catch {
      return false;
    }
  }

  /**
   * The AU ruling's tag as a status tag for a page: none for a page in Narratives without a lifecycle prefix, where AU is
   * the narrative tag of an AU's continuity (design E2.2: the tools set it).
   */
  private auFor(
    project: string,
    area: NarrativeArea | null,
    inNarr: boolean | 'unknown',
    name: string | null,
  ) {
    if (area?.rootId && inNarr === true && (name === null || looseKindIsPlain(name))) return null;
    return this.auTag(project);
  }

  async entry(input: WriteGuardEntry): Promise<WriteGuardVerdict> {
    const marker = input.lifecycle;
    const c = this.config(input.project);
    const changes = await this.changes(input, c);
    // Changes the job does not declare: refused, naming the right tool. A marker is bridge code's, so an undeclared
    // change in a marked job is a bridge fault: refused too. CR-2026-11 (CR-16): a page made [BSRC] that no tool
    // declares is not refused but needs the owner's canonical approval, as an Authoritative create by the tools does.
    const undeclared = changes.filter((ch) => !declares(marker, ch));
    const refused = undeclared.filter((ch) => ch.what !== 'canon' && ch.what !== 'narrative');
    if (refused.length > 0) {
      const first = refused[0]!;
      return {
        decision: 'deny',
        opId: input.items[first.stepIndex ?? 0]?.op ?? 'operation',
        ...(input.jobKind === 'batch_ops' && first.stepIndex !== undefined
          ? { stepIndex: first.stepIndex }
          : {}),
        reason: refusal(refused),
      };
    }
    const canon = undeclared.filter((ch) => ch.what === 'canon');
    // CR-2026-11-R4 (F1): a page entering or leaving Narratives is always the owner's decision; when a page of it
    // carries a lifecycle signal it loses (or regains) its lifecycle, so the owner's canonical approval.
    const crossing = undeclared.filter((ch) => ch.what === 'narrative');
    const losing = crossing.filter((ch) => (ch.narrative?.loses.length ?? 0) > 0);
    if (!marker?.canonical && canon.length === 0 && losing.length === 0) {
      if (crossing.length === 0) return { decision: 'allow' };
      // The owner approved this very proposal (an ordinary approval is enough: nothing loses a lifecycle).
      if (input.origin.approval !== undefined) return { decision: 'allow' };
      const reason = narrativeReason(crossing, false);
      if (input.principal.principalId === SYSTEM_PRINCIPAL.principalId && !ownerForcedProposal(input))
        return {
          decision: 'deny',
          opId: input.items[crossing[0]!.stepIndex ?? 0]?.op ?? 'operation',
          reason: `${reason}; the bridge never makes it on its own`,
        };
      return { decision: 'propose', reason, changes: crossing.map(changeView) };
    }
    // The four lifecycle tools: always the owner's canonical approval, at every scope (owner, 10 November 2026).
    if (isCanonicalApproval(input.origin.approval)) return { decision: 'allow' };
    const base = marker?.canonical
      ? `${marker.tool} ${marker.reason ?? 'changes a page’s lifecycle state'}`
      : canon.length > 0
        ? `this puts ${canon.length === 1 ? 'a page' : `${canon.length} pages`} into or out of [BSRC] (Authoritative: ${canon
            .slice(0, 3)
            .map((ch) => ch.text)
            .join('; ')})`
        : null;
    const reason = `${[base, losing.length > 0 ? narrativeReason(losing, true) : null].filter((x): x is string => x !== null).join('; and ')}, which always needs the owner’s canonical approval (“Approve and accept as canon”), whatever the scope`;
    if (input.origin.approval !== undefined) {
      return {
        decision: 'deny',
        opId: input.items[0]?.op ?? 'operation',
        reason: `refused at execution: ${reason}, and this proposal was not approved as canon; nothing was written`,
      };
    }
    // v2 E1a (ADR 0042): the bridge never makes it on its own; but a proposal the OWNER asked for on the dashboard
    // (bridge code forcing a proposal from a dashboard origin: "Propose a restore") becomes a canonical proposal, which
    // only "Approve and accept as canon" runs.
    if (input.principal.principalId === SYSTEM_PRINCIPAL.principalId && !ownerForcedProposal(input)) {
      return {
        decision: 'deny',
        opId: input.items[0]?.op ?? 'operation',
        reason: `${reason}; the bridge never makes it on its own`,
      };
    }
    return {
      decision: 'propose_canonical',
      reason,
      changes: [
        ...(marker?.canonical ? [{ lifecycle: marker.tool, pages: marker.pages }] : []),
        ...[...(marker?.canonical ? changes : [...canon, ...crossing])].map(changeView),
      ],
    };
  }

  /**
   * CR-2026-11 (CR-13): the lifecycle area a page under `parentId` is in, from what LegendKeeper holds: the confirmed
   * index ids, the tree for a parent it knows, else the parent's ancestors read one by one (at most 16). `unknown` when
   * it cannot be told (judged as a crossing).
   */
  private async areaLive(
    c: LifecycleConfig,
    project: string,
    parentId: string | null,
    read: (opId: string, params: OpParams) => Promise<unknown>,
  ): Promise<Area | 'unknown'> {
    // No index confirmed: no page is in a lifecycle area the guard can know (ADR 0035 decision 11).
    if (c.workingIndexId === null && c.archiveIndexId === null) return null;
    let id = parentId;
    for (let i = 0; i < 16; i++) {
      if (id === null) return null;
      if (id === c.workingIndexId) return 'working';
      if (id === c.archiveIndexId) return 'archived';
      const n = this.d.node(project, id);
      if (n) return areaOf(n, c);
      let r: unknown;
      try {
        r = await read('getResource', { path: { resourceId: id } });
      } catch {
        return 'unknown';
      }
      if (!r || typeof r !== 'object') return 'unknown';
      const pid = (r as Obj).parentId;
      id = typeof pid === 'string' ? pid : null;
    }
    return 'unknown';
  }

  /** The changes of a move from area `from` to area `to` (an area that cannot be told counts as a crossing). */
  private moveChange(
    c: LifecycleConfig,
    rid: string,
    page: string,
    from: Area | 'unknown',
    to: Area | 'unknown',
    stepIndex?: number,
  ): LifecycleChange | null {
    if (from === 'unknown' || to === 'unknown') {
      return {
        resourceId: rid,
        page,
        what: 'place',
        to: null,
        text: 'the page would be moved, and the bridge could not tell whether that crosses a lifecycle index',
        tool: 'the lifecycle tools, or move it by hand in LegendKeeper',
        ...(stepIndex !== undefined ? { stepIndex } : {}),
      };
    }
    const ch = placeChange(from, to);
    if (!ch) return null;
    return {
      resourceId: rid,
      page,
      what: 'place',
      to: ch.to,
      text:
        to !== null
          ? `the page would be moved into [INDEX] ${to === 'working' ? c.indexNames.working : c.indexNames.archived}`
          : `the page would be moved out of [INDEX] ${from === 'working' ? c.indexNames.working : c.indexNames.archived}`,
      tool: ch.tool,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
    };
  }

  /**
   * v2 E4 (RV2-1): the lifecycle area a page belongs in by its own state: `[BWRK]` (or the Working status tag) in the
   * Working area, `[BARC]` (or the Archived tag) in the Archived area, anything else in neither.
   */
  private ownArea(c: LifecycleConfig, name: string, tags: readonly string[] = []): Area {
    const kind = looseKind(name);
    if (kind === 'bwrk') return 'working';
    if (kind === 'barc') return 'archived';
    const states = statusTagStates(c, tags);
    if (states.has('working')) return 'working';
    if (states.has('archived')) return 'archived';
    return null;
  }

  /**
   * v2 E4 (RV2-1): a page whose own state says Working or Archived may not be moved anywhere outside that area, whatever
   * area it is moved from (a page that got out of its area, to the top level for instance, cannot be moved on into canon).
   */
  private ownAreaMove(
    c: LifecycleConfig,
    rid: string,
    name: string | null,
    to: Area | 'unknown',
    stepIndex?: number,
  ): LifecycleChange | null {
    if (name === null || to === 'unknown') return null;
    const own = this.ownArea(c, name);
    if (own === null || own === to) return null;
    return this.moveChange(c, rid, name, own, to, stepIndex);
  }

  /**
   * v2 E4 (RV2-1): `restoreResource` brings a page back under the parent it was deleted from (LegendKeeper puts it at the
   * top level when that parent is gone). Judged as a move from the area the page belongs in by its own state (as the
   * delete's journal entry recorded it) to the area it lands in; with no record of the page, the area it lands in cannot
   * be told, which counts as a crossing.
   */
  private async restoreChanges(
    c: LifecycleConfig,
    project: string,
    rid: string,
    read: (opId: string, params: OpParams) => Promise<unknown>,
    /** Whether a page the tree still holds is deleted now (read live). */
    gone: (id: string) => Promise<boolean>,
    stepIndex?: number,
  ): Promise<LifecycleChange[]> {
    if (c.workingIndexId === null && c.archiveIndexId === null) return [];
    // v3 F2 (ADR 0049 decision 5): a page deleted in the app has no delete record; the newest snapshot holding it says
    // what it was (its prefix, tags) and where it was, as for a create of that page.
    const rec =
      this.d.deletedPage?.(project, rid) ??
      (await this.d.snapshotPage?.(project, rid).catch(() => null)) ??
      null;
    if (!rec) {
      return [
        {
          resourceId: rid,
          page: rid,
          what: 'place',
          to: null,
          text: 'the page would be restored, and neither a delete record nor any snapshot says what it was or where it was deleted from, so it cannot tell whether that crosses a lifecycle index',
          tool: 'restore it in the LegendKeeper app (the owner), then let the sweep pick it up',
          ...(stepIndex !== undefined ? { stepIndex } : {}),
        },
      ];
    }
    const own = this.ownArea(c, rec.name, rec.tags ?? []);
    const landing = rec.parentId === null ? null : await this.areaLive(c, project, rec.parentId, read);
    const out: LifecycleChange[] = [];
    const top = this.moveChange(c, rid, rec.name, own, landing, stepIndex);
    if (top) out.push(top);
    // CR-2026-11-R2 (R2-10): every page deleted with it comes back with it, under its old parent: each is judged as a move
    // from the area its own state says to the area it lands in (the restored page's, unless a lifecycle index on the way
    // places it). What cannot be told about them makes the canon guard's canonical proposal.
    const set = this.d.restoreSet ? await this.d.restoreSet(project, rid).catch(() => null) : null;
    const byId = new Map((set?.pages ?? []).map((p) => [p.id, p]));
    const landsOf = async (parentId: string | null): Promise<Area | 'unknown'> => {
      let cur = parentId;
      for (let i = 0; i <= byId.size + 1; i++) {
        if (cur === null) return null;
        if (cur === c.workingIndexId) return 'working';
        if (cur === c.archiveIndexId) return 'archived';
        if (cur === rid) return landing;
        const q = byId.get(cur);
        // A parent that does not come back with it: where it is now.
        if (!q) return this.areaLive(c, project, cur, read);
        cur = q.parentId;
      }
      return 'unknown';
    };
    for (const p of set?.pages ?? []) {
      if (p.inTree && !(await gone(p.id))) continue; // still there: a restore does not touch it
      const ch = this.moveChange(
        c,
        p.id,
        `${p.name ?? p.id} (restored with ${rec.name})`,
        this.ownArea(c, p.name ?? '', p.tags ?? []),
        await landsOf(p.parentId),
        stepIndex,
      );
      if (ch) out.push(ch);
    }
    return out;
  }

  /**
   * CR-2026-11-R2 (R2-14): the areas of pages a job created, as judged inside the lock when it created them, so a page it
   * creates under one later needs no read (a restarted job reads it). Bounded.
   */
  private readonly madeIn = new Map<string, Area | 'unknown'>();

  private remember(jobId: string, id: string, area: Area | 'unknown'): void {
    this.madeIn.set(`${jobId}\u0000${id}`, area);
    if (this.madeIn.size > 2_000) this.madeIn.delete(this.madeIn.keys().next().value!);
  }

  /**
   * CR-2026-11-R2 (R2-14): inside the lock, the lifecycle area a page created under `parentId` lands in, as LegendKeeper
   * holds it now: an index by its id; a page the job created, where it was created; else the tree's place for the parent,
   * and, when it matters (the page belongs in an area, or the tree places the parent in one), the parent itself read
   * live (the owner may have moved it in the app since the tree read it) and its parent's area. `unknown` when the read
   * fails.
   */
  private async landingLive(
    c: LifecycleConfig,
    project: string,
    jobId: string,
    parentId: string | null,
    belongs: Area,
    read: (opId: string, params: OpParams) => Promise<unknown>,
  ): Promise<Area | 'unknown'> {
    if (c.workingIndexId === null && c.archiveIndexId === null) return null;
    if (parentId === null) return null;
    if (parentId === c.workingIndexId) return 'working';
    if (parentId === c.archiveIndexId) return 'archived';
    const made = this.madeIn.get(`${jobId}\u0000${parentId}`);
    if (made !== undefined) return made;
    const viaTree = await this.areaLive(c, project, parentId, read);
    if (belongs === null && viaTree === null) return null;
    if (!this.d.node(project, parentId)) return viaTree; // not in the tree: areaLive read it live
    let r: unknown;
    try {
      r = await read('getResource', { path: { resourceId: parentId } });
    } catch {
      return 'unknown';
    }
    if (r === undefined) return null; // no such parent: LegendKeeper refuses the create itself
    if (!r || typeof r !== 'object') return 'unknown';
    const pid = (r as Obj).parentId;
    return this.areaLive(c, project, typeof pid === 'string' ? pid : null, read);
  }

  /**
   * CR-2026-11-R2 (R2-14): a page that belongs in a lifecycle area (by its prefix or status tag, or the state its marker
   * gives it) created anywhere else: no marker declares it. A plain page whose area cannot be told counts as a crossing.
   */
  private landingChange(
    c: LifecycleConfig,
    id: string,
    page: string,
    belongs: Area,
    lands: Area | 'unknown',
  ): LifecycleChange | null {
    const idx = (a: 'working' | 'archived') =>
      `[INDEX] ${a === 'working' ? c.indexNames.working : c.indexNames.archived}`;
    if (belongs === null)
      return lands === 'unknown'
        ? {
            resourceId: id,
            page,
            what: 'place',
            to: null,
            text: 'a page would be created, and the bridge could not tell whether its parent is in a lifecycle area',
            tool: 'try again, or the lifecycle tools',
          }
        : null;
    if (lands === belongs) return null;
    return {
      resourceId: id,
      page,
      what: 'place',
      to: belongs,
      undeclarable: true,
      text:
        lands === 'unknown'
          ? `a page that belongs in ${idx(belongs)} would be created where the bridge cannot tell the lifecycle area`
          : `a page that belongs in ${idx(belongs)} would be created ${lands === null ? 'outside the lifecycle areas' : `in ${idx(lands)}`} (where its parent is in LegendKeeper now)`,
      tool: 'nothing until the place is checked: the parent may have been moved in LegendKeeper; the lifecycle tools move pages between areas',
    };
  }

  /** The area a new page belongs in: its prefix or status tag, else the state its job's marker gives it. */
  private belongsIn(
    c: LifecycleConfig,
    marker: LifecycleMarker | undefined,
    id: string,
    name: string,
    tags: readonly string[],
  ): Area {
    const own = this.ownArea(c, name, tags);
    if (own !== null) return own;
    const to = marker?.pages.find((p) => p.id === id)?.to;
    return to === 'working' || to === 'archived' ? to : null;
  }

  /** CR-2026-11 (CR-15): a write to one of the confirmed lifecycle indexes themselves. */
  private indexChange(
    c: LifecycleConfig,
    rid: string,
    what: string,
    stepIndex?: number,
  ): LifecycleChange | null {
    if (rid !== c.workingIndexId && rid !== c.archiveIndexId) return null;
    const name = rid === c.workingIndexId ? c.indexNames.working : c.indexNames.archived;
    return {
      resourceId: rid,
      page: `[INDEX] ${name}`,
      what: 'index',
      to: null,
      text: `[INDEX] ${name} itself would be ${what}`,
      tool: INDEX_TOOL,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
    };
  }

  /** The changes a new page (or a page copied with a template) of this name makes. */
  private createChanges(
    c: LifecycleConfig,
    id: string,
    raw: string,
    area: Area,
    stepIndex: number,
    copied = false,
  ): LifecycleChange[] {
    const out: LifecycleChange[] = [];
    const kind = looseKind(raw);
    const what = copied ? 'copied with the template' : 'created';
    if (kind === 'bwrk' || kind === 'barc') {
      out.push({
        resourceId: id,
        page: raw,
        what: 'create',
        to: kind === 'bwrk' ? 'working' : 'archived',
        text: `a page would be ${what} named ${raw}`,
        tool: kind === 'bwrk' ? 'create_resource with status "working"' : 'archive_page',
        stepIndex,
      });
    } else if (area !== null) {
      out.push({
        resourceId: id,
        page: raw || id,
        what: 'create',
        to: area,
        text: `a page would be ${what} under [INDEX] ${area === 'working' ? c.indexNames.working : c.indexNames.archived}`,
        tool: area === 'working' ? 'create_resource with status "working"' : 'archive_page',
        stepIndex,
      });
    }
    if (kind === 'bsrc')
      out.push({
        resourceId: id,
        page: raw,
        what: 'canon',
        to: 'authoritative',
        text: `a page would be ${what} named ${raw}`,
        tool: BSRC_TOOL,
        stepIndex,
      });
    if (isLifecycleIndexName(c, raw))
      out.push({
        resourceId: id,
        page: raw,
        what: 'index',
        to: null,
        text: `a page would be ${what} named ${raw}, a lifecycle index’s name`,
        tool: INDEX_TOOL,
        stepIndex,
      });
    return out;
  }

  /** Every lifecycle change the request makes, judged in order (sidebar writes simulated on the sidebars as they are). */
  private async changes(input: WriteGuardEntry, c: LifecycleConfig): Promise<LifecycleChange[]> {
    const out: LifecycleChange[] = [];
    const priority = input.origin.approval !== undefined ? 'P0' : 'P1';
    const internal = (opId: string, params: OpParams) =>
      this.d.engine.internalRead(input.project, opId, params, { priority, notFoundIsAnswer: true });
    // CR-2026-11-R4 (ADR 0065 amendment 2): the project's Narratives, and whether each page the request creates lands
    // in it.
    const narr = this.narrativesOf(input.project);
    const narrMade = new Map<string, boolean | 'unknown'>();
    const declaredNull = (id: string) =>
      input.lifecycle?.pages.some((p) => p.id === id && p.to === null) === true;
    /** Whether an existing page is in Narratives now, by the tree (`unknown` when the tree does not hold it). */
    const pageInNarr = (id: string): boolean | 'unknown' => {
      if (!narr?.rootId) return false;
      if (narrMade.has(id)) return narrMade.get(id)!;
      const n = this.d.node(input.project, id);
      return n ? n.id !== narr.rootId && n.path.ids.includes(narr.rootId) : 'unknown';
    };
    // CR-2026-11 (CR-08): an `onError: continue` batch's steps may fail one by one while the rest still run, so each
    // sidebar write is also judged on the page as it is now.
    const each = input.jobKind === 'batch_ops' && input.onError === 'continue';
    const reshapes = input.items.some((it) =>
      [
        'moveResource',
        'restoreResource',
        'createResource',
        'createManyResources',
        'saveResourceAsTemplate',
      ].includes(it.op),
    );
    // CR-2026-11 (CR-17): templates saved earlier in the same request: the name a copy of one takes; CR-2026-11-R2 (R2-13):
    // and its tags (its page's; null when they could not be read).
    const savedNames = new Map<string, string>();
    const savedTags = new Map<string, string[] | null>();
    // CR-2026-11-R2 (R2-13): a copy whose tags the bridge's own job sets itself: a lifecycle marker that declares any state
    // for it (`to: null`), or retags it later in the same request (an agent's request has no marker).
    const retagged = (id: string, i: number) =>
      input.lifecycle !== undefined &&
      (input.lifecycle.pages.some((p) => p.id === id && p.to === null) ||
        input.items
          .slice(i + 1)
          .some(
            (x) =>
              x.op === 'updateResource' &&
              x.params.path?.resourceId === id &&
              Array.isArray((x.params.body as Obj | undefined)?.tags),
          ));
    const live = new Map<string, SidebarProperty[] | null>();
    const readLive = async (resourceId: string): Promise<SidebarProperty[] | null> => {
      if (live.has(resourceId)) return live.get(resourceId)!;
      const pre = input.prefetched?.find(
        (p) => (p.op === 'listProperties' || p.op === 'getResource') && p.path.resourceId === resourceId,
      );
      let sb: SidebarProperty[] | null;
      if (pre) sb = sidebarFrom(pre.body);
      else {
        try {
          sb = sidebarFrom(await internal('listProperties', { path: { resourceId } }));
        } catch (e) {
          sb = e instanceof LkOperationError && e.lk.status === 404 ? [] : null;
        }
      }
      live.set(resourceId, sb);
      return sb;
    };
    const sidebars = new Map<string, SidebarProperty[] | null>();
    const read = async (resourceId: string): Promise<SidebarProperty[] | null> => {
      if (sidebars.has(resourceId)) return sidebars.get(resourceId)!;
      const sb = await readLive(resourceId);
      sidebars.set(resourceId, sb);
      return sb;
    };
    const created = new Set<string>();
    // C2d (ADR 0036 decision 7): the status tags, when the project's `statusTags` rule is on.
    const tagsGuarded = statusTagsGuarded(canonConfigFrom(this.d.settings(input.project)).active);
    const tagChanges = (
      rid: string,
      page: string,
      before: readonly string[],
      after: unknown,
      i: number,
      o: { readonly made?: boolean; readonly au?: string | null } = {},
    ) => {
      if (!tagsGuarded || !Array.isArray(after)) return;
      const next = (after as unknown[]).filter((t): t is string => typeof t === 'string');
      for (const t of statusTagChanges(
        c,
        before,
        next,
        o.au !== undefined ? o.au : this.auTag(input.project),
      ))
        out.push({
          resourceId: rid,
          page,
          what: 'tag',
          to: t.to,
          text: `the status tag ${t.tag} would be ${t.added ? 'added' : 'removed'}`,
          tool: t.tool,
          stepIndex: i,
          ...(o.made ? { made: true as const } : {}),
        });
    };
    // The area of a page created earlier in the same request (for a batch whose items nest).
    const createdArea = new Map<string, Area>();
    const name = (id: string) => this.d.node(input.project, id)?.rawName ?? id;
    const statusOf = (
      rid: string,
      page: string,
      before: SidebarProperty[],
      after: SidebarProperty[],
      i: number,
    ) => {
      if (newStatusMention(c, before, after)) {
        out.push({
          resourceId: rid,
          page,
          what: 'status',
          to: null,
          text: 'Status would be set to a page mention, which shows that page’s name (the bridge cannot judge it)',
          tool: 'set_facts with a plain-text Status, or the lifecycle tools',
          stepIndex: i,
        });
      }
      const ch = statusChange(c, statusValues(c, before), statusValues(c, after), created.has(rid));
      if (ch)
        out.push({
          resourceId: rid,
          page,
          what: 'status',
          to: ch.to,
          text: ch.text,
          tool: ch.tool,
          stepIndex: i,
          ...(created.has(rid) ? { made: true as const } : {}),
        });
    };
    for (const [i, it] of input.items.entries()) {
      const body = (it.params.body ?? {}) as Obj;
      if (
        it.op === 'createResource' ||
        it.op === 'createManyResources' ||
        it.op === 'createResourceFromTemplate'
      ) {
        const items =
          it.op === 'createManyResources'
            ? ((Array.isArray(body.resources) ? body.resources : []) as Obj[])
            : [body];
        const templateId =
          it.op === 'createResourceFromTemplate' && typeof body.templateId === 'string'
            ? body.templateId
            : null;
        // The template as LegendKeeper holds it (read once, when the copy takes something from it the request does not
        // set), or the page a template saved earlier in the same request was saved from.
        let tplRead: Obj | null | undefined;
        const tpl = async (): Promise<Obj | null> => {
          if (!templateId) return null;
          if (savedNames.has(templateId) || savedTags.has(templateId))
            return { name: savedNames.get(templateId), tags: savedTags.get(templateId) };
          if (tplRead === undefined)
            tplRead = await internal('getResource', { path: { resourceId: templateId } }).then(
              (r) => (r && typeof r === 'object' ? (r as Obj) : null),
              // No such template: LegendKeeper refuses the copy itself, so it copies nothing.
              (e: unknown) => (e instanceof LkOperationError && e.lk.status === 404 ? { tags: [] } : null),
            );
          return tplRead;
        };
        for (const x of items) {
          const id = typeof x.id === 'string' ? x.id : '(new)';
          // CR-2026-11 (CR-17): a template copy given no name takes the template's.
          let raw = typeof x.name === 'string' ? x.name : '';
          if (templateId && typeof x.name !== 'string') {
            const t = await tpl();
            raw = typeof t?.name === 'string' ? t.name : '';
          }
          // CR-2026-11-R2 (R2-13): a template copy takes the template's tags (a template saved earlier in the request, its
          // page's), judged as a create's tags. Not when the bridge's own job sets the copy's tags itself (a lifecycle
          // marker's job retagging it later in the request, as the creation tools do) or declares any lifecycle state
          // for it (`to: null`, an index the job makes).
          if (templateId && tagsGuarded && !retagged(id, i)) {
            const t = await tpl();
            const tags = t ? t.tags : undefined;
            if (Array.isArray(tags)) tagChanges(id, raw || id, [], tags, i, { made: true });
            else
              out.push({
                resourceId: id,
                page: raw || id,
                what: 'tag',
                to: null,
                text: 'a page would be copied from a template whose tags (which the copy takes) could not be read',
                tool: 'the creation tools, or try again',
                stepIndex: i,
                made: true,
              });
          }
          const pid = typeof x.parentId === 'string' ? x.parentId : null;
          // A parent created earlier in the same request has the area it was created in.
          const area: Area =
            pid !== null && createdArea.has(pid)
              ? (createdArea.get(pid) ?? null)
              : this.areaOfParent(c, input.project, pid);
          // CR-2026-11-R4 (F1): a page created (or copied) into Narratives that no narrative job declares is a proposal.
          const narrIn: boolean | 'unknown' = narr?.rootId
            ? await this.inNarrativesUnder(narr, input.project, pid, internal, narrMade)
            : false;
          if (typeof x.id === 'string') {
            created.add(x.id);
            createdArea.set(x.id, area);
            narrMade.set(x.id, narrIn);
          }
          if (narr && narrIn !== false)
            out.push(
              this.crossing(
                narr,
                id,
                raw || id,
                'into',
                narrIn === 'unknown' ? [`${raw || id} (where it would be created could not be told)`] : [],
                templateId ? 'copied with a template' : 'created',
                { stepIndex: i, made: true },
              ),
            );
          // CR-2026-11-R4 (F4): a narrative index's name, never given to a page.
          const nn = this.narrativeNameChange(
            narr,
            id,
            raw || id,
            raw,
            null,
            templateId ? 'copied with the template' : 'created',
            { stepIndex: i, declaredMain: declaredNull(id) && narr?.rootId != null && pid === narr.rootId },
          );
          if (nn) out.push(nn);
          out.push(...this.createChanges(c, id, raw, area, i).map(madeHere));
          // C2d: a create body that adds a status tag (createResourceFromTemplate takes no tags).
          tagChanges(id, raw || id, [], x.tags, i, { made: true });
        }
        if (templateId) {
          const id = typeof body.id === 'string' ? body.id : null;
          const t = await read(templateId);
          const ch = t ? statusChange(c, [], statusValues(c, t), true) : null;
          // CR-2026-11 (CR-17): judged whether or not the caller gave the copy an id.
          if (ch)
            out.push({
              resourceId: id ?? '(new)',
              page: `${typeof body.name === 'string' ? body.name : (id ?? 'a new page')} (new)`,
              what: 'status',
              to: ch.to,
              text: ch.text,
              tool: ch.tool,
              stepIndex: i,
              made: true,
            });
          // The new page starts as a copy of its template: later writes to it are judged on that copy.
          if (id && t) sidebars.set(id, t);
          // CR-2026-11 (CR-10): with its children, every page under the template is copied too, with its name and
          // sidebar: each is judged as a page created under the copy.
          if (body.includeChildren === true) {
            const area =
              typeof body.parentId === 'string' ? this.areaOfParent(c, input.project, body.parentId) : null;
            const below = reshapes ? null : await listSubtree(internal, templateId, 100);
            if (below === null || below.length > 100) {
              out.push({
                resourceId: id ?? '(new)',
                page: 'a template copied with its children',
                what: 'create',
                to: null,
                text: reshapes
                  ? 'a template would be copied with its children in a request that also moves or creates pages, so what it copies cannot be told'
                  : 'a template would be copied with pages under it that could not all be checked',
                tool: 'a copy without includeChildren',
                stepIndex: i,
              });
            } else {
              for (const d of below) {
                out.push(...this.createChanges(c, d.id, d.name ?? '', area, i, true).map(madeHere));
                const dn = this.narrativeNameChange(
                  narr,
                  d.id,
                  d.name ?? d.id,
                  d.name ?? '',
                  null,
                  'copied with the template',
                  {
                    stepIndex: i,
                  },
                );
                if (dn) out.push(dn);
                // CR-2026-11-R2 (R2-13): each copied with its tags.
                tagChanges(d.id, `${d.name ?? d.id} (copied with the template)`, [], d.tags, i, {
                  made: true,
                });
                const sb = await readLive(d.id);
                const sc = sb ? statusChange(c, [], statusValues(c, sb), true) : null;
                if (sc)
                  out.push({
                    resourceId: d.id,
                    page: `${d.name ?? d.id} (copied with the template)`,
                    what: 'status',
                    to: sc.to,
                    text: sc.text,
                    tool: sc.tool,
                    stepIndex: i,
                    made: true,
                  });
              }
            }
          }
        }
        continue;
      }
      if (it.op === 'saveResourceAsTemplate') {
        // A template saved from a page carries its name (unless renamed) and its sidebar.
        const src = it.params.path?.resourceId;
        const tid = typeof body.id === 'string' ? body.id : null;
        if (src && tid) {
          const n = typeof body.name === 'string' ? body.name : await this.nameNow(input.project, src);
          if (n !== null) savedNames.set(tid, n);
          sidebars.set(tid, await read(src));
          // CR-2026-11-R2 (R2-13): "the copy takes the resource's fields": its tags too.
          if (tagsGuarded) savedTags.set(tid, await this.tagsNow(input.project, src, internal));
        }
        continue;
      }
      if (SIDEBAR_WRITE_OPS.has(it.op)) {
        const rid = it.params.path?.resourceId;
        if (!rid) continue;
        const before = await read(rid);
        if (before) {
          const after = applySidebarWrite(before, it.op, it.params);
          if (after) {
            sidebars.set(rid, after);
            statusOf(rid, name(rid), before, after, i);
          }
        }
        // Unreadable: judged inside the lock, where a read is made again before the write is sent.
        if (each) {
          const now = await readLive(rid);
          const alone = now ? applySidebarWrite(now, it.op, it.params) : null;
          if (now && alone) statusOf(rid, name(rid), now, alone, i);
        }
        continue;
      }
      // C2d (ADR 0036 decision 7): status tags added or removed, judged on the page's tags now (the tree's, else read;
      // a page created earlier in the same request starts with none) and again inside the lock.
      if (it.op === 'updateResource' && Array.isArray(body.tags) && tagsGuarded) {
        const rid = it.params.path?.resourceId;
        if (rid) {
          const before = created.has(rid) ? [] : await this.tagsNow(input.project, rid, internal);
          if (before === null) {
            out.push({
              resourceId: rid,
              page: name(rid),
              what: 'tag',
              to: null,
              text: 'the page’s tags would be replaced, and the bridge could not read its status tags now',
              tool: 'the lifecycle tools for the status tags, or try again',
              stepIndex: i,
            });
          } else
            tagChanges(rid, name(rid), before, body.tags, i, {
              ...(created.has(rid) ? { made: true } : {}),
              // CR-2026-11-R4: in Narratives, AU is the narrative tag of an AU's continuity on a narrative page.
              au: this.auFor(
                input.project,
                narr,
                pageInNarr(rid),
                this.d.node(input.project, rid)?.rawName ?? null,
              ),
            });
        }
      }
      if (it.op === 'updateResource' && typeof body.name === 'string') {
        const rid = it.params.path?.resourceId;
        if (!rid) continue;
        const ix = this.indexChange(c, rid, `renamed to ${body.name}`, i);
        if (ix) {
          out.push(ix);
          continue;
        }
        const fromName = await this.nameNow(input.project, rid);
        const fromKind = fromName === null ? null : looseKind(fromName);
        const toKind = looseKind(body.name);
        const ch = prefixChange(fromKind, toKind);
        const canon = ch ? null : canonRename(fromKind, toKind, body.name);
        if (ch)
          out.push({
            resourceId: rid,
            page: name(rid),
            what: 'prefix',
            to: ch.to,
            text: `the page would be renamed to ${body.name}`,
            tool: ch.tool,
            stepIndex: i,
          });
        else if (canon) out.push({ resourceId: rid, page: name(rid), what: 'canon', ...canon, stepIndex: i });
        if (isLifecycleIndexName(c, body.name))
          out.push({
            resourceId: rid,
            page: name(rid),
            what: 'index',
            to: null,
            text: `the page would be renamed to ${body.name}, a lifecycle index’s name`,
            tool: INDEX_TOOL,
            stepIndex: i,
          });
        // CR-2026-11-R4 (F4): a narrative index's name, and the Narratives index itself renamed away.
        const nn = this.narrativeNameChange(narr, rid, name(rid), body.name, fromName, 'renamed', {
          stepIndex: i,
        });
        if (nn) out.push(nn);
        continue;
      }
      if (it.op === 'moveResource') {
        const rid = it.params.path?.resourceId;
        if (!rid || body.parentId === undefined) continue;
        const ix = this.indexChange(c, rid, 'moved', i);
        if (ix) {
          out.push(ix);
          continue;
        }
        // CR-2026-11 (CR-13): where the page is now, from the tree when it knows the page, else read.
        const known = this.d.node(input.project, rid);
        const from: Area | 'unknown' = known
          ? areaOf(known, c)
          : await (async () => {
              const r = (await internal('getResource', { path: { resourceId: rid } }).catch(() => null)) as
                Obj | null | undefined;
              if (!r) return 'unknown' as const;
              return this.areaLive(
                c,
                input.project,
                typeof r.parentId === 'string' ? r.parentId : null,
                internal,
              );
            })();
        // v3 F3a (ADR 0050): a parent created earlier in the same request has the area it was created in (as for a
        // create under it): a setting pack moves a Reference under the index the same job makes in its place.
        const dest = typeof body.parentId === 'string' ? body.parentId : null;
        const to: Area | 'unknown' =
          dest !== null && createdArea.has(dest)
            ? (createdArea.get(dest) ?? null)
            : await this.areaLive(c, input.project, dest, internal);
        const ch =
          this.moveChange(c, rid, name(rid), from, to, i) ??
          this.ownAreaMove(c, rid, known?.rawName ?? (await this.nameNow(input.project, rid)), to, i);
        if (ch) out.push(ch);
        // CR-2026-11-R4 (F1): a page or subtree moved into or out of Narratives (the Narratives index itself moves with
        // its pages, so it crosses nothing).
        if (narr?.rootId && rid !== narr.rootId) {
          const root = narr.rootId;
          const fromIn: boolean | 'unknown' = narrMade.has(rid)
            ? narrMade.get(rid)!
            : known
              ? known.id !== root && known.path.ids.includes(root)
              : await (async () => {
                  const r = (await internal('getResource', { path: { resourceId: rid } }).catch(
                    () => null,
                  )) as Obj | null | undefined;
                  if (!r) return 'unknown' as const;
                  return this.inNarrativesUnder(
                    narr,
                    input.project,
                    typeof r.parentId === 'string' ? r.parentId : null,
                    internal,
                  );
                })();
          const toIn = await this.inNarrativesUnder(narr, input.project, dest, internal, narrMade);
          if (fromIn !== toIn) {
            const unknown = fromIn === 'unknown' || toIn === 'unknown';
            const loses = unknown
              ? [
                  `${name(rid)} (whether the move crosses [INDEX] ${narr.indexNames.narratives} could not be told)`,
                ]
              : narrMade.has(rid)
                ? []
                : await this.crossingSignals(
                    c,
                    narr,
                    input.project,
                    rid,
                    { name: known?.rawName ?? null, tags: known ? [...known.tags] : null },
                    internal,
                  );
            out.push(
              this.crossing(
                narr,
                rid,
                name(rid),
                toIn === true || (unknown && fromIn !== true) ? 'into' : 'out',
                loses,
                'moved',
                {
                  stepIndex: i,
                  ...(narrMade.has(rid) ? { made: true } : {}),
                },
              ),
            );
          }
        }
        continue;
      }
      if (it.op === 'restoreResource') {
        const rid = it.params.path?.resourceId;
        if (!rid) continue;
        const gone = (id: string) =>
          internal('getResource', { path: { resourceId: id } }).then(
            () => false,
            () => true,
          );
        out.push(...(await this.restoreChanges(c, input.project, rid, internal, gone, i)));
        // CR-2026-11-R4 (F1): a restore that brings a page back into Narratives, or a narrative page back outside it.
        const nc = await this.restoreCrossing(c, narr, input.project, rid, internal, i);
        if (nc) out.push(nc);
        continue;
      }
      if (it.op === 'deleteResource') {
        const rid = it.params.path?.resourceId;
        const ix = rid ? this.indexChange(c, rid, 'deleted', i) : null;
        if (ix) out.push(ix);
      }
    }
    return out;
  }

  /** C2d: a page's tags now: the tree's, else read live (null when they cannot be told). */
  private async tagsNow(
    project: string,
    id: string,
    read: (opId: string, params: OpParams) => Promise<unknown>,
  ): Promise<string[] | null> {
    const n = this.d.node(project, id);
    if (n) return [...n.tags];
    try {
      const r = (await read('getResource', { path: { resourceId: id } })) as { tags?: unknown } | undefined;
      if (!r) return [];
      return Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return null;
    }
  }

  /** CR-2026-11: a page's name now: the tree's, else read live (null when it cannot be told). */
  private async nameNow(project: string, id: string): Promise<string | null> {
    const n = this.d.node(project, id);
    if (n) return n.rawName;
    try {
      const r = (await this.d.engine.internalRead(
        project,
        'getResource',
        { path: { resourceId: id } },
        { priority: 'P1', notFoundIsAnswer: true },
      )) as { name?: unknown } | undefined;
      return typeof r?.name === 'string' ? r.name : null;
    } catch {
      return null;
    }
  }

  /**
   * Inside the lock: a Status write, rename or move judged again on what is there now (the engine's own read of the
   * target, else one read), against the job's marker.
   */
  async inLock(input: WriteGuardInLock): Promise<void> {
    const marker = (input.jobOptions?.lifecycle as LifecycleMarker | undefined) ?? undefined;
    const c = this.config(input.job.projectId);
    const rid = input.params.path?.resourceId;
    const project = input.job.projectId;
    const body = (input.params.body ?? {}) as Obj;
    const refuse = (ch: LifecycleChange) => {
      if (declares(marker, ch)) return;
      // CR-2026-11 (CR-16): a page made [BSRC] passes only in work the owner approved as canon.
      if (ch.what === 'canon' && input.job.origin.canonicalApprovedBy !== undefined) return;
      // CR-2026-11-R4 (F1): a page into or out of Narratives passes only in work the owner approved (as canon when a
      // page of it loses, or regains, a lifecycle).
      if (ch.what === 'narrative') {
        const loses = ch.narrative?.loses.length ?? 0;
        if (input.job.origin.canonicalApprovedBy !== undefined) return;
        if (loses === 0 && input.job.approvedBy !== null) return;
        throw new PolicyDeniedError(
          input.opId,
          `refused: ${ch.page}: ${ch.text}. A page moves into or out of Narratives only as a proposal the owner approves${loses > 0 ? ' as canon' : ''} (checked again inside the lock; nothing was sent)`,
          input.job.principalId,
        );
      }
      throw new PolicyDeniedError(
        input.opId,
        `${refusal([ch])} (checked again inside the lock; nothing was sent)`,
        input.job.principalId,
      );
    };
    const read = async (opId: string, params: OpParams) => input.read(opId, params);
    const tagsGuarded = statusTagsGuarded(canonConfigFrom(this.d.settings(project)).active);
    const tagChange = (
      id: string,
      page: string,
      t: { tag: string; added: boolean; to: State | null; tool: string },
      made = false,
    ) =>
      refuse({
        resourceId: id,
        page,
        what: 'tag',
        to: t.to,
        text: `the status tag ${t.tag} would be ${t.added ? 'added' : 'removed'}`,
        tool: t.tool,
        ...(made ? { made: true as const } : {}),
      });
    // CR-2026-11-R4 (ADR 0065 amendment 2): the project's Narratives.
    const narr = this.narrativesOf(project);
    const declaredNull = (id: string) => marker?.pages.some((p) => p.id === id && p.to === null) === true;
    // CR-2026-11-R2 (R2-14): a create, judged again on where its page lands as LegendKeeper holds it now (the tree may
    // not have seen the parent moved in the app), with its name (R2-11: a lifecycle index's name is never declared).
    if (input.opId === 'createResource' || input.opId === 'createManyResources') {
      const items =
        input.opId === 'createManyResources'
          ? (Array.isArray(body.resources) ? (body.resources as unknown[]) : []).filter(
              (x): x is Obj => typeof x === 'object' && x !== null,
            )
          : [body];
      const here = new Map<string, Area | 'unknown'>();
      const hereNarr = new Map<string, boolean | 'unknown'>();
      for (const x of items) {
        const id = typeof x.id === 'string' ? x.id : '(new)';
        const name = typeof x.name === 'string' ? x.name : '';
        const tags = Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === 'string') : [];
        const parentId = typeof x.parentId === 'string' ? x.parentId : null;
        const belongs = this.belongsIn(c, marker, id, name, tags);
        const lands =
          parentId !== null && here.has(parentId)
            ? here.get(parentId)!
            : await this.landingLive(c, project, input.job.id, parentId, belongs, read);
        for (const ch of this.createChanges(c, id, name, lands === 'unknown' ? null : lands, 0))
          refuse(madeHere(ch));
        const lc = this.landingChange(c, id, name || id, belongs, lands);
        if (lc) refuse(lc);
        // CR-2026-11-R4 (F1, F4): a page created into Narratives, and a narrative index's name.
        const narrIn = narr?.rootId
          ? await this.inNarrativesUnder(narr, project, parentId, read, hereNarr)
          : false;
        if (narr && narrIn !== false)
          refuse(
            this.crossing(
              narr,
              id,
              name || id,
              'into',
              narrIn === 'unknown' ? [`${name || id} (where it would be created could not be told)`] : [],
              'created',
              { made: true },
            ),
          );
        const nn = this.narrativeNameChange(narr, id, name || id, name, null, 'created', {
          declaredMain: declaredNull(id) && narr?.rootId != null && parentId === narr.rootId,
        });
        if (nn) refuse(nn);
        if (typeof x.id === 'string') {
          here.set(x.id, lands);
          hereNarr.set(x.id, narrIn);
          this.remember(input.job.id, x.id, lands);
        }
      }
      return;
    }
    if (input.opId === 'createResourceFromTemplate') {
      if (typeof body.templateId !== 'string') return;
      const id = typeof body.id === 'string' ? body.id : '(new)';
      // CR-2026-11 (CR-17): a copy given no name takes the template's, judged on the template as it is now (it may have
      // been saved earlier in the same request), with the Status it carries. CR-2026-11-R2: every copy is judged here,
      // named or not (R2-11, R2-14); one an agent asks for (no lifecycle marker: the bridge's own jobs set their copies'
      // tags themselves) with the template's tags too (D1).
      const own = marker === undefined;
      const t =
        typeof body.name !== 'string' || own
          ? ((await input.read('getResource', { path: { resourceId: body.templateId } })) as Obj | undefined)
          : undefined;
      const name = typeof body.name === 'string' ? body.name : typeof t?.name === 'string' ? t.name : '';
      const tags =
        own && Array.isArray(t?.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [];
      const parentId = typeof body.parentId === 'string' ? body.parentId : null;
      const belongs = this.belongsIn(c, marker, id, name, tags);
      const lands = await this.landingLive(c, project, input.job.id, parentId, belongs, read);
      const area = lands === 'unknown' ? null : lands;
      for (const ch of this.createChanges(c, id, name, area, 0)) refuse(madeHere(ch));
      const lc = this.landingChange(c, id, name || id, belongs, lands);
      if (lc) refuse(lc);
      const sc = t ? statusChange(c, [], statusValues(c, sidebarFrom(t.properties)), true) : null;
      if (sc)
        refuse({
          resourceId: id,
          page: name || id,
          what: 'status',
          to: sc.to,
          text: sc.text,
          tool: sc.tool,
          made: true,
        });
      if (tagsGuarded)
        for (const tc of statusTagChanges(c, [], tags, this.auTag(project)))
          tagChange(id, name || id, tc, true);
      // CR-2026-11-R4 (F1, F4): a copy into Narratives, and a narrative index's name.
      const narrIn = narr?.rootId ? await this.inNarrativesUnder(narr, project, parentId, read) : false;
      if (narr && narrIn !== false)
        refuse(
          this.crossing(
            narr,
            id,
            name || id,
            'into',
            narrIn === 'unknown' ? [`${name || id} (where it would be copied could not be told)`] : [],
            'copied with a template',
            { made: true },
          ),
        );
      const nn = this.narrativeNameChange(narr, id, name || id, name, null, 'copied with the template', {
        declaredMain: declaredNull(id) && narr?.rootId != null && parentId === narr.rootId,
      });
      if (nn) refuse(nn);
      if (typeof body.id === 'string') this.remember(input.job.id, body.id, lands);
      // CR-2026-11 (CR-10): a template copied with its children, judged again on what is under the template now.
      if (body.includeChildren !== true) return;
      const below = await listSubtree(read, body.templateId, 100);
      if (below === null || below.length > 100) {
        refuse({
          resourceId: typeof body.id === 'string' ? body.id : '(new)',
          page: 'a template copied with its children',
          what: 'create',
          to: null,
          text: 'a template would be copied with pages under it that could not all be checked',
          tool: 'a copy without includeChildren',
        });
        return;
      }
      for (const d of below) {
        for (const ch of this.createChanges(c, d.id, d.name ?? '', area, 0, true)) refuse(madeHere(ch));
        const dn = this.narrativeNameChange(
          narr,
          d.id,
          d.name ?? d.id,
          d.name ?? '',
          null,
          'copied with the template',
        );
        if (dn) refuse(dn);
        // CR-2026-11-R2 (R2-13): each copied with its tags.
        if (tagsGuarded)
          for (const tc of statusTagChanges(c, [], d.tags, this.auTag(project)))
            tagChange(d.id, d.name ?? d.id, tc, true);
        const sb = await input.read('listProperties', { path: { resourceId: d.id } });
        const sc = sb !== undefined ? statusChange(c, [], statusValues(c, sidebarFrom(sb)), true) : null;
        if (sc)
          refuse({
            resourceId: d.id,
            page: d.name ?? d.id,
            what: 'status',
            to: sc.to,
            text: sc.text,
            tool: sc.tool,
          });
      }
      return;
    }
    if (!rid) return;
    const current = (input.current?.entity ?? input.current?.body) as Obj | undefined;
    if (input.opId === 'deleteResource') {
      const ix = this.indexChange(c, rid, 'deleted');
      if (ix) refuse(ix);
      return;
    }
    // C2d (ADR 0036 decision 7): status tags, judged on the page's tags as LegendKeeper holds them now.
    if (input.opId === 'updateResource' && Array.isArray(body.tags) && tagsGuarded) {
      const before = Array.isArray(current?.tags)
        ? (current.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : ((
            (await input.read('getResource', { path: { resourceId: rid } })) as { tags?: unknown } | undefined
          )?.tags as string[] | undefined);
      const next = (body.tags as unknown[]).filter((t): t is string => typeof t === 'string');
      // CR-2026-11-R4: a page the job itself created takes its first tags (F2); in Narratives, AU is the narrative tag
      // of an AU's continuity on a narrative page.
      const inNarr =
        narr?.rootId && this.auTag(project) !== null && current && 'parentId' in current
          ? await this.inNarrativesUnder(
              narr,
              project,
              typeof current.parentId === 'string' ? current.parentId : null,
              read,
            )
          : false;
      const au = this.auFor(project, narr, inNarr, typeof current?.name === 'string' ? current.name : null);
      const found = statusTagChanges(c, Array.isArray(before) ? before : [], next, au);
      const made = found.length > 0 && this.createdHere(project, input.job.id, rid);
      for (const t of found)
        refuse({
          resourceId: rid,
          page: typeof current?.name === 'string' ? current.name : rid,
          what: 'tag',
          to: t.to,
          text: `the status tag ${t.tag} would be ${t.added ? 'added' : 'removed'}`,
          tool: t.tool,
          ...(made ? { made: true as const } : {}),
        });
    }
    if (input.opId === 'updateResource' && typeof body.name === 'string') {
      const ix = this.indexChange(c, rid, `renamed to ${body.name}`);
      if (ix) return refuse(ix);
      const fromName = typeof current?.name === 'string' ? current.name : await this.nameNow(project, rid);
      const fromKind = fromName === null ? null : looseKind(fromName);
      const toKind = looseKind(body.name);
      const ch = prefixChange(fromKind, toKind);
      const canon = ch ? null : canonRename(fromKind, toKind, body.name);
      const page = fromName ?? rid;
      if (ch)
        refuse({
          resourceId: rid,
          page,
          what: 'prefix',
          to: ch.to,
          text: `the page would be renamed to ${body.name}`,
          tool: ch.tool,
        });
      else if (canon) refuse({ resourceId: rid, page, what: 'canon', ...canon });
      if (isLifecycleIndexName(c, body.name))
        refuse({
          resourceId: rid,
          page,
          what: 'index',
          to: null,
          text: `the page would be renamed to ${body.name}, a lifecycle index’s name`,
          tool: INDEX_TOOL,
        });
      // CR-2026-11-R4 (F4): a narrative index's name, and the Narratives index itself renamed away.
      const nn = this.narrativeNameChange(narr, rid, page, body.name, fromName, 'renamed');
      if (nn) refuse(nn);
      return;
    }
    if (input.opId === 'moveResource' && body.parentId !== undefined) {
      const ix = this.indexChange(c, rid, 'moved');
      if (ix) return refuse(ix);
      // CR-2026-11 (CR-13): where the page is now, from the engine's own read of it in the lock (the tree may not have
      // seen a move made in the app), and where it goes, from LegendKeeper when the tree does not know the parent.
      const from: Area | 'unknown' =
        current && 'parentId' in current
          ? await this.areaLive(
              c,
              project,
              typeof current.parentId === 'string' ? current.parentId : null,
              read,
            )
          : this.areaOfPage(c, project, rid);
      const to = await this.areaLive(
        c,
        project,
        typeof body.parentId === 'string' ? body.parentId : null,
        read,
      );
      const pageName = typeof current?.name === 'string' ? current.name : await this.nameNow(project, rid);
      const ch = this.moveChange(c, rid, pageName ?? rid, from, to) ?? this.ownAreaMove(c, rid, pageName, to);
      if (ch) refuse(ch);
      // CR-2026-11-R4 (F1): into or out of Narratives, as LegendKeeper holds the page and its new parent now (the owner
      // may have moved either in the app since the entry check), with the pages under it listed live.
      if (narr?.rootId && rid !== narr.rootId) {
        const root = narr.rootId;
        const fromIn: boolean | 'unknown' =
          current && 'parentId' in current
            ? await this.inNarrativesUnder(
                narr,
                project,
                typeof current.parentId === 'string' ? current.parentId : null,
                read,
              )
            : (() => {
                const n = this.d.node(project, rid);
                return n ? n.id !== root && n.path.ids.includes(root) : ('unknown' as const);
              })();
        const toIn = await this.inNarrativesLive(
          narr,
          project,
          typeof body.parentId === 'string' ? body.parentId : null,
          read,
        );
        if (fromIn !== toIn) {
          const unknown = fromIn === 'unknown' || toIn === 'unknown';
          const loses = unknown
            ? [
                `${pageName ?? rid} (whether the move crosses [INDEX] ${narr.indexNames.narratives} could not be told)`,
              ]
            : await this.crossingSignals(
                c,
                narr,
                project,
                rid,
                {
                  name: pageName,
                  tags: Array.isArray(current?.tags)
                    ? (current.tags as unknown[]).filter((t): t is string => typeof t === 'string')
                    : null,
                },
                read,
              );
          refuse(
            this.crossing(
              narr,
              rid,
              pageName ?? rid,
              toIn === true || (unknown && fromIn !== true) ? 'into' : 'out',
              loses,
              'moved',
              {
                ...(this.createdHere(project, input.job.id, rid) ? { made: true } : {}),
              },
            ),
          );
        }
      }
      return;
    }
    // v2 E4 (RV2-1): a restore lands the page under its old parent (or at the top level): judged as a move.
    if (input.opId === 'restoreResource') {
      const gone = async (id: string) =>
        (await read('getResource', { path: { resourceId: id } })) === undefined;
      for (const ch of await this.restoreChanges(c, project, rid, read, gone)) refuse(ch);
      // CR-2026-11-R4 (F1): back into Narratives, or a narrative page back outside it.
      const nc = await this.restoreCrossing(c, narr, project, rid, read);
      if (nc) refuse(nc);
      return;
    }
    if (!SIDEBAR_WRITE_OPS.has(input.opId)) return;
    // A row write whose If-Match the engine chained from this job's own previous write (or its check step):
    // LegendKeeper's If-Match refuses it if the rows changed since. CR-2026-11 (CR-08): only such a chain; a version the
    // caller gave proves nothing about what the entry check judged, so that write is judged here like any other.
    if (
      !input.current &&
      input.params.ifMatch !== undefined &&
      input.opId.endsWith('PropertyRow') &&
      input.step.options.ifMatchFrom !== undefined
    )
      return;
    // Only a write that can touch the Status row needs the whole sidebar (one more read).
    if (!touchesKey(input, factKey(c.fields.status))) return;
    const whole = sidebarFrom(await input.read('listProperties', { path: { resourceId: rid } }));
    const after = applySidebarWrite(whole, input.opId, input.params);
    if (!after) return;
    if (newStatusMention(c, whole, after))
      refuse({
        resourceId: rid,
        page: rid,
        what: 'status',
        to: null,
        text: 'Status would be set to a page mention, which shows that page’s name (the bridge cannot judge it)',
        tool: 'set_facts with a plain-text Status, or the lifecycle tools',
      });
    const ch = statusChange(c, statusValues(c, whole), statusValues(c, after));
    if (ch) refuse({ resourceId: rid, page: rid, what: 'status', to: ch.to, text: ch.text, tool: ch.tool });
  }
}

/**
 * Whether a sidebar write can touch a row keyed `k`, from its body and the engine's own read in the lock (no read
 * here). When it cannot be told, true (the whole sidebar is then read and judged).
 */
function touchesKey(input: WriteGuardInLock, k: string): boolean {
  const body = (input.params.body ?? {}) as { key?: unknown; rows?: unknown };
  const keyed = (rows: unknown) =>
    Array.isArray(rows) &&
    (rows as { key?: unknown }[]).some((r) => typeof r?.key === 'string' && factKey(r.key) === k);
  if (typeof body.key === 'string' && factKey(body.key) === k) return true;
  if (keyed(body.rows)) return true;
  const current = input.current;
  const rowsNow = Array.isArray((current?.body as { data?: unknown } | undefined)?.data)
    ? ((current!.body as { data: unknown[] }).data as { id?: unknown; key?: unknown }[])
    : Array.isArray((current?.entity as { rows?: unknown } | undefined)?.rows)
      ? ((current!.entity as { rows: unknown[] }).rows as { id?: unknown; key?: unknown }[])
      : null;
  switch (input.opId) {
    case 'createPropertyRow':
    case 'createProperty':
      return false; // judged from the body above
    case 'updatePropertyRow':
    case 'deletePropertyRow': {
      if (!rowsNow) return true;
      const row = rowsNow.find((r) => r.id === input.params.path?.rowId);
      return !row || (typeof row.key === 'string' && factKey(row.key) === k);
    }
    case 'updateProperty':
      // A link collection's items, or a key-value property's rows (judged from the body above and the rows now).
      return body.rows !== undefined && (rowsNow === null || keyed(rowsNow));
    case 'deleteProperty':
      return rowsNow === null || keyed(rowsNow);
    default:
      return true;
  }
}

/** CR-2026-11-R4 (F2): the changes that only say where a page is placed (what a marker's `to: null` declares). */
const PLACEMENT: ReadonlySet<LifecycleChange['what']> = new Set(['place', 'create', 'narrative']);

/** Whether the job's marker declares this change (the page, and the state it moves to when the change tells one). */
function declares(marker: LifecycleMarker | undefined, ch: LifecycleChange): boolean {
  if (!marker) return false;
  // CR-2026-11-R2 (R2-11): no marker declares a lifecycle index change (a page given a lifecycle index's name, or the index
  // itself changed: the owner's by hand, ADR 0036 decision 3), nor a page created outside the lifecycle area its own
  // state or its marker gives it (R2-14).
  // C2b: a canon change only a canonical marker declares (whose job the owner approves as canon).
  if (ch.what === 'index' || ch.undeclarable === true) return false;
  if (ch.what === 'canon' && !marker.canonical) return false;
  // CR-2026-11-R4 (F1): a page that carries a lifecycle signal entering or leaving Narratives loses (or regains) its
  // lifecycle: no marker declares that; only the owner's canonical approval runs it.
  if (ch.what === 'narrative' && (ch.narrative?.loses.length ?? 0) > 0) return false;
  const p = marker.pages.find((x) => x.id === ch.resourceId);
  if (!p) return false;
  // CR-2026-11-R4 (F2): a page's `to: null` (an index the job makes, a narrative page: no lifecycle state) covers only
  // where the page is placed, and the first state of a page the same job creates (the Status and tags its template
  // gives it, which the creation tools replace). A Status, prefix or tag change of a page that exists needs an
  // explicit target: the narrative audit's tags fix took CANON off a canon page on an ordinary approval through it.
  if (p.to === null) return PLACEMENT.has(ch.what) || ch.made === true;
  // A page given a lifecycle state is never declared into or out of Narratives, where it would have none.
  if (ch.what === 'narrative') return false;
  if (ch.to === null) return true;
  return p.to === ch.to;
}

/** A change as a proposal lists it. */
function changeView(ch: LifecycleChange): Obj {
  return {
    lifecycle: ch.what,
    page: ch.page,
    resourceId: ch.resourceId,
    text: ch.text,
    ...(ch.narrative
      ? {
          narrative: ch.narrative.direction,
          ...(ch.narrative.loses.length ? { loses: ch.narrative.loses } : {}),
        }
      : {}),
  };
}

/** CR-2026-11-R4 (F1): why a move into or out of Narratives is a proposal (canonical: some page loses a lifecycle). */
function narrativeReason(list: readonly LifecycleChange[], canonical: boolean): string {
  const parts = list.slice(0, 3).map((ch) => `${ch.page}: ${ch.text}`);
  return (
    `this moves ${list.length === 1 ? 'a page' : `${list.length} pages`} into or out of Narratives (${parts.join('; ')}${list.length > 3 ? `; and ${list.length - 3} more` : ''})` +
    (canonical ? '' : ', which is always the owner’s decision, whatever the scope')
  );
}

function refusal(changes: readonly LifecycleChange[]): string {
  const parts = changes.slice(0, 3).map((ch) => `${ch.page}: ${ch.text} — use ${ch.tool}`);
  return (
    `refused: this changes a page’s lifecycle state (${parts.join('; ')}${changes.length > 3 ? `; and ${changes.length - 3} more` : ''}). ` +
    'Lifecycle changes (Working, Archived, and Working to Authoritative) happen only through the lifecycle tools ' +
    '(archive_page, unarchive_page, move_to_working, promote_page) and the creation tools’ status, and so do the ' +
    'status tags CANON, Working and Archived (every other tag stays free); nothing was written'
  );
}
