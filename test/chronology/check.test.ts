/**
 * The chronology check (v2 D1, ADR 0038; PLAN-v2 4.12): read-only findings, never repairs. An untouched chronology has
 * none; each kind of drift made outside the bridge is reported; the maintenance job is registered weekly at P3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
let w: ChronologyWorld;
const FOURTH = 'Fourth Arkonan Age';

beforeAll(async () => {
  w = await chronologyWorld();
});
afterAll(async () => w.close());

const run = async () => {
  await w.stack.runtime.chronology.check(PROJECT, 'manual', 'P2');
  return w.stack.runtime.chronology.store.lastCheck(PROJECT)!;
};

describe('the chronology check', () => {
  it('has no findings on the untouched chronology, and costs about 15 reads (one per 100 events more)', async () => {
    const done = w.mark();
    const c = await run();
    expect(c.state).toBe('succeeded');
    expect(c.findings).toEqual([]);
    expect(c.summary).toMatch(/^No findings/);
    const cost = done();
    expect(cost.writes).toBe(0);
    // listCalendars, the Main table, then per age its table and one page of events.
    expect(cost.reads).toBe(2 + 2 * 4);
    console.log(`chronology check cost: ${cost.reads} reads`);
  });

  it('reports every kind of drift made outside the bridge, and repairs nothing', async () => {
    const table = w.repo.blocks.get(w.ages[FOURTH]!.table)!;
    const t = (table.blocks as Obj[]).find((b) => b.kind === 'table')!;
    const rows = t.children as Obj[];
    // Two rows swapped (out of calendar order), a wrong KCY, a wrong count, an event with a wrong link, an event
    // with no row and a row with no event.
    [rows[2], rows[3]] = [rows[3]!, rows[2]!];
    const kcyCell = ((rows[1]!.children as Obj[])[2]!.children as Obj[])[0]!;
    kcyCell.content = [{ text: '1,250,999' }];
    const main = w.repo.blocks.get(w.mainDoc)!;
    const mt = (main.blocks as Obj[]).find((b) => b.kind === 'table')!;
    const countPara = (
      ((mt.children as Obj[]).find((r) => r.id === w.ages[FOURTH]!.mainRow)!.children as Obj[])[1]!
        .children as Obj[]
    )[0]!;
    countPara.content = [{ text: '40' }];
    const evs = (w as unknown as { events(d: string): Obj[] }).events(w.ages[FOURTH]!.timeline);
    void evs;
    const before = JSON.stringify(w.repo.blocks.get(w.ages[FOURTH]!.table));
    const tl = w.ages[FOURTH]!.timeline;
    await w.stack.runtime.engine.run(
      'updateEvent',
      {
        path: { resourceId: 'chrono01', documentId: tl, eventId: 'efour000' },
        body: { uri: 'lk://resources/chrono01' },
      },
      { project: PROJECT, origin: { kind: 'test' } },
    );
    await w.stack.runtime.engine.run(
      'createEvent',
      {
        path: { resourceId: 'chrono01', documentId: tl },
        body: {
          laneId: w.ages[FOURTH]!.lane,
          type: 'event',
          name: 'Orphan',
          start: 1611395897400 + 1800 * 50,
          detail: 3,
          uri: `lk://resources/chrono01/docs/${w.ages[FOURTH]!.table}`,
        },
      },
      { project: PROJECT, origin: { kind: 'test' } },
    );
    await w.stack.runtime.engine.run(
      'deleteEvent',
      { path: { resourceId: 'chrono01', documentId: tl, eventId: 'efour005' } },
      { project: PROJECT, origin: { kind: 'test' } },
    );
    const c = await run();
    const kinds = c.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(
      expect.arrayContaining([
        'count_mismatch',
        'event_without_row',
        'row_out_of_order',
        'row_without_event',
        'wrong_kcy',
        'wrong_uri',
      ]),
    );
    expect(c.findings.every((f) => f.age === FOURTH)).toBe(true);
    expect(c.findings.find((f) => f.kind === 'count_mismatch')!.message).toContain('says 40');
    // Findings only: nothing was written.
    expect(JSON.stringify(w.repo.blocks.get(w.ages[FOURTH]!.table))).toBe(before);
  });

  it('is a weekly maintenance job at the lowest priority', () => {
    const job = w.stack.runtime.maintenance.scheduler.list().find((j) => j.id === 'chronology-check');
    expect(job).toMatchObject({
      implemented: true,
      writes: false,
      scope: 'project',
      priority: 'P3',
      schedule: { kind: 'interval', everySeconds: 7 * 86_400 },
    });
  });
});
