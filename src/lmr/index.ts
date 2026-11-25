/**
 * Last Major Revision on every substantial edit (v3 F2, ADR 0049 decision 2; the owner's decision of 16 November 2026:
 * "ANY substantial edit to a page should automatically include a call to set the sidebar's Last Major Revision").
 *
 * The planner the engine asks about every caller's write request (src/jobs/lmr-hook.ts). It reads nothing: it decides
 * from the request's operations, the tool that made them, the project's switches and the repository tree's sidebar
 * summary, and returns the steps the engine appends to the same job (and so to the same proposal):
 *
 * 1. `bridge.lmr`, the decision, dated when it runs (for a proposal, the day it is approved and applied), which reads the
 *    rows once unless it can chain on an earlier row write's version; and
 * 2. `updatePropertyRow` of the page's `Last Major Revision` row, bound to that decision, with its own If-Match.
 *
 * Both can never fail the job (`followUp: 'lmr_failed'`): the edit stays written. What counts is a per-project switch
 * per category (below, with the owner's defaults); the lifecycle tools set the date themselves and are left alone.
 */
import type { LmrMode, LmrPlan, LmrPlanInput, LmrPlanner } from '../jobs/lmr-hook.js';
import { LMR_STEP, type LmrParams } from '../jobs/internal-steps.js';
import type { StepSpec } from '../jobs/types.js';
import type { ProjectSettings } from '../projects/settings.js';
import {
  blockWriteEvidence,
  journalEvidence,
  propertiesOf,
  sidebarWriteEvidence,
  TEXT_WRITE_OPS,
  verdictFor,
  type LmrEvidence,
} from './measure.js';

export * from './measure.js';

type Obj = Record<string, unknown>;

/** The categories of edit, each a per-project switch (`lmr<Category>` on the Projects page). */
export const LMR_CATEGORIES = {
  /** `write_page`, any mode. */
  writePage: { setting: 'lmrWritePage', default: true, label: 'write_page (any mode)' },
  /** Block edits through `lk_api_write` / `lk_api_batch` (insert, replace, update, delete; replaceDocumentBlocks). */
  blockEdits: { setting: 'lmrBlockEdits', default: true, label: 'block edits (lk_api_write, lk_api_batch)' },
  /** A chronology table's rows, and the Main count fix. */
  chronologyTable: {
    setting: 'lmrChronologyTable',
    default: true,
    label: 'chronology table rows and counts',
  },
  /** A restore that changes a page's text. */
  restore: { setting: 'lmrRestore', default: true, label: 'restores that change text' },
  /** Setting-pack tools (none yet; a write they plan names its pack in its journal operation). */
  packTools: { setting: 'lmrPackTools', default: true, label: 'setting-pack tools' },
  /** A sidebar fact's value through `set_facts`, except the housekeeping keys; v3 F3c: and Dependencies added or removed. */
  facts: {
    setting: 'lmrFacts',
    default: true,
    label: 'set_facts (except housekeeping keys), and Dependencies',
  },
  /** Tags, aliases, icons and names; moves and re-orders (of pages and of blocks). */
  namesTagsMoves: {
    setting: 'lmrNamesTagsMoves',
    default: false,
    label: 'tags, aliases, icons, names, moves',
  },
  /** Link collections other than Dependencies (Related Sources); v3 F3c: Dependencies count as a sidebar fact. */
  linkCollections: {
    setting: 'lmrLinkCollections',
    default: false,
    label: 'link collections other than Dependencies',
  },
  /** Timeline events and lanes, and map features, on their own. */
  timelineMap: { setting: 'lmrTimelineMap', default: false, label: 'timeline events and map features' },
  /** An audit's paragraph split (the content is unchanged). */
  auditSplit: { setting: 'lmrAuditSplit', default: false, label: 'an audit’s paragraph split' },
} as const;

export type LmrCategory = keyof typeof LMR_CATEGORIES;

/** The housekeeping keys a `set_facts` change of which alone is not an edit (owner, 16 November 2026). */
export const DEFAULT_HOUSEKEEPING_KEYS: readonly string[] = [
  'Last Major Revision',
  'Reference Type',
  'Supersedes',
  'Status',
];

export interface LmrConfig {
  readonly categories: Readonly<Record<LmrCategory, boolean>>;
  readonly housekeeping: readonly string[];
  /** The row's key (the lifecycle's `lastMajorRevision` field name). */
  readonly key: string;
}

