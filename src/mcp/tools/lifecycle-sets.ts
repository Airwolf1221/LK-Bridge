/**
 * Whole-set lifecycle (C2d, ADR 0037; decided by the owner on 11 November 2026): `archive_page`, `unarchive_page`,
 * `move_to_working` and `promote_page` with `subtree: true`. A set is a page and every page beneath it; the main case is a
 * character (`[INDEX] {name}` with its Core and specialist pages).
 *
 * - ONE canonical proposal for the whole set, listing every page with its own plan (move, name, facts, tags, note) and a
 *   set summary; at every scope the only approval is "Approve and accept as canon".
 * - The set stays together: its root moves as a group (placed alphabetically among the destination's children) and the
 *   structure beneath it is unchanged. Content pages get exactly C2c's single-page treatment, each by its own previous
 *   state; an index stays `[INDEX]`, gets no Status and keeps its facts, its status tag changes, and on archiving it gets
 *   a short note as its first block (removed on unarchiving if unchanged).
 * - What a set may hold: content pages in the expected state and `[INDEX]` pages. A set holding an unclassified page, a
 *   lifecycle-inconsistent page, either lifecycle index or a page in another state is refused, each listed; so is one of
 *   more than 100 pages.
 * - One job holds every page's lock (and each note's document), taken in sorted order. Leaving the current state
 *   (archive, move to Working): every rename and status tag first, then the facts, the notes, and the root's move last.
 *   Entering it (unarchive, promote): the root's move first, then the facts and notes, and the renames and tags last. So
 *   no page ever claims a state it is not in.
 * - ADR 0036 decision 5: the set is captured as listed when planned; at approval, and in the job's first step inside the
 *   locks, a page added, gone or moved (renamed or retagged too, inside the job) makes the proposal `conflicted`.
 * - A part-way stop leaves an `incomplete` set record (and each page's record); calling the same tool again on the root
 *   resumes, planning only what is left from the pages as they are now. Nothing is replayed.
 */
import * as z from 'zod';
import { listSubtree } from '../../facts/canonical.js';
import {
  EXPECT_STEP,
  RECORD_STEP,
  VERIFY_STEP,
  internalReads,
  type ExpectCheck,
  type VerifyTarget,
} from '../../jobs/internal-steps.js';
import type { LifecycleMarker, OpParams, StepSpec } from '../../jobs/index.js';
import { mintClientId } from '../../jobs/ids.js';
import {
  archivedScope,
  canonExemptionUnder,
  fillText,
  isoDate,
  lifecycleIndexes,
  type LifecycleAction,
  type LifecycleConfig,
  type LifecycleFacts,
  type LifecycleRecordInput,
  type LifecycleSet,
  type LifecycleState,
  type LifecycleTarget,
  type SetPage,
} from '../../lifecycle/index.js';
import { key, subjectOf } from '../../registry/names.js';
import { authoritativeTags, statusTagFor } from '../../lifecycle/tags.js';
import { SiblingSim } from '../../resources/plan.js';
import { KIND_PREFIX, classifyName, isPageKind, type TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import { resolveParent, withRequest, type CreateOutcome } from './create-support.js';
import {
  LEAVING,
  TOOL,
  archiveTarget,
  factsOf,
  mainDocument,
  positionOf,
  tagRulesOf,
  planPage,
  readPage,
  refuse,
  same,
  stateOf,
  type Answer,
  type PagePart,
  type PageNow,
} from './lifecycle.js';
import { liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import { errorResult, render, withProject, type ProjectDeps, type ToolDeps } from './shape.js';
import { runWriteJob } from './write-job.js';

type Obj = Record<string, unknown>;
type SetState = 'authoritative' | 'working' | 'archived';

/** At most this many pages in a set, the root included (the owner's cap). */
export const MAX_SET_PAGES = 100;

export const subtreeArg = z
  .boolean()
  .optional()
  .describe(
    'true: the page and every page beneath it (a character: its [INDEX], Core and specialist pages) as ONE canonical proposal, kept together; at most 100 pages. Default: this page alone.',
  );

export interface SetArgs {
  readonly page: string;
  readonly dryRun?: boolean | undefined;
  readonly project?: string | undefined;
  readonly destination?: string | undefined;
}

/** One page of the set as planned. */
interface Member {
  readonly page: PageNow;
  readonly role: 'index' | 'page';
  readonly isRoot: boolean;
  /** Its state before (content pages; an index takes the set's). */
  readonly from: LifecycleState;
  readonly target: LifecycleTarget;
  readonly record: LifecycleRecordInput;
  readonly flags: string[];
}

const stateTag = (c: LifecycleConfig, s: SetState) =>
  s === 'authoritative' ? c.tags.canon : s === 'working' ? c.tags.working : c.tags.archived;
const prefixOf = (s: SetState) =>
  s === 'authoritative' ? KIND_PREFIX.bsrc : s === 'working' ? KIND_PREFIX.bwrk : KIND_PREFIX.barc;
const kindState = (kind: string): SetState | null =>
  kind === 'bsrc' ? 'authoritative' : kind === 'bwrk' ? 'working' : kind === 'barc' ? 'archived' : null;

/** The state a set leaves and the one it enters, by action. */
const EXPECTS: Readonly<Record<LifecycleAction, readonly SetState[]>> = {
  archive: ['authoritative', 'working'],
  move_to_working: ['authoritative'],
  promote: ['working'],
  unarchive: ['archived'],
};

/** Runs one of the four tools on a whole set. */
export async function runSet(
  deps: ToolDeps,
  mctx: McpToolContext,
  action: LifecycleAction,
  args: SetArgs,
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
    const root = r.node;
    return withRequest(
      pd,
      mctx,
      tool,
      { ...args, subtree: true },
      { key: `lifecycle:${root.id}`, label: `a lifecycle change of the set under “${root.rawName}”` },
      async (): Promise<CreateOutcome> => {
        const planned = await planSet(deps, pd, mctx, ctx, action, tool, root, args);
        if ('kind' in planned) return planned;
        return planned.submit();
      },
    );
  });
}

