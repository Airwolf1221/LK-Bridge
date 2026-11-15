/**
 * "Propose a fix" for a `count_mismatch` (v2 E5 hotfix, ADR 0039 note of 15 November 2026): the Main table's Event count
 * cell of ONE age set to the age table's row count, the table being the authority.
 *
 * The plan is pure, like `planSync`: it reads through a reader (the Main document, the age table and that age's timeline
 * events, all live), and gives the target and the context `buildJob` needs. The job is the ordinary chronology job
 * (src/chronology/plan.ts), so the Main document's write goes through the same machinery as the timeline tools' count
 * writes: the Main document and the age table locked for the whole job (sorted locks), `bridge.expect` inside the lock,
 * `bridge.record`, ONE `updateBlock` of the count cell's paragraph with the If-Match chained from the in-lock read,
 * `bridge.verify`, the journal (the cell's pre-image), the record (resume, never replay).
 *
 * The compare-and-swap inside the lock has two parts:
 *
 * - the Main count must still be the one read here (`expectBefore`): a count changed between the proposal and its
 *   approval (by hand, or by another approved change) ends the proposal `conflicted`, and nothing is written;
 * - the age table must still have the number of rows read here (`row.count`, `TableOp` `rows`): a row added or removed
 *   since would make the count planned here wrong.
 *
 * The new text is written in the Main table's learned style (`formatCount`: thousands commas when any count there has
 * them), with the cell's first run's marks kept (`countContent`). Every other cell and block is untouched: the write is
 * one block, the count cell's paragraph. The timeline is never touched; its event count is shown for the owner only.
 */
import { createHash } from 'node:crypto';
import type { Calendar } from '../calendar/index.js';
import { readEvents, type CheckReader } from './check.js';
import type { WriteContext } from './plan.js';
import type { AgeConfig, ChronologyConfig } from './settings.js';
import type { ChronologyTarget, TargetWrite } from './store.js';
import { formatCount, readAgeTable, readMainTable } from './table.js';

type Obj = Record<string, unknown>;

/** The record's tool name for this fix (it has no MCP tool: only the dashboard's and the audits' "Propose a fix"). */
export const COUNT_FIX_TOOL = 'chronology_count_fix' as const;

export interface CountFixRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details: Obj;
}

export interface CountFixPlan {
  readonly ok: true;
  /** `nothing`: the Main count already matches the table; `set`: the count cell is set to the table's row count. */
  readonly action: 'nothing' | 'set';
  readonly age: AgeConfig;
  /** The Main count as read now (its text and value), the text it is set to, the table's rows, the timeline's events. */
  readonly main: { readonly text: string; readonly value: number; readonly after: string };
  readonly rows: number;
  readonly events: number;
  readonly writes: readonly TargetWrite[];
  readonly target: ChronologyTarget;
  readonly ctx: WriteContext;
  readonly requestKey: string;
  readonly summary: string;
  readonly head: Obj;
  readonly markdown: { readonly before: string; readonly after: string };
}

export type CountFixResult = CountFixPlan | CountFixRefusal;