const keyOf = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The project's configuration, from its settings (an absent switch is its default). */
export function lmrConfigFrom(settings: ProjectSettings, lmrKey = 'Last Major Revision'): LmrConfig {
  const s = settings as Obj;
  const categories = Object.fromEntries(
    Object.entries(LMR_CATEGORIES).map(([k, c]) => [
      k,
      typeof s[c.setting] === 'boolean' ? (s[c.setting] as boolean) : c.default,
    ]),
  ) as Record<LmrCategory, boolean>;
  const raw = typeof s.lmrHousekeepingKeys === 'string' ? s.lmrHousekeepingKeys : null;
  const housekeeping =
    raw === null
      ? DEFAULT_HOUSEKEEPING_KEYS
      : raw
          .split(';')
          .map((x) => x.trim())
          .filter((x) => x !== '');
  return { categories, housekeeping, key: lmrKey };
}

// ============================================================================================ classification

const TEXT_OPS: ReadonlySet<string> = new Set([
  'replaceDocumentBlocks',
  'insertBlock',
  'replaceBlock',
  'updateBlock',
  'deleteBlock',
  'createBlockRow',
  'updateBlockRow',
  'deleteBlockRow',
  'createBlockPropertyRow',
  'updateBlockPropertyRow',
  'deleteBlockPropertyRow',
]);
const ROW_OPS: ReadonlySet<string> = new Set(['createPropertyRow', 'updatePropertyRow', 'deletePropertyRow']);
const NAME_MOVE_OPS: ReadonlySet<string> = new Set(['updateResource', 'moveResource', 'moveBlock']);
const TIMELINE_MAP_OPS: ReadonlySet<string> = new Set([
  'createEvent',
  'updateEvent',
  'deleteEvent',
  'createLane',
  'updateLane',
  'deleteLane',
  'createFeature',
  'updateFeature',
  'deleteFeature',
]);
const CREATE_OPS: ReadonlySet<string> = new Set([
  'createResource',
  'createResourceFromTemplate',
  'createManyResources',
]);
const CHRONOLOGY_TOOLS: ReadonlySet<string> = new Set([
  'create_timeline_event',
  'update_timeline_event',
  'delete_timeline_event',
  'sync_timeline_event',
  'chronology_count_fix',
  // v3 F10 (ADR 0078): the four deterministic repairs.
  'chronology_kcy_fix',
  'chronology_uri_fix',
  'chronology_order_fix',
  'chronology_style_fix',
]);

export interface StepClass {
  readonly category: LmrCategory;
  /** The page the step edits. */
  readonly pageId: string;
  /** For a `set_facts` row write: the fact's key, when the plan named it. */
  readonly factKey?: string;
}

/** What one step of a request is, for this rule (null: not an edit of a page, such as a read or a create). */
export function classifyStep(
  op: string,
  params: { readonly path?: Record<string, string>; readonly body?: unknown },
  journal: Obj | undefined,
  originTool: string | undefined,
): StepClass | null {
  const pageId = params.path?.resourceId;
  if (typeof pageId !== 'string' || pageId === '') return null;
  const tool = typeof journal?.tool === 'string' ? journal.tool : (originTool ?? '');
  if (TEXT_OPS.has(op)) {
    const category: LmrCategory =
      tool === 'audits.split_paragraph'
        ? 'auditSplit'
        : journal?.pack !== undefined
          ? 'packTools'
          : tool === 'restore_snapshot'
            ? 'restore'
            : CHRONOLOGY_TOOLS.has(tool) || CHRONOLOGY_TOOLS.has(originTool ?? '')
              ? 'chronologyTable'
              : tool === 'write_page'
                ? 'writePage'
                : 'blockEdits';
    return { category, pageId };
  }
  if (ROW_OPS.has(op)) {
    // Only set_facts counts (its plan names each row's key); a restore's sidebar is not the page's text. v3 F5c (ADR
    // 0069, H6): arkona_identity_reconcile writes its facts with set_facts' own plan, so it counts the same way.
    if (tool !== 'set_facts' && tool !== 'arkona_identity_reconcile') return null;
    const factKey = typeof journal?.factKey === 'string' ? journal.factKey : undefined;
    return { category: 'facts', pageId, ...(factKey !== undefined ? { factKey } : {}) };
  }
  if (NAME_MOVE_OPS.has(op)) return { category: 'namesTagsMoves', pageId };
  if (op === 'updateProperty') return { category: 'linkCollections', pageId };
  if (TIMELINE_MAP_OPS.has(op)) return { category: 'timelineMap', pageId };
  return null;
}

