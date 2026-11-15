/**
 * The four lifecycle tools (v2 C2c, ADR 0035; Part 2, decided by the owner on 10 November 2026): `archive_page`,
 * `unarchive_page`, `move_to_working` and `promote_page`.
 *
 * Each plans from the page as it is now (one `getResource`), the lifecycle record and the settings, refusing in a typed
 * way; answers a `dryRun` with the plan; and otherwise submits ONE job that always needs the owner's canonical approval
 * ("Approve and accept as canon"), at every scope: the lifecycle marker makes it a canonical proposal. The proposal holds
 * the full plan (the move and new name, every fact change, the tag changes, the note as a Markdown diff, the related
 * pages). The job:
 *
 * 1. `bridge.expect`: the page's name, parent and tags, the rows of its facts property, the pages under it (none, for a
 *    page that must have none) and the block the note goes before (or the note to remove), all as planned, else a
 *    conflict and nothing is written. Inside the page's lock (and its main document's, when the note is written).
 * 2. `bridge.record` begin: the lifecycle record, incomplete (a resume adds its job to the same record).
 * 3. The writes, ordered so a failure never leaves a misleading page: the PREFIX is the first thing to say "not current"
 *    and the last to say "current". Leaving the current state (archive_page, move_to_working): the rename and the tags
 *    first (one write), then the facts, the note, and the move last. Entering it (unarchive_page, promote_page): the move
 *    first, then the facts and the note, and the rename and the tags last. A page is therefore never classified
 *    `[BSRC]` while its facts still say Working or Archived, nor still `[BSRC]` while it says Archived.
 * 4. `bridge.verify`, then `bridge.record` complete.
 *
 * A job that stops part-way leaves the record incomplete; calling the same tool again on the page resumes: it re-plans
 * from the page as it is now and the record's target, and does only what is left (a new proposal, every guard and
 * precondition checked again). Nothing is ever replayed.
 */
