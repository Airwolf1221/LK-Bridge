/**
 * v2 D1 (ADR 0038), opt-in and READ-ONLY: the calendar engine and the chronology checked against the real tables and
 * timelines of every age (the oracle covers 330 Fourth Age events; this covers all six ages). It writes nothing.
 *
 * Reads: the chronology's documents, the calendar, the Main table, each age's table, lanes and events (about 15 reads
 * plus one per 100 events). Checks:
 *
 * 1. every row of every age table: the Date cell parses; the engine's KCY equals the KCY cell, byte for byte (in the
 *    style the tables show most); the engine's date text equals the Date cell, or the difference is reported. Every row
 *    that fails is listed with its exact text, and the distinct shapes of the Date and KCY cells are summarised;
 * 2. every timeline event: the engine reads LegendKeeper's formattedStart (and formattedEnd) to exactly its minutes and
 *    detail, and formats its minutes back to exactly that text, in LegendKeeper's own style (no thousands separator in
 *    a year: the owner's run of 11 November 2026 settled that; the tables write the separators, check 1 compares them in
 *    the table style);
 * 3. every age: every event's `uri` points at its age's table; one lane; the Main links; rows in calendar order;
 * 4. DRIFT (reported under its own heading, not as a failure of the engine): rows without an event, events without a
 *    row, a row and an event that disagree about the date (the table is the authority), and the counts. The
 *    chronology check lists the same, and "Propose a fix" repairs them.
 *
 * Two date styles (ADR 0039): LegendKeeper's, for everything compared with its event text; the table's, for the Date and
 * KCY cells. The report says what the owner sends back; anything it finds becomes a follow-up.
 */
import {
  createCalendar,
  describeReading,
  formatKcy,
  parseKcyCell,
  type Calendar,
} from '../../src/calendar/index.js';
import {
  AGE_COLUMNS,
  MAIN_COLUMNS,
  cellShape,
  detectStyle,
  outOfOrder,
  readAgeTable,
  readMainTable,
  type AgeTable,
} from '../../src/chronology/table.js';
import {
  eventText,
  matchRowsAndEvents,
  readEvents,
  uriPointsAt,
  type CheckReader,
} from '../../src/chronology/check.js';

type Obj = Record<string, unknown>;

export interface ChronologyReport {
  readonly text: string;
  /** Problems of the engine, its styles or the chronology's structure: the check FAILs on these. */
  readonly failures: readonly string[];
  /** Table and timeline drift (the table is the authority): reported, repaired by sync_timeline_event, not a failure. */
  readonly drift: readonly string[];
  readonly reads: number;
}

