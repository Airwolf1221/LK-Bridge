/**
 * The chronology check (v2 D1, PLAN-v2 4.9 and 4.12, ADR 0038): read-only, findings only, never a repair. Per age it reads
 * the table and the timeline's events (one request per 100 events), plus the Main table once, and reports:
 *
 * - table rows without an event, and events without a row (a row and an event are one chronology event when the bridge
 *   linked them, or when they have the same date and the event's name is the row's description, or its start cut short
 *   with an ellipsis);
 * - rows out of calendar order;
 * - wrong KCY values (and KCY or date cells written differently from the confirmed style);
 * - Main counts that differ from the table's row count;
 * - event `uri`s that do not point at their age's table;
 * - dates the engine cannot read.
 */
import { formatKcy, parseKcyCell, type Calendar } from '../calendar/index.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import type { CheckFinding, ChronologyLink } from './store.js';
import { outOfOrder, readAgeTable, readMainTable, sameDate, type AgeRow, type AgeTable } from './table.js';

type Obj = Record<string, unknown>;

export type CheckReader = (
  op: string,
  params: { path?: Record<string, string>; query?: Record<string, unknown> },
) => Promise<unknown>;

export interface TimelineEvent {
  readonly id: string;
  readonly laneId: string | null;
  readonly name: string;
  readonly start: number;
  readonly end: number | null;
  readonly detail: 1 | 2 | 3 | 4;
  readonly uri: string | null;
  readonly formattedStart: string | null;
  readonly formattedEnd: string | null;
  readonly type: string | null;
  readonly raw: Obj;
}

export function eventOf(e: Obj): TimelineEvent {
  const detail = typeof e.detail === 'number' ? e.detail : 3;
  return {
    id: String(e.id),
    laneId: typeof e.laneId === 'string' ? e.laneId : null,
    name: typeof e.name === 'string' ? e.name : '',
    start: typeof e.start === 'number' ? e.start : NaN,
    end: typeof e.end === 'number' && e.end !== e.start ? e.end : null,
    detail: (detail >= 1 && detail <= 4 ? detail : 3) as TimelineEvent['detail'],
    uri: typeof e.uri === 'string' && e.uri !== '' ? e.uri : null,
    formattedStart: typeof e.formattedStart === 'string' ? e.formattedStart : null,
    formattedEnd: typeof e.formattedEnd === 'string' ? e.formattedEnd : null,
    type: typeof e.type === 'string' ? e.type : null,
    raw: e,
  };
}

/** Every event of a timeline (listEvents, 100 a page). */
export async function readEvents(
  read: CheckReader,
  resourceId: string,
  documentId: string,
): Promise<TimelineEvent[]> {
  const out: TimelineEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = (await read('listEvents', {
      path: { resourceId, documentId },
      query: { limit: 100, ...(cursor ? { cursor } : {}) },
    })) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown } | undefined;
    for (const e of Array.isArray(r?.data) ? (r.data as Obj[]) : [])
      if (e && typeof e.id === 'string') out.push(eventOf(e));
    if (r?.hasMore !== true || typeof r.nextCursor !== 'string') break;
    cursor = r.nextCursor;
  }
  return out;
}

const normText = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** An event's name and a row's description name the same event: equal, or the name is the description cut short (… or ...). */
export function namesMatch(name: string, description: string): boolean {
  const n = normText(name);
  const d = normText(description);
  if (n === '' || d === '') return false;
  if (n === d) return true;
  const cut = n.replace(/(\.\.\.|…)$/, '').trim();
  return cut !== n && cut.length > 0 && d.startsWith(cut);
}

/** An event's `uri` points at a table document (either accepted form). */
export function uriPointsAt(uri: string | null, resourceId: string, documentId: string): boolean {
  return uri === `lk://resources/${resourceId}/docs/${documentId}` || uri === `lk://documents/${documentId}`;
}

export const tableUri = (resourceId: string, documentId: string) =>
  `lk://resources/${resourceId}/docs/${documentId}`;

/**
 * Pairs rows and events one to one: the bridge's own links first, then by date and text. What is left over is reported.
 */
export function pairRowsAndEvents(
  rows: readonly AgeRow[],
  events: readonly TimelineEvent[],
  links: readonly ChronologyLink[],
  age: AgeConfig,
): { pairs: { row: AgeRow; event: TimelineEvent }[]; rows: AgeRow[]; events: TimelineEvent[] } {
  const pairs: { row: AgeRow; event: TimelineEvent }[] = [];
  const freeRows = new Set(rows);
  const freeEvents = new Set(events);
  const byEvent = new Map(events.map((e) => [e.id, e]));
  for (const l of links) {
    if (l.tableDocumentId !== age.tableDocumentId || l.timelineDocumentId !== age.timelineDocumentId)
      continue;
    const row = rows.find((r) => r.id === l.rowId);
    const ev = byEvent.get(l.eventId);
    if (row && ev && freeRows.has(row) && freeEvents.has(ev)) {
      pairs.push({ row, event: ev });
      freeRows.delete(row);
      freeEvents.delete(ev);
    }
  }
  for (const row of [...freeRows]) {
    if (!row.date) continue;
    const hit = [...freeEvents].find(
      (e) =>
        sameDate({ start: e.start, end: e.end, detail: e.detail as 1 | 2 | 3 }, row.date!) &&
        namesMatch(e.name, row.description),
    );
    if (hit) {
      pairs.push({ row, event: hit });
      freeRows.delete(row);
      freeEvents.delete(hit);
    }
  }
  return { pairs, rows: [...freeRows], events: [...freeEvents] };
}