import * as z from 'zod';
import { stateHash } from '../../jobs/sidebar-state.js';
import { factKey, factRows, sidebarFrom, valueText, type SidebarProperty } from '../../facts/index.js';
import { FactsPlanError, planFacts, rowStates, type FactsPlan } from '../../facts/plan.js';
import { rowTextRuns } from '../../facts/values.js';
import {
  EXPECT_STEP,
  RECORD_STEP,
  VERIFY_STEP,
  type ExpectCheck,
  type VerifyTarget,
} from '../../jobs/internal-steps.js';
import { rowsContentHash } from '../../jobs/sidebar-state.js';
import type { LifecycleMarker, StepSpec } from '../../jobs/index.js';
import { mintClientId } from '../../jobs/ids.js';
import { compareStoredBlocks } from '../../jobs/verify-blocks.js';
import {
  archivedScope,
  fillText,
  isoDate,
  lifecycleIndexes,
  type LifecycleAction,
  type LifecycleConfig,
  type LifecycleFacts,
  type LifecycleRecord,
  type LifecycleRecordInput,
  type LifecycleState,
  type LifecycleTarget,
} from '../../lifecycle/index.js';
import { key } from '../../registry/names.js';
import { SiblingSim } from '../../resources/plan.js';
import { KIND_PREFIX, classifyName, isPageKind, type TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { resolveParent, withRequest, type CreateOutcome } from './create-support.js';
import { defineTool } from './define.js';
import { liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import { CHANGE_ANNOTATIONS } from './resources.js';
import { pageRef, templateKeysFor } from './set-facts.js';
import { errorResult, projectArg, render, withProject, type ProjectDeps, type ToolDeps } from './shape.js';
import { runWriteJob } from './write-job.js';
import { runSet, subtreeArg } from './lifecycle-sets.js';

type Obj = Record<string, unknown>;
export type Role = keyof LifecycleFacts;
export const ROLES: readonly Role[] = [
  'status',
  'continuityType',
  'scope',
  'temporalScope',
  'lastMajorRevision',
];

export const TOOL: Readonly<Record<LifecycleAction, string>> = {
  archive: 'archive_page',
  unarchive: 'unarchive_page',
  move_to_working: 'move_to_working',
  promote: 'promote_page',
};

/** Whether an action leaves the current state (prefix first) or enters it (prefix last). */
export const LEAVING: Readonly<Record<LifecycleAction, boolean>> = {
  archive: true,
  move_to_working: true,
  unarchive: false,
  promote: false,
};

export type Answer = { kind: 'answer'; result: McpToolResult };
export const refuse = (pd: ProjectDeps, code: string, message: string, more: Obj = {}): Answer => ({
  kind: 'answer',
  result: errorResult({ code, message, ...more }, pd),
});

// ============================================================================================ the page now

export interface PageNow {
  readonly node: TreeNode;
  readonly name: string;
  readonly kind: string;
  readonly displayName: string;
  readonly parentId: string | null;
  readonly rank: string | null;
  readonly tags: readonly string[];
  readonly documents: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly type: string | null;
  }[];
  readonly sidebar: readonly SidebarProperty[];
  readonly raw: Obj;
}

export async function readPage(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  node: TreeNode,
): Promise<{ ok: true; value: PageNow } | { ok: false; result: McpToolResult }> {
  const r = await liveRead(pd, mctx, tool, 'getResource', { path: { resourceId: node.id } });
  if (!r.ok) return r;
  const raw = (r.value ?? {}) as Obj;
  const name = typeof raw.name === 'string' ? raw.name : node.rawName;
  const c = classifyName(name);
  return {
    ok: true,
    value: {
      node,
      name,
      kind: c.kind,
      displayName: c.displayName,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
      rank: typeof raw.rank === 'string' ? raw.rank : null,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
      documents: (Array.isArray(raw.documents) ? (raw.documents as Obj[]) : [])
        .filter((d) => typeof d.id === 'string' && d.deletedAt == null)
        .map((d) => ({
          id: d.id as string,
          name: typeof d.name === 'string' ? d.name : null,
          type: typeof d.type === 'string' ? d.type : null,
        })),
      sidebar: sidebarFrom(raw.properties),
      raw,
    },
  };
}

/** The five lifecycle facts as the page holds them (null: no such row). */
export function factsOf(
  c: LifecycleConfig,
  propertyTitle: string,
  sidebar: readonly SidebarProperty[],
): LifecycleFacts {
  const kv = sidebar.filter((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(propertyTitle));
  const rows = kv.length === 1 ? factRows([kv[0]!]) : [];
  const get = (k: string) => {
    const row = rows.find((r) => factKey(r.key) === factKey(k));
    return row ? valueText(row.content) : null;
  };
  return {
    status: get(c.fields.status),
    continuityType: get(c.fields.continuityType),
    scope: get(c.fields.scope),
    temporalScope: get(c.fields.temporalScope),
    lastMajorRevision: get(c.fields.lastMajorRevision),
  };
}

export const same = (a: string | null, b: string | null) =>
  (a ?? '').trim().toLocaleLowerCase('en-GB') === (b ?? '').trim().toLocaleLowerCase('en-GB');

/** The page's main page document: `Main` (a page, or blank), else its first page document. */
export function mainDocument(p: PageNow) {
  return (
    p.documents.find((d) => d.name === 'Main' && (d.type === 'page' || d.type === 'blank')) ??
    p.documents.find((d) => d.type === 'page') ??
    null
  );
}

/** `tags` with `remove` taken out (any case) and `add` put in (if missing). */
export function tagsAfter(
  tags: readonly string[],
  remove: readonly string[],
  add: readonly string[],
): string[] {
  const r = new Set(remove.map((t) => t.toLocaleLowerCase('en-GB')));
  const out = tags.filter((t) => !r.has(t.toLocaleLowerCase('en-GB')));
  for (const a of add)
    if (!out.some((t) => t.toLocaleLowerCase('en-GB') === a.toLocaleLowerCase('en-GB'))) out.push(a);
  return out;
}

// ============================================================================================ the plan

interface Plan {
  readonly action: LifecycleAction;
  readonly tool: string;
  readonly page: PageNow;
  readonly target: LifecycleTarget;
  readonly record: {
    readonly previousState: LifecycleState;
    readonly previousFacts: LifecycleFacts;
    readonly tagsRemoved: readonly string[];
    readonly tagsAdded: readonly string[];
    readonly resumeOf?: number;
    readonly date: string;
    readonly detail: Obj;
  };
  readonly flags: readonly string[];
}

interface Built {
  readonly steps: StepSpec[];
  readonly labels: string[];
  readonly marker: LifecycleMarker;
  readonly hold: { resourceId: string };
  readonly holdDocument?: { documentId: string };
  readonly holdAlso?: { resourceId: string };
  /** What the plan changes, as answers and the proposal show it. */
  readonly head: Obj;
  readonly operation: Obj;
  readonly writes: number;
}

/**
 * Builds the job from the plan and the page as it is now: only what differs from the target is written (so a resume
 * does only what is left).
 */
async function build(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  c: LifecycleConfig,
  propertyTitle: string,
  plan: Plan,
): Promise<{ ok: true; value: Built } | { ok: false; result: McpToolResult }> {
  const { page, target, action, tool } = plan;
  const pid = ctx.projectId;
  const steps: StepSpec[] = [];
  const labels: string[] = [];
  const pp = await planPage(pd, mctx, ctx, c, propertyTitle, page, target, tool);
  if (!pp.ok) return pp;
  const part = pp.value;
  const verify: VerifyTarget[] = [...part.verify];
  const checks: ExpectCheck[] = [
    {
      label: page.name,
      kind: 'resource',
      resourceId: page.node.id,
      name: page.name,
      parentId: page.parentId,
      tags: [...page.tags],
    },
  ];
  const journal = (write: string) => ({ tool, page: { id: page.node.id, name: page.name }, write });

  // --- the move (the page, or a Working character's index with the page under it).
  const sim = new SiblingSim((parentId) => ctx.tree.children(pid, parentId).data);
  const moveSteps: { step: StepSpec; label: string }[] = [];
  const mover = target.moveIndex ?? null;
  const movingId = mover ? mover.id : page.node.id;
  const movingNode = ctx.tree.node(pid, movingId).data;
  const currentParent = mover ? (movingNode?.parentId ?? null) : page.parentId;
  let placement: { parentId: string; after: string | null; before: string | null } | null = null;
  if (currentParent !== target.parentId) {
    const display = mover ? mover.name.replace(/^\[INDEX\]\s*/, '') : classifyName(target.name).displayName;
    const kind = mover ? 'index' : classifyName(target.name).kind;
    if (currentParent) sim.remove(currentParent, movingId);
    const slot = sim.slot(target.parentId, { displayName: display, kind }, () => true, movingId);
    sim.insert(target.parentId, { id: movingId, displayName: display, kind }, slot);
    placement = { parentId: target.parentId, ...sim.neighbours(target.parentId, movingId) };
    moveSteps.push({
      step: {
        op: 'moveResource',
        params: { path: { resourceId: movingId }, body: { parentId: target.parentId, ...slot } },
        journalOperation: journal(mover ? `moved ${mover.name} (the character's index) with it` : 'moved'),
        deferTreeReread: true,
      },
      label: `move ${mover ? mover.name : page.name} under ${ctx.tree.node(pid, target.parentId).data?.rawName ?? target.parentId}`,
    });
    if (mover) {
      checks.push({
        label: mover.name,
        kind: 'resource',
        resourceId: mover.id,
        name: mover.name,
        parentId: currentParent,
      });
      // v2 E4 (RV2-2; ADR 0036 decision 5): the index moves with everything under it, so what is under it must still be
      // exactly the page itself, as planned: a page added there since is a conflict, never taken along unlisted.
      checks.push({
        label: `${mover.name} (what is under it)`,
        kind: 'subtree',
        resourceId: mover.id,
        pages:
          page.parentId === mover.id
            ? [{ id: page.node.id, parentId: mover.id, name: page.name, tags: [...page.tags] }]
            : [],
      });
    }
  }
  checks.push(...part.checks);

  // --- the check, the record, the writes in their order, the verify, the record's end.
  const recordInput = recordInputOf(plan, page, target);
  const updateW = part.updateStep ? [{ step: part.updateStep, label: part.updateLabel }] : [];
  const writesInOrder = LEAVING[action]
    ? [...updateW, ...part.factSteps, ...part.noteSteps, ...moveSteps]
    : [...moveSteps, ...part.factSteps, ...part.noteSteps, ...updateW];
  steps.push({ op: EXPECT_STEP, params: { body: { checks } } });
  labels.push('check');
  steps.push({ op: RECORD_STEP, params: { body: { action: 'begin', record: recordInput } } });
  labels.push('record');
  for (const w of writesInOrder) {
    const step =
      w.step.ifMatchFrom?.step === -1 ? { ...w.step, ifMatchFrom: { step: steps.length } } : w.step;
    steps.push(step);
    labels.push(w.label);
  }
  // The page (and a moved index) where the plan puts it, named and tagged as planned.
  verify.unshift({
    kind: 'resource',
    label: target.name,
    resourceId: page.node.id,
    fields: { name: target.name, tags: part.newTags, ...(mover ? {} : { parentId: target.parentId }) },
    ...(placement && !mover ? { placement } : {}),
  });
  if (mover && placement) {
    verify.push({
      kind: 'resource',
      label: mover.name,
      resourceId: mover.id,
      fields: { parentId: target.parentId },
      placement,
    });
  }
  steps.push({ op: VERIFY_STEP, params: { body: { targets: verify } } });
  labels.push('verify');
  steps.push({
    op: RECORD_STEP,
    params: { body: { action: 'complete', record: { flags: [...plan.flags, ...part.noteFlags] } } },
  });
  labels.push('record complete');

  // The state the page moves to, by the prefix it ends with.
  const toState = stateByName(target.name);
  const marker: LifecycleMarker = {
    tool,
    canonical: true,
    pages: [{ id: page.node.id, to: toState }, ...(mover ? [{ id: mover.id, to: null }] : [])],
  };
  const parentNode = ctx.tree.node(pid, target.parentId).data;
  const head: Obj = {
    page: { id: page.node.id, name: page.name, path: page.node.path.names.join(' / ') },
    action: tool,
    newName: target.name,
    newParent: { id: target.parentId, name: parentNode?.rawName ?? target.parentId },
    ...(placement ? { place: { after: placement.after, before: placement.before } } : {}),
    facts: part.factTable.filter((f) => f.change !== 'unchanged'),
    tags: {
      before: page.tags,
      after: part.newTags,
      removed: plan.record.tagsRemoved,
      added: plan.record.tagsAdded,
    },
    ...(part.noteHead ? { note: part.noteHead } : {}),
    ...(mover ? { characterIndex: { id: mover.id, name: mover.name, movesWith: true } } : {}),
    ...(plan.flags.length + part.noteFlags.length ? { flags: [...plan.flags, ...part.noteFlags] } : {}),
    ...(plan.record.resumeOf !== undefined ? { resumes: { recordId: plan.record.resumeOf } } : {}),
  };
  const operation: Obj = {
    tool,
    page: { id: page.node.id, name: page.name },
    pageParts: [
      ...part.pageParts.filter((x) => !x.startsWith('renamed') || part.renameChange),
      ...(moveSteps.length ? [`moved under ${parentNode?.rawName ?? target.parentId}`] : []),
    ].sort((a, b) => PART_ORDER(a) - PART_ORDER(b)),
    summaryLabel: `${tool}: ${page.name} → ${target.name} under ${parentNode?.rawName ?? target.parentId}`,
    lifecycle: head,
  };
  return {
    ok: true,
    value: {
      steps,
      labels,
      marker,
      hold: { resourceId: page.node.id },
      ...(part.holdDocument ? { holdDocument: part.holdDocument } : {}),
      ...(mover ? { holdAlso: { resourceId: mover.id } } : {}),
      head,
      operation,
      writes: writesInOrder.length,
    },
  };
}

/** The order of the page-level summary's parts (as C2c listed them). */
const PART_ORDER = (p: string): number =>
  p.startsWith('renamed')
    ? 0
    : p.startsWith('moved')
      ? 1
      : p.includes('fact write')
        ? 2
        : p === 'tags'
          ? 3
          : p.startsWith('archive note')
            ? 4
            : 5;

/** The lifecycle state a name's prefix says (`[BARC]` archived, `[BWRK]` working, else Authoritative). */
export function stateByName(name: string): 'authoritative' | 'working' | 'archived' {
  const k = classifyName(name).kind;
  return k === 'barc' ? 'archived' : k === 'bwrk' ? 'working' : 'authoritative';
}

/** The record a change writes when its job starts (the page as it is now and the target). */
function recordInputOf(plan: Plan, page: PageNow, target: LifecycleTarget): LifecycleRecordInput {
  return {
    pageId: page.node.id,
    pageName: page.name,
    action: plan.action,
    date: plan.record.date,
    previousState: plan.record.previousState,
    previousParentId: page.parentId,
    previousRank: page.rank,
    previousName: page.name,
    previousPrefix: page.kind === 'unclassified' ? '' : KIND_PREFIX[page.kind as 'bsrc'].trim(),
    previousFacts: plan.record.previousFacts,
    tagsRemoved: plan.record.tagsRemoved,
    tagsAdded: plan.record.tagsAdded,
    ...(target.note?.action === 'insert'
      ? { noteBlockId: target.note.blockId, noteContent: target.note.block ?? null }
      : {}),
    target,
    detail: plan.record.detail,
    ...(plan.record.resumeOf !== undefined ? { resumeOf: plan.record.resumeOf } : {}),
  };
}

/** What one page of a change writes, checks and verifies; the caller places the page (or its set's root). */
export interface PagePart {
  readonly page: PageNow;
  readonly target: LifecycleTarget;
  readonly updateStep: StepSpec | null;
  readonly updateLabel: string;
  readonly renameChange: boolean;
  readonly tagsChange: boolean;
  readonly newTags: string[];
  readonly factSteps: { step: StepSpec; label: string }[];
  readonly noteSteps: { step: StepSpec; label: string }[];
  readonly checks: ExpectCheck[];
  readonly verify: VerifyTarget[];
  readonly holdDocument?: { documentId: string };
  readonly noteHead?: Obj;
  readonly noteFlags: string[];
  readonly factTable: { key: string; before: string | null; after: string | null; change: string }[];
  readonly pageParts: string[];
}

/**
 * One page's part of a change (C2c's plan, shared by the single-page tools and the whole-set ones, C2d): the rename and
 * tags (one write), the lifecycle facts (C2a's planner, in template order for missing rows), and the note (block by
 * block, so it works beside content the whole-document write cannot take back); their in-lock checks and verify targets.
 * Only what differs from the target is written (a resume does only what is left).
 */
export async function planPage(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  c: LifecycleConfig,
  propertyTitle: string,
  page: PageNow,
  target: LifecycleTarget,
  tool: string,
  /** C2d: a set names each page in its step labels and checks (a single page keeps C2c's labels). */
  qualify = false,
): Promise<{ ok: true; value: PagePart } | { ok: false; result: McpToolResult }> {
  const label = page.name;
  const of = (what: string) => (qualify ? `${what} of ${label}` : what);
  const verify: VerifyTarget[] = [];
  const checks: ExpectCheck[] = [];
  const journal = (write: string) => ({ tool, page: { id: page.node.id, name: page.name }, write });

  // --- the rename and the tags (one write).
  const newTags = tagsAfter(page.tags, target.tagsRemove, target.tagsAdd);
  const tagsChange = JSON.stringify(newTags) !== JSON.stringify(page.tags);
  const renameChange = page.name !== target.name;
  const updateBody: Obj = {
    ...(renameChange ? { name: target.name } : {}),
    ...(tagsChange ? { tags: newTags } : {}),
  };
  const updateStep: StepSpec | null =
    Object.keys(updateBody).length > 0
      ? {
          op: 'updateResource',
          params: { path: { resourceId: page.node.id }, body: updateBody },
          journalOperation: journal(renameChange ? `renamed to ${target.name}` : 'tags'),
          // CR-2026-11 (CR-03): the tree re-reads the page once, when the job ends, for all its writes together.
          deferTreeReread: true,
          // RV4 sketch: the page's name and tags as planned, compared inside the lock just before this write (a set's
          // later pages are written minutes after the job's check, and after a hold the check is not repeated).
          expectCurrent: {
            state: 'resource',
            hash: stateHash({ name: page.name, tags: [...page.tags] }),
            label: page.name,
          },
        }
      : null;
  const updateLabel = [
    renameChange ? (qualify ? `rename ${page.name} to ${target.name}` : `rename to ${target.name}`) : '',
    tagsChange ? of('tags') : '',
  ]
    .filter(Boolean)
    .join(' and ');

  // --- the facts (C2a's planner, in template order for missing rows).
  const facts: { key: string; value: Obj[] | null }[] = ROLES.filter(
    (r) => target.facts[r] !== undefined,
  ).map((r) => {
    const v = target.facts[r]!;
    // C2d: as LegendKeeper stores it (lines with breaks between them, none leading or trailing).
    return { key: c.fields[r], value: v === null ? null : rowTextRuns(v) };
  });
  const kv = page.sidebar.filter((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(propertyTitle));
  let factsPlan: FactsPlan | null = null;
  if (facts.length > 0) {
    if (kv.length !== 1) {
      return {
        ok: false,
        result: errorResult(
          {
            code: kv.length === 0 ? 'FACTS_PROPERTY_NOT_FOUND' : 'FACTS_PROPERTY_AMBIGUOUS',
            message: `“${page.name}” has ${kv.length === 0 ? 'no' : kv.length} key-value property titled “${propertyTitle}”, so its lifecycle facts cannot be written; nothing was done.`,
          },
          pd,
        ),
      };
    }
    const existing = new Set((kv[0]!.rows ?? []).map((r) => factKey(r.key)));
    const missing = facts.some((f) => f.value !== null && !existing.has(factKey(f.key)));
    let templateKeys: readonly string[] | null = null;
    if (missing) {
      const t = await templateKeysFor(pd, mctx, ctx, page.node, facts, kv[0]!.rows ?? [], propertyTitle);
      if (!t.ok) return t;
      templateKeys = t.keys;
    }
    try {
      factsPlan = planFacts({
        resourceId: page.node.id,
        sidebar: page.sidebar,
        propertyTitle,
        facts,
        links: [],
        templateKeys,
      });
    } catch (e) {
      if (e instanceof FactsPlanError)
        return { ok: false, result: errorResult({ code: e.code, message: e.message, ...e.details }, pd) };
      throw e;
    }
  }
  const factWrites = (factsPlan?.writes ?? []).filter((w) => w.op !== 'updateProperty');
  const factSteps: { step: StepSpec; label: string }[] = [];
  if (factsPlan && factWrites.length > 0 && factsPlan.property) {
    checks.push({
      label: qualify ? `${label} ${factsPlan.property.title}` : factsPlan.property.title,
      kind: 'propertyRows',
      resourceId: page.node.id,
      propertyId: factsPlan.property.id,
      rows: rowStates(factsPlan.rowsBefore),
    });
    const preImage = page.sidebar.find((p) => p.id === factsPlan.property!.id)?.raw;
    factWrites.forEach((w, i) => {
      factSteps.push({
        step: {
          op: w.op,
          params: w.params,
          // The first reads the rows in the lock and checks them (the rename or move before it may have moved the
          // version on); each after it chains its If-Match from the write before it.
          ...(i > 0 ? { ifMatchFrom: { step: -1 } } : {}),
          expectCurrent: {
            state: 'rows',
            hash: rowsContentHash(rowStates(w.rowsBefore ?? [])),
            label: factsPlan.property!.title,
          },
          deferTreeReread: true,
          journalOperation: journal(w.label),
          ...(i === 0 && preImage ? { journalPreImage: preImage } : {}),
        },
        label: qualify ? `${label}: ${w.label}` : `${w.label}`,
      });
    });
    verify.push({
      kind: 'facts',
      label: page.name,
      resourceId: page.node.id,
      property: {
        title: factsPlan.property.title,
        rows: factsPlan.rowsAfter.map((r) => ({ key: r.key, content: [...r.content] })),
      },
    });
  }

  // --- the note (block-level: works beside content the whole-document write cannot take back).
  const noteSteps: { step: StepSpec; label: string }[] = [];
  let holdDocument: { documentId: string } | undefined;
  const note = target.note;
  let noteHead: Obj | undefined;
  const noteFlags: string[] = [];
  if (note) {
    const read = await liveRead(pd, mctx, tool, 'getDocumentBlocks', {
      path: { resourceId: page.node.id, documentId: note.documentId },
    });
    if (!read.ok) return read;
    const blocks = ((read.value as { blocks?: unknown } | null)?.blocks ?? []) as Obj[];
    const at = blocks.findIndex((b) => b.id === note.blockId);
    if (note.action === 'insert' && at < 0) {
      const first = (blocks[0]?.id as string | undefined) ?? null;
      checks.push({
        label: `${page.name} note`,
        kind: 'block',
        resourceId: page.node.id,
        documentId: note.documentId,
        blockId: first,
        ...(first ? { first: true } : { empty: true }),
      });
      noteSteps.push({
        step: {
          op: 'insertBlock',
          params: {
            path: { resourceId: page.node.id, documentId: note.documentId },
            body: { block: note.block, ...(first ? { before: first } : {}) },
          },
          journalOperation: journal('the archive note, as the first block'),
        },
        label: of('insert the archive note'),
      });
      holdDocument = { documentId: note.documentId };
      noteHead = { action: 'insert', blockId: note.blockId, diff: `+ ${noteText(note.block ?? {})}` };
    }
    if (note.action === 'remove' && at < 0)
      noteFlags.push(
        `${qualify ? `${label}: ` : ''}the archive note is no longer on the page; nothing to remove`,
      );
    if (note.action === 'remove' && at >= 0) {
      const unchanged = note.block !== undefined && compareStoredBlocks([note.block], [blocks[at]], 1).ok;
      if (!unchanged) {
        noteFlags.push(
          `${qualify ? `${label}: ` : ''}the archive note was edited after archiving, so it is KEPT on the page (only an unchanged note is removed); remove or change it by hand`,
        );
      }
      if (unchanged) {
        checks.push({
          label: `${page.name} note`,
          kind: 'block',
          resourceId: page.node.id,
          documentId: note.documentId,
          blockId: note.blockId,
          content: note.block,
        });
        noteSteps.push({
          step: {
            op: 'deleteBlock',
            params: {
              path: { resourceId: page.node.id, documentId: note.documentId, blockId: note.blockId },
            },
            journalOperation: journal('the archive note removed'),
          },
          label: of('remove the archive note'),
        });
        holdDocument = { documentId: note.documentId };
        noteHead = { action: 'remove', blockId: note.blockId, diff: `- ${noteText(note.block)}` };
        verify.push({
          kind: 'block',
          label: `${page.name} note`,
          resourceId: page.node.id,
          documentId: note.documentId,
          blockId: note.blockId,
          present: false,
        });
      }
    }
    if (note.action === 'insert') {
      verify.push({
        kind: 'block',
        label: `${page.name} note`,
        resourceId: page.node.id,
        documentId: note.documentId,
        blockId: note.blockId,
        present: true,
        first: true,
        content: note.block as Obj,
      });
    }
  }

  const factTable = ROLES.filter((r) => target.facts[r] !== undefined).map((r) => {
    const before = factsOf(c, propertyTitle, page.sidebar)[r];
    const after = target.facts[r] ?? null;
    return {
      key: c.fields[r],
      before,
      after,
      change:
        same(before, after) && (before === null) === (after === null)
          ? 'unchanged'
          : before === null
            ? 'added'
            : after === null
              ? 'removed'
              : 'changed',
    };
  });
  return {
    ok: true,
    value: {
      page,
      target,
      updateStep,
      updateLabel,
      renameChange,
      tagsChange,
      newTags,
      factSteps,
      noteSteps,
      checks,
      verify,
      ...(holdDocument ? { holdDocument } : {}),
      ...(noteHead ? { noteHead } : {}),
      noteFlags,
      factTable,
      pageParts: [
        ...(renameChange ? [`renamed to ${target.name}`] : []),
        ...(factWrites.length
          ? [`${factWrites.length} fact write${factWrites.length === 1 ? '' : 's'}`]
          : []),
        ...(tagsChange ? ['tags'] : []),
        ...(noteSteps.length
          ? [noteHead?.action === 'insert' ? 'archive note added' : 'archive note removed']
          : []),
      ],
    },
  };
}

export function noteText(block: Readonly<Record<string, unknown>>): string {
  const content = Array.isArray(block.content) ? (block.content as Obj[]) : [];
  return content.map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
}

// ============================================================================================ related pages (Part 4)

async function relatedPages(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  tool: string,
  page: PageNow,
): Promise<Obj> {
  const lc = pd.services?.lifecycle;
  const fromIndex = lc ? lc.related(ctx.projectId, page.node.id) : null;
  const known = new Set((fromIndex?.pages ?? []).map((p) => p.id));
  // One content search for the page's display name, for text mentions the index may not hold yet.
  const textHits: Obj[] = [];
  const s = await liveRead(pd, mctx, tool, 'search', {
    query: { q: page.displayName.slice(0, 500), limit: 25 },
  });
  if (s.ok) {
    const data = ((s.value as { data?: unknown } | null)?.data ?? []) as Obj[];
    const seen = new Set<string>();
    for (const hit of data) {
      const res = (hit.resource ?? {}) as Obj;
      const id = typeof res.id === 'string' ? res.id : null;
      if (!id || id === page.node.id || known.has(id) || seen.has(id)) continue;
      seen.add(id);
      const n = ctx.tree.node(ctx.projectId, id).data;
      if (!n) continue; // outside the AI REPOSITORY
      textHits.push({
        id,
        name: n.rawName,
        path: n.path.names.join(' / '),
        found: 'found by text search (may be incomplete)',
      });
    }
  }
  return {
    pages: (fromIndex?.pages ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      links: p.links.map((l) =>
        l.kind === 'collection' ? `link collection “${l.via}”` : `mentions it in “${l.via}”`,
      ),
    })),
    textSearch: textHits,
    freshness: fromIndex?.freshness.text ?? 'the link index is not running',
    note: 'Related pages are reported, never edited: check each one and change it yourself if it should no longer depend on this page.',
    ...(s.ok ? {} : { textSearchFailed: true }),
  };
}

// ============================================================================================ the tools

export const dryRunArg = z
  .boolean()
  .optional()
  .describe(
    'Show the plan (move, name, facts, tags, note, related pages); capture nothing and write nothing.',
  );

export const CANON_NOTE =
  'ALWAYS needs the owner’s canonical approval, whatever your scope: the call returns proposal_captured with ' +
  'requiresCanonicalApproval; never retry it, follow it with bridge_proposal_status. A call on a page whose earlier ' +
  'change of the same kind stopped part-way resumes it (only what is left). Every check is made again when it runs.';

interface Common {
  readonly page: string;
  readonly dryRun?: boolean | undefined;
  readonly project?: string | undefined;
}

/** The parts every tool shares: the page, the lifecycle indexes, the settings, the record, the claim. */
async function runLifecycle(
  deps: ToolDeps,
  mctx: McpToolContext,
  action: LifecycleAction,
  args: Common & Obj,
  planFor: (
    pd: ProjectDeps,
    ctx: RepoCtx,
    c: LifecycleConfig,
    idx: { working: TreeNode; archived: TreeNode },
    page: PageNow,
    o: { readonly propertyTitle: string; readonly date: string; readonly incomplete: LifecycleRecord | null },
  ) => Plan | Answer,
): Promise<McpToolResult> {
  const tool = TOOL[action];
  return withProject(deps, args.project, 'write', async (pd) => {
    const rc = repoContext(pd);
    if (!rc.ok) return rc.result;
    const ctx = rc.ctx;
    const lc = pd.services?.lifecycle;
    if (!lc)
      return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'The page lifecycle is not available.' }, pd);
    const r = resolvePage(ctx, args.page);
    if (!r.ok) return r.result;
    const node = r.node;
    return withRequest(
      pd,
      mctx,
      tool,
      { ...args, dryRun: args.dryRun },
      { key: `lifecycle:${node.id}`, label: `a lifecycle change of “${node.rawName}”` },
      async (): Promise<CreateOutcome> => {
        const c = lc.config(ctx.projectId);
        const idx = lifecycleIndexes(c, (id) => ctx.tree.node(ctx.projectId, id).data);
        if (!idx.ok) return refuse(pd, idx.code, idx.message);
        if (node.kind === 'root')
          return refuse(
            pd,
            'ROOT_PAGE',
            'The AI REPOSITORY page itself has no lifecycle. Name a page inside it.',
          );
        if (node.id === idx.working.id || node.id === idx.archived.id) {
          return refuse(
            pd,
            'LIFECYCLE_INDEX',
            `“${node.rawName}” is a lifecycle index itself: it has no lifecycle of its own and the tools never change it (the owner edits [INDEX] Working and [INDEX] Archived by hand). Name the page, or a character’s own [INDEX], instead.`,
          );
        }
        // A change of this page that stopped part-way: the same tool resumes it; another waits for it.
        const incomplete = lc.store.incomplete(ctx.projectId, node.id);
        // C2d: a page of a whole-set change that stopped part-way: the set is resumed as a whole, on its root.
        const ofSet = incomplete?.setId ? lc.store.set(ctx.projectId, incomplete.setId) : null;
        if (incomplete && ofSet) {
          return refuse(
            pd,
            'LIFECYCLE_INCOMPLETE',
            `“${node.rawName}” is part of a whole-set ${TOOL[ofSet.action]} that stopped part-way (set record ${ofSet.id}, root “${ofSet.rootName}”); call ${TOOL[ofSet.action]} with subtree: true on ${ofSet.rootId} to finish it first. Nothing was done.`,
            { setId: ofSet.id, root: { id: ofSet.rootId, name: ofSet.rootName }, action: TOOL[ofSet.action] },
          );
        }
        if (incomplete) {
          const job = incomplete.jobId ? pd.engine.queries.getJob(ctx.projectId, incomplete.jobId) : null;
          if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
            return refuse(
              pd,
              'LIFECYCLE_IN_PROGRESS',
              `${TOOL[incomplete.action]} of “${node.rawName}” is still running (job ${job.id}); nothing was done. Follow it with bridge_job_status.`,
              { jobId: job.id, recordId: incomplete.id },
            );
          }
          if (incomplete.action !== action) {
            return refuse(
              pd,
              'LIFECYCLE_INCOMPLETE',
              `${TOOL[incomplete.action]} of “${node.rawName}” stopped part-way (record ${incomplete.id}); call ${TOOL[incomplete.action]} again to finish it first. Nothing was done.`,
              { recordId: incomplete.id, action: TOOL[incomplete.action] },
            );
          }
        }
        const read = await readPage(pd, mctx, tool, node);
        if (!read.ok) return { kind: 'answer', result: read.result };
        const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
        const propertyTitle =
          typeof settings.factsPropertyName === 'string' && settings.factsPropertyName.trim() !== ''
            ? settings.factsPropertyName
            : 'PROPERTIES';
        const date = incomplete?.date ?? isoDate(Date.now());
        const planned = planFor(pd, ctx, c, idx, read.value, { propertyTitle, date, incomplete });
        if ('kind' in planned) return planned;
        const o2 = { resume: planned.record.resumeOf !== undefined };
        const built = await build(pd, mctx, ctx, c, propertyTitle, planned);
        if (!built.ok) return { kind: 'answer', result: built.result };
        const b = built.value;
        const related =
          action === 'archive' || action === 'move_to_working'
            ? await relatedPages(pd, mctx, ctx, tool, read.value)
            : undefined;
        const head = { ...b.head, ...(related ? { relatedPages: related } : {}) };
        if (b.writes === 0 && !o2.resume) {
          return {
            kind: 'answer',
            result: errorResult(
              {
                code: 'NOTHING_TO_DO',
                message: `“${node.rawName}” already is as ${tool} would leave it; nothing was proposed.`,
                ...head,
              },
              pd,
            ),
          };
        }
        if (args.dryRun === true) {
          return {
            kind: 'answer',
            result: render(
              {
                ...head,
                status: 'dry_run',
                steps: b.labels.filter((l) => !['check', 'record', 'verify', 'record complete'].includes(l)),
                requiresCanonicalApproval: true,
                message:
                  'Dry run: nothing was written and nothing was proposed. Run without dryRun to propose it: it always needs the owner’s canonical approval.',
              },
              pd,
            ),
          };
        }
        const summary = `${tool}: ${node.rawName} → ${String(b.head.newName)}`;
        const out = await runWriteJob(pd, mctx, tool, {
          steps: b.steps,
          labels: b.labels,
          title: summary,
          holdLock: b.hold,
          ...(b.holdDocument ? { holdDocument: b.holdDocument } : {}),
          ...(b.holdAlso ? { holdAlso: b.holdAlso } : {}),
          lifecycle: b.marker,
          proposal: {
            operations: [{ ...b.operation, ...(related ? { relatedPages: related } : {}) }],
            summary,
            prefetched: [{ op: 'getResource', path: { resourceId: node.id }, body: read.value.raw }],
          },
          head: {
            ...head,
            recordId:
              'assigned when the change runs (bridge_proposal_status, then bridge_job_status, show it)',
          },
          preview: () => ({ page: (head as Obj).page, newName: (head as Obj).newName }),
        });
        return { kind: 'job', head, labels: b.labels, ...out };
      },
    );
  });
}

