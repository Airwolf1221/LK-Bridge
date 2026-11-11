/**
 * The opt-in chronology sandbox check (test/sandbox/chronology.ts) run against the mock chronology: it reads only, gets
 * to an answer for every age, and its report says PASS on a consistent chronology and lists each row that is not (the
 * real run on the server is the owner's: `deploy/sandbox-test.sh --project test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { runChronologySandbox } from '../sandbox/chronology.js';
import { C, chronologyWorld, type ChronologyWorld } from './world.js';

let w: ChronologyWorld;
beforeAll(async () => {
  w = await chronologyWorld({ confirm: false });
});
afterAll(async () => w.close());

const run = () =>
  runChronologySandbox({
    resourceId: C.resource,
    read: (op, params) =>
      w.stack.runtime.engine.internalRead(PROJECT, op, params, { priority: 'P2', notFoundIsAnswer: true }),
  });

describe('the chronology sandbox check, dry run', () => {
  it('reads every age, writes nothing, and passes on a consistent chronology', async () => {
    const done = w.mark();
    const r = await run();
    const cost = done();
    expect(cost.writes).toBe(0);
    expect(r.failures, r.text).toEqual([]);
    expect(r.text).toContain('Result: PASS');
    expect(r.text).toContain('KCY cell shapes');
    console.log(`sandbox chronology check: ${r.reads} reads on the mock world`);
  });

  it('lists a row whose KCY or Date cell differs, with its exact text', async () => {
    const t = w.repo.blocks.get(w.ages['Fourth Arkonan Age']!.table)!;
    const table = (t.blocks as Record<string, unknown>[]).find((b) => b.kind === 'table')!;
    const row = (table.children as Record<string, unknown>[])[1]!;
    const cells = row.children as Record<string, unknown>[];
    (cells[2]!.children as Record<string, unknown>[])[0]!.content = [{ text: '1250308' }];
    const r = await run();
    expect(r.failures.some((f) => f.includes('"1250308"') && f.includes('"1,250,308"'))).toBe(true);
  });
});