// ============================================================================================ the planner

/** A page's sidebar as the repository tree last read it (null: not read), for where its row is. */
export interface TreeSidebarBlock {
  readonly id?: string | null | undefined;
  readonly kind: string;
  readonly title?: string | null | undefined;
  readonly rows?: readonly { readonly key: string; readonly text: string }[];
}

export interface LmrPlannerDeps {
  readonly settings: (projectId: string) => ProjectSettings | undefined;
  /** The row's key in this project (the lifecycle's field name). */
  readonly lmrKey?: (projectId: string) => string;
  /** The tree's sidebar summary of a page (null: not read; undefined: not in the tree). */
  readonly sidebar: (projectId: string, pageId: string) => readonly TreeSidebarBlock[] | null | undefined;
  /** A page's name, for the follow-up and the journal. */
  readonly pageName?: (projectId: string, pageId: string) => string | null;
}

/** The text a proposal's summary gains when the row is set (`why`: which mode applied and why). */
export const lmrNote = (key: string, unsure: boolean, why?: string) =>
  `+ ${key} → date of approval${unsure ? ' (if the page has the row)' : ''}${why ? ` (${why})` : ''}`;

/** v3 F3c: the text a proposal's summary gains when the row is left alone: `LMR skipped: a trimmed value, not …`. */
export const lmrSkipNote = (key: string, why: string) => `${key} skipped: ${why}`;

const isDependencies = (title: string | null | undefined) =>
  typeof title === 'string' && title.trim().toLocaleLowerCase('en-GB') === 'dependencies';

interface PageEdit {
  /** The steps (1-based) that edit it, for the decision's "did the edit write anything". */
  readonly after: number[];
  readonly evidence: LmrEvidence[];
  /** Text writes whose old text the request does not hold: measured when the job runs. */
  pending: boolean;
  /** A category the rule does not measure that the project switched on (names, moves, timeline, audit split). */
  readonly forced: string[];
}

