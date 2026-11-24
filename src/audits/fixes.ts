/**
 * "Propose a fix" and "Re-check now" (v2 E2, ADR 0044): the only two things in the audits that read LegendKeeper, each
 * on the owner's request, each at P1 and each for one finding.
 *
 * **Propose a fix** creates an ordinary proposal through the machinery of an existing tool, with every guard. Nothing is
 * applied: the owner approves it on the Proposals page (and canon, lifecycle and the other guards run as for any write).
 * Before proposing, the target is re-read LIVE and compared with what the finding says; if it has changed the fix is
 * refused as stale (`FIX_STALE`) with what is there now, and nothing is proposed. Four fixes, each exact or absent:
 *
 * - `move_resource`: the page re-placed alphabetically under the SAME parent (`moveResource` with the neighbour from the
 *   live siblings; the parent's children are compared again inside the lock);
 * - `set_facts`: one fact, through the tool's own planner (`planFacts`, `expandFacts`), only where the finding named the
 *   right value (the audit offers none when the value is ambiguous);
 * - `add_tags`: the missing required tags added to the page's tags (`updateResource`, additive; never a removal);
 * - `reorder_tags` (v3 F3d, ADR 0053): the page's own tags in a new order, the lifecycle tag first (`updateResource`;
 *   nothing added, removed or renamed, so the lifecycle guard sees no status tag change);
 * - `split_paragraph`: a paragraph with embedded line breaks split into separate paragraphs block by block
 *   (`insertBlock` for the new parts, each after the one before, then `replaceBlock` cutting the original to its first part: a
 *   refused insert loses nothing), as one proposal whose compare-and-swap is inside the
 *   lock (the block must still hold exactly the runs the finding saw). It never rewrites the whole page, so it works
 *   beside inline icons.
 *
 * D1.1's `sync_timeline_event` fix goes through the chronology module's own "Propose a fix".
 */
import { expandFacts } from '../facts/expand.js';
import { sidebarFrom } from '../facts/index.js';
import { planFacts, FactsPlanError } from '../facts/plan.js';
import { rowTextRuns } from '../facts/values.js';
import { mintClientId } from '../jobs/ids.js';
import { SYSTEM_PRINCIPAL, type JobOrigin, type LifecycleMarker, type StepSpec } from '../jobs/index.js';
import { EXPECT_STEP, VERIFY_STEP, type DocumentChecker, type VerifyTarget } from '../jobs/internal-steps.js';
import { stableJson } from '../jobs/sidebar-state.js';
import { slotAmong, type SiblingCompare } from '../registry/ordering.js';
import { classifyName, nameKey as treeNameKey } from '../tree/classify.js';
import { isKnownRun, runsHashOf, runsText, splitRunsAtBreaks } from './model.js';
import { AuditError } from './errors.js';
import type { Finding, FixKind } from './types.js';
import {
  CORE_TEXT_FILLER,
  coreTextChanges,
  reword,
  type CoreTextInput,
  type WordingRole,
} from '../packs/engine/core.js';
import { shownText, textChange, textChangeWords, type TextChange } from '../jobs/text-change.js';
import type { LkBlock } from '../markdown/index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const SPLIT_CHECK = 'audits.paragraph';
export const SPLIT_VERIFY = 'audits.paragraph.verify';

const ORIGIN: JobOrigin = {
  kind: 'ui',
  client: 'owner',
  tool: 'audits.propose_fix',
  principal: SYSTEM_PRINCIPAL,
};

export interface FixDeps {
  readonly engine: {
    internalRead(projectId: string, op: string, params: Obj, o: { priority: 'P1' }): Promise<unknown>;
    submit(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  readonly now: () => number;
  /**
   * v3 F3c (ADR 0054): who asks, when not the owner on the dashboard: an agent's `arkona_appraisal_fix` hands sibling
   * order and tags over to these fixes, and its proposal is the agent's own (still ONE proposal, whatever its scope).
   */
  readonly origin?: JobOrigin;
  /** v3 F4c (ADR 0065): the order inside Narratives (an ordering fix whose args say `order: 'narrative'`). */
  readonly narrativeOrder?: SiblingCompare | null;
  /**
   * v3 F7.1 (ADR 0072): the `core_upgrade` fix, planned by the packs layer (src/packs/core-fix.ts): the page read live
   * (FIX_STALE when its name changed), then arkona_create_character's upgrade through `engine.submit`.
   */
  readonly coreUpgrade?: CoreUpgrader;
  /**
   * v3 F7.1: the automation's Apply of a code that allows it: the fix submitted as a job (every guard judging it: the
   * canon guard keeps an Authoritative page's rename a canonical proposal) rather than forced into a proposal.
   */
  readonly direct?: boolean;
  /**
   * v3 F6a (ADR 0076): the owner's Reference Type decision as it stands now (null: undone), so a `reference_type` fix is
   * planned only while its mapping holds.
   */
  readonly referenceTypeDecision?: (
    projectId: string,
    id: string,
  ) => { readonly action: string; readonly target: string | null; readonly conflict: string | null } | null;
}

/** v3 F7.1 (ADR 0072): what plans and submits a `core_upgrade` fix. */
export type CoreUpgrader = (
  projectId: string,
  page: { readonly pageId: string; readonly name: string },
  o: {
    readonly origin: JobOrigin;
    readonly engine: FixDeps['engine'];
    readonly direct?: boolean;
  },
) => Promise<FixResult>;

export type FixResult =
  | {
      readonly status: 'proposal_captured';
      readonly proposalId: string;
      readonly summary: string | null;
      readonly fix: FixKind;
    }
  | { readonly status: 'nothing_to_do'; readonly message: string }
  /** v3 F7.1: a fix the automation applied as a job (`direct`): the job's id. */
  | {
      readonly status: 'job_submitted';
      readonly jobId: string;
      readonly summary: string | null;
      readonly fix: FixKind;
    };

export const stale = (what: string, details: Obj = {}): AuditError =>
  new AuditError(
    'FIX_STALE',
    `${what} The finding is out of date; nothing was proposed. Re-check it (or wait for the next audit).`,
    details,
  );

export function read(d: FixDeps, projectId: string, op: string, params: Obj): Promise<unknown> {
  return d.engine.internalRead(projectId, op, params, { priority: 'P1' });
}

export async function propose(
  d: FixDeps,
  projectId: string,
  spec: {
    readonly steps: readonly StepSpec[];
    readonly title: string;
    readonly holdLock?: { readonly resourceId: string };
    readonly holdDocuments?: readonly string[];
    readonly operation: Obj;
    readonly page: { readonly id: string; readonly name: string };
    readonly pageParts: readonly string[];
    readonly prefetched?: readonly Obj[];
    readonly fix: FixKind;
    /** v3 F4c: the lifecycle marker (a narrative page: no lifecycle, `to: null`). */
    readonly lifecycle?: LifecycleMarker;
  },
): Promise<FixResult> {
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: projectId,
    steps: spec.steps,
    onError: 'stop',
    priority: 'P1',
    origin: d.origin ?? ORIGIN,
    title: spec.title.slice(0, 300),
    ...(spec.holdLock ? { holdLock: spec.holdLock } : {}),
    ...(spec.holdDocuments ? { holdDocuments: spec.holdDocuments } : {}),
    internal: true,
    forceProposal: true,
    ...(spec.lifecycle ? { lifecycle: spec.lifecycle } : {}),
    proposal: {
      operation: spec.operation,
      operations: [
        { ...spec.operation, page: spec.page, pageParts: spec.pageParts, summaryLabel: spec.title },
      ],
      summary: spec.title,
      ...(spec.prefetched ? { prefetched: spec.prefetched } : {}),
    },
  });
  if (typeof r.proposalId !== 'string')
    throw new AuditError('NOT_PROPOSED', 'The fix was not captured as a proposal; nothing was done.');
  return {
    status: 'proposal_captured',
    proposalId: r.proposalId,
    summary: typeof r.summary === 'string' ? r.summary : null,
    fix: spec.fix,
  };
}

// ============================================================================================ move_resource

function neighboursAfterInsert(
  siblings: readonly { id: string }[],
  self: string,
  slot: { after?: string; before?: string },
): { after: string | null; before: string | null } {
  const list = siblings.filter((s) => s.id !== self).map((s) => s.id);
  let at = 0;
  if (slot.after) at = list.indexOf(slot.after) + 1;
  else if (slot.before) at = Math.max(0, list.indexOf(slot.before));
  return { after: at > 0 ? list[at - 1]! : null, before: at < list.length ? list[at]! : null };
}

