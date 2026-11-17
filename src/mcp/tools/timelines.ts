/**
 * The calendar and timeline tools (v2 D1, PLAN-v2 sections 4.8, 4.9 and 5; ADR 0038):
 *
 * - `calendar_date` (read): a date in any accepted form, minutes or a KCY, answered by the calendar engine. No
 *   LegendKeeper request when the chronology's calendar is cached.
 * - `create_timeline_event`, `update_timeline_event`, `delete_timeline_event` (write): a chronology event is a row of its
 *   age's table (the authority), an event of its age's timeline (a derived view) and one in its age's count on the Main
 *   table. Each call is ONE job that keeps the three in step (or ONE proposal under `propose`), holding all the
 *   documents' locks in sorted order, with the compare-and-swap inside the lock, verify, journal pre-images,
 *   `operation_id`, `dryRun`, and resume-never-replay after a part-way stop (C2c's pattern).
 * - `create_timeline_lane` (write): a lane on a timeline that is NOT one of the chronology's age timelines (each has
 *   exactly one lane by design). It touches only that timeline.
 *
 * Canon (ADR 0036 decision 6, option (a), decided 11 November 2026): these edits are ordinary edits on an Authoritative
 * page, never canon-gated; only deleting a whole timeline document of an Authoritative page is canonical.
 */
import { keptEventFields } from '../../chronology/event-body.js';
import { createHash } from 'node:crypto';
import * as z from 'zod';
import {
  CalendarError,
  formatKcy,
  parseQualified,
  type Calendar,
  type ParsedDate,
} from '../../calendar/index.js';
import {
  buildRow,
  currentTableOnly,
  ORPHAN_TOOL,
  orphanRequestKey,
  planOrphanDelete,
  readAgeTable,
  readMainTable,
  sameDate,
  sameText,
  sortKey,
  anchorFor,
  type AgeConfig,
  type AgeRow,
  type AgeTable,
  type ChronologyConfig,
  type ChronologyRecord,
  type ChronologyTarget,
  type ChronologyTool,
  type MainTable,
  type TargetWrite,
} from '../../chronology/index.js';
import {
  matchRowsAndEvents,
  tableUri,
  uriPointsAt,
  eventOf,
  type TimelineEvent,
} from '../../chronology/check.js';
import { buildJob, replaceCells, type WriteContext } from '../../chronology/plan.js';
import { planSync, syncRequestKey, SYNC_TOOL, type SyncRef } from '../../chronology/sync.js';
import { factValueRuns, FactValueError } from '../../facts/values.js';
import { mintClientId } from '../../jobs/ids.js';
import { VERIFY_STEP } from '../../jobs/internal-steps.js';
import type { StepSpec } from '../../jobs/index.js';
import { pageConverterContext } from '../../pages/index.js';
import { nameKey } from '../../tree/index.js';
import type { TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { withRequest, type CreateOutcome } from './create-support.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { liveRead, repoContext, resolvePage, type RepoCtx } from './repo.js';
import { CHANGE_ANNOTATIONS, CREATE_ANNOTATIONS, operationIdArg } from './resources.js';
import { pageRef } from './set-facts.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';
import { runWriteJob } from './write-job.js';
import { lastMajorRevisionArg } from './schemas.js';
import type { LmrMode } from '../../jobs/lmr-hook.js';

type Obj = Record<string, unknown>;
type Answer = { kind: 'answer'; result: McpToolResult };

const refuse = (pd: ProjectDeps, code: string, message: string, more: Obj = {}): Answer => ({
  kind: 'answer',
  result: errorResult({ code, message, ...more }, pd),
});

const descriptionArg = z
  .union([z.string().min(1).max(20_000), z.object({ markdown: z.string().min(1).max(20_000) }).strict()])
  .describe(
    'The full description, for the table row: plain text, or { "markdown": "…" } for inline Markdown (bold, italic, links and mentions such as [[Ashgate]]).',
  );

const DATE_HELP =
  'A chronology date such as “Kumikas 1st, 1A 159”, “4A 881”, “Unknown, 4A 101” or a range “Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102” (all forms: calendar_date, which also checks a date).';

// ============================================================================================ the chronology now

interface Chrono {
  readonly ctx: RepoCtx;
  readonly config: ChronologyConfig;
  readonly resource: TreeNode;
}

function chrono(pd: ProjectDeps): { ok: true; value: Chrono } | { ok: false; result: McpToolResult } {
  const rc = repoContext(pd);
  if (!rc.ok) return rc;
  const ch = pd.services?.chronology;
  if (!ch)
    return {
      ok: false,
      result: errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Chronology sync is not available.' }, pd),
    };
  const r = ch.readiness(pd.project.id);
  if (!r.ok) return { ok: false, result: errorResult({ code: r.code, message: r.message }, pd) };
  return { ok: true, value: { ctx: rc.ctx, config: r.config, resource: r.resource } };
}

/** The chronology's calendar, read again (one request) so a write never plans with a stale definition. */
async function freshCalendar(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  calendarId: string,
): Promise<{ ok: true; cal: Calendar } | { ok: false; result: McpToolResult }> {
  const r = await liveRead(pd, mctx, tool, 'listCalendars', {});
  if (!r.ok) return r;
  const data = (r.value as { data?: unknown }).data;
  const def = (Array.isArray(data) ? (data as Obj[]) : []).find((c) => c.id === calendarId);
  if (!def)
    return {
      ok: false,
      result: errorResult(
        {
          code: 'CALENDAR_NOT_FOUND',
          message: `The chronology's calendar ${calendarId} is gone. The owner confirms the chronology again.`,
        },
        pd,
      ),
    };
  try {
    return { ok: true, cal: pd.services!.chronology!.remember(pd.project.id, def) };
  } catch (e) {
    return { ok: false, result: calendarError(pd, e) };
  }
}

function calendarError(pd: ProjectDeps, e: unknown): McpToolResult {
  if (e instanceof CalendarError) return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
  return errorFromThrown(e, pd);
}

interface TableNow {
  readonly age: AgeConfig;
  readonly table: AgeTable;
  readonly version: string | null;
}

async function readTable(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  ch: Chrono,
  cal: Calendar,
  age: AgeConfig,
): Promise<{ ok: true; value: TableNow } | { ok: false; result: McpToolResult }> {
  const r = await liveRead(pd, mctx, tool, 'getDocumentBlocks', {
    path: { resourceId: ch.resource.id, documentId: age.tableDocumentId },
  });
  if (!r.ok) return r;
  const b = (r.value ?? {}) as { blocks?: unknown[]; version?: unknown };
  const t = readAgeTable(b.blocks ?? [], cal.parser, ch.config.style.date, ch.config.columns);
  if (!t)
    return {
      ok: false,
      result: errorResult(
        {
          code: 'CHRONOLOGY_CHANGED',
          message: `The ${age.name} table document has no table with the columns ${ch.config.columns.event} | ${ch.config.columns.date} | ${ch.config.columns.kcy}.`,
        },
        pd,
      ),
    };
  return { ok: true, value: { age, table: t, version: typeof b.version === 'string' ? b.version : null } };
}

async function readMain(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  ch: Chrono,
): Promise<{ ok: true; value: MainTable } | { ok: false; result: McpToolResult }> {
  const r = await liveRead(pd, mctx, tool, 'getDocumentBlocks', {
    path: { resourceId: ch.resource.id, documentId: ch.config.mainDocumentId! },
  });
  if (!r.ok) return r;
  const m = readMainTable(((r.value ?? {}) as { blocks?: unknown[] }).blocks ?? [], ch.config.columns);
  if (!m)
    return {
      ok: false,
      result: errorResult(
        { code: 'CHRONOLOGY_CHANGED', message: 'The Main document has no Main table.' },
        pd,
      ),
    };
  return { ok: true, value: m };
}

async function readEventsOf(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  ch: Chrono,
  age: AgeConfig,
): Promise<{ ok: true; value: TimelineEvent[] } | { ok: false; result: McpToolResult }> {
  const out: TimelineEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = await liveRead(pd, mctx, tool, 'listEvents', {
      path: { resourceId: ch.resource.id, documentId: age.timelineDocumentId },
      query: { limit: 100, ...(cursor ? { cursor } : {}) },
    });
    if (!r.ok) return r;
    const b = (r.value ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
    for (const e of Array.isArray(b.data) ? (b.data as Obj[]) : [])
      if (e && typeof e.id === 'string') out.push(eventOf(e));
    if (b.hasMore !== true || typeof b.nextCursor !== 'string') break;
    cursor = b.nextCursor;
  }
  return { ok: true, value: out.filter((e) => e.laneId === age.laneId) };
}

async function readEvent(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  ch: Chrono,
  documentId: string,
  eventId: string,
): Promise<{ ok: true; value: Obj | null } | { ok: false; result: McpToolResult }> {
  try {
    const r = await pd.engine.run(
      'getEvent',
      { path: { resourceId: ch.resource.id, documentId, eventId } },
      { project: pd.project.id, origin: mcpOrigin(mctx, tool), priority: 'P1', signal: mctx.signal },
    );
    if (r.status === 'succeeded') return { ok: true, value: (r.result ?? null) as Obj | null };
    return {
      ok: false,
      result: errorResult(
        { code: 'READ_DELAYED', message: 'LegendKeeper’s rate budget is busy; try later.' },
        pd,
      ),
    };
  } catch (e) {
    const code = (e as { code?: unknown; lk?: { status?: number } }).lk?.status;
    if (code === 404) return { ok: true, value: null };
    return { ok: false, result: errorFromThrown(e, pd) };
  }
}

/** The age a date belongs to (its start's era), or the refusal. */
function ageOfDate(ch: Chrono, cal: Calendar, d: ParsedDate): AgeConfig | null {
  return ch.config.ages.find((a) => cal.engine.eras.find((e) => e.id === a.eraId)?.id === d.era.id) ?? null;
}

/** An age named by the caller: its name or its era's abbreviation. */
function ageByName(ch: Chrono, cal: Calendar, name: string): AgeConfig | null {
  const k = nameKey(name);
  return (
    ch.config.ages.find((a) => nameKey(a.name) === k) ??
    ch.config.ages.find((a) => nameKey(cal.engine.eras.find((e) => e.id === a.eraId)?.abbr ?? '') === k) ??
    null
  );
}

function dateView(d: ParsedDate, ch: Chrono) {
  return {
    text: d.text,
    tableFormatted: d.tableFormatted,
    formatted: d.formatted,
    form: d.form,
    shape: d.shape,
    detail: d.detail,
    start: d.start,
    ...(d.end !== null ? { end: d.end } : {}),
    formattedStart: d.formattedStart,
    ...(d.formattedEnd !== null ? { formattedEnd: d.formattedEnd } : {}),
    era: d.era.abbr,
    kcy: formatKcy(d.kcy, ch.config.style.kcy),
  };
}

const mentionLabel = (m: Obj): string =>
  typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** The description's runs (inline Markdown through the converter, mentions resolved), or the refusal. */
function descriptionRuns(
  pd: ProjectDeps,
  ch: Chrono,
  description: string | { markdown: string },
): { ok: true; runs: Obj[]; text: string } | { ok: false; result: McpToolResult } {
  const converter = pd.services ? pageConverterContext(pd.services, ch.ctx.projectId) : undefined;
  if (!converter)
    return {
      ok: false,
      result: errorResult(
        { code: 'TOOL_UNAVAILABLE', message: 'The repository tree cannot resolve names now.' },
        pd,
      ),
    };
  try {
    const runs = factValueRuns(description, converter);
    if (runs.length === 0)
      return {
        ok: false,
        result: errorResult({ code: 'INVALID_PARAMS', message: 'The description is empty.' }, pd),
      };
    const text = runs
      .map((r) => (typeof r.text === 'string' ? r.text : r.mention ? mentionLabel(r.mention as Obj) : ' '))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, runs, text };
  } catch (e) {
    if (e instanceof FactValueError)
      return { ok: false, result: errorResult({ code: e.code, message: e.message, ...e.details }, pd) };
    return { ok: false, result: errorFromThrown(e, pd) };
  }
}

