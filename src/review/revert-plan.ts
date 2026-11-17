/**
 * Revert, target by target (v3 F3.4, ADR 0055 decision B). For each target of a finished direct-write job
 * (src/review/targets.ts): read it live, compare it with the state the job left (by content), and plan the steps that
 * put it back to the state before the job. The steps of every target that is ready become ONE job (src/review/revert.ts):
 * each part starts with its own check inside the job's locks (the target must still be exactly as read here; nothing
 * is written otherwise), chains its If-Match from that check, and ends with its own verify.
 *
 * - page text: block by block (`planBlockwise`, the undo's route), from the page as the job left it to the page before;
 *   written back whole only when its blocks were moved (which block-by-block writes cannot do);
 * - a single block (the low-level tools): deleted again when the job added it, its old content back otherwise;
 * - sidebar facts and link collections: planned by set_facts' own planner from the sidebar now to the sidebar before
 *   (the same check, chained writes and verify as set_facts), the Last Major Revision row the job set included;
 * - a Last Major Revision row alone: its value before;
 * - a page's name, tags, aliases and icon: their values before; a move: back under the old parent, at its old place
 *   among its siblings (by rank);
 * - an image the job placed: moved back to where it came from (a staged asset back to its folder and hidden; an asset
 *   the job made from a staged image into the project's staging folder, hidden). Never deleted.
 */
import { planFacts, FactsPlanError, type FactRequest, type LinkRequest } from '../facts/plan.js';
import { expandFacts } from '../facts/expand.js';
import { sidebarFrom } from '../facts/sidebar.js';
import { EXPECT_STEP, VERIFY_STEP } from '../jobs/internal-steps.js';
import {
  collectionState,
  normaliseContent,
  rowsState,
  stableJson,
  stateHash,
  type CollectionState,
  type RowState,
} from '../jobs/sidebar-state.js';
import type { OpParams, StepSpec } from '../jobs/types.js';
import { compareStoredBlocks } from '../jobs/verify-blocks.js';
import { BLOCKWISE_CHECK, blocksHash, planBlockwise, withoutVersions } from '../pages/blockwise.js';
import { blockwiseJob, validateBlockOp } from '../pages/blockwise-job.js';
import type {
  BlockTarget,
  FactsTarget,
  ImageTarget,
  LmrTarget,
  MoveTarget,
  PageRef,
  ResourceTarget,
  Target,
  TextTarget,
} from './targets.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The tool name a revert's job and journal entries carry. */
export const REVERT_TOOL = 'job.revert';
/** The registered asynchronous check of a revert's page and asset targets (inside the job's locks). */
export const REVERT_CHECKER = 'review.revert';
/** The registered document check of a revert's single blocks (gives the document's version for If-Match). */
export const REVERT_BLOCKS_CHECKER = 'review.revert.blocks';

export type TargetState = 'ready' | 'changed' | 'gone' | 'not_revertible' | 'nothing_to_do';

export interface Difference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** What Revert found for one target, for the owner. */
export interface TargetCheck {
  readonly key: string;
  readonly kind: Target['kind'];
  readonly page: PageRef | null;
  readonly what: string;
  readonly state: TargetState;
  /** In words: what will be written back, or why not. */
  readonly detail: string;
  /** What changed since the job (state `changed`): the job left `expected`, the target holds `actual`. */
  readonly differences?: readonly Difference[];
  readonly deletion?: boolean;
  readonly instead?: string | null;
  readonly journal?: readonly number[];
}

/** A target's part of the revert job, with step numbers from 1 (shifted when the parts are joined). */
export interface TargetPlan {
  readonly check: TargetCheck;
  readonly steps?: readonly StepSpec[];
  readonly resources?: readonly string[];
  readonly documents?: readonly string[];
  readonly assets?: readonly string[];
  /** Bridge-side follow-up once the job succeeded (an image's record back on the Staging page). */
  readonly image?: {
    readonly assetId: string;
    readonly stagedId: string | null;
    readonly folderStep: number | null;
  };
}