async function listChildren(
  d: FixDeps,
  projectId: string,
  parentId: string,
): Promise<{ id: string; name: string; rank: string | null }[]> {
  const out: { id: string; name: string; rank: string | null }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const r = (await read(d, projectId, 'listResources', {
      query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) },
    })) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
    for (const x of Array.isArray(r?.data) ? (r.data as unknown[]) : [])
      if (isObj(x) && typeof x.id === 'string' && typeof x.name === 'string')
        out.push({ id: x.id, name: x.name, rank: typeof x.rank === 'string' ? x.rank : null });
    if (r?.hasMore !== true || typeof r.nextCursor !== 'string') break;
    cursor = r.nextCursor;
  }
  return out;
}

async function fixMove(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const pageId = String(f.fix!.args.pageId);
  const parentId = String(f.fix!.args.parentId);
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  if (res.parentId !== parentId)
    throw stale(
      `The page is no longer under the parent the audit saw (it is under ${String(res.parentId)}).`,
      {
        parentId: res.parentId,
      },
    );
  const name = String(res.name);
  const { kind, displayName } = classifyName(name);
  const kids = await listChildren(d, projectId, parentId);
  const others = kids.filter((k) => k.id !== pageId).map((k) => ({ id: k.id, ...classifyName(k.name) }));
  // v3 F4c: inside Narratives, the narrative order (E1); never the alphabetical rule there.
  const narrative = f.fix!.args.order === 'narrative';
  if (narrative && !d.narrativeOrder)
    throw stale('The narrative rules are not available now, so the narrative order cannot be worked out.');
  const slot = slotAmong(
    others.map((o) => ({ id: o.id, displayName: o.displayName, kind: o.kind })),
    displayName,
    kind,
    narrative ? d.narrativeOrder! : undefined,
  );
  const cur = kids.findIndex((k) => k.id === pageId);
  const here = {
    after: cur > 0 ? kids[cur - 1]!.id : null,
    before: cur >= 0 && cur < kids.length - 1 ? kids[cur + 1]!.id : null,
  };
  const then = neighboursAfterInsert(kids, pageId, slot);
  if (here.after === then.after && here.before === then.before)
    return {
      status: 'nothing_to_do',
      message: `The page is already in its ${narrative ? 'narrative' : 'alphabetical'} place.`,
    };
  const title = `Re-place ${name} ${narrative ? 'in narrative order' : 'alphabetically'} under its parent`;
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            { label: 'siblings', kind: 'children', resourceId: parentId, ids: kids.map((k) => k.id) },
            { label: 'page', kind: 'resource', resourceId: pageId, name, parentId },
          ],
        },
      },
    },
    {
      op: 'moveResource',
      params: { path: { resourceId: pageId }, body: { parentId, ...slot } },
      journalOperation: { tool: 'move_resource', page: { id: pageId, name }, from: 'audits.propose_fix' },
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'resource',
              label: name,
              resourceId: pageId,
              fields: { parentId },
              placement: { parentId, after: then.after, before: then.before },
            } satisfies VerifyTarget,
          ],
        },
      },
    },
  ];
  return propose(d, projectId, {
    steps,
    title,
    holdLock: { resourceId: pageId },
    operation: { tool: 'move_resource', fromAudit: f.code, place: then },
    page: { id: pageId, name },
    pageParts: ['re-placed alphabetically'],
    fix: 'move_resource',
  });
}

// ============================================================================================ set_facts

async function fixFacts(
  d: FixDeps,
  projectId: string,
  f: Finding,
  propertiesName: string,
): Promise<FixResult> {
  const pageId = String(f.fix!.args.pageId);
  const facts = f.fix!.args.facts as Record<string, string>;
  const expected = f.fix!.args.expectedCurrent as Record<string, string>;
  const [key, value] = Object.entries(facts)[0]!;
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const path = { resourceId: pageId };
  const body = await read(d, projectId, 'listProperties', { path });
  const sidebar = sidebarFrom(body);
  const kv = sidebar.filter(
    (p) => p.kind === 'keyValue' && p.title.trim().toLowerCase() === propertiesName.trim().toLowerCase(),
  );
  if (kv.length !== 1) throw stale(`The page does not have exactly one “${propertiesName}” property now.`);
  const rows = (kv[0]!.rows ?? []).filter((r) => r.key.trim().toLowerCase() === key.trim().toLowerCase());
  if (rows.length !== 1)
    throw stale(`The row “${key}” is not there exactly once now.`, { rows: rows.length });
  const live = runsText(rows[0]!.content);
  if (live.trim() !== (expected[key] ?? '').trim())
    throw stale(`“${key}” is now “${live}”, not “${expected[key]}”.`, { found: live });
  const name = String(res.name);
  let plan;
  try {
    plan = planFacts({
      resourceId: pageId,
      sidebar,
      propertyTitle: kv[0]!.title,
      facts: [{ key, value: rowTextRuns(value) }],
      links: [],
      templateKeys: null,
    });
  } catch (e) {
    if (e instanceof FactsPlanError) throw new AuditError(e.code, e.message, e.details);
    throw e;
  }
  if (plan.empty) return { status: 'nothing_to_do', message: `“${key}” already holds “${value}”.` };
  const job = expandFacts(plan, { id: pageId, name }, sidebar, { facts: facts, links: {} });
  return propose(d, projectId, {
    steps: job.steps,
    title: job.summary,
    holdLock: { resourceId: pageId },
    operation: { ...job.operation, fromAudit: f.code },
    page: { id: pageId, name },
    pageParts: ['sidebar', `${key}: changed`],
    prefetched: [{ op: 'listProperties', path, body }],
    fix: 'set_facts',
  });
}

// ============================================================================================ add_tags

async function fixTags(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const pageId = String(f.fix!.args.pageId);
  const add = (f.fix!.args.add as string[]).filter((t) => typeof t === 'string' && t.trim() !== '');
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const live = Array.isArray(res.tags)
    ? (res.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const have = new Set(live.map((t) => treeNameKey(t.trim())));
  const missing = add.filter((t) => !have.has(treeNameKey(t.trim())));
  if (missing.length === 0)
    return { status: 'nothing_to_do', message: 'The page already carries those tags.' };
  const name = String(res.name);
  const tags = [...live, ...missing];
  const title = `Add the tag${missing.length > 1 ? 's' : ''} ${missing.join(', ')} to ${name}`;
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: { checks: [{ label: 'page', kind: 'resource', resourceId: pageId, name, tags: live }] },
      },
    },
    {
      op: 'updateResource',
      params: { path: { resourceId: pageId }, body: { tags } },
      journalOperation: { tool: 'update_resource', page: { id: pageId, name }, from: 'audits.propose_fix' },
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            { kind: 'resource', label: name, resourceId: pageId, fields: { tags } } satisfies VerifyTarget,
          ],
        },
      },
    },
  ];
  return propose(d, projectId, {
    steps,
    title,
    holdLock: { resourceId: pageId },
    operation: { tool: 'update_resource', fromAudit: f.code, changes: { tags: { add: missing } } },
    page: { id: pageId, name },
    pageParts: ['tags'],
    fix: 'add_tags',
  });
}

// ============================================================================================ reorder_tags

/** The same tags (each as often), whatever the order. */
const sameTagSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/**
 * v3 F3d (ADR 0053): a Working or Archived page's tags reordered so the lifecycle tag leads, every other tag (a status tag
 * included) in its order. Re-read live: the page must still hold exactly the tags the audit saw (in any order), else the
 * fix is stale; checked again inside the lock, and verified after.
 */
