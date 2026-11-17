/**
 * An event without a row (v2 E6, "Chronology II", ADR 0048): the chronology check's `event_without_row` has a fix.
 *
 * The table is the authority, so an event no row of its age's table accounts for is deleted, after the owner has seen
 * it. This plans that delete for ONE event: only the event, never a row (it has none) and never the Main count (the
 * count is the table's row count). The proposal names the event, its date, and the rows nearest it by date (up to 3,
 * with their opening words) so the owner can see what replaced it.
 *
 * It is refused when the event is paired with a row after all (`EVENT_HAS_ROW`: delete_timeline_event without `orphan`
 * deletes both, sync_timeline_event repairs a mismatch), or when an unpaired row could be its own (`PAIRING_AMBIGUOUS`:
 * pair them with sync_timeline_event and `event_id`). Inside the lock the age table must still have no such row (a row
 * edited or added since to match the event ends the proposal `conflicted`), and the event must still be exactly as read.
 *
 * Canon (ADR 0036 decision 6, option (a)): deleting an event of an Authoritative page is an ordinary content edit. The
 * delete is journalled with the event as its pre-image (the registry's `deleteEvent`).
 */
import { createHash } from 'node:crypto';
import type { Calendar } from '../calendar/index.js';
import {
  candidateRowView,
  couldBeRowOf,
  dateOfEvent,
  eventText,
  listRows,
  matchRowsAndEvents,
  nearestRows,
  openingWords,
  readEvents,
  type CheckReader,
  type TimelineEvent,
} from './check.js';
import type { WriteContext } from './plan.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import {
  currentTableOnly,
  type ChronologyLink,
  type ChronologyTarget,
  type TableOnlyMark,
  type TargetWrite,
} from './store.js';
import type { SyncRefusal } from './sync.js';
import { readAgeTable, type AgeRow, type AgeTable } from './table.js';

type Obj = Record<string, unknown>;

/** The record's tool: the MCP tool that does the same (`delete_timeline_event` with `orphan: true`). */
export const ORPHAN_TOOL = 'delete_timeline_event' as const;

export interface OrphanRef {
  readonly eventId: string;
  /** The age whose timeline holds it (name or era abbreviation); every age is searched when absent. */
  readonly age?: string;
}

export interface OrphanPlan {
  readonly ok: true;
  readonly age: AgeConfig;
  readonly table: AgeTable;
  readonly event: TimelineEvent;
  /** The rows nearest the event by date (up to 3), with their opening words. */
  readonly nearest: readonly { rowId: string | null; date: string; words: string }[];
  readonly writes: readonly TargetWrite[];
  readonly target: ChronologyTarget;
  readonly ctx: WriteContext;
  readonly requestKey: string;
  readonly summary: string;
  readonly head: Obj;
  readonly markdown: { readonly before: string; readonly after: string };
}

const refuse = (code: string, message: string, details: Obj = {}): SyncRefusal => ({
  ok: false,
  code,
  message,
  details,
});

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function orphanRequestKey(ref: OrphanRef): string {
  return createHash('sha256')
    .update(JSON.stringify({ tool: ORPHAN_TOOL, orphan: true, eventId: ref.eventId }))
    .digest('hex')
    .slice(0, 32);
}

/** A row that could be this event's own: the same date, the same start, or the event names it (in check.ts since v3 F2.1). */
export { couldBeRowOf } from './check.js';

const rowView = (r: AgeRow) => ({
  id: r.id,
  date: r.dateText,
  words: openingWords(r.description),
});

