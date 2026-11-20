/**
 * v3 F4c (ADR 0065; the owner-approved design docs/design/F4c-fiction.md, E6 and E7): reading a chapter against canon,
 * and offering what a story invents to the owner as canon.
 *
 * - `arkona_chapter_context` (E6.1, free): the smallest sufficient canon for drafting one chapter, AS OF its In-world
 *   Date (or its plan's Planned Date): `arkona_as_of` and `arkona_brief` for its POV, Characters Present and Locations,
 *   the chronology rows around the date, open contradictions, the plan's Canon Constraints and Question Gate, and the
 *   previous chapter's closing state; every item labelled by its evidence class (narrative pages are never canon).
 * - `arkona_chapter_check` (E6.2, read-only): what a saved chapter says against canon at its date, each item labelled
 *   Contradicts canon, Not in canon (candidate) or Unestablished in canon. It never edits anything.
 * - `arkona_promote_from_chapter` (E7): one item of the check made a CANON PROPOSAL through the existing tools; the
 *   agent supplies the content; the chapter is cited in the proposal's note only; never applied by itself.
 */
import * as z from 'zod';
import { readLeading, spanOf, overlaps, type DateReading } from '../../consistency/dates.js';
import { capitalisedRuns, knows, nameNorm, resolvableNames } from '../../audits/checks/governance.js';
import type { LoadedPage, PageReader } from '../../appraisal/reader.js';
import { lifecycleFrom } from '../../lifecycle/settings.js';
import { narrativeCalendar } from '../../narrative/calendar.js';
import { nkey, subjectOf, type StoryLayout } from '../../narrative/layout.js';
import { currentCharacters } from '../../packs/naming/namesakes.js';
import { sectionMarkdown, sectionsWhere } from '../../packs/read-support.js';
import { topicBrief } from '../../packs/topic-brief.js';
import type { PackRules } from '../../packs/types.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { liveReader } from './appraisal.js';
import { CREATE_ANNOTATIONS } from './resources.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import {
  existingFacts,
  findStory,
  no,
  openEnv,
  text,
  type Env,
  type Obj,
  type R,
} from './narrative-support.js';
import { shiftStep } from '../../packs/engine/job.js';
import type { StepSpec } from '../../jobs/index.js';
import type { PlanItem } from '../../jobs/items.js';
import type { LkBlock } from '../../markdown/index.js';
import { planPageWrite, WRITE_PAGE_PLANNER } from '../../pages/index.js';
import { runWriteJob } from './write-job.js';
import { finish, liveRead, resolvePage } from './repo.js';
import { errorFromThrown, projectArg, withProject, type ToolDeps } from './shape.js';

const PACK = 'arkona';

export const LABELS = {
  contradicts: 'Contradicts canon',
  candidate: 'Not in canon (candidate)',
  unestablished: 'Unestablished in canon',
} as const;

const chapterArgs = {
  chapter: z.string().min(1).max(300).optional().describe('The chapter: its name or id.'),
  plan: z.string().min(1).max(300).optional().describe('Or its Chapter Plan: its name or id.'),
  story: z.string().min(1).max(300).optional().describe('Or the story, with number.'),
  number: z.number().int().min(1).max(9999).optional(),
  continuity: z.string().min(1).max(200).optional(),
};

interface Where {
  readonly layout: StoryLayout;
  readonly n: number;
  readonly chapter: { id: string; name: string } | null;
  readonly plan: { id: string; name: string } | null;
}

/** The chapter (and its plan) a call names: a chapter or plan page, or a story and a number. */
function locate(
  env: Env,
  a: {
    chapter?: string | undefined;
    plan?: string | undefined;
    story?: string | undefined;
    number?: number | undefined;
    continuity?: string | undefined;
  },
): R<Where> {
  const ref = a.chapter ?? a.plan;
  let layout: StoryLayout;
  let n: number;
  if (a.story !== undefined && a.number !== undefined) {
    const st = findStory(env, a.story, a.continuity);
    if (!st.ok) return st;
    layout = st.value.layout;
    n = a.number;
  } else if (ref !== undefined) {
    const st = findStory(env, ref, a.continuity);
    if (!st.ok) return st;
    layout = st.value.layout;
    const q = ref.trim();
    const hit =
      layout.chapters.find((c) => c.node.id === q || nkey(c.node.displayName) === nkey(q)) ??
      layout.plans.find((p) => p.node.id === q || nkey(p.node.displayName) === nkey(q));
    if (!hit)
      return no(
        env.pd,
        'CHAPTER_NOT_FOUND',
        `“${ref}” is not a chapter or a Chapter Plan of “${layout.story.displayName}”.`,
      );
    n = hit.n;
  } else return no(env.pd, 'INVALID_PARAMS', 'Name the chapter (or its plan), or the story and a number.');
  const ch = layout.chapters.find((c) => c.n === n);
  const pl = layout.plans.find((p) => p.n === n);
  if (!ch && !pl)
    return no(
      env.pd,
      'CHAPTER_NOT_FOUND',
      `“${layout.story.displayName}” has no chapter or plan numbered ${n}.`,
    );
  return {
    ok: true,
    value: {
      layout,
      n,
      chapter: ch ? { id: ch.node.id, name: ch.node.displayName } : null,
      plan: pl ? { id: pl.node.id, name: pl.node.displayName } : null,
    },
  };
}