async function fixReorder(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const pageId = String(f.fix!.args.pageId);
  const seen = (f.fix!.args.tags as unknown[]).filter((t): t is string => typeof t === 'string');
  const order = (f.fix!.args.order as unknown[]).filter((t): t is string => typeof t === 'string');
  if (!sameTagSet(seen, order))
    throw new AuditError('FIX_NOT_APPLICABLE', 'The new order is not the same tags; nothing was proposed.');
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const live = Array.isArray(res.tags)
    ? (res.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  if (!sameTagSet(live, seen))
    throw stale(`The page's tags are now ${live.join(', ') || '(none)'}, not ${seen.join(', ')}.`, {
      tags: live,
    });
  if (live.join('\u0000') === order.join('\u0000'))
    return { status: 'nothing_to_do', message: 'The page’s tags are already in that order.' };
  const name = String(res.name);
  const title = `Reorder the tags of ${name}: ${order.join(', ')}`;
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: { checks: [{ label: 'page', kind: 'resource', resourceId: pageId, name, tags: live }] },
      },
    },
    {
      op: 'updateResource',
      params: { path: { resourceId: pageId }, body: { tags: order } },
      journalOperation: {
        tool: 'update_resource',
        page: { id: pageId, name },
        from: 'audits.propose_fix',
        write: 'tags reordered',
      },
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'resource',
              label: name,
              resourceId: pageId,
              fields: { tags: order },
            } satisfies VerifyTarget,
          ],
        },
      },
    },
  ];
  return propose(d, projectId, {
    steps,
    title,
    holdLock: { resourceId: pageId },
    operation: {
      tool: 'update_resource',
      fromAudit: f.code,
      changes: { tags: { before: live, after: order, reorderOnly: true } },
    },
    page: { id: pageId, name },
    pageParts: ['tags reordered'],
    fix: 'reorder_tags',
  });
}

// ============================================================================================ split_paragraph

const runsKey = (runs: unknown): string =>
  stableJson(Array.isArray(runs) ? runs.filter((r) => isObj(r)) : []);