export interface CheckReport {
  readonly summary: string;
  readonly findings: CheckFinding[];
  readonly ages: Obj[];
}

const MAX_PER_KIND = 200;

export async function runCheck(o: {
  readonly projectId: string;
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly links: readonly ChronologyLink[];
}): Promise<CheckReport> {
  const c = o.config;
  const resourceId = c.resourceId!;
  const findings: CheckFinding[] = [];
  const perKind = new Map<string, number>();
  const add = (f: CheckFinding) => {
    const n = (perKind.get(`${f.age}:${f.kind}`) ?? 0) + 1;
    perKind.set(`${f.age}:${f.kind}`, n);
    if (n <= MAX_PER_KIND) findings.push(f);
  };
  const mainBlocks = (await o.read('getDocumentBlocks', {
    path: { resourceId, documentId: c.mainDocumentId! },
  })) as { blocks?: unknown[] } | undefined;
  const main = readMainTable(mainBlocks?.blocks ?? [], c.columns);
  if (!main) add({ kind: 'not_found', age: '(Main)', message: 'The Main document has no Main table.' });
  const ages: Obj[] = [];
  for (const age of c.ages) {
    const blocks = (await o.read('getDocumentBlocks', {
      path: { resourceId, documentId: age.tableDocumentId },
    })) as { blocks?: unknown[] } | undefined;
    const t: AgeTable | null = readAgeTable(blocks?.blocks ?? [], o.calendar.parser, c.style.date, c.columns);
    if (!t) {
      add({ kind: 'not_found', age: age.name, message: `The table of ${age.name} was not found.` });
      continue;
    }
    const events = (await readEvents(o.read, resourceId, age.timelineDocumentId)).filter(
      (e) => e.laneId === age.laneId,
    );
    // Dates the engine cannot read, and cells written differently from the confirmed style.
    for (const r of t.rows) {
      if (!r.date) {
        add({
          kind: 'unreadable_date',
          age: age.name,
          message: `“${r.dateText}” (row ${r.index + 1}, ${r.description.slice(0, 80)}): ${r.dateError?.message ?? 'cannot be read'}`,
          detail: { rowId: r.id, date: r.dateText, code: r.dateError?.code },
        });
        continue;
      }
      if (r.date.text !== r.dateText.trim()) {
        add({
          kind: 'date_text_differs',
          age: age.name,
          message: `“${r.dateText}” is written “${r.date.text}” by the engine (row ${r.index + 1}).`,
          detail: { rowId: r.id, cell: r.dateText, engine: r.date.text },
        });
      }
      const want = formatKcy(r.date.kcy, c.style.kcy);
      if (r.kcyText.trim() !== want) {
        const k = parseKcyCell(r.kcyText);
        const valueOk =
          k !== null &&
          k.start === r.date.kcy.start &&
          (k.end ?? k.start) === (r.date.kcy.end ?? r.date.kcy.start);
        add({
          kind: valueOk ? 'date_text_differs' : 'wrong_kcy',
          age: age.name,
          message: valueOk
            ? `KCY “${r.kcyText}” for “${r.dateText}” is right but written differently (the confirmed style writes “${want}”).`
            : `KCY “${r.kcyText}” for “${r.dateText}” should be ${want} (row ${r.index + 1}).`,
          detail: { rowId: r.id, cell: r.kcyText, engine: want, date: r.dateText },
        });
      }
    }
    for (const x of outOfOrder(t.rows)) {
      add({
        kind: 'row_out_of_order',
        age: age.name,
        message: `“${x.row.dateText}” (row ${x.row.index + 1}) comes after “${x.after.dateText}” (row ${x.after.index + 1}).`,
        detail: { rowId: x.row.id, after: x.after.id },
      });
    }
    const paired = pairRowsAndEvents(t.rows, events, o.links, age);
    for (const r of paired.rows)
      add({
        kind: 'row_without_event',
        age: age.name,
        message: `Row ${r.index + 1} (“${r.dateText}”, ${r.description.slice(0, 80)}) has no timeline event.`,
        detail: { rowId: r.id, date: r.dateText },
      });
    for (const e of paired.events)
      add({
        kind: 'event_without_row',
        age: age.name,
        message: `Event “${e.name.slice(0, 80)}” (${e.formattedStart ?? e.start}) has no table row.`,
        detail: { eventId: e.id, start: e.start },
      });
    for (const e of events)
      if (!uriPointsAt(e.uri, resourceId, age.tableDocumentId))
        add({
          kind: 'wrong_uri',
          age: age.name,
          message: `Event “${e.name.slice(0, 80)}” links to ${e.uri ?? 'nothing'}, not ${tableUri(resourceId, age.tableDocumentId)}.`,
          detail: { eventId: e.id, uri: e.uri },
        });
    const row = main?.rows.find((r) => r.id === age.mainRowId) ?? null;
    if (main && (!row || row.count !== t.rows.length))
      add({
        kind: 'count_mismatch',
        age: age.name,
        message: row
          ? `The Main table says ${row.countText}; the table has ${t.rows.length} rows (the timeline ${events.length} events).`
          : `The Main table has no row ${age.mainRowId} for ${age.name}.`,
        detail: { main: row?.countText ?? null, rows: t.rows.length, events: events.length },
      });
    ages.push({ age: age.name, rows: t.rows.length, events: events.length, count: row?.countText ?? null });
  }
  const summary =
    findings.length === 0
      ? `No findings: ${ages.map((a) => `${String(a.age)} ${String(a.rows)} rows`).join(', ')}.`
      : `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${[...new Set(findings.map((f) => f.kind))].join(', ')}.`;
  return { summary, findings, ages };
}
