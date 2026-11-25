/**
 * v3 F10 (ADR 0078, C2): four deterministic repairs of what the chronology check reports, each planned from a live
 * read and run by the ordinary chronology job (src/chronology/plan.ts: the documents locked for the whole job, the
 * compare-and-swap inside the lock, block-level writes with the If-Match chained, `bridge.verify`, the journal and the
 * record). The table stays the authority (PLAN-v2 4.12): these change only what the calendar engine or the chronology's
 * own layout decides, never a row's words or its date.
 *
 * - `kcy` (`wrong_kcy`): the row's KCY cell set to the calendar engine's KCY for the row's date, in the confirmed style.
 *   Only for a complete, readable date (a day, not a year or a month alone, and not a qualified date): anything else
 *   has no fix (`KCY_NOT_DETERMINED`).
 * - `uri` (`wrong_uri`): the event's link set to its age's table (the age is the finding's: known by construction).
 * - `order` (`row_out_of_order`): the rows moved into calendar order, only when the order is strict: every row
 *   involved has a plain readable date, and no two neighbours tie or are a partial date that could fall either side of
 *   the other (`ORDER_NOT_STRICT`, and the finding stays a judgement). The fewest rows move (those outside the longest
 *   run already in order), each after its predecessor in the new order; the whole table's order is asserted inside the
 *   lock, and each moved row's place verified against its neighbours.
 * - `style` (`date_text_differs`): the Date cell rewritten as the engine writes the same date (the confirmed table
 *   style), and the KCY cell rewritten in the confirmed style when its value is right but written differently. A row
 *   whose KCY value is wrong is `kcy`'s, not this.
 *
 * Every plan gives its before and after text per cell (or, for an order, the rows' dates in order) as `textChanges`
 * (src/jobs/text-change.ts, F7.1a's display), shown in the proposal's summary, on the Proposals page and on the Review
 * card.
 */
import { createHash } from 'node:crypto';
import { formatKcy, kcyWrittenAlike, parseKcyCell, type Calendar } from '../calendar/index.js';
import { mintClientId } from '../jobs/ids.js';
import { textChange, type TextChange } from '../jobs/text-change.js';
import { readEvents, tableUri, uriPointsAt, type CheckReader } from './check.js';
import { replaceCells, rowKey, type WriteContext } from './plan.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import type { ChronologyTarget, TargetWrite } from './store.js';
import { compareKeys, readAgeTable, sortKey, type AgeRow, type AgeTable } from './table.js';

type Obj = Record<string, unknown>;

export const KCY_FIX_TOOL = 'chronology_kcy_fix' as const;
export const URI_FIX_TOOL = 'chronology_uri_fix' as const;
export const ORDER_FIX_TOOL = 'chronology_order_fix' as const;
export const STYLE_FIX_TOOL = 'chronology_style_fix' as const;
export type RepairTool =
  typeof KCY_FIX_TOOL | typeof URI_FIX_TOOL | typeof ORDER_FIX_TOOL | typeof STYLE_FIX_TOOL;
export const REPAIR_TOOLS: readonly RepairTool[] = [
  KCY_FIX_TOOL,
  URI_FIX_TOOL,
  ORDER_FIX_TOOL,
  STYLE_FIX_TOOL,
];

export interface RepairRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details: Obj;
}

export interface RepairPlan {
  readonly ok: true;
  readonly tool: RepairTool;
  /** `nothing`: already as the repair would leave it. */
  readonly action: 'nothing' | 'set';
  readonly age: AgeConfig;
  readonly writes: readonly TargetWrite[];
  readonly target: ChronologyTarget;
  readonly ctx: WriteContext;
  readonly requestKey: string;
  readonly summary: string;
  readonly head: Obj;
  readonly markdown: { readonly before: string; readonly after: string };
  /** The before and after text of each cell (or the order), for the proposal and the Review card. */
  readonly textChanges: readonly TextChange[];
}

export type RepairResult = RepairPlan | RepairRefusal;

const refuse = (code: string, message: string, details: Obj = {}): RepairRefusal => ({
  ok: false,
  code,
  message,
  details,
});

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

const textsOf = (r: AgeRow) => ({ description: r.description, date: r.dateText, kcy: r.kcyText });

