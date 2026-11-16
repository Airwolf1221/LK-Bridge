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
import { SYSTEM_PRINCIPAL, type JobOrigin, type StepSpec } from '../jobs/index.js';
import { EXPECT_STEP, VERIFY_STEP, type DocumentChecker, type VerifyTarget } from '../jobs/internal-steps.js';
import { stableJson } from '../jobs/sidebar-state.js';
import { slotAmong } from '../registry/ordering.js';
import { classifyName, nameKey as treeNameKey } from '../tree/classify.js';
import { isKnownRun, runsHashOf, runsText, splitRunsAtBreaks } from './model.js';
import { AuditError } from './errors.js';
import type { Finding, FixKind } from './types.js';

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
}

export type FixResult =
  | {
      readonly status: 'proposal_captured';
      readonly proposalId: string;
      readonly summary: string | null;
      readonly fix: FixKind;
    }
  | { readonly status: 'nothing_to_do'; readonly message: string };

const stale = (what: string, details: Obj = {}): AuditError =>
  new AuditError(
    'FIX_STALE',
    `${what} The finding is out of date; nothing was proposed. Re-check it (or wait for the next audit).`,
    details,
  );

function read(d: FixDeps, projectId: string, op: string, params: Obj): Promise<unknown> {
  return d.engine.internalRead(projectId, op, params, { priority: 'P1' });
}

async function propose(
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
  },
): Promise<FixResult> {
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: projectId,
    steps: spec.steps,
    onError: 'stop',
    priority: 'P1',
    origin: ORIGIN,
    title: spec.title.slice(0, 300),
    ...(spec.holdLock ? { holdLock: spec.holdLock } : {}),
    ...(spec.holdDocuments ? { holdDocuments: spec.holdDocuments } : {}),
    internal: true,
    forceProposal: true,
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
  const slot = slotAmong(
    others.map((o) => ({ id: o.id, displayName: o.displayName, kind: o.kind })),
    displayName,
    kind,
  );
  const cur = kids.findIndex((k) => k.id === pageId);
  const here = {
    after: cur > 0 ? kids[cur - 1]!.id : null,
    before: cur >= 0 && cur < kids.length - 1 ? kids[cur + 1]!.id : null,
  };
  const then = neighboursAfterInsert(kids, pageId, slot);
  if (here.after === then.after && here.before === then.before)
    return { status: 'nothing_to_do', message: 'The page is already in its alphabetical place.' };
  const title = `Re-place ${name} alphabetically under its parent`;
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
    case 'chronology_sync':
    case 'chronology_count':
    case 'chronology_orphan':
      throw new AuditError('USE_CHRONOLOGY', 'This fix goes through the chronology module.');
  }
}
