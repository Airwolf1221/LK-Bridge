/**
 * v3 F4c (ADR 0065; the owner-approved design docs/design/F4c-fiction.md, E5): the narrative writing tools, listed while
 * the approved Arkona pack version carries narrative rules. Routine narrative organisation (the Fiction Writing
 * Reference, 32B: a request to write a chapter authorises saving it, and this organisation "does not create new
 * substantive canon owners"), so at scope `write` they write directly (on the Review page, Revertible); at scope
 * `propose` (or when the owner switched a tool to `propose` on the Packs page) they are proposals. More than 10 pages in
 * one call meets the bulk rail as a proposal.
 *
 * - `arkona_story_create`: the story index, its Story Map, and (with acts) the act indexes and Act Maps;
 * - `arkona_chapter_plan`: a Chapter Plan made or updated under the right map (its body comes from the template);
 * - `arkona_chapter_save`: the chapter's prose, its dateline written by the tool from In-world Date, saved new or
 *   revised in place (one resource, one document), read back word for word; the Drafting Gate enforced;
 * - `arkona_chapter_insert` and `arkona_chapter_move`: renumbering every later chapter and plan (names and Chapter
 *   Number fields, as items the owner can approve one by one when it is a proposal); never the prose.
 */
import * as z from 'zod';
import { fromMarkdown, MarkdownError, type LkBlock } from '../../markdown/index.js';
import { PACK_FILLER, shiftStep } from '../../packs/engine/job.js';
import { mintClientId } from '../../jobs/ids.js';
import type { LifecycleMarker, StepSpec } from '../../jobs/index.js';
import type { PlanItem } from '../../jobs/items.js';
import { EXPECT_STEP, VERIFY_STEP } from '../../jobs/internal-steps.js';
import { PageVersionConflictError, planPageWrite } from '../../pages/index.js';
import { datelineOf, formatName, holdsReservedWord, narrativeCompare } from '../../narrative/names.js';
import { nkey, type StoryLayout } from '../../narrative/layout.js';
import { narrativeTags } from '../../narrative/tags.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { newPage, planCreateJob, prefetchedTemplates, type NewPage } from './create-support.js';
import { defineTool } from './define.js';
import { CREATE_ANNOTATIONS } from './resources.js';
import {
  actFor,
  existingFacts,
  findContinuity,
  findStory,
  linkTargets,
  mention,
  narrativeTemplate,
  no,
  openEnv,
  pageRuns,
  readDate,
  ensureCalendar,
  templateFacts,
  text,
  yieldToLoop,
  type Env,
  type Obj,
  type R,
  type Row,
  type Tpl,
} from './narrative-support.js';
import { finish, liveRead } from './repo.js';
import { errorFromThrown, errorResult, projectArg, withProject, type ToolDeps } from './shape.js';
import { runWriteJob } from './write-job.js';

const PACK = 'arkona';

const storyArg = z
  .string()
  .min(1)
  .max(300)
  .describe('The story: its name (or id), as arkona_story_create made it.');
const continuityArg = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('“Main CANON” or an AU’s name: needed only when two continuities hold a story of that name.');
const dryRunArg = z.boolean().optional().describe('Show the plan; write nothing.');

/** The marker of a narrative job: every page it makes or changes has no lifecycle (`to: null`; design E2). */
const marker = (tool: string, ids: readonly string[]): LifecycleMarker | undefined =>
  ids.length === 0 ? undefined : { tool, canonical: false, pages: ids.map((id) => ({ id, to: null })) };

/** Steps of several parts in one job: each part's step references shifted past the parts before it. */
function joinParts(parts: readonly (readonly StepSpec[])[]): StepSpec[] {
  const out: StepSpec[] = [];
  for (const p of parts) {
    const base = out.length;
    for (const s of p) out.push(shiftStep(s, base));
  }
  return out;
}

/** The text of blocks as words (mentions by their label), for the word-for-word read-back. */
export function wordsOf(blocks: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (b: unknown) => {
    if (!b || typeof b !== 'object') return;
    const o = b as Obj;
    if (Array.isArray(o.content))
      for (const r of o.content as Obj[]) {
        if (typeof r.text === 'string') out.push(r.text);
        else if (r.mention && typeof r.mention === 'object') {
          const m = r.mention as Obj;
          out.push(typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '');
        }
        out.push(' ');
      }
    if (Array.isArray(o.children)) for (const c of o.children) walk(c);
    out.push('\n');
  };
  for (const b of blocks) walk(b);
  return out
    .join('')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** Compares two word lists; the first difference, or null. */
export function firstDifference(
  want: readonly string[],
  got: readonly string[],
): { at: number; expected: string; actual: string } | null {
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++)
    if (want[i] !== got[i])
      return {
        at: i,
        expected: want.slice(Math.max(0, i - 3), i + 4).join(' '),
        actual: got.slice(Math.max(0, i - 3), i + 4).join(' '),
      };
  return null;
}

const dash = /[–—]/;

// ============================================================================================ arkona_story_create

