/**
 * The chronology check (v2 D1, PLAN-v2 4.9 and 4.12, ADR 0038): read-only, findings only, never a repair. Per age it reads
 * the table and the timeline's events (one request per 100 events), plus the Main table once, and reports:
 *
 * - table rows without an event, and events without a row (a row and an event are one chronology event when the bridge
 *   linked them, or when they have the same date and the event's name is the row's description, or its start cut short
 *   with an ellipsis, or when they are the only two on that date: the timeline's short name differs from the table's
 *   description by design);
 * - a row and an event that are the same event but disagree about its date or shape (`date_mismatch`, its own kind:
 *   the table is the authority);
 * - rows out of calendar order;
 * - wrong KCY values (and KCY or date cells written differently from the confirmed style);
 * - Main counts that differ from the table's row count;
 * - event `uri`s that do not point at their age's table;
 * - dates the engine cannot read.
 */
import {
  describeReading,
  formatKcy,
  kcyWrittenAlike,
  parseKcyCell,
  readQualifiedKcy,
  type Calendar,
} from '../calendar/index.js';
import { QUALIFIED_NAME_SEPARATOR, renameFor, renameLine } from './names.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import { currentTableOnly, type CheckFinding, type ChronologyLink, type TableOnlyMark } from './store.js';
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

/** An event's date as LegendKeeper writes it (its own `formattedStart` and `formattedEnd`: LegendKeeper's style). */
export const eventText = (e: TimelineEvent): string =>
  `${e.formattedStart ?? String(e.start)}${e.end !== null ? ` - ${e.formattedEnd ?? String(e.end)}` : ''}`;

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

/**
 * An event's name and a row's description name the same event: equal, or the name is the description cut short (… or
 * ...). v2 E6 (ADR 0048): a qualified row's event carries the row's Date cell after its opening words
 * (`<opening words> – <Date cell>`); that tail is not part of the name's comparison.
 */
export function namesMatch(name: string, description: string): boolean {
  const d = normText(description);
  const full = normText(name);
  if (full === '' || d === '') return false;
  const names = [full];
  for (
    let at = full.indexOf(QUALIFIED_NAME_SEPARATOR);
    at > 0;
    at = full.indexOf(QUALIFIED_NAME_SEPARATOR, at + 1)
  )
    names.push(full.slice(0, at).trim());
  return names.some((n) => {
    if (n === d) return true;
    const cut = n.replace(/(\.\.\.|…)$/, '').trim();
    return cut !== n && cut.length > 0 && d.startsWith(cut);
  });
}

/** v2 E6 (ADR 0048): between a qualified row's event name and its Date cell (`<opening words> – <Date cell>`). */
export { QUALIFIED_NAME_SEPARATOR } from './names.js';

/** An event's `uri` points at a table document (either accepted form). */
export function uriPointsAt(uri: string | null, resourceId: string, documentId: string): boolean {
  return uri === `lk://resources/${resourceId}/docs/${documentId}` || uri === `lk://documents/${documentId}`;
}

export const tableUri = (resourceId: string, documentId: string) =>
  `lk://resources/${resourceId}/docs/${documentId}`;

/** How a row and an event were paired. */
export type PairHow =
  /** The bridge made both (`chronology_links`). */
  | 'link'
  /** The same date, and the event's name is the row's description (or its start cut short). */
  | 'date+name'
  /** The same date and no other row or event on it to confuse them: the two differ only in wording. */
  | 'date'
  /**
   * v3 F2.1: the same date and shape as a PLAIN row's date, while qualified rows are anchored there too: the plain row
   * is preferred over the qualified anchors (they are offered new events of their own).
   */
  | 'plain';

/** v3 F2.1: how each pair was made, in plain words (every answer, the check and the Chronology page show it). */
export const PAIRED_BY_WORDS: Readonly<Record<string, string>> = {
  link: 'linked by the bridge',
  'date+name': 'the same date and name',
  date: 'the same date',
  plain: 'plain row preferred over qualified anchor',
  'start+end': 'the same start and end',
  'start+year': 'the same start and final year',
  'start+shape': 'the same start and shape',
  name: 'the name',
  start: 'the same start',
  chosen: 'chosen by the caller',
};

