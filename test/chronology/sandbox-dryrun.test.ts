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

  it('does not fail the thousands separator: the tables write AA 1,988,119, LegendKeeper’s events AA 1988119 (ADR 0039)', async () => {
    const r = await run();
    expect(r.text).toMatch(/Kumikas 1st, AA 1,988,119/); // the table style, in the report's row summary or cell shapes
    expect(r.failures, r.text).toEqual([]);
    const events = w.events(w.ages['Archon Age']!.timeline);
    expect(events.length).toBeGreaterThan(0);
    expect(r.text).toContain('Result: PASS');
  });

  it('reports drift under its own heading and does not fail the engine on it: a missing event, a date mismatch', async () => {
    const tl = w.ages['Fourth Arkonan Age']!.timeline;
    const live = w.liveEvents(tl);
    // A year-only row loses its event; a range row's event becomes a single day.
    live.splice(
      live.findIndex((e) => e.name === 'A comet is seen over Isar'),
      1,
    );
    const week = live.find((e) => e.name === 'The Week of Lanterns')!;
    delete week.end;
    const r = await run();
    expect(r.failures, r.text).toEqual([]);
    expect(r.drift.map((d) => d.replace(/\s+/g, ' '))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/has no timeline event/),
        expect.stringMatching(/says a range but its event .* is one date/),
      ]),
    );
    expect(r.drift.some((d) => /Main count/.test(d))).toBe(true);
    expect(r.text).toContain('## 4. Drift');
    expect(r.text).toMatch(/Result: PASS .*3 drift findings/);
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