/** A stopped change on these ages: the same request resumes it; anything else waits for it. */
function stoppedChange(
  pd: ProjectDeps,
  ch: Chrono,
  requestKey: string,
  ages: readonly string[],
): { resume: ChronologyRecord | null; refusal: Answer | null } {
  const store = pd.services!.chronology!.store;
  for (const rec of store.incomplete(ch.ctx.projectId)) {
    const job = rec.jobId ? pd.engine.queries.getJob(ch.ctx.projectId, rec.jobId) : null;
    const running = job && !['succeeded', 'failed', 'cancelled'].includes(job.status);
    const overlaps = rec.ages.some((a) => ages.some((b) => nameKey(a) === nameKey(b)));
    if (rec.requestKey === requestKey) {
      if (running)
        return {
          resume: null,
          refusal: refuse(
            pd,
            'CHRONOLOGY_IN_PROGRESS',
            `This change is still running (job ${job.id}); nothing was done. Follow it with bridge_job_status.`,
            {
              jobId: job.id,
              recordId: rec.id,
            },
          ),
        };
      return { resume: rec, refusal: null };
    }
    if (overlaps) {
      return {
        resume: null,
        refusal: refuse(
          pd,
          running ? 'CHRONOLOGY_IN_PROGRESS' : 'CHRONOLOGY_INCOMPLETE',
          running
            ? `Another chronology change of ${rec.ages.join(' and ')} is running (job ${job.id}); nothing was done. Try again when it has finished.`
            : `A chronology change of ${rec.ages.join(' and ')} stopped part-way (change ${rec.id}: ${rec.summary}). Repeat that same request to finish it first (or the owner marks it resolved on the dashboard). Nothing was done.`,
          { recordId: rec.id, ...(running ? { jobId: job.id } : {}) },
        ),
      };
    }
  }
  return { resume: null, refusal: null };
}

/** What the plan needs about each document a target writes (read now) for `buildJob`, and what is left to do. */
interface Now {
  readonly tables: Map<string, TableNow>;
  readonly main: MainTable;
  readonly events: Map<string, Obj | null>;
}

/**
 * The writes still to make, from the documents as they are now and the record (resuming), or the refusal when what is
 * there is neither the state before the change nor after it.
 */
function remaining(
  pd: ProjectDeps,
  target: ChronologyTarget,
  now: Now,
  rec: ChronologyRecord | null,
): { ok: true; writes: TargetWrite[]; expectBefore: Record<string, number> } | { ok: false; result: Answer } {
  const writes: TargetWrite[] = [];
  const expectBefore: Record<string, number> = {};
  const rowOf = (doc: string, id: string) => now.tables.get(doc)?.table.rows.find((r) => r.id === id) ?? null;
  const same = (r: AgeRow, t: { description: string; date: string; kcy: string }) =>
    sameText(r.description, t.description) &&
    r.dateText.trim() === t.date.trim() &&
    r.kcyText.trim() === t.kcy.trim();
  for (const w of target.writes) {
    switch (w.kind) {
      case 'row.assert':
        // A compare-and-swap of a first run only: on a resume the row may have been edited since, and the repair's
        // event writes are checked against their own state.
        if (!rec) writes.push(w);
        break;
      case 'row.count':
        // The count fix's compare-and-swap (v2 E5 hotfix), likewise of a first run only.
        if (!rec) writes.push(w);
        break;
      case 'row.orphan':
        // v2 E6 (ADR 0048): the "no row for this event" compare-and-swap, likewise of a first run only.
        if (!rec) writes.push(w);
        break;
      case 'event.assert':
        // v3 F2.1: the chosen event's compare-and-swap (a link), likewise of a first run only.
        if (!rec) writes.push(w);
        break;
      case 'row.insert': {
        const r = rowOf(w.documentId, w.rowId);
        if (!r) writes.push(w);
        // v2 E4 (RV4-5): the row this change inserted is there, but no longer as it was written (edited since in the
        // app): finishing the change would pair an event and a count with a row that now says something else.
        else if ('texts' in w && w.texts && !same(r, w.texts))
          return {
            ok: false,
            result: refuse(
              pd,
              'CHRONOLOGY_RESUME_CONFLICT',
              `The row ${w.rowId} of ${w.age} that this change inserted has been edited since it stopped; it was not finished. The owner checks it and marks the change resolved.`,
            ),
          };
        break;
      }
      case 'row.delete':
        if (rowOf(w.documentId, w.rowId)) writes.push(w);
        break;
      case 'row.replace': {
        const r = rowOf(w.documentId, w.rowId);
        if (!r)
          return {
            ok: false,
            result: refuse(
              pd,
              'CHRONOLOGY_RESUME_CONFLICT',
              `The row ${w.rowId} of ${w.age} is gone; this change cannot be finished. The owner checks the table and marks the change resolved.`,
            ),
          };
        if (same(r, w.texts)) break;
        if (!same(r, w.before))
          return {
            ok: false,
            result: refuse(
              pd,
              'CHRONOLOGY_RESUME_CONFLICT',
              `The row ${w.rowId} of ${w.age} has changed since this change stopped; it was not finished. The owner checks it and marks the change resolved.`,
            ),
          };
        writes.push(w);
        break;
      }
      case 'event.create':
        if (!now.events.get(w.eventId)) writes.push(w);
        break;
      case 'event.delete':
        if (now.events.get(w.eventId)) writes.push(w);
        break;
      case 'event.update': {
        const e = now.events.get(w.eventId);
        if (!e)
          return {
            ok: false,
            result: refuse(
              pd,
              'CHRONOLOGY_RESUME_CONFLICT',
              `The event ${w.eventId} of ${w.age} is gone; this change cannot be finished.`,
            ),
          };
        const done = Object.entries(w.fields).every(
          ([k, v]) => JSON.stringify(e[k] ?? null) === JSON.stringify(v ?? null),
        );
        if (!done) writes.push(w);
        break;
      }
      case 'count': {
        const seen = rec?.observed.counts?.[w.rowId];
        const row = now.main.rows.find((r) => r.id === w.rowId);
        if (!seen) {
          writes.push(w);
          break;
        }
        if (row?.count === seen.after) break;
        if (row?.count === seen.before) {
          writes.push(w);
          expectBefore[w.rowId] = seen.before;
          break;
        }
        return {
          ok: false,
          result: refuse(
            pd,
            'CHRONOLOGY_RESUME_CONFLICT',
            `The ${w.age} count on the Main table is ${row?.countText ?? '(gone)'}: neither ${seen.before} (before this change) nor ${seen.after} (after it). It was not finished; the owner checks the count and marks the change resolved.`,
          ),
        };
      }
    }
  }
  return { ok: true, writes, expectBefore };
}

/** The context `buildJob` needs, from the documents as read. */
function writeContext(
  ch: Chrono,
  now: Now,
  rows: WriteContext['rows'],
  extra: { expectBefore?: Record<string, number>; moves?: Set<string> } = {},
): WriteContext {
  const tableIds: Record<string, string> = {};
  for (const [doc, t] of now.tables) tableIds[doc] = t.table.table.id ?? '';
  const counts: Record<string, { paragraphId: string; text: string; age: string }> = {};
  for (const r of now.main.rows) {
    if (r.id && r.countCell?.paragraphId)
      counts[r.id] = { paragraphId: r.countCell.paragraphId, text: r.countText, age: r.age };
  }
  const lanes: Record<string, { id: string; name: string }> = {};
  for (const a of ch.config.ages) lanes[a.timelineDocumentId] = { id: a.laneId, name: a.laneName };
  const events: Record<string, Obj> = {};
  for (const [id, e] of now.events) if (e) events[id] = e;
  return {
    tableIds,
    mainTableId: now.main.table.id ?? '',
    rows,
    counts,
    lanes,
    events,
    ...(extra.expectBefore ? { expectBefore: extra.expectBefore } : {}),
    ...(extra.moves ? { moves: extra.moves } : {}),
  };
}

/** The table rows around a place, as Markdown lines (for the proposal's diff). */
function excerpt(t: AgeTable, around: number, extra?: { at: number; line: string }): string[] {
  const lines = t.rows.map((r) => `| ${r.description} | ${r.dateText} | ${r.kcyText} |`);
  if (extra) lines.splice(extra.at, 0, extra.line);
  const from = Math.max(0, around - 2);
  return lines.slice(from, around + 3);
}