export interface RowEventPair {
  readonly row: AgeRow;
  readonly event: TimelineEvent;
  readonly how: PairHow;
}

/** How a row and an event that disagree about the date were found to be the same chronology event. */
export type MismatchBy =
  /** The bridge linked them. */
  | 'link'
  /** The same start and the same end (both ranges); only the precision differs. */
  | 'start+end'
  /**
   * v3 F2.1: the same start, both ranges, and their ends in the same year (KCY): the Divan Heirage event against the
   * other ranges of the age that start the same day.
   */
  | 'start+year'
  /** The same start and a compatible shape (both ranges, or both single dates); the end or precision differs. */
  | 'start+shape'
  /** The event's name is the row's description (or its start cut short). */
  | 'name'
  /** The same start, one a range and the other a single date. */
  | 'start';

/**
 * A row and an event that are the same chronology event but disagree about its date or shape (the row says a range and
 * the event a single day, or another year), found by the scored pass of `matchRowsAndEvents`.
 */
export interface DateMismatch {
  readonly row: AgeRow;
  readonly event: TimelineEvent;
  readonly by: MismatchBy;
}

export interface Pairing {
  readonly pairs: RowEventPair[];
  /** Paired but disagreeing about the date (the table is the authority): their own finding, never "unpaired". */
  readonly mismatches: DateMismatch[];
  /** Rows and events left over, with no counterpart even by name or start (or with several: ambiguous). */
  readonly rows: AgeRow[];
  readonly events: TimelineEvent[];
  /** v2 E6 (ADR 0048): rows the owner marked table-only (their text unchanged since): never paired, never reported. */
  readonly tableOnly: AgeRow[];
}

export const dateOfEvent = (e: TimelineEvent) => ({
  start: e.start,
  end: e.end,
  detail: e.detail as 1 | 2 | 3,
});

/** A single date or a range: what a range row must not lose to a single-day event, and the reverse. */
const shapeOf = (d: { end: number | null }) => (d.end !== null ? 'range' : 'single');

/**
 * Scores of the last pass (higher first). A name match adds to a date match; a range row against a single-date event
 * (or the reverse) is the weakest evidence, and is barred while a row of the event's own shape starts there.
 */
const SCORE = { 'start+end': 8, 'start+year': 5, 'start+shape': 4, name: 2, start: 1 } as const;

/**
 * v3 F2.1: rows that could be an unpaired event's own (the same date, the same start, or the event's name is the row's
 * description). Shared by the check ("Event in a tie") and the orphan delete (refused beside any of them), so an event
 * the check offers for deletion is never one the delete refuses.
 */
export function couldBeRowOf(
  r: AgeRow,
  e: { start: number; end: number | null; detail: number; name: string },
): boolean {
  if (namesMatch(e.name, r.description)) return true;
  if (!r.eventDate) return false;
  return (
    sameDate(r.eventDate, { start: e.start, end: e.end, detail: e.detail as 1 | 2 | 3 }) ||
    r.eventDate.start === e.start
  );
}

/**
 * Pairs rows and events one to one (each pass uses only what the earlier ones left). A row is compared by its
 * `eventDate`: its plain date, or the anchor of its qualified date (ADR 0048).
 *
 * 1. the bridge's own links (a linked pair that disagrees about the date is a date mismatch, not a pair);
 * 2. the same date and the event's name is the row's description (or its start cut short);
 * 3. the same date alone, where a row and an event are the only two on that date (or equally many of each): the
 *    timeline's short name differs from the table's description by design, so wording alone is not a difference;
 * 4. v2 E6: the same chronology event with a different date, by score: the same start and end (a range against a
 *    range) first, then (v3 F2.1, with `kcyOf`) the same start with both ends in the same year, then the same start with
 *    a compatible shape, then the name, then the same start alone. A candidate is taken only when it is the one best
 *    candidate on both sides; a tie stays unpaired, never guessed. A row with a single date never takes a range event
 *    while a range row of the age starts at the same minute (and the reverse): the Divan Heirage case of the Fourth Age
 *    (16 November 2026).
 *
 * v3 F2.1 (ADR 0048, F2.1 amendments): pass 2 takes a name only when it names ONE row of that date and the row's name
 * matches one event (two plain rows and one event: the name decides, or nothing does); and after pass 3, a date where
 * rows and events are not equally many is settled by the plain rows: when the plain rows of that date are exactly as
 * many as its events, they take them (`plain`: "plain row preferred over qualified anchor"), and the qualified rows
 * anchored there are left to be offered events of their own (the Arkona Selyros 40th, 4A 605 case).
 *
 * Rows the owner marked table-only (`tableOnly`, by row id) take no part. What is left over is reported as rows without
 * an event and events without a row.
 */