/** The reads a plan makes (system principal, P1; a 404 is `exists: false`). */
export interface PlanIo {
  readonly jobId: string;
  read(op: string, params: OpParams): Promise<{ readonly exists: boolean; readonly body: unknown }>;
  /** The project's staging folder name in the asset library (`LK-Bridge staging` by default). */
  readonly stagingFolder: string;
}

const base = (t: Target) => ({ key: t.key, kind: t.kind, page: t.page, what: t.what });
const journalOp = (io: PlanIo, t: Target, extra: Obj = {}) => ({
  tool: REVERT_TOOL,
  revertOf: io.jobId,
  target: t.key,
  ...(t.page ? { page: t.page } : {}),
  ...extra,
});

export const nothing = (t: Target, detail: string): TargetPlan => ({
  check: { ...base(t), state: 'nothing_to_do', detail },
});
export const gone = (t: Target, detail: string): TargetPlan => ({
  check: { ...base(t), state: 'gone', detail },
});
export const changed = (t: Target, detail: string, differences: readonly Difference[]): TargetPlan => ({
  check: { ...base(t), state: 'changed', detail, differences: differences.slice(0, 10) },
});
export const notRevertible = (t: Target, detail: string, extra: Partial<TargetCheck> = {}): TargetPlan => ({
  check: { ...base(t), state: 'not_revertible', detail, ...extra },
});
const ready = (
  t: Target,
  detail: string,
  steps: readonly StepSpec[],
  holds: Pick<TargetPlan, 'resources' | 'documents' | 'assets' | 'image'> = {},
): TargetPlan => ({ check: { ...base(t), state: 'ready', detail }, steps, ...holds });

// ------------------------------------------------------------------------------------------------ page text

export async function planText(t: TextTarget, io: PlanIo): Promise<TargetPlan> {
  const r = await io.read('getDocumentBlocks', {
    path: { resourceId: t.resourceId, documentId: t.documentId },
  });
  if (!r.exists) return gone(t, 'the document is gone');
  const body = (r.body ?? {}) as { blocks?: unknown };
  const live = withoutVersions(Array.isArray(body.blocks) ? (body.blocks as unknown[]) : []);
  if (blocksHash(live) === blocksHash(t.before))
    return nothing(t, 'the page text is already as it was before the job');
  if (!t.left.some((l) => compareStoredBlocks(l, live).ok)) {
    const c = compareStoredBlocks(t.left[t.left.length - 1] ?? [], live, 5);
    return changed(
      t,
      'the page text has changed since the job (an outside edit is never overwritten)',
      c.differences.map((d) => ({ path: d.path, expected: d.expected, actual: d.actual })),
    );
  }
  const journalOperation = journalOp(io, t);
  const plan = planBlockwise(live, t.before, {
    validate: (op) => validateBlockOp(t.resourceId, t.documentId, op),
  });
  const holds = { resources: [t.resourceId], documents: [t.documentId] };
  if (plan.ok) {
    if (plan.empty) return nothing(t, 'nothing to write back');
    const { steps } = blockwiseJob({
      resourceId: t.resourceId,
      documentId: t.documentId,
      before: live,
      after: t.before,
      ops: plan.ops,
      journalOperation,
      undoOf: io.jobId,
    });
    return ready(
      t,
      `${plan.ops.length} block write${plan.ops.length === 1 ? '' : 's'}, block by block`,
      steps,
      holds,
    );
  }
  if (
    plan.refusal.reason === 'moved' ||
    plan.refusal.reason === 'ids' ||
    plan.refusal.reason === 'too_many'
  ) {
    // Blocks the job moved cannot be put back block by block: the page is written back whole, checked first.
    const steps: StepSpec[] = [
      {
        op: EXPECT_STEP,
        params: {
          body: {
            checks: [
              {
                label: 'document',
                kind: 'document',
                resourceId: t.resourceId,
                documentId: t.documentId,
                checker: BLOCKWISE_CHECK,
                input: { hash: blocksHash(live), before: live, undoOf: io.jobId },
              },
            ],
          },
        },
      },
      {
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: t.resourceId, documentId: t.documentId },
          body: { blocks: [...t.before] },
        },
        ifMatchFrom: { step: 1, key: 'document' },
        verifyAfterWrite: true,
        journalOperation: { ...journalOperation, whole: true },
      },
    ];
    return ready(
      t,
      'the page written back whole (the job moved blocks, which cannot be put back one by one)',
      steps,
      holds,
    );
  }
  return notRevertible(t, `the page text cannot be written back: ${plan.refusal.message}`);
}

