/**
 * The chronology's checks inside the lock (v2 D1, ADR 0038): the `bridge.expect` and `bridge.verify` document checkers
 * the chronology module registers with the job engine.
 *
 * Before the first write of a chronology job (its three documents locked), each document is read once and judged:
 *
 * - `chronology.table`: the age table is still there with its columns; a row to insert is not there yet and no
 *   identical row (same date and description) has appeared; a row to change or delete is still exactly as planned. The
 *   new row's place is worked out NOW, from the table as it is (calendar order, after the rows of the same date), and
 *   handed to the insert or move that follows (`bindBody`): rows added elsewhere since the plan (another approved
 *   proposal) move nothing.
 * - `chronology.main`: the Main table's row of each age is still that age's, with a count; the new count (one more or
 *   one less than the count NOW) is handed to the write that follows, and what was found is kept for the record.
 *
 * After the writes, `chronology.verify.table` and `chronology.verify.main` read the documents back.
 */
import type { DocumentCheckContext, DocumentCheckResult } from '../jobs/internal-steps.js';
import type { StateDifference } from '../jobs/sidebar-state.js';
import type { Calendar } from '../calendar/index.js';
import {
  anchorFor,
  compareKeys,
  countContent,
  formatCount,
  readAgeTable,
  readMainTable,
  sameDate,
  sameText,
  sortKey,
  type AgeRow,
  type RowTexts,
  type SortKey,
} from './table.js';

type Obj = Record<string, unknown>;

export interface DateRef {
  readonly start: number;
  readonly end: number | null;
  readonly detail: 1 | 2 | 3;
}

export type TableOp =
  | {
      readonly op: 'insert';
      /** The key of the insert's body in the step's result. */
      readonly key: string;
      readonly rowId: string;
      readonly block: Obj;
      readonly sortKey: SortKey;
      readonly date: DateRef;
      readonly description: string;
    }
  | { readonly op: 'delete'; readonly rowId: string; readonly texts: RowTexts }
  | {
      readonly op: 'replace';
      readonly rowId: string;
      readonly before: RowTexts;
      /** The key of the move's body (only when the row's date changes, so its place may too). */
      readonly moveKey?: string;
      readonly sortKey: SortKey;
      readonly date: DateRef;
      readonly description: string;
    };

export interface TableCheckInput {
  readonly age: string;
  readonly tableId: string;
  readonly columns: { readonly event: string; readonly date: string; readonly kcy: string };
  readonly ops: readonly TableOp[];
}

export interface MainCheckInput {
  readonly tableId: string;
  readonly columns: {
    readonly age: string;
    readonly count: string;
    readonly table: string;
    readonly timeline: string;
  };
  readonly ops: readonly {
    readonly rowId: string;
    readonly age: string;
    readonly paragraphId: string;
    readonly delta: number;
    /** The key of the count write's body. */
    readonly key: string;
    /** Resuming: the count must still be this (the change's count was not written yet). */
    readonly expectBefore?: number;
  }[];
  /** The key the verify step's expected counts go under. */
  readonly verifyKey: string;
}

export interface TableVerifyInput {
  readonly tableId: string;
  readonly columns: { readonly event: string; readonly date: string; readonly kcy: string };
  readonly rows: readonly { readonly rowId: string; readonly present: boolean; readonly texts?: RowTexts }[];
}

export interface MainVerifyInput {
  readonly tableId: string;
  readonly columns: MainCheckInput['columns'];
  readonly counts: Readonly<Record<string, string>>;
}

const diff = (path: string, expected: unknown, actual: unknown): StateDifference => ({
  path,
  expected,
  actual,
});

