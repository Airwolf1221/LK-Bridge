/**
 * `sync_timeline_event` (v2 D1.1, ADR 0039): repairing timeline drift, with the table as the authority.
 *
 * A table row of an age has no timeline event, or its paired event disagrees with it (a range row with a single-day
 * event, another year, a missing `uri`). This plans the repair of ONE row: it creates the row's event if it is missing,
 * or corrects the paired event's minutes, `detail`, shape (an end or none) and `uri` to match the row. It never touches
 * the table or the Main count (the row was already counted: that is the drift), and it never renames an event (the
 * timeline's short name differs from the table's description by design).
 *
 * The plan is pure: it reads through a reader, builds the target (the writes) and the context the job needs, and the
 * caller submits it: the MCP tool as a job or a proposal by the caller's scope, the dashboard's "Propose a fix" always
 * as a proposal. Both use the same job (src/chronology/plan.ts): the age table and the timeline held for the whole job
 * (sorted locks), `bridge.expect` inside the lock (the row still exactly as planned, the event still as read, the lane
 * there), the write, `bridge.verify`, the journal, the record (resume, never replay).
 */
import { createHash } from 'node:crypto';
import { CalendarError, type Calendar, type ParsedDate } from '../calendar/index.js';
import { mintClientId } from '../jobs/ids.js';
import {
  eventText,
  matchRowsAndEvents,
  namesMatch,
  readEvents,
  tableUri,
  uriPointsAt,
  type CheckReader,
  type Pairing,
  type TimelineEvent,
} from './check.js';
import type { WriteContext } from './plan.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import type { ChronologyLink, ChronologyTarget, TargetWrite } from './store.js';
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
  readonly field: 'start' | 'end' | 'detail' | 'uri';
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
      if (e instanceof CalendarError) return refuse(e.code, e.message, { ...e.details });
      throw e;
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
    if (date && (!row.date || !sameDate(row.date, date)))
      return refuse(
        'ROW_MISMATCH',
        `The row ${ref.rowId} says “${row.dateText}”, not ${date.text}. Nothing was done.`,
        { row: rowView(row) },
      );
  } else {
    const hits = table.rows.filter(
      (r) => r.date !== null && sameDate(r.date, date!) && sameText(r.description, ref.description ?? ''),
    );
    if (hits.length === 0)
      return refuse(
        'EVENT_NOT_FOUND',
        `The ${age.name} table has no row on ${date!.text} with this description. Check it with the table, or pass row_id.`,
        {
          sameDate: table.rows
            .filter((r) => r.date && sameDate(r.date, date!))
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
  if (!row.date)
    return refuse(
      'ROW_DATE_UNREADABLE',
      `The row’s date “${row.dateText}” cannot be read (${row.dateError?.message ?? 'unknown'}); fix the table first. Nothing was done.`,
      { row: rowView(row), code: row.dateError?.code },
    );
  const want: ParsedDate = row.date;

  // The events, and the pairing as the check makes it.
  const events = (await readEvents(o.read, resourceId, age.timelineDocumentId)).filter(
    (e) => e.laneId === age.laneId,
  );
  const pairing: Pairing = matchRowsAndEvents(
    table.rows,
    events,
    o.links.filter((l) => l.tableDocumentId === age.tableDocumentId),
    age,
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
    const candidates = free.filter(
      (e) =>
        sameDate({ start: e.start, end: e.end, detail: e.detail as 1 | 2 | 3 }, want) ||
        e.start === want.start ||
        namesMatch(e.name, row.description),
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
  const rowInfo = {
    id: row.id,
    texts: { description: row.description, date: row.dateText, kcy: row.kcyText },
  };
  const eventName = event?.name ?? (ref.name?.trim() || shortName(row.description));
  const requestKey = syncRequestKey(ref);
  const common = {
    ok: true as const,
    age,
    row,
    table,
    event,
    pairedBy,
    changes,
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
  const head = (action: SyncPlan['action']): Obj => ({
    action,
    age: age.name,
    row: rowView(row),
    date: { text: want.text, formatted: want.formatted, shape: want.shape, detail: want.detail },
    event: event ? eventView(event) : null,
    ...(pairedBy ? { pairedBy } : {}),
    changes,
    note: 'The table is the authority: only the timeline event is created or corrected. The table and the Main count are not touched.',
  });

  if (event && changes.length === 0) {
    const target: ChronologyTarget = { writes: [], link: { ...link, eventId: event.id } };
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
      target: { writes, link: { ...link, eventId: id } },
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
  const after = [`## ${age.name} - Table`, line, '', lane, `- ${wantText}: **${event.name}**`].join('\n');
  if (event.end !== null && want.end === null) {
    // LegendKeeper cannot take an end away from an event: it is made again (same lane, link and name).
    const id = mintClientId(24);
    const body: Obj = {
      id,
      laneId: age.laneId,
      type: 'event',
      name: event.name,
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
      target: { writes, link: { ...link, eventId: id } },
      ctx: baseCtx({ [event.id]: event.raw }),
      summary: `${SYNC_TOOL}: make the ${age.name} event for “${row.dateText}” again as a single date`,
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
    target: { writes, link: { ...link, eventId: event.id } },
    ctx: baseCtx({ [event.id]: event.raw }),
    summary: `${SYNC_TOOL}: correct the ${age.name} event for “${row.dateText}” (${changes.map((x) => x.field).join(', ')})`,
    head: head('correct'),
    markdown: { before, after },
  };
}