export function matchRowsAndEvents(
  rows: readonly AgeRow[],
  events: readonly TimelineEvent[],
  links: readonly ChronologyLink[],
  age: AgeConfig,
  opts: {
    readonly tableOnly?: ReadonlySet<string>;
    /** v3 F2.1: the calendar's KCY of a minute: ranges of the same start are told apart by the year they end in. */
    readonly kcyOf?: (minute: number) => number;
  } = {},
): Pairing {
  const pairs: RowEventPair[] = [];
  const tableOnly = rows.filter((r) => r.id !== null && opts.tableOnly?.has(r.id) === true);
  const freeRows = new Set(rows.filter((r) => !tableOnly.includes(r)));
  const freeEvents = new Set(events);
  const byEvent = new Map(events.map((e) => [e.id, e]));
  const mismatches: DateMismatch[] = [];
  const take = (row: AgeRow, event: TimelineEvent, how: PairHow) => {
    pairs.push({ row, event, how });
    freeRows.delete(row);
    freeEvents.delete(event);
  };
  for (const l of links) {
    if (l.tableDocumentId !== age.tableDocumentId || l.timelineDocumentId !== age.timelineDocumentId)
      continue;
    const row = rows.find((r) => r.id === l.rowId);
    const ev = byEvent.get(l.eventId);
    if (!row || !ev || !freeRows.has(row) || !freeEvents.has(ev)) continue;
    // A link says which event is the row's; it does not say they agree about the date.
    if (row.eventDate && !sameDate(dateOfEvent(ev), row.eventDate)) {
      mismatches.push({ row, event: ev, by: 'link' });
      freeRows.delete(row);
      freeEvents.delete(ev);
    } else take(row, ev, 'link');
  }
  // Pass 2: the same date and the name, one to one: a name that matches two rows (or a row two events) decides nothing.
  const named = new Map<AgeRow, TimelineEvent[]>();
  for (const row of freeRows) {
    if (!row.eventDate) continue;
    named.set(
      row,
      [...freeEvents].filter(
        (e) => sameDate(dateOfEvent(e), row.eventDate!) && namesMatch(e.name, row.description),
      ),
    );
  }
  for (const [row, hits] of named) {
    if (hits.length !== 1) continue;
    const hit = hits[0]!;
    const rivals = [...named].filter(([r, es]) => r !== row && es.includes(hit));
    if (rivals.length === 0 && freeEvents.has(hit)) take(row, hit, 'date+name');
  }
  // Pass 3: by date alone, one to one inside a group of the same date and the same number on each side.
  const key = (d: { start: number; end: number | null; detail: number }) =>
    `${d.start}|${d.end ?? ''}|${d.detail}`;
  const rowsByDate = new Map<string, AgeRow[]>();
  for (const r of freeRows) {
    if (!r.eventDate) continue;
    const k = key(r.eventDate);
    rowsByDate.set(k, [...(rowsByDate.get(k) ?? []), r]);
  }
  const eventsByDate = new Map<string, TimelineEvent[]>();
  for (const e of freeEvents) {
    const k = key(dateOfEvent(e));
    eventsByDate.set(k, [...(eventsByDate.get(k) ?? []), e]);
  }
  for (const [k, rs] of rowsByDate) {
    const es = eventsByDate.get(k);
    if (!es) continue;
    if (es.length === rs.length) {
      rs.forEach((r, i) => take(r, es[i]!, 'date'));
      continue;
    }
    // v3 F2.1: a plain row beats a qualified anchor. The event's date and shape are exactly the plain row's date; the
    // qualified rows anchored on it (`Before Selyros 40th, 4A 605; …`) are unpaired and offered new events.
    const plain = rs.filter((r) => r.date !== null && !r.reading);
    if (plain.length > 0 && plain.length < rs.length && plain.length === es.length)
      plain.forEach((r, i) => take(r, es[i]!, 'plain'));
  }
  // Pass 4: the same chronology event with a different date, by score. Every row of the age is a possible rival for
  // the shape guard, a table-only one too: its event is still more likely its own than another shape's row's.
  const shapesAt = new Map<number, AgeRow[]>();
  for (const r of rows) {
    if (!r.eventDate) continue;
    shapesAt.set(r.eventDate.start, [...(shapesAt.get(r.eventDate.start) ?? []), r]);
  }
  const score = (r: AgeRow, e: TimelineEvent): { s: number; by: MismatchBy } | null => {
    const rd = r.eventDate!;
    const ed = dateOfEvent(e);
    if (sameDate(rd, ed)) return null; // the same date: pass 3's to settle, or ambiguous
    const name = namesMatch(e.name, r.description);
    const sameStart = rd.start === ed.start;
    const compatible = shapeOf(rd) === shapeOf(ed);
    let by: MismatchBy | null = null;
    if (sameStart && compatible)
      by =
        rd.end !== null && rd.end === ed.end
          ? 'start+end'
          : rd.end !== null && ed.end !== null && opts.kcyOf && opts.kcyOf(rd.end) === opts.kcyOf(ed.end)
            ? 'start+year'
            : 'start+shape';
    else if (sameStart) {
      // A single-date row never takes a range event while a range row starts there (and the reverse).
      const rival = (shapesAt.get(rd.start) ?? []).some(
        (x) => x !== r && shapeOf(x.eventDate!) === shapeOf(ed),
      );
      if (rival) return null;
      by = name ? 'name' : 'start';
    } else if (name) by = 'name';
    if (by === null) return null;
    return { s: SCORE[by] + (name && by !== 'name' ? SCORE.name : 0), by };
  };
  const cands: { r: AgeRow; e: TimelineEvent; s: number; by: MismatchBy }[] = [];
  for (const r of freeRows) {
    if (!r.eventDate) continue;
    for (const e of freeEvents) {
      const sc = score(r, e);
      if (sc) cands.push({ r, e, ...sc });
    }
  }
  for (const level of [...new Set(cands.map((c) => c.s))].sort((a, b) => b - a)) {
    for (const c of cands) {
      if (c.s !== level || !freeRows.has(c.r) || !freeEvents.has(c.e)) continue;
      // The one best candidate on both sides (a candidate as good or better that is still free makes it a tie).
      const forRow = cands.filter((x) => x.r === c.r && x.s >= level && freeEvents.has(x.e));
      const forEvent = cands.filter((x) => x.e === c.e && x.s >= level && freeRows.has(x.r));
      if (forRow.length !== 1 || forEvent.length !== 1) continue;
      // v3 F2.1: "the same final year" is named only where it decided (another free candidate of the same start and
      // shape would have tied); otherwise the pair was made by its start and shape, as before.
      const decided =
        c.by === 'start+year' &&
        cands.some(
          (x) =>
            x !== c &&
            (x.e === c.e ? freeRows.has(x.r) : x.r === c.r && freeEvents.has(x.e)) &&
            x.s >= level - (SCORE['start+year'] - SCORE['start+shape']),
        );
      mismatches.push({ row: c.r, event: c.e, by: c.by === 'start+year' && !decided ? 'start+shape' : c.by });
      freeRows.delete(c.r);
      freeEvents.delete(c.e);
    }
  }
  return { pairs, mismatches, rows: [...freeRows], events: [...freeEvents], tableOnly };
}