export async function runChronologySandbox(o: {
  readonly read: CheckReader;
  /** The chronology resource (the test world's Universal Chronology). */
  readonly resourceId: string;
  readonly names?: { readonly main?: string; readonly table?: string; readonly timeline?: string };
}): Promise<ChronologyReport> {
  let reads = 0;
  const read: CheckReader = async (op, params) => {
    reads++;
    return o.read(op, params);
  };
  const lines: string[] = [];
  const failures: string[] = [];
  const drift: string[] = [];
  const out = (s = '') => lines.push(s);
  const fail = (s: string) => {
    failures.push(s);
    out(`  FAIL ${s}`);
  };
  const driftFound = (s: string) => {
    drift.push(s);
    out(`  DRIFT ${s}`);
  };
  const tableSuffix = o.names?.table ?? ' - Table';
  const timelineSuffix = o.names?.timeline ?? ' - Timeline';
  const mainName = o.names?.main ?? 'Main';
  out('# Chronology sandbox check (read-only)');
  out();
  const docs =
    ((await read('listDocuments', { path: { resourceId: o.resourceId } })) as { data?: Obj[] } | undefined)
      ?.data ?? [];
  const live = docs.filter((d) => !d.deletedAt);
  const main = live.find((d) => d.name === mainName);
  const ages: { name: string; table: Obj; timeline: Obj }[] = [];
  for (const d of live) {
    const name = typeof d.name === 'string' ? d.name : '';
    if (!name.endsWith(tableSuffix)) continue;
    const age = name.slice(0, -tableSuffix.length);
    const tl = live.find((x) => x.name === `${age}${timelineSuffix}`);
    if (tl) ages.push({ name: age, table: d, timeline: tl });
    else fail(`${age}: no “${age}${timelineSuffix}” document.`);
  }
  out(
    `Chronology ${o.resourceId}: ${live.length} documents; Main ${main ? String(main.id) : '(missing)'}; ages: ${ages.map((a) => a.name).join(', ')}.`,
  );
  if (!main || ages.length === 0) {
    fail('The chronology has no Main document or no ages.');
    return { text: lines.join('\n'), failures, drift, reads };
  }
  // The calendar of the timelines.
  const tdoc = (await read('getDocument', {
    path: { resourceId: o.resourceId, documentId: String(ages[0]!.timeline.id) },
  })) as Obj | undefined;
  const calendars = ((await read('listCalendars', {})) as { data?: Obj[] } | undefined)?.data ?? [];
  const def = calendars.find((c) => c.id === tdoc?.calendarId);
  if (!def) {
    fail(`The timelines' calendar ${String(tdoc?.calendarId)} was not found.`);
    return { text: lines.join('\n'), failures, drift, reads };
  }
  const cal: Calendar = createCalendar(def);
  out(
    `Calendar ${cal.engine.id} “${cal.engine.name}”: eras ${cal.engine.eras.map((e) => e.abbr).join(', ')}; formats day “${cal.engine.formatText.day}”, month “${cal.engine.formatText.month}”, year “${cal.engine.formatText.year}”.`,
  );
  const mainBlocks =
    (
      (await read('getDocumentBlocks', {
        path: { resourceId: o.resourceId, documentId: String(main.id) },
      })) as { blocks?: unknown[] } | undefined
    )?.blocks ?? [];
  const mainTable = readMainTable(mainBlocks, MAIN_COLUMNS);
  if (!mainTable)
    fail('The Main document has no Age | Event count | Complete dated table | Interactive timeline table.');

  // Read every age once.
  const tables: {
    name: string;
    table: AgeTable;
    events: Awaited<ReturnType<typeof readEvents>>;
    lanes: Obj[];
    tableId: string;
    timelineId: string;
  }[] = [];
  for (const a of ages) {
    const blocks =
      (
        (await read('getDocumentBlocks', {
          path: { resourceId: o.resourceId, documentId: String(a.table.id) },
        })) as { blocks?: unknown[] } | undefined
      )?.blocks ?? [];
    const t = readAgeTable(blocks, cal.parser, undefined, AGE_COLUMNS);
    const lanes =
      (
        (await read('listLanes', {
          path: { resourceId: o.resourceId, documentId: String(a.timeline.id) },
        })) as { data?: Obj[] } | undefined
      )?.data ?? [];
    const events = await readEvents(read, o.resourceId, String(a.timeline.id));
    if (!t) {
      fail(`${a.name}: no Historical Event | Date | KCY table.`);
      continue;
    }
    tables.push({
      name: a.name,
      table: t,
      events,
      lanes,
      tableId: String(a.table.id),
      timelineId: String(a.timeline.id),
    });
  }
  const style = detectStyle(tables.map((t) => t.table));
  out();
  out('## How the tables write dates and KCY values (learned from the rows)');
  const ev = (
    label: string,
    e: { value: unknown; seen: Readonly<Record<string, number>>; examples: readonly string[] },
  ) =>
    out(
      `- ${label}: ${JSON.stringify(e.value)}; seen ${JSON.stringify(e.seen)}; e.g. ${e.examples.map((x) => JSON.stringify(x)).join(', ') || '(none)'}`,
    );
  ev('date range separator', style.date.rangeSeparator);
  ev('year thousands separator', style.date.yearGrouping);
  ev('KCY thousands separator', style.kcy.grouping);
  ev('KCY minus sign', style.kcy.minus);
  ev('KCY range separator', style.kcy.rangeSeparator);
  ev('KCY of a range inside one year', style.kcy.sameYearRange);
  if (style.conflicts.length > 0) out(`- written more than one way: ${style.conflicts.join('; ')}`);
  const st = style.proposed;

  // 1. Every row.
  out();
  out('## 1. Every row of every age table');
  const dateShapes = new Map<string, number>();
  const kcyShapes = new Map<string, number>();
  const qualified: string[] = [];
  for (const t of tables) {
    let ok = 0;
    for (const r of t.table.rows) {
      const ds = cellShape(r.dateText);
      dateShapes.set(ds, (dateShapes.get(ds) ?? 0) + 1);
      const ks = cellShape(r.kcyText);
      kcyShapes.set(ks, (kcyShapes.get(ks) ?? 0) + 1);
      const where = `${t.name} row ${r.index + 1}`;
      // v2 E6 (ADR 0048): a qualified date is read by its anchor, on purpose: not an engine failure.
      if (!r.date && r.reading) {
        qualified.push(`${where}: ${JSON.stringify(r.dateText)} read as ${describeReading(r.reading)}`);
        continue;
      }
      if (!r.date) {
        fail(
          `${where}: Date ${JSON.stringify(r.dateText)} does not parse (${r.dateError?.code}: ${r.dateError?.message})`,
        );
        continue;
      }
      const reparsed = cal.parser.parse(r.dateText, st.date);
      const kcy = formatKcy(reparsed.kcy, st.kcy);
      let bad = false;
      if (kcy !== r.kcyText) {
        bad = true;
        const cell = parseKcyCell(r.kcyText);
        fail(
          `${where}: KCY ${JSON.stringify(r.kcyText)} ≠ engine ${JSON.stringify(kcy)} for ${JSON.stringify(r.dateText)}${cell ? '' : ' (the cell is not a KCY value)'}`,
        );
      }
      if (reparsed.text !== r.dateText) {
        bad = true;
        fail(
          `${where}: Date ${JSON.stringify(r.dateText)} is written ${JSON.stringify(reparsed.text)} by the engine`,
        );
      }
      if (!bad) ok++;
    }
    out(`- ${t.name}: ${t.table.rows.length} rows, ${ok} exactly as the engine writes them.`);
  }
  out(
    `- Date cell shapes: ${[...dateShapes]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${JSON.stringify(s)} ×${n}`)
      .join(', ')}`,
  );
  out(
    `- KCY cell shapes: ${[...kcyShapes]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${JSON.stringify(s)} ×${n}`)
      .join(', ')}`,
  );
  // v2 E6 (ADR 0048): qualified dates, read by their anchor (the table is never rewritten).
  out(`- Qualified dates read by their anchor: ${qualified.length}`);
  for (const q of qualified.slice(0, 100)) out(`  - ${q}`);

  // 2. Every event.
  out();
  out(
    '## 2. Every timeline event (LegendKeeper’s minutes, detail and text, in LegendKeeper’s style: no thousands separator)',
  );
  for (const t of tables) {
    let ok = 0;
    for (const e of t.events) {
      const where = `${t.name} event ${e.id} ${JSON.stringify(e.name.slice(0, 60))}`;
      const detail = (e.detail >= 1 && e.detail <= 3 ? e.detail : 3) as 1 | 2 | 3;
      let bad = false;
      const text = e.formattedEnd ? `${e.formattedStart} - ${e.formattedEnd}` : (e.formattedStart ?? '');
      try {
        const p = cal.parser.parse(text);
        if (p.start !== e.start || (p.end ?? null) !== e.end || p.detail !== detail) {
          bad = true;
          fail(
            `${where}: ${JSON.stringify(text)} reads as start ${p.start}, end ${p.end}, detail ${p.detail}; LegendKeeper has ${e.start}, ${e.end}, ${detail}`,
          );
        }
      } catch (x) {
        bad = true;
        fail(`${where}: ${JSON.stringify(text)} does not parse (${(x as Error).message})`);
      }
      // `format` is LegendKeeper's style (ADR 0039); the table style (`formatTable`) is for the Date cells only.
      const f = cal.engine.format(e.start, detail);
      if (f !== e.formattedStart) {
        bad = true;
        fail(
          `${where}: start ${e.start} formats as ${JSON.stringify(f)}; LegendKeeper shows ${JSON.stringify(e.formattedStart)}`,
        );
      }
      if (e.end !== null) {
        const g = cal.engine.format(e.end, detail);
        if (g !== e.formattedEnd) {
          bad = true;
          fail(
            `${where}: end ${e.end} formats as ${JSON.stringify(g)}; LegendKeeper shows ${JSON.stringify(e.formattedEnd)}`,
          );
        }
      }
      if (!bad) ok++;
    }
    out(`- ${t.name}: ${t.events.length} events, ${ok} exactly as LegendKeeper has them.`);
  }

  // 3. Every age: structure.
  out();
  out('## 3. Every age: lane, links, order');
  const drifts: string[] = [];
  for (const t of tables) {
    const row = mainTable?.rows.find((r) => r.age.trim().toLowerCase() === t.name.trim().toLowerCase());
    const where = t.name;
    if (t.lanes.length !== 1)
      fail(`${where}: the timeline has ${t.lanes.length} lanes (expected exactly one).`);
    if (!row) fail(`${where}: no row on the Main table.`);
    else {
      if (row.table?.documentId !== t.tableId)
        fail(`${where}: the Main table's table link points at ${row.table?.documentId ?? 'nothing'}.`);
      if (row.timeline?.documentId !== t.timelineId)
        fail(`${where}: the Main table's timeline link points at ${row.timeline?.documentId ?? 'nothing'}.`);
    }
    for (const e of t.events)
      if (!uriPointsAt(e.uri, o.resourceId, t.tableId))
        fail(`${where}: event ${e.id} links to ${e.uri ?? 'nothing'}.`);
    for (const x of outOfOrder(t.table.rows))
      fail(
        `${where}: row ${x.row.index + 1} ${JSON.stringify(x.row.dateText)} comes after row ${x.after.index + 1} ${JSON.stringify(x.after.dateText)}.`,
      );
    const lane = t.lanes[0];
    const paired = matchRowsAndEvents(t.table.rows, t.events, [], {
      name: t.name,
      eraId: '',
      tableDocumentId: t.tableId,
      timelineDocumentId: t.timelineId,
      laneId: typeof lane?.id === 'string' ? lane.id : '',
      laneName: typeof lane?.name === 'string' ? lane.name : '',
      mainRowId: '',
    });
    const byHow = (how: string) => paired.pairs.filter((p) => p.how === how).length;
    out(
      `- ${where}: ${t.table.rows.length} rows, ${t.events.length} events, Main ${row?.countText ?? '(none)'}; ` +
        `${paired.pairs.length} row–event pairs (${byHow('date+name')} by date and name, ${byHow('date')} by date alone: wording differs only), ` +
        `${paired.mismatches.length} date mismatches, ${paired.rows.length} rows and ${paired.events.length} events unpaired.`,
    );
    if (row && (row.count !== t.table.rows.length || row.count !== t.events.length))
      drifts.push(
        `${where}: Main count ${JSON.stringify(row.countText)}, table rows ${t.table.rows.length}, timeline events ${t.events.length}.`,
      );
    for (const m of paired.mismatches)
      drifts.push(
        `${where}: row ${m.row.index + 1} ${JSON.stringify(m.row.dateText)} (${JSON.stringify(m.row.description.slice(0, 60))}) says ` +
          `${m.row.eventDate!.end !== null ? 'a range' : 'one date'} but its event ${JSON.stringify(m.event.name.slice(0, 60))} is ` +
          `${m.event.end !== null ? 'a range' : 'one date'} (${eventText(m.event)}; paired by ${m.by}).`,
      );
    for (const r of paired.rows)
      drifts.push(
        `${where}: row ${r.index + 1} ${JSON.stringify(r.dateText)} ${JSON.stringify(r.description.slice(0, 80))} has no timeline event.`,
      );
    for (const e of paired.events)
      drifts.push(
        `${where}: event ${e.id} ${JSON.stringify(eventText(e))} ${JSON.stringify(e.name.slice(0, 80))} has no table row.`,
      );
  }
  out();
  out(
    '## 4. Drift between the tables and the timelines (the table is the authority; reported, not a failure of the engine)',
  );
  if (drifts.length === 0) out('- none.');
  for (const d of drifts) driftFound(d);
  out();
  out(
    `Result: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} (the engine, both date styles and the structure); ` +
      `${drift.length === 0 ? 'no drift' : `${drift.length} drift finding${drift.length === 1 ? '' : 's'} (run the chronology check on the dashboard and use "Propose a fix")`}; ` +
      `${reads} reads; nothing was written.`,
  );
  return { text: lines.join('\n'), failures, drift, reads };
}