/** Plans the delete of ONE event without a row (see the module comment). Throws what `read` throws. */
export async function planOrphanDelete(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly links: readonly ChronologyLink[];
  readonly tableOnly?: readonly TableOnlyMark[];
  readonly ref: OrphanRef;
}): Promise<OrphanPlan | SyncRefusal> {
  const c = o.config;
  const resourceId = c.resourceId!;
  let ages = c.ages;
  if (o.ref.age !== undefined) {
    const k = norm(o.ref.age);
    const a =
      c.ages.find((x) => norm(x.name) === k) ??
      c.ages.find((x) => norm(o.calendar.engine.eras.find((e) => e.id === x.eraId)?.abbr ?? '') === k);
    if (!a)
      return refuse('AGE_NOT_FOUND', `No age of the chronology is named “${o.ref.age}”.`, {
        ages: c.ages.map((x) => x.name),
      });
    ages = [a];
  }
  let age: AgeConfig | null = null;
  let events: TimelineEvent[] = [];
  for (const a of ages) {
    const es = (await readEvents(o.read, resourceId, a.timelineDocumentId)).filter(
      (e) => e.laneId === a.laneId,
    );
    if (es.some((e) => e.id === o.ref.eventId)) {
      age = a;
      events = es;
      break;
    }
  }
  if (!age)
    return refuse(
      'EVENT_NOT_FOUND',
      `No age timeline of the chronology has an event ${o.ref.eventId}${o.ref.age ? ` (looked in ${ages[0]!.name})` : ''}.`,
    );
  const event = events.find((e) => e.id === o.ref.eventId)!;
  const blocks = (await o.read('getDocumentBlocks', {
    path: { resourceId, documentId: age.tableDocumentId },
  })) as { blocks?: unknown[] } | undefined;
  const table = readAgeTable(blocks?.blocks ?? [], o.calendar.parser, c.style.date, c.columns);
  if (!table)
    return refuse(
      'CHRONOLOGY_CHANGED',
      `The ${age.name} table document has no table with the columns ${c.columns.event} | ${c.columns.date} | ${c.columns.kcy}.`,
    );
  const marks = currentTableOnly(
    table.rows,
    (o.tableOnly ?? []).filter((m) => m.tableDocumentId === age.tableDocumentId),
  );
  const links = o.links.filter((l) => l.tableDocumentId === age.tableDocumentId);
  const pairing = matchRowsAndEvents(table.rows, events, links, age, {
    tableOnly: marks.current,
    kcyOf: (m) => o.calendar.engine.kcyOf(m),
  });
  const pair = pairing.pairs.find((p) => p.event === event);
  if (pair)
    return refuse(
      'EVENT_HAS_ROW',
      `The event “${event.name.slice(0, 80)}” is the row “${pair.row.dateText}”’s (${openingWords(pair.row.description)}); it is not an event without a row. To delete both, use delete_timeline_event without orphan. Nothing was done.`,
      { row: rowView(pair.row) },
    );
  const mismatch = pairing.mismatches.find((m) => m.event === event);
  if (mismatch)
    return refuse(
      'EVENT_HAS_ROW',
      `The event “${event.name.slice(0, 80)}” is the row “${mismatch.row.dateText}”’s (paired by ${mismatch.by}), with another date: repair it with sync_timeline_event. Nothing was done.`,
      { row: rowView(mismatch.row), pairedBy: mismatch.by },
    );
  const ev = { ...dateOfEvent(event), name: event.name };
  // An unpaired row that could be its own (the same date, the same start or the name; a row whose date cannot be read
  // by its name only): never deleted beside a possible pair.
  const candidates = pairing.rows.filter((r) => couldBeRowOf(r, ev));
  if (candidates.length > 0)
    return refuse(
      'PAIRING_AMBIGUOUS',
      // v3 F2.1: the event is caught in a tie (the check reports it as "Event in a tie"), not an orphan.
      `This event is not an orphan: ${candidates.length} row${candidates.length === 1 ? '' : 's'} of the table could be its own (${listRows(candidates)}). Pair it with one instead of deleting it: sync_timeline_event with the row and event_id ${event.id}. The event is “${event.name.slice(0, 80)}” (${eventText(event)}). Nothing was done.`,
      {
        event: { id: event.id, name: event.name, date: eventText(event) },
        candidates: candidates.map(rowView),
        candidateRows: candidates.map(candidateRowView),
      },
    );
  // Rows that look like its own but belong elsewhere (paired with another event, or table-only): they may stay as they
  // are; any other row that comes to match it before the approval stops the delete.
  const ignore = table.rows
    .filter((r) => r.id !== null && couldBeRowOf(r, ev))
    .map((r) => ({ rowId: r.id!, texts: { description: r.description, date: r.dateText, kcy: r.kcyText } }));
  const nearest = nearestRows(table.rows, event.start);
  // CR-2026-11-R2 (R2-09): an unpaired row whose Date cell cannot be read has no date to compare, so it is matched by
  // its name only (`couldBeRowOf`), and it is never among the rows nearest by date. The owner sees each such row in the
  // proposal: the bridge cannot rule out that it is this event's own (marking it table-only says it is not).
  const unreadable = pairing.rows
    .filter((r) => r.eventDate === null)
    .map((r) => ({ rowId: r.id, date: r.dateText, words: openingWords(r.description) }));
  const link = links.find((l) => l.eventId === event.id) ?? null;
  const writes: TargetWrite[] = [
    {
      kind: 'row.orphan',
      age: age.name,
      resourceId,
      documentId: age.tableDocumentId,
      event: { start: ev.start, end: ev.end, detail: ev.detail, name: event.name },
      ignore,
    },
    {
      kind: 'event.delete',
      age: age.name,
      resourceId,
      documentId: age.timelineDocumentId,
      eventId: event.id,
    },
  ];
  const target: ChronologyTarget = {
    writes,
    ...(link ? { unlink: { tableDocumentId: link.tableDocumentId, rowId: link.rowId } } : {}),
  };
  const ctx: WriteContext = {
    tableIds: { [age.tableDocumentId]: table.table.id ?? '' },
    mainTableId: '',
    rows: {},
    counts: {},
    lanes: { [age.timelineDocumentId]: { id: age.laneId, name: age.laneName } },
    events: { [event.id]: event.raw },
  };
  const date = eventText(event);
  const near = nearest.map((n) => `- ${n.date}: ${n.words}`);
  const unread =
    unreadable.length > 0
      ? [
          '',
          `## ${age.name} - Table (rows whose date cannot be read: one could be this event's)`,
          ...unreadable.map((n) => `- ${n.date || '(empty)'}: ${n.words}`),
        ]
      : [];
  const lane = `## ${age.name} - Timeline (${age.laneName})`;
  const summary = `${ORPHAN_TOOL}: delete the ${age.name} event “${openingWords(event.name, 12)}” (${date}), which has no table row`;
  return {
    ok: true,
    age,
    table,
    event,
    nearest,
    writes,
    target,
    ctx,
    requestKey: orphanRequestKey(o.ref),
    summary,
    head: {
      action: 'delete_orphan',
      age: age.name,
      event: { id: event.id, name: event.name.slice(0, 200), date, start: event.start, uri: event.uri },
      nearest,
      ...(unreadable.length > 0
        ? {
            unreadable,
            unreadableNote:
              'These rows of the table have a Date the bridge cannot read, so it cannot tell whether one is this event’s own. Check them before approving; mark a row table-only if it has no event.',
          }
        : {}),
      note: 'Only the timeline event is deleted: the table (the authority) has no row for it, and the Main count (the table’s row count) does not change. The journal keeps the event.',
    },
    markdown: {
      before: [
        lane,
        `- ${date}: **${event.name}**`,
        '',
        `## ${age.name} - Table (the nearest rows)`,
        ...near,
        ...unread,
      ].join('\n'),
      after: [lane, '- (deleted)', '', `## ${age.name} - Table (the nearest rows)`, ...near, ...unread].join(
        '\n',
      ),
    },
  };
}