/** The archive target of a page in a state (`from`), with a new note. */
export function archiveTarget(
  c: LifecycleConfig,
  page: PageNow,
  facts: LifecycleFacts,
  from: 'authoritative' | 'working',
  archiveId: string,
  date: string,
  doc: { id: string },
): LifecycleTarget {
  const block = {
    id: mintClientId(),
    kind: 'paragraph',
    content: [
      {
        text: fillText(from === 'authoritative' ? c.texts.noteFromAuthoritative : c.texts.noteFromWorking, {
          date,
          source: page.displayName,
        }),
      },
    ],
  };
  return {
    name: `${KIND_PREFIX.barc}${page.displayName}`,
    parentId: archiveId,
    facts: {
      status: c.status.archived,
      continuityType: c.continuityTypes.nonCurrent,
      scope: archivedScope(c, facts.scope ?? ''),
      temporalScope: fillText(
        from === 'authoritative' ? c.texts.temporalFromAuthoritative : c.texts.temporalFromWorking,
        { date },
      ),
      lastMajorRevision: date,
    },
    tagsRemove: [from === 'authoritative' ? c.tags.canon : c.tags.working],
    tagsAdd: [c.tags.archived],
    note: { action: 'insert', blockId: block.id, documentId: doc.id, block },
  };
}