interface PlannedSet {
  submit(): Promise<CreateOutcome>;
}

async function planSet(
  deps: ToolDeps,
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  action: LifecycleAction,
  tool: string,
  root: TreeNode,
  args: SetArgs,
): Promise<PlannedSet | Answer> {
  const lc = pd.services!.lifecycle!;
  const pid = ctx.projectId;
  const c = lc.config(pid);
  const idx = lifecycleIndexes(c, (id) => ctx.tree.node(pid, id).data);
  if (!idx.ok) return refuse(pd, idx.code, idx.message);
  if (root.kind === 'root')
    return refuse(pd, 'ROOT_PAGE', 'The AI REPOSITORY page itself has no lifecycle. Name a page inside it.');
  if (root.id === idx.working.id || root.id === idx.archived.id)
    return refuse(
      pd,
      'LIFECYCLE_INDEX',
      `“${root.rawName}” is a lifecycle index itself: it has no lifecycle of its own and the tools never change it (the owner edits [INDEX] Working and [INDEX] Archived by hand). Name the page, or a character’s own [INDEX], instead.`,
    );

  // A set change of this root that stopped part-way: the same tool resumes it; another waits for it.
  const open = lc.store.setsForRoot(pid, root.id, 5).find((s) => s.state === 'incomplete') ?? null;
  if (open) {
    const job = open.jobId ? pd.engine.queries.getJob(pid, open.jobId) : null;
    if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      return refuse(
        pd,
        'LIFECYCLE_IN_PROGRESS',
        `${TOOL[open.action]} of the set under “${root.rawName}” is still running (job ${job.id}); nothing was done. Follow it with bridge_job_status.`,
        { jobId: job.id, setId: open.id },
      );
    }
    if (open.action !== action) {
      return refuse(
        pd,
        'LIFECYCLE_INCOMPLETE',
        `${TOOL[open.action]} of the set under “${root.rawName}” stopped part-way (set record ${open.id}); call ${TOOL[open.action]} with subtree: true on it again to finish it first. Nothing was done.`,
        { setId: open.id, action: TOOL[open.action] },
      );
    }
  }

  // --- the set, as LegendKeeper holds it now (listed level by level), at most 100 pages.
  const read = async (opId: string, params: OpParams): Promise<unknown> => {
    const x = await liveRead(pd, mctx, tool, opId, params as Obj);
    if (!x.ok) throw new Error('read failed');
    return x.value;
  };
  const below = await listSubtree(read, root.id, MAX_SET_PAGES - 1);
  if (below === null)
    return refuse(
      pd,
      'SET_UNREADABLE',
      `The pages under “${root.rawName}” could not be listed; nothing was done.`,
    );
  if (below.length + 1 > MAX_SET_PAGES) {
    return refuse(
      pd,
      'SET_TOO_LARGE',
      `The set under “${root.rawName}” has more than ${MAX_SET_PAGES} pages (the cap for one set change); nothing was done. Change it in parts.`,
      { cap: MAX_SET_PAGES, pagesAtLeast: below.length + 1 },
    );
  }
  const unknown = below.filter((p) => !ctx.tree.node(pid, p.id).data);
  if (unknown.length > 0) {
    return refuse(
      pd,
      'SET_NOT_IN_TREE',
      `The repository tree has not seen ${unknown.length} page(s) under “${root.rawName}” yet (made or moved in the app since its last sweep); nothing was done. Try again after the next sweep.`,
      { pages: unknown.slice(0, 50).map((p) => ({ id: p.id, name: p.name })) },
    );
  }
  const parentOf = new Map<string, string | null>([
    [root.id, root.parentId],
    ...below.map((p) => [p.id, p.parentId] as [string, string]),
  ]);
  const pages: PageNow[] = [];
  for (const id of [root.id, ...below.map((p) => p.id)]) {
    const got = await readPage(pd, mctx, tool, ctx.tree.node(pid, id).data!);
    if (!got.ok) return { kind: 'answer', result: got.result };
    pages.push(got.value);
  }
  const settings = pd.services?.projectSettings?.(pid) ?? {};
  const propertyTitle =
    typeof settings.factsPropertyName === 'string' && settings.factsPropertyName.trim() !== ''
      ? settings.factsPropertyName
      : 'PROPERTIES';
  const date = open?.date ?? isoDate(Date.now());
  // v3 F3d (ADR 0053): where the lifecycle tag goes and the AU ruling, from the project's approved pack.
  const rules = tagRulesOf(pd, pid);
  const leaving = (s: SetState) => (s === 'authoritative' ? authoritativeTags(c, rules) : [stateTag(c, s)]);
  const rootPage = pages[0]!;
  const lifecycleArea = (n: TreeNode): 'working' | 'archived' | null =>
    n.id === idx.working.id || n.path.ids.includes(idx.working.id)
      ? 'working'
      : n.id === idx.archived.id || n.path.ids.includes(idx.archived.id)
        ? 'archived'
        : null;

  // --- what each page becomes (a resume: what its record aimed at).
  const members: Member[] = [];
  const problems: { id: string; name: string; problem: string }[] = [];
  const flags: string[] = [];
  let fromState: SetState | null = null;
  let toState: SetState;
  let rootParent: string;
  let setRecordOf: LifecycleSet | null = null;

  if (open) {
    // Resume: the same set, towards the same targets.
    const want = new Set(open.pages.map((p) => p.id));
    const now = new Set(pages.map((p) => p.node.id));
    const diff = [...want].filter((x) => !now.has(x)).concat([...now].filter((x) => !want.has(x)));
    if (diff.length > 0) {
      return refuse(
        pd,
        'SET_CHANGED',
        `The set under “${root.rawName}” is not the set the stopped change was made for (${diff.length} page(s) added or gone since); nothing was done. Make it agree by hand, or finish each page with the single-page tools.`,
        { setId: open.id, pages: diff.slice(0, 50) },
      );
    }
    toState = open.target.state;
    rootParent = open.target.parentId;
    const recs = new Map(lc.store.setRecords(pid, open.id).map((x) => [x.pageId, x]));
    for (const p of pages) {
      const t = open.target.pages[p.node.id];
      const rec = recs.get(p.node.id);
      if (!t || !rec) {
        return refuse(
          pd,
          'SET_CHANGED',
          `The stopped change has no record of “${p.name}”; nothing was done.`,
        );
      }
      members.push({
        page: p,
        role: rec.previousPrefix === '[INDEX]' ? 'index' : 'page',
        isRoot: p.node.id === root.id,
        from: rec.previousState,
        target: t,
        record: rec,
        flags: [],
      });
    }
  } else {
    // --- what the set may hold.
    const contentStates = new Set<SetState>();
    for (const p of pages) {
      const kind = p.kind;
      if (p.node.id === idx.working.id || p.node.id === idx.archived.id) {
        problems.push({ id: p.node.id, name: p.name, problem: 'a lifecycle index' });
        continue;
      }
      if (kind === 'index') continue;
      const st = kindState(kind);
      if (!st) {
        problems.push({
          id: p.node.id,
          name: p.name,
          problem: 'unclassified (no [BSRC], [BWRK], [BARC] or [INDEX] prefix)',
        });
        continue;
      }
      const facts = factsOf(c, propertyTitle, p.sidebar);
      const inc = stateOf(c, p, facts);
      if (inc.conflict) {
        problems.push({
          id: p.node.id,
          name: p.name,
          problem: 'lifecycle-inconsistent: its prefix and Status disagree',
        });
        continue;
      }
      if (!EXPECTS[action].includes(st)) {
        problems.push({
          id: p.node.id,
          name: p.name,
          problem: `${KIND_PREFIX[kind as 'bsrc'].trim()}, not ${EXPECTS[action].map((s) => prefixOf(s).trim()).join(' or ')}`,
        });
        continue;
      }
      contentStates.add(st);
      const half = lc.store.incomplete(pid, p.node.id);
      if (half)
        problems.push({
          id: p.node.id,
          name: p.name,
          problem: `${TOOL[half.action]} of it stopped part-way`,
        });
    }
    // One state for the whole set: a set that is part Authoritative and part Working is refused.
    if (contentStates.size > 1) {
      for (const p of pages)
        if (isPageKind(p.kind))
          problems.push({
            id: p.node.id,
            name: p.name,
            problem: `${KIND_PREFIX[p.kind as 'bsrc'].trim()} in a mixed set`,
          });
    }
    const area = lifecycleArea(root);
    fromState =
      contentStates.size === 1
        ? [...contentStates][0]!
        : area === 'working'
          ? 'working'
          : area === 'archived'
            ? 'archived'
            : 'authoritative';
    // The set must be where its state says (a Working set under [INDEX] Working, an archived one under Archived).
    const wantArea = fromState === 'working' ? 'working' : fromState === 'archived' ? 'archived' : null;
    if (area !== wantArea) {
      problems.push({
        id: root.id,
        name: root.rawName,
        problem:
          wantArea === null
            ? 'its pages are Authoritative but it is under a lifecycle index'
            : `its pages are ${fromState} but it is not under [INDEX] ${wantArea === 'working' ? c.indexNames.working : c.indexNames.archived}`,
      });
    }
    if (!EXPECTS[action].includes(fromState)) {
      problems.push({
        id: root.id,
        name: root.rawName,
        problem: `the set is ${fromState}, which ${tool} does not take`,
      });
    }
    if (problems.length > 0) {
      return refuse(
        pd,
        'SET_NOT_ELIGIBLE',
        `${tool} with subtree: true refuses the set under “${root.rawName}”: ${problems.length} page(s) cannot be part of it (listed); nothing was done.`,
        { problems: dedupe(problems).slice(0, 100) },
      );
    }

    // --- where the root goes, and what each page becomes.
    if (action === 'archive') {
      toState = 'archived';
      rootParent = idx.archived.id;
    } else if (action === 'move_to_working') {
      toState = 'working';
      rootParent = idx.working.id;
    } else if (action === 'promote') {
      toState = 'authoritative';
      const back = lc.store
        .setsForRoot(pid, root.id, 5)
        .find((s) => s.action === 'move_to_working' && s.state === 'complete');
      const prev = back?.previousParentId ? ctx.tree.node(pid, back.previousParentId).data : null;
      const suggested = prev ? { id: prev.id, name: prev.rawName, path: prev.path.names.join(' / ') } : null;
      if (args.destination === undefined) {
        return refuse(
          pd,
          'DESTINATION_REQUIRED',
          `promote_page with subtree: true needs \`destination\`: the index the set's root “${root.rawName}” goes under.${suggested ? ` It was under ${suggested.name} (${suggested.path}) before move_to_working: pass destination “${suggested.id}” to take it back there.` : ''}`,
          { ...(suggested ? { suggestedDestination: suggested } : {}) },
        );
      }
      const d = resolveParent(ctx, args.destination, { what: `the destination “${args.destination}”` });
      if (!d.ok) return { kind: 'answer', result: d.result };
      if (lifecycleArea(d.value) !== null || d.value.id === root.id || d.value.path.ids.includes(root.id)) {
        return refuse(
          pd,
          'LIFECYCLE_AREA',
          `“${d.value.displayName}” is a lifecycle index, under one, or inside the set; an Authoritative set goes in its normal place.`,
        );
      }
      rootParent = d.value.id;
      if (suggested && suggested.id !== d.value.id)
        flags.push(`goes under ${d.value.rawName}; it was under ${suggested.name} before move_to_working`);
    } else {
      // unarchive: back to the state and place the set's archive record holds.
      const arch =
        lc.store.setsForRoot(pid, root.id, 5).find((s) => s.action === 'archive' && s.state === 'complete') ??
        null;
      if (!arch) {
        return refuse(
          pd,
          'NO_SET_RECORD',
          `The bridge has no record of archiving the set under “${root.rawName}” as a set, so it cannot know where each page goes back; nothing was done. Unarchive its pages one by one with unarchive_page (each needs \`destination\`).`,
        );
      }
      setRecordOf = arch;
      toState = arch.previousState === 'working' ? 'working' : 'authoritative';
      const prev = arch.previousParentId ? ctx.tree.node(pid, arch.previousParentId).data : null;
      const usable =
        prev !== null &&
        prev.kind !== 'root' &&
        (toState === 'working'
          ? // C2d.1: a Working set goes back under [INDEX] Working or the Working-set index it came from.
            lifecycleArea(prev) === 'working' && (prev.id === idx.working.id || prev.kind === 'index')
          : lifecycleArea(prev) === null) &&
        !prev.path.ids.includes(root.id);
      if (args.destination !== undefined || !usable) {
        if (args.destination === undefined) {
          return refuse(
            pd,
            'DESTINATION_REQUIRED',
            `The set's previous parent (${arch.previousParentId ?? 'none'}) is gone, outside the repository or not usable. Give \`destination\`: the index the set's root goes back under.`,
          );
        }
        const d = resolveParent(ctx, args.destination, { what: `the destination “${args.destination}”` });
        if (!d.ok) return { kind: 'answer', result: d.result };
        const dArea = lifecycleArea(d.value);
        if (
          (toState === 'working' ? dArea !== 'working' : dArea !== null) ||
          d.value.path.ids.includes(root.id)
        ) {
          return refuse(
            pd,
            'LIFECYCLE_AREA',
            toState === 'working'
              ? `A Working set goes back under [INDEX] ${c.indexNames.working} or an [INDEX] inside a Working set.`
              : `“${d.value.displayName}” is a lifecycle index or under one; an Authoritative set goes back to its normal place.`,
          );
        }
        rootParent = d.value.id;
        if (usable && d.value.id !== prev.id)
          flags.push(`returns under ${d.value.rawName}, not its previous parent ${prev.rawName}, as asked`);
      } else rootParent = prev.id;
      // Pages of the archived set unarchived on their own since are not part of this change.
      const live = new Set(pages.map((p) => p.node.id));
      const gone = arch.pages.filter((p) => !live.has(p.id));
      if (gone.length > 0)
        flags.push(
          `${gone.length} page(s) archived with the set are no longer under it (unarchived on their own, or moved): ${gone
            .slice(0, 10)
            .map((p) => p.name)
            .join(', ')}; they are not part of this change`,
        );
    }

    // The root's name must be free at its destination.
    const display = rootPage.kind === 'index' ? rootPage.displayName : rootPage.displayName;
    const twin = ctx.tree
      .children(pid, rootParent)
      .data.find(
        (x) =>
          x.id !== root.id &&
          (rootPage.kind === 'index' ? x.kind === 'index' : isPageKind(x.kind)) &&
          key(x.displayName) === key(display),
      );
    if (twin) {
      return refuse(
        pd,
        'NAME_TAKEN',
        `The destination already holds “${twin.rawName}”; rename one of them first.`,
        {
          existing: { id: twin.id, name: twin.rawName },
        },
      );
    }

    // E5.3 (ADR 0046 decision 13): a set made Authoritative beneath an index whose pages are Authoritative without
    // CANON gets no CANON tag (its pages and its indexes alike).
    const exemptUnder =
      toState === 'authoritative'
        ? canonExemptionUnder(c, ctx.tree.node(pid, rootParent).data ?? null)
        : null;
    if (exemptUnder)
      flags.push(
        `goes beneath ${ctx.tree.node(pid, exemptUnder).data?.rawName ?? exemptUnder}, whose pages are Authoritative without ${c.tags.canon}: no ${c.tags.canon} tag is added`,
      );
    const addTag = (t: string) =>
      exemptUnder && authoritativeTags(c, rules).some((x) => same(t, x)) ? [] : [t];
    // Each page's own target.
    const archRecs = setRecordOf
      ? new Map(lc.store.setRecords(pid, setRecordOf.id).map((x) => [x.pageId, x]))
      : null;
    for (const p of pages) {
      const isRoot = p.node.id === root.id;
      const parentId = isRoot ? rootParent : (parentOf.get(p.node.id) ?? p.parentId ?? rootParent);
      const role: 'index' | 'page' = p.kind === 'index' ? 'index' : 'page';
      const facts = factsOf(c, propertyTitle, p.sidebar);
      const own = role === 'page' ? kindState(p.kind)! : fromState;
      const mflags: string[] = [];
      let target: LifecycleTarget;
      let previous: LifecycleState = own;
      if (action === 'archive') {
        const doc = mainDocument(p);
        if (!doc) {
          problems.push({ id: p.node.id, name: p.name, problem: 'no page document for the archive note' });
          continue;
        }
        if (role === 'page') {
          target = archiveTarget(
            c,
            p,
            facts,
            own === 'working' ? 'working' : 'authoritative',
            parentId,
            date,
            doc,
            rules,
          );
        } else {
          const block = {
            id: mintClientId(),
            kind: 'paragraph',
            content: [{ text: fillText(c.texts.noteForIndex, { date, source: p.displayName }) }],
          };
          target = {
            name: p.name,
            parentId,
            facts: {},
            tagsRemove: [...authoritativeTags(c, rules), c.tags.working],
            tagsAdd: [c.tags.archived],
            ...positionOf(rules),
            note: { action: 'insert', blockId: block.id, documentId: doc.id, block },
          };
        }
      } else if (action === 'move_to_working' || action === 'promote') {
        const to: SetState = action === 'promote' ? 'authoritative' : 'working';
        const ct = facts.continuityType;
        const keepCt = ct !== null && (same(ct, c.continuityTypes.canon) || same(ct, c.continuityTypes.au));
        target = {
          name: role === 'page' ? `${prefixOf(to)}${p.displayName}` : p.name,
          parentId,
          facts:
            role === 'index'
              ? {}
              : to === 'working'
                ? { status: c.status.working }
                : {
                    status: c.status.authoritative,
                    lastMajorRevision: date,
                    ...(keepCt ? {} : { continuityType: c.continuityTypes.canon }),
                  },
          tagsRemove: leaving(fromState),
          // v3 F3d (ADR 0053): a content page made Authoritative carries its Continuity Type's status tag (AU under the
          // ruling); an index has no Continuity Type, so CANON.
          tagsAdd: addTag(
            to === 'authoritative' && role === 'page'
              ? statusTagFor(c, rules, keepCt ? ct : c.continuityTypes.canon)
              : stateTag(c, to),
          ),
          ...positionOf(rules),
        };
      } else {
        // unarchive: from each page's own record of the set's archiving.
        const rec = archRecs!.get(p.node.id) ?? null;
        const latest = lc.store.latest(pid, p.node.id, ['archive', 'unarchive']);
        if (!rec || !latest || latest.id !== rec.id || rec.state !== 'complete') {
          problems.push({
            id: p.node.id,
            name: p.name,
            problem:
              latest && latest.action === 'unarchive'
                ? 'unarchived on its own earlier'
                : 'not archived with this set (no record of it in the set’s archiving)',
          });
          continue;
        }
        previous = 'archived';
        const back: SetState = rec.previousState === 'working' ? 'working' : 'authoritative';
        const noteDoc = rec.target.note?.documentId ?? null;
        const note: LifecycleTarget['note'] =
          rec.noteBlockId && noteDoc && rec.noteContent
            ? {
                action: 'remove',
                blockId: rec.noteBlockId,
                documentId: noteDoc,
                block: rec.noteContent as Obj,
              }
            : undefined;
        if (role === 'page') {
          const restore = rec.previousFacts;
          const expected = archivedScope(c, restore.scope ?? '');
          if (facts.scope !== null && !same(facts.scope, expected))
            mflags.push(
              `${p.name}: Scope was edited after archiving (it is “${facts.scope}”); the recorded original “${restore.scope ?? ''}” is restored`,
            );
          target = {
            name: `${prefixOf(back)}${p.displayName}`,
            parentId,
            facts: {
              status: back === 'working' ? c.status.working : (restore.status ?? null),
              continuityType: restore.continuityType,
              scope: restore.scope,
              temporalScope: restore.temporalScope,
              lastMajorRevision: date,
            },
            tagsRemove: [c.tags.archived],
            tagsAdd: addTag(
              back === 'authoritative' ? statusTagFor(c, rules, restore.continuityType) : stateTag(c, back),
            ),
            ...positionOf(rules),
            ...(note ? { note } : {}),
          };
        } else {
          target = {
            name: p.name,
            parentId,
            facts: {},
            tagsRemove: [c.tags.archived],
            tagsAdd: (rec.tagsRemoved.length > 0 ? [...rec.tagsRemoved] : [stateTag(c, back)]).flatMap(
              addTag,
            ),
            ...positionOf(rules),
            ...(note ? { note } : {}),
          };
        }
      }
      const record: LifecycleRecordInput = {
        pageId: p.node.id,
        pageName: p.name,
        action,
        date,
        previousState: previous,
        previousParentId: p.parentId,
        previousRank: p.rank,
        previousName: p.name,
        previousPrefix: p.kind === 'unclassified' ? '' : KIND_PREFIX[p.kind as 'bsrc'].trim(),
        previousFacts: role === 'page' ? facts : EMPTY,
        tagsRemoved: target.tagsRemove.filter((t) => p.tags.some((x) => same(x, t))),
        tagsAdded: target.tagsAdd,
        ...(target.note?.action === 'insert'
          ? { noteBlockId: target.note.blockId, noteContent: target.note.block ?? null }
          : {}),
        target,
        detail: { set: true, root: { id: root.id, name: root.rawName } },
      };
      members.push({ page: p, role, isRoot, from: own, target, record, flags: mflags });
    }
    if (problems.length > 0) {
      return refuse(
        pd,
        'SET_NOT_ELIGIBLE',
        `${tool} with subtree: true refuses the set under “${root.rawName}”: ${problems.length} page(s) cannot be part of it (listed); nothing was done.`,
        { problems: dedupe(problems).slice(0, 100) },
      );
    }
  }

  // --- each page's writes, checks and verify targets (only what differs from its target: a resume does what is left).
  const parts: { m: Member; part: PagePart }[] = [];
  for (const m of members) {
    const pp = await planPage(pd, mctx, ctx, c, propertyTitle, m.page, m.target, tool, true);
    if (!pp.ok) return { kind: 'answer', result: pp.result };
    parts.push({ m, part: pp.value });
  }

  // The root's move, alphabetical among the destination's children.
  const journal = (page: PageNow, write: string) => ({
    tool,
    subtree: true,
    page: { id: page.node.id, name: page.name },
    write,
  });
  const sim = new SiblingSim((parentId) => ctx.tree.children(pid, parentId).data);
  const moveSteps: { step: StepSpec; label: string }[] = [];
  let placement: { parentId: string; after: string | null; before: string | null } | null = null;
  const rootTarget = members.find((m) => m.isRoot)!.target;
  if ((rootPage.parentId ?? null) !== rootParent) {
    const display = classifyName(rootTarget.name).displayName;
    const kind = classifyName(rootTarget.name).kind;
    if (rootPage.parentId) sim.remove(rootPage.parentId, root.id);
    const slot = sim.slot(rootParent, { displayName: display, kind }, () => true, root.id);
    sim.insert(rootParent, { id: root.id, displayName: display, kind }, slot);
    placement = { parentId: rootParent, ...sim.neighbours(rootParent, root.id) };
    moveSteps.push({
      step: {
        op: 'moveResource',
        params: { path: { resourceId: root.id }, body: { parentId: rootParent, ...slot } },
        journalOperation: journal(rootPage, 'moved the set (its root) as a group'),
        deferTreeReread: true,
      },
      label: `move the set (${root.rawName}) under ${ctx.tree.node(pid, rootParent).data?.rawName ?? rootParent}`,
    });
  }

  // --- the job: check, record, writes in their order, verify, record's end.
  const checks: ExpectCheck[] = [
    {
      label: `the set under ${root.rawName}`,
      kind: 'subtree',
      resourceId: root.id,
      pages: pages
        .filter((p) => p.node.id !== root.id)
        .map((p) => ({
          id: p.node.id,
          parentId: parentOf.get(p.node.id) ?? p.parentId,
          name: p.name,
          tags: [...p.tags],
        })),
    },
    {
      label: rootPage.name,
      kind: 'resource',
      resourceId: root.id,
      name: rootPage.name,
      parentId: rootPage.parentId,
      tags: [...rootPage.tags],
    },
    ...parts.flatMap((x) => x.part.checks),
  ];
  const updates = parts
    .filter((x) => x.part.updateStep)
    .map((x) => ({ step: x.part.updateStep!, label: x.part.updateLabel }));
  const factGroups = parts.map((x) => x.part.factSteps);
  const notes = parts.flatMap((x) => x.part.noteSteps);
  const ordered: { step: StepSpec; label: string }[][] = LEAVING[action]
    ? [updates, ...factGroups, notes, moveSteps]
    : [moveSteps, ...factGroups, notes, updates];
  const steps: StepSpec[] = [];
  const labels: string[] = [];
  steps.push({ op: EXPECT_STEP, params: { body: { checks } } });
  labels.push('check');
  const setInput = {
    rootId: root.id,
    rootName: root.rawName,
    action,
    date,
    previousState: open ? open.previousState : (fromState ?? 'unknown'),
    previousParentId: open ? open.previousParentId : rootPage.parentId,
    previousRank: open ? open.previousRank : rootPage.rank,
    pages: (open
      ? open.pages
      : members.map((m): SetPage => ({
          id: m.page.node.id,
          parentId: parentOf.get(m.page.node.id) ?? m.page.parentId,
          name: m.page.name,
          kind: m.page.kind,
          role: m.role,
        }))) as SetPage[],
    target: open
      ? open.target
      : {
          parentId: rootParent,
          state: toState,
          pages: Object.fromEntries(members.map((m) => [m.page.node.id, m.target])),
        },
  };
  steps.push({
    op: RECORD_STEP,
    params: {
      body: {
        action: 'begin_set',
        record: {
          set: setInput,
          records: open ? [] : members.map((m) => m.record),
          ...(open ? { resumeOf: open.id } : {}),
        },
      },
    },
  });
  labels.push('record');
  let writes = 0;
  for (const group of ordered) {
    for (const w of group) {
      const step =
        w.step.ifMatchFrom?.step === -1 ? { ...w.step, ifMatchFrom: { step: steps.length } } : w.step;
      steps.push(step);
      labels.push(w.label);
      writes++;
    }
  }
  const verify: VerifyTarget[] = [];
  for (const { m, part } of parts) {
    verify.push({
      kind: 'resource',
      label: m.target.name,
      resourceId: m.page.node.id,
      fields: {
        name: m.target.name,
        tags: part.newTags,
        parentId: m.isRoot ? rootParent : m.target.parentId,
      },
      ...(m.isRoot && placement ? { placement } : {}),
    });
    verify.push(...part.verify);
  }
  steps.push({ op: VERIFY_STEP, params: { body: { targets: verify } } });
  labels.push('verify');
  // C2d.1 (promote), C2d.2 (archive and move to Working): Working pages of the same subject left flat under
  // [INDEX] Working are not in the set; say so, so the owner does not approve a partial change by accident. A resumed
  // change (open) lists nothing: it finishes what the earlier plan began.
  const outsiders =
    OUTSIDER_ACTIONS.has(action) && !open
      ? workingOutsiders(ctx, idx.working.id, root, new Set(members.map((m) => m.page.node.id)))
      : [];
  const outsiderWords = outsiderWording(action, root, c.indexNames.working, fromState);
  if (outsiders.length > 0) {
    flags.push(
      `${outsiders.length} Working page${outsiders.length === 1 ? '' : 's'} of the same subject sit outside this set, flat under [INDEX] ${c.indexNames.working}, and ${outsiderWords.consequence}: ${outsiders
        .slice(0, 10)
        .map((o) => o.name)
        .join(', ')}${outsiders.length > 10 ? ', …' : ''}. ${outsiderWords.advice}`,
    );
  }
  const allFlags = [...flags, ...parts.flatMap((x) => [...x.m.flags, ...x.part.noteFlags])];
  steps.push({ op: RECORD_STEP, params: { body: { action: 'complete_set', record: { flags: allFlags } } } });
  labels.push('record complete');

  // --- what it shows: a set summary and every page's own plan; the estimate.
  const parentNode = ctx.tree.node(pid, rootParent).data;
  const pagePlans = parts.map(({ m, part }) => ({
    id: m.page.node.id,
    name: m.page.name,
    role: m.role,
    ...(m.role === 'page' ? { from: m.from } : {}),
    newName: m.target.name,
    move: m.isRoot
      ? { under: { id: rootParent, name: parentNode?.rawName ?? rootParent } }
      : 'stays under its parent (moves with the set)',
    facts: part.factTable.filter((f) => f.change !== 'unchanged'),
    tags: { before: m.page.tags, after: part.newTags },
    ...(part.noteHead ? { note: part.noteHead } : {}),
  }));
  const contentPages = members.filter((m) => m.role === 'page').length;
  const factPages = factGroups.filter((g) => g.length > 0).length;
  const reads =
    // The check: the set listed level by level (about one listing per page), then one read per other check.
    members.length +
    internalReads(EXPECT_STEP, { body: { checks } }) -
    1 +
    internalReads(VERIFY_STEP, { body: { targets: verify } }) +
    // In the lock: each page's first fact write reads its rows, and the canon guard its Status; each note reads its
    // document's version; the guards read a page before its rename or retag, and the root (and its new parent) before
    // the move.
    2 * factPages +
    notes.length +
    updates.length +
    2 * moveSteps.length +
    // The tree re-reads every page once when the job ends.
    members.length;
  const gov = deps.projects?.anyClient(pd.project.id)?.governor;
  const est = gov?.estimate({ reads, writes, createManyItems: 0, priority: 'P2' });
  const estimate = {
    pages: members.length,
    contentPages,
    indexes: members.length - contentPages,
    reads,
    writes,
    ...(est
      ? {
          wallClock:
            est.wallClockMs < 60_000
              ? `${Math.round(est.wallClockMs / 1000)} s`
              : `${Math.round((est.wallClockMs / 60_000) * 10) / 10} min`,
          tightestTier: est.tightestTier,
          fitsToday: est.fitsToday,
        }
      : {}),
    note: 'bridge_estimate of the job’s reads and writes (planning reads, already made, not included)',
  };
  const related =
    action === 'archive' || action === 'move_to_working'
      ? await relatedForSet(pd, mctx, ctx, tool, members)
      : undefined;
  const set = {
    root: { id: root.id, name: root.rawName, path: root.path.names.join(' / ') },
    pages: members.length,
    contentPages,
    indexes: members.length - contentPages,
    from: open ? open.previousState : fromState,
    to: toState,
    newParent: { id: rootParent, name: parentNode?.rawName ?? rootParent },
    ...(placement ? { place: { after: placement.after, before: placement.before } } : {}),
    layout: 'the set stays together: its root moves as a group, the structure beneath it is unchanged',
  };
  const head: Obj = {
    action: tool,
    subtree: true,
    set,
    pages: pagePlans,
    estimate,
    ...(allFlags.length ? { flags: allFlags } : {}),
    ...(open ? { resumes: { setId: open.id } } : {}),
    ...(outsiders.length > 0
      ? {
          outsiders: {
            pages: outsiders,
            suggestion: `These Working pages have the same subject as the set but sit flat under [INDEX] ${c.indexNames.working}, so ${outsiderWords.why}. ${outsiderWords.suggestionAdvice(root.id)}`,
          },
        }
      : {}),
    ...(related ? { relatedPages: related } : {}),
  };
  if (writes === 0 && !open) {
    return refuse(
      pd,
      'NOTHING_TO_DO',
      `The set under “${root.rawName}” already is as ${tool} would leave it; nothing was proposed.`,
      head,
    );
  }
  const marker: LifecycleMarker = {
    tool,
    canonical: true,
    reason: `changes the lifecycle state of a whole set (${members.length} pages under ${root.rawName})`,
    pages: members.map((m) => ({
      id: m.page.node.id,
      to: m.role === 'page' ? stateOfTarget(m.target) : toState,
    })),
  };
  const docs = [
    ...new Set(parts.map((x) => x.part.holdDocument?.documentId).filter((d): d is string => !!d)),
  ];
  const others = members.filter((m) => !m.isRoot).map((m) => m.page.node.id);
  const summary = `${tool} (whole set, ${members.length} pages): ${root.rawName} → under ${parentNode?.rawName ?? rootParent}`;
  const operation: Obj = {
    tool,
    subtree: true,
    page: { id: root.id, name: root.rawName },
    pageParts: [
      `whole set of ${members.length} page${members.length === 1 ? '' : 's'}`,
      ...(moveSteps.length ? [`moved under ${parentNode?.rawName ?? rootParent}`] : []),
      `${updates.length} renamed or retagged`,
      ...(notes.length ? [`${notes.length} note${notes.length === 1 ? '' : 's'}`] : []),
    ],
    summaryLabel: summary,
    lifecycle: head,
  };
  return {
    async submit(): Promise<CreateOutcome> {
      if (args.dryRun === true) {
        return {
          kind: 'answer',
          result: render(
            {
              ...head,
              status: 'dry_run',
              steps: labels.filter((l) => !['check', 'record', 'verify', 'record complete'].includes(l)),
              requiresCanonicalApproval: true,
              message:
                'Dry run: nothing was written and nothing was proposed. Run without dryRun to propose it: one proposal for the whole set, which always needs the owner’s canonical approval.',
            },
            pd,
          ),
        };
      }
      const out = await runWriteJob(pd, mctx, tool, {
        steps,
        labels,
        title: summary,
        holdLock: { resourceId: root.id },
        holdMore: { resources: others, documents: docs },
        lifecycle: marker,
        pageScope: {
          subtrees: [
            {
              rootId: root.id,
              label: `the set under ${root.rawName}`,
              pages: pages
                .filter((p) => p.node.id !== root.id)
                .map((p) => ({
                  id: p.node.id,
                  parentId: parentOf.get(p.node.id) ?? p.parentId,
                  name: p.name,
                })),
            },
          ],
        },
        proposal: {
          operations: [{ ...operation, ...(related ? { relatedPages: related } : {}) }],
          summary,
          prefetched: pages.map((p) => ({ op: 'getResource', path: { resourceId: p.node.id }, body: p.raw })),
        },
        head: {
          ...head,
          setId: 'assigned when the change runs (bridge_proposal_status, then bridge_job_status, show it)',
        },
        preview: () => ({ set }),
      });
      return { kind: 'job', head, labels, ...out };
    },
  };
}