// ------------------------------------------------------------------------------------------------ single blocks

function findBlock(blocks: readonly unknown[], id: string): Obj | null {
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.id === id) return b;
    if (Array.isArray(b.children)) {
      const f = findBlock(b.children as unknown[], id);
      if (f) return f;
    }
  }
  return null;
}

const sameBlock = (a: Obj, b: Obj) => compareStoredBlocks([a], [b]).ok;

/** The single blocks of one document, together (one check gives the version every write chains from). */
export async function planBlocks(ts: readonly BlockTarget[], io: PlanIo): Promise<TargetPlan[]> {
  const t0 = ts[0]!;
  const r = await io.read('getDocumentBlocks', {
    path: { resourceId: t0.resourceId, documentId: t0.documentId },
  });
  if (!r.exists) return ts.map((t) => gone(t, 'the document is gone'));
  const blocks = ((r.body ?? {}) as { blocks?: unknown }).blocks;
  const live = Array.isArray(blocks) ? (blocks as unknown[]) : [];
  const out: TargetPlan[] = [];
  const readyOnes: { t: BlockTarget; left: Obj }[] = [];
  for (const t of ts) {
    const found = findBlock(live, t.blockId);
    const left =
      t.change === 'updated' && t.before
        ? ({ ...t.before, ...t.sent, id: t.blockId } as Obj)
        : ({ ...t.sent, id: t.blockId } as Obj);
    if (t.change === 'inserted') {
      if (!found) out.push(nothing(t, 'the block the job added is already gone'));
      else if (sameBlock(left, withoutVersions([found])[0]!)) readyOnes.push({ t, left });
      else
        out.push(
          changed(t, 'the block the job added has changed since', [
            { path: t.blockId, expected: left, actual: found },
          ]),
        );
      continue;
    }
    if (!found) {
      out.push(gone(t, 'the block is gone'));
      continue;
    }
    const now = withoutVersions([found])[0]!;
    if (t.before && sameBlock(t.before, now))
      out.push(nothing(t, 'the block is already as it was before the job'));
    else if (sameBlock(left, now)) readyOnes.push({ t, left });
    else
      out.push(
        changed(t, 'the block has changed since the job', [{ path: t.blockId, expected: left, actual: now }]),
      );
  }
  if (readyOnes.length === 0) return out;
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: 'blocks',
              kind: 'document',
              resourceId: t0.resourceId,
              documentId: t0.documentId,
              checker: REVERT_BLOCKS_CHECKER,
              input: { blocks: readyOnes.map((x) => ({ id: x.t.blockId, expect: x.left })) },
            },
          ],
        },
      },
    },
  ];
  const verify: Obj[] = [];
  readyOnes.forEach((x, i) => {
    const path = { resourceId: t0.resourceId, documentId: t0.documentId, blockId: x.t.blockId };
    steps.push({
      op: x.t.change === 'inserted' ? 'deleteBlock' : 'replaceBlock',
      params: x.t.change === 'inserted' ? { path } : { path, body: { ...x.t.before! } },
      ifMatchFrom: i === 0 ? { step: 1, key: 'blocks' } : { step: steps.length },
      judgedInLock: true,
      journalOperation: journalOp(io, x.t),
    });
    verify.push({
      kind: 'block',
      label: `block ${x.t.blockId}`,
      resourceId: t0.resourceId,
      documentId: t0.documentId,
      blockId: x.t.blockId,
      present: x.t.change !== 'inserted',
    });
  });
  steps.push({ op: VERIFY_STEP, params: { body: { targets: verify } } });
  // The steps belong to the first ready target; the others share them (one check, one chain).
  readyOnes.forEach((x, i) =>
    out.push(
      i === 0
        ? ready(
            x.t,
            x.t.change === 'inserted' ? 'the block the job added, deleted' : 'the block’s content before',
            steps,
            {
              resources: [t0.resourceId],
              documents: [t0.documentId],
            },
          )
        : {
            check: {
              ...base(x.t),
              state: 'ready',
              detail:
                x.t.change === 'inserted' ? 'the block the job added, deleted' : 'the block’s content before',
            },
          },
    ),
  );
  return out;
}

