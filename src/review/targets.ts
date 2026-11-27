/**
 * What a finished job changed, target by target (v3 F3.4, ADR 0055 decisions A and B), from the job's own record (its
 * steps: params, options, results, its check and verify steps) and the write journal (each write's pre-image). Pure:
 * no LegendKeeper request. The Review page shows each target's change (the same kinds of diff a proposal shows), and
 * Revert reads each target live, compares it with the state the job left, and writes it back to the state before.
 *
 * | Kind         | From                                                                             | Revert       |
 * | ------------ | -------------------------------------------------------------------------------- | ------------ |
 * | `text`       | a document's blocks before the job's first text write (a block-by-block job's    | yes          |
 * |              | check, else a whole write's pre-image) and after its last (replayed in order)     |              |
 * | `block`      | one block written through the low-level tools (insert, replace, update)           | yes          |
 * | `facts`      | set_facts' check (rows and collections before) and verify (after) of one page     | yes          |
 * | `lmr`        | a Last Major Revision row the job set (its decision keeps the value before)       | yes          |
 * | `resource`   | a page's name, tags, aliases or icon (updateResource's pre-image and body)         | yes          |
 * | `move`       | a page moved (moveResource's pre-image: its parent and rank)                       | yes          |
 * | `chronology` | a chronology change (its record: rows, events and counts, kept in step)           | yes          |
 * | `image`      | an image placed (a new asset in its folder, or a staged asset moved and unhidden)  | yes (moved)  |
 * | `entity`     | v3 F12 (ADR 0081): every other write: an update (back to its pre-image), a        | yes          |
 * |              | creation (deleted again while untouched), a deletion (restored, made again from    |              |
 * |              | its pre-image, or from the copy kept before it: D3)                                |              |
 * | `none`       | what is left: a write with no record to revert it from, and why                   | no, and why  |
 */
import { EXPECT_STEP, LMR_STEP, VERIFY_STEP, isBridgeStep } from '../jobs/internal-steps.js';
import type { JournalEntry } from '../jobs/journal.js';
import type { CollectionState, RowState } from '../jobs/sidebar-state.js';
import type { JobView, OpParams, StepOptions } from '../jobs/types.js';
import { BLOCKWISE_CHECK, applyBlockOps, stepOp, withoutVersions } from '../pages/blockwise.js';
import type { ChronologyRecord, TargetWrite } from '../chronology/store.js';
import { remadeEventBody } from '../chronology/event-body.js';
import { rowKey } from '../chronology/plan.js';
import { mintClientId } from '../jobs/ids.js';
import { ENTITIES, ENTITY_OPS, type EntityUndo } from './entity-undo.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const runsText = (runs: readonly unknown[]): string =>
  runs.map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : '')).join('');

/** One step of a job, as the engine holds it (`JobEngine.stepRecords`). */
export interface StepRecord {
  readonly stepNo: number;
  readonly opId: string;
  readonly opKind: string;
  readonly status: string;
  readonly maybeSent: boolean;
  readonly params: OpParams;
  readonly options: StepOptions;
  readonly result: unknown;
}

/** Everything the bridge holds about a job. */
export interface JobRecord {
  readonly job: JobView;
  readonly steps: readonly StepRecord[];
  /** The job's journal entries, oldest first, with their pre-images. */
  readonly journal: readonly JournalEntry[];
  /** A chronology change's record, when the job made one. */
  readonly chronology: ChronologyRecord | null;
}

export interface PageRef {
  readonly id: string;
  readonly name: string | null;
}

interface Common {
  /** Unique within the job (`text:<documentId>`). */
  readonly key: string;
  readonly page: PageRef | null;
  /** In words: "page text of “Main”", "sidebar facts", "name and tags". */
  readonly what: string;
  /** The job's steps it covers. */
  readonly steps: readonly number[];
  /** A write of it may or may not have been applied (its outcome is unknown). */
  readonly uncertain?: boolean;
  /**
   * CR-2026-11-R2 (R2-28): a later job wrote this target again (an applied, or possibly applied, journal entry of its own
   * on it): the job that did. Revert then treats it as changed since the job, whatever its content.
   */
  readonly laterWrite?: string;
}

export interface TextTarget extends Common {
  readonly kind: 'text';
  readonly resourceId: string;
  readonly documentId: string;
  readonly documentName: string | null;
  /** The document's blocks before the job's first text write to it (per-block versions removed). */
  readonly before: readonly Obj[];
  /** The states the job can have left it in (one, or two when a write's outcome is unknown). */
  readonly left: readonly (readonly Obj[])[];
}

export interface BlockTarget extends Common {
  readonly kind: 'block';
  readonly resourceId: string;
  readonly documentId: string;
  readonly blockId: string;
  readonly change: 'inserted' | 'replaced' | 'updated';
  /** The block before (replaced or updated), or null (inserted). */
  readonly before: Obj | null;
  /** The block the job sent (inserted or replaced), or the fields it changed (updated). */
  readonly sent: Obj;
}

export interface FactsTarget extends Common {
  readonly kind: 'facts';
  readonly resourceId: string;
  /** The key-value property the job wrote rows of (null: only collections). */
  readonly property: { readonly id: string; readonly title: string } | null;
  readonly rowsBefore: readonly RowState[] | null;
  /** The rows as the job left them (its plan's result, and the Last Major Revision row it set, if any). */
  readonly rowsLeft: readonly RowState[] | null;
  readonly collections: readonly {
    readonly propertyId: string;
    readonly title: string;
    readonly before: CollectionState;
    readonly left: CollectionState;
  }[];
  /** The Last Major Revision row the job set on this property (folded in: its value before and the date). */
  readonly lmr?: {
    readonly rowId: string;
    readonly key: string;
    readonly before: string;
    readonly after: string;
    /** CR-2026-11-R2 (R2-18): the job's steps whose writes made the edit major (the date goes back only with them). */
    readonly justifiedBy: readonly number[];
    /** CR-2026-11-R2 (R2-18): a later job relied on the date (its own major revision the same day): why it stays. */
    readonly keptFor: string | null;
  };
}

export interface LmrTarget extends Common {
  readonly kind: 'lmr';
  readonly resourceId: string;
  readonly propertyId: string;
  readonly rowId: string;
  /** The row's key (`Last Major Revision`, or the project's own name for it). */
  readonly rowKey: string;
  /** The value before (empty when the row was empty), and the date the job wrote. */
  readonly before: string;
  readonly after: string;
  /**
   * CR-2026-11-R2 (R2-18): the value before exactly as it was (its runs: a link, a mention), when the job's decision
   * recorded them; null when it recorded its plain text only.
   */
  readonly beforeRuns: readonly Obj[] | null;
  /** CR-2026-11-R2 (R2-18): the job's steps whose writes made the edit major (the date goes back only with them). */
  readonly justifiedBy: readonly number[];
  /** CR-2026-11-R2 (R2-18): a later job relied on the date (its own major revision the same day): why it stays. */
  readonly keptFor: string | null;
}

/** The page fields a revert of `updateResource` puts back. */
export const RESOURCE_FIELDS = [
  'name',
  'tags',
  'aliases',
  'iconGlyph',
  'iconColor',
  'iconShape',
  'iconSize',
  'isLocked',
  'isFullWidth',
] as const;
export type ResourceField = (typeof RESOURCE_FIELDS)[number];