function storyCreateTool(deps: ToolDeps, listed: () => boolean): McpToolProvider {
  const tool = 'arkona_story_create';
  return defineTool({
    name: tool,
    title: 'Create a story under Narratives (Arkona pack)',
    access: 'write',
    description:
      'The Arkona pack (design F4c, E5): makes a STORY under Narratives, in Main CANON or an AU’s continuity index: the story index, its Story Map as its first child, and (with acts) one act index “Act <n> - <Title>” and one “Act <n> Map” under the Story Map per act, from the narrative templates, tagged Narrative + kind (+ AU), with no [BSRC] or [BWRK] prefix (narrative pages have no lifecycle). Without acts, chapters and plans later go straight under the story and its Story Map. ' +
      'A continuity index that does not exist yet is refused (the narrative audit proposes it); a story of that name in that continuity is refused. span: the Story Span (a date or range the calendar reads); principalCharacters: pages for the Principal Characters collection (a field the template lacks is refused as a template mismatch). ' +
      'At scope write it is written directly (Review page, Revertible); at scope propose, a proposal. dryRun shows the plan. Next: arkona_chapter_plan for each chapter. Cost: 1 to 2 template reads, then about 3 writes per page.',
    inputSchema: z.object({
      continuity: z
        .string()
        .min(1)
        .max(200)
        .describe('“Main CANON”, or the AU’s name (as defined under Continuities).'),
      title: z.string().min(1).max(150).describe('The story’s title (its index’s name).'),
      acts: z
        .array(z.string().min(1).max(150))
        .max(50)
        .optional()
        .describe('The acts’ titles, in order (Act 1, Act 2…). Leave out for a story without acts.'),
      span: z.string().min(1).max(200).optional().describe('Story Span: a date or range the calendar reads.'),
      principalCharacters: z
        .array(z.string().min(1).max(300))
        .max(50)
        .optional()
        .describe('The Principal Characters: page names or ids.'),
      dryRun: dryRunArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    listed,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const o = openEnv(pd, mctx, tool);
        if (!o.ok) return o.result;
        const env = o.value;
        try {
          return await storyCreate(env, args);
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      }),
  });
}

async function storyCreate(
  env: Env,
  args: {
    continuity: string;
    title: string;
    acts?: string[] | undefined;
    span?: string | undefined;
    principalCharacters?: string[] | undefined;
    dryRun?: boolean | undefined;
  },
): Promise<McpToolResult> {
  const { pd, rules, view } = env;
  const title = args.title.replace(/\s+/g, ' ').trim();
  const bad = (t: string, what: string) =>
    holdsReservedWord(rules, t)
      ? no(
          pd,
          'RESERVED_WORD',
          `${what} “${t}”: only the ${rules.indexes.main} index may carry “${rules.reservedWord}”.`,
        )
      : dash.test(t)
        ? no(pd, 'NAME_DASH', `${what} “${t}”: no em or en dashes in names (use a hyphen).`)
        : null;
  for (const [t, w] of [
    [title, 'The title'],
    ...(args.acts ?? []).map((a, i) => [a, `Act ${i + 1}’s title`]),
  ] as const) {
    const b = bad(t, w);
    if (b) return b.result;
  }
  const c = findContinuity(env, args.continuity);
  if (!c.ok) return c.result;
  const cont = c.value;
  const au = !cont.main;
  const twin = view
    .children(cont.node.id)
    .find((n) => n.kind === 'index' && nkey(n.displayName) === nkey(title));
  if (twin)
    return errorResult(
      {
        code: 'STORY_EXISTS',
        message: `${cont.name} already has a story “${twin.displayName}” (${twin.id}). Plan its chapters with arkona_chapter_plan, or choose another title.`,
        story: { id: twin.id, name: twin.displayName },
      },
      pd,
    );
  let span: string | null = null;
  if (args.span !== undefined) {
    await ensureCalendar(env);
    const d = readDate(env, args.span, 'Story Span');
    if (!d.ok) return d.result;
    span = d.value;
  }
  const principal = linkTargets(env, args.principalCharacters ?? []);
  if (!principal.ok) return principal.result;
  const mapTpl = await narrativeTemplate(env, 'storyMap');
  if (!mapTpl.ok) return mapTpl.result;
  const acts = args.acts ?? [];
  let actTpl: Tpl | null = null;
  if (acts.length > 0) {
    const t = await narrativeTemplate(env, 'actMap');
    if (!t.ok) return t.result;
    actTpl = t.value;
  }
  const f = rules.fields;
  const continuityRows = (): Row[] => [
    {
      key: f.continuityType,
      runs: text(au ? rules.continuityType.au : rules.continuityType.main),
      needed: false,
    },
    { key: f.continuity, runs: text(cont.name), needed: false },
  ];
  const story = newPage({
    key: 'story',
    rawName: `[INDEX] ${title}`,
    parent: { existing: cont.node.id },
    templateId: null,
    facts: null,
    parentName: cont.node.rawName,
    templateName: null,
    status: null,
    tags: narrativeTags(rules, 'story', au),
  });
  const mapId = mintClientId();
  const mapFacts = templateFacts(
    env,
    mapTpl.value,
    { id: mapId, name: rules.names.storyMap },
    [
      ...(span !== null ? [{ key: f.storySpan, runs: text(span), needed: true }] : []),
      { key: f.planningStatus, runs: text(rules.planning.planning), needed: false },
      ...continuityRows(),
    ],
    [{ title: f.principalCharacters, add: principal.value, needed: principal.value.length > 0 }],
  );
  if (!mapFacts.ok) return mapFacts.result;
  const pages: NewPage[] = [
    story,
    newPage({
      key: 'map',
      id: mapId,
      rawName: rules.names.storyMap,
      parent: { item: 'story' },
      templateId: mapTpl.value.id,
      facts: mapFacts.value.facts,
      parentName: story.rawName,
      templateName: mapTpl.value.name,
      status: null,
      tags: narrativeTags(rules, 'storyMap', au),
    }),
  ];
  const skipped = new Set(mapFacts.value.skipped);
  acts.forEach((t, i) => {
    const n = i + 1;
    const act = newPage({
      key: `act${n}`,
      rawName: `[INDEX] ${formatName(rules.names.act, n, t)}`,
      parent: { item: 'story' },
      templateId: null,
      facts: null,
      parentName: story.rawName,
      templateName: null,
      status: null,
      tags: narrativeTags(rules, 'act', au),
    });
    pages.push(act);
  });
  for (let i = 0; i < acts.length; i++) {
    const n = i + 1;
    const id = mintClientId();
    const name = formatName(rules.names.actMap, n);
    const ff = templateFacts(env, actTpl!, { id, name }, [
      { key: f.story, runs: mention(story.id, title), needed: false },
      { key: f.actNumber, runs: text(String(n)), needed: false },
      { key: f.planningStatus, runs: text(rules.planning.planning), needed: false },
      ...continuityRows(),
    ]);
    if (!ff.ok) return ff.result;
    ff.value.skipped.forEach((s) => skipped.add(s));
    pages.push(
      newPage({
        key: `actmap${n}`,
        id,
        rawName: name,
        parent: { item: 'map' },
        templateId: actTpl!.id,
        facts: ff.value.facts,
        parentName: rules.names.storyMap,
        templateName: actTpl!.name,
        status: null,
        tags: narrativeTags(rules, 'actMap', au),
      }),
    );
  }
  const planned = planCreateJob(env.ctx, pages, {
    batch: false,
    tool: env.tool,
    orderFor: () => narrativeCompare(rules),
  });
  if (!planned.ok) return planned.result;
  const { job } = planned.value;
  const summary = `${env.tool}: “${title}” in ${cont.name} (${pages.length} pages${acts.length ? `, ${acts.length} act${acts.length === 1 ? '' : 's'}` : ', no acts'})`;
  const head: Obj = {
    story: { id: story.id, name: title, continuity: cont.name, au },
    pages: job.pages,
    writes: job.writes,
    ...(skipped.size > 0
      ? {
          fieldsNotOnTemplate: [...skipped],
          note: 'These fields are not on the templates, so they were not written (the design’s suggested sidebars add them).',
        }
      : {}),
    next: 'arkona_chapter_plan { story, number, title } for each chapter; then arkona_chapter_context, the Question Gate, and arkona_chapter_save.',
  };
  const preview = () => ({ pages: job.pages.length, summary });
  if (args.dryRun === true)
    return finish(
      env.pd,
      env.mctx,
      env.tool,
      {
        ...head,
        status: 'dry_run',
        steps: job.labels.filter((l) => l !== 'check' && l !== 'verify'),
        message: 'Dry run: nothing was written and nothing was proposed.',
      },
      preview,
    );
  const out = await runWriteJob(env.pd, env.mctx, env.tool, {
    steps: job.steps,
    labels: job.labels,
    title: summary,
    lifecycle: marker(
      env.tool,
      pages.map((p) => p.id),
    ),
    ...(env.forceProposal ? { forceProposal: true } : {}),
    proposal: { operations: job.operations, summary, prefetched: prefetchedTemplates(env.cc) },
    head,
    preview,
  });
  return out.result;
}

// ============================================================================================ the tools

export function narrativeTools(deps: ToolDeps): McpToolProvider[] {
  // Listed while the pack is attached and its rules carry the narrative layout (as the other pack tools); a version
  // waiting for the owner's approval is refused at the call (PACK_NOT_CURRENT).
  const listed = () => {
    const packs = deps.services?.packs;
    return (packs?.toolListed(PACK) ?? false) && packs?.get(PACK)?.rules.narrative !== undefined;
  };
  return [storyCreateTool(deps, listed), ...chapterTools(deps, listed)];
}

// ============================================================================================ shared for chapters

const numberArg = z.number().int().min(1).max(9999);

/** The single Story Map of a story, or the refusal. */
function storyMapOf(env: Env, layout: StoryLayout): R<StoryLayout['storyMaps'][number]> {
  if (layout.storyMaps.length === 1) return { ok: true, value: layout.storyMaps[0]! };
  return no(
    env.pd,
    layout.storyMaps.length === 0 ? 'STORY_MAP_MISSING' : 'STORY_MAP_AMBIGUOUS',
    layout.storyMaps.length === 0
      ? `“${layout.story.displayName}” has no ${env.rules.names.storyMap} (its first child). Tell the owner; the narrative audit reports it.`
      : `“${layout.story.displayName}” has ${layout.storyMaps.length} pages named ${env.rules.names.storyMap}; the bridge will not guess which.`,
  );
}

/** One page of the story by its number, or null; two of one number are refused (the audit reports them). */
function oneNumbered<T extends { n: number; node: { id: string; displayName: string } }>(
  env: Env,
  list: readonly T[],
  n: number,
  what: string,
): R<T | null> {
  const hits = list.filter((x) => x.n === n);
  if (hits.length > 1)
    return no(
      env.pd,
      'DUPLICATE_NUMBER',
      `Two ${what}s are numbered ${n} (${hits.map((h) => h.node.displayName).join(', ')}); the narrative audit reports it. Nothing was written.`,
    );
  return { ok: true, value: hits[0] ?? null };
}

/** The row values of a page's sidebar as last read live (one read), by key. */
async function liveFacts(env: Env, id: string): Promise<R<Map<string, string>>> {
  const r = await liveRead(env.pd, env.mctx, env.tool, 'listProperties', { path: { resourceId: id } });
  if (!r.ok) return r;
  const out = new Map<string, string>();
  const data = (r.value as { data?: unknown } | null)?.data;
  for (const p of Array.isArray(data) ? (data as Obj[]) : []) {
    if (
      p.kind !== 'keyValue' ||
      nkey(typeof p.title === 'string' ? p.title : '') !== nkey(env.cc.propertyTitle)
    )
      continue;
    for (const row of Array.isArray(p.rows) ? (p.rows as Obj[]) : []) {
      const content = Array.isArray(row.content) ? (row.content as Obj[]) : [];
      const t = content
        .map((c) =>
          typeof c.text === 'string'
            ? c.text
            : c.mention && typeof c.mention === 'object'
              ? typeof (c.mention as Obj).text === 'string'
                ? ((c.mention as Obj).text as string)
                : ''
              : '',
        )
        .join('')
        .trim();
      if (typeof row.key === 'string')
        out.set(nkey(row.key), t || (typeof row.text === 'string' ? row.text.trim() : ''));
    }
  }
  return { ok: true, value: out };
}

// ============================================================================================ arkona_chapter_plan

async function chapterPlan(
  env: Env,
  args: {
    story: string;
    continuity?: string | undefined;
    number: number;
    act?: number | undefined;
    title?: string | undefined;
    plannedDate?: string | undefined;
    pov?: string | undefined;
    questionGate?: 'open' | 'closed' | undefined;
    dryRun?: boolean | undefined;
  },
): Promise<McpToolResult> {
  const { pd, rules } = env;
  const f = rules.fields;
  const st = findStory(env, args.story, args.continuity);
  if (!st.ok) return st.result;
  const { layout } = st.value;
  const map = storyMapOf(env, layout);
  if (!map.ok) return map.result;
  const n = args.number;
  const had = oneNumbered(env, layout.plans, n, 'Chapter Plan');
  if (!had.ok) return had.result;
  const chapter = oneNumbered(env, layout.chapters, n, 'chapter');
  if (!chapter.ok) return chapter.result;
  let planned: string | null = null;
  if (args.plannedDate !== undefined) {
    await ensureCalendar(env);
    const d = readDate(env, args.plannedDate, 'Planned Date');
    if (!d.ok) return d.result;
    planned = d.value;
  }
  let pov: Obj[] | null = null;
  if (args.pov !== undefined) {
    const p = pageRuns(env, args.pov, 'POV');
    if (!p.ok) return p.result;
    pov = p.value;
  }
  const title = args.title?.replace(/\s+/g, ' ').trim();
  if (title && dash.test(title))
    return no(pd, 'NAME_DASH', `The title “${title}”: no em or en dashes (use a hyphen).`).result;
  const story = layout.story;
  const au = layout.continuity !== null && !layout.continuity.main;
  const rowsFor = (actNode: { id: string; displayName: string } | null, isNew: boolean): Row[] => [
    { key: f.story, runs: mention(story.id, story.displayName), needed: false },
    ...(actNode ? [{ key: f.act, runs: mention(actNode.id, actNode.displayName), needed: false }] : []),
    { key: f.chapterNumber, runs: text(String(n)), needed: false },
    ...(chapter.value
      ? [
          {
            key: f.chapter,
            runs: mention(chapter.value.node.id, chapter.value.node.displayName),
            needed: false,
          },
        ]
      : []),
    ...(planned !== null ? [{ key: f.plannedDate, runs: text(planned), needed: true }] : []),
    ...(pov ? [{ key: f.pov, runs: pov, needed: true }] : []),
    ...(args.questionGate
      ? [
          {
            key: f.questionGate,
            runs: text(args.questionGate === 'open' ? rules.gate.open : rules.gate.closed),
            needed: true,
          },
        ]
      : isNew
        ? [{ key: f.questionGate, runs: text(rules.gate.open), needed: false }]
        : []),
    ...(isNew ? [{ key: f.planningStatus, runs: text(rules.planning.planned), needed: false }] : []),
    // The generic Working sidebar has no title field; its Subject holds the chapter's working title (chosen).
    ...(title ? [{ key: 'Subject', runs: text(title), needed: false }] : []),
  ];
  const summaryOf = (what: string) =>
    `${env.tool}: ${story.displayName}, Chapter ${n}${title ? ` (“${title}”)` : ''}: ${what}`;
  if (had.value) {
    const plan = had.value;
    if (args.act !== undefined && plan.act !== args.act)
      return no(
        pd,
        'PLAN_ELSEWHERE',
        `Chapter ${n}’s plan is in ${plan.act === null ? 'the Story Map' : `Act ${plan.act}`}; move it with arkona_chapter_move.`,
      ).result;
    const actNode = plan.act === null ? null : (layout.acts.find((a) => a.n === plan.act)?.node ?? null);
    const ef = await existingFacts(
      env,
      { id: plan.node.id, name: plan.node.displayName },
      rowsFor(actNode, false),
    );
    if (!ef.ok) return ef.result;
    const head = {
      plan: { id: plan.node.id, name: plan.node.displayName, updated: true },
      changes: ef.value.changes,
      ...(ef.value.skipped.length ? { fieldsNotOnPage: ef.value.skipped } : {}),
      note: 'The planning text itself is written with write_page (the Workflow’s chapter-plan headings).',
    };
    if (ef.value.steps.length === 0)
      return finish(
        pd,
        env.mctx,
        env.tool,
        { ...head, status: 'no_change', message: 'The plan already holds this. Nothing was sent.' },
        () => head,
      );
    if (args.dryRun === true)
      return finish(
        pd,
        env.mctx,
        env.tool,
        { ...head, status: 'dry_run', message: 'Dry run: nothing was written and nothing was proposed.' },
        () => head,
      );
    const summary = summaryOf(`plan updated (${ef.value.changes.join(', ')})`);
    const out = await runWriteJob(pd, env.mctx, env.tool, {
      steps: [...ef.value.steps],
      labels: ef.value.steps.map((s) => s.op),
      title: summary,
      holdLock: { resourceId: plan.node.id },
      lifecycle: marker(env.tool, [plan.node.id]),
      ...(env.forceProposal ? { forceProposal: true } : {}),
      proposal: {
        operations: [
          { tool: env.tool, page: { id: plan.node.id, name: plan.node.displayName }, pageParts: ['sidebar'] },
        ],
        summary,
      },
      head,
      preview: () => head,
    });
    return out.result;
  }
  const a = actFor(env, layout, n, args.act);
  if (!a.ok) return a.result;
  let parent: { id: string; rawName: string; displayName: string } = map.value;
  if (a.value) {
    const am = layout.actMaps.find((x) => x.n === a.value!.n);
    if (!am)
      return no(
        pd,
        'ACT_MAP_MISSING',
        `Act ${a.value.n} has no “${formatName(rules.names.actMap, a.value.n)}” under the ${rules.names.storyMap}. Tell the owner; the narrative audit reports it.`,
      ).result;
    parent = am.node;
  }
  const tpl = await narrativeTemplate(env, 'chapterPlan');
  if (!tpl.ok) return tpl.result;
  const id = mintClientId();
  const name = formatName(rules.names.chapterPlan, n);
  const ff = templateFacts(env, tpl.value, { id, name }, rowsFor(a.value?.node ?? null, true));
  if (!ff.ok) return ff.result;
  const page = newPage({
    key: 'plan',
    id,
    rawName: name,
    parent: { existing: parent.id },
    templateId: tpl.value.id,
    facts: ff.value.facts,
    parentName: parent.rawName,
    templateName: tpl.value.name,
    status: null,
    tags: narrativeTags(rules, 'chapterPlan', au),
  });
  const planned2 = planCreateJob(env.ctx, [page], {
    batch: false,
    tool: env.tool,
    orderFor: () => narrativeCompare(rules),
  });
  if (!planned2.ok) return planned2.result;
  const { job } = planned2.value;
  const head = {
    plan: { id, name, parent: { id: parent.id, name: parent.displayName }, created: true },
    pages: job.pages,
    ...(ff.value.skipped.length ? { fieldsNotOnTemplate: ff.value.skipped } : {}),
    questionGate: hasGateField(tpl.value.keys, rules)
      ? `${args.questionGate === 'closed' ? rules.gate.closed : rules.gate.open}: arkona_chapter_save refuses this chapter while it is ${rules.gate.open} (the Workflow’s Drafting Gate). Ask the plan’s questions, then close it (arkona_chapter_plan with questionGate "closed").`
      : 'The Chapter Plan template has no Question Gate field yet, so the Drafting Gate is not enforced for this plan.',
    note: 'Its body is the template’s (the Workflow’s chapter-plan headings): write the planning text with write_page.',
  };
  if (args.dryRun === true)
    return finish(
      pd,
      env.mctx,
      env.tool,
      { ...head, status: 'dry_run', message: 'Dry run: nothing was written and nothing was proposed.' },
      () => head,
    );
  const summary = summaryOf('plan created');
  const out = await runWriteJob(pd, env.mctx, env.tool, {
    steps: job.steps,
    labels: job.labels,
    title: summary,
    lifecycle: marker(env.tool, [id]),
    ...(env.forceProposal ? { forceProposal: true } : {}),
    proposal: { operations: job.operations, summary, prefetched: prefetchedTemplates(env.cc) },
    head,
    preview: () => head,
  });
  return out.result;
}

const hasGateField = (keys: readonly string[], rules: Env['rules']) =>
  keys.some((k) => nkey(k) === nkey(rules.fields.questionGate));

// ============================================================================================ arkona_chapter_save

/** The agent's own dateline, if its Markdown starts with one (a date the calendar reads, then at most a place). */
export function stripDateline(
  md: string,
  isDate: (line: string) => boolean,
): { readonly body: string; readonly removed: string | null } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i < 0) return { body: '', removed: null };
  const raw = lines[i]!.trim();
  const plain = raw
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim();
  const head = plain.split(/\s*[·•|]\s*|\s+[-–—]\s+(?=[^\d])/)[0]!.trim();
  if (
    plain.length <= 160 &&
    !/[.!?]["”’]?$/.test(plain.replace(/\b(?:c|ca|approx)\.\s*/gi, '')) &&
    isDate(head)
  )
    return {
      body: lines
        .slice(i + 1)
        .join('\n')
        .replace(/^\n+/, ''),
      removed: raw,
    };
  return { body: md, removed: null };
}