/** The block with this id, anywhere in the tree. */
function findBlock(blocks: readonly unknown[], id: string): Obj | null {
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.id === id) return b;
    if (Array.isArray(b.children)) {
      const hit = findBlock(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Strips `version` from a run list (LegendKeeper adds none to runs; kept for safety) and drops empty parts. */
export function paragraphParts(runs: readonly unknown[]): Obj[][] {
  return splitRunsAtBreaks(runs).filter((p) => p.length > 0);
}

export interface SplitPlan {
  readonly blockId: string;
  /** The ids of the new paragraphs, in order (client-chosen ids, fixed at proposal time). */
  readonly newIds: readonly string[];
  readonly parts: readonly Obj[][];
}

/** The list holding block `id` (the document's or a container's children). */
function siblingsOf(list: readonly unknown[], id: string): readonly unknown[] | null {
  for (const b of list) {
    if (isObj(b) && b.id === id) return list;
    if (isObj(b) && Array.isArray(b.children)) {
      const hit = siblingsOf(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The document checker run inside the lock: the block must still hold exactly the runs the plan was made from. */
export const splitChecker: DocumentChecker = (ctx) => {
  const input = ctx.input as { blockId: string; runsKey: string; parts?: string[]; finishing?: string[] };
  // v2 E4 (RV4-4): the parts are already after the paragraph (a split stopped after its inserts) and this plan would
  // insert them again: a conflict; the fix is proposed again, and then only finishes the split.
  if (input.parts && input.parts.length > 0 && !input.finishing) {
    const sib = siblingsOf(ctx.document.blocks, input.blockId) ?? [];
    const at = sib.findIndex((b) => isObj(b) && b.id === input.blockId);
    const next = sib.slice(at + 1, at + 1 + input.parts.length);
    if (
      next.length === input.parts.length &&
      next.every((b, i) => isObj(b) && b.kind === 'paragraph' && runsKey(b.content) === input.parts![i])
    )
      return {
        differences: [
          {
            path: `block ${input.blockId}`,
            expected: 'the paragraph not yet split',
            actual:
              'its parts are already after it (a split stopped part-way): propose the fix again to finish it',
          },
        ],
      };
  }
  const block = findBlock(ctx.document.blocks, input.blockId);
  if (!block)
    return {
      differences: [{ path: `block ${input.blockId}`, expected: 'present', actual: 'not in the document' }],
    };
  if (runsKey(block.content) !== input.runsKey)
    return {
      differences: [
        {
          path: `block ${input.blockId} content`,
          expected: 'the runs the finding saw',
          actual: 'changed since (edited in LegendKeeper or by another write)',
        },
      ],
    };
  return { differences: [] };
};

/** After the writes: the block and the new ones, in order, hold exactly the parts. */
export const splitVerifier: DocumentChecker = (ctx) => {
  const input = ctx.input as { blockId: string; newIds: string[]; parts: string[] };
  const ids = [input.blockId, ...input.newIds];
  const differences: { path: string; expected: unknown; actual: unknown }[] = [];
  // The paragraphs must be consecutive siblings: find the first's container and compare the run of blocks.
  const siblings = (list: readonly unknown[]): readonly unknown[] | null => {
    for (const b of list) {
      if (isObj(b) && b.id === input.blockId) return list;
      if (isObj(b) && Array.isArray(b.children)) {
        const hit = siblings(b.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  const list = siblings(ctx.document.blocks);
  if (!list)
    return {
      differences: [{ path: `block ${input.blockId}`, expected: 'present', actual: 'not in the document' }],
    };
  const at = list.findIndex((b) => isObj(b) && b.id === input.blockId);
  ids.forEach((id, i) => {
    const b = list[at + i];
    if (!isObj(b) || b.id !== id) {
      differences.push({ path: `paragraph ${i + 1}`, expected: id, actual: isObj(b) ? b.id : null });
      return;
    }
    if (runsKey(b.content) !== input.parts[i])
      differences.push({ path: `paragraph ${i + 1} content`, expected: 'the split part', actual: 'differs' });
  });
  return { differences };
};

async function fixSplit(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const pageId = String(f.fix!.args.pageId);
  const documentId = String(f.fix!.args.documentId);
  const blockId = String(f.fix!.args.blockId);
  const wanted = String(f.fix!.args.runsHash);
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const doc = await read(d, projectId, 'getDocumentBlocks', { path: { resourceId: pageId, documentId } });
  const blocks = isObj(doc) && Array.isArray(doc.blocks) ? (doc.blocks as unknown[]) : [];
  const block = findBlock(blocks, blockId);
  if (!block) throw stale(`The paragraph ${blockId} is no longer in the document.`);
  if (block.kind !== 'paragraph' || !Array.isArray(block.content))
    throw stale(`The block ${blockId} is no longer a paragraph.`);
  const runs = block.content as unknown[];
  if (extractHash(runs) !== wanted) throw stale('The paragraph has been edited since the audit.');
  if (runs.some((r) => isObj(r) && !isKnownRun(r)))
    throw new AuditError(
      'FIX_NOT_APPLICABLE',
      'The paragraph itself holds an inline icon, which LegendKeeper’s write format cannot write back; it cannot be split by the API. Nothing was proposed.',
    );
  const parts = paragraphParts(runs);
  if (parts.length < 2)
    return {
      status: 'nothing_to_do',
      message: 'Splitting would give fewer than two paragraphs (the breaks are at the ends).',
    };
  // v2 E4 (RV4-4): a split that stopped after its inserts left the parts after the paragraph (the text twice, as
  // planned); proposing again finishes it with the replace alone, never inserting the parts a second time.
  const siblings = siblingsOf(blocks, blockId) ?? [];
  const at = siblings.findIndex((b) => isObj(b) && b.id === blockId);
  const following = siblings.slice(at + 1, at + parts.length);
  const already =
    following.length === parts.length - 1 &&
    following.every(
      (b, i) => isObj(b) && b.kind === 'paragraph' && runsKey(b.content) === runsKey(parts[i + 1]),
    );
  const newIds = already
    ? following.map((b) => String((b as Obj).id))
    : parts.slice(1).map(() => mintClientId());
  const name = String(res.name);
  const label = `Split a paragraph of ${name} into ${parts.length}`;
  const writeBase = { judgedInLock: true } as const;
  const steps: StepSpec[] = [
    {
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: 'paragraph',
              kind: 'document',
              resourceId: pageId,
              documentId,
              checker: SPLIT_CHECK,
              input: {
                blockId,
                runsKey: runsKey(runs),
                // v2 E4 (RV4-4): the parts the inserts would add, so a split already half made is never inserted again.
                parts: parts.slice(1).map((p) => runsKey(p)),
                ...(already ? { finishing: newIds } : {}),
              },
            },
          ],
        },
      },
    },
    // The new paragraphs first, each after the one before and the original still whole, then the original is cut down to its
    // first part: a refused insert leaves the paragraph exactly as it was, and nothing is ever lost (a failure after the
    // inserts leaves the text twice, never less).
    ...(already ? [] : parts.slice(1)).map((p, i): StepSpec => ({
      op: 'insertBlock',
      ...writeBase,
      params: {
        path: { resourceId: pageId, documentId },
        body: {
          block: { kind: 'paragraph', id: newIds[i]!, content: p },
          after: i === 0 ? blockId : newIds[i - 1]!,
        },
      },
      ifMatchFrom: i === 0 ? { step: 1, key: 'paragraph' } : { step: 1 + i },
      journalOperation: { tool: 'audits.split_paragraph', page: { id: pageId, name }, block: newIds[i]! },
    })),
    {
      op: 'replaceBlock',
      ...writeBase,
      params: {
        path: { resourceId: pageId, documentId, blockId },
        body: { kind: 'paragraph', id: blockId, content: parts[0] },
      },
      ifMatchFrom: already ? { step: 1, key: 'paragraph' } : { step: parts.length },
      journalOperation: { tool: 'audits.split_paragraph', page: { id: pageId, name }, block: blockId },
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'checked',
              label: 'the split paragraphs',
              resourceId: pageId,
              documentId,
              checker: SPLIT_VERIFY,
              input: { blockId, newIds, parts: parts.map((p) => runsKey(p)) },
            } satisfies VerifyTarget,
          ],
        },
      },
    },
  ];
  return propose(d, projectId, {
    steps,
    title: label,
    holdDocuments: [documentId],
    operation: {
      tool: 'audits.split_paragraph',
      fromAudit: f.code,
      document: documentId,
      block: blockId,
      parts: parts.map((p) => p.map((r) => (typeof r.text === 'string' ? r.text : '[…]')).join('')),
    },
    page: { id: pageId, name },
    pageParts: ['page content: one paragraph split'],
    fix: 'split_paragraph',
  });
}

/** The same hash the extraction made (sha1 of the runs' JSON). */
const extractHash = runsHashOf;

// ============================================================================================ entry

export interface ProposeContext {
  /** The name of the key-value property facts are written to (`PROPERTIES`). */
  readonly propertiesName: string;
}

/** Plans and captures one finding's fix. Throws `AuditError` (`FIX_STALE`, `NO_FIX`, `FIX_NOT_APPLICABLE`, a plan's refusal). */
export async function proposeFix(
  d: FixDeps,
  projectId: string,
  f: Finding,
  c: ProposeContext,
): Promise<FixResult> {
  if (!f.fix)
    throw new AuditError('NO_FIX', 'This finding offers no fix: only the owner can decide what is right.');
  if (f.state !== 'open') throw new AuditError('FINDING_GONE', 'This finding is no longer present.');
  switch (f.fix.kind) {
    case 'move_resource':
      return fixMove(d, projectId, f);
    case 'set_facts':
      return fixFacts(d, projectId, f, c.propertiesName);
    case 'add_tags':
      return fixTags(d, projectId, f);
    case 'split_paragraph':
      return fixSplit(d, projectId, f);
    case 'reorder_tags':
      return fixReorder(d, projectId, f);
    case 'chronology_sync':
    case 'chronology_count':
    case 'chronology_orphan':
    case 'chronology_pair':
      throw new AuditError('USE_CHRONOLOGY', 'This fix goes through the chronology module.');
    case 'merge_asset_folders':
      return fixMergeFolders(d, projectId, f);
    case 'narrative':
      return fixNarrative(d, projectId, f, c.propertiesName);
    case 'art_layout':
      return fixArtLayout(d, projectId, f);
    case 'core_upgrade': {
      // v3 F7.1 (ADR 0072): the character tool's own upgrade, planned by the pack planner (one rule for every caller).
      if (!d.coreUpgrade)
        throw new AuditError(
          'FIX_UNAVAILABLE',
          'The character tool is not available here, so the upgrade cannot be planned now. Nothing was proposed.',
        );
      const a = f.fix.args as Obj;
      return d.coreUpgrade(
        projectId,
        { pageId: String(a.pageId), name: String(a.name) },
        {
          origin: d.origin ?? ORIGIN,
          engine: d.engine,
          ...(d.direct === true ? { direct: true } : {}),
        },
      );
    }
    case 'core_wording':
      return fixCoreWording(d, projectId, f);
    case 'reference_type':
      return fixReferenceType(d, projectId, f, c.propertiesName);
    case 'identity_copy':
      return fixIdentityCopy(d, projectId, f, c.propertiesName);
  }
}

// ============================================================================================ v3 F7d: identity copies

/**
 * v3 F7d (ADR 0077, A10): the `owner_identity_copy_drift` fix. Both pages are read LIVE: the identity page must still
 * hold the values the finding saw, and the page its copies the finding saw (either changed: FIX_STALE, nothing
 * proposed). Then ONE set_facts copies the identity page's values into the page's rows (never a row added), through the
 * governed facts path: the rows checked inside the lock, the writes If-Match chained, journalled, read back. A proposal;
 * with the automation's Apply (`direct`), a job every guard judges.
 */
async function fixIdentityCopy(
  d: FixDeps,
  projectId: string,
  f: Finding,
  propertiesName: string,
): Promise<FixResult> {
  const a = f.fix!.args as Obj;
  const pageId = String(a.pageId);
  const identityId = String(a.identityId);
  const expected = a.expectedCurrent as Record<string, string>;
  const expectedIdentity = a.expectedIdentity as Record<string, string>;
  const kvOf = (sidebar: ReturnType<typeof sidebarFrom>, what: string) => {
    const kv = sidebar.filter(
      (p) => p.kind === 'keyValue' && p.title.trim().toLowerCase() === propertiesName.trim().toLowerCase(),
    );
    if (kv.length !== 1) throw stale(`${what} does not have exactly one “${propertiesName}” property now.`);
    return kv[0]!;
  };
  const valueOf = (kv: ReturnType<typeof kvOf>, key: string, what: string): string => {
    const rows = (kv.rows ?? []).filter((r) => r.key.trim().toLowerCase() === key.trim().toLowerCase());
    if (rows.length !== 1) throw stale(`${what}: the row “${key}” is not there exactly once now.`);
    return runsText(rows[0]!.content).trim();
  };
  // The identity page, live: the values to copy, as the finding saw them.
  const idRes = (await read(d, projectId, 'getResource', { path: { resourceId: identityId } })) as
    Obj | undefined;
  if (!isObj(idRes)) throw stale(`The identity page ${identityId} is gone.`);
  const idKv = kvOf(
    sidebarFrom(await read(d, projectId, 'listProperties', { path: { resourceId: identityId } })),
    String(idRes.name),
  );
  const copy: Record<string, string> = {};
  for (const [key, v] of Object.entries(expectedIdentity)) {
    const live = valueOf(idKv, key, String(idRes.name));
    if (live !== v.trim())
      throw stale(
        `${String(idRes.name)}: “${key}” is now “${live}”, not “${v}” (the identity page changed since the audit).`,
        {
          found: live,
        },
      );
    copy[key] = live;
  }
  // The page, live: its rows as the finding saw them.
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const path = { resourceId: pageId };
  const body = await read(d, projectId, 'listProperties', { path });
  const sidebar = sidebarFrom(body);
  const kv = kvOf(sidebar, String(res.name));
  for (const [key, v] of Object.entries(expected)) {
    const live = valueOf(kv, key, String(res.name));
    if (live !== v.trim())
      throw stale(
        `${String(res.name)}: “${key}” is now “${live}”, not “${v}” (the page changed since the audit).`,
        {
          found: live,
        },
      );
  }
  const name = String(res.name);
  let plan;
  try {
    plan = planFacts({
      resourceId: pageId,
      sidebar,
      propertyTitle: kv.title,
      facts: Object.entries(copy).map(([key, value]) => ({ key, value: rowTextRuns(value) })),
      links: [],
      templateKeys: null,
    });
  } catch (e) {
    if (e instanceof FactsPlanError) throw new AuditError(e.code, e.message, e.details);
    throw e;
  }
  if (plan.empty)
    return { status: 'nothing_to_do', message: `${name} already holds the identity page's values.` };
  const job = expandFacts(plan, { id: pageId, name }, sidebar, { facts: copy, links: {} });
  const operation = {
    ...job.operation,
    fromAudit: f.code,
    identityPage: { id: identityId, name: String(idRes.name) },
    copied: copy,
  };
  const keys = Object.keys(copy);
  const title = `${name}: ${keys.join(', ')} copied from ${String(idRes.name)}`;
  if (d.direct !== true)
    return propose(d, projectId, {
      steps: job.steps,
      title,
      holdLock: { resourceId: pageId },
      operation,
      page: { id: pageId, name },
      pageParts: ['sidebar', ...keys.map((k) => `${k}: copied`)],
      prefetched: [{ op: 'listProperties', path, body }],
      fix: 'identity_copy',
    });
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: projectId,
    steps: job.steps,
    onError: 'stop',
    priority: 'P1',
    origin: d.origin ?? ORIGIN,
    title: title.slice(0, 300),
    holdLock: { resourceId: pageId },
    internal: true,
    proposal: {
      operation,
      operations: [
        {
          ...operation,
          page: { id: pageId, name },
          pageParts: ['sidebar', ...keys.map((k) => `${k}: copied`)],
          summaryLabel: title,
        },
      ],
      summary: title,
      prefetched: [{ op: 'listProperties', path, body }],
    },
  });
  if (typeof r.proposalId === 'string')
    return { status: 'proposal_captured', proposalId: r.proposalId, summary: title, fix: 'identity_copy' };
  if (typeof r.jobId === 'string')
    return { status: 'job_submitted', jobId: r.jobId, summary: title, fix: 'identity_copy' };
  throw new AuditError('NOT_PROPOSED', 'The fix was neither proposed nor submitted; nothing was done.');
}

