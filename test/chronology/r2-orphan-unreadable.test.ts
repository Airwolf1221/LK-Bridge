/**
 * CR-2026-11-R2 (R2-49): deleting "an event without a row" (ADR 0048 decision 7) is refused beside a row that could be
 * its own: the same date, the same start, or its name. A row whose Date cell cannot be read has no date to compare, so
 * it is matched by its name only, and an event the owner made for it under another name is offered for deletion. The
 * proposal then shows the event and the three rows nearest it by date, never that row. The safe behaviour kept here:
 * the proposal (and the tool's dry run) list every unpaired row whose date cannot be read, so the owner sees the rows
 * the bridge cannot rule out before approving. (Whether such a row should block the delete is an owner decision:
 * ADR 0057 decision 2.)
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
const FOURTH = 'Fourth Arkonan Age';

let w: ChronologyWorld;
let client: Client;
const budget = {
  env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
  limits: { 'key-min': 5000, 'write-min': 2000 },
};
beforeAll(async () => {
  w = await chronologyWorld(budget);
  client = await w.stack.connect();
});
afterAll(() => w?.close());

const table = () => w.ages[FOURTH]!.table;
const tl = () => w.ages[FOURTH]!.timeline;
const tableBlock = () => (w.repo.blocks.get(table())!.blocks as Obj[]).find((b) => b.kind === 'table')!;
const cell = (id: string, text: string) => ({
  id: `${id}c`,
  kind: 'tableCell',
  children: [{ id: `${id}p`, kind: 'paragraph', content: [{ text }] }],
});
const addRow = (id: string, date: string, description: string, kcy: string) =>
  (tableBlock().children as Obj[]).push({
    id,
    kind: 'tableRow',
    children: [cell(`${id}a`, description), cell(`${id}b`, date), cell(`${id}c`, kcy)],
  });
const syncCount = () => {
  const main = (w.repo.blocks.get(w.mainDoc)!.blocks as Obj[]).find((b) => b.kind === 'table')!;
  const row = (main.children as Obj[]).find((r) => r.id === w.ages[FOURTH]!.mainRow)!;
  const para = ((row.children as Obj[])[1]!.children as Obj[])[0]!;
  para.content = [{ text: String((tableBlock().children as Obj[]).length - 1) }];
};

it('the orphan delete names every unpaired row whose date cannot be read, in the proposal and the dry run', async () => {
  // A row whose date the bridge cannot read, and the owner's own event for it, made in the app under a short name.
  addRow('rr2unrd1', 'The winter after the second siege; undated', 'The Ashgate walls are raised again', '');
  syncCount();
  w.liveEvents(tl()).push({
    id: 'er2walls',
    laneId: w.ages[FOURTH]!.lane,
    type: 'event',
    rank: 'z8',
    name: 'Walls raised',
    start: CAL.parser.parse('4A 890').start,
    detail: 1,
    uri: `lk://resources/${C.resource}/docs/${table()}`,
  });

  // The tool's dry run shows what the owner would approve.
  const dry = await w.stack.call(client, 'delete_timeline_event', {
    project: 'test',
    event: { event_id: 'er2walls', age: '4A' },
    orphan: true,
    confirm: true,
    dryRun: true,
  });
  expect(dry.body.status, dry.text).toBe('dry_run');
  expect(JSON.stringify(dry.body)).toContain('rr2unrd1');

  const fix = (await w.stack.runtime.chronology.proposeFix('owner', PROJECT, {
    kind: 'orphan',
    age: FOURTH,
    eventId: 'er2walls',
  })) as { status: string; proposalId: string };
  expect(fix.status).toBe('proposal_captured');
  const detail = w.stack.runtime.policy.proposals.detail(fix.proposalId)!;
  const head = detail.operationDetail!.chronology as Obj;
  expect(head.unreadable, JSON.stringify(head)).toEqual([
    {
      rowId: 'rr2unrd1',
      date: 'The winter after the second siege; undated',
      words: expect.stringContaining('The Ashgate walls are raised again') as unknown,
    },
  ]);
  expect(String(detail.operationDetail!.before)).toContain('The winter after the second siege; undated');
});