const refuse = (code: string, message: string, details: Obj = {}): CountFixRefusal => ({
  ok: false,
  code,
  message,
  details,
});

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** Plans the count fix of one age. Throws what `read` throws; every other refusal is a `CountFixRefusal`. */
export async function planCountFix(o: {
  readonly config: ChronologyConfig;
  readonly calendar: Calendar;
  readonly read: CheckReader;
  readonly age: AgeConfig;
}): Promise<CountFixResult> {
  const { config: c, calendar: cal, age } = o;
  const resourceId = c.resourceId!;
  const mainDoc = c.mainDocumentId!;

  // Both sides, live: the Main table first, then the age table (the authority), then the timeline (for the owner).
  const mainBlocks = (await o.read('getDocumentBlocks', { path: { resourceId, documentId: mainDoc } })) as
    { blocks?: unknown[] } | undefined;
  const main = readMainTable(mainBlocks?.blocks ?? [], c.columns);
  if (!main || main.table.id === null)
    return refuse(
      'CHRONOLOGY_CHANGED',
      'The Main document has no Main table (with a block id); nothing was proposed.',
    );
  const mainRow = main.rows.find((r) => r.id === age.mainRowId) ?? null;
  if (!mainRow)
    return refuse(
      'MAIN_ROW_NOT_FOUND',
      `The Main table has no row ${age.mainRowId} for ${age.name}, so there is no fix to propose: add the row by hand, then confirm the chronology again.`,
      { age: age.name, mainRowId: age.mainRowId },
    );
  if (mainRow.count === null || !mainRow.countCell?.paragraphId)
    return refuse(
      'COUNT_UNREADABLE',
      `The ${age.name} count on the Main table (“${mainRow.countText}”) is not a number in a single paragraph, so it cannot be set safely; correct it by hand.`,
      { age: age.name, count: mainRow.countText },
    );
  const tableBlocks = (await o.read('getDocumentBlocks', {
    path: { resourceId, documentId: age.tableDocumentId },
  })) as { blocks?: unknown[] } | undefined;
  const table = readAgeTable(tableBlocks?.blocks ?? [], cal.parser, c.style.date, c.columns);
  if (!table || table.table.id === null)
    return refuse(
      'CHRONOLOGY_CHANGED',
      `The ${age.name} table document has no table with the columns ${c.columns.event} | ${c.columns.date} | ${c.columns.kcy}; nothing was proposed.`,
    );
  const events = (await readEvents(o.read, resourceId, age.timelineDocumentId)).filter(
    (e) => e.laneId === age.laneId,
  );
  const rows = table.rows.length;
  const before = mainRow.count;
  const after = formatCount(rows, main);
  const summary = `${age.name}: Main ${mainRow.countText.trim()} → ${after} (table rows ${rows}; timeline events ${events.length})`;
  const head: Obj = {
    action: before === rows ? 'nothing' : 'set',
    age: age.name,
    count: { before: mainRow.countText, after, rows, events: events.length },
    note: 'The table is the authority: only the Main table’s Event count cell of this age is set to the table’s row count. The table and the timeline are not touched.',
  };
  const ctx: WriteContext = {
    tableIds: { [age.tableDocumentId]: table.table.id },
    mainTableId: main.table.id,
    rows: {},
    counts: { [age.mainRowId]: { paragraphId: mainRow.countCell.paragraphId, text: after, age: age.name } },
    lanes: {},
    events: {},
    expectBefore: { [age.mainRowId]: before },
  };
  const requestKey = sha({ tool: COUNT_FIX_TOOL, age: age.name, row: age.mainRowId, from: before, to: rows });
  const base = { ok: true as const, age, main: { text: mainRow.countText, value: before, after }, rows };
  if (before === rows)
    return {
      ...base,
      action: 'nothing',
      events: events.length,
      writes: [],
      target: { writes: [] },
      ctx,
      requestKey,
      summary,
      head,
      markdown: { before: '', after: '' },
    };
  const writes: TargetWrite[] = [
    {
      kind: 'row.count',
      age: age.name,
      resourceId,
      documentId: age.tableDocumentId,
      rows,
    },
    {
      kind: 'count',
      age: age.name,
      resourceId,
      documentId: mainDoc,
      rowId: age.mainRowId,
      delta: rows - before,
    },
  ];
  const line = (n: string) => `| ${mainRow.age} | ${n} |`;
  return {
    ...base,
    action: 'set',
    events: events.length,
    writes,
    target: { writes },
    ctx,
    requestKey,
    summary,
    head,
    markdown: {
      before: ['## Main', `| ${c.columns.age} | ${c.columns.count} |`, line(mainRow.countText)].join('\n'),
      after: ['## Main', `| ${c.columns.age} | ${c.columns.count} |`, line(after)].join('\n'),
    },
  };
}
