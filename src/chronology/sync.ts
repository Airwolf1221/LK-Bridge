/**
 * `sync_timeline_event` (v2 D1.1, ADR 0039): repairing timeline drift, with the table as the authority.
 *
 * A table row of an age has no timeline event, or its paired event disagrees with it (a range row with a single-day
 * event, another year, a missing `uri`). This plans the repair of ONE row: it creates the row's event if it is missing,
 * or corrects the paired event's minutes, `detail`, shape (an end or none) and `uri` to match the row. It never touches
 * the table or the Main count (the row was already counted: that is the drift), and it never renames an event (the
 * timeline's short name differs from the table's description by design), with one exception (v3 F2, ADR 0049 decision
 * 1): the date tail the bridge itself wrote into a linked qualified event's name follows the row's Date cell.
 *
 * The plan is pure: it reads through a reader, builds the target (the writes) and the context the job needs, and the
 * caller submits it: the MCP tool as a job or a proposal by the caller's scope, the dashboard's "Propose a fix" always
 * as a proposal. Both use the same job (src/chronology/plan.ts): the age table and the timeline held for the whole job
 * (sorted locks), `bridge.expect` inside the lock (the row still exactly as planned, the event still as read, the lane
 * there), the write, `bridge.verify`, the journal, the record (resume, never replay).
 */
import { createHash } from 'node:crypto';
import {
  CalendarError,
  describeReading,
  parseQualified,
  type Calendar,
  type ParsedDate,
} from '../calendar/index.js';
import { mintClientId } from '../jobs/ids.js';
import {
  eventText,
  matchRowsAndEvents,
  namesMatch,
  readEvents,
  shapeChange,
  tableUri,
  uriPointsAt,
  type CheckReader,
  type Pairing,
  type TimelineEvent,
} from './check.js';
import type { WriteContext } from './plan.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import { EVENT_NAME_MAX, nameWithTail, renameFor, renameLine, splitNameTail } from './names.js';
export { renameFor, renameLine } from './names.js';
import {
  currentTableOnly,
  type ChronologyLink,
  type ChronologyTarget,
  type TableOnlyMark,
  type TargetWrite,
} from './store.js';
import { readAgeTable, sameDate, sameText, type AgeRow, type AgeTable } from './table.js';

type Obj = Record<string, unknown>;

export const SYNC_TOOL = 'sync_timeline_event' as const;

/** Which row, as the caller names it: its date with its text, or its block id (with its age when no date is given). */
export interface SyncRef {
  readonly date?: string;
  readonly description?: string;
  readonly rowId?: string;
  readonly age?: string;
  /** Only to choose among the candidate events of a row the pairing could not settle (it names one of them). */
  readonly eventId?: string;
  /** The new event's short name (default: the row's description, cut short with an ellipsis when long). */
  readonly name?: string;
}

export interface SyncRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details: Obj;
}

export interface FieldChange {
  readonly field: 'start' | 'end' | 'detail' | 'uri' | 'name';
  readonly from: unknown;
  readonly to: unknown;
}

export interface SyncPlan {
  readonly ok: true;
  /**
   * `nothing`: the row and its event already agree; `create`: no event, one is made; `correct`: the paired event is
   * updated; `recreate`: the row has no end but the event has one, which LegendKeeper cannot take away, so the event is
   * made again (same lane, link and name).
   */
  readonly action: 'nothing' | 'create' | 'correct' | 'recreate';
  readonly age: AgeConfig;
  readonly row: AgeRow;
  readonly table: AgeTable;
  /** The event as it is now (null when there is none). */
  readonly event: TimelineEvent | null;
  /** How the event was found: the pairing pass, or the caller's choice. */
  readonly pairedBy: string | null;
  readonly changes: readonly FieldChange[];
  /**
   * v2 E6 (ADR 0048): what the repair does to the event's shape in plain words (`range → single day`, `single day →
   * range`), or null. Such a repair is never one click: the dashboard and the tool ask for a confirmation first.
   */
  readonly shapeChange: string | null;
  readonly eventName: string;
  readonly writes: readonly TargetWrite[];
  readonly target: ChronologyTarget;
  readonly ctx: WriteContext;
  readonly requestKey: string;
  readonly summary: string;
  /** What every answer and the proposal show. */
  readonly head: Obj;
  readonly markdown: { readonly before: string; readonly after: string };
}