interface Submit {
  readonly tool: ChronologyTool;
  readonly ch: Chrono;
  readonly target: ChronologyTarget;
  readonly writes: readonly TargetWrite[];
  readonly ctx: WriteContext;
  readonly requestKey: string;
  readonly ages: readonly string[];
  readonly summary: string;
  readonly resumeOf?: number;
  readonly head: Obj;
  readonly markdown: { before: string; after: string };
  readonly dryRun: boolean | undefined;
  /** v3 F2.1: a proposal whatever the gate says (a link at scope `propose`: no LegendKeeper write to gate). */
  readonly forceProposal?: boolean;
  /** v3 F2.1: what a finished job answers instead of `written` (`linked`). */
  readonly writtenStatus?: string;
  /** v3 F3c (ADR 0051): the caller's Last Major Revision override. */
  readonly lastMajorRevision?: LmrMode | undefined;
}

async function submit(pd: ProjectDeps, mctx: McpToolContext, s: Submit): Promise<CreateOutcome> {
  const built = buildJob({
    tool: s.tool,
    config: s.ch.config,
    target: s.target,
    writes: s.writes,
    ctx: s.ctx,
    record: {
      requestKey: s.requestKey,
      ages: s.ages,
      summary: s.summary,
      ...(s.resumeOf !== undefined ? { resumeOf: s.resumeOf } : {}),
    },
  });
  const steps = built.labels.filter((l) => !['check', 'record', 'verify', 'record complete'].includes(l));
  if (s.dryRun === true) {
    return {
      kind: 'answer',
      result: render(
        {
          ...s.head,
          status: 'dry_run',
          steps,
          message: 'Dry run: nothing was written and nothing was proposed.',
        },
        pd,
      ),
    };
  }
  const page = { id: s.ch.resource.id, name: s.ch.resource.rawName };
  const out = await runWriteJob(pd, mctx, s.tool, {
    steps: built.steps,
    labels: built.labels,
    title: s.summary,
    holdDocuments: built.holdDocuments,
    proposal: {
      operation: {
        tool: s.tool,
        page,
        before: s.markdown.before,
        after: s.markdown.after,
        chronology: s.head,
      },
      operations: [{ tool: s.tool, page, pageParts: steps, summaryLabel: s.summary, chronology: s.head }],
      summary: s.summary,
    },
    head: { ...s.head, steps, ...(s.writtenStatus ? { writtenStatus: s.writtenStatus } : {}) },
    preview: () => ({ summary: s.summary }),
    ...(s.forceProposal === true ? { forceProposal: true } : {}),
    ...(s.lastMajorRevision ? { lastMajorRevision: s.lastMajorRevision } : {}),
  });
  return {
    kind: 'job',
    head: { ...s.head, steps, ...(s.writtenStatus ? { writtenStatus: s.writtenStatus } : {}) },
    labels: built.labels,
    ...out,
  };
}

// ============================================================================================ calendar_date

function calendarDateTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'calendar_date',
    title: 'Read or check a date in the chronology’s calendar',
    access: 'read',
    description:
      'Reads or converts a date with the same calendar engine the timeline tools use: give `date` (any accepted form), or `minutes` (LegendKeeper minutes, with `detail` 1 year, 2 month or 3 day, and `endMinutes` for a range), or `kcy`. Answers the age, the minutes, the KCY as the tables write it and the text in both styles (`formatted`, as LegendKeeper writes it; `tableFormatted`, as the tables do), or exactly why a date is refused (unknown month, impossible day, outside its era, reversed range). Use it to check a date before create_timeline_event, never to work one out yourself. Forms: "Kumikas 1st, 1A 159" (a day), "4A 881" (a year), "Unknown, 4A 101" (a year, day unknown), "Zahras 4A 367" (a month), "Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102" (a range), "Jehet 11th - 18th, 4A 424", "Kumikas - Azaakh, 4A 180", "4A 881 - 4A 900". "Unknown" alone is refused. Cost: none (1 read when the calendar is not cached).',
    inputSchema: z.object({
      date: z.string().min(1).max(300).optional().describe('A date in any accepted form.'),
      minutes: z.number().int().optional().describe('LegendKeeper minutes (an event’s start).'),
      endMinutes: z.number().int().optional().describe('With minutes: the end of a range.'),
      detail: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .optional()
        .describe('With minutes: 1 year, 2 month, 3 day (default 3).'),
      kcy: z.number().int().optional().describe('A continuous year (KCY): the era years it holds.'),
      calendar: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Another calendar (name or id) than the chronology’s.'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'read', async (pd) => {
        const given = [args.date !== undefined, args.minutes !== undefined, args.kcy !== undefined].filter(
          Boolean,
        ).length;
        if (given !== 1)
          return errorResult(
            { code: 'INVALID_PARAMS', message: 'Give exactly one of date, minutes or kcy.' },
            pd,
          );
        const ch = pd.services?.chronology;
        if (!ch)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'The calendar engine is not available.' },
            pd,
          );
        const config = ch.config(pd.project.id);
        let cal: Calendar | null = null;
        let source = 'cached';
        if (args.calendar === undefined && config.calendarId)
          cal = ch.calendar(pd.project.id, config.calendarId);
        if (!cal) {
          const r = await liveRead(pd, mctx, 'calendar_date', 'listCalendars', {});
          if (!r.ok) return r.result;
          const data = (r.value as { data?: unknown }).data;
          const list = Array.isArray(data) ? (data as Obj[]) : [];
          const want = args.calendar ?? config.calendarId;
          const hits = want
            ? list.filter(
                (c) => c.id === want || (typeof c.name === 'string' && nameKey(c.name) === nameKey(want)),
              )
            : list;
          if (hits.length !== 1)
            return errorResult(
              {
                code: hits.length === 0 ? 'CALENDAR_NOT_FOUND' : 'CALENDAR_AMBIGUOUS',
                message: want
                  ? `${hits.length === 0 ? 'No' : 'More than one'} calendar is named or numbered “${want}”.`
                  : 'The chronology is not confirmed and the project has several calendars: pass `calendar`.',
                calendars: list.map((c) => ({ id: c.id, name: c.name })),
              },
              pd,
            );
          try {
            cal = ch.remember(pd.project.id, hits[0]!);
          } catch (e) {
            return calendarError(pd, e);
          }
          source = 'read now';
        }
        const ageOf = (eraId: string) => {
          const a = config.confirmed ? config.ages.find((x) => x.eraId === eraId) : undefined;
          return a ? { age: a.name } : {};
        };
        const base = { calendar: { id: cal.engine.id, name: cal.engine.name, source } };
        try {
          if (args.kcy !== undefined) {
            const years = cal.engine.yearsOfKcy(args.kcy);
            return render(
              {
                ...base,
                kcy: args.kcy,
                kcyText: formatKcy({ start: args.kcy, end: null }, config.style.kcy),
                years: years.map((y) => ({
                  era: y.era.abbr,
                  eraName: y.era.name,
                  year: y.year,
                  ...ageOf(y.era.id),
                  tableFormatted: cal.parser.render('year', y.from, null, config.style.date),
                  text: cal.parser.render('year', y.from, null, config.style.date),
                  from: {
                    minutes: y.from,
                    formatted: cal.engine.format(y.from, 3),
                    tableFormatted: cal.engine.formatTable(y.from, 3, config.style.date),
                  },
                  to: {
                    minutes: y.to,
                    formatted: cal.engine.format(y.to, 3),
                    tableFormatted: cal.engine.formatTable(y.to, 3, config.style.date),
                  },
                })),
              },
              pd,
            );
          }
          let p: ParsedDate;
          if (args.minutes !== undefined) {
            const detail = args.detail ?? 3;
            const form = cal.parser.formFor(args.minutes, args.endMinutes ?? null, detail);
            p = cal.parser.result(form, args.minutes, args.endMinutes ?? null, '', config.style.date);
            p = { ...p, input: p.text };
          } else p = cal.parser.parse(args.date!, config.style.date);
          return render(
            {
              ...base,
              input: args.date ?? null,
              formatted: p.formatted,
              tableFormatted: p.tableFormatted,
              text: p.text,
              form: p.form,
              shape: p.shape,
              detail: p.detail,
              start: p.start,
              ...(p.end !== null ? { end: p.end } : {}),
              startDate: p.startDate,
              ...(p.endDate ? { endDate: p.endDate } : {}),
              formattedStart: p.formattedStart,
              ...(p.formattedEnd !== null ? { formattedEnd: p.formattedEnd } : {}),
              era: { abbr: p.era.abbr, name: p.era.name },
              ...ageOf(p.era.id),
              kcy: p.kcy,
              kcyText: formatKcy(p.kcy, config.style.kcy),
            },
            pd,
          );
        } catch (e) {
          return calendarError(pd, e);
        }
      }),
  });
}

// ============================================================================================ create