// ============================================================================================ v3 F6a: Reference Type

/**
 * v3 F6a (ADR 0076): the `reference_type_noncanonical` fix. The owner's mapping must still hold (undone or conflicting:
 * FIX_STALE, nothing proposed); the page's Reference Type is read LIVE and must still be the value the finding saw. Then
 * ONE field is set through the governed facts path (`planFacts` and `expandFacts`: the row checked inside the lock, the
 * write's If-Match chained from that check, journalled with the decision, read back). A proposal; with the automation's
 * Apply (`direct`), a job that every guard judges (the canon guard decides an Authoritative page's: never bypassed).
 */
async function fixReferenceType(
  d: FixDeps,
  projectId: string,
  f: Finding,
  propertiesName: string,
): Promise<FixResult> {
  const a = f.fix!.args as Obj;
  const decisionId = String(a.decisionId);
  const facts = a.facts as Record<string, string>;
  const [key, target] = Object.entries(facts)[0]!;
  const now = d.referenceTypeDecision?.(projectId, decisionId) ?? null;
  if (!now || now.action !== 'map' || now.target !== target)
    throw stale(
      `The owner's mapping of “${String(a.value)}” to “${target}” no longer holds (undone or changed).`,
    );
  if (now.conflict)
    throw stale(`The owner's mapping conflicts with the published vocabulary (${now.conflict}).`);
  const pageId = String(a.pageId);
  const expected = a.expectedCurrent as Record<string, string>;
  const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as Obj | undefined;
  if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
  const path = { resourceId: pageId };
  const body = await read(d, projectId, 'listProperties', { path });
  const sidebar = sidebarFrom(body);
  const kv = sidebar.filter(
    (p) => p.kind === 'keyValue' && p.title.trim().toLowerCase() === propertiesName.trim().toLowerCase(),
  );
  if (kv.length !== 1) throw stale(`The page does not have exactly one “${propertiesName}” property now.`);
  const rows = (kv[0]!.rows ?? []).filter((r) => r.key.trim().toLowerCase() === key.trim().toLowerCase());
  if (rows.length !== 1)
    throw stale(`The row “${key}” is not there exactly once now.`, { rows: rows.length });
  const live = runsText(rows[0]!.content);
  if (live.trim() !== (expected[key] ?? '').trim())
    throw stale(`“${key}” is now “${live}”, not “${expected[key]}”.`, { found: live });
  const name = String(res.name);
  let plan;
  try {
    plan = planFacts({
      resourceId: pageId,
      sidebar,
      propertyTitle: kv[0]!.title,
      facts: [{ key, value: rowTextRuns(target) }],
      links: [],
      templateKeys: null,
    });
  } catch (e) {
    if (e instanceof FactsPlanError) throw new AuditError(e.code, e.message, e.details);
    throw e;
  }
  if (plan.empty) return { status: 'nothing_to_do', message: `“${key}” already holds “${target}”.` };
  const job = expandFacts(plan, { id: pageId, name }, sidebar, { facts, links: {} });
  // Every write carries the decision, so the decision knows it has been applied (it then cannot be undone).
  const steps = job.steps.map((st) =>
    st.journalOperation
      ? { ...st, journalOperation: { ...st.journalOperation, referenceTypeDecision: decisionId } }
      : st,
  );
  const operation = {
    ...job.operation,
    fromAudit: f.code,
    referenceTypeDecision: decisionId,
    from: String(a.value),
    to: target,
  };
  const title = `Reference Type of ${name}: “${String(a.value)}” → “${target}” (the owner’s mapping)`;
  if (d.direct !== true)
    return propose(d, projectId, {
      steps,
      title,
      holdLock: { resourceId: pageId },
      operation,
      page: { id: pageId, name },
      pageParts: ['sidebar', `${key}: changed`],
      prefetched: [{ op: 'listProperties', path, body }],
      fix: 'reference_type',
    });
  // The automation's Apply: a job, every guard judging it (the canon guard may still make it a proposal).
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: projectId,
    steps,
    onError: 'stop',
    priority: 'P1',
    origin: d.origin ?? ORIGIN,
    title: title.slice(0, 300),
    holdLock: { resourceId: pageId },
    internal: true,
    proposal: {
      operation,
      operations: [
        {
          ...operation,
          page: { id: pageId, name },
          pageParts: ['sidebar', `${key}: changed`],
          summaryLabel: title,
        },
      ],
      summary: title,
      prefetched: [{ op: 'listProperties', path, body }],
    },
  });
  if (typeof r.proposalId === 'string')
    return { status: 'proposal_captured', proposalId: r.proposalId, summary: title, fix: 'reference_type' };
  if (typeof r.jobId === 'string')
    return { status: 'job_submitted', jobId: r.jobId, summary: title, fix: 'reference_type' };
  throw new AuditError('NOT_PROPOSED', 'The fix was neither proposed nor submitted; nothing was done.');
}

// ============================================================================================ v3 F7.1: Core wording

interface WordingPart {
  readonly pageId: string;
  readonly name: string;
  readonly documentId: string;
  readonly role: WordingRole;
  readonly replacements: readonly {
    readonly blockId: string;
    readonly before: string;
    readonly after: string;
  }[];
}

/**
 * v3 F7.1 (ADR 0072): the `core_compact_wording` fix. Each page is read LIVE first (its name, its document): the
 * replacements the helper's rules make now must be the ones the finding saw (else FIX_STALE, nothing proposed). Then ONE
 * job, the Art page's write first and the Core's after, each filled inside the lock by `pack.core_text` (the rules applied
 * to the named blocks only; nothing else touched, `unsupported` blocks kept), verified on read-back. A proposal, unless
 * the automation's Apply asks for a direct job (`direct`), which every guard still judges.
 */