export interface ResourceTarget extends Common {
  readonly kind: 'resource';
  readonly resourceId: string;
  readonly before: Readonly<Partial<Record<ResourceField, unknown>>>;
  readonly left: Readonly<Partial<Record<ResourceField, unknown>>>;
  /**
   * CR-2026-11-R3, R3-57 (ADR 0061 part B decision 5, the owner's (b)): a retag batch's page is put back only while its
   * name and parent are as the job left them too (`TargetDeps.placeAsLeft`), not only its tags.
   */
  readonly place?: { readonly name: unknown; readonly parentId: string | null };
  /**
   * v3 F7.1 (ADR 0072): the template the bridge recorded for the page with its rename (a Compact Character Reference
   * upgraded to its Character Core): put back with the name, so the tree records the Compact template again.
   */
  readonly template?: { readonly before: string; readonly left: string };
}

export interface MoveTarget extends Common {
  readonly kind: 'move';
  readonly resourceId: string;
  readonly before: { readonly parentId: string | null; readonly rank: string | null };
  /** CR-2026-11-R2 (R2-19): where the job left it: its parent and its rank (null when the move's answer had none). */
  readonly left: { readonly parentId: string | null; readonly rank: string | null };
}

export interface ChronologyUnitTarget extends Common {
  readonly kind: 'chronology';
  readonly record: ChronologyRecord;
  /** The writes that put it back, in the chronology tools' own form (rows, events and counts, in step). */
  readonly inverse: readonly TargetWrite[];
  /** For each row the inverse writes back: the block it held before the job (its journal pre-image). */
  /** By `rowKey(documentId, rowId)` (X5: a row id is unique only within its table document). */
  readonly oldRows: Readonly<Record<string, Obj>>;
  /** For each event the inverse updates: its fields before the job. */
  readonly oldEvents: Readonly<Record<string, Obj>>;
  /**
   * CR-2026-11-R2 (R2-16): for each row the job wrote (added or changed), its block as the job left it: Revert compares the
   * row whole (links, marks, inline icons), not only its words.
   */
  /** By `rowKey(documentId, rowId)`. */
  readonly leftRows: Readonly<Record<string, Obj>>;
  /**
   * CR-2026-11-R2 (R2-16): for each event the job made or changed, the event as LegendKeeper answered the job's write (every
   * stored field: colour, icon, image too), or null when the answer is not recorded.
   */
  readonly leftEvents: Readonly<Record<string, Obj | null>>;
}

export interface ImageTarget extends Common {
  readonly kind: 'image';
  readonly assetId: string;
  readonly name: string | null;
  /** The staged image it came from (its record on the Staging page), when the job's record names it. */
  readonly stagedId: string | null;
  /**
   * v3 F3.4 (ADR 0055 decision B5): the placement of a staged image (made from the bridge's server staging, or moved out
   * of LegendKeeper's staging folder). Reverted by copying its file back into the bridge's server staging (back on the
   * Staging page) and proposing the placed asset's deletion to the owner; nothing is written to the staging folder.
   * False: an ordinary asset move, put back where it was.
   */
  readonly placement: boolean;
  /** Where it came from: an asset the job moved (its folder, name and hidden flag before), or one the job made. */
  readonly from:
    | {
        readonly kind: 'asset';
        readonly folderId: string | null;
        readonly name: string | null;
        readonly isHidden: boolean;
      }
    | { readonly kind: 'created' };
  readonly left: {
    readonly folderId: string | null;
    readonly name: string | null;
    readonly isHidden: boolean;
  };
  /** Folders the job made for it (they stay: a revert never deletes an asset). */
  readonly foldersMade: readonly string[];
  /**
   * CR-2026-11-R2 (R2-22): the names a staging folder has (the project's setting and the default): an ordinary move is put
   * back only into a folder read live whose name is none of them.
   */
  readonly stagingNames: readonly string[];
}

/** v3 F12 (ADR 0081): every other write kind, reverted by the generic undo (src/review/entity-undo.ts). */
export interface EntityTarget extends Common {
  readonly kind: 'entity';
  readonly undo: EntityUndo;
}

export interface NotRevertible extends Common {
  readonly kind: 'none';
  /**
   * v3 F12 (ADR 0081): what reverts this with something else: a write on a page the job made goes with that page's
   * deletion (`entity:<pageId>`), so it is nothing to do of its own.
   */
  readonly coveredBy?: string;
  /** Why Revert does not put it back, in words. */
  readonly reason: string;
  readonly deletion?: true;
  readonly creation?: true;
  /** What to use instead (`restore_resource`), when there is something. */
  readonly instead?: string;
  /** The journal entries that hold what it was (for a restore by hand). */
  readonly journal: readonly number[];
}

export type Target =
  | TextTarget
  | BlockTarget
  | FactsTarget
  | LmrTarget
  | ResourceTarget
  | MoveTarget
  | ChronologyUnitTarget
  | ImageTarget
  | EntityTarget
  | NotRevertible;

// ------------------------------------------------------------------------------------------------ classification

const TEXT_DOC_OPS = new Set([
  'replaceDocumentBlocks',
  'insertBlock',
  'replaceBlock',
  'updateBlock',
  'deleteBlock',
  'moveBlock',
]);
const ROW_OPS = new Set(['createPropertyRow', 'updatePropertyRow', 'deletePropertyRow']);
const PAGE_CREATES = new Set(['createResource', 'createResourceFromTemplate', 'saveResourceAsTemplate']);
const CHRONOLOGY_OPS = new Set([
  'insertBlock',
  'replaceBlock',
  'updateBlock',
  'deleteBlock',
  'moveBlock',
  'createEvent',
  'updateEvent',
  'deleteEvent',
]);

/** Deletions: what each deletes, and what to use instead. */
const DELETIONS: Readonly<Record<string, { what: string; instead?: string }>> = {
  deleteResource: {
    what: 'a page deleted',
    instead: 'restore_resource (or Restore in the LegendKeeper app)',
  },
  deleteDocument: { what: 'a document deleted', instead: 'restoreDocument through lk_api_write' },
  deleteEvent: { what: 'a timeline event deleted' },
  deleteLane: { what: 'a timeline lane deleted' },
  deleteFeature: { what: 'a map feature deleted' },
  deleteAsset: { what: 'an asset deleted' },
  deleteCalendar: { what: 'a calendar deleted' },
  deleteProperty: { what: 'a sidebar property deleted' },
  deleteBoardShapes: { what: 'board shapes deleted' },
};

/** Whether a step changed something (succeeded and not skipped), or may have (its outcome is unknown). */
function wrote(s: StepRecord): 'yes' | 'maybe' | 'no' {
  if (s.opKind === 'read' || isBridgeStep(s.opId)) return 'no';
  if (s.status === 'succeeded') {
    const r = isObj(s.result) ? s.result : {};
    if (r.unchanged === true || r.skipped !== undefined) return 'no';
    return 'yes';
  }
  return s.maybeSent ? 'maybe' : 'no';
}

const bodyOf = (p: OpParams): Obj => (isObj(p.body) ? p.body : {});

function expectChecks(steps: readonly StepRecord[]): Obj[] {
  const out: Obj[] = [];
  for (const s of steps) {
    if (s.opId !== EXPECT_STEP) continue;
    const checks = bodyOf(s.params).checks;
    for (const c of Array.isArray(checks) ? checks : [])
      // v3 F7d (ADR 0077, A8): the check of the identity page an Art page copies from writes nothing and explains no
      // write: it is not the identity page's own facts check (an upgrade's), which a revert works from.
      if (isObj(c) && !(typeof c.label === 'string' && c.label.endsWith(': identity'))) out.push(c);
  }
  return out;
}

function verifyTargets(steps: readonly StepRecord[]): Obj[] {
  const out: Obj[] = [];
  for (const s of steps) {
    if (s.opId !== VERIFY_STEP) continue;
    const targets = bodyOf(s.params).targets;
    for (const t of Array.isArray(targets) ? targets : []) if (isObj(t)) out.push(t);
  }
  return out;
}