export type SyncResult = SyncPlan | SyncRefusal;

const refuse = (code: string, message: string, details: Obj = {}): SyncRefusal => ({
  ok: false,
  code,
  message,
  details,
});

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The key of a request (same request, same key: a job that stopped part-way is resumed by repeating it). */
export function syncRequestKey(ref: SyncRef): string {
  return sha({
    tool: SYNC_TOOL,
    date: ref.date ?? null,
    description: ref.description !== undefined ? norm(ref.description) : null,
    rowId: ref.rowId ?? null,
    age: ref.age !== undefined ? norm(ref.age) : null,
    eventId: ref.eventId ?? null,
    name: ref.name ?? null,
  });
}

/** An event's short name from its row's description: the whole text, or its start cut short with `...` when long. */
export const SHORT_NAME_LENGTH = 100;
export function shortName(description: string): string {
  const t = description.replace(/\s+/g, ' ').trim();
  if (t.length <= SHORT_NAME_LENGTH) return t;
  return `${t.slice(0, SHORT_NAME_LENGTH - 3).trimEnd()}...`;
}

/** LegendKeeper's longest event name. */
export { EVENT_NAME_MAX } from './names.js';

/**
 * v2 E6 (ADR 0048 decision 3, accepted by the owner as `with-date`): how a qualified row's event shows its
 * qualification on the timeline. LegendKeeper's events have no text field but the name (`detail` is the precision, 1
 * to 4), so the owner's own wording goes into the name: the row's opening words as now, then ` – ` and the Date cell
 * verbatim (`The House of Menkhet admits Mehrana… – c. 4A 563; exact date unresolved`). Plain rows are never affected.
 */
export const QUALIFIED_EVENT_NAMES = 'with-date' as const;

/** The name a new event of this row gets (the caller's `name`, or the row's opening words; see above). */
export function eventNameFor(row: AgeRow, given?: string): string {
  const base = given?.trim() || shortName(row.description);
  if (!row.reading) return base.slice(0, EVENT_NAME_MAX);
  return nameWithTail(base, row.dateText);
}

/** The tail the bridge writes into a new event's name for this row ('' for a plain row, or no room). */
export function tailOfNewName(name: string, row: AgeRow): string {
  if (!row.reading) return '';
  const split = splitNameTail(name);
  return split && name === nameWithTail(split.opening, row.dateText) ? split.tail : '';
}

/** The tail a link keeps when the event is not renamed: the bridge's own, while the name still ends with it. */
function bridgeTail(
  event: { readonly id: string },
  link: ChronologyLink | null | undefined,
  name: string,
): string {
  if (!link || link.eventId !== event.id || !link.nameTail) return '';
  return splitNameTail(name)?.tail === link.nameTail ? link.nameTail : '';
}

/** v2 E6 (ADR 0048): a row's qualified reading as every answer and proposal shows it. */
export function readingView(r: AgeRow): Obj | null {
  if (!r.reading) return null;
  const q = r.reading;
  return {
    reads: describeReading(q),
    anchor: q.anchorText,
    qualifier: q.qualifier,
    approximate: q.approximate,
    ...(q.openStart ? { openStart: true } : {}),
    ...(q.openEnd ? { openEnd: true } : {}),
  };
}

const ageOfEra = (c: ChronologyConfig, cal: Calendar, d: ParsedDate): AgeConfig | null =>
  c.ages.find((a) => cal.engine.eras.find((e) => e.id === a.eraId)?.id === d.era.id) ?? null;

const ageNamed = (c: ChronologyConfig, cal: Calendar, name: string): AgeConfig | null => {
  const k = norm(name);
  return (
    c.ages.find((a) => norm(a.name) === k) ??
    c.ages.find((a) => norm(cal.engine.eras.find((e) => e.id === a.eraId)?.abbr ?? '') === k) ??
    null
  );
};

const rowView = (r: AgeRow) => ({
  id: r.id,
  date: r.dateText,
  description: r.description.slice(0, 200),
  kcy: r.kcyText,
});