async function fixCoreWording(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const a = f.fix!.args as Obj;
  const subject = String(a.subject);
  // Amendment 1 to ADR 0072: the names the audit's self-reference test used (the filler applies the same ones).
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const names = strings(a.names);
  const others = strings(a.others);
  const wn = { ...(names ? { names } : {}), ...(others ? { others } : {}) };
  const core = a.core as Obj;
  const parts: WordingPart[] = [];
  if (isObj(a.art))
    parts.push({
      pageId: String(a.art.pageId),
      name: String(a.art.name),
      documentId: String(a.art.documentId),
      role: 'art',
      replacements: (a.art.replacements as WordingPart['replacements'] | undefined) ?? [],
    });
  parts.push({
    pageId: String(a.pageId),
    name: String(a.name),
    documentId: String(core.documentId),
    role: 'core',
    replacements: (core.replacements as WordingPart['replacements'] | undefined) ?? [],
  });
  const keyOf = (rs: readonly { blockId: string; before: string }[]) =>
    rs
      .map((r) => `${r.blockId}|${r.before}`)
      .sort()
      .join('\n');
  const live: WordingPart[] = [];
  for (const p of parts) {
    const res = (await read(d, projectId, 'getResource', { path: { resourceId: p.pageId } })) as
      Obj | undefined;
    if (!isObj(res)) throw stale(`${p.name} is gone.`);
    if (res.name !== p.name)
      throw stale(`${p.name} is named “${String(res.name)}” now.`, { found: res.name });
    const doc = (await read(d, projectId, 'getDocumentBlocks', {
      path: { resourceId: p.pageId, documentId: p.documentId },
    })) as Obj | undefined;
    const blocks = isObj(doc) && Array.isArray(doc.blocks) ? (doc.blocks as LkBlock[]) : null;
    if (!blocks) throw stale(`${p.name}'s text could not be read now.`);
    const now = reword(blocks, p.role, subject, undefined, wn).replacements;
    if (keyOf(now) !== keyOf(p.replacements))
      throw stale(
        `${p.name}'s text has changed since the audit (the phrases to replace are not the ones it found).`,
        {
          found: now.map((r) => ({ blockId: r.blockId, before: r.before })),
        },
      );
    if (now.length > 0) live.push({ ...p, replacements: now });
  }
  if (live.length === 0) return { status: 'nothing_to_do', message: 'No compact phrase is left to replace.' };
  const n = live.reduce((k, p) => k + p.replacements.length, 0);
  // Amendment 1 to ADR 0072: the words that change, sentence by sentence, in the title, the page summary and the
  // operation (the Proposals page and the Review card show them, the replaced words highlighted).
  const changes: TextChange[] = live.flatMap((p) =>
    coreTextChanges({ page: { id: p.pageId, name: p.name }, replacements: p.replacements }),
  );
  const title = `Replace ${n} phrase${n === 1 ? '' : 's'} where ${subject}'s Character Core calls itself compact (${live.map((p) => p.name).join(', ')})`;
  const steps: StepSpec[] = live.map((p) => {
    const input: CoreTextInput = {
      role: p.role,
      subject,
      ...wn,
      reword: [...new Set(p.replacements.map((r) => r.blockId))],
      expect: p.replacements.map((r) => ({ blockId: r.blockId, before: r.before, after: r.after })),
      remove: [],
    };
    return {
      op: 'replaceDocumentBlocks',
      params: { path: { resourceId: p.pageId, documentId: p.documentId }, body: { blocks: [] } },
      fill: { filler: CORE_TEXT_FILLER, input },
      judgedInLock: true,
      verifyAfterWrite: true,
      journalOperation: {
        tool: 'audits.core_wording',
        page: { id: p.pageId, name: p.name },
        from: 'audits.propose_fix',
        write: `${p.replacements.length} compact phrase(s) now say Character Core`,
      },
    } satisfies StepSpec;
  });
  const operation = {
    tool: 'audits.core_wording',
    fromAudit: f.code,
    replacements: live.flatMap((p) =>
      p.replacements.map((r) => ({ page: p.name, before: r.before, after: r.after })),
    ),
    textChanges: changes,
  };
  if (d.direct !== true)
    return propose(d, projectId, {
      steps,
      title,
      holdDocuments: live.map((p) => p.documentId),
      operation,
      page: { id: String(a.pageId), name: String(a.name) },
      pageParts: live.flatMap((p) => {
        const mine = changes.filter((c) => c.pageId === p.pageId);
        return mine.length > 0
          ? mine.map((c) => `wording: ${textChangeWords({ ...c, page: '' })}`)
          : [`${p.replacements.length} phrase(s) → Character Core`];
      }),
      fix: 'core_wording',
    });
  // The automation's Apply: a job, every guard judging it (a guard may still make it a proposal).
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: projectId,
    steps,
    onError: 'stop',
    priority: 'P1',
    origin: d.origin ?? ORIGIN,
    title: title.slice(0, 300),
    holdDocuments: live.map((p) => p.documentId),
    internal: true,
    proposal: {
      operation,
      operations: [
        { ...operation, page: { id: String(a.pageId), name: String(a.name) }, summaryLabel: title },
      ],
      summary: title,
    },
  });
  if (typeof r.proposalId === 'string')
    return { status: 'proposal_captured', proposalId: r.proposalId, summary: title, fix: 'core_wording' };
  if (typeof r.jobId === 'string')
    return { status: 'job_submitted', jobId: r.jobId, summary: title, fix: 'core_wording' };
  throw new AuditError('NOT_PROPOSED', 'The fix was neither proposed nor submitted; nothing was done.');
}

// ============================================================================================ v3 F7: art layout

/** A live getAsset (null: gone). */
async function liveAsset(d: FixDeps, projectId: string, id: string): Promise<Obj | null> {
  try {
    const a = await read(d, projectId, 'getAsset', { path: { assetId: id } });
    return isObj(a) ? a : null;
  } catch (e) {
    if ((e as { status?: unknown }).status === 404 || (e as { lkCode?: unknown }).lkCode === 'NOT_FOUND')
      return null;
    throw e;
  }
}

/** A folder's direct children, listed live (paged). */
async function liveChildren(d: FixDeps, projectId: string, folderId: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page = (await read(d, projectId, 'listAssets', {
      query: { limit: 100, folderId, ...(cursor ? { cursor } : {}) },
    })) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
    for (const x of Array.isArray(page?.data) ? page.data : []) if (isObj(x)) out.push(x);
    if (page?.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor)
      cursor = page.nextCursor;
    else break;
  }
  return out;
}

/**
 * v3 F7 (ADR 0070, G7, G9): the art layout's fixes. Every target is read LIVE first and compared with what the audit
 * saw (else FIX_STALE: nothing proposed); then ONE proposal for the owner. Moves are `updateAsset` (journalled), a
 * folder is found or made inside the job (`findOrCreate`), deletes are `onlyIfEmpty` (never with anything in them), a
 * line is replaced with the document version read now (a later edit makes the job stop, never overwrite).
 */