function createTimelineEventTool(deps: ToolDeps): McpToolProvider {
  const tool = 'create_timeline_event';
  return defineTool({
    name: tool,
    title: 'Add an event to the chronology',
    access: 'write',
    description:
      'Adds a chronology event as ONE job: a row in its age’s table (the authority) in calendar order, an event on that age’s timeline (linked to the table) and one more in the age’s count on the Main table. `date` gives the age; `name` is short (for the timeline); `description` is the full text (for the table). Check the date first with calendar_date (its forms are listed there). Never edit the chronology’s tables or timelines with write_page or lk_api_*: this tool keeps all three in step. An identical row is refused (DUPLICATE_EVENT); a job that stopped part-way finishes when you send the same request again. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 10 reads and 3 writes.',
    inputSchema: z.object({
      date: z.string().min(1).max(300),
      name: z.string().min(1).max(500).describe('The short name, for the timeline.'),
      description: descriptionArg,
      age: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('The age (its name or era abbreviation), to confirm the date’s.'),
      dryRun: z.boolean().optional().describe('Show the plan; write nothing.'),
      operation_id: operationIdArg,
      lastMajorRevision: lastMajorRevisionArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const c = chrono(pd);
        if (!c.ok) return c.result;
        const ch = c.value;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const fc = await freshCalendar(pd, mctx, tool, ch.config.calendarId!);
          if (!fc.ok) return { kind: 'answer', result: fc.result };
          const cal = fc.cal;
          let date: ParsedDate;
          try {
            date = cal.parser.parse(args.date, ch.config.style.date);
          } catch (e) {
            return { kind: 'answer', result: calendarError(pd, e) };
          }
          const age = ageOfDate(ch, cal, date);
          if (!age)
            return refuse(
              pd,
              'AGE_NOT_CONFIGURED',
              `${date.text} is in the ${date.era.name} (${date.era.abbr}), which has no confirmed table and timeline.`,
            );
          if (args.age !== undefined) {
            const named = ageByName(ch, cal, args.age);
            if (!named)
              return refuse(pd, 'AGE_NOT_FOUND', `No age of the chronology is named “${args.age}”.`, {
                ages: ch.config.ages.map((a) => a.name),
              });
            if (named.name !== age.name)
              return refuse(
                pd,
                'AGE_MISMATCH',
                `${date.text} is in ${age.name}, not ${named.name}. Nothing was done.`,
                { dateAge: age.name, givenAge: named.name },
              );
          }
          const desc = descriptionRuns(pd, ch, args.description);
          if (!desc.ok) return { kind: 'answer', result: desc.result };
          const name = args.name.trim();
          const requestKey = sha({
            tool,
            age: age.name,
            start: date.start,
            end: date.end,
            detail: date.detail,
            text: date.text,
            name,
            description: nameKey(desc.text),
          });
          const stopped = stoppedChange(pd, ch, requestKey, [age.name]);
          if (stopped.refusal) return stopped.refusal;
          const tr = await readTable(pd, mctx, tool, ch, cal, age);
          if (!tr.ok) return { kind: 'answer', result: tr.result };
          const mr = await readMain(pd, mctx, tool, ch);
          if (!mr.ok) return { kind: 'answer', result: mr.result };
          const t = tr.value.table;
          const mainRow = mr.value.rows.find((r) => r.id === age.mainRowId);
          if (!mainRow || mainRow.count === null || !mainRow.countCell?.paragraphId)
            return refuse(
              pd,
              'CHRONOLOGY_CHANGED',
              `The Main table's row of ${age.name} is gone or its count is not a number.`,
            );
          let target: ChronologyTarget;
          const resume = stopped.resume;
          if (resume) target = resume.target;
          else {
            const twin = t.rows.find(
              (r) => r.eventDate && sameDate(r.eventDate, date) && sameText(r.description, desc.text),
            );
            if (twin)
              return refuse(
                pd,
                'DUPLICATE_EVENT',
                `The ${age.name} table already has this event: “${twin.dateText}”, ${twin.description.slice(0, 120)}. Nothing was done.`,
                {
                  row: { id: twin.id, date: twin.dateText, description: twin.description },
                },
              );
            const width = t.table.header.cells.length;
            const ids = {
              row: mintClientId(8),
              cells: Array.from({ length: width }, () => mintClientId(8)),
              paragraphs: Array.from({ length: width }, () => mintClientId(8)),
            };
            const kcyText = formatKcy(date.kcy, ch.config.style.kcy);
            const block = buildRow({
              ids,
              width,
              columns: t.columns,
              descriptionRuns: desc.runs,
              dateText: date.text,
              kcyText,
            });
            const eventId = mintClientId(24);
            target = {
              writes: [
                {
                  kind: 'row.insert',
                  age: age.name,
                  resourceId: ch.resource.id,
                  documentId: age.tableDocumentId,
                  rowId: ids.row,
                  texts: { description: desc.text, date: date.text, kcy: kcyText },
                  block,
                },
                {
                  kind: 'event.create',
                  age: age.name,
                  resourceId: ch.resource.id,
                  documentId: age.timelineDocumentId,
                  eventId,
                  body: {
                    id: eventId,
                    laneId: age.laneId,
                    type: 'event',
                    name,
                    start: date.start,
                    ...(date.end !== null ? { end: date.end } : {}),
                    detail: date.detail,
                    uri: tableUri(ch.resource.id, age.tableDocumentId),
                  },
                },
                {
                  kind: 'count',
                  age: age.name,
                  resourceId: ch.resource.id,
                  documentId: ch.config.mainDocumentId!,
                  rowId: age.mainRowId,
                  delta: 1,
                },
              ],
              link: {
                age: age.name,
                tableDocumentId: age.tableDocumentId,
                rowId: ids.row,
                timelineDocumentId: age.timelineDocumentId,
                eventId,
                // v3 F2 (ADR 0049): a plain date: the bridge writes no tail in the name.
                nameTail: '',
              },
            };
          }
          const ins = target.writes.find((w) => w.kind === 'row.insert');
          const ev = target.writes.find((w) => w.kind === 'event.create');
          const events = new Map<string, Obj | null>();
          if (resume && ev) {
            const e = await readEvent(pd, mctx, tool, ch, ev.documentId, ev.eventId);
            if (!e.ok) return { kind: 'answer', result: e.result };
            events.set(ev.eventId, e.value);
          }
          const now: Now = { tables: new Map([[age.tableDocumentId, tr.value]]), main: mr.value, events };
          const left = remaining(pd, target, now, resume);
          if (!left.ok) return left.result;
          const anchor = anchorFor(t.rows, sortKey(date));
          const at = anchor ? anchor.index + 1 : 0;
          const head: Obj = {
            date: dateView(date, ch),
            age: age.name,
            name,
            description: desc.text,
            row: {
              ...(ins ? { id: ins.rowId } : {}),
              place: anchor
                ? { after: { date: anchor.dateText, description: anchor.description.slice(0, 120) } }
                : 'first',
            },
            event: {
              ...(ev ? { id: ev.eventId } : {}),
              lane: age.laneName,
              uri: tableUri(ch.resource.id, age.tableDocumentId),
            },
            count: {
              before: mainRow.countText,
              after: String(mainRow.count + 1),
              note: 'one more than the count when the job runs',
            },
            ...(resume ? { resumes: { recordId: resume.id, summary: resume.summary } } : {}),
          };
          if (left.writes.length === 0 && resume) {
            pd.services!.chronology!.store.complete(ch.ctx.projectId, resume.id, {
              completedBy: 'resume found nothing left',
            });
            if (resume.target.link) pd.services!.chronology!.store.link(ch.ctx.projectId, resume.target.link);
            return {
              kind: 'answer',
              result: render(
                {
                  ...head,
                  status: 'nothing_left',
                  message:
                    'Everything this change makes is already in place; its record is now complete. Nothing was written.',
                },
                pd,
              ),
            };
          }
          const rowLine = ins ? `| ${ins.texts.description} | ${ins.texts.date} | ${ins.texts.kcy} |` : '';
          const before = [
            `## ${age.name} - Table`,
            ...excerpt(t, at),
            '',
            '## Main',
            `| ${age.name} | ${mainRow.countText} |`,
          ].join('\n');
          const after = [
            `## ${age.name} - Table`,
            ...excerpt(t, at, ins ? { at, line: rowLine } : undefined),
            '',
            '## Main',
            `| ${age.name} | ${mainRow.count + 1} |`,
            '',
            `## ${age.name} - Timeline (${age.laneName})`,
            `- ${date.formattedStart}${date.formattedEnd ? ` – ${date.formattedEnd}` : ''}: **${name}**`,
          ].join('\n');
          return submit(pd, mctx, {
            lastMajorRevision: args.lastMajorRevision,
            tool,
            ch,
            target,
            writes: left.writes,
            ctx: writeContext(
              ch,
              now,
              ins
                ? {
                    [ins.rowId]: {
                      sortKey: sortKey(date),
                      date: { start: date.start, end: date.end, detail: date.detail },
                      description: desc.text,
                    },
                  }
                : {},
              {
                expectBefore: left.expectBefore,
              },
            ),
            requestKey,
            ages: [age.name],
            summary: `${tool}: ${date.text} “${name}” (${age.name})`,
            ...(resume ? { resumeOf: resume.id } : {}),
            head,
            markdown: { before, after },
            dryRun: args.dryRun,
          });
        });
      }),
  });
}

// ============================================================================================ which event

const eventRefArg = z
  .object({
    date: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Its date as the table shows it (any accepted form).'),
    description: z.string().min(1).max(20_000).optional().describe('Its row’s description (with date).'),
    name: z.string().min(1).max(500).optional().describe('Its timeline name (with date).'),
    row_id: z.string().min(1).max(64).optional().describe('Its table row’s block id.'),
    event_id: z.string().min(1).max(64).optional().describe('Its timeline event’s id.'),
    age: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Its age (name or era abbreviation), when no date is given.'),
  })
  .strict()
  .describe(
    'The chronology event: its date with its description or name, or its row id or event id (with its age when no date is given).',
  );

interface Found {
  readonly age: AgeConfig;
  readonly table: TableNow;
  readonly row: AgeRow;
  readonly event: TimelineEvent;
  readonly events: TimelineEvent[];
}

