/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- step bodies are untyped JSON */
/**
 * The owner's sandbox run of CR-2026-11-R3's checks, X5: one block id can exist in two documents of one page. A
 * chronology row lives in its age's table document, so two ages can hold rows with the same id. Every row lookup is now
 * by (document, row): the job builder's context (`rowKey`), the in-lock check's bodies and the binds that read them, a
 * rename's items and rebases, and Revert's pre-images. Pure functions; no LegendKeeper.
 */
import { describe, expect, it } from 'vitest';
import { buildJob, rowKey } from '../../../src/chronology/plan.js';
import { DEFAULT_CHRONOLOGY, type ChronologyConfig } from '../../../src/chronology/settings.js';
import type { TargetWrite } from '../../../src/chronology/store.js';

type Obj = Record<string, any>;
const age = (n: number) => ({
  name: `Age ${n}`,
  eraId: `era${n}`,
  tableDocumentId: `tbl${n}`,
  timelineDocumentId: `tml${n}`,
  laneId: `lane${n}`,
  laneName: `Lane ${n}`,
  mainRowId: `main${n}`,
});
const config: ChronologyConfig = {
  ...DEFAULT_CHRONOLOGY,
  resourceId: 'chron001',
  mainDocumentId: 'maindoc1',
  ages: [age(1), age(2)],
  problem: null,
};
const row = (doc: string, description: string, date: string): TargetWrite => ({
  kind: 'row.replace',
  age: doc === 'tbl1' ? 'Age 1' : 'Age 2',
  resourceId: 'chron001',
  documentId: doc,
  rowId: 'row00001', // the SAME id in both tables
  before: { description: 'Old', date: '1', kcy: '1' },
  texts: { description, date, kcy: '1' },
  block: { id: 'row00001', kind: 'tableRow', cells: [{ text: description }] },
});
const date = (start: number) => ({
  sortKey: [start, 0, 0] as never,
  date: { start, end: null, detail: 1 as const },
});

describe('X5: one row id in two age tables of the chronology page', () => {
  it('each row is planned, checked and moved as its own document’s', () => {
    const writes = [row('tbl1', 'In the first age', '5'), row('tbl2', 'In the second age', '9')];
    const built = buildJob({
      tool: 'update_timeline_event',
      config,
      target: { writes },
      writes,
      ctx: {
        tableIds: { tbl1: 'table1', tbl2: 'table2' },
        mainTableId: 'maintable',
        rows: {
          [rowKey('tbl1', 'row00001')]: { ...date(5), description: 'In the first age' },
          [rowKey('tbl2', 'row00001')]: { ...date(9), description: 'In the second age' },
        },
        moves: new Set([rowKey('tbl1', 'row00001'), rowKey('tbl2', 'row00001')]),
        counts: {},
        lanes: {},
        events: {},
      },
      record: { requestKey: 'x5', ages: ['Age 1', 'Age 2'], summary: 'x5' },
    });
    // The in-lock check of each table carries its own row, with its own date and its own move key.
    const expect0 = built.steps.find((s) => s.op === 'bridge.expect')!;
    const tables = (expect0.params!.body as Obj).checks.filter((c: Obj) => c.checker === 'chronology.table');
    const ops = Object.fromEntries(tables.map((c: Obj) => [c.documentId, c.input.ops[0]]));
    expect(ops.tbl1).toMatchObject({
      rowId: 'row00001',
      description: 'In the first age',
      moveKey: 'move:tbl1:row00001',
    });
    expect(ops.tbl2).toMatchObject({
      rowId: 'row00001',
      description: 'In the second age',
      moveKey: 'move:tbl2:row00001',
    });
    expect(ops.tbl1.sortKey).not.toEqual(ops.tbl2.sortKey);
    // Each move binds to its own document's body from the check, never the other's.
    const moves = built.steps.filter((s) => s.op === 'moveBlock');
    expect(moves.map((s) => [s.params!.path!.documentId, (s as Obj).bindBody.key])).toEqual([
      ['tbl1', 'move:tbl1:row00001'],
      ['tbl2', 'move:tbl2:row00001'],
    ]);
  });
});