const rowLine = (t: { description: string; date: string; kcy: string }) =>
  `| ${t.description} | ${t.date} | ${t.kcy} |`;

async function readTable(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly age: AgeConfig;
}): Promise<AgeTable | RepairRefusal> {
  const c = o.config;
  const b = (await o.read('getDocumentBlocks', {
    path: { resourceId: c.resourceId!, documentId: o.age.tableDocumentId },
  })) as { blocks?: unknown[] } | undefined;
  const t = readAgeTable(b?.blocks ?? [], o.calendar.parser, c.style.date, c.columns);
  if (!t || t.table.id === null)
    return refuse(
      'CHRONOLOGY_CHANGED',
      `The ${o.age.name} table document has no table with the columns ${c.columns.event} | ${c.columns.date} | ${c.columns.kcy}; nothing was proposed.`,
    );
  return t;
}

const isRefusal = (x: unknown): x is RepairRefusal =>
  typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

/** A row's cells rewritten (Date and or KCY), as the KCY and style repairs plan it. */
function cellRepair(o: {
  readonly tool: typeof KCY_FIX_TOOL | typeof STYLE_FIX_TOOL;
  readonly config: ChronologyConfig;
  readonly age: AgeConfig;
  readonly table: AgeTable;
  readonly row: AgeRow;
  readonly date?: string;
  readonly kcy?: string;
  readonly pageName: string;
}): RepairPlan {
  const { config: c, age, table, row } = o;
  const rid = c.resourceId!;
  const before = textsOf(row);
  const texts = {
    description: row.description,
    date: o.date ?? row.dateText,
    kcy: o.kcy ?? row.kcyText,
  };
  const block = replaceCells(
    row.row.block,
    table.columns,
    {
      ...(o.date !== undefined ? { date: o.date } : {}),
      ...(o.kcy !== undefined ? { kcy: o.kcy } : {}),
    },
    () => mintClientId(8),
  );
  const writes: TargetWrite[] = [
    {
      kind: 'row.replace',
      age: age.name,
      resourceId: rid,
      documentId: age.tableDocumentId,
      rowId: row.id!,
      before,
      texts,
      block,
    },
  ];
  const date = row.date!;
  const ctx: WriteContext = {
    tableIds: { [age.tableDocumentId]: table.table.id! },
    mainTableId: '',
    rows: {
      [rowKey(age.tableDocumentId, row.id!)]: {
        sortKey: sortKey(date),
        date: { start: date.start, end: date.end, detail: date.detail },
        description: row.description,
      },
    },
    counts: {},
    lanes: {},
    events: {},
  };
  const changes = [
    ...(o.date !== undefined && o.date !== row.dateText
      ? [
          textChange({
            page: o.pageName,
            pageId: rid,
            blockId: row.id!,
            what: `${age.name} Date cell`,
            before: row.dateText,
            after: o.date,
          }),
        ]
      : []),
    ...(o.kcy !== undefined && o.kcy !== row.kcyText
      ? [
          textChange({
            page: o.pageName,
            pageId: rid,
            blockId: row.id!,
            what: `${age.name} KCY cell`,
            before: row.kcyText,
            after: o.kcy,
          }),
        ]
      : []),
  ].filter((x): x is TextChange => x !== null);
  const what = o.tool === KCY_FIX_TOOL ? 'KCY' : 'written style';
  const parts = [
    ...(o.date !== undefined && o.date !== row.dateText ? [`Date “${row.dateText}” → “${o.date}”`] : []),
    ...(o.kcy !== undefined && o.kcy !== row.kcyText ? [`KCY “${row.kcyText}” → “${o.kcy}”`] : []),
  ];
  const nothing = parts.length === 0;
  return {
    ok: true,
    tool: o.tool,
    action: nothing ? 'nothing' : 'set',
    age,
    writes: nothing ? [] : writes,
    target: { writes: nothing ? [] : writes },
    ctx,
    requestKey: sha({ tool: o.tool, age: age.name, row: row.id, before, texts }),
    summary: `${age.name} row ${row.index + 1} (${row.description.slice(0, 60)}): ${what}: ${parts.join('; ') || 'already right'}`,
    head: {
      action: nothing ? 'nothing' : 'set',
      age: age.name,
      rowId: row.id,
      before,
      after: texts,
      note:
        o.tool === KCY_FIX_TOOL
          ? 'The KCY cell set to the calendar engine’s KCY for the row’s date, in the confirmed style. The date, the description and the timeline are not touched.'
          : 'The cells rewritten in the confirmed table style: the same date and KCY, written as the engine writes them. The words and the timeline are not touched.',
    },
    markdown: { before: rowLine(before), after: rowLine(texts) },
    textChanges: changes,
  };
}