interface SaveArgs {
  story: string;
  continuity?: string | undefined;
  number: number;
  title?: string | undefined;
  act?: number | undefined;
  inWorldDate: string;
  place?: string | undefined;
  pov: string;
  charactersPresent: string[];
  locations: string[];
  draftStatus: string;
  markdown: string;
  baseVersion?: string | undefined;
  overrideGate?: { reason: string } | undefined;
  dryRun?: boolean | undefined;
}

async function chapterSave(env: Env, args: SaveArgs): Promise<McpToolResult> {
  const { pd, rules } = env;
  const f = rules.fields;
  const st = findStory(env, args.story, args.continuity);
  if (!st.ok) return st.result;
  const { layout } = st.value;
  const story = layout.story;
  const n = args.number;
  const existing = oneNumbered(env, layout.chapters, n, 'chapter');
  if (!existing.ok) return existing.result;
  const plan = oneNumbered(env, layout.plans, n, 'Chapter Plan');
  if (!plan.ok) return plan.result;
  await ensureCalendar(env);
  const date = readDate(env, args.inWorldDate, 'In-world Date');
  if (!date.ok) return date.result;
  const place = args.place?.replace(/\s+/g, ' ').trim() || null;
  if (place && dash.test(place))
    return no(pd, 'NAME_DASH', `place “${place}”: no em or en dashes (use a hyphen).`).result;
  const dateline = datelineOf(rules, date.value, place);
  const stripped = stripDateline(args.markdown, (line) => {
    const r = readDate(env, line, 'line');
    return r.ok;
  });
  if (stripped.body.trim() === '')
    return no(pd, 'EMPTY_CHAPTER', 'The chapter has no prose after its dateline. Nothing was written.')
      .result;
  const markdown = `${dateline}\n\n${stripped.body.trim()}\n`;
  const pov = pageRuns(env, args.pov, 'POV');
  if (!pov.ok) return pov.result;
  const people = linkTargets(env, args.charactersPresent);
  if (!people.ok) return people.result;
  const places = linkTargets(env, args.locations);
  if (!places.ok) return places.result;

  // The Drafting Gate (the Workflow): the chapter's plan must have its Question Gate Closed, unless overridden.
  let gate: Obj;
  if (!plan.value)
    gate = {
      enforced: false,
      note: `There is no Chapter ${n} Plan, so the Drafting Gate could not be checked (the narrative audit reports a chapter without a plan).`,
    };
  else {
    const lf = await liveFacts(env, plan.value.node.id);
    if (!lf.ok) return lf.result;
    const v = lf.value.get(nkey(f.questionGate));
    if (v === undefined)
      gate = {
        enforced: false,
        note: 'The Chapter Plan has no Question Gate field yet (its template’s sidebar), so the Drafting Gate is not enforced.',
      };
    else if (nkey(v) === nkey(rules.gate.closed)) gate = { enforced: true, state: rules.gate.closed };
    else if (args.overrideGate)
      gate = { enforced: true, state: v || rules.gate.open, overridden: args.overrideGate.reason };
    else
      return no(
        pd,
        'QUESTION_GATE_OPEN',
        `Chapter ${n}’s plan has its Question Gate ${v || rules.gate.open}: the Workflow’s Drafting Gate makes closing it a precondition of drafting. Ask the plan’s questions and close it (arkona_chapter_plan with questionGate "closed"), or pass overrideGate: { reason } (the reason is shown on the Review page). Nothing was written.`,
        { plan: { id: plan.value.node.id, name: plan.value.node.displayName } },
      ).result;
  }
  const gateNote = gate.overridden
    ? ` (Question Gate overridden: ${(typeof gate.overridden === 'string' ? gate.overridden : '').slice(0, 200)})`
    : '';
  const au = layout.continuity !== null && !layout.continuity.main;
  const rows = (
    actNode: { id: string; displayName: string } | null,
    planNode: { id: string; displayName: string } | null,
  ): Row[] => [
    { key: f.story, runs: mention(story.id, story.displayName), needed: false },
    ...(actNode ? [{ key: f.act, runs: mention(actNode.id, actNode.displayName), needed: false }] : []),
    { key: f.chapterNumber, runs: text(String(n)), needed: true },
    { key: f.inWorldDate, runs: text(date.value), needed: true },
    ...(layout.continuity ? [{ key: f.continuity, runs: text(layout.continuity.name), needed: false }] : []),
    { key: f.pov, runs: pov.value, needed: true },
    ...(planNode
      ? [{ key: f.chapterPlan, runs: mention(planNode.id, planNode.displayName), needed: false }]
      : []),
    { key: f.draftStatus, runs: text(args.draftStatus.trim()), needed: true },
  ];
  const links = [
    { title: f.charactersPresent, add: people.value, needed: true },
    { title: f.locations, add: places.value, needed: places.value.length > 0 },
  ];
  /** The plan points at the chapter and says Drafted (only the fields its page has). */
  const planSteps = async (chapterId: string, chapterName: string): Promise<R<readonly StepSpec[]>> => {
    if (!plan.value) return { ok: true, value: [] };
    const ef = await existingFacts(env, { id: plan.value.node.id, name: plan.value.node.displayName }, [
      { key: f.chapter, runs: mention(chapterId, chapterName), needed: false },
      { key: f.planningStatus, runs: text(rules.planning.drafted), needed: false },
    ]);
    return ef.ok ? { ok: true, value: ef.value.steps } : ef;
  };

  if (existing.value) {
    // ---- a revision, in place: the same resource and document, never a duplicate.
    const ch = existing.value;
    if (args.baseVersion === undefined)
      return no(
        pd,
        'NUMBER_TAKEN',
        `Chapter ${n} already exists (“${ch.node.displayName}”). To revise it, read it (read_document) and pass the version as baseVersion; to add a chapter here, make room with arkona_chapter_insert. Nothing was written.`,
        { chapter: { id: ch.node.id, name: ch.node.displayName } },
      ).result;
    if (args.act !== undefined && ch.act?.n !== args.act)
      return no(
        pd,
        'ACT_CHANGE',
        `Chapter ${n} is in ${ch.act ? `Act ${ch.act.n}` : 'the story itself'}; move it with arkona_chapter_move. Nothing was written.`,
      ).result;
    const node = env.view.treeNode(ch.node.id);
    const doc = node?.documents.find((d) => d.type === 'page') ?? null;
    if (!node || !doc)
      return no(pd, 'DOCUMENT_NOT_FOUND', `“${ch.node.displayName}” has no page document.`).result;
    const read = await liveRead(pd, env.mctx, env.tool, 'getDocumentBlocks', {
      path: { resourceId: node.id, documentId: doc.id },
    });
    if (!read.ok) return read.result;
    const current = read.value as { version?: unknown; blocks?: unknown };
    if (typeof current.version !== 'string' || !Array.isArray(current.blocks))
      return no(pd, 'DOCUMENT_UNREADABLE', `${ch.node.displayName}: its document could not be read.`).result;
    let planned;
    try {
      planned = planPageWrite(
        { version: current.version, blocks: current.blocks as LkBlock[] },
        { mode: 'replace', markdown },
        env.converter,
        { baseVersion: args.baseVersion },
      );
    } catch (e) {
      if (e instanceof PageVersionConflictError)
        return errorResult({ code: 'VERSION_CONFLICT', ...e.toJSON(), message: `${e.message}` }, pd);
      if (e instanceof MarkdownError)
        return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
      throw e;
    }
    const title = (args.title?.replace(/\s+/g, ' ').trim() || ch.title) ?? ch.title;
    if (dash.test(title))
      return no(pd, 'NAME_DASH', `The title “${title}”: no em or en dashes (use a hyphen).`).result;
    const newName = formatName(rules.names.chapter, n, title);
    const ef = await existingFacts(
      env,
      { id: node.id, name: node.displayName },
      rows(ch.act?.node ?? null, plan.value?.node ?? null),
      links,
    );
    if (!ef.ok) return ef.result;
    const ps = await planSteps(node.id, newName);
    if (!ps.ok) return ps.result;
    const body: StepSpec = {
      op: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: node.id, documentId: doc.id },
        ifMatch: planned.version,
        body: { blocks: planned.blocks },
      },
      verifyAfterWrite: true,
      journalOperation: {
        tool: env.tool,
        page: { id: node.id, name: node.displayName },
        write: 'the chapter’s text',
      },
    };
    const rename: StepSpec[] =
      newName !== node.displayName
        ? [
            {
              op: 'updateResource',
              params: { path: { resourceId: node.id }, body: { name: newName } },
              journalOperation: {
                tool: env.tool,
                page: { id: node.id, name: node.displayName },
                write: `renamed ${newName}`,
              },
            },
          ]
        : [];
    const steps = joinParts([[body], ef.value.steps, rename, ps.value]);
    return saveAndReadBack(env, {
      steps,
      title: `${env.tool}: ${story.displayName}, Chapter ${n} revised${gateNote}`,
      chapter: { id: node.id, name: newName, documentId: doc.id, revised: true },
      planted: planned.blocks,
      dateline,
      removed: stripped.removed,
      gate,
      skipped: ef.value.skipped,
      holdLock: { resourceId: node.id },
      holdDocuments: [doc.id],
      holdMore: plan.value ? [plan.value.node.id] : [],
      dryRun: args.dryRun === true,
      au,
    });
  }

  // ---- a new chapter.
  const a = actFor(env, layout, n, args.act);
  if (!a.ok) return a.result;
  const title = args.title?.replace(/\s+/g, ' ').trim() ?? '';
  if (title === '')
    return no(
      pd,
      'TITLE_REQUIRED',
      `A new chapter needs a title (its name is “${formatName(rules.names.chapter, n, '<Title>')}”). Nothing was written.`,
    ).result;
  if (dash.test(title))
    return no(pd, 'NAME_DASH', `The title “${title}”: no em or en dashes (use a hyphen).`).result;
  const parent = a.value ? env.view.treeNode(a.value.node.id) : env.view.treeNode(story.id);
  if (!parent) return no(pd, 'NOT_FOUND', 'The chapter’s parent is not in the repository tree.').result;
  const tpl = await narrativeTemplate(env, 'chapter');
  if (!tpl.ok) return tpl.result;
  const id = mintClientId();
  const name = formatName(rules.names.chapter, n, title);
  const ff = templateFacts(
    env,
    tpl.value,
    { id, name },
    rows(a.value?.node ?? null, plan.value?.node ?? null),
    links,
  );
  if (!ff.ok) return ff.result;
  let blocks: LkBlock[];
  try {
    blocks = fromMarkdown(markdown, { blocks: [] }, env.converter).blocks;
  } catch (e) {
    if (e instanceof MarkdownError)
      return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
    throw e;
  }
  const page = newPage({
    key: 'chapter',
    id,
    rawName: name,
    parent: { existing: parent.id },
    templateId: tpl.value.id,
    facts: ff.value.facts,
    parentName: parent.rawName,
    templateName: tpl.value.name,
    status: null,
    tags: narrativeTags(rules, 'chapter', au),
  });
  const planned = planCreateJob(env.ctx, [page], {
    batch: false,
    tool: env.tool,
    orderFor: () => narrativeCompare(rules),
  });
  if (!planned.ok) return planned.result;
  const { job } = planned.value;
  const createStep = job.steps.findIndex((s) => s.op === 'createResourceFromTemplate') + 1;
  const body: StepSpec = {
    op: 'replaceDocumentBlocks',
    params: { path: { resourceId: id, documentId: 'pending' }, body: { blocks } },
    bindFrom: { step: createStep, to: 'path.documentId', from: 'documents.main.id' },
    // The template copy's body is replaced inside the lock (anything the template holds that Markdown cannot is kept).
    fill: { filler: PACK_FILLER, input: { keepSections: [] } },
    verifyAfterWrite: true,
    journalOperation: { tool: env.tool, page: { id, name }, write: 'the chapter’s text' },
  };
  const ps = await planSteps(id, name);
  if (!ps.ok) return ps.result;
  // The text right after the create's own part (its binding names the create's step number, unshifted).
  const steps = joinParts([[...job.steps, body], ps.value]);
  return saveAndReadBack(env, {
    steps,
    title: `${env.tool}: ${story.displayName}, Chapter ${n} “${title}” saved${gateNote}`,
    chapter: { id, name, parent: { id: parent.id, name: parent.displayName }, created: true },
    planted: blocks,
    dateline,
    removed: stripped.removed,
    gate,
    skipped: ff.value.skipped,
    // No job-level lock: each write takes its own (the new page's text is bound to its document only when it exists,
    // as a package's is); the plan's facts are checked against what was read, inside their own write's lock.
    holdMore: [],
    dryRun: args.dryRun === true,
    au,
    operations: job.operations,
  });
}

