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
import { buildJob, EVENT_STORED_FIELDS, rowKey, type WriteContext } from '../chronology/plan.js';
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
import { compareStoredBlocks } from '../jobs/verify-blocks.js';
import { withoutVersions } from '../pages/blockwise.js';
import {
  changed,
  changedLater,
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
  ):
    | { readonly ok: true; readonly config: ChronologyConfig }
    | { readonly ok: false; readonly message: string };
  /** The calendar the bridge last read, or null (then it is read: `listCalendars`). */
  calendar(projectId: string, calendarId?: string): Calendar | null;
  remember(projectId: string, definition: Obj): Calendar;
  /** v3 F12 follow-up: the bridge's links between rows and events (a link-only change's Revert checks its own). */
  readonly store?: {
    links(projectId: string, tableDocumentId?: string): readonly { rowId: string; eventId: string }[];
  };
}

const same = (r: AgeRow, t: { description: string; date: string; kcy: string }) =>
  sameText(r.description, t.description) &&
  r.dateText.trim() === t.date.trim() &&
  r.kcyText.trim() === t.kcy.trim();

const rowLine = (t: { description: string; date: string; kcy: string }) =>
  `${t.description} | ${t.date} | ${t.kcy}`;

/**
 * CR-2026-11-R2 (R2-16): a row compared whole with a block (as a verify compares blocks: links, marks and inline icons
 * count), never by its words alone. No block to compare with: not the same.
 */
const sameRow = (r: AgeRow, block: Obj | undefined): boolean =>
  block !== undefined && compareStoredBlocks([block], withoutVersions([r.row.block])).ok;

/** CR-2026-11-R2 (R2-16): an event compared by every stored field (colour, icon, image too); unknown: not the same. */
const sameEvent = (a: Obj | null | undefined, b: Obj | null): boolean =>
  !!a && !!b && EVENT_STORED_FIELDS.every((k) => stableJson(a[k] ?? null) === stableJson(b[k] ?? null));