// ------------------------------------------------------------------------------------------------ sidebar

const keyOf = (k: string) => k.normalize('NFKC').trim().toLowerCase();
const content = (r: RowState) => stableJson(normaliseContent(r.content));

/** Rows by id, else by key; the differences between what is expected and what is there. */
function rowDiffs(label: string, expected: readonly RowState[], actual: readonly RowState[]): Difference[] {
  const out: Difference[] = [];
  const match = (r: RowState, list: readonly RowState[]) =>
    (r.id !== null ? list.find((x) => x.id === r.id) : undefined) ??
    list.find((x) => (x.id === null || r.id === null ? keyOf(x.key) === keyOf(r.key) : false)) ??
    list.find((x) => keyOf(x.key) === keyOf(r.key));
  for (const e of expected) {
    const a = match(e, actual);
    if (!a) out.push({ path: `${label} ${e.key}`, expected: e.content, actual: '(no such row)' });
    else if (content(a) !== content(e) || keyOf(a.key) !== keyOf(e.key))
      out.push({ path: `${label} ${e.key}`, expected: e.content, actual: a.content });
  }
  for (const a of actual)
    if (!match(a, expected))
      out.push({ path: `${label} ${a.key}`, expected: '(no such row)', actual: a.content });
  return out;
}

const itemKey = (i: { resourceId: string; documentId: string | null }) =>
  `${i.resourceId}/${i.documentId ?? ''}`;
const sameItems = (a: CollectionState, b: CollectionState) =>
  a.items.map(itemKey).join(',') === b.items.map(itemKey).join(',');