export interface TargetDeps {
  readonly pageName?: (resourceId: string) => string | null;
  readonly documentName?: (resourceId: string, documentId: string) => string | null;
  /**
   * v3 F3.4 (ADR 0055 decision B5): the staged image this job placed by moving its asset (an image staged in
   * LegendKeeper's staging folder before F2), when the bridge's record says so: its staged id; else null.
   */
  readonly placedStaged?: (assetId: string) => string | null;
  /** Whether a folder is the project's staging folder in LegendKeeper (Revert never writes there). */
  readonly isStagingFolder?: (folderId: string | null) => boolean;
  /** CR-2026-11-R2 (R2-22): the staging folder's names (the project's setting and the default). */
  readonly stagingNames?: () => readonly string[];
  /**
   * CR-2026-11-R2 (R2-18): a later job that relied on a Last Major Revision date the job set (its own decision the same day
   * on that page, or a later write to that page's text that day): its id, else null.
   */
  readonly laterLmr?: (resourceId: string, date: string) => string | null;
  /** CR-2026-11-R2 (R2-28): the applied (or possibly applied) journal entries of later jobs. */
  readonly laterWrites?: () => readonly LaterWrite[];
  /**
   * CR-2026-11-R3, R3-57 (ADR 0061 part B decision 5): the job is a retag batch (ADR 0060 decision 3.6, "only where the
   * page is as the job left it"): each page target also keeps the page's name and parent as the job left them.
   */
  readonly placeAsLeft?: boolean;
}

/** A later job's journal entry (CR-2026-11-R2, F10). */
export interface LaterWrite {
  readonly jobId: string;
  readonly opId: string;
  readonly targetId: string | null;
  readonly resourceId: string | null;
  readonly documentId: string | null;
  /** The write's input as journalled (its path, ids). */
  readonly params: unknown;
}