/**
 * The set changes that list same-subject Working pages outside the set (C2d.1: promote; C2d.2, the owner's request of
 * 12 November 2026: archive and move to Working, the same listing and flag). Unarchive does not: it brings pages back
 * from the Archived area, where this trap does not arise.
 */
const OUTSIDER_ACTIONS: ReadonlySet<LifecycleAction> = new Set<LifecycleAction>([
  'promote',
  'archive',
  'move_to_working',
]);

/**
 * What each set change would do to the outsiders, in the words of the flag and of the suggestion. The advice depends on
 * where the set is: a Working page can only be moved into the Working area, so into a Working set's index, never into
 * an Authoritative set's (or one about to leave for the Working area, which it has not yet).
 */
function outsiderWording(
  action: LifecycleAction,
  root: TreeNode,
  workingName: string,
  fromState: SetState | null,
): { consequence: string; why: string; advice: string; suggestionAdvice: (rootId: string) => string } {
  const moveIn = (rootId: string) => `Move each in with move_resource (page: its id, to: ${rootId})`;
  switch (action) {
    case 'archive':
      return fromState === 'working'
        ? {
            consequence: 'would stay Working, left behind when the set is archived',
            why: 'archiving the set would leave them Working, behind it',
            advice: `Move them in first with move_resource (to: “${root.rawName}”), then archive the whole set.`,
            suggestionAdvice: (id) => `${moveIn(id)}, then archive the whole set in one approval.`,
          }
        : {
            consequence: 'would stay Working, left behind when the set is archived',
            why: 'archiving the set would leave them Working, behind it',
            advice:
              'A Working page cannot be moved into an Authoritative set, so archive each of them with archive_page as well (or leave them Working on purpose).',
            suggestionAdvice: () =>
              'A Working page cannot be moved into an Authoritative set: archive each with archive_page too, or leave them Working on purpose.',
          };
    case 'move_to_working':
      return {
        consequence: `would stay where they are, apart from the Working set under “${root.rawName}”`,
        why: `they would not be part of the Working set this makes (they stay flat under [INDEX] ${workingName})`,
        advice: `Once the set is Working, bring them in with move_resource (to: “${root.rawName}”).`,
        suggestionAdvice: (id) => `Once the set is Working, ${moveIn(id).replace('Move', 'move')}.`,
      };
    default:
      return {
        consequence: 'would stay Working',
        why: 'this promotion would leave them Working',
        advice: `Move them in first with move_resource (to: “${root.rawName}”), then promote the whole set.`,
        suggestionAdvice: (id) => `${moveIn(id)}, then promote the whole set in one approval.`,
      };
  }
}