/** The checkers, given the project's calendar (the definition the plan used, cached by the module). */
export function chronologyCheckers(calendarOf: (projectId: string) => Calendar | null) {
  const cal = (ctx: DocumentCheckContext): Calendar => {
    const c = calendarOf(ctx.projectId);
    if (!c)
      throw new Error('the chronology’s calendar is not known to the bridge (confirm the chronology again)');
    return c;
  };

  const table = (ctx: DocumentCheckContext): DocumentCheckResult => {
    const input = ctx.input as TableCheckInput;
    const t = readAgeTable(ctx.document.blocks, cal(ctx).parser, undefined, input.columns);
    if (!t || t.table.id !== input.tableId) {
      return {
        differences: [
          diff(`${ctx.label} table`, input.tableId, t ? t.table.id : '(no table with its columns)'),
        ],
      };
    }
    const differences: StateDifference[] = [];
    const bodies: Obj = {};
    const byId = new Map(t.rows.filter((r) => r.id !== null).map((r) => [r.id!, r]));
    const headerId = t.table.header.id;
    const same = (r: AgeRow, texts: RowTexts) =>
      sameText(r.description, texts.description) &&
      r.dateText.trim() === texts.date.trim() &&
      r.kcyText.trim() === texts.kcy.trim();
    const duplicate = (date: DateRef, description: string, except: string | null) =>
      t.rows.find(
        (r) =>
          r.id !== except &&
          r.date !== null &&
          sameDate(r.date, date) &&
          sameText(r.description, description),
      );
    for (const op of input.ops) {
      if (op.op === 'insert') {
        if (byId.has(op.rowId)) differences.push(diff(`${ctx.label} row ${op.rowId}`, 'absent', 'present'));
        const twin = duplicate(op.date, op.description, null);
        if (twin)
          differences.push(
            diff(`${ctx.label} identical row`, 'none', `${twin.dateText} | ${twin.description}`),
          );
        const anchor = anchorFor(t.rows, op.sortKey);
        const after = anchor?.id ?? headerId;
        if (!after)
          differences.push(diff(`${ctx.label} place`, 'a row id to insert after', '(the rows have no ids)'));
        else bodies[op.key] = { block: op.block, after };
        continue;
      }
      const row = byId.get(op.rowId);
      if (!row) {
        differences.push(diff(`${ctx.label} row ${op.rowId}`, 'present', '(gone)'));
        continue;
      }
      if (op.op === 'delete') {
        if (!same(row, op.texts))
          differences.push(
            diff(`${ctx.label} row ${op.rowId}`, op.texts, {
              description: row.description,
              date: row.dateText,
              kcy: row.kcyText,
            }),
          );
        continue;
      }
      if (!same(row, op.before)) {
        differences.push(
          diff(`${ctx.label} row ${op.rowId}`, op.before, {
            description: row.description,
            date: row.dateText,
            kcy: row.kcyText,
          }),
        );
        continue;
      }
      const twin = duplicate(op.date, op.description, op.rowId);
      if (twin)
        differences.push(
          diff(`${ctx.label} identical row`, 'none', `${twin.dateText} | ${twin.description}`),
        );
      if (op.moveKey !== undefined) {
        const anchor = anchorFor(t.rows, op.sortKey, new Set([op.rowId]));
        const after = anchor?.id ?? headerId;
        if (!after)
          differences.push(diff(`${ctx.label} place`, 'a row id to move after', '(the rows have no ids)'));
        else bodies[op.moveKey] = { after };
      }
    }
    return { differences, bodies, observed: { rows: t.rows.length } };
  };

  const main = (ctx: DocumentCheckContext): DocumentCheckResult => {
    const input = ctx.input as MainCheckInput;
    const m = readMainTable(ctx.document.blocks, input.columns);
    if (!m || m.table.id !== input.tableId)
      return { differences: [diff(`${ctx.label} table`, input.tableId, m ? m.table.id : '(no Main table)')] };
    const differences: StateDifference[] = [];
    const bodies: Obj = {};
    const counts: Record<string, { before: number; after: number }> = {};
    const verify: Record<string, string> = {};
    for (const op of input.ops) {
      const row = m.rows.find((r) => r.id === op.rowId);
      if (!row) {
        differences.push(diff(`${ctx.label} row of ${op.age}`, op.rowId, '(gone)'));
        continue;
      }
      if (!sameText(row.age, op.age))
        differences.push(diff(`${ctx.label} row ${op.rowId} age`, op.age, row.age));
      if (row.count === null || !row.countCell) {
        differences.push(diff(`${ctx.label} ${op.age} count`, 'a number', row.countText));
        continue;
      }
      if (row.countCell.paragraphId !== op.paragraphId)
        differences.push(
          diff(`${ctx.label} ${op.age} count cell`, op.paragraphId, row.countCell.paragraphId),
        );
      if (op.expectBefore !== undefined && row.count !== op.expectBefore)
        differences.push(diff(`${ctx.label} ${op.age} count`, op.expectBefore, row.count));
      const after = row.count + op.delta;
      if (after < 0)
        differences.push(diff(`${ctx.label} ${op.age} count`, `at least ${-op.delta}`, row.count));
      const text = formatCount(after, m);
      bodies[op.key] = { content: countContent(row.countCell, text) };
      counts[op.rowId] = { before: row.count, after };
      verify[op.rowId] = text;
    }
    bodies[input.verifyKey] = {
      tableId: input.tableId,
      columns: input.columns,
      counts: verify,
    } satisfies MainVerifyInput;
    return { differences, bodies, observed: { counts } };
  };

  const verifyTable = (ctx: DocumentCheckContext): DocumentCheckResult => {
    const input = ctx.input as TableVerifyInput;
    const t = readAgeTable(ctx.document.blocks, cal(ctx).parser, undefined, input.columns);
    if (!t || t.table.id !== input.tableId)
      return { differences: [diff(`${ctx.label} table`, input.tableId, t ? t.table.id : '(none)')] };
    const differences: StateDifference[] = [];
    for (const want of input.rows) {
      const at = t.rows.findIndex((r) => r.id === want.rowId);
      if (!want.present) {
        if (at >= 0) differences.push(diff(`${ctx.label} row ${want.rowId}`, '(deleted)', 'still there'));
        continue;
      }
      if (at < 0) {
        differences.push(diff(`${ctx.label} row ${want.rowId}`, 'present', '(not found)'));
        continue;
      }
      const r = t.rows[at]!;
      if (want.texts) {
        const got = { description: r.description, date: r.dateText, kcy: r.kcyText };
        if (
          !sameText(got.description, want.texts.description) ||
          got.date !== want.texts.date ||
          got.kcy !== want.texts.kcy
        )
          differences.push(diff(`${ctx.label} row ${want.rowId}`, want.texts, got));
      }
      // In calendar order with its readable neighbours.
      if (r.date) {
        const before = t.rows
          .slice(0, at)
          .reverse()
          .find((x) => x.date);
        const next = t.rows.slice(at + 1).find((x) => x.date);
        if (before?.date && compareKeys(sortKey(before.date), sortKey(r.date)) > 0)
          differences.push(
            diff(`${ctx.label} row ${want.rowId} place`, `after ${before.dateText}`, 'before it'),
          );
        if (next?.date && compareKeys(sortKey(r.date), sortKey(next.date)) > 0)
          differences.push(
            diff(`${ctx.label} row ${want.rowId} place`, `before ${next.dateText}`, 'after it'),
          );
      }
    }
    return { differences };
  };

  const verifyMain = (ctx: DocumentCheckContext): DocumentCheckResult => {
    const input = ctx.input as MainVerifyInput | null;
    if (!input) return { differences: [diff(ctx.label, 'the counts to check', '(none worked out)')] };
    const m = readMainTable(ctx.document.blocks, input.columns);
    if (!m || m.table.id !== input.tableId)
      return { differences: [diff(`${ctx.label} table`, input.tableId, m ? m.table.id : '(none)')] };
    const differences: StateDifference[] = [];
    for (const [rowId, text] of Object.entries(input.counts)) {
      const r = m.rows.find((x) => x.id === rowId);
      if (!r) differences.push(diff(`${ctx.label} row ${rowId}`, text, '(gone)'));
      else if (r.countText !== text) differences.push(diff(`${ctx.label} ${r.age} count`, text, r.countText));
    }
    return { differences };
  };

  return {
    'chronology.table': table,
    'chronology.main': main,
    'chronology.verify.table': verifyTable,
    'chronology.verify.main': verifyMain,
  } as const;
}