/** `wrong_kcy`: the KCY cell set to the engine's KCY of a complete, readable date. */
export async function planKcyFix(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly age: AgeConfig;
  readonly rowId: string;
  readonly pageName: string;
}): Promise<RepairResult> {
  const t = await readTable(o);
  if (isRefusal(t)) return t;
  const row = t.rows.find((r) => r.id === o.rowId);
  if (!row) return refuse('ROW_NOT_FOUND', `The ${o.age.name} table has no row ${o.rowId}.`);
  if (!row.date || row.reading || row.date.detail !== 3)
    return refuse(
      'KCY_NOT_DETERMINED',
      `The ${o.age.name} row “${row.dateText}” is ${row.reading ? 'a qualified date' : !row.date ? 'a date the engine cannot read' : 'a partial date (no day)'}: its KCY is not set automatically. Correct it by hand.`,
      { rowId: o.rowId, date: row.dateText },
    );
  const want = formatKcy(row.date.kcy, o.config.style.kcy);
  return cellRepair({
    tool: KCY_FIX_TOOL,
    config: o.config,
    age: o.age,
    table: t,
    row,
    kcy: kcyWrittenAlike(row.kcyText, row.date.kcy, o.config.style.kcy) ? row.kcyText : want,
    pageName: o.pageName,
  });
}

/** `date_text_differs`: the Date cell, and a right KCY written differently, rewritten in the confirmed style. */
export async function planStyleFix(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly age: AgeConfig;
  readonly rowId: string;
  readonly pageName: string;
}): Promise<RepairResult> {
  const t = await readTable(o);
  if (isRefusal(t)) return t;
  const row = t.rows.find((r) => r.id === o.rowId);
  if (!row) return refuse('ROW_NOT_FOUND', `The ${o.age.name} table has no row ${o.rowId}.`);
  if (!row.date || row.reading)
    return refuse(
      'STYLE_NOT_DETERMINED',
      `The ${o.age.name} row “${row.dateText}” is ${row.reading ? 'a qualified date (never rewritten)' : 'a date the engine cannot read'}: nothing is rewritten.`,
      { rowId: o.rowId, date: row.dateText },
    );
  const s = o.config.style.kcy;
  const k = parseKcyCell(row.kcyText);
  const valueOk =
    k !== null &&
    k.start === row.date.kcy.start &&
    (k.end ?? k.start) === (row.date.kcy.end ?? row.date.kcy.start);
  const kcy =
    valueOk && !kcyWrittenAlike(row.kcyText, row.date.kcy, s) ? formatKcy(row.date.kcy, s) : undefined;
  if (!valueOk && !kcyWrittenAlike(row.kcyText, row.date.kcy, s) && row.date.text === row.dateText.trim())
    return refuse(
      'KCY_WRONG',
      `The ${o.age.name} row “${row.dateText}” has a wrong KCY value (“${row.kcyText}”), not only a different style: that is the KCY fix's.`,
      { rowId: o.rowId },
    );
  return cellRepair({
    tool: STYLE_FIX_TOOL,
    config: o.config,
    age: o.age,
    table: t,
    row,
    ...(row.date.text !== row.dateText.trim() ? { date: row.date.text } : {}),
    ...(kcy !== undefined ? { kcy } : {}),
    pageName: o.pageName,
  });
}

