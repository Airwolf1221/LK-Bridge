/**
 * The revert of a direct chronology change (v3 F3.4, ADR 0055 decision B): its table rows and timeline events kept in
 * step, as the chronology tools keep them. The change's record holds what it wrote (its "target"); its inverse
 * (src/review/targets.ts: an added row and event deleted, a changed row and event given their old values back, the
 * Main count put back) is checked against the documents as they are now, and planned by the chronology's own job
 * builder (src/chronology/plan.ts), so the revert has the same checks inside the locks (each row where it must be, the
 * count as expected), places a row whose date goes back by that date, writes the table first, and verifies rows,
 * events and counts. It records itself as a chronology change (`job_revert`), like any other.
 */
import type { Calendar } from '../calendar/index.js';
import { buildJob, type WriteContext } from '../chronology/plan.js';
import type { ChronologyConfig } from '../chronology/settings.js';
import type { ChronologyTarget } from '../chronology/store.js';
import {
  readAgeTable,
  readMainTable,
  sameText,
  sortKey,
  type AgeRow,
  type AgeTable,
  type MainTable,
} from '../chronology/table.js';
import { stableJson } from '../jobs/sidebar-state.js';
import {
  changed,
  gone,
  nothing,
  notRevertible,
  REVERT_TOOL,
  type Difference,
  type PlanIo,
  type TargetPlan,
} from './revert-plan.js';
import type { ChronologyUnitTarget } from './targets.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the revert needs of the chronology service. */
export interface ChronologyAccess {
  readiness(
    projectId: string,
  ): { readonly ok: true; readonly config: ChronologyConfig } | { readonly ok: false; readonly message: string };
  /** The calendar the bridge last read, or null (then it is read: `listCalendars`). */
  calendar(projectId: string, calendarId?: string): Calendar | null;
  remember(projectId: string, definition: Obj): Calendar;
}

const EVENT_FIELDS = ['name', 'start', 'end', 'detail', 'laneId', 'uri'] as const;

const same = (r: AgeRow, t: { description: string; date: string; kcy: string }) =>
  sameText(r.description, t.description) && r.dateText.trim() === t.date.trim() && r.kcyText.trim() === t.kcy.trim();

const rowLine = (t: { description: string; date: string; kcy: string }) => `${t.description} | ${t.date} | ${t.kcy}`;

