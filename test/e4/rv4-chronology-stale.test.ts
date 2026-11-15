/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * RV4: ADR 0038 decision 12: on a resume "a row or count must hold its before or after value; anything else is
 * CHRONOLOGY_RESUME_CONFLICT". create_timeline_event stops after its table row (the event's create fails); the owner
 * then corrects the new row's description in the app; the same request again. `remaining()` (timelines.ts) checks only
 * that the inserted row is PRESENT, so the resume creates the event from the stale plan (the old description) and links
 * it to the edited row, and counts it, instead of refusing.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

vi.setConfig({ testTimeout: 60_000 });

type Obj = Record<string, unknown>;
let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const FOURTH = 'Fourth Arkonan Age';

beforeAll(async () => {
  w = await chronologyWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

function findRow(blocks: Obj[], id: string): Obj | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (Array.isArray(b.children)) {
      const hit = findRow(b.children as Obj[], id);
      if (hit) return hit;
    }
  }
  return null;
}

it('a row edited in the app between the stop and the resume is a resume conflict, not an event from the old plan', async () => {
  const args = {
    date: 'Malakh 3rd, 4A 88',
    name: 'Stale probe',
    description: 'The first wording of the event',
  };
  const count = Number(w.count(FOURTH));
  w.failAt('createEvent', 0);
  const first = await call('create_timeline_event', args);
  expect(first.isError, first.text).toBe(true);
  const rec = w.stack.runtime.chronology.store.incomplete(PROJECT)[0]!;
  const ins = rec.target.writes.find((x) => x.kind === 'row.insert') as { rowId: string; documentId: string };
  // The owner corrects the new row's description in the app (its first cell).
  const doc = w.repo.blocks.get(ins.documentId)!;
  const row = findRow(doc.blocks as Obj[], ins.rowId)!;
  const cell = (row.children as Obj[])[0]!;
  (cell.children as Obj[])[0]!.content = [{ text: 'The corrected wording, by the owner' }];
  doc.version++;
  expect(w.rows(FOURTH).some((r) => r.includes('The corrected wording'))).toBe(true);
  // The same request again.
  const again = await call('create_timeline_event', args);
  const ev = w.events(w.ages[FOURTH]!.timeline).filter((e) => e.name === 'Stale probe');
  // Safe: refused as a resume conflict (the row holds neither its before nor its after value), nothing written.
  expect(again.body.error?.code ?? again.body.status, `${again.text}\nevents: ${JSON.stringify(ev)}`).toBe(
    'CHRONOLOGY_RESUME_CONFLICT',
  );
  expect(ev).toHaveLength(0);
  expect(Number(w.count(FOURTH))).toBe(count);
});