/** `wrong_uri`: the event's link set to its age's table. */
export async function planUriFix(o: {
  readonly config: ChronologyConfig;
  readonly read: CheckReader;
  readonly age: AgeConfig;
  readonly eventId: string;
  readonly pageName: string;
}): Promise<RepairResult> {
  const c = o.config;
  const rid = c.resourceId!;
  const events = (await readEvents(o.read, rid, o.age.timelineDocumentId)).filter(
    (e) => e.laneId === o.age.laneId,
  );
  const event = events.find((e) => e.id === o.eventId);
  if (!event)
    return refuse('EVENT_NOT_FOUND', `The ${o.age.name} timeline has no event ${o.eventId} (in its lane).`, {
      eventId: o.eventId,
    });
  const uri = tableUri(rid, o.age.tableDocumentId);
  const nothing = uriPointsAt(event.uri, rid, o.age.tableDocumentId);
  const writes: TargetWrite[] = nothing
    ? []
    : [
        {
          kind: 'event.update',
          age: o.age.name,
          resourceId: rid,
          documentId: o.age.timelineDocumentId,
          eventId: event.id,
          fields: { uri },
        },
      ];
  const change = textChange({
    page: o.pageName,
    pageId: rid,
    what: `${o.age.name} event link (“${event.name.slice(0, 60)}”)`,
    before: event.uri ?? '(none)',
    after: uri,
  });
  return {
    ok: true,
    tool: URI_FIX_TOOL,
    action: nothing ? 'nothing' : 'set',
    age: o.age,
    writes,
    target: { writes },
    ctx: {
      tableIds: {},
      mainTableId: '',
      rows: {},
      counts: {},
      lanes: {},
      events: { [event.id]: event.raw },
    },
    requestKey: sha({ tool: URI_FIX_TOOL, age: o.age.name, event: event.id, from: event.uri, to: uri }),
    summary: `${o.age.name} event “${event.name.slice(0, 60)}”: link ${event.uri ?? 'none'} → its age's table`,
    head: {
      action: nothing ? 'nothing' : 'set',
      age: o.age.name,
      eventId: event.id,
      uri: { before: event.uri, after: uri },
      note: 'Only the event’s link is set, to its age’s table. Its name, date and lane are not touched.',
    },
    markdown: { before: `- ${event.name}: ${event.uri ?? '(no link)'}`, after: `- ${event.name}: ${uri}` },
    textChanges: change ? [change] : [],
  };
}

/** The year, the month and the minute a plain date's start is known to (its detail). */
const startAt = (r: AgeRow) => {
  const d = r.date!;
  return { detail: d.detail, kcy: d.kcy.start, month: d.startDate.month, start: d.start };
};

/**
 * Whether `a` is strictly before `b` whatever a partial date stands for: compared at the coarser of their details (a
 * year with a day of another year is ordered; with a day of the same year it could fall either side), and never equal.
 */
export function strictlyBefore(a: AgeRow, b: AgeRow): boolean {
  const x = startAt(a);
  const y = startAt(b);
  const d = Math.min(x.detail, y.detail);
  if (x.kcy !== y.kcy) return x.kcy < y.kcy;
  if (d === 1) return false;
  if (x.month !== y.month) return x.month < y.month;
  if (d === 2) return false;
  return x.start < y.start;
}

/** Indices (into `seq`) of a longest strictly increasing run of `seq` (patience sorting). */
function longestRun(seq: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let k = tails.length > 0 ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) keep.add(k);
  return keep;
}