/**
 * Pairs rows and events one to one (see `matchRowsAndEvents`); a row and an event that disagree about the date are not
 * listed here, only in `matchRowsAndEvents`' `mismatches`.
 */
export function pairRowsAndEvents(
  rows: readonly AgeRow[],
  events: readonly TimelineEvent[],
  links: readonly ChronologyLink[],
  age: AgeConfig,
): { pairs: { row: AgeRow; event: TimelineEvent }[]; rows: AgeRow[]; events: TimelineEvent[] } {
  const p = matchRowsAndEvents(rows, events, links, age);
  return {
    pairs: p.pairs.map(({ row, event }) => ({ row, event })),
    rows: [...p.rows, ...p.mismatches.map((m) => m.row)],
    events: [...p.events, ...p.mismatches.map((m) => m.event)],
  };
}

export interface CheckReport {
  readonly summary: string;
  readonly findings: CheckFinding[];
  readonly ages: Obj[];
}

const MAX_PER_KIND = 200;

/** A row's opening words, for naming it in a proposal or a finding (the whole text when short). */
export function openingWords(description: string, words = 10): string {
  const t = description.replace(/\s+/g, ' ').trim();
  const parts = t.split(' ');
  if (parts.length <= words && t.length <= 90) return t;
  const cut = parts.slice(0, words).join(' ');
  return `${cut.length > 90 ? cut.slice(0, 89).trimEnd() : cut}…`;
}