/** Finds a chronology event's row and timeline event, refusing when they have drifted apart. */
async function findEvent(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  ch: Chrono,
  cal: Calendar,
  ref: z.infer<typeof eventRefArg>,
): Promise<{ ok: true; value: Found } | { ok: false; result: McpToolResult }> {
  const store = pd.services!.chronology!.store;
  const bad = (code: string, message: string, more: Obj = {}) => ({
    ok: false as const,
    result: errorResult({ code, message, ...more }, pd),
  });
  let date: ParsedDate | null = null;
  if (ref.date !== undefined) {
    try {
      date = cal.parser.parse(ref.date, ch.config.style.date);
    } catch (e) {
      // v2 E6 (ADR 0048): a qualified Date cell, as the table shows it, is read by its anchor.
      const q = parseQualified(cal.parser, ref.date, ch.config.style.date);
      if (!q.ok) return { ok: false, result: calendarError(pd, e) };
      date = q.reading.date;
    }
  }
  let age: AgeConfig | null = null;
  if (ref.age !== undefined) {
    age = ageByName(ch, cal, ref.age);
    if (!age)
      return bad('AGE_NOT_FOUND', `No age of the chronology is named “${ref.age}”.`, {
        ages: ch.config.ages.map((a) => a.name),
      });
  }
  if (date) {
    const a = ageOfDate(ch, cal, date);
    if (!a) return bad('AGE_NOT_CONFIGURED', `${date.text} is in an age with no confirmed table.`);
    if (age && age.name !== a.name)
      return bad('AGE_MISMATCH', `${date.text} is in ${a.name}, not ${age.name}.`);
    age = a;
  }
  if (!age) {
    const link = store
      .links(ch.ctx.projectId)
      .find(
        (l) =>
          (ref.row_id !== undefined && l.rowId === ref.row_id) ||
          (ref.event_id !== undefined && l.eventId === ref.event_id),
      );
    age = link ? (ch.config.ages.find((a) => a.tableDocumentId === link.tableDocumentId) ?? null) : null;
  }
  if (!age) return bad('INVALID_PARAMS', 'Name the event’s date, or its age with its row_id or event_id.');
  if (
    ref.row_id === undefined &&
    ref.event_id === undefined &&
    (!date || (ref.description === undefined && ref.name === undefined))
  )
    return bad(
      'INVALID_PARAMS',
      'Name the event by its date with its description or name, or by its row_id or event_id.',
    );
  const tr = await readTable(pd, mctx, tool, ch, cal, age);
  if (!tr.ok) return tr;
  const er = await readEventsOf(pd, mctx, tool, ch, age);
  if (!er.ok) return er;
  const rows = tr.value.table.rows;
  const events = er.value;
  const marks = currentTableOnly(rows, store.tableOnly(ch.ctx.projectId, age.tableDocumentId));
  const paired = matchRowsAndEvents(rows, events, store.links(ch.ctx.projectId, age.tableDocumentId), age, {
    tableOnly: marks.current,
    kcyOf: (m) => cal.engine.kcyOf(m),
  });
  const pairs = paired.pairs;
  let row: AgeRow | null = null;
  let event: TimelineEvent | null = null;
  if (ref.row_id !== undefined) {
    row = rows.find((r) => r.id === ref.row_id) ?? null;
    if (!row) return bad('EVENT_NOT_FOUND', `The ${age.name} table has no row ${ref.row_id}.`);
  }
  if (ref.event_id !== undefined) {
    event = events.find((e) => e.id === ref.event_id) ?? null;
    if (!event) return bad('EVENT_NOT_FOUND', `The ${age.name} timeline has no event ${ref.event_id}.`);
  }
  if (!row && !event && date) {
    const hits = rows.filter(
      (r) =>
        r.eventDate &&
        sameDate(r.eventDate, date) &&
        ((ref.description !== undefined && sameText(r.description, ref.description)) ||
          (ref.name !== undefined && pairs.some((p) => p.row === r && sameText(p.event.name, ref.name!)))),
    );
    const evHits =
      hits.length === 0 && ref.name !== undefined
        ? events.filter(
            (e) =>
              sameDate({ start: e.start, end: e.end, detail: e.detail as 1 | 2 | 3 }, date) &&
              sameText(e.name, ref.name!),
          )
        : [];
    if (hits.length > 1)
      return bad('EVENT_AMBIGUOUS', `${hits.length} rows of ${age.name} match; pass row_id.`, {
        rows: hits.map((r) => ({ id: r.id, date: r.dateText, description: r.description.slice(0, 120) })),
      });
    if (hits.length === 1) row = hits[0]!;
    else if (evHits.length === 1) event = evHits[0]!;
    else if (evHits.length > 1)
      return bad('EVENT_AMBIGUOUS', `${evHits.length} events of ${age.name} match; pass event_id.`);
    else return bad('EVENT_NOT_FOUND', `No event of ${age.name} on ${date.text} matches.`);
  }
  const drift = (message: string, more: Obj = {}) =>
    bad(
      'CHRONOLOGY_DRIFT',
      `${message} The table and the timeline have drifted apart here; nothing was done. The chronology check reports it; ` +
        'sync_timeline_event repairs it, with the table as the authority.',
      more,
    );
  if (row) {
    const p = pairs.find((x) => x.row === row);
    const m = paired.mismatches.find((x) => x.row === row);
    if (!p && m)
      return drift(
        `The row says “${row.dateText}” but its event is at ${m.event.formattedStart ?? m.event.start}.`,
        { rowId: row.id, eventId: m.event.id },
      );
    if (!p)
      return drift(
        `The row “${row.dateText}” (${row.description.slice(0, 80)}) has no matching timeline event.`,
        { rowId: row.id },
      );
    if (event && p.event !== event)
      return drift(`The row ${row.id} and the event ${event.id} are not the same chronology event.`);
    event = p.event;
  } else if (event) {
    const p = pairs.find((x) => x.event === event);
    const m = paired.mismatches.find((x) => x.event === event);
    if (!p && m)
      return drift(
        `The row “${m.row.dateText}” says one date but the event is at ${event.formattedStart ?? event.start}.`,
        { rowId: m.row.id, eventId: event.id },
      );
    if (!p)
      return drift(`The event “${event.name.slice(0, 80)}” has no matching table row.`, {
        eventId: event.id,
      });
    row = p.row;
  }
  if (!row || !event) return bad('EVENT_NOT_FOUND', 'The event was not found.');
  if (
    !row.eventDate ||
    !sameDate(row.eventDate, { start: event.start, end: event.end, detail: event.detail as 1 | 2 | 3 })
  )
    return drift(
      `The row says “${row.dateText}” but the event is at ${event.formattedStart ?? event.start}.`,
      { rowId: row.id, eventId: event.id },
    );
  return { ok: true, value: { age, table: tr.value, row, event, events } };
}

// ============================================================================================ update