async function fixArtLayout(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const a = f.fix!.args as Obj;
  const tool = 'audits.art_layout';
  const character = typeof a.character === 'string' ? a.character : '';
  const firstId = [a.folderId, a.wardrobeId, a.assetId, a.pageId].find(
    (x): x is string => typeof x === 'string',
  );
  const page = { id: firstId ?? '', name: character };
  const journal = (write: string) => ({ tool, write });
  const moves = (Array.isArray(a.moves) ? a.moves : []) as {
    assetId: string;
    name: string;
    fromId: string;
  }[];
  const checkMoves = async () => {
    for (const m of moves) {
      const live = await liveAsset(d, projectId, m.assetId);
      if (!live) throw stale(`“${m.name}” is gone.`);
      if ((live.folderId ?? null) !== m.fromId) throw stale(`“${m.name}” has been moved since the audit.`);
      if (live.name !== m.name) throw stale(`“${m.name}” has been renamed since the audit.`);
    }
  };
  switch (a.action) {
    case 'unfold': {
      await checkMoves();
      const folderId = String(a.folderId);
      if (!(await liveAsset(d, projectId, String(a.wardrobeId)))) throw stale('Wardrobe is gone.');
      const kids = await liveChildren(d, projectId, folderId);
      if (kids.length !== 1) throw stale(`The folder now holds ${kids.length} item(s).`);
      const m = moves[0]!;
      return propose(d, projectId, {
        steps: [
          {
            op: 'updateAsset',
            params: { path: { assetId: m.assetId }, body: { folderId: String(a.wardrobeId) } },
            journalOperation: journal(`move “${m.name}” into ${String(a.wardrobePath)}`),
          },
          {
            op: 'deleteAsset',
            params: { path: { assetId: folderId } },
            onlyIfEmpty: true,
            journalOperation: journal(`delete the emptied ${String(a.folderPath)}`),
          },
        ],
        title: `${character}: move “${m.name}” into Wardrobe and delete the one-piece folder ${String(a.folderPath)}`,
        operation: { tool, action: 'unfold', folder: a.folderPath, piece: m.name },
        page,
        pageParts: ['asset folders'],
        fix: 'art_layout',
      });
    }
    case 'fold': {
      await checkMoves();
      const wardrobeId = String(a.wardrobeId);
      const kids = await liveChildren(d, projectId, wardrobeId);
      const name = String(a.folderName ?? a.outfit);
      const existing =
        (typeof a.folderId === 'string'
          ? kids.find((k) => k.id === a.folderId && k.type === 'FOLDER')
          : undefined) ?? kids.find((k) => k.type === 'FOLDER' && k.name === name);
      const steps: StepSpec[] = [];
      if (!existing) {
        steps.push({
          op: 'createAssetFolder',
          params: { body: { name, folderId: wardrobeId } },
          findOrCreate: true,
          journalOperation: journal(`folder ${String(a.wardrobePath)} / ${name}`),
        });
      }
      for (const m of moves)
        steps.push({
          op: 'updateAsset',
          params: {
            path: { assetId: m.assetId },
            body: { folderId: existing ? String(existing.id) : 'pending' },
          },
          ...(existing ? {} : { bindFrom: { step: 1, to: 'body.folderId' as const } }),
          journalOperation: journal(`move “${m.name}” into ${String(a.wardrobePath)} / ${name}`),
        });
      return propose(d, projectId, {
        steps,
        title: `${character}: ${existing ? '' : `make Wardrobe / ${name} and `}move its ${moves.length} loose pieces into it`,
        operation: { tool, action: 'fold', outfit: a.outfit, pieces: moves.map((m) => m.name) },
        page,
        pageParts: ['asset folders'],
        fix: 'art_layout',
      });
    }
    case 'delete_empty': {
      const deletes = (Array.isArray(a.deletes) ? a.deletes : []) as { folderId: string; path: string }[];
      const ids = new Set(deletes.map((x) => x.folderId));
      for (const x of deletes) {
        if (!(await liveAsset(d, projectId, x.folderId))) throw stale(`${x.path} is gone.`);
        const kids = await liveChildren(d, projectId, x.folderId);
        if (kids.some((k) => !ids.has(String(k.id)))) throw stale(`${x.path} is no longer empty.`);
      }
      return propose(d, projectId, {
        steps: deletes.map((x) => ({
          op: 'deleteAsset',
          params: { path: { assetId: x.folderId } },
          onlyIfEmpty: true,
          journalOperation: journal(`delete the empty ${x.path}`),
        })),
        title: `${character}: delete the empty ${deletes.at(-1)?.path ?? 'folder'}`,
        operation: { tool, action: 'delete_empty', folders: deletes.map((x) => x.path) },
        page,
        pageParts: ['asset folders'],
        fix: 'art_layout',
      });
    }
    case 'rename': {
      const live = await liveAsset(d, projectId, String(a.assetId));
      if (!live) throw stale(`“${String(a.from)}” is gone.`);
      if (live.name !== a.from) throw stale(`“${String(a.from)}” has been renamed since the audit.`);
      const siblings = await liveChildren(d, projectId, String(live.folderId ?? a.folderId));
      if (siblings.some((s) => s.name === a.to)) throw stale(`“${String(a.to)}” is taken in its folder now.`);
      return propose(d, projectId, {
        steps: [
          {
            op: 'updateAsset',
            params: { path: { assetId: String(a.assetId) }, body: { name: String(a.to) } },
            journalOperation: journal(`rename “${String(a.from)}” to “${String(a.to)}”`),
          },
        ],
        title: `${character}: rename “${String(a.from)}” to “${String(a.to)}”`,
        operation: { tool, action: 'rename', from: a.from, to: a.to },
        page,
        pageParts: ['asset name'],
        fix: 'art_layout',
      });
    }
    case 'update_line': {
      const pageId = String(a.pageId);
      const documentId = String(a.documentId);
      const blockId = String(a.blockId);
      const from = String(a.from);
      const to = String(a.to);
      const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as
        Obj | undefined;
      if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
      const doc = (await read(d, projectId, 'getDocumentBlocks', {
        path: { resourceId: pageId, documentId },
      })) as Obj | undefined;
      const version = isObj(doc) && typeof doc.version === 'string' ? doc.version : null;
      const block = findBlock(isObj(doc) && Array.isArray(doc.blocks) ? doc.blocks : [], blockId);
      if (!block || !version) throw stale(`The line ${blockId} is no longer in the document.`);
      const runs = Array.isArray(block.content) ? (block.content as Obj[]) : [];
      const at = runs.findIndex((r) => typeof r.text === 'string' && r.text.includes(from));
      if (at < 0)
        throw new AuditError(
          'FIX_NOT_APPLICABLE',
          'The stale path is no longer in one piece of the line’s text (edited, or split by formatting); nothing was proposed. Update it by hand.',
        );
      const content = runs.map((r, i) => (i === at ? { ...r, text: String(r.text).replace(from, to) } : r));
      // Amendment 1 to ADR 0072: the line before and after, the path that changes marked.
      const lineChange = textChange({
        page: String(res.name),
        pageId,
        blockId,
        what: 'folder path',
        before: shownText(runs),
        after: shownText(content),
      });
      return propose(d, projectId, {
        steps: [
          {
            op: 'replaceBlock',
            params: {
              path: { resourceId: pageId, documentId, blockId },
              body: {
                ...Object.fromEntries(Object.entries(block).filter(([k]) => k !== 'version')),
                content,
              },
              ifMatch: version,
            },
            journalOperation: { tool, page: { id: pageId, name: String(res.name) }, block: blockId },
          },
        ],
        title: `${String(res.name)}: update a line naming ${from} to ${to}`,
        holdDocuments: [documentId],
        operation: {
          tool,
          action: 'update_line',
          from,
          to,
          block: blockId,
          ...(lineChange ? { textChanges: [lineChange] } : {}),
        },
        page: { id: pageId, name: String(res.name) },
        pageParts: [
          lineChange
            ? `page content: one line updated: ${textChangeWords({ ...lineChange, page: '' })}`
            : 'page content: one line updated',
        ],
        fix: 'art_layout',
      });
    }
    default:
      throw new AuditError('NO_FIX', 'This finding offers no fix.');
  }
}

/**
 * v3 F2 (ADR 0049 decision 9): duplicate asset folders merged. ONE proposal: each asset of a later duplicate moved into
 * its match in the earliest chain (`updateAsset`, journalled with its pre-image), then each emptied duplicate deleted,
 * deepest first, each only if it is empty when the job runs (`onlyIfEmpty`: never deleted with anything in it).
 */
async function fixMergeFolders(d: FixDeps, projectId: string, f: Finding): Promise<FixResult> {
  const a = f.fix!.args as {
    keep?: string;
    moves?: { assetId: string; name: string; from: string; to: string; toId?: string }[];
    deletes?: { folderId: string; path: string }[];
    sameNames?: string[];
  };
  const moves = a.moves ?? [];
  const deletes = a.deletes ?? [];
  if (!a.keep || (moves.length === 0 && deletes.length === 0))
    throw new AuditError('FIX_NOT_APPLICABLE', 'Nothing to move or delete; nothing was proposed.');
  const steps: StepSpec[] = [
    ...moves.map((m) => ({
      op: 'updateAsset',
      params: { path: { assetId: m.assetId }, body: { folderId: m.toId ?? a.keep! } },
      journalOperation: {
        tool: 'audits.merge_asset_folders',
        write: `move “${m.name}” from ${m.from} to ${m.to}`,
      },
    })),
    ...deletes.map((x) => ({
      op: 'deleteAsset',
      params: { path: { assetId: x.folderId } },
      onlyIfEmpty: true,
      journalOperation: {
        tool: 'audits.merge_asset_folders',
        write: `delete the emptied duplicate ${x.path}`,
      },
    })),
  ];
  const same = a.sameNames ?? [];
  const ev = f.evidence as { name?: unknown; path?: unknown };
  const name = typeof ev.name === 'string' ? ev.name : '';
  const title = `Merge duplicate folders “${name}”: ${same.length ? `${same.length} same-named asset(s) moved anyway, never deleted; ` : ''}move ${moves.length} asset(s) into the earliest, delete ${deletes.length} emptied duplicate(s), deepest first`;
  return propose(d, projectId, {
    steps,
    title,
    operation: { tool: 'audits.merge_asset_folders', keep: a.keep, moves, deletes, sameNames: same },
    page: { id: a.keep, name: typeof ev.path === 'string' ? ev.path : a.keep },
    pageParts: ['asset folders'],
    fix: 'merge_asset_folders',
  });
}

// ============================================================================================ v3 F4c: narrative

/**
 * v3 F4c (ADR 0065, design E4 and E8): the narrative audit's mechanical fixes, each re-read live and compared with what
 * the audit saw (else FIX_STALE), then ONE proposal for the owner. Never the prose: a dateline fix changes only the
 * chapter's first block (or puts one before the text), every other block echoed exactly as read.
 */