/** A page's facts and link collections, planned by set_facts' own planner back to the state before. */
export async function planFactsTarget(t: FactsTarget, io: PlanIo): Promise<TargetPlan> {
  const r = await io.read('listProperties', { path: { resourceId: t.resourceId } });
  if (!r.exists) return gone(t, 'the page is gone');
  const sidebar = sidebarFrom(r.body);
  const kv = t.property ? sidebar.find((p) => p.id === t.property!.id) : undefined;
  if (t.property && !kv) return gone(t, `the sidebar property “${t.property.title}” is gone`);
  const liveRows = kv
    ? rowsState(
        (kv.rows ?? []).map((x) => ({ id: x.id, rank: x.rank ?? null, key: x.key, content: x.content })),
      )
    : [];
  const diffsLeft: Difference[] = [];
  const diffsBefore: Difference[] = [];
  if (t.rowsLeft && t.rowsBefore) {
    diffsLeft.push(...rowDiffs(t.property?.title ?? 'facts', t.rowsLeft, liveRows));
    diffsBefore.push(...rowDiffs(t.property?.title ?? 'facts', t.rowsBefore, liveRows));
  }
  const colls = t.collections.map((c) => {
    const p = sidebar.find((x) => x.id === c.propertyId);
    return { c, live: p ? collectionState(p.raw) : null };
  });
  for (const { c, live } of colls) {
    if (!live) {
      diffsLeft.push({ path: c.title, expected: 'present', actual: '(gone)' });
      diffsBefore.push({ path: c.title, expected: 'present', actual: '(gone)' });
      continue;
    }
    if (!sameItems(c.left, live))
      diffsLeft.push({ path: c.title, expected: c.left.items.map(itemKey), actual: live.items.map(itemKey) });
    if (!sameItems(c.before, live))
      diffsBefore.push({
        path: c.title,
        expected: c.before.items.map(itemKey),
        actual: live.items.map(itemKey),
      });
  }
  if (diffsBefore.length === 0) return nothing(t, 'the sidebar is already as it was before the job');
  if (diffsLeft.length > 0)
    return changed(
      t,
      'the sidebar has changed since the job (an outside edit is never overwritten)',
      diffsLeft,
    );

  // From the sidebar now (as the job left it) back to the sidebar before.
  const facts: FactRequest[] = [];
  if (t.rowsBefore) {
    const match = (r: RowState, list: readonly RowState[]) =>
      (r.id !== null ? list.find((x) => x.id === r.id) : undefined) ??
      list.find((x) => keyOf(x.key) === keyOf(r.key));
    for (const b of t.rowsBefore) {
      const now = match(b, liveRows);
      if (!now || content(now) !== content(b)) facts.push({ key: now?.key ?? b.key, value: [...b.content] });
    }
    for (const now of liveRows) if (!match(now, t.rowsBefore)) facts.push({ key: now.key, value: null });
  }
  const links: LinkRequest[] = colls
    .filter((x) => x.live)
    .map(({ c, live }) => {
      const had = new Set(c.before.items.map(itemKey));
      const has = new Set(live!.items.map(itemKey));
      const target = (i: { resourceId: string; documentId: string | null }) => ({
        resourceId: i.resourceId,
        ...(i.documentId ? { documentId: i.documentId } : {}),
        name: i.resourceId,
      });
      return {
        title: c.title,
        add: c.before.items.filter((i) => !has.has(itemKey(i))).map(target),
        remove: live!.items.filter((i) => !had.has(itemKey(i))).map(target),
      };
    })
    .filter((l) => l.add.length > 0 || l.remove.length > 0);
  let plan;
  try {
    plan = planFacts({
      resourceId: t.resourceId,
      sidebar,
      propertyTitle: t.property?.title ?? sidebar.find((p) => p.kind === 'keyValue')?.title ?? 'PROPERTIES',
      facts,
      links,
      templateKeys: t.rowsBefore ? t.rowsBefore.map((x) => x.key) : null,
    });
  } catch (e) {
    if (e instanceof FactsPlanError)
      return notRevertible(t, `the sidebar cannot be planned back: ${e.message}`);
    throw e;
  }
  if (plan.empty) return nothing(t, 'nothing to write back');
  const job = expandFacts(plan, { id: t.resourceId, name: t.page?.name ?? t.resourceId }, sidebar, {
    facts: { revertOf: io.jobId },
    links: {},
  });
  const steps = job.steps.map((s) =>
    s.journalOperation ? { ...s, journalOperation: { ...s.journalOperation, ...journalOp(io, t) } } : s,
  );
  return ready(t, job.summary.replace(/^set_facts on /, ''), steps, { resources: [t.resourceId] });
}