/** A page's lifecycle state by its prefix, and whether its Status says another one (an inconsistent page). */
export function stateOf(
  c: LifecycleConfig,
  page: PageNow,
  facts: LifecycleFacts,
): { state: LifecycleState | null; conflict: string | null } {
  const state: LifecycleState | null =
    page.kind === 'bsrc'
      ? 'authoritative'
      : page.kind === 'bwrk'
        ? 'working'
        : page.kind === 'barc'
          ? 'archived'
          : null;
  if (!state || facts.status === null || facts.status.trim() === '') return { state, conflict: null };
  const says: LifecycleState | null = same(facts.status, c.status.authoritative)
    ? 'authoritative'
    : same(facts.status, c.status.working)
      ? 'working'
      : same(facts.status, c.status.archived)
        ? 'archived'
        : null;
  return {
    state,
    conflict:
      says !== null && says !== state
        ? `“${page.name}” is ${KIND_PREFIX[page.kind as 'bsrc'].trim()} but its ${c.fields.status} is ${facts.status}: its lifecycle state is unclear (the lifecycle-consistency audit reports such pages). Make them agree by hand first; nothing was done.`
        : null,
  };
}

function subpageRefusal(pd: ProjectDeps, ctx: RepoCtx, node: TreeNode, tool: string): Answer | null {
  const kids = ctx.tree.children(ctx.projectId, node.id).data;
  if (kids.length === 0) return null;
  return refuse(
    pd,
    'HAS_SUBPAGES',
    `“${node.rawName}” has ${kids.length} page${kids.length === 1 ? '' : 's'} under it, so ${tool} refuses it (a lifecycle change of one page moves that page alone). To change the whole set together, pass subtree: true; otherwise move or change them first.`,
    { subpages: kids.slice(0, 50).map((k) => ({ id: k.id, name: k.rawName })) },
  );
}