/** The job's targets (see the module comment), in the order of their first step. */
export function jobTargets(rec: JobRecord, d: TargetDeps = {}): Target[] {
  const targets: Target[] = [];
  const handled = new Set<number>();
  const page = (id: string | undefined | null): PageRef | null =>
    id ? { id, name: d.pageName?.(id) ?? null } : null;
  const entriesOf = (stepNo: number) => rec.journal.filter((e) => e.stepNo === stepNo);
  const preOf = (stepNo: number): unknown => {
    const e = entriesOf(stepNo).find((x) => x.preImage !== undefined && x.preImage !== null);
    return e?.preImage ?? null;
  };
  const writes = rec.steps.filter((s) => wrote(s) !== 'no');
  const uncertain = (ss: readonly StepRecord[]) => ss.some((s) => wrote(s) === 'maybe');

  // Pages the job created: what it did to them is part of their creation.
  const created = new Set<string>();
  for (const s of writes) {
    const b = bodyOf(s.params);
    if (PAGE_CREATES.has(s.opId)) {
      const id = str(b.id) ?? str((s.result as Obj | null)?.id);
      if (id) created.add(id);
    }
    if (s.opId === 'createManyResources') {
      for (const r of Array.isArray(b.resources) ? b.resources : [])
        if (isObj(r) && str(r.id)) created.add(String(r.id));
      for (const r of Array.isArray((s.result as Obj | null)?.resources)
        ? ((s.result as Obj).resources as unknown[])
        : [])
        if (isObj(r) && str(r.id)) created.add(String(r.id));
    }
  }

  // 1. A chronology change: its rows, events and counts as one unit (kept in step, as the chronology tools do).
  if (rec.chronology) {
    const unit = chronologyUnit(rec, writes, preOf, page);
    if (unit) {
      targets.push(unit.target);
      for (const n of unit.steps) handled.add(n);
    }
  }

  // 2. Last Major Revision rows the job set (folded into a facts target of the same property below).
  const lmrs: LmrTarget[] = [];
  for (const s of rec.steps) {
    if (s.opId !== LMR_STEP || s.status !== 'succeeded') continue;
    const r = isObj(s.result) ? s.result : {};
    const lmr = isObj(r.lmr) ? r.lmr : null;
    const path = lmr && isObj(lmr.path) ? (lmr.path as Record<string, string>) : null;
    if (!path || typeof r.date !== 'string') continue;
    const write = rec.steps.find((w) => w.options.decisionFrom?.step === s.stepNo);
    if (!write || wrote(write) === 'no') continue;
    const key = str(bodyOf(s.params).key) ?? 'Last Major Revision';
    const after = bodyOf(s.params).after;
    // CR-2026-11-R2 (R2-18): the value before exactly (its runs), when the decision recorded them.
    const runs = Array.isArray(r.previousContent)
      ? r.previousContent
      : Array.isArray(r.previous)
        ? r.previous
        : null;
    handled.add(write.stepNo);
    lmrs.push({
      key: `lmr:${path.resourceId}`,
      kind: 'lmr',
      page: page(path.resourceId),
      what: `${key}`,
      steps: [write.stepNo],
      ...(wrote(write) === 'maybe' ? { uncertain: true } : {}),
      resourceId: path.resourceId!,
      propertyId: path.propertyId!,
      rowId: path.rowId!,
      rowKey: key,
      before: typeof r.previous === 'string' ? r.previous : runs ? runsText(runs) : '',
      after: r.date,
      beforeRuns: runs ? runs.filter(isObj) : null,
      justifiedBy: Array.isArray(after) ? after.filter((n): n is number => typeof n === 'number') : [],
      keptFor: d.laterLmr?.(path.resourceId!, r.date) ?? null,
    });
  }

  // 3. Page text, per document.
  const checks = expectChecks(rec.steps);
  const textSteps = writes.filter((s) => TEXT_DOC_OPS.has(s.opId) && !handled.has(s.stepNo));
  const docs = [...new Set(textSteps.map((s) => s.params.path?.documentId).filter((x): x is string => !!x))];
  for (const docId of docs) {
    const ss = textSteps.filter((s) => s.params.path?.documentId === docId);
    const resourceId = ss[0]!.params.path?.resourceId ?? '';
    if (created.has(resourceId)) continue; // part of a page the job made
    const blockwise = checks.find(
      (c) => c.checker === BLOCKWISE_CHECK && c.kind === 'document' && c.documentId === docId,
    );
    const firstWhole = ss.find((s) => s.opId === 'replaceDocumentBlocks');
    let before: Obj[] | null = null;
    if (blockwise && isObj(blockwise.input) && Array.isArray(blockwise.input.before))
      before = withoutVersions(blockwise.input.before as unknown[]);
    else if (firstWhole && firstWhole === ss[0]) {
      const pre = preOf(firstWhole.stepNo);
      const blocks = isObj(pre) ? pre.blocks : undefined;
      if (Array.isArray(blocks)) before = withoutVersions(blocks);
    } else if (ss[0]!.opId === 'deleteBlock') {
      // v3 F12: a low-level block delete keeps the document's blocks as they were (src/jobs/step-exec.ts).
      const pre = preOf(ss[0]!.stepNo);
      const blocks = isObj(pre) ? pre.documentBlocks : undefined;
      if (Array.isArray(blocks)) before = withoutVersions(blocks);
    }
    if (before) {
      const left = replay(before, ss);
      if (left) {
        for (const s of ss) handled.add(s.stepNo);
        targets.push({
          key: `text:${docId}`,
          kind: 'text',
          page: page(resourceId),
          what: 'page text',
          steps: ss.map((s) => s.stepNo),
          ...(uncertain(ss) ? { uncertain: true } : {}),
          resourceId,
          documentId: docId,
          documentName: d.documentName?.(resourceId, docId) ?? null,
          before,
          left,
        });
        continue;
      }
    }
    // Single blocks through the low-level tools: each insert, replace or update on its own.
    for (const s of ss) {
      const blockId =
        s.opId === 'insertBlock'
          ? str((bodyOf(s.params).block as Obj | undefined)?.id)
          : s.params.path?.blockId;
      if (!blockId || (s.opId !== 'insertBlock' && s.opId !== 'replaceBlock' && s.opId !== 'updateBlock'))
        continue;
      const pre = preOf(s.stepNo);
      if (s.opId !== 'insertBlock' && !isObj(pre)) continue;
      handled.add(s.stepNo);
      const b = bodyOf(s.params);
      targets.push({
        key: `block:${docId}:${blockId}:${s.stepNo}`,
        kind: 'block',
        page: page(resourceId),
        what: `a block (${s.opId === 'insertBlock' ? 'added' : s.opId === 'replaceBlock' ? 'replaced' : 'changed'})`,
        steps: [s.stepNo],
        ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
        resourceId,
        documentId: docId,
        blockId,
        change: s.opId === 'insertBlock' ? 'inserted' : s.opId === 'replaceBlock' ? 'replaced' : 'updated',
        before: s.opId === 'insertBlock' ? null : withoutVersions([pre])[0]!,
        sent: s.opId === 'insertBlock' ? (b.block as Obj) : b,
      });
    }
  }

  // 4. Sidebar facts and link collections (set_facts' check and verify steps; packs use the same).
  const verifies = verifyTargets(rec.steps);
  const rowSteps = writes.filter(
    (s) => (ROW_OPS.has(s.opId) || s.opId === 'updateProperty') && !handled.has(s.stepNo),
  );
  const factPages = [
    ...new Set(rowSteps.map((s) => s.params.path?.resourceId).filter((x): x is string => !!x)),
  ];
  for (const pid of factPages) {
    if (created.has(pid)) continue;
    const ss = rowSteps.filter((s) => s.params.path?.resourceId === pid);
    const rowsCheck = checks.find((c) => c.kind === 'propertyRows' && c.resourceId === pid);
    const sidebar = verifies.find((t) => t.kind === 'sidebar' && t.resourceId === pid);
    const props = Array.isArray(sidebar?.properties) ? (sidebar.properties as Obj[]) : [];
    const rowsProp = rowsCheck
      ? props.find((p) => p.id === rowsCheck.propertyId && Array.isArray(p.rows))
      : undefined;
    const explained = ss.every((s) =>
      ROW_OPS.has(s.opId)
        ? rowsCheck !== undefined &&
          s.params.path?.propertyId === rowsCheck.propertyId &&
          rowsProp !== undefined
        : checks.some(
            (c) =>
              c.kind === 'collection' && c.resourceId === pid && c.propertyId === s.params.path?.propertyId,
          ) && props.some((p) => p.id === s.params.path?.propertyId && isObj(p.collection)),
    );
    if (!explained) continue; // raw row writes: reported as not revertible below
    for (const s of ss) handled.add(s.stepNo);
    const collections = ss
      .filter((s) => s.opId === 'updateProperty')
      .map((s) => {
        const id = s.params.path!.propertyId!;
        const c = checks.find((x) => x.kind === 'collection' && x.resourceId === pid && x.propertyId === id)!;
        const p = props.find((x) => x.id === id)!;
        return {
          propertyId: id,
          title: str(c.label) ?? str(p.title) ?? id,
          before: c.collection as CollectionState,
          left: p.collection as CollectionState,
        };
      });
    const propertyId = rowsCheck ? String(rowsCheck.propertyId) : null;
    let rowsLeft = rowsProp ? (rowsProp.rows as RowState[]) : null;
    // CR-2026-11-R2 (R2-27): a job that failed part-way left what its row writes that succeeded wrote, not its plan: the
    // rows it left are worked out by replaying those writes on the rows before (as the page text is).
    if (rowsCheck && Array.isArray(rowsCheck.rows)) {
      const all = rec.steps.filter(
        (s) =>
          ROW_OPS.has(s.opId) &&
          s.options.decisionFrom === undefined &&
          s.params.path?.resourceId === pid &&
          s.params.path?.propertyId === rowsCheck.propertyId,
      );
      // A write LegendKeeper refused (its journal entry: not applied) wrote nothing, although it was sent.
      const refused = (s: StepRecord) =>
        s.status === 'failed' &&
        entriesOf(s.stepNo).length > 0 &&
        entriesOf(s.stepNo).every((e) => e.outcome === 'not_applied');
      const did = (s: StepRecord) => (refused(s) ? 'no' : wrote(s));
      if (all.some((s) => did(s) === 'no') && !all.some((s) => did(s) === 'maybe'))
        rowsLeft = replayRows(
          rowsCheck.rows as RowState[],
          all.filter((s) => did(s) === 'yes'),
        );
    }
    const lmr = propertyId
      ? lmrs.find((l) => l.resourceId === pid && l.propertyId === propertyId)
      : undefined;
    if (lmr && rowsLeft) {
      rowsLeft = rowsLeft.map((r) =>
        r.id === lmr.rowId ? { ...r, content: lmr.after === '' ? [] : [{ text: lmr.after }] } : r,
      );
      lmrs.splice(lmrs.indexOf(lmr), 1);
    }
    targets.push({
      key: `facts:${pid}`,
      kind: 'facts',
      page: page(pid),
      what: [
        rowsCheck ? 'sidebar facts' : '',
        collections.length ? collections.map((c) => c.title).join(', ') : '',
      ]
        .filter(Boolean)
        .join(' and '),
      steps: ss.map((s) => s.stepNo),
      ...(uncertain(ss) ? { uncertain: true } : {}),
      resourceId: pid,
      property: propertyId ? { id: propertyId, title: str(rowsCheck?.label) ?? 'facts' } : null,
      rowsBefore: rowsCheck && Array.isArray(rowsCheck.rows) ? (rowsCheck.rows as RowState[]) : null,
      rowsLeft,
      collections,
      ...(lmr
        ? {
            lmr: {
              rowId: lmr.rowId,
              key: lmr.rowKey,
              before: lmr.before,
              after: lmr.after,
              justifiedBy: lmr.justifiedBy,
              keptFor: lmr.keptFor,
            },
          }
        : {}),
    });
  }
  for (const l of lmrs) if (!created.has(l.resourceId)) targets.push(l);

  // 5. Names, tags, aliases and icons; and moves.
  const resSteps = writes.filter((s) => s.opId === 'updateResource' && !handled.has(s.stepNo));
  for (const pid of [
    ...new Set(resSteps.map((s) => s.params.path?.resourceId).filter((x): x is string => !!x)),
  ]) {
    if (created.has(pid)) continue;
    const ss = resSteps.filter((s) => s.params.path?.resourceId === pid);
    const pre = preOf(ss[0]!.stepNo);
    if (!isObj(pre)) continue;
    const before: Partial<Record<ResourceField, unknown>> = {};
    const left: Partial<Record<ResourceField, unknown>> = {};
    let other = false;
    for (const s of ss) {
      for (const [k, v] of Object.entries(bodyOf(s.params))) {
        if (!(RESOURCE_FIELDS as readonly string[]).includes(k)) {
          other = true;
          continue;
        }
        const f = k as ResourceField;
        if (!(f in before)) before[f] = pre[f] ?? null;
        left[f] = v;
      }
    }
    if (other || Object.keys(left).length === 0) continue; // permissions, banner or the hidden flag: not reverted
    for (const s of ss) handled.add(s.stepNo);
    // v3 F7.1: a template the job recorded for this page with its rename (the Core upgrade), and the one it had.
    const tpl = 'name' in left ? templateRecorded(rec, pid) : null;
    targets.push({
      key: `resource:${pid}`,
      kind: 'resource',
      page: page(pid),
      what: Object.keys(left).join(', '),
      steps: ss.map((s) => s.stepNo),
      ...(uncertain(ss) ? { uncertain: true } : {}),
      resourceId: pid,
      before,
      left,
      ...(tpl ? { template: tpl } : {}),
      // R3-57: its name (as the job left it) and parent (the job did not move it), for a retag batch.
      ...(d.placeAsLeft === true
        ? {
            place: {
              name: 'name' in left ? left.name : (pre.name ?? null),
              parentId: str(pre.parentId) ?? null,
            },
          }
        : {}),
    });
  }
  const moveSteps = writes.filter((s) => s.opId === 'moveResource' && !handled.has(s.stepNo));
  for (const pid of [
    ...new Set(moveSteps.map((s) => s.params.path?.resourceId).filter((x): x is string => !!x)),
  ]) {
    if (created.has(pid)) continue;
    const ss = moveSteps.filter((s) => s.params.path?.resourceId === pid);
    const pre = preOf(ss[0]!.stepNo);
    if (!isObj(pre)) continue;
    const parentBefore = str(pre.parentId) ?? null;
    const last = ss[ss.length - 1]!;
    const lastBody = bodyOf(last.params);
    const parentLeft = lastBody.parentId === undefined ? parentBefore : (str(lastBody.parentId) ?? null);
    // CR-2026-11-R2 (R2-19): its place as the job left it (the move's answer: the page with its rank).
    const rankLeft = isObj(last.result) ? (str(last.result.rank) ?? null) : null;
    for (const s of ss) handled.add(s.stepNo);
    targets.push({
      key: `move:${pid}`,
      kind: 'move',
      page: page(pid),
      what: parentLeft === parentBefore ? 'its place among its siblings' : 'its place in the tree',
      steps: ss.map((s) => s.stepNo),
      ...(uncertain(ss) ? { uncertain: true } : {}),
      resourceId: pid,
      before: { parentId: parentBefore, rank: str(pre.rank) ?? null },
      left: { parentId: parentLeft, rank: rankLeft },
    });
  }

  // 6. Images placed: an asset the job made in its folder, or a staged asset it moved and unhid.
  const folders = writes.filter((s) => s.opId === 'createAssetFolder');
  const madeFolders = folders
    .filter((s) => (isObj(s.result) ? s.result.found !== true : true))
    .map((s) => str(bodyOf(s.params).name) ?? 'a folder');
  for (const s of writes) {
    if (s.opId === 'createImageAsset' && !handled.has(s.stepNo)) {
      const r = isObj(s.result) ? s.result : {};
      const entry = entriesOf(s.stepNo)[0];
      const assetId = str(r.id) ?? str(entry?.targetId);
      if (!assetId) continue;
      handled.add(s.stepNo);
      const b = bodyOf(s.params);
      const op = isObj(s.options.journalOperation) ? s.options.journalOperation : {};
      const stagedId = str(op.stagedId) ?? null;
      if (!stagedId) {
        // An image uploaded straight into its folder (no staged image behind it): a creation.
        targets.push({
          key: `none:${s.stepNo}`,
          kind: 'none',
          page: null,
          what: `image “${str(b.name) ?? assetId}”`,
          steps: [s.stepNo],
          reason: `an image uploaded straight into its folder: Revert does not delete what a job made (delete it yourself if it should go)`,
          creation: true,
          journal: entriesOf(s.stepNo).map((e) => e.id),
        });
        continue;
      }
      targets.push({
        key: `image:${assetId}`,
        kind: 'image',
        page: null,
        what: `image “${str(b.name) ?? assetId}”`,
        steps: [s.stepNo],
        ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
        assetId,
        name: str(b.name) ?? null,
        stagedId,
        placement: true,
        from: { kind: 'created' },
        left: {
          folderId: str(b.folderId) ?? str(r.folderId) ?? null,
          name: str(b.name) ?? null,
          isHidden: false,
        },
        foldersMade: madeFolders,
        stagingNames: d.stagingNames?.() ?? [],
      });
    }
    if (s.opId === 'updateAsset' && !handled.has(s.stepNo)) {
      const pre = preOf(s.stepNo);
      const assetId = s.params.path?.assetId;
      if (!assetId || !isObj(pre)) continue;
      const b = bodyOf(s.params);
      // Only a placement or a move (folder, or unhiding); a description edit alone is not one.
      if (b.folderId === undefined && b.isHidden === undefined && b.name === undefined) continue;
      handled.add(s.stepNo);
      const from = {
        kind: 'asset' as const,
        folderId: str(pre.folderId) ?? null,
        name: str(pre.name) ?? null,
        isHidden: pre.isHidden === true,
      };
      const stagedId = d.placedStaged?.(assetId) ?? null;
      if (!stagedId && d.isStagingFolder?.(from.folderId) === true) {
        // Out of the staging folder by hand, with no staged record behind it: putting it back would write there.
        targets.push({
          key: `none:${s.stepNo}`,
          kind: 'none',
          page: null,
          what: `asset “${str(b.name) ?? from.name ?? assetId}”`,
          steps: [s.stepNo],
          reason:
            'an asset moved out of the staging folder that no staged image records: Revert never writes to the staging folder (move it yourself if it should go back)',
          journal: entriesOf(s.stepNo).map((e) => e.id),
        });
        continue;
      }
      targets.push({
        key: `image:${assetId}`,
        kind: 'image',
        page: null,
        what: stagedId
          ? `image “${str(b.name) ?? from.name ?? assetId}”`
          : `asset “${str(b.name) ?? from.name ?? assetId}”`,
        steps: [s.stepNo],
        ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
        assetId,
        name: str(b.name) ?? from.name,
        stagedId,
        placement: stagedId !== null,
        from,
        left: {
          folderId: b.folderId === undefined ? from.folderId : (str(b.folderId) ?? null),
          name: str(b.name) ?? from.name,
          isHidden: b.isHidden === undefined ? from.isHidden : b.isHidden === true,
        },
        foldersMade: madeFolders,
        stagingNames: d.stagingNames?.() ?? [],
      });
    }
  }
  // CR-2026-11-R2 (R2-24): a folder is part of a placement only when the same job placed an image into it (or into a folder
  // it made inside it, as a chain). Any other folder the job made is a creation, listed as not revertible below.
  const placedIn = new Set<string>();
  for (const t of targets) {
    if (t.kind !== 'image' || !t.placement) continue;
    if (t.left.folderId) placedIn.add(t.left.folderId);
    for (const n of t.steps) {
      const st = rec.steps.find((x) => x.stepNo === n);
      const f = st && isObj(st.result) ? str(st.result.folderId) : undefined;
      if (f) placedIn.add(f);
    }
  }
  for (const s of [...folders].reverse()) {
    const id = isObj(s.result) ? str(s.result.id) : undefined;
    if (id && placedIn.has(id)) {
      handled.add(s.stepNo);
      const parent = str(bodyOf(s.params).parentId);
      if (parent) placedIn.add(parent);
    } else if (isObj(s.result) && s.result.found === true) handled.add(s.stepNo); // found, not made: nothing changed
  }
  for (const s of writes) if (s.opId === 'createImageUpload') handled.add(s.stepNo); // no change in LegendKeeper

  // 7. v3 F12 (ADR 0081, D2 and D3): every other write, by the generic undo (an update back to its pre-image, a creation
  // deleted again while untouched, a deletion restored or made again); a write on a page the job made goes with it.
  const pageTargets: EntityTarget[] = [];
  const madePages = [...created];
  for (const s of writes) {
    if (handled.has(s.stepNo)) continue;
    const rid = s.params.path?.resourceId ?? null;
    const journal = entriesOf(s.stepNo).map((e) => e.id);
    const common = {
      key: `none:${s.stepNo}`,
      kind: 'none' as const,
      page: page(rid ?? (PAGE_CREATES.has(s.opId) ? str(bodyOf(s.params).id) : undefined)),
      steps: [s.stepNo],
      ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
      journal,
    };
    // A page the job made (one or many): deleted again while untouched, children first.
    if (PAGE_CREATES.has(s.opId) || s.opId === 'createManyResources') {
      const items =
        s.opId === 'createManyResources'
          ? (Array.isArray(bodyOf(s.params).resources)
              ? (bodyOf(s.params).resources as unknown[])
              : []
            ).filter(isObj)
          : [bodyOf(s.params)];
      const results =
        s.opId === 'createManyResources' && isObj(s.result) && Array.isArray(s.result.resources)
          ? (s.result.resources as unknown[]).filter(isObj)
          : isObj(s.result)
            ? [s.result]
            : [];
      for (const [i, it] of items.entries()) {
        const id = str(it.id) ?? str(results[i]?.id);
        if (!id) continue;
        pageTargets.push(createdPageTarget(rec, writes, s, id, it, results[i] ?? null, madePages, page));
      }
      handled.add(s.stepNo);
      continue;
    }
    // Anything else on a page the job made is part of making it: it goes with the page's deletion.
    if (rid && created.has(rid) && s.opId !== 'deleteResource') {
      targets.push({
        ...common,
        what: `part of a page the job made (${s.opId})`,
        reason: 'it goes with the page the job made, which Revert deletes again while untouched',
        coveredBy: `entity:resource:${rid}`,
        creation: true,
      });
      continue;
    }
    const ent = ENTITY_OPS[s.opId];
    if (ent) {
      const undo = entityUndoOf(s, ent, preOf(s.stepNo), entriesOf(s.stepNo)[0]?.targetId ?? null);
      if (undo) {
        targets.push({
          key: `entity:${s.opId}:${s.stepNo}`,
          kind: 'entity',
          page: page(rid),
          what: `${ENTITIES[undo.entity].label} ${ent.action === 'update' ? 'changed' : ent.action === 'create' ? 'made' : ent.action === 'restore' ? 'restored' : 'deleted'}`,
          steps: [s.stepNo],
          ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
          undo,
        });
        continue;
      }
    }
    const del = DELETIONS[s.opId];
    if (del) {
      targets.push({
        ...common,
        what: del.what,
        reason: `${del.what}, with no record of what it was (a delete from before F12): use ${del.instead ?? 'the journal’s pre-images (bridge_journal_lookup)'}`,
        deletion: true,
        ...(del.instead ? { instead: del.instead } : {}),
      });
      continue;
    }
    const why =
      s.opId === 'createImageUpload' || s.opId === 'assignBlockIds'
        ? null
        : TEXT_DOC_OPS.has(s.opId)
          ? 'a page text write whose page before the job is not recorded'
          : `${s.opId}: the journal holds no record of it to revert from`;
    if (why === null) {
      targets.push({ ...common, what: s.opId, reason: 'no change to put back', coveredBy: 'nothing' });
      continue;
    }
    targets.push({ ...common, what: s.opId, reason: why });
  }
  // Children before their parents (a page made under another the job made is deleted first).
  const depth = (t: EntityTarget): number => {
    let n = 0;
    let cur = t.undo.left && typeof t.undo.left.parentId === 'string' ? t.undo.left.parentId : null;
    while (cur && created.has(cur) && n < 50) {
      n++;
      const up = pageTargets.find((x) => x.undo.path.resourceId === cur);
      cur = up?.undo.left && typeof up.undo.left.parentId === 'string' ? up.undo.left.parentId : null;
    }
    return n;
  };
  targets.push(...[...pageTargets].sort((a, b) => depth(b) - depth(a)));

  const later = d.laterWrites?.() ?? [];
  const marked =
    later.length === 0
      ? targets
      : targets.map((t) => {
          const by = laterWriteOf(t, later);
          return by ? { ...t, laterWrite: by } : t;
        });
  // Everything else in the order of its first step; then the pages the job made, deleted again last (so what the job
  // moved under them has gone back first), children before their parents.
  const madePage = (t: Target) =>
    t.kind === 'entity' && t.undo.entity === 'resource' && t.undo.action === 'create';
  return [
    ...marked.filter((t) => !madePage(t)).sort((a, b) => (a.steps[0] ?? 0) - (b.steps[0] ?? 0)),
    ...marked.filter(madePage),
  ];
}