function updateTimelineEventTool(deps: ToolDeps): McpToolProvider {
  const tool = 'update_timeline_event';
  return defineTool({
    name: tool,
    title: 'Change an event of the chronology',
    access: 'write',
    description:
      'Changes a chronology event’s `date`, `name` (timeline) or `description` (table) as ONE job, keeping its table row, timeline event and the Main counts in step; a date in another age moves it there. Name it with `event`: its date plus its description or name, or its row_id or event_id. Refused when its row and event have drifted apart (CHRONOLOGY_DRIFT): repair that with sync_timeline_event. A job that stopped part-way finishes on the same request. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 9 reads and 3 writes (into another age 18 and 6).',
    inputSchema: z.object({
      event: eventRefArg,
      date: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe('The new date. ' + DATE_HELP),
      name: z.string().min(1).max(500).optional().describe('The new short name (timeline).'),
      description: descriptionArg.optional(),
      dryRun: z.boolean().optional(),
      operation_id: operationIdArg,
      lastMajorRevision: lastMajorRevisionArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const c = chrono(pd);
        if (!c.ok) return c.result;
        const ch = c.value;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          if (args.date === undefined && args.name === undefined && args.description === undefined)
            return refuse(pd, 'INVALID_PARAMS', 'Give a new date, name or description.');
          const fc = await freshCalendar(pd, mctx, tool, ch.config.calendarId!);
          if (!fc.ok) return { kind: 'answer', result: fc.result };
          const cal = fc.cal;
          const requestKey = sha({
            tool,
            event: args.event,
            date: args.date ?? null,
            name: args.name ?? null,
            description: args.description ?? null,
          });
          const store = pd.services!.chronology!.store;
          const resume = store.incomplete(ch.ctx.projectId).find((r) => r.requestKey === requestKey) ?? null;
          if (resume)
            return resumeChange(pd, mctx, tool, ch, cal, resume, args.dryRun, args.lastMajorRevision);
          const f = await findEvent(pd, mctx, tool, ch, cal, args.event);
          if (!f.ok) return { kind: 'answer', result: f.result };
          const { age, row, event, table } = f.value;
          // A qualified row keeps its own Date cell unless a new date is given (ADR 0048: never rewritten).
          let newDate: ParsedDate = row.date ?? row.eventDate!;
          if (args.date !== undefined) {
            try {
              newDate = cal.parser.parse(args.date, ch.config.style.date);
            } catch (e) {
              return { kind: 'answer', result: calendarError(pd, e) };
            }
          }
          const newAge = ageOfDate(ch, cal, newDate);
          if (!newAge)
            return refuse(
              pd,
              'AGE_NOT_CONFIGURED',
              `${newDate.text} is in an age with no confirmed table and timeline.`,
            );
          let desc = { runs: row.descriptionRuns as Obj[], text: row.description };
          if (args.description !== undefined) {
            const d = descriptionRuns(pd, ch, args.description);
            if (!d.ok) return { kind: 'answer', result: d.result };
            desc = { runs: d.runs, text: d.text };
          }
          const name = args.name?.trim() ?? event.name;
          const dateChanged =
            args.date !== undefined &&
            !(sameDate(newDate, row.eventDate!) && newDate.text === row.dateText.trim());
          const descChanged = args.description !== undefined && !sameText(desc.text, row.description);
          const nameChanged = name !== event.name;
          if (!dateChanged && !descChanged && !nameChanged)
            return refuse(
              pd,
              'NOTHING_TO_DO',
              'The event already has this date, name and description; nothing was proposed.',
            );
          const ages = newAge.name === age.name ? [age.name] : [age.name, newAge.name];
          const stopped = stoppedChange(pd, ch, requestKey, ages);
          if (stopped.refusal) return stopped.refusal;
          const mr = await readMain(pd, mctx, tool, ch);
          if (!mr.ok) return { kind: 'answer', result: mr.result };
          const tables = new Map<string, TableNow>([[age.tableDocumentId, table]]);
          let newTable = table;
          if (newAge.name !== age.name) {
            const tr = await readTable(pd, mctx, tool, ch, cal, newAge);
            if (!tr.ok) return { kind: 'answer', result: tr.result };
            newTable = tr.value;
            tables.set(newAge.tableDocumentId, newTable);
          }
          const twin = newTable.table.rows.find(
            (r) =>
              r.id !== row.id && r.date && sameDate(r.date, newDate) && sameText(r.description, desc.text),
          );
          if (twin)
            return refuse(
              pd,
              'DUPLICATE_EVENT',
              `The ${newAge.name} table already has “${twin.dateText}”, ${twin.description.slice(0, 120)}. Nothing was done.`,
            );
          const kcyText = formatKcy(newDate.kcy, ch.config.style.kcy);
          const texts = {
            description: desc.text,
            // The cell as it stands unless the date changes (it is only written then).
            date: dateChanged ? newDate.text : row.dateText,
            kcy: dateChanged ? kcyText : row.kcyText,
          };
          const before = { description: row.description, date: row.dateText, kcy: row.kcyText };
          const rid = ch.resource.id;
          const writes: TargetWrite[] = [];
          let link: ChronologyTarget['link'];
          let unlink: ChronologyTarget['unlink'] = null;
          const rowsCtx: Record<string, WriteContext['rows'][string]> = {};
          const moves = new Set<string>();
          // v2 E4 (RV3-5): an event made again (an end taken away, a move to another age) keeps everything else it had
          // (its colour, icon, image, hidden and calendar flags…): the writable fields of the old event, in their write
          // form, then the changes.
          const kept = keptEventFields(event.raw);
          const eventBody = (id: string, a: AgeConfig) => ({
            ...kept,
            id,
            laneId: a.laneId,
            type: 'event',
            name,
            start: newDate.start,
            ...(newDate.end !== null ? { end: newDate.end } : {}),
            detail: newDate.detail,
            uri: tableUri(rid, a.tableDocumentId),
          });
          if (newAge.name === age.name) {
            const block = replaceCells(
              row.row.block,
              table.table.columns,
              {
                ...(descChanged ? { descriptionRuns: desc.runs } : {}),
                ...(dateChanged ? { date: newDate.text, kcy: kcyText } : {}),
              },
              () => mintClientId(8),
            );
            if (dateChanged || descChanged) {
              writes.push({
                kind: 'row.replace',
                age: age.name,
                resourceId: rid,
                documentId: age.tableDocumentId,
                rowId: row.id!,
                before,
                texts,
                block,
              });
              rowsCtx[row.id!] = {
                sortKey: sortKey(newDate),
                date: { start: newDate.start, end: newDate.end, detail: newDate.detail },
                description: desc.text,
              };
              if (dateChanged) moves.add(row.id!);
            }
            if (dateChanged && event.end !== null && newDate.end === null) {
              // LegendKeeper cannot take an end away: the event is made again (same lane, link and name).
              const id = mintClientId(24);
              writes.push({
                kind: 'event.delete',
                age: age.name,
                resourceId: rid,
                documentId: age.timelineDocumentId,
                eventId: event.id,
              });
              writes.push({
                kind: 'event.create',
                age: age.name,
                resourceId: rid,
                documentId: age.timelineDocumentId,
                eventId: id,
                body: eventBody(id, age),
              });
              link = {
                age: age.name,
                tableDocumentId: age.tableDocumentId,
                rowId: row.id!,
                timelineDocumentId: age.timelineDocumentId,
                eventId: id,
              };
            } else if (dateChanged || nameChanged) {
              const fields: Obj = {
                ...(nameChanged ? { name } : {}),
                ...(dateChanged
                  ? {
                      start: newDate.start,
                      ...(newDate.end !== null ? { end: newDate.end } : {}),
                      detail: newDate.detail,
                    }
                  : {}),
              };
              writes.push({
                kind: 'event.update',
                age: age.name,
                resourceId: rid,
                documentId: age.timelineDocumentId,
                eventId: event.id,
                fields,
              });
              link = {
                age: age.name,
                tableDocumentId: age.tableDocumentId,
                rowId: row.id!,
                timelineDocumentId: age.timelineDocumentId,
                eventId: event.id,
              };
            } else
              link = {
                age: age.name,
                tableDocumentId: age.tableDocumentId,
                rowId: row.id!,
                timelineDocumentId: age.timelineDocumentId,
                eventId: event.id,
              };
          } else {
            // Another age: the row moves to that table, the event to that timeline, and both counts change.
            const width = newTable.table.table.header.cells.length;
            const ids = {
              row: mintClientId(8),
              cells: Array.from({ length: width }, () => mintClientId(8)),
              paragraphs: Array.from({ length: width }, () => mintClientId(8)),
            };
            const block = buildRow({
              ids,
              width,
              columns: newTable.table.columns,
              descriptionRuns: desc.runs,
              dateText: newDate.text,
              kcyText,
            });
            const id = mintClientId(24);
            writes.push({
              kind: 'row.insert',
              age: newAge.name,
              resourceId: rid,
              documentId: newAge.tableDocumentId,
              rowId: ids.row,
              texts: { ...texts, kcy: kcyText },
              block,
            });
            writes.push({
              kind: 'row.delete',
              age: age.name,
              resourceId: rid,
              documentId: age.tableDocumentId,
              rowId: row.id!,
              texts: before,
            });
            writes.push({
              kind: 'event.create',
              age: newAge.name,
              resourceId: rid,
              documentId: newAge.timelineDocumentId,
              eventId: id,
              body: eventBody(id, newAge),
            });
            writes.push({
              kind: 'event.delete',
              age: age.name,
              resourceId: rid,
              documentId: age.timelineDocumentId,
              eventId: event.id,
            });
            writes.push({
              kind: 'count',
              age: newAge.name,
              resourceId: rid,
              documentId: ch.config.mainDocumentId!,
              rowId: newAge.mainRowId,
              delta: 1,
            });
            writes.push({
              kind: 'count',
              age: age.name,
              resourceId: rid,
              documentId: ch.config.mainDocumentId!,
              rowId: age.mainRowId,
              delta: -1,
            });
            rowsCtx[ids.row] = {
              sortKey: sortKey(newDate),
              date: { start: newDate.start, end: newDate.end, detail: newDate.detail },
              description: desc.text,
            };
            link = {
              age: newAge.name,
              tableDocumentId: newAge.tableDocumentId,
              rowId: ids.row,
              timelineDocumentId: newAge.timelineDocumentId,
              eventId: id,
            };
            unlink = { tableDocumentId: age.tableDocumentId, rowId: row.id! };
          }
          const target: ChronologyTarget = { writes, link, unlink };
          const now: Now = { tables, main: mr.value, events: new Map([[event.id, event.raw]]) };
          const counts = Object.fromEntries(mr.value.rows.map((r) => [r.age, r.countText]));
          const head: Obj = {
            event: {
              rowId: row.id,
              eventId: event.id,
              age: age.name,
              date: row.dateText,
              name: event.name,
              description: row.description.slice(0, 200),
            },
            changes: {
              ...(dateChanged ? { date: { from: row.dateText, to: dateView(newDate, ch) } } : {}),
              ...(nameChanged ? { name: { from: event.name, to: name } } : {}),
              ...(descChanged
                ? { description: { from: row.description.slice(0, 200), to: desc.text.slice(0, 200) } }
                : {}),
              ...(newAge.name !== age.name ? { age: { from: age.name, to: newAge.name } } : {}),
            },
          };
          const line = (t: { description: string; date: string; kcy: string }) =>
            `| ${t.description} | ${t.date} | ${t.kcy} |`;
          const md = {
            before: [
              `## ${age.name} - Table`,
              line(before),
              `- ${event.formattedStart ?? event.start}: **${event.name}**`,
              ...(newAge.name !== age.name
                ? [
                    '',
                    '## Main',
                    `| ${age.name} | ${counts[age.name] ?? ''} |`,
                    `| ${newAge.name} | ${counts[newAge.name] ?? ''} |`,
                  ]
                : []),
            ].join('\n'),
            after: [
              `## ${newAge.name} - Table`,
              line({ ...texts, kcy: dateChanged ? kcyText : texts.kcy }),
              `- ${newDate.formattedStart}${newDate.formattedEnd ? ` – ${newDate.formattedEnd}` : ''}: **${name}**`,
              ...(newAge.name !== age.name
                ? [
                    '',
                    '## Main',
                    `| ${age.name} | ${String((parseInt((counts[age.name] ?? '0').replace(/,/g, ''), 10) || 0) - 1)} |`,
                    `| ${newAge.name} | ${String((parseInt((counts[newAge.name] ?? '0').replace(/,/g, ''), 10) || 0) + 1)} |`,
                  ]
                : []),
            ].join('\n'),
          };
          return submit(pd, mctx, {
            lastMajorRevision: args.lastMajorRevision,
            tool,
            ch,
            target,
            writes,
            ctx: writeContext(ch, now, rowsCtx, { moves }),
            requestKey,
            ages,
            summary: `${tool}: ${row.dateText} “${event.name}” (${age.name})${dateChanged ? ` → ${newDate.text}${newAge.name !== age.name ? ` (${newAge.name})` : ''}` : ''}`,
            head,
            markdown: md,
            dryRun: args.dryRun,
          });
        });
      }),
  });
}

// ============================================================================================ delete

