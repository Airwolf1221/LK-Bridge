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
 * | `none`       | everything else: deletions, pages and other things created, other updates         | no, and why  |
 */
import { EXPECT_STEP, LMR_STEP, VERIFY_STEP, isBridgeStep } from '../jobs/internal-steps.js';
import type { JournalEntry } from '../jobs/journal.js';
import type { CollectionState, RowState } from '../jobs/sidebar-state.js';
import type { JobView, OpParams, StepOptions } from '../jobs/types.js';
import { BLOCKWISE_CHECK, applyBlockOps, stepOp, withoutVersions } from '../pages/blockwise.js';
import type { ChronologyRecord, TargetWrite } from '../chronology/store.js';
import { remadeEventBody } from '../chronology/event-body.js';
import { mintClientId } from '../jobs/ids.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

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
}

export interface MoveTarget extends Common {
  readonly kind: 'move';
  readonly resourceId: string;
  readonly before: { readonly parentId: string | null; readonly rank: string | null };
  readonly left: { readonly parentId: string | null };
}

export interface ChronologyUnitTarget extends Common {
  readonly kind: 'chronology';
  readonly record: ChronologyRecord;
  /** The writes that put it back, in the chronology tools' own form (rows, events and counts, in step). */
  readonly inverse: readonly TargetWrite[];
  /** For each row the inverse writes back: the block it held before the job (its journal pre-image). */
  readonly oldRows: Readonly<Record<string, Obj>>;
  /** For each event the inverse updates: its fields before the job. */
  readonly oldEvents: Readonly<Record<string, Obj>>;
}

export interface ImageTarget extends Common {
  readonly kind: 'image';
  readonly assetId: string;
  readonly name: string | null;
  /** The staged image it came from (server staging), when the job's record names it. */
  readonly stagedId: string | null;
  /**
   * Where it came from: an asset the job moved (its folder, name and hidden flag before), or the bridge's own staging
   * (the job made the asset in its folder: it goes back to the project's staging folder in LegendKeeper, hidden).
   */
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
}