/** `row_out_of_order`: the rows moved into calendar order when the order is strict. */
export async function planOrderFix(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly age: AgeConfig;
  readonly pageName: string;
}): Promise<RepairResult> {
  const c = o.config;
  const rid = c.resourceId!;
  const t = await readTable(o);
  if (isRefusal(t)) return t;
  const rows = t.rows;
  const readable = (r: AgeRow) => r.date !== null && r.reading === null && r.id !== null;
  // The order the readable rows take (a stable sort: rows of one key keep theirs), unreadable rows kept where they are.
  const sorted = rows
    .filter(readable)
    .slice()
    .sort((a, b) => compareKeys(sortKey(a.date!), sortKey(b.date!)) || a.index - b.index);
  const target: AgeRow[] = [];
  let k = 0;
  for (const r of rows) target.push(readable(r) ? sorted[k++]! : r);
  const first = target.findIndex((r, i) => r !== rows[i]);
  const requestKey = sha({
    tool: ORDER_FIX_TOOL,
    age: o.age.name,
    rows: rows.map((r) => [r.id, r.dateText]),
  });
  const base = {
    ok: true as const,
    tool: ORDER_FIX_TOOL,
    age: o.age,
    requestKey,
    ctx: {
      tableIds: { [o.age.tableDocumentId]: t.table.id! },
      mainTableId: '',
      rows: {},
      counts: {},
      lanes: {},
      events: {},
    } satisfies WriteContext,
  };
  if (first < 0)
    return {
      ...base,
      action: 'nothing',
      writes: [],
      target: { writes: [] },
      summary: `${o.age.name}: the rows are already in calendar order`,
      head: { action: 'nothing', age: o.age.name },
      markdown: { before: '', after: '' },
      textChanges: [],
    };
  let last = rows.length - 1;
  while (last > first && target[last] === rows[last]) last--;
  // Every row involved (the span that changes, with its neighbours either side) has a plain readable date and is
  // strictly ordered with the next.
  const span = rows.slice(Math.max(0, first - 1), Math.min(rows.length, last + 2));
  const unreadable = span.find((r) => !readable(r));
  if (unreadable)
    return refuse(
      'ORDER_NOT_STRICT',
      `The ${o.age.name} rows cannot be put in order automatically: row ${unreadable.index + 1} (“${unreadable.dateText}”) ${unreadable.reading ? 'is a qualified date' : 'has a date the engine cannot read'}, so where it belongs is a judgement. Nothing was proposed.`,
      { rowId: unreadable.id },
    );
  const window = target.slice(Math.max(0, first - 1), Math.min(rows.length, last + 2));
  for (let i = 0; i + 1 < window.length; i++) {
    const a = window[i]!;
    const b = window[i + 1]!;
    if (!strictlyBefore(a, b))
      return refuse(
        'ORDER_NOT_STRICT',
        `The ${o.age.name} rows cannot be put in order automatically: “${a.dateText}” and “${b.dateText}” ${compareKeys(sortKey(a.date!), sortKey(b.date!)) === 0 ? 'tie' : 'could fall either way (a partial date)'}, so their order is a judgement. Nothing was proposed.`,
        { rows: [a.id, b.id] },
      );
  }
  // The fewest moves: the rows outside a longest run already in order move, each after its predecessor in the order.
  const rank = new Map(target.map((r, i) => [r, i]));
  const keep = longestRun(rows.map((r) => rank.get(r)!));
  const headerId = t.table.header.id;
  const writes: TargetWrite[] = [
    {
      kind: 'row.order',
      age: o.age.name,
      resourceId: rid,
      documentId: o.age.tableDocumentId,
      rows: rows.map((r) => ({ rowId: r.id ?? '', texts: textsOf(r) })),
    },
  ];
  const moved: AgeRow[] = [];
  for (let i = 0; i < target.length; i++) {
    const r = target[i]!;
    if (keep.has(rows.indexOf(r))) continue;
    const after = i === 0 ? headerId : target[i - 1]!.id;
    if (!after) return refuse('CHRONOLOGY_CHANGED', 'The table has no header row id to move a row after.');
    moved.push(r);
    writes.push({
      kind: 'row.move',
      age: o.age.name,
      resourceId: rid,
      documentId: o.age.tableDocumentId,
      rowId: r.id!,
      after,
      texts: textsOf(r),
    });
  }
  const order = (list: readonly AgeRow[]) =>
    list.slice(Math.max(0, first - 1), last + 2).map((r) => r.dateText);
  const change = textChange({
    page: o.pageName,
    pageId: rid,
    what: `${o.age.name} row order`,
    before: order(rows).join(' · '),
    after: order(target).join(' · '),
  });
  return {
    ...base,
    action: 'set',
    writes,
    target: { writes },
    summary: `${o.age.name}: ${moved.length} row${moved.length === 1 ? '' : 's'} moved into calendar order (${moved.map((r) => `“${r.dateText}”`).join(', ')})`,
    head: {
      action: 'set',
      age: o.age.name,
      moved: moved.map((r) => ({ rowId: r.id, date: r.dateText, description: r.description.slice(0, 80) })),
      note: 'Only the rows’ order changes, into calendar order: every cell and the timeline are untouched.',
    },
    markdown: {
      before: rows.map((r) => rowLine(textsOf(r))).join('\n'),
      after: target.map((r) => rowLine(textsOf(r))).join('\n'),
    },
    textChanges: change ? [change] : [],
  };
}