function deleteTimelineEventTool(deps: ToolDeps): McpToolProvider {
  const tool = 'delete_timeline_event';
  return defineTool({
    name: tool,
    title: 'Delete an event of the chronology',
    access: 'write',
    description:
      'Deletes a chronology event as ONE job: its table row, its timeline event and one from the age’s count. `confirm: true` is required. Name it with `event` as update_timeline_event does. Refused when its row and event have drifted apart: sync_timeline_event first. With `orphan: true` and `event.event_id`, it deletes ONLY a timeline event that has no table row (the check’s event_without_row): no row, no count change; refused if a row could be its own. The journal keeps the row and the event. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 12 reads and 3 writes (orphan: about 5 reads and 1 write).',
    inputSchema: z.object({
      event: eventRefArg,
      orphan: z
        .boolean()
        .optional()
        .describe(
          'true: delete only this timeline event (event.event_id), which has no table row. No row is deleted and the count does not change.',
        ),
      confirm: z.literal(true).describe('Required: true.'),
      dryRun: z.boolean().optional(),
      operation_id: operationIdArg,
      lastMajorRevision: lastMajorRevisionArg,
      project: projectArg,
    }),
    annotations: { ...CHANGE_ANNOTATIONS, destructiveHint: true },
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const c = chrono(pd);
        if (!c.ok) return c.result;
        const ch = c.value;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const fc = await freshCalendar(pd, mctx, tool, ch.config.calendarId!);
          if (!fc.ok) return { kind: 'answer', result: fc.result };
          const cal = fc.cal;
          if (args.orphan === true)
            return deleteOrphan(pd, mctx, ch, cal, args.event, args.dryRun, args.lastMajorRevision);
          const requestKey = sha({ tool, event: args.event });
          const store = pd.services!.chronology!.store;
          const resume = store.incomplete(ch.ctx.projectId).find((r) => r.requestKey === requestKey) ?? null;
          if (resume)
            return resumeChange(pd, mctx, tool, ch, cal, resume, args.dryRun, args.lastMajorRevision);
          const f = await findEvent(pd, mctx, tool, ch, cal, args.event);
          if (!f.ok) return { kind: 'answer', result: f.result };
          const { age, row, event, table } = f.value;
          const stopped = stoppedChange(pd, ch, requestKey, [age.name]);
          if (stopped.refusal) return stopped.refusal;
          const mr = await readMain(pd, mctx, tool, ch);
          if (!mr.ok) return { kind: 'answer', result: mr.result };
          const rid = ch.resource.id;
          const texts = { description: row.description, date: row.dateText, kcy: row.kcyText };
          const target: ChronologyTarget = {
            writes: [
              {
                kind: 'row.delete',
                age: age.name,
                resourceId: rid,
                documentId: age.tableDocumentId,
                rowId: row.id!,
                texts,
              },
              {
                kind: 'event.delete',
                age: age.name,
                resourceId: rid,
                documentId: age.timelineDocumentId,
                eventId: event.id,
              },
              {
                kind: 'count',
                age: age.name,
                resourceId: rid,
                documentId: ch.config.mainDocumentId!,
                rowId: age.mainRowId,
                delta: -1,
              },
            ],
            unlink: { tableDocumentId: age.tableDocumentId, rowId: row.id! },
          };
          const mainRow = mr.value.rows.find((r) => r.id === age.mainRowId);
          const now: Now = {
            tables: new Map([[age.tableDocumentId, table]]),
            main: mr.value,
            events: new Map([[event.id, event.raw]]),
          };
          const head: Obj = {
            event: {
              rowId: row.id,
              eventId: event.id,
              age: age.name,
              date: row.dateText,
              name: event.name,
              description: row.description.slice(0, 200),
            },
            count: {
              before: mainRow?.countText ?? null,
              after:
                mainRow?.count !== null && mainRow?.count !== undefined ? String(mainRow.count - 1) : null,
            },
          };
          return submit(pd, mctx, {
            lastMajorRevision: args.lastMajorRevision,
            tool,
            ch,
            target,
            writes: target.writes,
            ctx: writeContext(ch, now, {}),
            requestKey,
            ages: [age.name],
            summary: `${tool}: ${row.dateText} “${event.name}” (${age.name})`,
            head,
            markdown: {
              before: [
                `## ${age.name} - Table`,
                `| ${texts.description} | ${texts.date} | ${texts.kcy} |`,
                '',
                `## ${age.name} - Timeline`,
                `- ${event.formattedStart ?? event.start}: **${event.name}**`,
                '',
                '## Main',
                `| ${age.name} | ${mainRow?.countText ?? ''} |`,
              ].join('\n'),
              after: [
                `## ${age.name} - Table`,
                '',
                `## ${age.name} - Timeline`,
                '',
                '## Main',
                `| ${age.name} | ${mainRow?.count !== null && mainRow?.count !== undefined ? mainRow.count - 1 : ''} |`,
              ].join('\n'),
            },
            dryRun: args.dryRun,
          });
        });
      }),
  });
}

/**
 * v2 E6 (ADR 0048): `delete_timeline_event` with `orphan: true`: ONE timeline event that has no table row, deleted
 * (src/chronology/orphan.ts). Only the event: no row, no count change. Refused when the event is paired with a row
 * after all, or an unpaired row could be its own.
 */
async function deleteOrphan(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ch: Chrono,
  cal: Calendar,
  ref: z.infer<typeof eventRefArg>,
  dryRun: boolean | undefined,
  lastMajorRevision?: LmrMode,
): Promise<CreateOutcome> {
  const tool = ORPHAN_TOOL;
  if (ref.event_id === undefined || ref.row_id !== undefined)
    return refuse(
      pd,
      'INVALID_PARAMS',
      'With orphan: true, name the timeline event by its event_id (and its age if you know it); it has no row.',
    );
  const store = pd.services!.chronology!.store;
  const orphanRef = { eventId: ref.event_id, ...(ref.age !== undefined ? { age: ref.age } : {}) };
  const requestKey = orphanRequestKey(orphanRef);
  const resume = store.incomplete(ch.ctx.projectId).find((r) => r.requestKey === requestKey) ?? null;
  if (resume) return resumeChange(pd, mctx, tool, ch, cal, resume, dryRun, lastMajorRevision);
  let plan;
  try {
    plan = await planOrphanDelete({
      config: ch.config,
      calendar: cal,
      links: store.links(ch.ctx.projectId),
      tableOnly: store.tableOnly(ch.ctx.projectId),
      ref: orphanRef,
      read: async (op, params) => {
        const r = await liveRead(pd, mctx, tool, op, params);
        if (!r.ok) throw new ReadStopped(r.result);
        return r.value;
      },
    });
  } catch (e) {
    if (e instanceof ReadStopped) return { kind: 'answer', result: e.result };
    return { kind: 'answer', result: errorFromThrown(e, pd) };
  }
  if (!plan.ok) return refuse(pd, plan.code, plan.message, plan.details);
  const stopped = stoppedChange(pd, ch, requestKey, [plan.age.name]);
  if (stopped.refusal) return stopped.refusal;
  return submit(pd, mctx, {
    lastMajorRevision: lastMajorRevision,
    tool,
    ch,
    target: plan.target,
    writes: plan.writes,
    ctx: plan.ctx,
    requestKey,
    ages: [plan.age.name],
    summary: plan.summary,
    head: plan.head,
    markdown: plan.markdown,
    dryRun,
  });
}

/** An update or delete whose earlier job stopped part-way: only what is left, from the documents as they are now. */
async function resumeChange(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: ChronologyTool,
  ch: Chrono,
  cal: Calendar,
  rec: ChronologyRecord,
  dryRun: boolean | undefined,
  lastMajorRevision?: LmrMode,
): Promise<CreateOutcome> {
  const job = rec.jobId ? pd.engine.queries.getJob(ch.ctx.projectId, rec.jobId) : null;
  if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status))
    return refuse(
      pd,
      'CHRONOLOGY_IN_PROGRESS',
      `This change is still running (job ${job.id}); nothing was done.`,
      { jobId: job.id },
    );
  const tables = new Map<string, TableNow>();
  for (const w of rec.target.writes) {
    if (!w.kind.startsWith('row.') || tables.has(w.documentId)) continue;
    const age = ch.config.ages.find((a) => a.tableDocumentId === w.documentId);
    if (!age)
      return refuse(
        pd,
        'CHRONOLOGY_CHANGED',
        `The table ${w.documentId} is no longer one of the chronology's.`,
      );
    const tr = await readTable(pd, mctx, tool, ch, cal, age);
    if (!tr.ok) return { kind: 'answer', result: tr.result };
    tables.set(w.documentId, tr.value);
  }
  const mr = await readMain(pd, mctx, tool, ch);
  if (!mr.ok) return { kind: 'answer', result: mr.result };
  const events = new Map<string, Obj | null>();
  for (const w of rec.target.writes) {
    if (!w.kind.startsWith('event.') || events.has((w as { eventId: string }).eventId)) continue;
    const e = await readEvent(pd, mctx, tool, ch, w.documentId, (w as { eventId: string }).eventId);
    if (!e.ok) return { kind: 'answer', result: e.result };
    events.set((w as { eventId: string }).eventId, e.value);
  }
  const now: Now = { tables, main: mr.value, events };
  const left = remaining(pd, rec.target, now, rec);
  if (!left.ok) return left.result;
  const head: Obj = { resumes: { recordId: rec.id, summary: rec.summary } };
  if (left.writes.length === 0) {
    const store = pd.services!.chronology!.store;
    store.complete(ch.ctx.projectId, rec.id, { completedBy: 'resume found nothing left' });
    if (rec.target.unlink)
      store.unlink(ch.ctx.projectId, rec.target.unlink.tableDocumentId, rec.target.unlink.rowId);
    if (rec.target.link) store.link(ch.ctx.projectId, rec.target.link);
    return {
      kind: 'answer',
      result: render(
        {
          ...head,
          status: 'nothing_left',
          message:
            'Everything this change makes is already in place; its record is now complete. Nothing was written.',
        },
        pd,
      ),
    };
  }
  const rows: Record<
    string,
    {
      sortKey: ReturnType<typeof sortKey>;
      date: { start: number; end: number | null; detail: 1 | 2 | 3 };
      description: string;
    }
  > = {};
  const moves = new Set<string>();
  for (const w of left.writes) {
    if (w.kind !== 'row.insert' && w.kind !== 'row.replace') continue;
    try {
      const d = cal.parser.parse(w.texts.date, ch.config.style.date);
      rows[w.rowId] = {
        sortKey: sortKey(d),
        date: { start: d.start, end: d.end, detail: d.detail },
        description: w.texts.description,
      };
      if (w.kind === 'row.replace' && w.before.date !== w.texts.date) moves.add(w.rowId);
    } catch (e) {
      return { kind: 'answer', result: calendarError(pd, e) };
    }
  }
  return submit(pd, mctx, {
    lastMajorRevision: lastMajorRevision,
    tool,
    ch,
    target: rec.target,
    writes: left.writes,
    ctx: writeContext(ch, now, rows, { expectBefore: left.expectBefore, moves }),
    requestKey: rec.requestKey,
    ages: rec.ages,
    summary: `${rec.summary} (resumed)`,
    resumeOf: rec.id,
    head,
    markdown: { before: rec.summary, after: `${rec.summary} (what is left)` },
    dryRun,
  });
}

// ============================================================================================ sync

/** A read that failed, with the answer the tool gives for it. */
class ReadStopped extends Error {
  constructor(readonly result: McpToolResult) {
    super('read stopped');
  }
}

const syncRowArg = z
  .object({
    date: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('The row’s Date cell (any accepted form), with its description.'),
    description: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        'The row’s description, as the table shows it (with its date), or its opening words: a prefix of exactly one row of that date, at least 20 characters.',
      ),
    row_id: z.string().min(1).max(64).optional().describe('The row’s block id, instead of a date and text.'),
    age: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('The age (name or era abbreviation); with a row_id and no date, the table to look in.'),
  })
  .strict()
  .describe('The age table row: its date with its description, or its row_id.');