export interface NotRevertible extends Common {
  readonly kind: 'none';
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
const BLOCK_ROW_OPS = new Set([
  'createBlockRow',
  'updateBlockRow',
  'deleteBlockRow',
  'createBlockProperty',
  'updateBlockProperty',
  'deleteBlockProperty',
  'createBlockPropertyRow',
  'updateBlockPropertyRow',
  'deleteBlockPropertyRow',
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

const CREATIONS: Readonly<Record<string, string>> = {
  createResource: 'a page created',
  createResourceFromTemplate: 'a page created',
  createManyResources: 'pages created',
  saveResourceAsTemplate: 'a template saved',
  createDocument: 'a document created',
  createLane: 'a timeline lane created',
  createEvent: 'a timeline event created',
  createFeature: 'a map feature created',
  createProperty: 'a sidebar property created',
  createBoardShapes: 'board shapes created',
  createCalendar: 'a calendar created',
  restoreResource: 'a deleted page restored',
  restoreDocument: 'a deleted document restored',
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
    for (const c of Array.isArray(checks) ? checks : []) if (isObj(c)) out.push(c);
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
      before: typeof r.previous === 'string' ? r.previous : '',
      after: r.date,
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
      ...(lmr ? { lmr: { rowId: lmr.rowId, key: lmr.rowKey, before: lmr.before, after: lmr.after } } : {}),
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
    const lastBody = bodyOf(ss[ss.length - 1]!.params);
    const parentLeft = lastBody.parentId === undefined ? parentBefore : (str(lastBody.parentId) ?? null);
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
      left: { parentId: parentLeft },
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
      targets.push({
        key: `image:${assetId}`,
        kind: 'image',
        page: null,
        what: `image “${str(b.name) ?? assetId}”`,
        steps: [s.stepNo],
        ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
        assetId,
        name: str(b.name) ?? null,
        stagedId: str(op.stagedId) ?? null,
        from: { kind: 'created' },
        left: {
          folderId: str(b.folderId) ?? str(r.folderId) ?? null,
          name: str(b.name) ?? null,
          isHidden: false,
        },
        foldersMade: madeFolders,
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
      targets.push({
        key: `image:${assetId}`,
        kind: 'image',
        page: null,
        what: `asset “${str(b.name) ?? from.name ?? assetId}”`,
        steps: [s.stepNo],
        ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
        assetId,
        name: str(b.name) ?? from.name,
        stagedId: null,
        from,
        left: {
          folderId: b.folderId === undefined ? from.folderId : (str(b.folderId) ?? null),
          name: str(b.name) ?? from.name,
          isHidden: b.isHidden === undefined ? from.isHidden : b.isHidden === true,
        },
        foldersMade: madeFolders,
      });
    }
  }
  for (const s of folders) handled.add(s.stepNo); // part of the image's placement (they stay)
  for (const s of writes) if (s.opId === 'createImageUpload') handled.add(s.stepNo); // no change in LegendKeeper

  // 7. Everything else the job wrote: not reverted, and why.
  for (const s of writes) {
    if (handled.has(s.stepNo)) continue;
    const rid = s.params.path?.resourceId ?? null;
    const journal = entriesOf(s.stepNo).map((e) => e.id);
    const del = DELETIONS[s.opId];
    const common = {
      key: `none:${s.stepNo}`,
      kind: 'none' as const,
      page: page(rid ?? (PAGE_CREATES.has(s.opId) ? str(bodyOf(s.params).id) : undefined)),
      steps: [s.stepNo],
      ...(wrote(s) === 'maybe' ? { uncertain: true } : {}),
      journal,
    };
    if (del) {
      targets.push({
        ...common,
        what: del.what,
        reason: `${del.what}: a deletion is never reverted${del.instead ? `; use ${del.instead}` : ''}`,
        deletion: true,
        ...(del.instead ? { instead: del.instead } : {}),
      });
      continue;
    }
    const made = CREATIONS[s.opId];
    if (made || (rid && created.has(rid))) {
      targets.push({
        ...common,
        what: made ?? 'a page the job created',
        reason: `${made ?? 'part of a page the job created'}: Revert does not delete what a job made (delete it yourself if it should go)`,
        creation: true,
      });
      continue;
    }
    const why =
      s.opId === 'deleteBlock' || s.opId === 'moveBlock'
        ? 'a block deleted or moved through the low-level tools (the journal keeps the block; put it back by hand)'
        : ROW_OPS.has(s.opId)
          ? 'a sidebar row written through the low-level tools (only set_facts records the sidebar as it was)'
          : BLOCK_ROW_OPS.has(s.opId)
            ? 'a row of a block written through the low-level tools'
            : TEXT_DOC_OPS.has(s.opId)
              ? 'a page text write whose page before the job is not recorded'
              : `${s.opId}: not one of the kinds Revert puts back (page text, sidebar facts and links, chronology rows and events, names, tags, aliases, moves, image placements)`;
    targets.push({ ...common, what: s.opId, reason: why });
  }

  return targets.sort((a, b) => (a.steps[0] ?? 0) - (b.steps[0] ?? 0));
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
  const tool = record.tool;
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
  // A delete with no creation of its replacement in the same change is a deletion (never reverted). A delete paired with
  // one (an event whose end was removed is made again; a row and event moved to another age) is an edit of its shape.
  const count = (k: TargetWrite['kind']) => record.target.writes.filter((w) => w.kind === k).length;
  if (count('event.delete') > count('event.create') || count('row.delete') > count('row.insert')) {
    const del = record.target.writes.find((w) => w.kind === 'row.delete' || w.kind === 'event.delete')!;
    return refuse(
      `a chronology change that deleted a ${del.kind === 'row.delete' ? 'table row' : 'timeline event'} (${tool}): a deletion is never reverted`,
      true,
    );
  }
  const inverse: TargetWrite[] = [];
  const oldRows: Record<string, Obj> = {};
  const oldEvents: Record<string, Obj> = {};
  for (const w of record.target.writes) {
    switch (w.kind) {
      case 'row.delete': {
        // The row moved to another age: it comes back where it was, as it was (its block, kept by the delete).
        const step = mine.find((s) => s.opId === 'deleteBlock' && s.params.path?.blockId === w.rowId);
        const old = step ? preOf(step.stepNo) : null;
        if (!isObj(old))
          return refuse(`the table row ${w.rowId} as it was before the change is not in the journal`);
        const block = withoutVersions([old])[0]!;
        oldRows[w.rowId] = block;
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
        const step = mine.find((s) => s.opId === 'replaceBlock' && s.params.path?.blockId === w.rowId);
        const old = step ? preOf(step.stepNo) : null;
        if (!isObj(old))
          return refuse(`the table row ${w.rowId} as it was before the change is not in the journal`);
        const block = withoutVersions([old])[0]!;
        oldRows[w.rowId] = block;
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
  return { target: { ...base, kind: 'chronology', record, inverse, oldRows, oldEvents }, steps };
}