/**
 * C2d.1: Working pages that look as if they belong to a Working set but sit outside it: directly under
 * `[INDEX] Working` (flat) with the same subject as the set's root (`subjectOf`: a Subject row, else the name before
 * " - "; a character index's own subject). A set change would leave them behind (promote, archive) or apart (move to
 * Working), so the dry run and the proposal list them and suggest `move_resource` first.
 */
function workingOutsiders(
  ctx: RepoCtx,
  workingId: string,
  root: TreeNode,
  inSet: ReadonlySet<string>,
): { id: string; name: string; subject: string }[] {
  const pid = ctx.projectId;
  const flat = ctx.tree
    .children(pid, workingId)
    .data.filter((k) => k.kind === 'bwrk' && !inSet.has(k.id) && k.id !== root.id);
  if (flat.length === 0) return [];
  const sidebars = ctx.tree.sidebars(
    pid,
    flat.map((k) => k.id),
  ).data;
  const subjectRow = (id: string): string | null => {
    for (const b of sidebars.get(id) ?? []) {
      if (b.kind !== 'keyValue') continue;
      const row = (b.rows ?? []).find((r) => key(r.key) === 'subject');
      if (row && row.text.trim() !== '') return row.text.trim();
    }
    return null;
  };
  const want = key(ctx.types.characterRole?.(root.id)?.subject ?? root.displayName);
  return flat
    .map((k) => ({
      id: k.id,
      name: k.rawName,
      subject: ctx.types.characterRole?.(k.id)?.subject ?? subjectOf(k.displayName, subjectRow(k.id)),
    }))
    .filter((k) => key(k.subject) === want);
}

