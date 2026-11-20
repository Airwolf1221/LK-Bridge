/**
 * v3 F4c (ADR 0065; the owner-approved design docs/design/F4c-fiction.md): what the narrative tools share. The rules are
 * the APPROVED pack version's (`rules.narrative`); Narratives is found by name; templates by name through the template
 * list; every field by name (a field a tool needs that a template lacks is a TEMPLATE_MISMATCH refusal naming it, never
 * an invented field); dates through the calendar engine (never guessed).
 */
import { readLeading } from '../../consistency/dates.js';
import { expandFacts } from '../../facts/expand.js';
import { factKey, sidebarFrom, type SidebarProperty } from '../../facts/index.js';
import { FactsPlanError, planFacts, type LinkTarget } from '../../facts/plan.js';
import { factValueRuns, FactValueError, rowTextRuns } from '../../facts/values.js';
import type { StepSpec } from '../../jobs/index.js';
import type { FromMarkdownContext } from '../../markdown/index.js';
import { approvedRulesOf } from '../../packs/governance-audit.js';
import type { NarrativeRules } from '../../packs/types.js';
import { pageConverterContext } from '../../pages/index.js';
import { narrativeCalendar } from '../../narrative/calendar.js';
import {
  continuityIndexes,
  nkey,
  rootsOf,
  storiesIn,
  storyLayout,
  type ContinuityIndex,
  type NNode,
  type NView,
  type Numbered,
  type Roots,
  type StoryLayout,
} from '../../narrative/layout.js';
import { treeView } from '../../narrative/scope.js';
import type { TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import {
  createCtx,
  readSidebar,
  resolveTemplate,
  type CreateCtx,
  type NewPageFactsPlan,
} from './create-support.js';
import { liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import { resolveLink } from './set-facts.js';
import { errorFromThrown, errorResult, type ProjectDeps } from './shape.js';

export type Obj = Record<string, unknown>;
export type R<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: McpToolResult };

export const no = (
  pd: ProjectDeps,
  code: string,
  message: string,
  extra: Obj = {},
): { readonly ok: false; readonly result: McpToolResult } => ({
  ok: false,
  result: errorResult({ code, message, ...extra }, pd),
});

/** The accepted date forms, for a refusal (the calendar engine's forms; PLAN-v2's date decisions). */
export const DATE_FORMS =
  'a day (“Kumikas 1st, 4A 159”), a year (“4A 881”), a month range (“Kumikas - Azaakh, 4A 180”), a range of days (“Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102”) or of years (“4A 881 - 4A 900”), each optionally approximate with “c.” (“c. 4A 640-645”)';

export interface Env {
  readonly pd: ProjectDeps;
  readonly mctx: McpToolContext;
  readonly tool: string;
  readonly ctx: RepoCtx;
  readonly cc: CreateCtx;
  readonly rules: NarrativeRules;
  readonly roots: Roots & { readonly narratives: NNode };
  readonly view: NView & { treeNode(id: string): TreeNode | null };
  readonly packId: string;
  /** The pack's switch for this tool is `propose` (the owner tightened it): every write is a proposal. */
  readonly forceProposal: boolean;
  readonly converter: FromMarkdownContext;
}

/** The narrative tools' setting-up: the tree, the approved narrative rules, Narratives found by name. */
export function openEnv(pd: ProjectDeps, mctx: McpToolContext, tool: string): R<Env> {
  const rc = repoContext(pd);
  if (!rc.ok) return rc;
  const ctx = rc.ctx;
  const packs = pd.services?.packs;
  if (!packs) return no(pd, 'TOOL_UNAVAILABLE', 'The setting packs are not available here.');
  let rules: NarrativeRules | null = null;
  let packId: string | null = null;
  let waiting = false;
  for (const pack of [...packs.forProject(ctx.projectId)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const approved = approvedRulesOf(pack, (id, v) => packs.store.rulesAt(id, v));
    if (approved?.narrative) {
      rules = approved.narrative;
      packId = pack.id;
      break;
    }
    if (pack.rules.narrative) waiting = true;
  }
  if (!rules || !packId)
    return no(
      pd,
      waiting ? 'PACK_NOT_CURRENT' : 'NARRATIVE_NOT_CONFIGURED',
      waiting
        ? 'The narrative rules are in a pack version waiting for the owner’s approval (Packs page): nothing can be written until it is approved.'
        : 'No setting pack attached to this project has narrative rules.',
    );
  const cc = createCtx(pd, mctx, ctx, tool);
  const view = treeView(ctx.tree, ctx.projectId, cc.propertyTitle);
  const roots = rootsOf(view, rules);
  if (!roots.narratives)
    return no(
      pd,
      'NARRATIVES_NOT_FOUND',
      roots.ambiguous.includes(rules.indexes.narratives)
        ? `More than one index is named “${rules.indexes.narratives}”; the bridge will not guess which holds the stories. Tell the owner.`
        : `No index named “${rules.indexes.narratives}” is in the repository tree (it is found by name). Tell the owner.`,
    );
  const converter = pd.services ? pageConverterContext(pd.services, ctx.projectId) : undefined;
  if (!converter) return no(pd, 'TOOL_UNAVAILABLE', 'The repository tree cannot resolve names now.');
  return {
    ok: true,
    value: {
      pd,
      mctx,
      tool,
      ctx,
      cc,
      rules,
      roots: roots as Roots & { narratives: NNode },
      view,
      packId,
      forceProposal: packs.strictToolMode(packId, tool) === 'propose',
      converter,
    },
  };
}

// ============================================================================================ continuities and stories

/** The continuity index named (Main CANON or an AU), or the refusal that says what is missing (design E4). */
export function findContinuity(env: Env, name: string): R<ContinuityIndex> {
  const all = continuityIndexes(env.view, env.rules, env.roots);
  const want = nkey(name) === 'main' ? nkey(env.rules.indexes.main) : nkey(name);
  const hit = all.find((c) => nkey(c.name) === want);
  if (hit) {
    if (!hit.main && !hit.au)
      return no(
        env.pd,
        'UNKNOWN_CONTINUITY',
        `“${hit.name}” is an index under ${env.roots.narratives.displayName} but no AU of that name is defined under ${env.rules.indexes.continuities}.`,
      );
    return { ok: true, value: hit };
  }
  const aus = env.roots.continuities
    ? env.view.children(env.roots.continuities.id).map((n) => n.displayName.split(/\s+[-–—]\s+/)[0]!.trim())
    : [];
  const known = want === nkey(env.rules.indexes.main) || aus.some((a) => nkey(a) === want);
  return no(
    env.pd,
    known ? 'CONTINUITY_INDEX_MISSING' : 'UNKNOWN_CONTINUITY',
    known
      ? `There is no index “${name}” under ${env.roots.narratives.displayName} yet. The narrative audit reports it and its “Propose a fix” proposes it for the owner (design E4); nothing was written.`
      : `“${name}” is neither ${env.rules.indexes.main} nor an AU defined under ${env.rules.indexes.continuities} (${aus.length ? aus.join(', ') : 'none defined'}). Nothing was written.`,
    { continuities: [env.rules.indexes.main, ...aus] },
  );
}

/** A story by its index's name or id (optionally within one continuity), with its layout. */
export function findStory(
  env: Env,
  ref: string,
  continuity?: string,
): R<{ readonly node: TreeNode; readonly layout: StoryLayout }> {
  const conts = continuityIndexes(env.view, env.rules, env.roots).filter(
    (c) => continuity === undefined || nkey(c.name) === nkey(continuity),
  );
  const q = ref.trim().replace(/^lk:\/\/resources\//, '');
  const stories = conts.flatMap((c) => storiesIn(env.view, c.node));
  const hits = stories.filter(
    (s) => s.id === q || nkey(s.displayName) === nkey(q.replace(/^\[INDEX\]\s*/i, '')),
  );
  if (hits.length === 0) {
    // Any page of the story (its Story Map, a chapter): the story it belongs to.
    const rp = resolvePage(env.ctx, ref);
    if (rp.ok) {
      const owner = stories.find((s) => rp.node.path.ids.includes(s.id));
      if (owner) hits.push(owner);
    }
  }
  if (hits.length !== 1)
    return no(
      env.pd,
      hits.length === 0 ? 'STORY_NOT_FOUND' : 'AMBIGUOUS',
      hits.length === 0
        ? `No story “${ref}” under ${env.roots.narratives.displayName}${continuity ? ` / ${continuity}` : ''}. Make one with arkona_story_create.`
        : `“${ref}” is a story in more than one continuity; pass continuity (or the story’s id).`,
      hits.length > 1
        ? {
            candidates: hits.map((h) => ({
              id: h.id,
              continuity: env.view.node(h.parentId ?? '')?.displayName,
            })),
          }
        : {},
    );
  const node = env.view.treeNode(hits[0]!.id);
  if (!node) return no(env.pd, 'NOT_FOUND', `${hits[0]!.id} is not in the repository tree.`);
  return { ok: true, value: { node, layout: storyLayout(env.view, env.rules, env.roots, node) } };
}

/**
 * The act a chapter numbered `n` belongs in: the act named (it must fit the number's position: every chapter of an
 * earlier act numbered lower, every chapter of a later act higher), else the one act that fits. A story without acts
 * has none (and an act given is refused). `except`: a chapter left out of the comparison (the one being revised).
 */
export function actFor(
  env: Env,
  layout: StoryLayout,
  n: number,
  act: number | undefined,
  except: ReadonlySet<string> = new Set(),
): R<Numbered | null> {
  if (!layout.hasActs) {
    if (act !== undefined)
      return no(env.pd, 'NO_ACTS', `“${layout.story.displayName}” is told without acts; leave act out.`);
    return { ok: true, value: null };
  }
  const numbersIn = (a: number) => [
    ...layout.chapters.filter((c) => c.act?.n === a && !except.has(c.node.id)).map((c) => c.n),
    ...layout.plans.filter((p) => p.act === a && !except.has(p.node.id)).map((p) => p.n),
  ];
  const fits = (a: Numbered) =>
    layout.acts.every(
      (o) =>
        o.n === a.n || (o.n < a.n ? numbersIn(o.n).every((x) => x < n) : numbersIn(o.n).every((x) => x > n)),
    );
  if (act !== undefined) {
    const a = layout.acts.find((x) => x.n === act);
    if (!a)
      return no(
        env.pd,
        'ACT_NOT_FOUND',
        `“${layout.story.displayName}” has no Act ${act} (acts: ${layout.acts.map((x) => x.n).join(', ') || 'none'}).`,
      );
    if (!fits(a))
      return no(
        env.pd,
        'ACT_POSITION',
        `Chapter ${n} cannot be in Act ${act}: chapter numbers run across the whole story, and Act ${act}’s place does not hold that number (design E1). Nothing was written.`,
        { acts: layout.acts.map((x) => ({ act: x.n, chapters: numbersIn(x.n) })) },
      );
    return { ok: true, value: a };
  }
  const fitting = layout.acts.filter(fits);
  if (fitting.length === 1) return { ok: true, value: fitting[0]! };
  return no(
    env.pd,
    'ACT_REQUIRED',
    `Say which act chapter ${n} is in (act): ${fitting.length === 0 ? 'no act fits that number' : `Acts ${fitting.map((x) => x.n).join(', ')} all fit it`}.`,
    { acts: layout.acts.map((x) => ({ act: x.n, chapters: numbersIn(x.n) })) },
  );
}

// ============================================================================================ dates

/** A date the calendar engine reads WHOLE (exact or an approximate range), or the refusal with the accepted forms. */
export function readDate(env: Env, text: string, field: string): R<string> {
  const chron = env.pd.services?.chronology;
  const { calendar, style } = chron
    ? narrativeCalendar(chron, env.ctx.projectId)
    : { calendar: null, style: undefined };
  const t = text.replace(/\s+/g, ' ').trim();
  if (!calendar)
    return no(
      env.pd,
      'CALENDAR_UNAVAILABLE',
      'The chronology’s calendar is not available to the bridge yet (the chronology tools read and keep it), so no date can be read; nothing was written.',
    );
  const r = style ? readLeading(calendar, t, style) : readLeading(calendar, t);
  if (r.ok && r.reading.text.replace(/\s+/g, ' ').trim().length >= t.replace(/[.;,]\s*$/, '').length)
    return { ok: true, value: t };
  return no(
    env.pd,
    'DATE_UNREADABLE',
    `${field} “${t}” is not a date the calendar can read${r.ok ? ' as a whole' : `: ${r.reason}`}. Accepted: ${DATE_FORMS}. Nothing was written.`,
    { field, value: t },
  );
}

// ============================================================================================ templates and fields

export interface Tpl {
  readonly id: string;
  readonly name: string;
  readonly sidebar: readonly SidebarProperty[];
  readonly keys: readonly string[];
  readonly collections: readonly string[];
}

const keysOf = (sidebar: readonly SidebarProperty[], title: string) => {
  const kv = sidebar.filter((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(title));
  return kv.length === 1 ? (kv[0]!.rows ?? []).map((r) => r.key) : [];
};
const collectionsOf = (sidebar: readonly SidebarProperty[]) =>
  sidebar.filter((p) => p.kind === 'resourceCollection' || p.kind === 'resourceLink').map((p) => p.title);

/** A narrative template, by its name in the pack (through the template list), with its fields. */
export async function narrativeTemplate(env: Env, which: keyof NarrativeRules['templates']): Promise<R<Tpl>> {
  const t = await resolveTemplate(env.pd, env.mctx, env.ctx, env.tool, env.rules.templates[which]);
  if (!t.ok) return t;
  const sb = await readSidebar(env.pd, env.mctx, env.tool, t.value.id, env.cc.sidebars, env.cc.templateTags);
  if (!sb.ok) return sb;
  return {
    ok: true,
    value: {
      id: t.value.id,
      name: t.value.name ?? env.rules.templates[which],
      sidebar: sb.value,
      keys: keysOf(sb.value, env.cc.propertyTitle),
      collections: collectionsOf(sb.value),
    },
  };
}

export const hasField = (keys: readonly string[], field: string) =>
  keys.some((k) => factKey(k) === factKey(field));

/** One fact the tool writes: its runs, and whether the tool NEEDS it (a missing needed field is a mismatch). */
export interface Row {
  readonly key: string;
  readonly runs: readonly Obj[];
  readonly needed: boolean;
}
export interface Links {
  readonly title: string;
  readonly add: readonly LinkTarget[];
  readonly needed: boolean;
}

export function mismatch(
  env: Env,
  where: string,
  fields: readonly string[],
  have: readonly string[],
): R<never> {
  return no(
    env.pd,
    'TEMPLATE_MISMATCH',
    `${where} has no ${fields.map((f) => `“${f}”`).join(', ')} field, which this needs. Nothing was written; no field is ever invented: the owner adds it to the template (or the page), or leave that value out.`,
    { template: where, missing: fields, fields: have },
  );
}

/** The facts of a page made from `tpl` in the same job, planned on the template's sidebar. */
export function templateFacts(
  env: Env,
  tpl: Tpl,
  page: { readonly id: string; readonly name: string },
  rows: readonly Row[],
  links: readonly Links[] = [],
): R<{ readonly facts: NewPageFactsPlan | null; readonly skipped: readonly string[] }> {
  const missing = [
    ...rows.filter((r) => r.needed && !hasField(tpl.keys, r.key)).map((r) => r.key),
    ...links.filter((l) => l.needed && !hasField(tpl.collections, l.title)).map((l) => l.title),
  ];
  if (missing.length > 0)
    return mismatch(env, `The template “${tpl.name}”`, missing, [...tpl.keys, ...tpl.collections]);
  const use = rows.filter((r) => hasField(tpl.keys, r.key));
  const useLinks = links.filter((l) => hasField(tpl.collections, l.title) && l.add.length > 0);
  const skipped = [
    ...rows.filter((r) => !hasField(tpl.keys, r.key)).map((r) => r.key),
    ...links.filter((l) => !hasField(tpl.collections, l.title)).map((l) => l.title),
  ];
  if (use.length === 0 && useLinks.length === 0) return { ok: true, value: { facts: null, skipped } };
  try {
    const plan = planFacts({
      resourceId: page.id,
      sidebar: tpl.sidebar,
      propertyTitle: env.cc.propertyTitle,
      facts: use.map((r) => ({ key: r.key, value: [...r.runs] })),
      links: useLinks.map((l) => ({ title: l.title, add: [...l.add], remove: [] })),
      templateKeys: tpl.keys,
    });
    return { ok: true, value: { facts: { plan, templateSidebar: tpl.sidebar, status: null }, skipped } };
  } catch (e) {
    if (e instanceof FactsPlanError) return no(env.pd, e.code, `${page.name}: ${e.message}`, e.details);
    return { ok: false, result: errorFromThrown(e, env.pd) };
  }
}

/**
 * The facts of an EXISTING page: its sidebar read live (one read), the changes planned on it and expanded as set_facts
 * does (a check of the rows inside the page's lock, the chained writes, the read-back). Fields the page lacks are skipped
 * unless needed (then a mismatch). `steps` is empty when nothing changes.
 */
export async function existingFacts(
  env: Env,
  page: { readonly id: string; readonly name: string },
  rows: readonly Row[],
  links: readonly Links[] = [],
): Promise<
  R<{
    readonly steps: readonly StepSpec[];
    readonly skipped: readonly string[];
    readonly changes: readonly string[];
  }>
> {
  const read = await liveRead(env.pd, env.mctx, env.tool, 'listProperties', {
    path: { resourceId: page.id },
  });
  if (!read.ok) return read;
  const sidebar = sidebarFrom(read.value);
  const keys = keysOf(sidebar, env.cc.propertyTitle);
  const colls = collectionsOf(sidebar);
  const missing = [
    ...rows.filter((r) => r.needed && !hasField(keys, r.key)).map((r) => r.key),
    ...links.filter((l) => l.needed && !hasField(colls, l.title)).map((l) => l.title),
  ];
  if (missing.length > 0) return mismatch(env, `“${page.name}”`, missing, [...keys, ...colls]);
  const use = rows.filter((r) => hasField(keys, r.key));
  const useLinks = links.filter((l) => hasField(colls, l.title));
  const skipped = [...rows.filter((r) => !hasField(keys, r.key)).map((r) => r.key)];
  if (use.length === 0 && useLinks.length === 0)
    return { ok: true, value: { steps: [], skipped, changes: [] } };
  try {
    // A collection takes exactly the targets given: the ones it holds and are not given are removed.
    const linkReqs = useLinks.map((l) => {
      const coll = sidebar.find(
        (p) =>
          (p.kind === 'resourceCollection' || p.kind === 'resourceLink') &&
          factKey(p.title) === factKey(l.title),
      );
      const held = (Array.isArray(coll?.raw.items) ? (coll.raw.items as { resourceId?: unknown }[]) : [])
        .map((i) => i.resourceId)
        .filter((x): x is string => typeof x === 'string');
      const want = new Set(l.add.map((a) => a.resourceId));
      return {
        title: l.title,
        add: l.add.filter((a) => !held.includes(a.resourceId)),
        remove: held.filter((h) => !want.has(h)).map((h) => ({ resourceId: h, name: h })),
      };
    });
    const plan = planFacts({
      resourceId: page.id,
      sidebar,
      propertyTitle: env.cc.propertyTitle,
      facts: use.map((r) => ({ key: r.key, value: [...r.runs] })),
      links: linkReqs,
      templateKeys: null,
    });
    if (plan.empty) return { ok: true, value: { steps: [], skipped, changes: [] } };
    const job = expandFacts(plan, { id: page.id, name: page.name }, sidebar, { facts: {}, links: {} });
    const changes = plan.facts
      .filter((f) => f.change === 'added' || f.change === 'changed')
      .map((f) => f.key)
      .concat(plan.links.filter((l) => l.added.length + l.removed.length > 0).map((l) => l.title));
    return { ok: true, value: { steps: job.steps, skipped, changes } };
  } catch (e) {
    if (e instanceof FactsPlanError) return no(env.pd, e.code, `${page.name}: ${e.message}`, e.details);
    return { ok: false, result: errorFromThrown(e, env.pd) };
  }
}

// ============================================================================================ values

export const text = (v: string): Obj[] => rowTextRuns(v);
export const mention = (id: string, name: string): Obj[] => [{ mention: { resourceId: id, text: name } }];

/** A page named by the caller, as a mention's runs (one page inside the AI REPOSITORY, the character rule applied). */
export function pageRuns(env: Env, name: string, field: string): R<Obj[]> {
  try {
    return {
      ok: true,
      value: factValueRuns({ markdown: `[[${name.replace(/[[\]]/g, '')}]]` }, env.converter),
    };
  } catch (e) {
    if (e instanceof FactValueError) return no(env.pd, e.code, `${field} “${name}”: ${e.message}`, e.details);
    return { ok: false, result: errorFromThrown(e, env.pd) };
  }
}

/**
 * Pages named by the caller, as link targets: each exactly one page inside the AI REPOSITORY, a character's name taking
 * the character rule (its Core, else its Reference, else its index), as a mention does.
 */
export function linkTargets(env: Env, names: readonly string[]): R<LinkTarget[]> {
  const out: LinkTarget[] = [];
  for (const n of names) {
    let target: LinkTarget;
    const r = resolveLink(env.ctx, n);
    if (r.ok) target = r.target;
    else {
      const m = pageRuns(env, n, 'the link');
      const run = m.ok && m.value.length === 1 ? (m.value[0]!.mention as Obj | undefined) : undefined;
      if (!run || typeof run.resourceId !== 'string') return r;
      const node = env.ctx.tree.node(env.ctx.projectId, run.resourceId).data;
      target = { resourceId: run.resourceId, name: node?.displayName ?? n };
    }
    if (!out.some((x) => x.resourceId === target.resourceId)) out.push(target);
  }
  return { ok: true, value: out };
}

/** How many times the narrative tools gave the event loop a turn (for the tests). */
export const loopYields = { count: 0 };

/** Gives the event loop a turn (CR-2026-11-R3, R3-64): long planning loops call it every few pages. */
export const yieldToLoop = (): Promise<void> => {
  loopYields.count++;
  return new Promise((r) => setImmediate(r));
};