export function createLmrPlanner(d: LmrPlannerDeps): LmrPlanner {
  return (input: LmrPlanInput): LmrPlan | null => {
    // The lifecycle tools set the date themselves (ADR 0035). A restore rehearsal must reproduce the snapshot exactly
    // (it is compared with it afterwards), so it never sets the date.
    if (input.lifecycle || input.origin.tool === 'snapshot_rehearsal') return null;
    const settings = d.settings(input.project);
    if (!settings) return null;
    const mode: LmrMode = input.mode ?? 'auto';
    const cfg = lmrConfigFrom(settings, d.lmrKey?.(input.project));
    const housekeeping = new Set(cfg.housekeeping.map(keyOf));
    const created = new Set<string>();
    for (const s of input.steps) {
      if (!CREATE_OPS.has(s.op)) continue;
      const b = (s.params.body ?? {}) as Obj;
      if (typeof b.id === 'string') created.add(b.id);
      if (Array.isArray(b.resources))
        for (const r of b.resources as Obj[]) if (typeof r?.id === 'string') created.add(r.id);
    }
    // v3 F3c: what the calling tool read before planning (the old state the rule measures against).
    const oldDocs = new Map<string, unknown>();
    const oldSidebars = new Map<string, Obj[]>();
    for (const p of input.prefetched ?? []) {
      if (p.op === 'getDocumentBlocks' && typeof p.path.documentId === 'string')
        oldDocs.set(p.path.documentId, p.body);
      if ((p.op === 'listProperties' || p.op === 'getResource') && typeof p.path.resourceId === 'string')
        oldSidebars.set(p.path.resourceId, propertiesOf(p.body));
    }
    const titleOf = (pageId: string, propertyId: string | undefined): string | null => {
      if (propertyId === undefined) return null;
      const read = oldSidebars.get(pageId)?.find((p) => p.id === propertyId);
      if (typeof read?.title === 'string') return read.title;
      const sb = d.sidebar(input.project, pageId);
      return sb?.find((p) => p.id === propertyId)?.title ?? null;
    };
    // The pages edited, with the steps that did it and what they changed; pages whose row the request sets itself are left.
    const pages = new Map<string, PageEdit>();
    const setsItself = new Set<string>();
    const lastRowWrite = new Map<string, { step: number; propertyId: string }>();
    input.steps.forEach((s, i) => {
      const journal = s.options.journalOperation as Obj | undefined;
      const c = classifyStep(s.op, s.params, journal, input.origin.tool);
      if (ROW_OPS.has(s.op) && typeof s.params.path?.resourceId === 'string') {
        lastRowWrite.set(s.params.path.resourceId, {
          step: i + 1,
          propertyId: s.params.path.propertyId ?? '',
        });
      }
      if (!c || created.has(c.pageId)) return;
      if (c.factKey !== undefined && keyOf(c.factKey) === keyOf(cfg.key)) setsItself.add(c.pageId);
      // v3 F3c: adding or removing a Dependency is a sidebar change the rule counts (Related Sources alone is not).
      let category = c.category;
      if (s.op === 'updateProperty' && isDependencies(titleOf(c.pageId, s.params.path?.propertyId)))
        category = 'facts';
      if (mode !== 'set' && !cfg.categories[category]) return;
      if (
        mode !== 'set' &&
        category === 'facts' &&
        c.factKey !== undefined &&
        housekeeping.has(keyOf(c.factKey))
      )
        return;
      const edit = pages.get(c.pageId) ?? { after: [], evidence: [], pending: false, forced: [] };
      pages.set(c.pageId, edit);
      edit.after.push(i + 1);
      const own = journalEvidence(journal);
      if (own) edit.evidence.push(own);
      else if (UNMEASURED.has(category))
        edit.forced.push(`${LMR_CATEGORIES[category].label}, switched on for this project`);
      else if (category === 'facts') {
        const sb = oldSidebars.get(c.pageId);
        edit.evidence.push(
          sb ? sidebarWriteEvidence(s.op, s.params, sb) : { kind: 'unknown', what: 'a sidebar write' },
        );
      } else if (TEXT_WRITE_OPS.has(s.op)) {
        const doc = s.params.path?.documentId;
        const oldDoc = typeof doc === 'string' ? oldDocs.get(doc) : undefined;
        if (oldDoc === undefined) edit.pending = true;
        else edit.evidence.push(blockWriteEvidence(s.op, s.params, { oldDoc }));
      } else edit.evidence.push({ kind: 'unknown', what: `a ${s.op}` });
    });
    for (const p of setsItself) pages.delete(p);
    if (pages.size === 0) return null;

    const steps: StepSpec[] = [];
    const planned: string[] = [];
    const setWhy: string[] = [];
    const left: string[] = [];
    let unsure = false;
    for (const [pageId, edit] of pages) {
      const at = locate(d, input, pageId, cfg.key);
      if (at === 'none') continue; // the page has no such row: skipped silently
      // v3 F3c (ADR 0051): which mode applied and why.
      let why: string;
      let measure: LmrParams['measure'];
      if (mode === 'skip') {
        left.push(lmrSkipNote(cfg.key, 'lastMajorRevision "skip" was asked'));
        continue;
      } else if (mode === 'set') why = 'set: lastMajorRevision "set" was asked';
      else if (edit.forced.length > 0) why = `auto: ${edit.forced[0]}`;
      else if (edit.pending) {
        why = 'auto: if the edit is a major revision, measured when it runs';
        const known = edit.evidence.filter((e) => e.kind !== 'text');
        measure = { known };
      } else {
        const v = verdictFor(edit.evidence);
        if (!v.major) {
          left.push(lmrSkipNote(cfg.key, `${v.reason}, not a major revision`));
          continue;
        }
        why = `auto: ${v.reason}`;
      }
      if (at.unsure) unsure = true;
      const chain = lastRowWrite.get(pageId);
      const stepNo = input.steps.length + steps.length + 1;
      const name = d.pageName?.(input.project, pageId) ?? undefined;
      const body: LmrParams = {
        resourceId: pageId,
        ...(at.propertyId !== undefined ? { propertyId: at.propertyId } : {}),
        key: cfg.key,
        ...(at.rowId !== undefined ? { rowId: at.rowId } : {}),
        ...(at.value !== undefined ? { value: at.value } : {}),
        ...(chain &&
        at.rowId !== undefined &&
        at.propertyId !== undefined &&
        chain.propertyId === at.propertyId
          ? { chainFrom: chain.step }
          : {}),
        after: edit.after,
        ...(name ? { page: name.slice(0, 500) } : {}),
        why: why.slice(0, 500),
        ...(measure ? { measure } : {}),
      };
      steps.push({ op: LMR_STEP, params: { body }, followUp: 'lmr_failed' });
      steps.push({
        op: 'updatePropertyRow',
        params: {
          // The row and the date are bound when the decision runs (the date is the day the job runs).
          path: {
            resourceId: pageId,
            propertyId: at.propertyId ?? pageId,
            rowId: at.rowId ?? at.propertyId ?? pageId,
          },
          body: { content: [{ text: 'date of approval' }] },
        },
        decisionFrom: { step: stepNo },
        ifMatchFrom: { step: stepNo, key: 'lmr' },
        followUp: 'lmr_failed',
        judgedInLock: true,
        deferTreeReread: true,
        journalOperation: {
          tool: 'last_major_revision',
          page: { id: pageId, ...(name ? { name } : {}) },
          write: `${cfg.key}: today`,
          why: why.slice(0, 500),
        },
      });
      planned.push(pageId);
      setWhy.push(why);
    }
    if (steps.length === 0 && left.length === 0) return null;
    // One note: the pages set (with why: one page, or the first of several), then the pages left alone and why.
    const head =
      setWhy.length === 0
        ? []
        : [
            setWhy.length === 1
              ? lmrNote(cfg.key, unsure, setWhy[0])
              : `${lmrNote(cfg.key, unsure)} on ${setWhy.length} pages (${setWhy[0]}; …)`,
          ];
    return { steps, pages: planned, note: [...head, ...new Set(left)].join('; ') };
  };
}