const EMPTY: LifecycleFacts = {
  status: null,
  continuityType: null,
  scope: null,
  temporalScope: null,
  lastMajorRevision: null,
};

function stateOfTarget(t: LifecycleTarget): SetState {
  const k = classifyName(t.name).kind;
  return k === 'barc' ? 'archived' : k === 'bwrk' ? 'working' : 'authoritative';
}

function dedupe<T extends { id: string; problem: string }>(l: readonly T[]): T[] {
  const seen = new Set<string>();
  return l.filter((x) => {
    const k = `${x.id}|${x.problem}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Related pages of a set (archive and move to Working only): for every page in it, the pages that link to or mention it
 * from the link index, plus one content search per content page, leaving out every link from inside the set.
 */
async function relatedForSet(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  tool: string,
  members: readonly Member[],
): Promise<Obj> {
  const lc = pd.services?.lifecycle;
  const inside = new Set(members.map((m) => m.page.node.id));
  const out: Obj[] = [];
  let freshness = 'the link index is not running';
  let failed = false;
  for (const m of members) {
    const fromIndex = lc ? lc.related(ctx.projectId, m.page.node.id) : null;
    if (fromIndex) freshness = fromIndex.freshness.text;
    const linked = (fromIndex?.pages ?? []).filter((p) => !inside.has(p.id));
    const known = new Set(linked.map((p) => p.id));
    const text: Obj[] = [];
    if (m.role === 'page') {
      const s = await liveRead(pd, mctx, tool, 'search', {
        query: { q: m.page.displayName.slice(0, 500), limit: 25 },
      });
      if (!s.ok) failed = true;
      else {
        const seen = new Set<string>();
        for (const hit of ((s.value as { data?: unknown } | null)?.data ?? []) as Obj[]) {
          const res = (hit.resource ?? {}) as Obj;
          const id = typeof res.id === 'string' ? res.id : null;
          if (!id || inside.has(id) || known.has(id) || seen.has(id)) continue;
          seen.add(id);
          const n = ctx.tree.node(ctx.projectId, id).data;
          if (!n) continue;
          text.push({
            id,
            name: n.rawName,
            path: n.path.names.join(' / '),
            found: 'found by text search (may be incomplete)',
          });
        }
      }
    }
    if (linked.length === 0 && text.length === 0) continue;
    out.push({
      page: { id: m.page.node.id, name: m.page.name },
      pages: linked.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        links: p.links.map((l) =>
          l.kind === 'collection' ? `link collection “${l.via}”` : `mentions it in “${l.via}”`,
        ),
      })),
      textSearch: text,
    });
  }
  return {
    pages: out,
    freshness,
    excluded: 'links between pages of the set are left out',
    note: 'Related pages are reported, never edited: check each one and change it yourself if it should no longer depend on these pages.',
    ...(failed ? { textSearchFailed: true } : {}),
  };
}