/** Submits a save, and (once written) reads the chapter back and compares it word for word (32B). */
async function saveAndReadBack(
  env: Env,
  o: {
    steps: StepSpec[];
    title: string;
    chapter: Obj & { id: string; name: string; documentId?: string };
    planted: readonly unknown[];
    dateline: string;
    removed: string | null;
    gate: Obj;
    skipped: readonly string[];
    holdLock?: { resourceId: string };
    holdDocuments?: string[];
    holdMore: string[];
    dryRun: boolean;
    au: boolean;
    operations?: readonly Obj[];
  },
): Promise<McpToolResult> {
  const { pd } = env;
  const head: Obj = {
    chapter: o.chapter,
    dateline: o.dateline,
    ...(o.removed
      ? {
          replacedDateline: o.removed,
          note: 'Your own first line was a dateline: it was replaced by the one written from In-world Date.',
        }
      : {}),
    gate: o.gate,
    ...(o.skipped.length ? { fieldsNotOnTemplate: o.skipped } : {}),
    next: 'arkona_chapter_check { chapter } (read-only): what the chapter says against canon at its date, and any new-lore candidates; then arkona_promote_from_chapter for the ones the owner should see.',
  };
  const preview = () => ({ chapter: o.chapter.name, dateline: o.dateline });
  if (o.dryRun)
    return finish(
      pd,
      env.mctx,
      env.tool,
      {
        ...head,
        status: 'dry_run',
        words: wordsOf(o.planted).length,
        message: 'Dry run: nothing was written and nothing was proposed.',
      },
      preview,
    );
  const out = await runWriteJob(pd, env.mctx, env.tool, {
    steps: o.steps,
    labels: o.steps.map((s) => (s.op === 'replaceDocumentBlocks' ? 'text' : s.op)),
    title: o.title,
    // The engine holds further locks only with a page lock: the plan's, when the chapter is new.
    ...(o.holdLock
      ? { holdLock: o.holdLock, ...(o.holdMore.length ? { holdMore: { resources: o.holdMore } } : {}) }
      : o.holdMore.length
        ? {
            holdLock: { resourceId: o.holdMore[0]! },
            ...(o.holdMore.length > 1 ? { holdMore: { resources: o.holdMore.slice(1) } } : {}),
          }
        : {}),
    ...(o.holdDocuments ? { holdDocuments: o.holdDocuments } : {}),
    lifecycle: marker(env.tool, [o.chapter.id, ...o.holdMore]),
    ...(env.forceProposal ? { forceProposal: true } : {}),
    proposal: {
      operations: o.operations ?? [
        { tool: env.tool, page: { id: o.chapter.id, name: o.chapter.name }, pageParts: ['text', 'sidebar'] },
      ],
      summary: o.title.slice(0, 500),
      prefetched: prefetchedTemplates(env.cc),
    },
    head,
    preview,
  });
  if (out.body.status !== 'written') return out.result;
  // 32B: the prose verified by DIRECT read-back, word for word.
  let documentId = o.chapter.documentId;
  if (!documentId) {
    const res = await liveRead(pd, env.mctx, env.tool, 'getResource', { path: { resourceId: o.chapter.id } });
    if (res.ok) {
      const docs = ((res.value as { documents?: unknown }).documents ?? []) as Obj[];
      const d = docs.find((x) => x.type === 'page' && !x.deletedAt) ?? null;
      documentId = d && typeof d.id === 'string' ? d.id : undefined;
    }
  }
  let readBack: Obj;
  if (!documentId)
    readBack = {
      matches: null,
      note: 'The chapter’s document could not be found to read back; read it with read_document.',
    };
  else {
    const r = await liveRead(pd, env.mctx, env.tool, 'getDocumentBlocks', {
      path: { resourceId: o.chapter.id, documentId },
    });
    if (!r.ok)
      readBack = {
        matches: null,
        note: 'The read-back could not be made; read the chapter with read_document.',
      };
    else {
      const got = (r.value as { blocks?: unknown[]; version?: unknown }).blocks ?? [];
      const want = wordsOf(o.planted);
      const diff = firstDifference(want, wordsOf(got));
      readBack = {
        matches: diff === null,
        words: want.length,
        version: (r.value as { version?: unknown }).version ?? null,
        documentId,
        ...(diff
          ? {
              firstDifference: diff,
              warning:
                'The chapter as read back differs from what was sent: read it (read_document) and check it; nothing was retried.',
            }
          : {}),
      };
    }
  }
  const body = { ...out.body, readBack };
  return finish(pd, env.mctx, env.tool, body, preview);
}