export async function planChronology(
  t: ChronologyUnitTarget,
  io: PlanIo,
  projectId: string,
  ch: ChronologyAccess | undefined,
): Promise<TargetPlan> {
  if (!ch) return notRevertible(t, 'chronology sync is not available on this bridge');
  const ready = ch.readiness(projectId);
  if (!ready.ok) return notRevertible(t, `the chronology is not ready: ${ready.message}`);
  const config = ready.config;
  if (!config.resourceId || !config.mainDocumentId || !config.calendarId)
    return notRevertible(t, 'the chronology is not confirmed');
  const resourceId = config.resourceId;
  let cal = ch.calendar(projectId, config.calendarId);
  if (!cal) {
    const r = await io.read('listCalendars', {});
    const data = (r.body as { data?: unknown } | undefined)?.data;
    const def = (Array.isArray(data) ? (data as Obj[]) : []).find((c) => c.id === config.calendarId);
    if (!def) return notRevertible(t, 'the chronology’s calendar is gone');
    cal = ch.remember(projectId, def);
  }
  const record = t.record;
  // The job's own writes (what it left), by row and by event.
  const jobRows = new Map<string, { description: string; date: string; kcy: string }>();
  const jobEvents = new Map<string, Obj>();
  for (const w of record.target.writes) {
    if (w.kind === 'row.insert' || w.kind === 'row.replace') jobRows.set(w.rowId, w.texts);
    if (w.kind === 'event.create')
      jobEvents.set(
        w.eventId,
        Object.fromEntries(EVENT_FIELDS.filter((k) => w.body[k] !== undefined).map((k) => [k, w.body[k]])),
      );
    if (w.kind === 'event.update') jobEvents.set(w.eventId, { ...w.fields });
  }

  // The documents as they are now.
  const tables = new Map<string, AgeTable>();
  for (const doc of [...new Set(t.inverse.filter((w) => w.kind.startsWith('row.')).map((w) => w.documentId))]) {
    const r = await io.read('getDocumentBlocks', { path: { resourceId, documentId: doc } });
    if (!r.exists) return gone(t, 'an age table document is gone');
    const blocks = (r.body as { blocks?: unknown } | undefined)?.blocks;
    const table = readAgeTable(Array.isArray(blocks) ? (blocks as unknown[]) : [], cal.parser, config.style.date, config.columns);
    if (!table) return notRevertible(t, 'an age table document has no chronology table now');
    tables.set(doc, table);
  }
  let main: MainTable | null = null;
  if (t.inverse.some((w) => w.kind === 'count')) {
    const r = await io.read('getDocumentBlocks', { path: { resourceId, documentId: config.mainDocumentId } });
    if (!r.exists) return gone(t, 'the Main document is gone');
    const blocks = (r.body as { blocks?: unknown } | undefined)?.blocks;
    main = readMainTable(Array.isArray(blocks) ? (blocks as unknown[]) : [], config.columns);
    if (!main) return notRevertible(t, 'the Main document has no Main table now');
  }
  const events = new Map<string, Obj | null>();
  for (const w of t.inverse) {
    if ((w.kind !== 'event.delete' && w.kind !== 'event.update') || events.has(w.eventId)) continue;
    const r = await io.read('getEvent', { path: { resourceId, documentId: w.documentId, eventId: w.eventId } });
    events.set(w.eventId, r.exists && isObj(r.body) ? r.body : null);
  }
  // An event the change deleted and made again: the old one must still be gone (it is made once more, as it was).
  const oldGone = new Map<string, boolean>();
  for (const w of t.inverse) {
    if (w.kind !== 'event.create') continue;
    const old = t.oldEvents[w.eventId];
    const oldId = typeof old?.id === 'string' ? old.id : null;
    if (!oldId) {
      oldGone.set(w.eventId, true);
      continue;
    }
    const r = await io.read('getEvent', { path: { resourceId, documentId: w.documentId, eventId: oldId } });
    oldGone.set(w.eventId, !r.exists);
  }

  // Each part as the job left it (ready), already back (nothing to do), or changed since (an outside edit).
  const atLeft: boolean[] = [];
  const atBefore: boolean[] = [];
  const diffs: Difference[] = [];
  for (const w of t.inverse) {
    if (w.kind === 'row.delete') {
      const row = tables.get(w.documentId)?.rows.find((r) => r.id === w.rowId) ?? null;
      atBefore.push(row === null);
      atLeft.push(row !== null && same(row, w.texts));
      if (row && !same(row, w.texts))
        diffs.push({ path: `${w.age} row ${w.rowId}`, expected: rowLine(w.texts), actual: rowLine(texts(row)) });
    } else if (w.kind === 'row.replace') {
      const row = tables.get(w.documentId)?.rows.find((r) => r.id === w.rowId) ?? null;
      atBefore.push(row !== null && same(row, w.texts));
      atLeft.push(row !== null && same(row, w.before));
      if (!row) diffs.push({ path: `${w.age} row ${w.rowId}`, expected: rowLine(w.before), actual: '(gone)' });
      else if (!same(row, w.before) && !same(row, w.texts))
        diffs.push({ path: `${w.age} row ${w.rowId}`, expected: rowLine(w.before), actual: rowLine(texts(row)) });
    } else if (w.kind === 'row.insert') {
      // A row the change moved to another age: gone from its old table now, back there once reverted.
      const row = tables.get(w.documentId)?.rows.find((r) => r.id === w.rowId) ?? null;
      atBefore.push(row !== null && same(row, w.texts));
      atLeft.push(row === null);
      if (row && !same(row, w.texts))
        diffs.push({ path: `${w.age} row ${w.rowId}`, expected: '(moved away by the change)', actual: rowLine(texts(row)) });
    } else if (w.kind === 'event.create') {
      atBefore.push(false);
      atLeft.push(oldGone.get(w.eventId) === true);
      if (oldGone.get(w.eventId) !== true)
        diffs.push({ path: `${w.age} event`, expected: '(deleted by the change)', actual: 'present' });
    } else if (w.kind === 'event.delete') {
      const e = events.get(w.eventId) ?? null;
      const want = jobEvents.get(w.eventId) ?? {};
      const fieldsOk = e !== null && Object.entries(want).every(([k, v]) => stableJson(e[k] ?? null) === stableJson(v ?? null));
      atBefore.push(e === null);
      atLeft.push(fieldsOk);
      if (e && !fieldsOk) diffs.push({ path: `${w.age} event ${w.eventId}`, expected: want, actual: pick(e, Object.keys(want)) });
    } else if (w.kind === 'event.update') {
      const e = events.get(w.eventId) ?? null;
      const want = jobEvents.get(w.eventId) ?? {};
      const leftOk = e !== null && Object.entries(want).every(([k, v]) => stableJson(e[k] ?? null) === stableJson(v ?? null));
      const backOk = e !== null && Object.entries(w.fields).every(([k, v]) => stableJson(e[k] ?? null) === stableJson(v ?? null));
      atBefore.push(backOk);
      atLeft.push(leftOk);
      if (!e) diffs.push({ path: `${w.age} event ${w.eventId}`, expected: want, actual: '(gone)' });
      else if (!leftOk && !backOk) diffs.push({ path: `${w.age} event ${w.eventId}`, expected: want, actual: pick(e, Object.keys(want)) });
    } else if (w.kind === 'count') {
      const seen = record.observed.counts?.[w.rowId];
      const row = main?.rows.find((r) => r.id === w.rowId) ?? null;
      if (!seen) {
        atBefore.push(false);
        atLeft.push(true); // not recorded: the in-lock check takes the count as it then is
        continue;
      }
      atBefore.push(row?.count === seen.before);
      atLeft.push(row?.count === seen.after);
      if (row?.count !== seen.after && row?.count !== seen.before)
        diffs.push({ path: `${w.age} count`, expected: seen.after, actual: row?.countText ?? '(gone)' });
    }
  }
  if (atBefore.length > 0 && atBefore.every(Boolean)) return nothing(t, 'the chronology is already as it was before the job');
  if (!atLeft.every(Boolean))
    return changed(t, 'the chronology has changed since the job (an outside edit is never overwritten)', diffs);

  // The context the chronology's job builder needs, from the documents as read now.
  const rows: Record<string, WriteContext['rows'][string]> = {};
  const moves = new Set<string>();
  for (const w of t.inverse) {
    if (w.kind !== 'row.replace' && w.kind !== 'row.insert') continue;
    const table = tables.get(w.documentId)!;
    const old = t.oldRows[w.rowId];
    if (!old) return notRevertible(t, `the row ${w.rowId} as it was is not recorded`);
    const synthetic = { ...table.table.block, children: [table.table.header.block, old] };
    const parsed = readAgeTable([synthetic], cal.parser, config.style.date, config.columns)?.rows[0];
    const date = parsed?.date ?? parsed?.eventDate ?? null;
    if (!parsed || !date) return notRevertible(t, `the row’s old date “${w.texts.date}” cannot be read by the calendar`);
    rows[w.rowId] = {
      sortKey: sortKey(date),
      date: { start: date.start, end: date.end, detail: date.detail },
      description: parsed.description,
    };
    if (w.kind === 'row.replace' && w.texts.date.trim() !== w.before.date.trim()) moves.add(w.rowId);
  }
  const tableIds: Record<string, string> = {};
  for (const [doc, table] of tables) tableIds[doc] = table.table.id ?? '';
  const counts: Record<string, { paragraphId: string; text: string; age: string }> = {};
  for (const r of main?.rows ?? [])
    if (r.id && r.countCell?.paragraphId) counts[r.id] = { paragraphId: r.countCell.paragraphId, text: r.countText, age: r.age };
  const lanes: Record<string, { id: string; name: string }> = {};
  for (const a of config.ages) lanes[a.timelineDocumentId] = { id: a.laneId, name: a.laneName };
  const eventsNow: Record<string, Obj> = {};
  for (const [id, e] of events) if (e) eventsNow[id] = e;
  const ctx: WriteContext = {
    tableIds,
    mainTableId: main?.table.id ?? '',
    rows,
    counts,
    lanes,
    events: eventsNow,
    ...(moves.size > 0 ? { moves } : {}),
  };
  const link = record.target.link ?? null;
  const unlinks =
    link !== null &&
    t.inverse.some(
      (w) => (w.kind === 'event.delete' && w.eventId === link.eventId) || (w.kind === 'row.delete' && w.rowId === link.rowId),
    );
  // An event made once more pairs with the row it belonged to (the row put back, or the row the change rewrote).
  const remade = t.inverse.find((w) => w.kind === 'event.create');
  const rowBack = t.inverse.find((w) => w.kind === 'row.insert' || w.kind === 'row.replace');
  const relink =
    remade && remade.kind === 'event.create' && rowBack && (rowBack.kind === 'row.insert' || rowBack.kind === 'row.replace')
      ? {
          age: rowBack.age,
          tableDocumentId: rowBack.documentId,
          rowId: rowBack.rowId,
          timelineDocumentId: remade.documentId,
          eventId: remade.eventId,
        }
      : null;
  const target: ChronologyTarget = {
    writes: t.inverse,
    ...(unlinks && link && !(relink && relink.tableDocumentId === link.tableDocumentId && relink.rowId === link.rowId)
      ? { unlink: { tableDocumentId: link.tableDocumentId, rowId: link.rowId } }
      : {}),
    ...(relink ? { link: relink } : {}),
  };
  const built = buildJob({
    tool: 'job_revert',
    config,
    target,
    writes: t.inverse,
    ctx,
    record: {
      requestKey: `${REVERT_TOOL}:${io.jobId}`,
      ages: record.ages,
      summary: `Revert of: ${record.summary}`.slice(0, 500),
    },
  });
  const steps = built.steps.map((s) =>
    s.journalOperation ? { ...s, journalOperation: { ...s.journalOperation, revertOf: io.jobId, target: t.key } } : s,
  );
  return {
    check: {
      key: t.key,
      kind: t.kind,
      page: t.page,
      what: t.what,
      state: 'ready',
      detail: built.labels.filter((l) => !['check', 'record', 'verify', 'record complete'].includes(l)).join('; '),
    },
    steps,
    resources: [resourceId],
    documents: built.holdDocuments,
  };
}

function texts(r: AgeRow) {
  return { description: r.description, date: r.dateText, kcy: r.kcyText };
}

function pick(o: Obj, keys: readonly string[]): Obj {
  return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
}