/** v3 F12: the pages a job made: what it left them as (name, parent, tags) and the documents it wrote (their versions). */
function createdPageTarget(
  rec: JobRecord,
  writes: readonly StepRecord[],
  s: StepRecord,
  id: string,
  body: Obj,
  result: Obj | null,
  madePages: readonly string[],
  page: (id: string | undefined | null) => PageRef | null,
): EntityTarget {
  let left: Obj = {
    ...(typeof body.name === 'string'
      ? { name: body.name }
      : result?.name !== undefined
        ? { name: result.name }
        : {}),
    parentId: str(body.parentId) ?? str(result?.parentId) ?? null,
    ...(Array.isArray(body.tags)
      ? { tags: body.tags }
      : Array.isArray(result?.tags)
        ? { tags: result.tags }
        : {}),
  };
  const documents = new Map<string, string>();
  const sidebar = new Map<string, string>();
  for (const w of writes) {
    if (w.stepNo <= s.stepNo || w.params.path?.resourceId !== id) continue;
    if (w.opId === 'createPropertyRow' || w.opId === 'updatePropertyRow') {
      const b = bodyOf(w.params);
      const content = Array.isArray(b.content) ? runsText(b.content as unknown[]) : str(b.text);
      if (typeof b.key === 'string') sidebar.set(b.key, content ?? '');
    }
    if (w.opId === 'updateResource') left = { ...left, ...pickResource(bodyOf(w.params)) };
    if (w.opId === 'moveResource' && bodyOf(w.params).parentId !== undefined)
      left = { ...left, parentId: str(bodyOf(w.params).parentId) ?? null };
    const docId = w.params.path?.documentId;
    const v = isObj(w.result) ? str(w.result.version) : undefined;
    if (docId && v) documents.set(docId, v);
  }
  void rec;
  return {
    key: `entity:resource:${id}`,
    kind: 'entity',
    page: page(id),
    what: `a page the job made${typeof left.name === 'string' ? ` (${left.name})` : ''}`,
    steps: [s.stepNo],
    ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
    undo: {
      entity: 'resource',
      action: 'create',
      op: s.opId,
      path: { resourceId: id },
      left,
      before: null,
      documents: [...documents].map(([docId, version]) => ({ id: docId, version })),
      // The pages the job made, and the pages it moved here itself (their moves are reverted first, by their own targets).
      madeWith: [
        ...madePages.filter((x) => x !== id),
        ...writes
          .filter(
            (w) =>
              (w.opId === 'moveResource' || w.opId === 'updateResource') &&
              str(bodyOf(w.params).parentId) === id &&
              typeof w.params.path?.resourceId === 'string',
          )
          .map((w) => w.params.path!.resourceId!),
      ],
      ...(sidebar.size > 0 ? { sidebar: [...sidebar].map(([key, value]) => ({ key, value })) } : {}),
    },
  };
}