/** A fact's text from a loaded page's sidebar. */
const factOf = (p: LoadedPage | null, key: string): string | null => {
  const f = p?.sidebar?.facts.get(key.trim().toLowerCase());
  const t = f && f.count === 1 ? f.text.trim() : '';
  return t === '' ? null : t;
};
/** The page a sidebar row mentions (the first mention in it). */
const rowMention = (p: LoadedPage | null, key: string): string | null =>
  p?.sidebar?.refs.find(
    (r) => r.via.kind === 'mention' && r.via.where === 'sidebar' && nkey(r.via.row) === nkey(key),
  )?.resourceId ?? null;
const collection = (p: LoadedPage | null, title: string): string[] =>
  (p?.collections ?? []).find((c) => nkey(c.title) === nkey(title))?.items.map((i) => i.resourceId) ?? [];

/** Plain text of blocks, one string per top-level block (mentions by their label). */
function blockTexts(blocks: readonly Obj[]): string[] {
  const one = (b: Obj): string =>
    [
      ...(Array.isArray(b.content)
        ? (b.content as Obj[]).map((r) =>
            typeof r.text === 'string'
              ? r.text
              : r.mention && typeof (r.mention as Obj).text === 'string'
                ? ((r.mention as Obj).text as string)
                : '',
          )
        : []),
      ...(Array.isArray(b.children) ? (b.children as Obj[]).map(one) : []),
    ].join(' ');
  return blocks.map(one);
}
/** The pages a body mentions. */
function mentionsIn(blocks: readonly Obj[]): Set<string> {
  const out = new Set<string>();
  const walk = (b: unknown) => {
    if (!b || typeof b !== 'object') return;
    const o = b as Obj;
    if (o.mention && typeof o.mention === 'object' && typeof (o.mention as Obj).resourceId === 'string')
      out.add((o.mention as Obj).resourceId as string);
    for (const v of Object.values(o)) if (Array.isArray(v)) v.forEach(walk);
  };
  blocks.forEach(walk);
  return out;
}
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[\p{Lu}\d])/u)
    .map((s) => s.trim())
    .filter(Boolean);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (text: string, name: string) =>
  name.trim() !== '' && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);

interface Opened {
  readonly env: Env;
  readonly pack: PackRules;
  readonly reader: PageReader | null;
  readonly note: string[];
}

async function openRead(
  pd: Parameters<typeof openEnv>[0],
  mctx: McpToolContext,
  tool: string,
): Promise<R<Opened>> {
  const o = openEnv(pd, mctx, tool);
  if (!o.ok) return o;
  const ap = pd.services?.appraisal;
  const note: string[] = [];
  let reader: PageReader | null = null;
  let pack: PackRules | null = null;
  try {
    pack = ap ? ap.rules(o.value.ctx.projectId) : null;
    reader = ap ? (await ap.reader(o.value.ctx.projectId)).reader : null;
  } catch (e) {
    note.push(
      `The snapshots cannot be read (${e instanceof Error ? e.message : String(e)}): pass live: true.`,
    );
  }
  if (!pack) return no(pd, 'TOOL_UNAVAILABLE', 'The Arkona pack’s rules cannot be read here.');
  return { ok: true, value: { env: o.value, pack, reader, note } };
}

async function loadPage(o: Opened, id: string | null, live: boolean): Promise<LoadedPage | null> {
  if (!id || !o.reader) return null;
  if (live)
    return (await o.reader.readLive(id, liveReader(o.env.pd, o.env.mctx, o.env.tool), o.env.ctx.now)).page;
  return o.reader.load(id);
}

/** A tool's rendered answer as data (a stored handle comes back as it is). */
function bodyOf(r: McpToolResult): Obj {
  const text = (r.content[0] as { text?: string } | undefined)?.text ?? '';
  const lines = text.split('\n');
  try {
    return JSON.parse(lines.slice(0, -1).join('\n')) as Obj;
  } catch {
    return { text: text.slice(0, 2000) };
  }
}

// ============================================================================================ arkona_chapter_context