// ============================================================================================ renumbering

interface Renumber {
  readonly id: string;
  readonly rawName: string;
  readonly kind: 'chapter' | 'plan';
  readonly from: number;
  readonly to: number;
  readonly title?: string;
  readonly parentId: string;
  /** A move to another parent (an act index, an Act Map), with its slot. */
  readonly move?: { readonly parentId: string; readonly after?: string; readonly before?: string };
}

/** The renumbering's steps and items (each page one item: its name, its Chapter Number, its move). */
async function renumberParts(
  env: Env,
  list: readonly Renumber[],
): Promise<R<{ parts: StepSpec[][]; items: PlanItem[]; targets: Obj[]; targetItems: string[][] }>> {
  const { rules } = env;
  const parts: StepSpec[][] = [];
  const items: PlanItem[] = [];
  const targets: Obj[] = [];
  const targetItems: string[][] = [];
  let i = 0;
  for (const r of list) {
    if (++i % 5 === 0) await yieldToLoop(); // R3-64: a long renumbering gives the event loop its turns
    const item = `renumber:${r.id}`;
    const newName =
      r.kind === 'chapter'
        ? formatName(rules.names.chapter, r.to, r.title ?? '')
        : formatName(rules.names.chapterPlan, r.to);
    const steps: StepSpec[] = [
      {
        op: EXPECT_STEP,
        params: {
          body: {
            checks: [
              { label: r.rawName, kind: 'resource', resourceId: r.id, name: r.rawName, parentId: r.parentId },
            ],
          },
        },
        items: [item],
      },
    ];
    if (newName !== r.rawName)
      steps.push({
        op: 'updateResource',
        params: { path: { resourceId: r.id }, body: { name: newName } },
        journalOperation: {
          tool: env.tool,
          page: { id: r.id, name: r.rawName },
          write: `renamed ${newName}`,
        },
        items: [item],
      });
    if (r.move)
      steps.push({
        op: 'moveResource',
        params: {
          path: { resourceId: r.id },
          body: {
            parentId: r.move.parentId,
            ...(r.move.after ? { after: r.move.after } : {}),
            ...(r.move.before ? { before: r.move.before } : {}),
          },
        },
        journalOperation: { tool: env.tool, page: { id: r.id, name: newName }, write: 'moved' },
        items: [item],
      });
    const ef =
      r.from === r.to
        ? null
        : await existingFacts(env, { id: r.id, name: r.rawName }, [
            { key: rules.fields.chapterNumber, runs: text(String(r.to)), needed: false },
          ]);
    if (ef && !ef.ok) return ef;
    parts.push(steps);
    if (ef && ef.value.steps.length > 0) parts.push(ef.value.steps.map((s) => ({ ...s, items: [item] })));
    items.push({
      id: item,
      kind: 'renumber',
      group: r.kind === 'chapter' ? 'Chapters' : 'Chapter Plans',
      label: `${r.rawName} → ${newName}${r.move ? ' (moved)' : ''}`,
      page: { id: r.id, name: r.rawName },
      diff: { before: r.rawName, after: newName },
      dependsOn: [],
      selected: true,
    });
    targets.push({
      kind: 'resource',
      label: newName,
      resourceId: r.id,
      fields: { name: newName, parentId: r.move?.parentId ?? r.parentId },
    });
    targetItems.push([item]);
  }
  return { ok: true, value: { parts, items, targets, targetItems } };
}