/**
 * v2 E6 (ADR 0048): the rows nearest a date (by their event date), up to `n`, nearest first: a range that holds the
 * date is nearest of all; otherwise the distance to the row's start or end, whichever is closer.
 */
export function nearestRows(
  rows: readonly AgeRow[],
  start: number,
  n = 3,
): { rowId: string | null; date: string; words: string }[] {
  const distance = (d: { start: number; end: number | null }) =>
    d.end !== null && d.start <= start && start <= d.end
      ? 0
      : Math.min(Math.abs(d.start - start), d.end !== null ? Math.abs(d.end - start) : Infinity);
  return rows
    .filter((r) => r.eventDate !== null)
    .map((r) => ({ r, d: distance(r.eventDate!) }))
    .sort((a, b) => a.d - b.d || a.r.index - b.r.index)
    .slice(0, n)
    .map(({ r }) => ({ rowId: r.id, date: r.dateText, words: openingWords(r.description) }));
}

/** v3 F2.1: a candidate row as a tie shows it: its id, Date cell and opening words. */
export const candidateRowView = (r: AgeRow) => ({
  rowId: r.id,
  date: r.dateText,
  words: openingWords(r.description),
});

/** v3 F2.1: a candidate event as a tie shows it: its id, name and date. */
export const candidateEventView = (e: TimelineEvent) => ({
  eventId: e.id,
  name: e.name.slice(0, 200),
  date: eventText(e),
});

/** v3 F2.1: candidates named in a refusal's text (not only in its details): `“name” (date, id)`. */
export function listEvents(es: readonly TimelineEvent[]): string {
  return es.map((e) => `“${openingWords(e.name, 12)}” (${eventText(e)}, ${e.id})`).join('; ');
}

/** v3 F2.1: candidate rows named in a refusal's text: `date: opening words (row id)`. */
export function listRows(rs: readonly AgeRow[]): string {
  return rs.map((r) => `${r.dateText}: ${openingWords(r.description)} (row ${r.id ?? '?'})`).join('; ');
}

const unit = (detail: number) => (detail === 1 ? 'year' : detail === 2 ? 'month' : 'day');

/**
 * v2 E6 (ADR 0048): what a repair from the row would do to the event's shape, in plain words (`range → single day`,
 * `single day → range`), or null when the shape stays.
 */
export function shapeChange(
  event: { readonly end: number | null; readonly detail: number },
  row: { readonly end: number | null; readonly detail: number },
): string | null {
  if (event.end !== null && row.end === null) return `range → single ${unit(row.detail)}`;
  if (event.end === null && row.end !== null) return `single ${unit(event.detail)} → range`;
  return null;
}