const pickResource = (b: Obj): Obj => {
  const out: Obj = {};
  for (const k of ['name', 'tags']) if (b[k] !== undefined) out[k] = b[k];
  return out;
};

/** v3 F12: the generic undo of one write, from its step and its journal entry; null when there is nothing to work from. */
function entityUndoOf(
  s: StepRecord,
  ent: { readonly entity: EntityUndo['entity']; readonly action: EntityUndo['action'] },
  pre: unknown,
  journalTarget: string | null,
): EntityUndo | null {
  const def = ENTITIES[ent.entity];
  const path: Record<string, string> = { ...(s.params.path ?? {}) };
  const body = bodyOf(s.params);
  const res = isObj(s.result) ? s.result : null;
  const shapesSent = Array.isArray(body.shapes) ? body.shapes.filter(isObj) : [];
  if (ent.action === 'create' && def.idParam && !path[def.idParam]) {
    const id = str(res?.id) ?? str(body.id) ?? journalTarget ?? undefined;
    if (!id) return null;
    path[def.idParam] = id;
  }
  if (ent.entity === 'boardShapes') {
    const ids =
      ent.action === 'delete'
        ? Array.isArray(body.ids)
          ? body.ids.filter((x): x is string => typeof x === 'string')
          : []
        : shapesSent.map((x) => str(x.id)).filter((x): x is string => !!x);
    const board = isObj(pre) && Array.isArray(pre.shapes) ? pre.shapes.filter(isObj) : [];
    const byId = (list: readonly Obj[]) =>
      Object.fromEntries(list.filter((x) => ids.includes(String(x.id))).map((x) => [String(x.id), x]));
    return {
      entity: 'boardShapes',
      action: ent.action,
      op: s.opId,
      path,
      shapeIds: ids,
      left: ent.action === 'delete' ? null : byId(shapesSent),
      before: ent.action === 'create' ? null : byId(board),
    };
  }
  if (ent.entity === 'board')
    return {
      entity: 'board',
      action: 'update',
      op: s.opId,
      path,
      left: { shapes: shapesSent },
      before: isObj(pre) ? pre : null,
    };
  const preObj = isObj(pre) ? pre : null;
  const copy =
    preObj && isObj(preObj.copy) && typeof preObj.copy.snapshotId === 'string'
      ? { snapshotId: preObj.copy.snapshotId, pages: Number(preObj.copy.pages ?? 1) }
      : null;
  if (ent.action === 'update') {
    // The fields the job wrote, as LegendKeeper answered them (else as sent), and their values before.
    const keys = Object.keys(body);
    const left: Obj = {};
    const before: Obj = {};
    for (const k of keys) {
      left[k] = res && res[k] !== undefined ? res[k] : body[k];
      before[k] = preObj ? (preObj[k] ?? null) : undefined;
    }
    return {
      entity: ent.entity,
      action: 'update',
      op: s.opId,
      path,
      left,
      before: preObj ? before : null,
    };
  }
  if (ent.action === 'create' || ent.action === 'restore') {
    const left: Obj = {};
    for (const k of Object.keys(body))
      if (k !== 'id') left[k] = res && res[k] !== undefined ? res[k] : body[k];
    return { entity: ent.entity, action: ent.action, op: s.opId, path, left, before: null };
  }
  return { entity: ent.entity, action: 'delete', op: s.opId, path, left: null, before: preObj, copy };
}