async function fixNarrative(
  d: FixDeps,
  projectId: string,
  f: Finding,
  propertiesName: string,
): Promise<FixResult> {
  const a = f.fix!.args as Obj;
  const marker = (id: string): LifecycleMarker => ({
    tool: 'audits.propose_fix',
    canonical: false,
    pages: [{ id, to: null }],
  });
  switch (a.action) {
    case 'index': {
      const parentId = String(a.parentId);
      const name = String(a.name);
      const tags = (a.tags as string[]) ?? [];
      const kids = await listChildren(d, projectId, parentId);
      if (kids.some((k) => treeNameKey(classifyName(k.name).displayName) === treeNameKey(name)))
        return { status: 'nothing_to_do', message: `“${name}” exists now.` };
      const id = mintClientId();
      const raw = `[INDEX] ${name}`;
      const slot = slotAmong(
        kids.map((k) => ({ id: k.id, ...classifyName(k.name) })),
        name,
        'index',
      );
      const steps: StepSpec[] = [
        {
          op: EXPECT_STEP,
          params: {
            body: {
              checks: [
                { label: 'siblings', kind: 'children', resourceId: parentId, ids: kids.map((k) => k.id) },
              ],
            },
          },
        },
        {
          op: 'createResource',
          params: { body: { id, name: raw, parentId, tags, ...slot } },
          journalOperation: { tool: 'create_index', page: { id, name: raw }, from: 'audits.propose_fix' },
        },
        {
          op: VERIFY_STEP,
          params: {
            body: {
              targets: [
                {
                  kind: 'resource',
                  label: raw,
                  resourceId: id,
                  fields: { name: raw, parentId, tags },
                } satisfies VerifyTarget,
              ],
            },
          },
        },
      ];
      return propose(d, projectId, {
        steps,
        title: `Make the continuity index ${raw} under Narratives`,
        operation: { tool: 'create_index', fromAudit: f.code, name: raw, tags },
        page: { id, name: raw },
        pageParts: ['a new continuity index'],
        fix: 'narrative',
        lifecycle: marker(id),
      });
    }
    case 'tags': {
      const pageId = String(a.pageId);
      const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as
        Obj | undefined;
      if (!isObj(res)) throw stale(`The page ${pageId} is gone.`);
      const now = Array.isArray(res.tags) ? (res.tags as string[]) : [];
      if (stableJson(now) !== stableJson(a.expected))
        throw stale('The page’s tags changed since the audit.', { tags: now });
      // CR-2026-11-R4 (F2): additive only. Every tag the page holds now is kept, by its exact spelling (a status tag
      // too: taking one off is the lifecycle tools', never an ordinary approval's), whatever the finding's args say.
      const lower = (s: string) => s.toLocaleLowerCase('en-GB');
      const asked = Array.isArray(a.tags)
        ? (a.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      const tags: string[] = [];
      for (const t of asked) {
        const mine = now.find((x) => lower(x) === lower(t)) ?? t;
        if (!tags.includes(mine)) tags.push(mine);
      }
      for (const t of now) if (!tags.includes(t)) tags.push(t);
      if (stableJson(tags) === stableJson(now))
        return { status: 'nothing_to_do', message: 'The page already carries its narrative tags.' };
      const name = String(res.name);
      return propose(d, projectId, {
        steps: [
          {
            op: EXPECT_STEP,
            params: {
              body: { checks: [{ label: 'page', kind: 'resource', resourceId: pageId, tags: now }] },
            },
          },
          {
            op: 'updateResource',
            params: { path: { resourceId: pageId }, body: { tags } },
            journalOperation: {
              tool: 'update_resource',
              page: { id: pageId, name },
              from: 'audits.propose_fix',
            },
          },
          {
            op: VERIFY_STEP,
            params: {
              body: {
                targets: [
                  {
                    kind: 'resource',
                    label: name,
                    resourceId: pageId,
                    fields: { tags },
                  } satisfies VerifyTarget,
                ],
              },
            },
          },
        ],
        title: `Tag ${name}: ${tags.join(', ')}`,
        holdLock: { resourceId: pageId },
        operation: { tool: 'update_resource', fromAudit: f.code, tags },
        page: { id: pageId, name },
        pageParts: ['tags'],
        fix: 'narrative',
        lifecycle: marker(pageId),
      });
    }
    case 'link': {
      const pageId = String(a.pageId);
      const field = String(a.field);
      const path = { resourceId: pageId };
      const props = await read(d, projectId, 'listProperties', { path });
      const sidebar = sidebarFrom(props);
      const res = (await read(d, projectId, 'getResource', { path })) as Obj | undefined;
      const name = isObj(res) ? String(res.name) : pageId;
      let plan;
      try {
        plan = planFacts({
          resourceId: pageId,
          sidebar,
          propertyTitle: propertiesName,
          facts: [
            {
              key: field,
              value: [{ mention: { resourceId: String(a.targetId), text: String(a.targetName) } }],
            },
          ],
          links: [],
          templateKeys: null,
        });
      } catch (e) {
        if (e instanceof FactsPlanError) throw new AuditError('FIX_NOT_APPLICABLE', `${name}: ${e.message}`);
        throw e;
      }
      if (plan.empty) return { status: 'nothing_to_do', message: `${name}’s ${field} already points there.` };
      const job = expandFacts(plan, { id: pageId, name }, sidebar, { facts: {}, links: {} });
      return propose(d, projectId, {
        steps: job.steps,
        title: `Point ${name}’s ${field} at ${String(a.targetName)}`,
        holdLock: { resourceId: pageId },
        operation: job.operation,
        page: { id: pageId, name },
        pageParts: job.pageParts,
        prefetched: [{ op: 'listProperties', path, body: props }],
        fix: 'narrative',
        lifecycle: marker(pageId),
      });
    }
    case 'dateline': {
      const pageId = String(a.pageId);
      const documentId = String(a.documentId);
      const path = { resourceId: pageId, documentId };
      const doc = (await read(d, projectId, 'getDocumentBlocks', { path })) as
        { version?: unknown; blocks?: unknown } | undefined;
      if (!doc || typeof doc.version !== 'string' || !Array.isArray(doc.blocks))
        throw stale('The chapter’s document is gone.');
      const blocks = doc.blocks as Obj[];
      const first = blocks[0];
      const firstText =
        isObj(first) && Array.isArray(first.content)
          ? runsText(first.content as unknown[])
              .replace(/\s+/g, ' ')
              .trim()
          : '';
      if (firstText !== String(a.expectedFirst).replace(/\s+/g, ' ').trim())
        throw stale('The chapter’s first line changed since the audit.');
      const dateline = String(a.dateline);
      // CR-2026-11-R4 (F5): the first block is replaced only when the audit read its text before the separator WHOLE
      // as a calendar date (`replaceFirst`: a wrong or old dateline); anything else (an epigraph, a short line of prose,
      // a finding stored before the flag) stays, and the dateline is put before it.
      const isDateline =
        a.replaceFirst === true &&
        isObj(first) &&
        first.kind === 'paragraph' &&
        firstText.length <= 160 &&
        !/[.!?]["”’]?$/.test(firstText);
      const next: Obj[] = isDateline
        ? [{ ...first, content: rowTextRuns(dateline) }, ...blocks.slice(1)]
        : [{ id: mintClientId(), kind: 'paragraph', content: rowTextRuns(dateline) }, ...blocks];
      const res = (await read(d, projectId, 'getResource', { path: { resourceId: pageId } })) as
        Obj | undefined;
      const name = isObj(res) ? String(res.name) : pageId;
      // Amendment 1 to ADR 0072: the first line before and after (a dateline put first: nothing before it).
      const datelineChange = textChange({
        page: name,
        pageId,
        what: 'dateline',
        before: isDateline ? firstText : '',
        after: dateline,
      });
      return propose(d, projectId, {
        steps: [
          {
            op: 'replaceDocumentBlocks',
            params: { path, ifMatch: doc.version, body: { blocks: next } },
            verifyAfterWrite: true,
            journalOperation: {
              tool: 'write_page',
              page: { id: pageId, name },
              from: 'audits.propose_fix',
              write: 'the dateline',
            },
          },
        ],
        title: `${name}: its dateline “${dateline}”`,
        holdDocuments: [documentId],
        operation: {
          tool: 'write_page',
          fromAudit: f.code,
          dateline,
          replaced: isDateline ? firstText : null,
          ...(datelineChange ? { textChanges: [datelineChange] } : {}),
        },
        page: { id: pageId, name },
        pageParts: [
          isDateline
            ? `the first line (the dateline) replaced: “${firstText}” → “${dateline}”`
            : `a dateline put first: “${dateline}”`,
        ],
        prefetched: [{ op: 'getDocumentBlocks', path, body: doc }],
        fix: 'narrative',
        lifecycle: marker(pageId),
      });
    }
    default:
      throw new AuditError('FIX_NOT_APPLICABLE', 'This narrative finding offers no fix.');
  }
}