export async function runCheck(o: {
  readonly projectId: string;
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly links: readonly ChronologyLink[];
  /** v2 E6 (ADR 0048): the owner's table-only marks (each holds while its row is unchanged). */
  readonly tableOnly?: readonly TableOnlyMark[];
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
    // v2 E6 (ADR 0048): rows the owner marked table-only are hidden while their cells are unchanged.
    const marks = currentTableOnly(
      t.rows,
      (o.tableOnly ?? []).filter((m) => m.tableDocumentId === age.tableDocumentId),
    );
    const hidden = (r: AgeRow) => r.id !== null && marks.current.has(r.id);
    let qualified = 0;
    let unreadable = 0;
    // Dates the engine cannot read, and cells written differently from the confirmed style.
    for (const r of t.rows) {
      if (hidden(r)) continue;
      if (r.reading) {
        // A qualified date: read by its anchor, never rewritten. Its qualifier words (in the Date and KCY cells) are
        // text, not errors; the KCY is checked where one is computable (not for an open bound).
        qualified++;
        if (r.reading.openStart || r.reading.openEnd) continue;
        const k = readQualifiedKcy(r.kcyText);
        const want = r.reading.date.kcy;
        if (k.kind === 'value' && (k.start !== want.start || (k.end ?? k.start) !== (want.end ?? want.start)))
          add({
            kind: 'wrong_kcy',
            age: age.name,
            message: `KCY “${r.kcyText}” for “${r.dateText}” (read as ${describeReading(r.reading)}) should be ${formatKcy(want, c.style.kcy)} (row ${r.index + 1}; its words are not checked).`,
            detail: { rowId: r.id, cell: r.kcyText, engine: formatKcy(want, c.style.kcy), date: r.dateText },
          });
        continue;
      }
      if (!r.date) {
        unreadable++;
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
      if (!kcyWrittenAlike(r.kcyText, r.date.kcy, c.style.kcy)) {
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
      if (hidden(x.row)) continue;
      add({
        kind: 'row_out_of_order',
        age: age.name,
        message: `“${x.row.dateText}” (row ${x.row.index + 1}) comes after “${x.after.dateText}” (row ${x.after.index + 1}).`,
        detail: { rowId: x.row.id, after: x.after.id },
      });
    }
    const paired = matchRowsAndEvents(t.rows, events, o.links, age, {
      tableOnly: marks.current,
      kcyOf: (m) => o.calendar.engine.kcyOf(m),
    });
    for (const m of paired.mismatches) {
      const rowDate = m.row.eventDate!;
      const change = shapeChange(m.event, rowDate);
      add({
        kind: 'date_mismatch',
        age: age.name,
        message:
          `Row ${m.row.index + 1} (“${m.row.dateText}”, ${m.row.description.slice(0, 80)}) and the timeline event ` +
          `“${m.event.name.slice(0, 80)}” are the same event (paired by ${m.by}) but disagree about its date: the row says ` +
          `${rowDate.end !== null ? 'a range' : 'one date'} (${rowDate.formatted}), the event ` +
          `${m.event.end !== null ? 'a range' : 'one date'} (${eventText(m.event)}). The table is the authority.` +
          (change ? ` A fix would change the event: ${change}.` : ''),
        detail: {
          rowId: m.row.id,
          eventId: m.event.id,
          rowDate: m.row.dateText,
          eventDate: eventText(m.event),
          pairedBy: m.by,
          ...(change ? { shapeChange: change } : {}),
          ...(m.row.reading ? { reading: describeReading(m.row.reading) } : {}),
        },
      });
    }
    // v3 F2 (ADR 0049 decision 1): a linked event whose date tail (written by the bridge) no longer says what the row's
    // Date cell says, though the date agrees: the cell's wording changed. "Propose a fix" makes a name-only update.
    for (const p of paired.pairs) {
      const link = o.links.find((l) => l.tableDocumentId === age.tableDocumentId && l.rowId === p.row.id);
      const to = renameFor(p.event, link, p.row);
      if (to === null) continue;
      add({
        kind: 'name_drift',
        age: age.name,
        message: `Row ${p.row.index + 1} (“${p.row.dateText}”, ${p.row.description.slice(0, 80)}): its event's name no longer carries the row's Date cell (${renameLine(p.event.name, to)}). The date agrees.`,
        detail: { rowId: p.row.id, eventId: p.event.id, date: p.row.dateText, from: p.event.name, to },
      });
    }
    for (const r of paired.rows) {
      // A row whose date cannot be read is reported once, as unreadable; a qualified row's event is now fixable.
      if (!r.eventDate) continue;
      add({
        kind: 'row_without_event',
        age: age.name,
        message: `Row ${r.index + 1} (“${r.dateText}”, ${r.description.slice(0, 80)}) has no timeline event.`,
        detail: {
          rowId: r.id,
          date: r.dateText,
          ...(r.reading ? { reading: describeReading(r.reading) } : {}),
        },
      });
    }
    for (const e of paired.events) {
      // v3 F2.1: an unpaired event that an unpaired row could own is caught in a tie, never "without a row": it is
      // paired (the owner picks the row), never deleted.
      const candidates = paired.rows.filter((r) => couldBeRowOf(r, { ...dateOfEvent(e), name: e.name }));
      if (candidates.length > 0) {
        add({
          kind: 'event_in_tie',
          age: age.name,
          message: `Event “${e.name.slice(0, 80)}” (${eventText(e)}) is in a tie: ${candidates.length} row${candidates.length === 1 ? '' : 's'} of the table could be its own (${candidates.map((r) => `${r.dateText}: ${openingWords(r.description)}`).join('; ')}). Pair it with one; it is not deleted.`,
          detail: {
            eventId: e.id,
            start: e.start,
            name: e.name.slice(0, 200),
            date: eventText(e),
            candidates: candidates.map(candidateRowView),
          },
        });
        continue;
      }
      add({
        kind: 'event_without_row',
        age: age.name,
        message: `Event “${e.name.slice(0, 80)}” (${eventText(e)}) has no table row.`,
        detail: {
          eventId: e.id,
          start: e.start,
          name: e.name.slice(0, 200),
          date: eventText(e),
          nearest: nearestRows(t.rows, e.start),
        },
      });
    }
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
    // v2 E6 (ADR 0048): how each pair was made (the Chronology page shows it), and how the dates were read.
    const pairedBy: Record<string, number> = {};
    for (const p of paired.pairs) pairedBy[p.how] = (pairedBy[p.how] ?? 0) + 1;
    for (const m of paired.mismatches) pairedBy[`mismatch:${m.by}`] = (pairedBy[`mismatch:${m.by}`] ?? 0) + 1;
    ages.push({
      age: age.name,
      rows: t.rows.length,
      events: events.length,
      count: row?.countText ?? null,
      dates: { qualified, unreadable, tableOnly: marks.current.size },
      ...(marks.lapsed.length > 0
        ? { tableOnlyLapsed: marks.lapsed.map((m) => ({ rowId: m.rowId, date: m.texts.date })) }
        : {}),
      pairedBy,
      pairs: [
        ...paired.pairs.map((p) => ({
          rowId: p.row.id,
          eventId: p.event.id,
          by: p.how,
          date: p.row.dateText.slice(0, 60),
          ...(p.row.reading ? { qualified: true } : {}),
        })),
        ...paired.mismatches.map((m) => ({
          rowId: m.row.id,
          eventId: m.event.id,
          by: m.by,
          mismatch: true,
          date: m.row.dateText.slice(0, 60),
          ...(m.row.reading ? { qualified: true } : {}),
        })),
      ],
    });
  }
  const summary =
    findings.length === 0
      ? `No findings: ${ages.map((a) => `${String(a.age)} ${String(a.rows)} rows`).join(', ')}.`
      : `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${[...new Set(findings.map((f) => f.kind))].join(', ')}.`;
  return { summary, findings, ages };
}
