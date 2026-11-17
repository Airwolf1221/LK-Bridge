/**
 * CR-2026-11-R2 (R2-08): at scope `write` an agent's direct work is reviewed afterwards on the Review page (ADR 0055
 * decision A). A chronology link the agent chooses (`sync_timeline_event` with `event_id`: "this row is that event",
 * ADR 0048 F2.1) writes nothing to LegendKeeper but changes what the chronology check pairs, repairs and offers to
 * delete from then on; at scope `propose` it is a proposal for that reason. At scope `write` its job holds only the
 * bridge's own steps, so the Review queue never recorded it: the owner never saw it.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
const FOURTH = 'Fourth Arkonan Age';

let w: ChronologyWorld;
let agent: Client;
beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = await w.stack.connect(w.stack.newToken('r2-link-agent', 'write').token);
});
afterAll(() => w?.close());

const tl = () => w.ages[FOURTH]!.timeline;
const events = (): Obj[] => w.events(tl());

it('a chronology link chosen at scope write is on the Review page (or is a proposal)', async () => {
  const [harvest] = events().filter((e) => e.name === 'The year of the long harvest');
  const list = w.liveEvents(tl());
  list.splice(
    list.findIndex((e) => e.id === harvest!.id),
    1,
  );
  const year = CAL.parser.parse('4A 881');
  for (const [i, name] of ['Harvest, one telling', 'Harvest, another telling'].entries())
    list.push({
      id: `r2lnk00${i}`,
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: `z${i}`,
      uri: `lk://resources/${C.resource}/docs/${w.ages[FOURTH]!.table}`,
      detail: 1,
      name,
      start: year.start,
    });
  const before = w.stack.runtime.review.store.count(PROJECT, { state: 'all' });
  const r = await w.stack.call(agent, 'sync_timeline_event', {
    project: 'test',
    row: { date: '4A 881', description: 'The year of the long harvest' },
    event_id: 'r2lnk000',
  });
  if (r.body.status === 'proposal_captured') return; // the owner sees it first: safe
  expect(r.body.status, r.text).toBe('linked');
  for (let i = 0; i < 100; i++) {
    if (w.stack.runtime.review.store.count(PROJECT, { state: 'all' }) > before) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  const items = w.stack.runtime.review.list(PROJECT, { state: 'all' });
  const item = items.find((i) => i.tool === 'sync_timeline_event');
  expect(item, JSON.stringify(items.map((i) => i.tool))).toBeDefined();
  // What it changed is shown: the row and the event it now pairs.
  const detail = w.stack.runtime.review.detail(PROJECT, item!.jobId)!;
  expect(JSON.stringify(detail.pageChanges)).toContain('r2lnk000');
});