/** Submits a renumbering (with any page the call makes) as ONE job of items; the bulk rail judges its size. */
async function submitRenumbering(
  env: Env,
  o: {
    title: string;
    parts: StepSpec[][];
    items: PlanItem[];
    targets: Obj[];
    targetItems: string[][];
    ids: string[];
    head: Obj;
    dryRun: boolean;
    operations: Obj[];
  },
): Promise<McpToolResult> {
  const verify: StepSpec = {
    op: VERIFY_STEP,
    params: { body: { targets: o.targets } },
    itemParts: [{ path: 'body.targets', items: o.targetItems }],
  };
  const steps = joinParts([...o.parts, ...(o.targets.length ? [[verify]] : [])]);
  const head = { ...o.head, pages: o.ids.length, items: o.items.map((i) => ({ id: i.id, label: i.label })) };
  const preview = () => ({ pages: o.ids.length, summary: o.title });
  if (o.dryRun)
    return finish(
      env.pd,
      env.mctx,
      env.tool,
      {
        ...head,
        status: 'dry_run',
        message:
          'Dry run: nothing was written and nothing was proposed. The prose is never changed by a renumbering.',
      },
      preview,
    );
  const out = await runWriteJob(env.pd, env.mctx, env.tool, {
    steps,
    labels: steps.map((s) => s.op),
    title: o.title,
    holdLock: { resourceId: o.ids[0]! },
    ...(o.ids.length > 1 ? { holdMore: { resources: o.ids.slice(1) } } : {}),
    lifecycle: marker(env.tool, o.ids),
    ...(env.forceProposal ? { forceProposal: true } : {}),
    proposal: {
      operations: o.operations,
      summary: o.title.slice(0, 500),
      items: o.items,
      prefetched: prefetchedTemplates(env.cc),
    },
    head,
    preview,
  });
  return out.result;
}

/** The order to rename in, so no two pages ever share a name on the way: away from the gap first. */
const renameOrder = (list: Renumber[]) =>
  [...list].sort((a, b) => (a.to > a.from ? b.from - a.from : a.from - b.from));