/** A Last Major Revision row the job set, alone: its value before. */
export async function planLmr(t: LmrTarget, io: PlanIo): Promise<TargetPlan> {
  const r = await io.read('listPropertyRows', {
    path: { resourceId: t.resourceId, propertyId: t.propertyId },
  });
  if (!r.exists) return gone(t, 'the sidebar property is gone');
  const rows = rowsState((r.body as { data?: unknown } | undefined)?.data);
  const row = rows.find((x) => x.id === t.rowId);
  if (!row) return gone(t, `the ${t.rowKey} row is gone`);
  const text = row.content
    .map((x) => (typeof x.text === 'string' ? x.text : ''))
    .join('')
    .trim();
  if (text === t.before.trim()) return nothing(t, `${t.rowKey} already says “${t.before}”`);
  if (text !== t.after.trim())
    return changed(t, `${t.rowKey} has changed since the job`, [
      { path: t.rowKey, expected: t.after, actual: text },
    ]);
  const after = rows.map((x) =>
    x.id === t.rowId ? { ...x, content: t.before === '' ? [] : [{ text: t.before }] } : x,
  );
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            { label: 'rows', kind: 'propertyRows', resourceId: t.resourceId, propertyId: t.propertyId, rows },
          ],
        },
      },
    },
    {
      op: 'updatePropertyRow',
      params: {
        path: { resourceId: t.resourceId, propertyId: t.propertyId, rowId: t.rowId },
        body: { content: t.before === '' ? null : [{ text: t.before }] },
      },
      ifMatchFrom: { step: 1, key: 'rows' },
      deferTreeReread: true,
      journalOperation: journalOp(io, t, { write: `${t.rowKey}: ${t.before || '(empty)'}` }),
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'sidebar',
              label: t.page?.name ?? t.resourceId,
              resourceId: t.resourceId,
              properties: [{ id: t.propertyId, title: t.rowKey, rows: after }],
            },
          ],
        },
      },
    },
  ];
  return ready(t, `${t.rowKey} back to “${t.before || '(empty)'}”`, steps, { resources: [t.resourceId] });
}

// ------------------------------------------------------------------------------------------------ page fields

const fieldEq = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);

export function resourceDiffs(fields: Readonly<Record<string, unknown>>, live: Obj): Difference[] {
  return Object.entries(fields)
    .filter(([k, v]) => !fieldEq(v, live[k]))
    .map(([k, v]) => ({ path: k, expected: v ?? null, actual: live[k] ?? null }));
}

export async function planResource(t: ResourceTarget, io: PlanIo): Promise<TargetPlan> {
  const r = await io.read('getResource', { path: { resourceId: t.resourceId } });
  const live = isObj(r.body) ? r.body : {};
  if (!r.exists || typeof live.deletedAt === 'string') return gone(t, 'the page is gone');
  if (resourceDiffs(t.before, live).length === 0)
    return nothing(t, 'the page is already as it was before the job');
  const d = resourceDiffs(t.left, live);
  if (d.length > 0)
    return changed(t, 'the page has changed since the job (an outside edit is never overwritten)', d);
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: 'page',
              kind: 'registered',
              checker: REVERT_CHECKER,
              resourceId: t.resourceId,
              input: { kind: 'resource', resourceId: t.resourceId, fields: t.left },
            },
          ],
        },
      },
    },
    {
      op: 'updateResource',
      params: { path: { resourceId: t.resourceId }, body: { ...t.before } },
      expectCurrent: {
        state: 'resource',
        hash: stateHash({ name: live.name ?? null, tags: Array.isArray(live.tags) ? live.tags : [] }),
        label: 'the page',
      },
      deferTreeReread: true,
      journalOperation: journalOp(io, t),
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'resource',
              label: t.page?.name ?? t.resourceId,
              resourceId: t.resourceId,
              fields: { ...t.before },
            },
          ],
        },
      },
    },
  ];
  return ready(
    t,
    Object.entries(t.before)
      .map(([k, v]) => `${k} back to ${JSON.stringify(v)}`)
      .join('; '),
    steps,
    { resources: [t.resourceId] },
  );
}

