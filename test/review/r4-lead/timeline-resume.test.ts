/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the mock's state and tool results are JSON */
/**
 * CR-2026-11-R4 (the pick builder's note, R3-35's class): `update_timeline_event` RESUMING a stopped change wrote the
 * rows it had left from the plan's texts, so marks added to such a row since (bold, a link, a mention) were lost, while
 * a first run now compares and writes the row whole (R4-17). Each test asserts the SAFE behaviour.
 *
 * - LD-08: a date change stops after moving its row (the row's rewrite refused once); bold is added to the row's
 *   Historical Event in the app; the same request resumes: the row keeps its bold.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chronologyWorld, type ChronologyWorld } from '../../chronology/world.js';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let w: ChronologyWorld;
let client: Client;
beforeAll(async () => {
  w = await chronologyWorld();
  client = await w.stack.connect();
}, 120_000);
afterAll(async () => w?.close());

const FOURTH = 'Fourth Arkonan Age';
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });

/** The row's Historical Event cell's first paragraph, in the mock. */
function eventCell(rowId: string): Obj {
  const doc = w.repo.blocks.get(w.ages[FOURTH]!.table)!;
  const table = (doc.blocks as Obj[]).find((b) => b.kind === 'table')!;
  const row = (table.children as Obj[]).find((r) => r.id === rowId)!;
  return ((row.children as Obj[])[0]!.children as Obj[])[0]!;
}

describe('a resumed timeline change writes its rows whole (LD-08)', () => {
  it('LD-08: bold added to a row between the stop and the resume is kept', async () => {
    const args = {
      event: { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
      date: 'Kumikas 9th, 4A 881',
    };
    // The move is made; the row's rewrite is refused once: the change stops part-way.
    w.failAt('replaceBlock', 0);
    const first = await call('update_timeline_event', args);
    expect(first.isError, first.text).toBe(true);
    expect(first.body.error.code, first.text).toBe('WRITTEN_IN_PART');
    // Meanwhile, in the LegendKeeper app: the row's Historical Event made bold (the same words).
    const cell = eventCell('rfour006');
    cell.content = [{ text: 'Ashgate falls to the Isar host', bold: true }];
    const doc = w.repo.blocks.get(w.ages[FOURTH]!.table)!;
    doc.version += 1;
    // The same request resumes what is left.
    const again = await call('update_timeline_event', args);
    expect(again.body.status, again.text).toBe('written');
    expect(w.rows(FOURTH)).toContain('Kumikas 9th, 4A 881 | Ashgate falls to the Isar host | 1,251,188');
    // SAFE: the row was written from itself as it is now, its bold kept.
    expect(eventCell('rfour006').content, 'the bold added since was lost').toEqual([
      { text: 'Ashgate falls to the Isar host', bold: true },
    ]);
  });
});