/** CR-2026-11-R2 (R2-27): the rows after the row writes that were applied (in order), from the rows before. */
function replayRows(before: readonly RowState[], steps: readonly StepRecord[]): RowState[] {
  let rows: RowState[] = before.map((r) => ({ ...r }));
  for (const s of steps) {
    if (wrote(s) !== 'yes') continue;
    const b = bodyOf(s.params);
    const rowId = s.params.path?.rowId;
    const content = Array.isArray(b.content) ? (b.content as Obj[]) : b.content === null ? [] : undefined;
    if (s.opId === 'updatePropertyRow')
      rows = rows.map((r) =>
        r.id === rowId
          ? { ...r, ...(typeof b.key === 'string' ? { key: b.key } : {}), ...(content ? { content } : {}) }
          : r,
      );
    else if (s.opId === 'deletePropertyRow') rows = rows.filter((r) => r.id !== rowId);
    else if (s.opId === 'createPropertyRow') {
      const res = isObj(s.result) ? s.result : {};
      rows.push({
        id: str(res.id) ?? null,
        rank: str(res.rank) ?? null,
        key: typeof b.key === 'string' ? b.key : '',
        content: content ?? [],
      });
    }
  }
  return rows;
}

/** The states a document can be in after the job's text writes (two when one write's outcome is unknown); null when they cannot be replayed. */
function replay(before: readonly Obj[], steps: readonly StepRecord[]): Obj[][] | null {
  let states: Obj[][] = [before.map((b) => structuredClone(b))];
  for (const s of steps) {
    const next: Obj[][] = [];
    for (const st of states) {
      let applied: Obj[] | null;
      if (s.opId === 'replaceDocumentBlocks') {
        const blocks = bodyOf(s.params).blocks;
        if (!Array.isArray(blocks)) return null;
        applied = withoutVersions(blocks);
      } else {
        const op = stepOp(s.opId, s.params);
        if (!op) return null;
        try {
          applied = applyBlockOps(st, [op]);
        } catch {
          applied = null;
        }
      }
      if (wrote(s) === 'yes') {
        if (!applied) return null;
        next.push(applied);
      } else {
        // Unknown outcome: either state is possible.
        next.push(st);
        if (applied) next.push(applied);
      }
    }
    states = next.slice(0, 4);
  }
  return states;
}

// ------------------------------------------------------------------------------------------------ chronology

const EVENT_FIELDS = ['name', 'start', 'end', 'detail', 'laneId', 'uri'] as const;

/**
 * A chronology change as one unit: the inverse writes in the chronology tools' own form. A change that deleted a row or
 * an event (a deletion) is not reverted, nor one whose table or timeline writes are not all explained by its record.
 */