/** Where the page stood among its old siblings: after the one ranked just before it (else before the first). */
async function anchorFor(
  io: PlanIo,
  pageId: string,
  parentId: string | null,
  rank: string | null,
): Promise<{ after?: string; before?: string }> {
  if (parentId === null || rank === null) return {};
  const siblings: { id: string; rank: string }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await io.read('listResources', {
      query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) },
    });
    const b = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
    for (const x of Array.isArray(b.data) ? (b.data as Obj[]) : [])
      if (typeof x.id === 'string' && x.id !== pageId && typeof x.rank === 'string')
        siblings.push({ id: x.id, rank: x.rank });
    if (b.hasMore !== true || typeof b.nextCursor !== 'string') break;
    cursor = b.nextCursor;
  }
  siblings.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const prev = [...siblings].reverse().find((s) => s.rank < rank);
  if (prev) return { after: prev.id };
  const next = siblings.find((s) => s.rank > rank);
  return next ? { before: next.id } : {};
}

export async function planMove(t: MoveTarget, io: PlanIo): Promise<TargetPlan> {
  const r = await io.read('getResource', { path: { resourceId: t.resourceId } });
  const live = isObj(r.body) ? r.body : {};
  if (!r.exists || typeof live.deletedAt === 'string') return gone(t, 'the page is gone');
  const parent = str(live.parentId) ?? null;
  const rank = str(live.rank) ?? null;
  if (parent === t.before.parentId && rank === t.before.rank)
    return nothing(t, 'the page is already where it was');
  if (parent !== t.left.parentId)
    return changed(t, 'the page has been moved since the job', [
      { path: 'parent', expected: t.left.parentId, actual: parent },
    ]);
  const anchor = await anchorFor(io, t.resourceId, t.before.parentId, t.before.rank);
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [{ label: 'place', kind: 'resource', resourceId: t.resourceId, parentId: t.left.parentId }],
        },
      },
    },
    {
      op: 'moveResource',
      params: { path: { resourceId: t.resourceId }, body: { parentId: t.before.parentId, ...anchor } },
      deferTreeReread: true,
      journalOperation: journalOp(io, t),
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'resource',
              label: t.page?.name ?? t.resourceId,
              resourceId: t.resourceId,
              fields: {},
              ...(t.before.parentId !== null
                ? { placement: { parentId: t.before.parentId, ...anchor } }
                : {}),
            },
          ],
        },
      },
    },
  ];
  const holds = [
    t.resourceId,
    ...(t.before.parentId ? [t.before.parentId] : []),
    ...(t.left.parentId ? [t.left.parentId] : []),
  ];
  return ready(t, 'back under its old parent, at its old place', steps, { resources: [...new Set(holds)] });
}

// ------------------------------------------------------------------------------------------------ images