function syncTimelineEventTool(deps: ToolDeps): McpToolProvider {
  const tool = SYNC_TOOL;
  return defineTool({
    name: tool,
    title: 'Repair the timeline event of a chronology table row',
    access: 'write',
    description:
      'Repairs drift for ONE chronology table row, with the TABLE as the authority: creates the row’s missing timeline event, or corrects the paired event’s minutes, detail, shape and link to match. It never touches the table or the Main count, and renames an event only to keep a date tail the bridge wrote in step with the row’s Date cell. Name the row with `row` (its date plus its description or its opening words, at least 20 characters; or its row_id). Use it for what the chronology check reports (row_without_event, date_mismatch, event_in_tie) or CHRONOLOGY_DRIFT. A row whose event already agrees answers "nothing to do". If several events could be its pair it is refused (PAIRING_AMBIGUOUS) with every candidate’s name, date and id: pass `event_id` to pair it with one (an event that already agrees is then linked to the row, no LegendKeeper write: a link is a proposal at every scope), or `create_new: true` to make a new event instead. dryRun shows the plan. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 6 to 7 reads and 1 write (a link: no write).',
    inputSchema: z.object({
      row: syncRowArg,
      event_id: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          'Only to choose among the candidate events of a refused, ambiguous pairing (or an event in a tie). The choice is remembered: an event that already agrees is linked to the row.',
        ),
      create_new: z
        .boolean()
        .optional()
        .describe(
          '“None of these: make a new event”: creates the row’s event although candidates exist (the proposal names those passed over). Never with event_id.',
        ),
      name: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'The short name of an event that is created (default: the row’s description, cut short when long).',
        ),
      confirm_shape_change: z
        .boolean()
        .optional()
        .describe(
          'Required when the repair turns a range event into a single date or the reverse (the plan says “range → single day”): check with the person first.',
        ),
      dryRun: z.boolean().optional().describe('Show the plan; write nothing and propose nothing.'),
      operation_id: operationIdArg,
      lastMajorRevision: lastMajorRevisionArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const c = chrono(pd);
        if (!c.ok) return c.result;
        const ch = c.value;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const fc = await freshCalendar(pd, mctx, tool, ch.config.calendarId!);
          if (!fc.ok) return { kind: 'answer', result: fc.result };
          const cal = fc.cal;
          const ref: SyncRef = {
            ...(args.row.date !== undefined ? { date: args.row.date } : {}),
            ...(args.row.description !== undefined ? { description: args.row.description } : {}),
            ...(args.row.row_id !== undefined ? { rowId: args.row.row_id } : {}),
            ...(args.row.age !== undefined ? { age: args.row.age } : {}),
            ...(args.event_id !== undefined ? { eventId: args.event_id } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.create_new === true ? { createNew: true } : {}),
          };
          const requestKey = syncRequestKey(ref);
          const store = pd.services!.chronology!.store;
          const resume = store.incomplete(ch.ctx.projectId).find((r) => r.requestKey === requestKey) ?? null;
          if (resume)
            return resumeChange(pd, mctx, tool, ch, cal, resume, args.dryRun, args.lastMajorRevision);
          let plan;
          try {
            plan = await planSync({
              config: ch.config,
              calendar: cal,
              links: store.links(ch.ctx.projectId),
              tableOnly: store.tableOnly(ch.ctx.projectId),
              ref,
              read: async (op, params) => {
                const r = await liveRead(pd, mctx, tool, op, params);
                if (!r.ok) throw new ReadStopped(r.result);
                return r.value;
              },
            });
          } catch (e) {
            if (e instanceof ReadStopped) return { kind: 'answer', result: e.result };
            return { kind: 'answer', result: errorFromThrown(e, pd) };
          }
          if (!plan.ok) return refuse(pd, plan.code, plan.message, plan.details);
          if (plan.action === 'nothing')
            return {
              kind: 'answer',
              result: render(
                {
                  ...plan.head,
                  status: 'nothing_to_do',
                  message:
                    'The row and its timeline event already agree (minutes, detail, shape and link); nothing was written or proposed.',
                },
                pd,
              ),
            };
          // v2 E6 (ADR 0048): a range made a single date (or the reverse) only when the caller confirms it.
          if (plan.shapeChange && args.confirm_shape_change !== true && args.dryRun !== true)
            return refuse(
              pd,
              'SHAPE_CHANGE_UNCONFIRMED',
              `This repair changes the event “${plan.event?.name.slice(0, 80) ?? ''}”: ${plan.shapeChange} (the row says “${plan.row.dateText}”). Check with the person that the row and the event are the same chronology event, then repeat with confirm_shape_change: true. Nothing was done.`,
              { ...plan.head },
            );
          const stopped = stoppedChange(pd, ch, requestKey, [plan.age.name]);
          if (stopped.refusal) return stopped.refusal;
          return submit(pd, mctx, {
            lastMajorRevision: args.lastMajorRevision,
            tool,
            ch,
            target: plan.target,
            writes: plan.writes,
            ctx: plan.ctx,
            requestKey,
            ages: [plan.age.name],
            summary: plan.summary,
            head: plan.head,
            markdown: plan.markdown,
            dryRun: args.dryRun,
            // v3 F2.1: a link is a bridge-side record with no LegendKeeper write; it changes what the check pairs,
            // repairs and offers to delete, so it is a proposal, and done it answers `linked`. CR-2026-11-R2 (R2-08): at
            // every scope: at scope write its job holds only the bridge's own steps, which the Review page (ADR 0055
            // decision A) never lists, so a direct link was one change the owner never saw (ADR 0057 decision 3).
            ...(plan.action === 'link' ? { writtenStatus: 'linked', forceProposal: true } : {}),
          });
        });
      }),
  });
}

// ============================================================================================ lanes

function createTimelineLaneTool(deps: ToolDeps): McpToolProvider {
  const tool = 'create_timeline_lane';
  return defineTool({
    name: tool,
    title: 'Add a lane to a timeline',
    access: 'write',
    description:
      'Adds a lane to an ordinary timeline document; it touches only that timeline. The chronology’s age timelines have exactly one lane and refuse more (their events are create_timeline_event). A lane of the same name is refused. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: 2 reads and 1 write.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      document: z.string().min(1).max(500).describe('The timeline document (name or id).'),
      name: z.string().min(1).max(500),
      size: z.enum(['sm', 'lg']).optional().describe('The lane’s height (default sm).'),
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional()
        .describe('Every event’s colour in the lane, #RRGGBB.'),
      dryRun: z.boolean().optional(),
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const p = resolvePage(ctx, args.page);
          if (!p.ok) return { kind: 'answer', result: p.result };
          const node = p.node;
          const q = args.document.trim();
          const docs = node.documents.filter((d) => d.id === q || nameKey(d.name ?? '') === nameKey(q));
          if (docs.length !== 1)
            return refuse(
              pd,
              docs.length === 0 ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_AMBIGUOUS',
              `“${node.displayName}” has ${docs.length === 0 ? 'no' : 'several'} documents named or numbered “${q}”.`,
              {
                documents: node.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
              },
            );
          const doc = docs[0]!;
          if (doc.type !== 'time') return refuse(pd, 'NOT_A_TIMELINE', `“${doc.name}” is not a timeline.`);
          // The chronology's age timelines: confirmed ones, and by naming convention on the chronology resource.
          const ch = pd.services?.chronology;
          const cfg = ch?.config(ctx.projectId);
          const isAge =
            (cfg?.ages ?? []).some((a) => a.timelineDocumentId === doc.id) ||
            (cfg !== undefined &&
              (cfg.resourceId === node.id || nameKey(node.displayName) === nameKey(cfg.names.resource)) &&
              (doc.name ?? '').toLowerCase().endsWith(cfg.names.timelineSuffix.toLowerCase()));
          if (isAge)
            return refuse(
              pd,
              'CHRONOLOGY_TIMELINE',
              `“${doc.name}” is one of the chronology’s age timelines, which have exactly one lane by design; nothing was done. Lanes are for other timelines.`,
            );
          const lr = await liveRead(pd, mctx, tool, 'listLanes', {
            path: { resourceId: node.id, documentId: doc.id },
          });
          if (!lr.ok) return { kind: 'answer', result: lr.result };
          const lanes = (((lr.value ?? {}) as { data?: unknown }).data ?? []) as Obj[];
          const name = args.name.trim();
          if (lanes.some((l) => typeof l.name === 'string' && nameKey(l.name) === nameKey(name)))
            return refuse(pd, 'LANE_EXISTS', `“${doc.name}” already has a lane named “${name}”.`);
          const ranks = lanes.map((l) => (typeof l.rank === 'string' ? l.rank : '')).sort();
          const rank = `${ranks[ranks.length - 1] ?? 'a'}V`;
          const id = mintClientId(24);
          const body = {
            id,
            name,
            rank,
            size: args.size ?? 'sm',
            ...(args.color ? { style: { color: args.color } } : {}),
          };
          const page = { id: node.id, name: node.rawName };
          const head = {
            page,
            document: { id: doc.id, name: doc.name },
            lane: { id, name, size: body.size, after: lanes.length },
          };
          if (args.dryRun === true)
            return {
              kind: 'answer',
              result: render({ ...head, status: 'dry_run', message: 'Dry run: nothing was written.' }, pd),
            };
          const steps: StepSpec[] = [
            {
              op: 'createLane',
              params: { path: { resourceId: node.id, documentId: doc.id }, body },
              journalOperation: { tool, page },
            },
            {
              op: VERIFY_STEP,
              params: {
                body: {
                  targets: [
                    {
                      kind: 'lane',
                      label: `lane “${name}” of ${doc.name ?? doc.id}`,
                      resourceId: node.id,
                      documentId: doc.id,
                      laneId: id,
                      name,
                    },
                  ],
                },
              },
            },
          ];
          const summary = `${tool}: “${name}” on ${node.rawName} / ${doc.name ?? doc.id}`;
          const out = await runWriteJob(pd, mctx, tool, {
            steps,
            labels: [`add the lane “${name}”`, 'verify'],
            title: summary,
            proposal: {
              operations: [{ tool, page, pageParts: [`lane “${name}” added to ${doc.name ?? doc.id}`] }],
              summary,
            },
            head,
            preview: () => head,
          });
          return { kind: 'job', head, labels: [`add the lane “${name}”`, 'verify'], ...out };
        });
      }),
  });
}

export function timelineTools(deps: ToolDeps): McpToolProvider[] {
  return [
    calendarDateTool(deps),
    createTimelineEventTool(deps),
    updateTimelineEventTool(deps),
    deleteTimelineEventTool(deps),
    syncTimelineEventTool(deps),
    createTimelineLaneTool(deps),
  ];
}

export { uriPointsAt };