function chronologyUnit(
  rec: JobRecord,
  writes: readonly StepRecord[],
  preOf: (stepNo: number) => unknown,
  page: (id: string | undefined | null) => PageRef | null,
): { target: Target; steps: number[] } | null {
  const record = rec.chronology!;
  const mine = writes.filter(
    (s) =>
      CHRONOLOGY_OPS.has(s.opId) &&
      isObj(s.options.journalOperation) &&
      isObj(s.options.journalOperation.chronology),
  );
  if (mine.length === 0) return null;
  const steps = mine.map((s) => s.stepNo);
  const resourceId = mine[0]!.params.path?.resourceId ?? null;
  const base = {
    key: `chronology:${record.id}`,
    page: page(resourceId),
    what: `chronology: ${record.summary}`.slice(0, 300),
    steps,
    ...(mine.some((s) => wrote(s) === 'maybe') ? { uncertain: true } : {}),
  };
  const refuse = (reason: string, deletion = false): { target: Target; steps: number[] } => ({
    target: {
      ...base,
      kind: 'none',
      reason,
      ...(deletion ? { deletion: true as const } : {}),
      journal: rec.journal.filter((e) => e.stepNo !== null && steps.includes(e.stepNo)).map((e) => e.id),
    },
    steps,
  });
  if (record.state !== 'complete')
    return refuse(
      'a chronology change that did not finish (its record is incomplete): resolve it on the Chronology page first',
    );
  const count = (k: TargetWrite['kind']) => record.target.writes.filter((w) => w.kind === k).length;
  // v3 F10 (ADR 0078): rows put into calendar order are not put back out of it (the calendar decides the order).
  if (count('row.move') > 0)
    return refuse(
      'a chronology change that put table rows into calendar order: it is not reverted (the calendar decides the order; move a row by hand if it must go elsewhere)',
    );
  // v3 F12 (ADR 0081, D3): a deletion too is put back, from the journal's pre-images (a row where it stood, an event made
  // again under a new id), as a delete paired with a creation always was.
  const inverse: TargetWrite[] = [];
  const oldRows: Record<string, Obj> = {};
  const oldEvents: Record<string, Obj> = {};
  for (const w of record.target.writes) {
    switch (w.kind) {
      case 'row.delete': {
        // The row moved to another age: it comes back where it was, as it was (its block, kept by the delete).
        // X5: one block id can be in two documents of a page: the row is its table document's.
        const step = mine.find(
          (s) =>
            s.opId === 'deleteBlock' &&
            s.params.path?.blockId === w.rowId &&
            s.params.path?.documentId === w.documentId,
        );
        const old = step ? preOf(step.stepNo) : null;
        if (!isObj(old))
          return refuse(`the table row ${w.rowId} as it was before the change is not in the journal`);
        const block = withoutVersions([old])[0]!;
        oldRows[rowKey(w.documentId, w.rowId)] = block;
        inverse.push({
          kind: 'row.insert',
          age: w.age,
          resourceId: w.resourceId,
          documentId: w.documentId,
          rowId: w.rowId,
          texts: w.texts,
          block,
        });
        break;
      }
      case 'event.delete': {
        // The event the change made again (or moved): made once more as it was, under a new id.
        const step = mine.find((s) => s.opId === 'deleteEvent' && s.params.path?.eventId === w.eventId);
        const old = step ? preOf(step.stepNo) : null;
        if (!isObj(old))
          return refuse(`the timeline event ${w.eventId} as it was before the change is not in the journal`);
        const id = mintClientId();
        oldEvents[id] = old;
        inverse.push({
          kind: 'event.create',
          age: w.age,
          resourceId: w.resourceId,
          documentId: w.documentId,
          eventId: id,
          body: remadeEventBody(old, id),
        });
        break;
      }
      case 'row.insert':
        inverse.push({
          kind: 'row.delete',
          age: w.age,
          resourceId: w.resourceId,
          documentId: w.documentId,
          rowId: w.rowId,
          texts: w.texts,
        });
        break;
      case 'row.replace': {
        const step = mine.find(
          (s) =>
            s.opId === 'replaceBlock' &&
            s.params.path?.blockId === w.rowId &&
            s.params.path?.documentId === w.documentId,
        );
        const old = step ? preOf(step.stepNo) : null;
        if (!isObj(old))
          return refuse(`the table row ${w.rowId} as it was before the change is not in the journal`);
        const block = withoutVersions([old])[0]!;
        oldRows[rowKey(w.documentId, w.rowId)] = block;
        inverse.push({
          kind: 'row.replace',
          age: w.age,
          resourceId: w.resourceId,
          documentId: w.documentId,
          rowId: w.rowId,
          before: w.texts,
          texts: w.before,
          block,
        });
        break;
      }
      case 'event.create':
        inverse.push({
          kind: 'event.delete',
          age: w.age,
          resourceId: w.resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
        });
        break;
      case 'event.update': {
        const step = mine.find((s) => s.opId === 'updateEvent' && s.params.path?.eventId === w.eventId);
        const old = step ? preOf(step.stepNo) : null;
        if (!isObj(old))
          return refuse(`the timeline event ${w.eventId} as it was before the change is not in the journal`);
        const fields = Object.fromEntries(
          Object.keys(w.fields)
            .filter((k) => (EVENT_FIELDS as readonly string[]).includes(k))
            .map((k) => [k, old[k] ?? null]),
        );
        oldEvents[w.eventId] = fields;
        inverse.push({
          kind: 'event.update',
          age: w.age,
          resourceId: w.resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
          fields,
        });
        break;
      }
      case 'count':
        inverse.push({ ...w, delta: -w.delta });
        break;
      default:
        break; // the compare-and-swap entries (asserts) write nothing
    }
  }
  if (inverse.length === 0) return null;
  // CR-2026-11-R2 (R2-16): what the job left, whole: each row block it wrote, and each event as LegendKeeper answered the
  // job's last write of it (null when that answer is not recorded: then the event cannot be compared, and is not reverted).
  const leftRows: Record<string, Obj> = {};
  const leftEvents: Record<string, Obj | null> = {};
  for (const w of record.target.writes) {
    if ((w.kind === 'row.insert' || w.kind === 'row.replace') && isObj(w.block))
      leftRows[rowKey(w.documentId, w.rowId)] = withoutVersions([w.block])[0]!;
    if (w.kind === 'event.create' || w.kind === 'event.update') {
      const last = [...mine]
        .reverse()
        .find(
          (s) =>
            wrote(s) === 'yes' &&
            ((s.opId === 'createEvent' && str(bodyOf(s.params).id) === w.eventId) ||
              (s.opId === 'updateEvent' && s.params.path?.eventId === w.eventId)),
        );
      leftEvents[w.eventId] = last && isObj(last.result) ? last.result : null;
    }
  }
  return {
    target: { ...base, kind: 'chronology', record, inverse, oldRows, oldEvents, leftRows, leftEvents },
    steps,
  };
}

const ROW_WRITE_OPS = new Set([
  'createPropertyRow',
  'updatePropertyRow',
  'deletePropertyRow',
  'updateProperty',
]);

/** The ids a later write names (its target, and every id in its path). */
function idsOf(e: LaterWrite): Set<string> {
  const ids = new Set<string>();
  if (e.targetId) ids.add(e.targetId);
  const p = isObj(e.params) ? e.params : {};
  const path = isObj(p.path) ? p.path : {};
  for (const v of Object.values(path)) if (typeof v === 'string') ids.add(v);
  const body = isObj(p.body) ? p.body : {};
  if (typeof body.id === 'string') ids.add(body.id);
  if (isObj(body.block) && typeof body.block.id === 'string') ids.add(body.block.id);
  return ids;
}

/**
 * CR-2026-11-R2 (R2-28): the later job that wrote a target again, if any. Each kind is matched at its own grain: a page's
 * text by its document, a single block by its id, a sidebar by the properties the job wrote (and a Last Major Revision
 * row by its own id), a page's fields or place by the page, a chronology change by its rows and events (not the Main
 * count, which every later change moves), an asset by its id.
 */
function laterWriteOf(t: Target, later: readonly LaterWrite[]): string | undefined {
  const hit = later.find((e) => {
    const ids = idsOf(e);
    switch (t.kind) {
      case 'text':
        return e.documentId === t.documentId;
      case 'block':
        return e.documentId === t.documentId && ids.has(t.blockId);
      case 'facts': {
        if (e.resourceId !== t.resourceId || !ROW_WRITE_OPS.has(e.opId)) return false;
        const props = [...(t.property ? [t.property.id] : []), ...t.collections.map((c) => c.propertyId)];
        return props.some((id) => ids.has(id));
      }
      case 'lmr':
        return e.resourceId === t.resourceId && ids.has(t.rowId);
      case 'resource':
        return e.resourceId === t.resourceId && e.opId === 'updateResource';
      case 'move':
        return e.resourceId === t.resourceId && (e.opId === 'moveResource' || e.opId === 'updateResource');
      case 'chronology': {
        const own = new Set<string>();
        for (const w of t.inverse) {
          if ('rowId' in w && w.kind !== 'count') own.add(w.rowId);
          if ('eventId' in w) own.add(w.eventId);
        }
        return [...ids].some((id) => own.has(id));
      }
      case 'image':
        return ids.has(t.assetId);
      case 'none':
        return false;
    }
  });
  return hit?.jobId;
}

/**
 * v3 F7.1 (ADR 0072): the template a job recorded for a page (`bridge.record` `set_template`, succeeded) with the one it
 * had (`previousTemplateId`, recorded since F7.1), or null.
 */
function templateRecorded(rec: JobRecord, resourceId: string): { before: string; left: string } | null {
  for (const s of rec.steps) {
    if (s.opId !== 'bridge.record' || s.status !== 'succeeded') continue;
    const r = (bodyOf(s.params).record ?? null) as Obj | null;
    if (!isObj(r) || r.kind !== 'set_template' || r.resourceId !== resourceId) continue;
    if (typeof r.templateId === 'string' && typeof r.previousTemplateId === 'string')
      return { before: r.previousTemplateId, left: r.templateId };
  }
  return null;
}