const eventView = (e: TimelineEvent) => ({
  id: e.id,
  name: e.name.slice(0, 200),
  date: eventText(e),
  start: e.start,
  ...(e.end !== null ? { end: e.end } : {}),
  detail: e.detail,
  uri: e.uri,
});

/**
 * Plans the repair of one row. Reads through `read` (the calendar is the caller's: read fresh, so a write never plans on
 * a stale definition). Throws what `read` throws; every other refusal is a `SyncRefusal`.
 */
export async function planSync(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly links: readonly ChronologyLink[];
  readonly ref: SyncRef;
  /** v2 E6 (ADR 0048): the owner's table-only marks; a marked row is never given an event. */
  readonly tableOnly?: readonly TableOnlyMark[];
}): Promise<SyncResult> {
  const { config: c, calendar: cal, ref } = o;
  const resourceId = c.resourceId!;
  if (ref.rowId === undefined && (ref.date === undefined || ref.description === undefined))
    return refuse(
      'INVALID_PARAMS',
      'Name the row by its date together with its description, or by its row_id (with its age when no date is given).',
    );
  let date: ParsedDate | null = null;
  if (ref.date !== undefined) {
    try {
      date = cal.parser.parse(ref.date, c.style.date);
    } catch (e) {
      if (!(e instanceof CalendarError)) throw e;
      // v2 E6 (ADR 0048): a qualified Date cell, given as the table shows it, read by its anchor.
      const q = parseQualified(cal.parser, ref.date, c.style.date);
      if (!q.ok)
        return refuse(e.code, `${e.message} (read as a qualified date: ${q.message})`, { ...e.details });
      date = q.reading.date;
    }
  }
  let age: AgeConfig | null = null;
  if (ref.age !== undefined) {
    age = ageNamed(c, cal, ref.age);
    if (!age)
      return refuse('AGE_NOT_FOUND', `No age of the chronology is named “${ref.age}”.`, {
        ages: c.ages.map((a) => a.name),
      });
  }
  if (date) {
    const a = ageOfEra(c, cal, date);
    if (!a) return refuse('AGE_NOT_CONFIGURED', `${date.text} is in an age with no confirmed table.`);
    if (age && age.name !== a.name)
      return refuse('AGE_MISMATCH', `${date.text} is in ${a.name}, not ${age.name}.`, {
        dateAge: a.name,
        givenAge: age.name,
      });
    age = a;
  }

  // The table, and the row in it.
  const readTable = async (a: AgeConfig): Promise<AgeTable | null> => {
    const b = (await o.read('getDocumentBlocks', {
      path: { resourceId, documentId: a.tableDocumentId },
    })) as { blocks?: unknown[] } | undefined;
    return readAgeTable(b?.blocks ?? [], cal.parser, c.style.date, c.columns);
  };
  let table: AgeTable | null = null;
  let row: AgeRow | null = null;
  if (age) {
    table = await readTable(age);
    if (!table)
      return refuse(
        'CHRONOLOGY_CHANGED',
        `The ${age.name} table document has no table with the columns ${c.columns.event} | ${c.columns.date} | ${c.columns.kcy}.`,
      );
  } else {
    // A row id alone: the age whose table holds it.
    for (const a of c.ages) {
      const t = await readTable(a);
      if (t?.rows.some((r) => r.id === ref.rowId)) {
        age = a;
        table = t;
        break;
      }
    }
    if (!age || !table)
      return refuse('EVENT_NOT_FOUND', `No table of the chronology has a row ${String(ref.rowId)}.`, {
        ages: c.ages.map((a) => a.name),
      });
  }
  if (ref.rowId !== undefined) {
    row = table.rows.find((r) => r.id === ref.rowId) ?? null;
    if (!row) return refuse('EVENT_NOT_FOUND', `The ${age.name} table has no row ${ref.rowId}.`);
    if (date && (!row.eventDate || !sameDate(row.eventDate, date)))
      return refuse(
        'ROW_MISMATCH',
        `The row ${ref.rowId} says “${row.dateText}”, not ${date.text}. Nothing was done.`,
        { row: rowView(row) },
      );
  } else {
    const hits = table.rows.filter(
      (r) =>
        r.eventDate !== null &&
        sameDate(r.eventDate, date!) &&
        sameText(r.description, ref.description ?? ''),
    );
    if (hits.length === 0)
      return refuse(
        'EVENT_NOT_FOUND',
        `The ${age.name} table has no row on ${date!.text} with this description. Check it with the table, or pass row_id.`,
        {
          sameDate: table.rows
            .filter((r) => r.eventDate && sameDate(r.eventDate, date!))
            .slice(0, 10)
            .map(rowView),
        },
      );
    if (hits.length > 1)
      return refuse('EVENT_AMBIGUOUS', `${hits.length} rows of ${age.name} match; pass row_id.`, {
        rows: hits.map(rowView),
      });
    row = hits[0]!;
  }
  if (!row.id)
    return refuse('CHRONOLOGY_CHANGED', 'This row has no block id, so it cannot be named; nothing was done.');
  if (!row.eventDate)
    return refuse(
      'ROW_DATE_UNREADABLE',
      `The row’s date “${row.dateText}” cannot be read (${row.dateError?.message ?? 'unknown'}); fix the table first, or mark the row table-only on the Chronology page. Nothing was done.`,
      { row: rowView(row), code: row.dateError?.code },
    );
  const marks = currentTableOnly(
    table.rows,
    (o.tableOnly ?? []).filter((m) => m.tableDocumentId === age.tableDocumentId),
  );
  if (marks.current.has(row.id))
    return refuse(
      'ROW_TABLE_ONLY',
      `The owner marked the row “${row.dateText}” (${row.description.slice(0, 80)}) table-only: it is never put on the timeline. Nothing was done.`,
      { row: rowView(row) },
    );
  // The plain date, or the qualified date's anchor (ADR 0048): what the event takes. The table is never rewritten.
  const want: ParsedDate = row.eventDate;

  // The events, and the pairing as the check makes it.
  const events = (await readEvents(o.read, resourceId, age.timelineDocumentId)).filter(
    (e) => e.laneId === age.laneId,
  );
  const pairing: Pairing = matchRowsAndEvents(
    table.rows,
    events,
    o.links.filter((l) => l.tableDocumentId === age.tableDocumentId),
    age,
    { tableOnly: marks.current },
  );
  let event: TimelineEvent | null = null;
  let pairedBy: string | null = null;
  const pair = pairing.pairs.find((p) => p.row === row);
  const mismatch = pairing.mismatches.find((m) => m.row === row);
  if (pair) {
    event = pair.event;
    pairedBy = pair.how;
  } else if (mismatch) {
    event = mismatch.event;
    pairedBy = `date mismatch (by ${mismatch.by})`;
  } else {
    // Unpaired: a candidate is a leftover event that names the row's description, begins where it begins or has its
    // date. Any candidate makes the pairing ambiguous: never made a second event beside it.
    const free = pairing.events;
    // v2 E6 (ADR 0048): an event of the other shape at the same start is not this row's while a row of the event's own
    // shape starts there (the Divan Heirage case: the one-day row is offered a new event, not the range's).
    const rival = (e: TimelineEvent) =>
      e.start === want.start &&
      (e.end !== null) !== (want.end !== null) &&
      table.rows.some(
        (x) =>
          x !== row &&
          x.eventDate !== null &&
          x.eventDate.start === e.start &&
          (x.eventDate.end !== null) === (e.end !== null),
      );
    const candidates = free.filter(
      (e) =>
        !rival(e) &&
        (sameDate({ start: e.start, end: e.end, detail: e.detail as 1 | 2 | 3 }, want) ||
          e.start === want.start ||
          namesMatch(e.name, row.description)),
    );
    if (ref.eventId !== undefined) {
      const chosen = events.find((e) => e.id === ref.eventId);
      if (!chosen)
        return refuse('EVENT_NOT_FOUND', `The ${age.name} timeline has no event ${ref.eventId}.`, {
          candidates: candidates.map(eventView),
        });
      if (!free.includes(chosen))
        return refuse(
          'EVENT_TAKEN',
          `The event ${chosen.id} already belongs to another row of ${age.name}; nothing was done.`,
          { event: eventView(chosen) },
        );
      event = chosen;
      pairedBy = 'chosen by the caller';
    } else if (candidates.length > 0) {
      return refuse(
        'PAIRING_AMBIGUOUS',
        `The row “${row.dateText}” (${row.description.slice(0, 80)}) has no event the check can pair it with, but ${candidates.length} unpaired event${candidates.length === 1 ? '' : 's'} of ${age.name} could be its own. Nothing was done: pass event_id to name the one to correct, or fix the table or timeline by hand.`,
        { row: rowView(row), candidates: candidates.map(eventView) },
      );
    }
  }
  if (ref.eventId !== undefined && event && event.id !== ref.eventId)
    return refuse(
      'EVENT_MISMATCH',
      `The row is paired with the event ${event.id}, not ${ref.eventId}; nothing was done.`,
      { event: eventView(event) },
    );

  const uri = tableUri(resourceId, age.tableDocumentId);
  const changes: FieldChange[] = [];
  if (event) {
    if (event.start !== want.start) changes.push({ field: 'start', from: event.start, to: want.start });
    if ((event.end ?? null) !== (want.end ?? null))
      changes.push({ field: 'end', from: event.end, to: want.end });
    if (event.detail !== want.detail) changes.push({ field: 'detail', from: event.detail, to: want.detail });
    if (!uriPointsAt(event.uri, resourceId, age.tableDocumentId))
      changes.push({ field: 'uri', from: event.uri, to: uri });
  }
  // v3 F2 (ADR 0049 decision 1): a tail the bridge wrote follows the row's Date cell, in the same proposal.
  const rowLink = o.links.find((l) => l.tableDocumentId === age.tableDocumentId && l.rowId === row.id);
  const rename = event ? renameFor(event, rowLink, row) : null;
  if (event && rename !== null) changes.push({ field: 'name', from: event.name, to: rename });
  const renameText = event && rename !== null ? renameLine(event.name, rename) : null;
  // The tail the link records after this change.
  const tailAfter = (name: string): string =>
    rename !== null ? (splitNameTail(rename)?.tail ?? '') : event ? bridgeTail(event, rowLink, name) : '';
  const rowInfo = {
    id: row.id,
    texts: { description: row.description, date: row.dateText, kcy: row.kcyText },
  };
  const eventName = rename ?? event?.name ?? eventNameFor(row, ref.name);
  const requestKey = syncRequestKey(ref);
  const shape = event ? shapeChange(event, want) : null;
  const common = {
    ok: true as const,
    age,
    row,
    table,
    event,
    pairedBy,
    changes,
    shapeChange: shape,
    eventName,
    requestKey,
  };
  const lanes: Record<string, { id: string; name: string }> = {
    [age.timelineDocumentId]: { id: age.laneId, name: age.laneName },
  };
  const rid = resourceId;
  const assertRow: TargetWrite = {
    kind: 'row.assert',
    age: age.name,
    resourceId: rid,
    documentId: age.tableDocumentId,
    rowId: rowInfo.id,
    texts: rowInfo.texts,
  };
  const link = {
    age: age.name,
    tableDocumentId: age.tableDocumentId,
    rowId: row.id,
    timelineDocumentId: age.timelineDocumentId,
    eventId: '',
  };
  const baseCtx = (extraEvents: Record<string, Obj>): WriteContext => ({
    tableIds: { [age.tableDocumentId]: table.table.id ?? '' },
    mainTableId: '',
    rows: {},
    counts: {},
    lanes,
    events: extraEvents,
  });
  const line = `| ${row.description} | ${row.dateText} | ${row.kcyText} |`;
  const lane = `## ${age.name} - Timeline (${age.laneName})`;
  const wantText = want.formatted;
  const reading = readingView(row);
  const head = (action: SyncPlan['action']): Obj => ({
    action,
    age: age.name,
    row: rowView(row),
    date: { text: want.text, formatted: want.formatted, shape: want.shape, detail: want.detail },
    ...(reading ? { reading } : {}),
    event: event ? eventView(event) : null,
    ...(pairedBy ? { pairedBy } : {}),
    changes,
    ...(renameText ? { rename: renameText } : {}),
    ...(shape
      ? {
          shapeChange: shape,
          warning: `This changes the event's shape: ${shape}. Check the row and the event first.`,
        }
      : {}),
    note: 'The table is the authority: only the timeline event is created or corrected. The table and the Main count are not touched.',
  });

  if (event && changes.length === 0) {
    const target: ChronologyTarget = {
      writes: [],
      link: { ...link, eventId: event.id, nameTail: tailAfter(event.name) },
    };
    return {
      ...common,
      action: 'nothing',
      writes: [],
      target,
      ctx: baseCtx({}),
      summary: `${SYNC_TOOL}: “${row.dateText}” (${age.name}): nothing to do`,
      head: head('nothing'),
      markdown: { before: '', after: '' },
    };
  }

  if (!event) {
    const id = mintClientId(24);
    const body: Obj = {
      id,
      laneId: age.laneId,
      type: 'event',
      name: eventName,
      start: want.start,
      ...(want.end !== null ? { end: want.end } : {}),
      detail: want.detail,
      uri,
    };
    const writes: TargetWrite[] = [
      assertRow,
      {
        kind: 'event.create',
        age: age.name,
        resourceId: rid,
        documentId: age.timelineDocumentId,
        eventId: id,
        body,
      },
    ];
    return {
      ...common,
      action: 'create',
      writes,
      target: { writes, link: { ...link, eventId: id, nameTail: tailOfNewName(eventName, row) } },
      ctx: baseCtx({}),
      summary: `${SYNC_TOOL}: add the missing ${age.name} event for “${row.dateText}”`,
      head: { ...head('create'), event: { id, name: eventName, date: wantText, ...body } },
      markdown: {
        before: [`## ${age.name} - Table`, line, '', lane, '- (no event)'].join('\n'),
        after: [`## ${age.name} - Table`, line, '', lane, `- ${wantText}: **${eventName}**`].join('\n'),
      },
    };
  }

  const before = [`## ${age.name} - Table`, line, '', lane, `- ${eventText(event)}: **${event.name}**`].join(
    '\n',
  );
  const after = [`## ${age.name} - Table`, line, '', lane, `- ${wantText}: **${eventName}**`].join('\n');
  if (event.end !== null && want.end === null) {
    // LegendKeeper cannot take an end away from an event: it is made again (same lane, link and name).
    const id = mintClientId(24);
    const body: Obj = {
      id,
      laneId: age.laneId,
      type: 'event',
      name: eventName,
      start: want.start,
      detail: want.detail,
      uri,
    };
    const writes: TargetWrite[] = [
      assertRow,
      {
        kind: 'event.delete',
        age: age.name,
        resourceId: rid,
        documentId: age.timelineDocumentId,
        eventId: event.id,
      },
      {
        kind: 'event.create',
        age: age.name,
        resourceId: rid,
        documentId: age.timelineDocumentId,
        eventId: id,
        body,
      },
    ];
    return {
      ...common,
      action: 'recreate',
      writes,
      target: { writes, link: { ...link, eventId: id, nameTail: tailAfter(event.name) } },
      ctx: baseCtx({ [event.id]: event.raw }),
      summary: `${SYNC_TOOL}: make the ${age.name} event for “${row.dateText}” again as a single date (${shape ?? 'range → single date'})${renameText ? `; ${renameText}` : ''}`,
      head: head('recreate'),
      markdown: { before, after },
    };
  }
  const fields: Obj = {};
  for (const ch of changes) {
    if (ch.field === 'end' && ch.to === null) continue;
    fields[ch.field] = ch.to;
  }
  const writes: TargetWrite[] = [
    assertRow,
    {
      kind: 'event.update',
      age: age.name,
      resourceId: rid,
      documentId: age.timelineDocumentId,
      eventId: event.id,
      fields,
    },
  ];
  return {
    ...common,
    action: 'correct',
    writes,
    target: { writes, link: { ...link, eventId: event.id, nameTail: tailAfter(event.name) } },
    ctx: baseCtx({ [event.id]: event.raw }),
    summary: `${SYNC_TOOL}: correct the ${age.name} event for “${row.dateText}” (${changes.map((x) => x.field).join(', ')}${shape ? `; ${shape}` : ''})${renameText ? `; ${renameText}` : ''}`,
    head: head('correct'),
    markdown: { before, after },
  };
}