/** The stored fields that differ between two events (for the owner). */
const eventDiff = (left: Obj | null | undefined, now: Obj) => {
  if (!left)
    return { expected: '(the event as the job left it is not recorded)', actual: pick(now, ['name']) };
  const keys = EVENT_STORED_FIELDS.filter((k) => stableJson(left[k] ?? null) !== stableJson(now[k] ?? null));
  return { expected: pick(left, keys), actual: pick(now, keys) };
};

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

  // v3 F12 follow-up (ADR 0081 amendment 1, decision 3): a link-only change: its link taken off, while it is still the
  // one the change recorded (the row paired with that event); no LegendKeeper write.
  if (t.linkOnly) {
    const l = t.linkOnly;
    if (!ch.store) return notRevertible(t, 'the chronology’s links cannot be read on this bridge');
    const now = ch.store.links(projectId, l.tableDocumentId).find((x) => x.rowId === l.rowId);
    if (!now) return nothing(t, 'the row is no longer linked to an event');
    if (now.eventId !== l.eventId)
      return changed(t, 'the row has been linked to another event since', [
        {
          path: `${l.age} row ${l.rowId}`,
          expected: `linked to ${l.eventId}`,
          actual: `linked to ${now.eventId}`,
        },
      ]);
    const built = buildJob({
      tool: 'job_revert',
      config,
      target: { writes: [], unlink: { tableDocumentId: l.tableDocumentId, rowId: l.rowId } },
      writes: [],
      ctx: {
        rowBlocks: {},
        exactEvents: true,
        tableIds: {},
        mainTableId: '',
        rows: {},
        counts: {},
        lanes: {},
        events: {},
      },
      record: {
        requestKey: `${REVERT_TOOL}:${io.jobId}`,
        ages: record.ages,
        summary: `Revert of: ${record.summary}`.slice(0, 500),
      },
    });
    return {
      check: {
        key: t.key,
        kind: t.kind,
        page: t.page,
        what: t.what,
        state: 'ready',
        detail: 'the link between the row and the event taken off',
      },
      // No LegendKeeper write, so no check or verify of one: the record's begin and complete (which takes the link off).
      steps: built.steps
        .filter((s) => s.op === 'bridge.record')
        .map((s) =>
          s.journalOperation
            ? { ...s, journalOperation: { ...s.journalOperation, revertOf: io.jobId, target: t.key } }
            : s,
        ),
      resources: [resourceId],
      documents: built.holdDocuments,
    };
  }

  // The documents as they are now.
  const tables = new Map<string, AgeTable>();
  for (const doc of [
    ...new Set(t.inverse.filter((w) => w.kind.startsWith('row.')).map((w) => w.documentId)),
  ]) {
    const r = await io.read('getDocumentBlocks', { path: { resourceId, documentId: doc } });
    if (!r.exists) return gone(t, 'an age table document is gone');
    const blocks = (r.body as { blocks?: unknown } | undefined)?.blocks;
    const table = readAgeTable(
      Array.isArray(blocks) ? (blocks as unknown[]) : [],
      cal.parser,
      config.style.date,
      config.columns,
    );
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
    const r = await io.read('getEvent', {
      path: { resourceId, documentId: w.documentId, eventId: w.eventId },
    });
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
      const asLeft = row !== null && sameRow(row, t.leftRows[rowKey(w.documentId, w.rowId)]);
      atBefore.push(row === null);
      atLeft.push(asLeft);
      if (row && !asLeft)
        diffs.push({
          path: `${w.age} row ${w.rowId}`,
          expected: rowLine(w.texts),
          actual: same(row, w.texts)
            ? `${rowLine(texts(row))} (other links, marks or icons)`
            : rowLine(texts(row)),
        });
    } else if (w.kind === 'row.replace') {
      const row = tables.get(w.documentId)?.rows.find((r) => r.id === w.rowId) ?? null;
      const asLeft = row !== null && sameRow(row, t.leftRows[rowKey(w.documentId, w.rowId)]);
      const asBefore = row !== null && sameRow(row, t.oldRows[rowKey(w.documentId, w.rowId)]);
      atBefore.push(asBefore);
      atLeft.push(asLeft);
      if (!row)
        diffs.push({ path: `${w.age} row ${w.rowId}`, expected: rowLine(w.before), actual: '(gone)' });
      else if (!asLeft && !asBefore)
        diffs.push({
          path: `${w.age} row ${w.rowId}`,
          expected: rowLine(w.before),
          actual: same(row, w.before)
            ? `${rowLine(texts(row))} (other links, marks or icons)`
            : rowLine(texts(row)),
        });
    } else if (w.kind === 'row.insert') {
      // A row the change moved to another age: gone from its old table now, back there once reverted.
      const row = tables.get(w.documentId)?.rows.find((r) => r.id === w.rowId) ?? null;
      atBefore.push(
        row !== null && (sameRow(row, t.oldRows[rowKey(w.documentId, w.rowId)]) || same(row, w.texts)),
      );
      atLeft.push(row === null);
      if (row && !same(row, w.texts))
        diffs.push({
          path: `${w.age} row ${w.rowId}`,
          expected: '(moved away by the change)',
          actual: rowLine(texts(row)),
        });
    } else if (w.kind === 'event.create') {
      atBefore.push(false);
      atLeft.push(oldGone.get(w.eventId) === true);
      if (oldGone.get(w.eventId) !== true)
        diffs.push({ path: `${w.age} event`, expected: '(deleted by the change)', actual: 'present' });
    } else if (w.kind === 'event.delete') {
      const e = events.get(w.eventId) ?? null;
      const fieldsOk = sameEvent(t.leftEvents[w.eventId], e);
      atBefore.push(e === null);
      atLeft.push(fieldsOk);
      if (e && !fieldsOk)
        diffs.push({ path: `${w.age} event ${w.eventId}`, ...eventDiff(t.leftEvents[w.eventId], e) });
    } else if (w.kind === 'event.update') {
      const e = events.get(w.eventId) ?? null;
      const want = t.leftEvents[w.eventId] ?? {};
      const leftOk = sameEvent(t.leftEvents[w.eventId], e);
      const backOk =
        e !== null &&
        Object.entries(w.fields).every(([k, v]) => stableJson(e[k] ?? null) === stableJson(v ?? null));
      atBefore.push(backOk);
      atLeft.push(leftOk);
      if (!e) diffs.push({ path: `${w.age} event ${w.eventId}`, expected: want, actual: '(gone)' });
      else if (!leftOk && !backOk)
        diffs.push({ path: `${w.age} event ${w.eventId}`, ...eventDiff(t.leftEvents[w.eventId], e) });
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
  if (atBefore.length > 0 && atBefore.every(Boolean))
    return nothing(t, 'the chronology is already as it was before the job');
  if (!atLeft.every(Boolean))
    return changed(
      t,
      'the chronology has changed since the job (an outside edit is never overwritten)',
      diffs,
    );
  if (t.laterWrite) return changedLater(t);

  // The context the chronology's job builder needs, from the documents as read now.
  const rows: Record<string, WriteContext['rows'][string]> = {};
  const moves = new Set<string>();
  for (const w of t.inverse) {
    if (w.kind !== 'row.replace' && w.kind !== 'row.insert') continue;
    const table = tables.get(w.documentId)!;
    const old = t.oldRows[rowKey(w.documentId, w.rowId)];
    if (!old) return notRevertible(t, `the row ${w.rowId} as it was is not recorded`);
    const synthetic = { ...table.table.block, children: [table.table.header.block, old] };
    const parsed = readAgeTable([synthetic], cal.parser, config.style.date, config.columns)?.rows[0];
    const date = parsed?.date ?? parsed?.eventDate ?? null;
    if (!parsed || !date)
      return notRevertible(t, `the row’s old date “${w.texts.date}” cannot be read by the calendar`);
    rows[rowKey(w.documentId, w.rowId)] = {
      sortKey: sortKey(date),
      date: { start: date.start, end: date.end, detail: date.detail },
      description: parsed.description,
    };
    if (w.kind === 'row.replace' && w.texts.date.trim() !== w.before.date.trim())
      moves.add(rowKey(w.documentId, w.rowId));
  }
  const tableIds: Record<string, string> = {};
  for (const [doc, table] of tables) tableIds[doc] = table.table.id ?? '';
  const counts: Record<string, { paragraphId: string; text: string; age: string }> = {};
  for (const r of main?.rows ?? [])
    if (r.id && r.countCell?.paragraphId)
      counts[r.id] = { paragraphId: r.countCell.paragraphId, text: r.countText, age: r.age };
  const lanes: Record<string, { id: string; name: string }> = {};
  for (const a of config.ages) lanes[a.timelineDocumentId] = { id: a.laneId, name: a.laneName };
  const eventsNow: Record<string, Obj> = {};
  for (const [id, e] of events) if (e) eventsNow[id] = e;
  // CR-2026-11-R2 (R2-16): inside the lock, each row the revert deletes or writes back must still be exactly the block read
  // now (which is the job's, as checked above), and each event every stored field it has now.
  const rowBlocks: Record<string, Obj> = {};
  for (const w of t.inverse) {
    if (w.kind !== 'row.delete' && w.kind !== 'row.replace') continue;
    const row = tables.get(w.documentId)?.rows.find((r) => r.id === w.rowId);
    if (row) rowBlocks[rowKey(w.documentId, w.rowId)] = withoutVersions([row.row.block])[0]!;
  }
  const ctx: WriteContext = {
    rowBlocks,
    exactEvents: true,
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
      (w) =>
        (w.kind === 'event.delete' && w.eventId === link.eventId) ||
        (w.kind === 'row.delete' && w.rowId === link.rowId),
    );
  // An event made once more pairs with the row it belonged to (the row put back, or the row the change rewrote).
  const remade = t.inverse.find((w) => w.kind === 'event.create');
  const rowBack = t.inverse.find((w) => w.kind === 'row.insert' || w.kind === 'row.replace');
  const relink =
    remade &&
    remade.kind === 'event.create' &&
    rowBack &&
    (rowBack.kind === 'row.insert' || rowBack.kind === 'row.replace')
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
    ...(unlinks &&
    link &&
    !(relink && relink.tableDocumentId === link.tableDocumentId && relink.rowId === link.rowId)
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
    s.journalOperation
      ? { ...s, journalOperation: { ...s.journalOperation, revertOf: io.jobId, target: t.key } }
      : s,
  );
  return {
    check: {
      key: t.key,
      kind: t.kind,
      page: t.page,
      what: t.what,
      state: 'ready',
      detail: built.labels
        .filter((l) => !['check', 'record', 'verify', 'record complete'].includes(l))
        .join('; '),
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