/** C2d (ADR 0037): the whole set (`subtree: true`); a hand-archived page's arguments are for a single page only. */
function runSubtree(
  deps: ToolDeps,
  mctx: McpToolContext,
  action: LifecycleAction,
  args: Common & {
    readonly destination?: string | undefined;
    readonly previousState?: unknown;
    readonly restore?: unknown;
  },
): McpToolResult | Promise<McpToolResult> {
  if (args.previousState !== undefined || args.restore !== undefined) {
    return withProject(deps, args.project, 'write', (pd) =>
      errorResult(
        {
          code: 'INVALID_ARGUMENTS',
          message:
            'previousState and restore are for one page archived by hand; a set is unarchived from the record of its archiving (subtree: true takes neither). Nothing was done.',
        },
        pd,
      ),
    );
  }
  return runSet(deps, mctx, action, args);
}

function archivePageTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'archive_page',
    title: 'Archive a page',
    access: 'write',
    description:
      'Retires an Authoritative [BSRC] or Working [BWRK] page to [INDEX] Archived as [BARC]: moves, renames and re-tags it, adds a dated note at the top of its page document, and sets Status Archived, Continuity Type NON-CURRENT and Scope. Use it to retire a design, not delete_resource. A page with pages under it is refused unless `subtree: true`, which archives the whole set (a character’s index, Core and specialist pages) as ONE proposal. ALWAYS a proposal that only the owner can accept as canon, whatever your scope; never retry it, follow it with bridge_proposal_status. Lists the pages that link to it (never edited): tell the person. dryRun shows the whole plan. A change that stopped part-way resumes when you call the same tool again. Cost: about 6 reads to propose; the job about 15 reads and 8 writes once approved.',
    inputSchema: z.object({
      page: pageRef.describe('The page to archive (name or id); with subtree, the root of the set.'),
      subtree: subtreeArg,
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      args.subtree === true
        ? runSubtree(deps, mctx, 'archive', args)
        : runLifecycle(deps, mctx, 'archive', args, (pd, ctx, c, idx, page, o) => {
            const facts = factsOf(c, o.propertyTitle, page.sidebar);
            const rec = o.incomplete;
            if (!rec) {
              if (page.kind === 'index')
                return refuse(
                  pd,
                  'INDEX_PAGE',
                  `“${page.name}” is an index: archive_page takes a page. To archive a whole character (its index and all its pages) pass subtree: true on its [INDEX].`,
                );
              if (page.kind === 'barc')
                return refuse(
                  pd,
                  'ALREADY_ARCHIVED',
                  `“${page.name}” is already archived. unarchive_page puts it back; nothing else to do.`,
                );
              if (page.kind !== 'bsrc' && page.kind !== 'bwrk') {
                return refuse(
                  pd,
                  'NOT_LIFECYCLE_PAGE',
                  `“${page.name}” is neither an Authoritative [BSRC] page nor a Working [BWRK] page, so archive_page does not take it (an unclassified page is the owner’s to sort out: tell the person).`,
                );
              }
              const st = stateOf(c, page, facts);
              if (st.conflict) return refuse(pd, 'LIFECYCLE_INCONSISTENT', st.conflict);
            }
            const sub = subpageRefusal(pd, ctx, page.node, 'archive_page');
            if (sub) return sub;
            const from: 'authoritative' | 'working' = rec
              ? rec.previousState === 'working'
                ? 'working'
                : 'authoritative'
              : page.kind === 'bwrk'
                ? 'working'
                : 'authoritative';
            let target: LifecycleTarget;
            if (rec) target = rec.target;
            else {
              const doc = mainDocument(page);
              if (!doc) {
                return refuse(
                  pd,
                  'NO_PAGE_DOCUMENT',
                  `“${page.name}” has no page document for the archive note; nothing was done.`,
                );
              }
              target = archiveTarget(c, page, facts, from, idx.archived.id, o.date, doc);
            }
            const twin = ctx.tree
              .children(ctx.projectId, target.parentId)
              .data.find(
                (x) =>
                  x.id !== page.node.id && isPageKind(x.kind) && key(x.displayName) === key(page.displayName),
              );
            if (twin) {
              return refuse(
                pd,
                'NAME_TAKEN',
                `[INDEX] ${c.indexNames.archived} already holds “${twin.rawName}”; rename one of them first.`,
                {
                  existing: { id: twin.id, name: twin.rawName },
                },
              );
            }
            return {
              action: 'archive',
              tool: 'archive_page',
              page,
              target,
              record: {
                previousState: rec ? rec.previousState : from,
                previousFacts: rec ? rec.previousFacts : facts,
                tagsRemoved: target.tagsRemove.filter(
                  (t) => page.tags.some((x) => same(x, t)) || rec !== null,
                ),
                tagsAdded: target.tagsAdd,
                date: o.date,
                detail: {},
                ...(rec ? { resumeOf: rec.id } : {}),
              },
              flags: [],
            };
          }),
  });
}

function unarchivePageTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'unarchive_page',
    title: 'Unarchive a page',
    access: 'write',
    description:
      'Reverses an archiving from the bridge’s lifecycle record: the page goes back to its previous place and state (formerly Authoritative: [BSRC] with its old Status, Continuity Type and Scope; formerly Working: [BWRK]); the archive note is removed if it was not edited. If the old place is gone give `destination`; a page archived by hand needs `destination`, `previousState` and `restore`. `subtree: true` unarchives a whole archived set as ONE proposal. ALWAYS a proposal that only the owner can accept as canon, whatever your scope; never retry it, follow it with bridge_proposal_status. dryRun shows the plan. Cost: about 4 reads to propose; the job about 15 reads and 7 writes once approved.',
    inputSchema: z.object({
      page: pageRef.describe('The [BARC] page (name or id); with subtree, the root of the archived set.'),
      subtree: subtreeArg,
      destination: pageRef
        .optional()
        .describe(
          'Where it goes back (an index), when its previous parent cannot be used (a page unarchived alone from inside an archived set always needs it).',
        ),
      previousState: z
        .enum(['authoritative', 'working'])
        .optional()
        .describe('A page archived by hand: the state it goes back to.'),
      restore: z
        .object({
          continuityType: z.string().max(256),
          scope: z.string().max(4000),
          temporalScope: z.string().max(1000),
          status: z.string().max(256).optional(),
        })
        .strict()
        .optional()
        .describe(
          'A page archived by hand: the values to restore (Status follows previousState unless given).',
        ),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      args.subtree === true
        ? runSubtree(deps, mctx, 'unarchive', args)
        : runLifecycle(deps, mctx, 'unarchive', args, (pd, ctx, c, idx, page, o) => {
            const lc = pd.services!.lifecycle!;
            const flags: string[] = [];
            const facts = factsOf(c, o.propertyTitle, page.sidebar);
            if (o.incomplete) {
              // Resume: the same target, re-planned from the page as it is now.
              return {
                action: 'unarchive',
                tool: 'unarchive_page',
                page,
                target: o.incomplete.target,
                record: {
                  previousState: o.incomplete.previousState,
                  previousFacts: o.incomplete.previousFacts,
                  tagsRemoved: o.incomplete.tagsRemoved,
                  tagsAdded: o.incomplete.tagsAdded,
                  date: o.date,
                  detail: {},
                  resumeOf: o.incomplete.id,
                },
                flags,
              };
            }
            if (page.kind !== 'barc') {
              return refuse(
                pd,
                'NOT_ARCHIVED',
                `“${page.name}” is not an Archived [BARC] page, so there is nothing to unarchive. To rework a canon page use move_to_working; to retire a page use archive_page.`,
              );
            }
            const sub = subpageRefusal(pd, ctx, page.node, 'unarchive_page');
            if (sub) return sub;
            const last = lc.store.latest(ctx.projectId, page.node.id, ['archive', 'unarchive']);
            const rec = last && last.action === 'archive' && last.state === 'complete' ? last : null;
            let state: 'authoritative' | 'working';
            let restore: LifecycleFacts;
            let parentId: string;
            let note: LifecycleTarget['note'];
            const destination = (q: string | undefined, why: string): TreeNode | Answer => {
              if (q === undefined) {
                return refuse(
                  pd,
                  'DESTINATION_REQUIRED',
                  `${why} Give \`destination\`: the index it goes back under.`,
                );
              }
              const d = resolveParent(ctx, q, { what: `the destination “${q}”` });
              if (!d.ok) return { kind: 'answer', result: d.result };
              if (
                d.value.id === idx.working.id ||
                d.value.id === idx.archived.id ||
                d.value.path.ids.includes(idx.working.id) ||
                d.value.path.ids.includes(idx.archived.id)
              ) {
                return refuse(
                  pd,
                  'LIFECYCLE_AREA',
                  `“${d.value.displayName}” is a lifecycle index or under one; an Authoritative page goes back to its normal place.`,
                );
              }
              return d.value;
            };
            if (rec) {
              state = rec.previousState === 'working' ? 'working' : 'authoritative';
              restore = rec.previousFacts;
              if (state === 'working') {
                // C2d.1: back where it came from when that is an [INDEX] inside a Working set that is still there
                // (a Working character's own index, say), else under [INDEX] Working.
                const was = rec.previousParentId
                  ? ctx.tree.node(ctx.projectId, rec.previousParentId).data
                  : null;
                parentId =
                  was && was.kind === 'index' && was.path.ids.includes(idx.working.id)
                    ? was.id
                    : idx.working.id;
              } else {
                const prev = rec.previousParentId
                  ? ctx.tree.node(ctx.projectId, rec.previousParentId).data
                  : null;
                const usable =
                  prev &&
                  prev.kind !== 'root' &&
                  prev.id !== idx.working.id &&
                  prev.id !== idx.archived.id &&
                  !prev.path.ids.includes(idx.working.id) &&
                  !prev.path.ids.includes(idx.archived.id);
                if (args.destination !== undefined || !usable) {
                  const d = destination(
                    args.destination,
                    `Its previous parent (${rec.previousParentId ?? 'none'}) is gone, outside the repository or not usable.`,
                  );
                  if ('result' in d) return d;
                  parentId = d.id;
                  if (usable && d.id !== prev.id)
                    flags.push(
                      `returns under ${d.rawName}, not its previous parent ${prev.rawName}, as asked`,
                    );
                } else parentId = prev.id;
              }
              // The note: removed only if it is still exactly what was inserted.
              const noteDoc = rec.target.note?.documentId ?? null;
              if (rec.noteBlockId && noteDoc && rec.noteContent) {
                // Checked against the document when the job is built: removed only if it is still exactly as inserted.
                note = {
                  action: 'remove',
                  blockId: rec.noteBlockId,
                  documentId: noteDoc,
                  block: rec.noteContent as Obj,
                };
              }
              // Scope: edited after archiving when it is no longer the archive prefix plus the original.
              const expected = archivedScope(c, rec.previousFacts.scope ?? '');
              if (facts.scope !== null && !same(facts.scope, expected)) {
                flags.push(
                  `Scope was edited after archiving (it is “${facts.scope}”); the recorded original “${rec.previousFacts.scope ?? ''}” is restored`,
                );
              }
            } else {
              // Archived by hand: the agent supplies what the record would have held.
              const missing = [
                ...(args.previousState === undefined ? ['previousState'] : []),
                ...(args.restore === undefined ? ['restore (continuityType, scope, temporalScope)'] : []),
                ...(args.previousState !== 'working' && args.destination === undefined
                  ? ['destination']
                  : []),
              ];
              if (missing.length > 0) {
                return refuse(
                  pd,
                  'NO_LIFECYCLE_RECORD',
                  `The bridge has no record of archiving “${page.name}” (it was archived by hand), so it cannot know what to restore. Give: ${missing.join(', ')}. Nothing was done.`,
                  { missing },
                );
              }
              state = args.previousState!;
              restore = {
                status:
                  args.restore!.status ?? (state === 'working' ? c.status.working : c.status.authoritative),
                continuityType: args.restore!.continuityType,
                scope: args.restore!.scope,
                temporalScope: args.restore!.temporalScope,
                lastMajorRevision: null,
              };
              if (state === 'working') parentId = idx.working.id;
              else {
                const d = destination(args.destination, 'A page archived by hand has no recorded parent.');
                if ('result' in d) return d;
                parentId = d.id;
              }
              flags.push(
                'archived by hand: no archive note is known, so none is removed (remove it by hand if there is one)',
              );
            }
            const kind = state === 'working' ? 'bwrk' : 'bsrc';
            const target: LifecycleTarget = {
              name: `${KIND_PREFIX[kind]}${page.displayName}`,
              parentId,
              facts: {
                status: state === 'working' ? c.status.working : (restore.status ?? null),
                continuityType: restore.continuityType,
                scope: restore.scope,
                temporalScope: restore.temporalScope,
                lastMajorRevision: o.date,
              },
              tagsRemove: [c.tags.archived],
              tagsAdd: [state === 'working' ? c.tags.working : c.tags.canon],
              ...(note ? { note } : {}),
            };
            const twin = ctx.tree
              .children(ctx.projectId, parentId)
              .data.find(
                (x) =>
                  x.id !== page.node.id && isPageKind(x.kind) && key(x.displayName) === key(page.displayName),
              );
            if (twin) {
              return refuse(
                pd,
                'NAME_TAKEN',
                `The destination already holds “${twin.rawName}”; give another \`destination\`.`,
                {
                  existing: { id: twin.id, name: twin.rawName },
                },
              );
            }
            return {
              action: 'unarchive',
              tool: 'unarchive_page',
              page,
              target,
              record: {
                previousState: 'archived',
                previousFacts: facts,
                tagsRemoved: target.tagsRemove.filter((t) => page.tags.some((x) => same(x, t))),
                tagsAdded: target.tagsAdd,
                date: o.date,
                detail: rec ? { archiveRecord: rec.id } : { handArchived: true },
              },
              flags,
            };
          }),
  });
}

function moveToWorkingTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'move_to_working',
    title: 'Move a page back to Working',
    access: 'write',
    description:
      'Takes an Authoritative [BSRC] page back to Working for rework: moves it under [INDEX] Working as [BWRK], Status Working, tag CANON swapped for Working. The record keeps where it was (promote_page offers it as the destination). `subtree: true` moves a whole Authoritative set as ONE proposal; a Character Core under its own index moves alone. Lists the pages that link to it (never edited). ALWAYS a proposal that only the owner can accept as canon, whatever your scope; never retry it, follow it with bridge_proposal_status. dryRun shows the plan. Cost: about 3 reads to propose; the job about 11 reads and 3 writes once approved.',
    inputSchema: z.object({
      page: pageRef.describe('The [BSRC] page (name or id); with subtree, the root of the set.'),
      subtree: subtreeArg,
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      args.subtree === true
        ? runSubtree(deps, mctx, 'move_to_working', args)
        : runLifecycle(deps, mctx, 'move_to_working', args, (pd, ctx, c, idx, page, o) => {
            const facts = factsOf(c, o.propertyTitle, page.sidebar);
            const rec = o.incomplete;
            if (!rec) {
              if (page.kind !== 'bsrc') {
                return refuse(
                  pd,
                  'NOT_AUTHORITATIVE',
                  `“${page.name}” is not an Authoritative [BSRC] page; move_to_working takes only those. A Working page is already Working (promote_page makes it canon); an Archived one comes back with unarchive_page.`,
                );
              }
              const st = stateOf(c, page, facts);
              if (st.conflict) return refuse(pd, 'LIFECYCLE_INCONSISTENT', st.conflict);
            }
            const sub = subpageRefusal(pd, ctx, page.node, 'move_to_working');
            if (sub) return sub;
            const flags: string[] = [];
            const parent = page.parentId ? ctx.tree.node(ctx.projectId, page.parentId).data : null;
            const role = pd.services?.registry.forProject(ctx.projectId).characterRole(page.node.id) ?? null;
            if (
              role?.role === 'core' &&
              parent &&
              parent.kind === 'index' &&
              key(parent.displayName) === key(role.subject)
            ) {
              flags.push(
                `a Character Core under its own character index: the Core moves alone; ${parent.rawName} and its other pages stay where they are, and promote_page offers it as the way back`,
              );
            }
            const target: LifecycleTarget = rec
              ? rec.target
              : {
                  name: `${KIND_PREFIX.bwrk}${page.displayName}`,
                  parentId: idx.working.id,
                  facts: { status: c.status.working },
                  tagsRemove: [c.tags.canon],
                  tagsAdd: [c.tags.working],
                };
            const twin = ctx.tree
              .children(ctx.projectId, idx.working.id)
              .data.find(
                (x) =>
                  x.id !== page.node.id && isPageKind(x.kind) && key(x.displayName) === key(page.displayName),
              );
            if (twin) {
              return refuse(
                pd,
                'NAME_TAKEN',
                `[INDEX] ${c.indexNames.working} already holds “${twin.rawName}”.`,
                {
                  existing: { id: twin.id, name: twin.rawName },
                },
              );
            }
            return {
              action: 'move_to_working',
              tool: 'move_to_working',
              page,
              target,
              record: {
                previousState: rec ? rec.previousState : 'authoritative',
                previousFacts: rec ? rec.previousFacts : facts,
                tagsRemoved: rec
                  ? rec.tagsRemoved
                  : target.tagsRemove.filter((t) => page.tags.some((x) => same(x, t))),
                tagsAdded: target.tagsAdd,
                date: o.date,
                detail: {},
                ...(rec ? { resumeOf: rec.id } : {}),
              },
              flags,
            };
          }),
  });
}

function promotePageTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'promote_page',
    title: 'Promote a Working page',
    access: 'write',
    description:
      'Makes a Working [BWRK] page Authoritative (canon): moves it to `destination` (required, an [INDEX]; a dry run suggests where it was before move_to_working), renames it [BSRC], sets Status Authoritative and Last Major Revision, swaps the Working tag for CANON. A Working character’s Core takes its [INDEX] with it. `subtree: true` promotes a whole Working set (a character’s index and all its pages) as ONE proposal; any page of that character left flat under [INDEX] Working is listed as an outsider: move_resource it into the set first. This is the only way to make a page canon: never set Status to Authoritative with set_facts. ALWAYS a proposal that only the owner can accept as canon, whatever your scope; never retry it, follow it with bridge_proposal_status. dryRun shows the plan. Cost: about 2 reads to propose; the job about 11 reads and 5 writes once approved.',
    inputSchema: z.object({
      page: pageRef.describe('The [BWRK] page (name or id); with subtree, the root of the Working set.'),
      subtree: subtreeArg,
      destination: pageRef
        .optional()
        .describe('The index it (or the set’s root) goes under (required; normally its normal place).'),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      args.subtree === true
        ? runSubtree(deps, mctx, 'promote', args)
        : runLifecycle(deps, mctx, 'promote', args, (pd, ctx, c, idx, page, o) => {
            const lc = pd.services!.lifecycle!;
            const facts = factsOf(c, o.propertyTitle, page.sidebar);
            const rec = o.incomplete;
            if (rec) {
              return {
                action: 'promote',
                tool: 'promote_page',
                page,
                target: rec.target,
                record: {
                  previousState: rec.previousState,
                  previousFacts: rec.previousFacts,
                  tagsRemoved: rec.tagsRemoved,
                  tagsAdded: rec.tagsAdded,
                  date: o.date,
                  detail: {},
                  resumeOf: rec.id,
                },
                flags: [],
              };
            }
            if (page.kind !== 'bwrk') {
              return refuse(
                pd,
                'NOT_WORKING',
                `“${page.name}” is not a Working [BWRK] page; promote_page takes only those. An Authoritative page is already canon; an Archived one comes back with unarchive_page (then move_to_working if it needs rework).`,
              );
            }
            const st = stateOf(c, page, facts);
            if (st.conflict) return refuse(pd, 'LIFECYCLE_INCONSISTENT', st.conflict);
            // The location move_to_working remembered, offered (never used without being asked).
            const back = lc.store.latest(ctx.projectId, page.node.id, ['move_to_working']);
            const prev =
              back?.state === 'complete' && back.previousParentId
                ? ctx.tree.node(ctx.projectId, back.previousParentId).data
                : null;
            const suggested = prev
              ? { id: prev.id, name: prev.rawName, path: prev.path.names.join(' / ') }
              : null;
            if (args.destination === undefined) {
              return refuse(
                pd,
                'DESTINATION_REQUIRED',
                `promote_page needs \`destination\`: the index “${page.displayName}” goes under.${suggested ? ` It was under ${suggested.name} (${suggested.path}) before move_to_working: pass destination “${suggested.id}” to take it back there.` : ''}`,
                { ...(suggested ? { suggestedDestination: suggested } : {}) },
              );
            }
            const d = resolveParent(ctx, args.destination, { what: `the destination “${args.destination}”` });
            if (!d.ok) return { kind: 'answer', result: d.result };
            const dest = d.value;
            if ([idx.working.id, idx.archived.id].some((x) => dest.id === x || dest.path.ids.includes(x))) {
              return refuse(
                pd,
                'LIFECYCLE_AREA',
                `“${dest.displayName}” is a lifecycle index or under one; an Authoritative page goes in its normal place.`,
              );
            }
            // A Working character: its own index under [INDEX] Working moves with it.
            let mover: LifecycleTarget['moveIndex'] = null;
            const flags: string[] = [];
            const parent = page.parentId ? ctx.tree.node(ctx.projectId, page.parentId).data : null;
            const others: { id: string; name: string }[] = [];
            if (parent && parent.kind === 'index' && parent.parentId === idx.working.id) {
              mover = { id: parent.id, name: parent.rawName, parentId: idx.working.id };
            } else if (page.parentId === idx.working.id) {
              const role =
                pd.services?.registry.forProject(ctx.projectId).characterRole(page.node.id) ?? null;
              if (role && (role.role === 'core' || role.role === 'compact')) {
                const ci = ctx.tree
                  .children(ctx.projectId, idx.working.id)
                  .data.find((x) => x.kind === 'index' && key(x.displayName) === key(role.subject));
                if (ci) mover = { id: ci.id, name: ci.rawName, parentId: idx.working.id };
              }
            }
            if (mover) {
              if (dest.id === mover.id || dest.path.ids.includes(mover.id)) {
                return refuse(
                  pd,
                  'MOVE_CYCLE',
                  `The destination is under ${mover.name}, which moves with the page.`,
                );
              }
              // v2 E4 (RV2-2; ADR 0046 decision 2): every page under the character's index, at any depth. Since C2d.1 a
              // Working character's specialist pages are made under its index, and moving the index with the Core alone
              // took them into canon still Working, on an approval that did not list them. Promoting one Core while
              // other pages are under the index is refused: promote the set with subtree: true (one approval for every
              // page), or move the other pages out first.
              const below = ctx.tree.subtree(ctx.projectId, mover.id).data.entries;
              for (const k of below)
                if (k.node.id !== mover.id && k.node.id !== page.node.id)
                  others.push({ id: k.node.id, name: k.node.rawName });
              if (others.length)
                return refuse(
                  pd,
                  'SET_HAS_OTHER_PAGES',
                  `${others.length} other page(s) are under ${mover.name}, which moves with the Core: ${others
                    .slice(0, 20)
                    .map((x) => x.name)
                    .join(
                      ', ',
                    )}. Promoting the Core alone would take them into canon unapproved. Promote the whole set with subtree: true on ${mover.name} (one approval for every page), or move those pages out first.`,
                );
              const twinIdx = ctx.tree
                .children(ctx.projectId, dest.id)
                .data.find(
                  (x) =>
                    x.id !== mover.id &&
                    x.kind === 'index' &&
                    key(x.displayName) === key(mover.name.replace(/^\[INDEX\]\s*/, '')),
                );
              if (twinIdx)
                return refuse(pd, 'NAME_TAKEN', `“${dest.displayName}” already holds “${twinIdx.rawName}”.`);
            } else {
              const twin = ctx.tree
                .children(ctx.projectId, dest.id)
                .data.find(
                  (x) =>
                    x.id !== page.node.id &&
                    isPageKind(x.kind) &&
                    key(x.displayName) === key(page.displayName),
                );
              if (twin)
                return refuse(pd, 'NAME_TAKEN', `“${dest.displayName}” already holds “${twin.rawName}”.`);
              const sub = subpageRefusal(pd, ctx, page.node, 'promote_page');
              if (sub) return sub;
            }
            const ct = facts.continuityType;
            const keepCt =
              ct !== null && (same(ct, c.continuityTypes.canon) || same(ct, c.continuityTypes.au));
            const target: LifecycleTarget = {
              name: `${KIND_PREFIX.bsrc}${page.displayName}`,
              parentId: dest.id,
              facts: {
                status: c.status.authoritative,
                lastMajorRevision: o.date,
                ...(keepCt ? {} : { continuityType: c.continuityTypes.canon }),
              },
              tagsRemove: [c.tags.working],
              tagsAdd: [c.tags.canon],
              ...(mover ? { moveIndex: mover } : {}),
            };
            return {
              action: 'promote',
              tool: 'promote_page',
              page,
              target,
              record: {
                previousState: 'working',
                previousFacts: facts,
                tagsRemoved: target.tagsRemove.filter((t) => page.tags.some((x) => same(x, t))),
                tagsAdded: target.tagsAdd,
                date: o.date,
                detail: {
                  ...(suggested ? { remembered: suggested } : {}),
                  ...(others.length ? { othersUnderIndex: others } : {}),
                },
              },
              flags: [
                ...flags,
                ...(suggested && suggested.id !== dest.id
                  ? [`goes under ${dest.rawName}; it was under ${suggested.name} before move_to_working`]
                  : []),
              ],
            };
          }),
  });
}

export function lifecycleTools(deps: ToolDeps): McpToolProvider[] {
  return [archivePageTool(deps), unarchivePageTool(deps), moveToWorkingTool(deps), promotePageTool(deps)];
}