async function chapterContext(
  o: Opened,
  a: Parameters<typeof locate>[1] & { live?: boolean | undefined },
): Promise<McpToolResult> {
  const { env } = o;
  const w = locate(env, a);
  if (!w.ok) return w.result;
  const { layout, n } = w.value;
  const f = env.rules.fields;
  const live = a.live === true;
  const ch = await loadPage(o, w.value.chapter?.id ?? null, live);
  const pl = await loadPage(o, w.value.plan?.id ?? null, live);
  const date = factOf(ch, f.inWorldDate) ?? factOf(pl, f.plannedDate);
  const continuity = layout.continuity && !layout.continuity.main ? layout.continuity.name : undefined;
  const pov = rowMention(ch, f.pov) ?? rowMention(pl, f.pov);
  const present = collection(ch, f.charactersPresent);
  const locations = collection(ch, f.locations);
  const people = [...new Set([...(pov ? [pov] : []), ...present])];
  const narrativeClass = 'narrative (never canon: the Fiction Writing Reference, 35)';
  // As of the date: arkona_as_of for the people (free).
  let asOf: Obj | null = null;
  if (date && people.length > 0 && env.pd.services?.consistency) {
    try {
      asOf = await env.pd.services.consistency.asOf({
        projectId: env.ctx.projectId,
        characters: people.slice(0, 25),
        date,
        window: 3,
        ...(continuity ? { continuity } : {}),
      });
    } catch (e) {
      asOf = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  // Each one's brief (free).
  const briefs: Obj[] = [];
  for (const id of [...people, ...locations].slice(0, 12)) {
    const r = await topicBrief(env.pd, env.mctx, {
      packId: PACK,
      tool: env.tool,
      input: { subject: id, live: false, include: [], full: false },
    });
    briefs.push({ subject: id, ...bodyOf(r) });
  }
  // The chronology rows around the date and the open contradictions, from the as-of answers.
  const rows = new Map<string, Obj>();
  const contradictions: Obj[] = [];
  for (const c of (asOf?.characters as Obj[] | undefined) ?? []) {
    const around = (c.around ?? {}) as Record<string, Obj[] | number>;
    for (const k of ['before', 'during', 'after'])
      for (const r of Array.isArray(around[k]) ? around[k] : []) rows.set(String(r.row), { ...r, when: k });
    if (Array.isArray(c.contradictions))
      contradictions.push(...(c.contradictions as Obj[]).map((x) => ({ character: c.character, ...x })));
  }
  const section = (p: LoadedPage | null, title: string) =>
    sectionsWhere(p?.body?.blocks ?? [], (t) => nkey(t) === nkey(title))
      .map((s) => sectionMarkdown(s.blocks))
      .join('\n\n') || null;
  // The previous chapter's closing state: its last section (or last paragraphs) and its plan's Closing State.
  const prevCh = layout.chapters.filter((c) => c.n < n).sort((x, y) => y.n - x.n)[0] ?? null;
  const prevPl = prevCh ? (layout.plans.find((p) => p.n === prevCh.n) ?? null) : null;
  const prevPage = await loadPage(o, prevCh?.node.id ?? null, live);
  const prevPlan = await loadPage(o, prevPl?.node.id ?? null, live);
  const prevBlocks = (prevPage?.body?.blocks ?? []) as Obj[];
  const lastHeading = prevBlocks.map((b) => b.kind).lastIndexOf('heading');
  const closing = lastHeading >= 0 ? prevBlocks.slice(lastHeading) : prevBlocks.slice(-3);
  const body = {
    chapter: {
      story: layout.story.displayName,
      number: n,
      ...(w.value.chapter ? { chapter: w.value.chapter } : {}),
      ...(w.value.plan ? { plan: w.value.plan } : {}),
    },
    date: date ? { value: date, from: factOf(ch, f.inWorldDate) ? f.inWorldDate : f.plannedDate } : null,
    ...(date
      ? {}
      : { dateNote: 'No In-world Date or Planned Date: nothing can be read as of a date; set one first.' }),
    continuity: continuity ?? env.rules.indexes.main,
    asOf: asOf ? { evidence: 'canon, by the lifecycle each value carries (arkona_as_of)', ...asOf } : null,
    briefs: { evidence: 'canon, every item labelled by its lifecycle (arkona_brief)', subjects: briefs },
    chronology: { evidence: 'the chronology (canon)', rows: [...rows.values()] },
    contradictions: {
      evidence: 'open Contradictory findings: do not write on these values until the owner picks',
      items: contradictions,
    },
    plan: w.value.plan
      ? {
          evidence: narrativeClass,
          questionGate: factOf(pl, f.questionGate),
          canonConstraints: section(pl, env.rules.planSections.canonConstraints),
        }
      : null,
    previous: prevCh
      ? {
          evidence: narrativeClass,
          chapter: prevCh.node.displayName,
          closingState: blockTexts(closing).join('\n').slice(0, 4000) || null,
          planClosingState: section(prevPlan, env.rules.planSections.closingState),
        }
      : null,
    ...(o.note.length ? { couldNotCheck: o.note } : {}),
    rule: 'Smallest sufficient canon for this chapter (the Workflow). Canon comes first; the plan and the previous chapter are narrative, never canon evidence. Then the Question Gate: ask, close it, draft, arkona_chapter_save.',
    cost: live ? 'a few reads (live)' : 'free (the snapshots, the tree, the calendar)',
  };
  return finish(env.pd, env.mctx, env.tool, body, () => ({ chapter: body.chapter, date: body.date }));
}

// ============================================================================================ arkona_chapter_check

interface Item {
  readonly label: (typeof LABELS)[keyof typeof LABELS];
  readonly kind: 'person' | 'age' | 'date' | 'name' | 'location';
  readonly what: string;
  readonly [k: string]: unknown;
}

async function chapterCheck(
  o: Opened,
  a: Parameters<typeof locate>[1] & { live?: boolean | undefined },
): Promise<McpToolResult> {
  const { env, pack } = o;
  const w = locate(env, a);
  if (!w.ok) return w.result;
  if (!w.value.chapter)
    return no(
      env.pd,
      'CHAPTER_NOT_FOUND',
      `Chapter ${w.value.n} has a plan but no chapter yet: save it first.`,
    ).result;
  const f = env.rules.fields;
  const live = a.live !== false;
  const ch = await loadPage(o, w.value.chapter.id, live);
  if (!ch) return no(env.pd, 'CHAPTER_UNREADABLE', `“${w.value.chapter.name}” could not be read.`).result;
  const blocks = (ch.body?.blocks ?? []) as Obj[];
  const texts = blockTexts(blocks.slice(1)); // the first line is the dateline
  const prose = texts.join('\n');
  const sentences = texts.flatMap(sentencesOf);
  const items: Item[] = [];
  const presence: Obj[] = [];
  const notes: string[] = [...o.note];
  const date = factOf(ch, f.inWorldDate);
  const { calendar, style } = env.pd.services?.chronology
    ? narrativeCalendar(env.pd.services.chronology, env.ctx.projectId)
    : { calendar: null, style: undefined };
  const reading: DateReading | null =
    date && calendar
      ? ((r) => (r.ok ? r.reading : null))(
          style ? readLeading(calendar, date, style) : readLeading(calendar, date),
        )
      : null;
  if (!reading)
    notes.push(
      date
        ? `The In-world Date “${date}” cannot be read: nothing was checked as of a date.`
        : 'No In-world Date: nothing was checked as of a date.',
    );
  const continuity =
    w.value.layout.continuity && !w.value.layout.continuity.main ? w.value.layout.continuity.name : undefined;
  if (continuity)
    notes.push(
      `An AU chapter: read with ${continuity}’s own facts first, else Main CANON’s labelled inherited (F4b D9).`,
    );
  // ---- people: the as-of states.
  const pov = rowMention(ch, f.pov);
  const listed = [...new Set([...(pov ? [pov] : []), ...collection(ch, f.charactersPresent)])];
  const scan = currentCharacters({
    ctx: env.ctx,
    rules: pack,
    lifecycle: lifecycleFrom(env.pd.services?.projectSettings?.(env.ctx.projectId) ?? {}),
  });
  const ownerOf = (id: string) => {
    const r = env.ctx.types.characterOfPage(id);
    return r.ok ? r.value.core.id : id;
  };
  const byOwner = new Map(scan.characters.map((c) => [ownerOf(c.identity.id), c]));
  const recordOf = (id: string) =>
    byOwner.get(ownerOf(id)) ?? scan.characters.find((c) => c.identity.id === id) ?? null;
  const consistency = env.pd.services?.consistency;
  const asOf = new Map<string, Obj>();
  if (reading && consistency && listed.length > 0) {
    const ans = await consistency.asOf({
      projectId: env.ctx.projectId,
      characters: listed.slice(0, 25),
      date: date!,
      ...(continuity ? { continuity } : {}),
    });
    for (const [i, c] of ((ans.characters as Obj[]) ?? []).entries()) asOf.set(listed[i]!, c);
  }
  for (const id of listed) {
    const c = asOf.get(id);
    if (!c || c.refused) continue;
    const state = (c.state as { value?: string; why?: string } | undefined) ?? {};
    const who = typeof c.character === 'string' ? c.character : id;
    if (c.elapsedYears === 'not yet born')
      items.push({
        label: LABELS.contradicts,
        kind: 'person',
        what: `${who} is not yet born at ${date}`,
        character: who,
        born: c.born,
      });
    else if (state.value === 'Deceased (recorded)')
      items.push({
        label: LABELS.contradicts,
        kind: 'person',
        what: `${who} is recorded deceased by ${date}`,
        character: who,
        died: c.died,
      });
    else if (state.value === 'Unestablished')
      items.push({
        label: LABELS.unestablished,
        kind: 'person',
        what: `Nothing recorded places ${who} alive at ${date} (${state.why ?? 'outside the attested life'})`,
        character: who,
      });
  }
  // Present but absent from the prose, and the reverse.
  const mentioned = mentionsIn(blocks);
  const named = (rec: NonNullable<ReturnType<typeof recordOf>>) =>
    [...rec.names.full, ...rec.names.aliases, ...(rec.names.given ? [rec.names.given] : [])].some((n) =>
      wholeWord(prose, n),
    );
  for (const id of listed) {
    const rec = recordOf(id);
    const inProse = [...mentioned].some((m) => ownerOf(m) === ownerOf(id)) || (rec ? named(rec) : false);
    if (!inProse)
      presence.push({
        issue: 'listed in Characters Present but not in the prose',
        character: rec?.subject ?? id,
      });
  }
  const listedOwners = new Set(listed.map(ownerOf));
  for (const rec of scan.characters) {
    if (listedOwners.has(ownerOf(rec.identity.id))) continue;
    const inProse =
      [...mentioned].some((m) => ownerOf(m) === ownerOf(rec.identity.id)) ||
      rec.names.full.some((n) => wholeWord(prose, n));
    if (inProse)
      presence.push({ issue: 'in the prose but not in Characters Present', character: rec.subject });
  }
  // ---- ages and dates written in the prose (the pack's phrasings; by name only, never a pronoun).
  const cons = pack.consistency as
    (typeof pack.consistency & { ages?: { id: string; regex: string }[] }) | undefined;
  for (const id of listed) {
    const rec = recordOf(id);
    const c = asOf.get(id);
    if (!rec) continue;
    const names = [...rec.names.full, ...rec.names.aliases].filter((n) => n.trim().length >= 3);
    if (names.length === 0) continue;
    const nameRe = `(?:${names.map(escape).join('|')})`;
    for (const p of cons?.ages ?? []) {
      let re: RegExp;
      try {
        re = new RegExp(p.regex.replace('{name}', nameRe), 'iu');
      } catch {
        continue;
      }
      for (const s of sentences) {
        const m = re.exec(s);
        if (!m?.groups?.age) continue;
        const age = Number(m.groups.age);
        const e = c?.elapsedYears;
        if (typeof e === 'number' && e !== age)
          items.push({
            label: LABELS.contradicts,
            kind: 'age',
            what: `${rec.subject} is ${age} in the prose, ${e} calendar years at ${date}`,
            sentence: s,
          });
        else if (e && typeof e === 'object' && (age < Number((e as Obj).min) || age > Number((e as Obj).max)))
          items.push({
            label: LABELS.contradicts,
            kind: 'age',
            what: `${rec.subject} is ${age} in the prose, ${String((e as Obj).min)} to ${String((e as Obj).max)} calendar years at ${date}`,
            sentence: s,
          });
        else if (e === null || e === undefined)
          items.push({
            label: LABELS.unestablished,
            kind: 'age',
            what: `${rec.subject} is ${age} in the prose; no birth is recorded`,
            sentence: s,
          });
      }
    }
    for (const p of (cons?.patterns ?? []).filter(
      (x) => x.source === 'prose' && (x.kind === 'birth' || x.kind === 'death') && !x.gap,
    )) {
      let re: RegExp;
      try {
        re = new RegExp(p.regex.replace('{name}', nameRe), 'iu');
      } catch {
        continue;
      }
      for (const s of sentences) {
        const m = re.exec(s);
        const t = m?.groups?.date;
        if (!t || !calendar) continue;
        const said = style ? readLeading(calendar, t, style) : readLeading(calendar, t);
        if (!said.ok) continue;
        const recorded = (p.kind === 'birth' ? c?.born : c?.died) as { value?: string } | undefined;
        const rv = recorded?.value
          ? style
            ? readLeading(calendar, recorded.value, style)
            : readLeading(calendar, recorded.value)
          : null;
        const margin = cons?.approxMargin ?? 5;
        if (
          rv &&
          rv.ok &&
          !overlaps(spanOf(calendar, said.reading, margin), spanOf(calendar, rv.reading, margin))
        )
          items.push({
            label: LABELS.contradicts,
            kind: 'date',
            what: `${rec.subject}’s ${p.kind} is ${said.reading.text} in the prose, ${recorded!.value} in canon`,
            sentence: s,
          });
        else if (!rv)
          items.push({
            label: LABELS.candidate,
            kind: 'date',
            what: `${rec.subject}’s ${p.kind} (${said.reading.text}) is not recorded in canon`,
            sentence: s,
          });
      }
    }
  }
  // ---- names that resolve nowhere (new-lore candidates), and those resolving only to Archived or Legacy pages.
  const nodes = env.ctx.tree
    .subtree(env.ctx.projectId, env.ctx.meta.rootId ?? '', { limit: 1_000_000 })
    .data.entries.map((e) => e.node);
  const archivedOnly = (id: string) => {
    const n = env.ctx.tree.node(env.ctx.projectId, id).data;
    return !!n && (n.kind === 'barc' || n.path.names.some((x) => /^legacy canon archive$/i.test(x)));
  };
  const namesOf = (n: (typeof nodes)[number]) => [
    n.displayName,
    subjectOf(n.displayName),
    ...n.aliases,
    ...(n.canonicalDisplayName ? [n.canonicalDisplayName] : []),
  ];
  const current = resolvableNames([
    ...nodes.filter((n) => !archivedOnly(n.id)).flatMap(namesOf),
    ...scan.characters.flatMap((c) => [
      ...c.names.full,
      ...c.names.aliases,
      ...(c.names.given ? [c.names.given] : []),
      ...(c.names.surname ? [c.names.surname] : []),
    ]),
    ...env.rules.notNames,
    ...(calendar ? calendarWords(calendar) : []),
  ]);
  const historical = resolvableNames(nodes.filter((n) => archivedOnly(n.id)).flatMap(namesOf));
  const seen = new Set<string>();
  const candidates: Item[] = [];
  for (const s of sentences) {
    const runs = capitalisedRuns(s);
    const firstWord =
      s
        .replace(/^["“‘(]+/, '')
        .split(/\s+/)[0]
        ?.replace(/[^\p{L}'’-]/gu, '') ?? '';
    for (const run of runs) {
      const words =
        run[0] === firstWord &&
        s
          .trimStart()
          .replace(/^["“‘(]+/, '')
          .startsWith(firstWord)
          ? run.slice(1)
          : run;
      if (words.length === 0) continue;
      const name = words.join(' ');
      const k = nameNorm(name);
      if (k === '' || seen.has(k) || knows(current, k) || words.every((x) => knows(current, nameNorm(x))))
        continue;
      seen.add(k);
      if (knows(historical, k))
        items.push({
          label: LABELS.unestablished,
          kind: 'name',
          what: `“${name}” resolves only to Archived or Legacy pages`,
          name,
          sentence: s,
        });
      else
        candidates.push({
          label: LABELS.candidate,
          kind: 'name',
          what: `“${name}” resolves to no page`,
          name,
          sentence: s,
        });
    }
  }
  const cap = env.rules.candidateCap;
  // ---- locations.
  for (const id of collection(ch, f.locations)) {
    const n = env.ctx.tree.node(env.ctx.projectId, id).data;
    if (!n)
      items.push({
        label: LABELS.candidate,
        kind: 'location',
        what: `A Location (${id}) is no page in the repository now`,
        location: id,
      });
    else if (archivedOnly(id))
      items.push({
        label: LABELS.unestablished,
        kind: 'location',
        what: `“${n.displayName}” is only Archived or Legacy`,
        location: n.displayName,
      });
  }
  const all = [...items, ...candidates.slice(0, cap)];
  const body = {
    chapter: { ...w.value.chapter, story: w.value.layout.story.displayName, number: w.value.n, date },
    continuity: continuity ?? env.rules.indexes.main,
    counts: {
      contradicts: all.filter((i) => i.label === LABELS.contradicts).length,
      candidates: candidates.length,
      unestablished: all.filter((i) => i.label === LABELS.unestablished).length,
    },
    items: all,
    ...(candidates.length > cap ? { candidatesNotListed: candidates.length - cap } : {}),
    presence,
    ...(notes.length ? { notes } : {}),
    rule: 'Read-only: nothing was edited. Candidates are names, never findings: offer the ones the owner should see with arkona_promote_from_chapter (you supply the content); never promote by yourself.',
    cost: live ? '2 reads (the chapter, live); the rest free' : 'free (the snapshots)',
  };
  return finish(env.pd, env.mctx, env.tool, body, () => body.counts);
}

/** The calendar's month and era words (never a new-lore candidate). */
function calendarWords(cal: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Obj)) {
      if ((k === 'name' || k === 'abbreviation' || k === 'shortName') && typeof x === 'string') out.push(x);
      if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1));
      else if (x && typeof x === 'object') walk(x, depth + 1);
    }
  };
  walk(cal, 0);
  return out;
}

// ============================================================================================ the tools

export function narrativeReadTools(
  deps: ToolDeps,
  tool: (name: string) => McpToolProvider | undefined,
): McpToolProvider[] {
  const listed = () => {
    const packs = deps.services?.packs;
    return (packs?.toolListed(PACK) ?? false) && packs?.get(PACK)?.rules.narrative !== undefined;
  };
  const runRead =
    <A>(name: string, fn: (o: Opened, args: A) => Promise<McpToolResult>) =>
    (args: A & { project?: string | undefined }, mctx: McpToolContext) =>
      withProject(deps, args.project, 'read', async (pd) => {
        const o = await openRead(pd, mctx, name);
        if (!o.ok) return o.result;
        try {
          return await fn(o.value, args);
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      });
  return [
    defineTool({
      name: 'arkona_chapter_context',
      title: 'The canon a chapter needs, as of its date (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack (design F4c, E6), read-only and free: the SMALLEST SUFFICIENT CANON for drafting one chapter, as of its In-world Date (or its plan’s Planned Date): arkona_as_of and arkona_brief for its POV, Characters Present and Locations, the chronology rows around the date, open contradictions, the plan’s Canon Constraints and Question Gate, and the previous chapter’s closing state; every part labelled by its evidence class (the plan and earlier chapters are narrative, never canon). Call it first; then the Question Gate (ask, close it), the draft, arkona_chapter_save, arkona_chapter_check. Cost: none from the snapshots; live: true reads the chapter, its plan and the previous chapter now.',
      inputSchema: z.object({
        ...chapterArgs,
        live: z.boolean().optional().describe('Read the pages now instead of the snapshots.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: runRead('arkona_chapter_context', chapterContext),
    }),
    defineTool({
      name: 'arkona_chapter_check',
      title: 'Check a saved chapter against canon at its date (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack (design F4c, E6), read-only: what a SAVED chapter says against canon at its In-world Date. People: a character not yet born, recorded deceased, or with nothing recording them alive at the date (the as-of states); Characters Present missing from the prose, and characters in the prose missing from Characters Present. Ages and birth or death dates written in the prose, by the pack’s phrasings and by name only, against the as-of values. Names in the prose that resolve to no page (new-lore candidates, capped; never a sentence’s first word) or only to Archived or Legacy pages; Locations that are gone or only Archived. An AU chapter is read with the AU’s facts first. Each item is labelled Contradicts canon, Not in canon (candidate) or Unestablished in canon. It NEVER edits anything: offer candidates with arkona_promote_from_chapter. Cost: 2 reads (the chapter, live; live: false reads the snapshots instead).',
      inputSchema: z.object({
        ...chapterArgs,
        live: z.boolean().optional().describe('false: read the snapshots instead of the chapter now.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: runRead('arkona_chapter_check', chapterCheck),
    }),
    promoteTool(deps, listed, tool),
  ];
}

// ============================================================================================ arkona_promote_from_chapter

const candidateSchema = z
  .object({
    candidate: z
      .string()
      .min(1)
      .max(300)
      .describe('The item of arkona_chapter_check it comes from (its name or what).'),
    as: z.enum(['character', 'page', 'fact', 'text']),
    character: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('as character: arkona_create_character’s arguments (status is made authoritative).'),
    page: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('as page: create_resource’s arguments (status is made authoritative).'),
    target: z.string().min(1).max(300).optional().describe('as fact or text: the existing owner page.'),
    facts: z.record(z.string(), z.string()).optional().describe('as fact: field → value.'),
    section: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('as text: the section the Markdown is appended to.'),
    markdown: z
      .string()
      .min(1)
      .max(50_000)
      .optional()
      .describe('as text: the Markdown appended to the section.'),
  })
  .strict();

function promoteTool(
  deps: ToolDeps,
  listed: () => boolean,
  tool: (name: string) => McpToolProvider | undefined,
): McpToolProvider {
  const name = 'arkona_promote_from_chapter';
  return defineTool({
    name,
    title: 'Offer what a chapter invents to the owner as canon (Arkona pack)',
    access: 'write',
    description:
      'The Arkona pack (design F4c, E7): turns items of arkona_chapter_check into CANON PROPOSALS through the existing tools, whatever your scope: a new character (arkona_create_character, Authoritative), a new page (create_resource, Authoritative), or a fact or text on an existing owner page (set_facts, write_page: made proposals). YOU supply the content (never the prose taken as canon by itself); arkona_name_check’s namesakes are carried for a new character. Several facts and texts in one call are ONE proposal of items, so the owner accepts some and rejects the rest; each new character or page is its own proposal. The chapter is cited in the proposal’s note only (never a Dependency or a Related Source). Nothing is ever applied by itself, and silence is never acceptance. Cost: the tools’ own (each a proposal).',
    inputSchema: z.object({
      chapter: z.string().min(1).max(300).describe('The chapter the lore comes from: its name or id.'),
      continuity: z.string().min(1).max(200).optional(),
      candidates: z.array(candidateSchema).min(1).max(20),
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    listed,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const o = openEnv(pd, mctx, name);
        if (!o.ok) return o.result;
        const env = o.value;
        try {
          const w = locate(env, { chapter: args.chapter, continuity: args.continuity });
          if (!w.ok) return w.result;
          if (!w.value.chapter) return no(pd, 'CHAPTER_NOT_FOUND', 'Name a saved chapter.').result;
          const cite = `introduced in Chapter ${w.value.n} of “${w.value.layout.story.displayName}” (${w.value.chapter.name})`;
          const out: Obj[] = [];
          for (const c of args.candidates) {
            if (c.as === 'character' || c.as === 'page') {
              const t = tool(c.as === 'character' ? 'arkona_create_character' : 'create_resource');
              const input = (c.as === 'character' ? c.character : c.page) ?? null;
              if (!t || !input) {
                out.push({
                  candidate: c.candidate,
                  error: {
                    code: 'INVALID_PARAMS',
                    message: `as ${c.as} needs ${c.as}: the tool’s arguments.`,
                  },
                });
                continue;
              }
              const r = await t.handler({ ...input, status: 'authoritative', project: args.project }, mctx);
              const b = bodyOf(r);
              const proposalId = typeof b.proposalId === 'string' ? b.proposalId : null;
              if (proposalId) pd.services?.proposals?.annotate(proposalId, cite);
              out.push({ candidate: c.candidate, as: c.as, ...b, ...(proposalId ? { note: cite } : {}) });
              continue;
            }
            if (!c.target) {
              out.push({
                candidate: c.candidate,
                error: { code: 'INVALID_PARAMS', message: `as ${c.as} needs target: the owner page.` },
              });
              continue;
            }
          }
          const result = await promoteEdits(
            env,
            args.candidates.filter((c) => c.as === 'fact' || c.as === 'text'),
            cite,
          );
          return finish(
            pd,
            mctx,
            name,
            {
              cite,
              proposals: out,
              ...(result ? { edits: result } : {}),
              rule: 'Nothing was applied: each is a proposal the owner accepts or rejects (silence is never acceptance).',
            },
            () => ({ cite }),
          );
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      }),
  });
}

/** Facts and texts on existing owner pages: ONE proposal of items (forced), whatever the scope. */
async function promoteEdits(
  env: Env,
  list: readonly z.infer<typeof candidateSchema>[],
  cite: string,
): Promise<Obj | null> {
  if (list.length === 0) return null;
  const parts: StepSpec[][] = [];
  const items: PlanItem[] = [];
  const refused: Obj[] = [];
  const pages: string[] = [];
  for (const [i, c] of list.entries()) {
    const rp = resolvePage(env.ctx, c.target!);
    if (!rp.ok) {
      refused.push({ candidate: c.candidate, ...bodyOf(rp.result) });
      continue;
    }
    const node = rp.node;
    const item = `promote:${i}:${node.id}`;
    if (c.as === 'fact') {
      const rows = Object.entries(c.facts ?? {}).map(([key, v]) => ({ key, runs: text(v), needed: true }));
      if (rows.length === 0) {
        refused.push({
          candidate: c.candidate,
          error: { code: 'INVALID_PARAMS', message: 'as fact needs facts.' },
        });
        continue;
      }
      const ef = await existingFacts(env, { id: node.id, name: node.displayName }, rows);
      if (!ef.ok) {
        refused.push({ candidate: c.candidate, ...bodyOf(ef.result) });
        continue;
      }
      if (ef.value.steps.length === 0) continue;
      parts.push(ef.value.steps.map((st) => ({ ...st, items: [item] })));
      items.push({
        id: item,
        kind: 'fact',
        group: 'Facts',
        label: `${node.displayName}: ${ef.value.changes.join(', ')} (${c.candidate})`,
        page: { id: node.id, name: node.displayName },
        dependsOn: [],
        selected: true,
      });
    } else {
      const doc = node.documents.find((d) => d.type === 'page');
      if (!doc || !c.markdown || !c.section) {
        refused.push({
          candidate: c.candidate,
          error: {
            code: 'INVALID_PARAMS',
            message: 'as text needs target (with a page document), section and markdown.',
          },
        });
        continue;
      }
      const read = await liveRead(env.pd, env.mctx, env.tool, 'getDocumentBlocks', {
        path: { resourceId: node.id, documentId: doc.id },
      });
      if (!read.ok) {
        refused.push({ candidate: c.candidate, ...bodyOf(read.result) });
        continue;
      }
      const cur = read.value as { version: string; blocks: LkBlock[] };
      let plan;
      try {
        plan = planPageWrite(
          { version: cur.version, blocks: cur.blocks },
          { mode: 'append_to_section', section: c.section, markdown: c.markdown },
          env.converter,
        );
      } catch (e) {
        refused.push({
          candidate: c.candidate,
          error: {
            code: (e as { code?: string }).code ?? 'MARKDOWN_ERROR',
            message: e instanceof Error ? e.message : String(e),
          },
        });
        continue;
      }
      parts.push([
        {
          op: 'replaceDocumentBlocks',
          params: {
            path: { resourceId: node.id, documentId: doc.id },
            ifMatch: plan.version,
            body: { blocks: plan.blocks },
          },
          verifyAfterWrite: true,
          ...(plan.section
            ? {
                replan: {
                  planner: WRITE_PAGE_PLANNER,
                  input: {
                    mode: 'append_to_section',
                    section: c.section,
                    markdown: c.markdown,
                    sectionHash: plan.section.hash,
                  },
                },
              }
            : {}),
          journalOperation: {
            tool: 'write_page',
            page: { id: node.id, name: node.displayName },
            from: env.tool,
          },
          items: [item],
        },
      ]);
      items.push({
        id: item,
        kind: 'text',
        group: 'Text',
        label: `${node.displayName}: ${c.section} (${c.candidate})`,
        page: { id: node.id, name: node.displayName },
        diff: { after: c.markdown.slice(0, 500) },
        dependsOn: [],
        selected: true,
      });
    }
    pages.push(node.id);
  }
  if (items.length === 0) return refused.length ? { refused } : null;
  const steps: StepSpec[] = [];
  for (const p of parts) {
    const base = steps.length;
    for (const st of p) steps.push(shiftStep(st, base));
  }
  const summary = `${env.tool}: ${items.length} canon change(s) offered; ${cite}`;
  const out = await runWriteJob(env.pd, env.mctx, env.tool, {
    steps,
    labels: steps.map((st) => st.op),
    title: summary,
    // A canon proposal whatever the scope (E7): it states new canon.
    forceProposal: true,
    proposal: {
      operations: items.map((it) => ({ tool: env.tool, page: it.page, pageParts: [it.kind] })),
      summary: summary.slice(0, 500),
      items,
    },
    head: { items: items.map((it) => ({ id: it.id, label: it.label })), note: cite },
    preview: () => ({ items: items.length }),
  });
  return { ...out.body, ...(refused.length ? { refused } : {}) };
}