/**
 * Categories the rule never counts (ADR 0051 decision 1): switched on by the owner for a project, they count as they did
 * in F2. Link collections here are the ones other than Dependencies (Related Sources): Dependencies are a sidebar fact.
 */
const UNMEASURED: ReadonlySet<LmrCategory> = new Set([
  'namesTagsMoves',
  'linkCollections',
  'timelineMap',
  'auditSplit',
]);

/**
 * Where the page's row is: from a read the calling tool made in this call (its id and value too), else from the tree's
 * sidebar summary (the property; the row is found when the decision runs). `none` when the page is known to have no
 * such row (an index, an AI REPOSITORY tab): it is skipped silently. A page the tree has not read is `unsure`: the
 * decision looks for the row when it runs (one more read). A page the tree does not hold at all (outside the AI
 * REPOSITORY) is skipped.
 */
function locate(
  d: LmrPlannerDeps,
  input: LmrPlanInput,
  pageId: string,
  key: string,
): 'none' | { propertyId?: string; rowId?: string; value?: string; unsure: boolean } {
  const k = keyOf(key);
  const pre = input.prefetched?.find(
    (p) => (p.op === 'listProperties' || p.op === 'getResource') && p.path.resourceId === pageId,
  );
  if (pre) {
    const b = pre.body as Obj | undefined;
    const props = (
      Array.isArray(b?.data) ? b.data : Array.isArray(b?.properties) ? b.properties : []
    ) as Obj[];
    for (const p of props) {
      if (p?.kind !== 'keyValue' || typeof p.id !== 'string' || !Array.isArray(p.rows)) continue;
      const row = (p.rows as Obj[]).find((r) => typeof r?.key === 'string' && keyOf(r.key) === k);
      if (row && typeof row.id === 'string') {
        const value = Array.isArray(row.content)
          ? (row.content as Obj[]).map((r) => (typeof r?.text === 'string' ? r.text : '')).join('')
          : '';
        return { propertyId: p.id, rowId: row.id, value, unsure: false };
      }
    }
    return 'none';
  }
  const sb = d.sidebar(input.project, pageId);
  // Not in the tree: outside the AI REPOSITORY (or not seen yet), where the bridge's own pages are not; skipped.
  if (sb === undefined) return 'none';
  if (sb === null) return { unsure: true };
  for (const p of sb) {
    if (p.kind !== 'keyValue' || typeof p.id !== 'string') continue;
    const row = p.rows?.find((r) => keyOf(r.key) === k);
    if (row) return { propertyId: p.id, value: row.text, unsure: false };
  }
  return 'none';
}