async function chapterInsert(
  env: Env,
  args: {
    story: string;
    continuity?: string | undefined;
    at: number;
    act?: number | undefined;
    title: string;
    dryRun?: boolean | undefined;
  },
): Promise<McpToolResult> {
  const { pd, rules } = env;
  const st = findStory(env, args.story, args.continuity);
  if (!st.ok) return st.result;
  const { layout } = st.value;
  const map = storyMapOf(env, layout);
  if (!map.ok) return map.result;
  const at = args.at;
  const max = Math.max(0, ...layout.chapters.map((c) => c.n), ...layout.plans.map((p) => p.n));
  if (at > max + 1)
    return no(
      pd,
      'POSITION_OUT_OF_RANGE',
      `The story’s chapters run to ${max}; insert at ${max + 1} at most (or plan it with arkona_chapter_plan).`,
    ).result;
  const title = args.title.replace(/\s+/g, ' ').trim();
  if (dash.test(title))
    return no(pd, 'NAME_DASH', `The title “${title}”: no em or en dashes (use a hyphen).`).result;
  // Which act the new chapter goes in: one whose place holds the position (between the chapters before and after it).
  const a = actFor(env, layout, at - 0.5, args.act);
  if (!a.ok) return a.result;
  const shifted: Renumber[] = [
    ...layout.chapters
      .filter((c) => c.n >= at)
      .map((c) => ({
        id: c.node.id,
        rawName: c.node.displayName,
        kind: 'chapter' as const,
        from: c.n,
        to: c.n + 1,
        title: c.title,
        parentId: c.node.parentId!,
      })),
    ...layout.plans
      .filter((p) => p.n >= at)
      .map((p) => ({
        id: p.node.id,
        rawName: p.node.displayName,
        kind: 'plan' as const,
        from: p.n,
        to: p.n + 1,
        parentId: p.node.parentId!,
      })),
  ];
  const rp = await renumberParts(env, renameOrder(shifted));
  if (!rp.ok) return rp.result;
  // The new chapter's Chapter Plan, placed among its siblings as they will be named after the renumbering.
  let parent: { id: string; rawName: string; displayName: string } = map.value;
  if (a.value) {
    const am = layout.actMaps.find((x) => x.n === a.value!.n);
    if (!am)
      return no(
        pd,
        'ACT_MAP_MISSING',
        `Act ${a.value.n} has no Act Map; tell the owner (the narrative audit reports it).`,
      ).result;
    parent = am.node;
  }
  const tpl = await narrativeTemplate(env, 'chapterPlan');
  if (!tpl.ok) return tpl.result;
  const id = mintClientId();
  const name = formatName(rules.names.chapterPlan, at);
  const f = rules.fields;
  const ff = templateFacts(env, tpl.value, { id, name }, [
    { key: f.story, runs: mention(layout.story.id, layout.story.displayName), needed: false },
    ...(a.value
      ? [{ key: f.act, runs: mention(a.value.node.id, a.value.node.displayName), needed: false }]
      : []),
    { key: f.chapterNumber, runs: text(String(at)), needed: false },
    { key: f.questionGate, runs: text(rules.gate.open), needed: false },
    { key: f.planningStatus, runs: text(rules.planning.planned), needed: false },
    { key: 'Subject', runs: text(title), needed: false },
  ]);
  if (!ff.ok) return ff.result;
  const au = layout.continuity !== null && !layout.continuity.main;
  const page = newPage({
    key: 'plan',
    id,
    rawName: name,
    parent: { existing: parent.id },
    templateId: tpl.value.id,
    facts: ff.value.facts,
    parentName: parent.rawName,
    templateName: tpl.value.name,
    status: null,
    tags: narrativeTags(rules, 'chapterPlan', au),
  });
  const renamed = new Map(
    shifted.map((r) => [
      r.id,
      r.kind === 'chapter'
        ? formatName(rules.names.chapter, r.to, r.title ?? '')
        : formatName(rules.names.chapterPlan, r.to),
    ]),
  );
  const after = Object.create(env.ctx.tree) as typeof env.ctx.tree;
  after.children = (pid: string, cid: string) => {
    const real = env.ctx.tree.children(pid, cid);
    return {
      ...real,
      data: real.data.map((n) =>
        renamed.has(n.id) ? { ...n, displayName: renamed.get(n.id)!, rawName: renamed.get(n.id)! } : n,
      ),
    };
  };
  const planned = planCreateJob({ ...env.ctx, tree: after }, [page], {
    batch: false,
    tool: env.tool,
    orderFor: () => narrativeCompare(rules),
  });
  if (!planned.ok) return planned.result;
  const newItem = `new:${id}`;
  const createSteps = planned.value.job.steps.map((s) => ({ ...s, items: [newItem] }));
  const items: PlanItem[] = [
    ...rp.value.items,
    {
      id: newItem,
      kind: 'new_page',
      group: 'New Chapter Plan',
      label: `${name} (“${title}”) under ${parent.displayName}`,
      page: { id, name },
      // It takes a number the renumbering frees: it needs every page numbered from `at` up to move first.
      dependsOn: rp.value.items.map((x) => x.id),
      selected: true,
    },
  ];
  // Locks: every renumbered page, the new plan and its parent (the create takes the parent's lock).
  const ids = [
    ...shifted.map((r) => r.id),
    id,
    ...(shifted.some((r) => r.id === parent.id) ? [] : [parent.id]),
  ];
  return submitRenumbering(env, {
    title: `${env.tool}: ${layout.story.displayName}, a chapter inserted at ${at} (“${title}”); ${shifted.length} page(s) renumbered`,
    parts: [...rp.value.parts, createSteps],
    items,
    targets: rp.value.targets,
    targetItems: rp.value.targetItems,
    ids,
    head: {
      inserted: { at, title, plan: { id, name, parent: { id: parent.id, name: parent.displayName } } },
      renumbered: shifted.map((r) => ({ id: r.id, from: r.rawName, to: renamed.get(r.id) })),
      ...(ff.value.skipped.length ? { fieldsNotOnTemplate: ff.value.skipped } : {}),
      note: 'Names and Chapter Number fields move; mentions point at pages, so they follow; the prose is never changed. The new chapter’s plan is made; write the chapter with arkona_chapter_save once its Question Gate is closed.',
    },
    dryRun: args.dryRun === true,
    operations: [
      ...shifted.map((r) => ({
        tool: env.tool,
        page: { id: r.id, name: r.rawName },
        pageParts: ['renumbered'],
      })),
      ...planned.value.job.operations,
    ],
  });
}

async function chapterMove(
  env: Env,
  args: {
    story: string;
    continuity?: string | undefined;
    from: number;
    to: number;
    act?: number | undefined;
    dryRun?: boolean | undefined;
  },
): Promise<McpToolResult> {
  const { pd, rules } = env;
  const st = findStory(env, args.story, args.continuity);
  if (!st.ok) return st.result;
  const { layout } = st.value;
  const { from, to } = args;
  const moving = oneNumbered(env, layout.chapters, from, 'chapter');
  if (!moving.ok) return moving.result;
  const movingPlan = oneNumbered(env, layout.plans, from, 'Chapter Plan');
  if (!movingPlan.ok) return movingPlan.result;
  if (!moving.value && !movingPlan.value)
    return no(
      pd,
      'CHAPTER_NOT_FOUND',
      `“${layout.story.displayName}” has no chapter or plan numbered ${from}.`,
    ).result;
  const max = Math.max(...layout.chapters.map((c) => c.n), ...layout.plans.map((p) => p.n));
  if (to > max) return no(pd, 'POSITION_OUT_OF_RANGE', `The story’s chapters run to ${max}.`).result;
  const map = (n: number) =>
    n === from ? to : from < to && n > from && n <= to ? n - 1 : to < from && n >= to && n < from ? n + 1 : n;
  const movedIds = new Set(
    [moving.value?.node.id, movingPlan.value?.node.id].filter((x): x is string => !!x),
  );
  // The layout as it will be (other pages renumbered), to say which act the moved chapter lands in.
  const after: StoryLayout = {
    ...layout,
    chapters: layout.chapters.filter((c) => !movedIds.has(c.node.id)).map((c) => ({ ...c, n: map(c.n) })),
    plans: layout.plans.filter((p) => !movedIds.has(p.node.id)).map((p) => ({ ...p, n: map(p.n) })),
  };
  const currentAct = moving.value?.act?.n ?? movingPlan.value?.act ?? null;
  const fitsCurrent =
    currentAct !== null && args.act === undefined ? actFor(env, after, to, currentAct) : null;
  const a = fitsCurrent?.ok ? fitsCurrent : actFor(env, after, to, args.act);
  if (!a.ok) return a.result;
  const targetAct = a.value;
  const list: Renumber[] = [];
  for (const c of layout.chapters) {
    const n2 = map(c.n);
    const moved = c.node.id === moving.value?.node.id;
    if (n2 === c.n && !moved) continue;
    // The moved chapter is placed again (into its new act, or among its siblings as renumbered).
    const parentId = moved && targetAct !== null ? targetAct.node.id : c.node.parentId!;
    list.push({
      id: c.node.id,
      rawName: c.node.displayName,
      kind: 'chapter',
      from: c.n,
      to: n2,
      title: c.title,
      parentId: c.node.parentId!,
      ...(moved ? { move: { parentId } } : {}),
    });
  }
  for (const p of layout.plans) {
    const n2 = map(p.n);
    const moved = p.node.id === movingPlan.value?.node.id;
    let move: Renumber['move'];
    if (moved && targetAct !== null && p.act !== targetAct.n) {
      const am = layout.actMaps.find((x) => x.n === targetAct.n);
      if (!am)
        return no(
          pd,
          'ACT_MAP_MISSING',
          `Act ${targetAct.n} has no Act Map; tell the owner (the narrative audit reports it).`,
        ).result;
      move = { parentId: am.node.id };
    } else if (moved) move = { parentId: p.node.parentId! };
    if (n2 === p.n && !move) continue;
    list.push({
      id: p.node.id,
      rawName: p.node.displayName,
      kind: 'plan',
      from: p.n,
      to: n2,
      parentId: p.node.parentId!,
      ...(move ? { move } : {}),
    });
  }
  // A moved page's place among its new siblings, as they will be named.
  const finalName = (r: Renumber) =>
    r.kind === 'chapter'
      ? formatName(rules.names.chapter, r.to, r.title ?? '')
      : formatName(rules.names.chapterPlan, r.to);
  const byId = new Map(list.map((r) => [r.id, r]));
  const cmp = narrativeCompare(rules);
  const placed = list.map((r) => {
    if (!r.move) return r;
    const sibs = env.view
      .children(r.move.parentId)
      .filter((s) => s.id !== r.id)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        displayName: byId.has(s.id) ? finalName(byId.get(s.id)!) : s.displayName,
      }));
    let after: string | undefined;
    let before: string | undefined;
    const me = { displayName: finalName(r), kind: 'unclassified' as const };
    for (const s of sibs) {
      if (cmp(s, me) <= 0) after = s.id;
      else if (before === undefined) before = s.id;
    }
    return { ...r, move: { parentId: r.move.parentId, ...(after ? { after } : before ? { before } : {}) } };
  });
  const rp = await renumberParts(env, renameOrder(placed));
  if (!rp.ok) return rp.result;
  return submitRenumbering(env, {
    title: `${env.tool}: ${layout.story.displayName}, chapter ${from} moved to ${to}${targetAct ? ` (Act ${targetAct.n})` : ''}; ${list.length} page(s) renumbered or moved`,
    parts: rp.value.parts,
    items: rp.value.items,
    targets: rp.value.targets,
    targetItems: rp.value.targetItems,
    ids: list.map((r) => r.id),
    head: {
      moved: { from, to, ...(targetAct ? { act: targetAct.n } : {}) },
      renumbered: list.map((r) => ({
        id: r.id,
        from: r.rawName,
        to: finalName(r),
        ...(r.move ? { movedTo: r.move.parentId } : {}),
      })),
      note: 'Names and Chapter Number fields move; mentions point at pages, so they follow; the prose is never changed.',
    },
    dryRun: args.dryRun === true,
    operations: list.map((r) => ({
      tool: env.tool,
      page: { id: r.id, name: r.rawName },
      pageParts: [r.move ? 'renumbered and moved' : 'renumbered'],
    })),
  });
}