export async function planImage(t: ImageTarget, io: PlanIo): Promise<TargetPlan> {
  const r = await io.read('getAsset', { path: { assetId: t.assetId } });
  const live = isObj(r.body) ? r.body : {};
  if (!r.exists || typeof live.deletedAt === 'string') return gone(t, 'the asset is gone');
  const now = {
    folderId: str(live.folderId) ?? null,
    name: str(live.name) ?? null,
    isHidden: live.isHidden === true,
  };
  if (
    t.from.kind === 'asset' &&
    now.folderId === t.from.folderId &&
    now.isHidden === t.from.isHidden &&
    now.name === t.from.name
  )
    return nothing(t, 'the asset is already where it came from');
  const d: Difference[] = [];
  if (now.folderId !== t.left.folderId)
    d.push({ path: 'folder', expected: t.left.folderId, actual: now.folderId });
  if (now.isHidden !== t.left.isHidden)
    d.push({ path: 'hidden', expected: t.left.isHidden, actual: now.isHidden });
  if (t.left.name !== null && now.name !== t.left.name)
    d.push({ path: 'name', expected: t.left.name, actual: now.name });
  if (d.length > 0) return changed(t, 'the asset has changed since the job (moved, renamed or hidden)', d);
  const check: StepSpec = {
    op: EXPECT_STEP,
    params: {
      body: {
        checks: [
          {
            label: 'asset',
            kind: 'registered',
            checker: REVERT_CHECKER,
            input: { kind: 'asset', assetId: t.assetId, fields: t.left },
          },
        ],
      },
    },
  };
  if (t.from.kind === 'asset') {
    const body = {
      folderId: t.from.folderId,
      isHidden: t.from.isHidden,
      ...(t.from.name !== null && t.from.name !== t.left.name ? { name: t.from.name } : {}),
    };
    const steps: StepSpec[] = [
      check,
      {
        op: 'updateAsset',
        params: { path: { assetId: t.assetId }, body },
        journalOperation: journalOp(io, t),
      },
      {
        op: VERIFY_STEP,
        params: { body: { targets: [{ kind: 'asset', label: t.what, assetId: t.assetId, fields: body }] } },
      },
    ];
    return ready(t, 'moved back to where it came from', steps, {
      assets: [t.assetId],
      image: { assetId: t.assetId, stagedId: t.stagedId, folderStep: null },
    });
  }
  // The job made it from an image staged on the bridge: it goes to the staging folder, hidden (never deleted).
  const steps: StepSpec[] = [
    check,
    {
      op: 'createAssetFolder',
      params: { body: { name: io.stagingFolder } },
      findOrCreate: true,
      journalOperation: journalOp(io, t, { write: `folder ${io.stagingFolder}` }),
    },
    {
      op: 'updateAsset',
      params: { path: { assetId: t.assetId }, body: { isHidden: true } },
      bindFrom: { step: 2, to: 'body.folderId' },
      journalOperation: journalOp(io, t, { write: `back to ${io.stagingFolder}, hidden` }),
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'asset',
              label: t.what,
              assetId: t.assetId,
              fields: { isHidden: true },
              folderFrom: { step: 2 },
            },
          ],
        },
      },
    },
  ];
  return ready(
    t,
    `moved to “${io.stagingFolder}”, hidden (the asset is kept; it is back on the Staging page)`,
    steps,
    {
      assets: [t.assetId],
      image: { assetId: t.assetId, stagedId: t.stagedId, folderStep: 2 },
    },
  );
}

// ------------------------------------------------------------------------------------------------ joining the parts

/** The step numbers a step names (`ifMatchFrom`, the bindings, a verify's `inputFrom`…), shifted by `by`. */
export function shiftStep(s: StepSpec, by: number): StepSpec {
  if (by === 0) return s;
  const n = (x: number) => x + by;
  const out: Record<string, unknown> = { ...s };
  if (s.ifMatchFrom) out.ifMatchFrom = { ...s.ifMatchFrom, step: n(s.ifMatchFrom.step) };
  if (s.bindIds) out.bindIds = { step: n(s.bindIds.step) };
  if (s.bindBody) out.bindBody = { ...s.bindBody, step: n(s.bindBody.step) };
  if (s.decisionFrom) out.decisionFrom = { step: n(s.decisionFrom.step) };
  if (s.bindFrom) out.bindFrom = { ...s.bindFrom, step: n(s.bindFrom.step) };
  if (s.bindAssetUrls) out.bindAssetUrls = s.bindAssetUrls.map((b) => ({ ...b, step: n(b.step) }));
  if (s.op === VERIFY_STEP && isObj(s.params?.body) && Array.isArray(s.params.body.targets)) {
    const targets = (s.params.body.targets as Obj[]).map((t) => {
      const o: Obj = { ...t };
      if (isObj(t.inputFrom) && typeof t.inputFrom.step === 'number')
        o.inputFrom = { ...t.inputFrom, step: n(t.inputFrom.step) };
      if (Array.isArray(t.inputFrom))
        o.inputFrom = (t.inputFrom as Obj[]).map((x) => ({ ...x, step: n(Number(x.step)) }));
      if (isObj(t.assetFrom)) o.assetFrom = { step: n(Number(t.assetFrom.step)) };
      if (isObj(t.folderFrom)) o.folderFrom = { step: n(Number(t.folderFrom.step)) };
      return o;
    });
    out.params = { ...s.params, body: { ...s.params.body, targets } };
  }
  return out as unknown as StepSpec;
}