// ============================================================================================ the chapter tools

function chapterTools(deps: ToolDeps, listed: () => boolean): McpToolProvider[] {
  const run =
    <A>(tool: string, fn: (env: Env, args: A) => Promise<McpToolResult>) =>
    (args: A & { project?: string | undefined }, mctx: McpToolContext) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const o = openEnv(pd, mctx, tool);
        if (!o.ok) return o.result;
        try {
          return await fn(o.value, args);
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      });
  return [
    defineTool({
      name: 'arkona_chapter_plan',
      title: 'Create or update a Chapter Plan (Arkona pack)',
      access: 'write',
      description:
        'The Arkona pack (design F4c, E5): makes “Chapter <n> Plan” under the right map (the act’s Act Map, or the Story Map of a story without acts), from the Chapter Plan template (its body is the Workflow’s chapter-plan format: write the planning text with write_page), or updates the plan of that number: Story, Act, Chapter Number, the Chapter link, Planned Date (read by the calendar), POV, Question Gate and Planning Status, each only where the template has the field. A new plan’s Question Gate starts Open: arkona_chapter_save refuses the chapter until it is Closed (the Workflow’s Drafting Gate); close it with questionGate "closed" once the plan’s questions are answered. act: needed when the story has acts and the number does not say which. At scope write it is written directly; at scope propose, a proposal. Cost: 1 to 2 reads and about 4 writes.',
      inputSchema: z.object({
        story: storyArg,
        continuity: continuityArg,
        number: numberArg.describe('The chapter’s number (they run across the whole story).'),
        act: numberArg.optional().describe('The act’s number, when the story has acts.'),
        title: z
          .string()
          .min(1)
          .max(150)
          .optional()
          .describe('The chapter’s working title (kept in the plan’s Subject).'),
        plannedDate: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Planned Date: a date or approximate range the calendar reads.'),
        pov: z.string().min(1).max(300).optional().describe('The POV character: a page name or id.'),
        questionGate: z.enum(['open', 'closed']).optional().describe('Open or close the Question Gate.'),
        dryRun: dryRunArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed,
      handler: run('arkona_chapter_plan', chapterPlan),
    }),
    defineTool({
      name: 'arkona_chapter_save',
      title: 'Save a chapter’s prose (Arkona pack)',
      access: 'write',
      description:
        'The Arkona pack (design F4c, E5; the Fiction Writing Reference, 32B): SAVES a chapter. A new number makes “Chapter <n> - <Title>” in its act (or the story) from the Chapter template, with its fields, and links it with its Chapter Plan both ways; an existing chapter is revised IN PLACE (same page, same document): read it first and pass the version as baseVersion (else NUMBER_TAKEN). The tool writes the DATELINE itself as the first line, from inWorldDate (and place): “Isar 27th, 4A 645 · <Place>”; a dateline you put first is replaced. inWorldDate must be readable by the calendar (exact, or approximate: “c. 4A 640-645”). ' +
        'The Drafting Gate: when the chapter’s plan has a Question Gate field and it is Open, the save is refused unless overrideGate: { reason } (the reason goes on the Review page entry). The prose is read back word for word (readBack). Refused: an act that does not hold the number’s position; a field the Chapter template lacks. At scope write it is written directly (Review page, Revertible); at scope propose, a proposal. Next: arkona_chapter_check. Cost: 2 to 4 reads, about 12 writes, 2 reads to verify.',
      inputSchema: z.object({
        story: storyArg,
        continuity: continuityArg,
        number: numberArg.describe('The chapter’s number (they run across the whole story).'),
        title: z
          .string()
          .min(1)
          .max(150)
          .optional()
          .describe('Its title (required for a new chapter; a new one renames it).'),
        act: numberArg
          .optional()
          .describe('The act’s number, when the story has acts and the number does not say which.'),
        inWorldDate: z
          .string()
          .min(1)
          .max(200)
          .describe('In-world Date: exact or an approximate range (the dateline is written from it).'),
        place: z.string().min(1).max(200).optional().describe('The place, after the date in the dateline.'),
        pov: z.string().min(1).max(300).describe('The POV character: a page name or id.'),
        charactersPresent: z
          .array(z.string().min(1).max(300))
          .max(100)
          .describe('Characters Present: page names or ids.'),
        locations: z.array(z.string().min(1).max(300)).max(100).describe('Locations: page names or ids.'),
        draftStatus: z.string().min(1).max(100).describe('Draft Status (for example Draft, Revised, Final).'),
        markdown: z
          .string()
          .min(1)
          .max(400_000)
          .describe(
            'The chapter’s prose, in the bridge’s Markdown (get_markdown_guide), without the dateline.',
          ),
        baseVersion: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('The chapter document’s version you read (revising).'),
        overrideGate: z
          .object({ reason: z.string().trim().min(1).max(500) })
          .strict()
          .optional()
          .describe('Save although the plan’s Question Gate is Open: why (shown on the Review page).'),
        dryRun: dryRunArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed,
      handler: run('arkona_chapter_save', chapterSave),
    }),
    defineTool({
      name: 'arkona_chapter_insert',
      title: 'Insert a chapter and renumber the rest (Arkona pack)',
      access: 'write',
      description:
        'The Arkona pack (design F4c, E5): makes room for a chapter at position `at`: every chapter and Chapter Plan numbered `at` or more moves up by one (names and Chapter Number fields; mentions point at pages, so they follow; prose is never changed), and the new chapter’s Chapter Plan is made at `at` (Question Gate Open; write the chapter with arkona_chapter_save). One job of items: more than 10 pages meets the bulk rail as a proposal the owner can approve item by item. Cost: 1 read per page renumbered, about 2 writes each.',
      inputSchema: z.object({
        story: storyArg,
        continuity: continuityArg,
        at: numberArg.describe('The new chapter’s number.'),
        act: numberArg
          .optional()
          .describe('Its act, when the story has acts and the position does not say which.'),
        title: z.string().min(1).max(150).describe('The new chapter’s working title.'),
        dryRun: dryRunArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed,
      handler: run('arkona_chapter_insert', chapterInsert),
    }),
    defineTool({
      name: 'arkona_chapter_move',
      title: 'Move a chapter to another position or act (Arkona pack)',
      access: 'write',
      description:
        'The Arkona pack (design F4c, E5): moves chapter `from` (and its Chapter Plan) to position `to`, renumbering every chapter and plan in between (names and Chapter Number fields; mentions follow; prose never changes), and into another act when its new position (or `act`) says so (its plan to that act’s Act Map). One job of items: more than 10 pages meets the bulk rail as a proposal. Cost: 1 read per page renumbered, about 2 writes each.',
      inputSchema: z.object({
        story: storyArg,
        continuity: continuityArg,
        from: numberArg.describe('The chapter’s number now.'),
        to: numberArg.describe('Its number after the move.'),
        act: numberArg.optional().describe('The act it moves into, when the position does not say which.'),
        dryRun: dryRunArg,
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed,
      handler: run('arkona_chapter_move', chapterMove),
    }),
  ];
}
