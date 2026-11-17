/**
 * CR-2026-11-R2 (R2-49) and ADR 0057 decision 2 (the owner's, 17 November 2026: the stricter option). Deleting "an event
 * without a row" (ADR 0048 decision 7) is refused beside a row that could be its own: the same date, the same start, or
 * its name. A row whose Date cell cannot be read has no date to compare, so it is matched by its name only, and an event
 * the owner made for it under another name looked like an orphan. Now: while the age's table has an unpaired row whose
 * date cannot be read (not marked table-only), no event of the age is deleted as an orphan (`ORPHAN_NEAR_UNREADABLE`,
 * naming the rows), in the tool's dry run and in "Propose a fix" alike. Marking the row table-only, or fixing its date,
 * lifts the block; a row whose date cannot be read that appears after the proposal stops it inside the lock.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const approve = async (id: string) => {
  const proposals = w.stack.runtime.policy.proposals;
  await w.stack.runtime.policy.commands.approve('owner', id);
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  return proposals.get(id)!;
};
const dryRun = () =>
  w.stack.call(client, 'delete_timeline_event', {
    project: 'test',
    event: { event_id: 'er2walls', age: '4A' },
    orphan: true,
    confirm: true,
    dryRun: true,
  });
const propose = () =>
  w.stack.runtime.chronology.proposeFix('owner', PROJECT, {
    kind: 'orphan',
    age: FOURTH,
    eventId: 'er2walls',
  }) as Promise<{ status: string; proposalId: string }>;
const dateCell = (rowId: string) => {
  const row = (tableBlock().children as Obj[]).find((r) => r.id === rowId)!;
  return ((row.children as Obj[])[1]!.children as Obj[])[0]!;
};

describe('an orphan delete beside a row whose date cannot be read (ADR 0057 decision 2)', () => {
  it('is refused (ORPHAN_NEAR_UNREADABLE), naming the row, in the dry run and in Propose a fix', async () => {
    // A row whose date the bridge cannot read, and the owner's own event for it, made in the app under a short name.
    addRow(
      'rr2unrd1',
      'The winter after the second siege; undated',
      'The Ashgate walls are raised again',
      '',
    );
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
    const n = w.stack.mock.calls.length;

    const dry = await dryRun();
    const err = dry.body.error as { code?: string; message?: string } | undefined;
    expect(err?.code, dry.text).toBe('ORPHAN_NEAR_UNREADABLE');
    expect(err?.message).toContain('The winter after the second siege; undated');
    expect(JSON.stringify(dry.body)).toContain('rr2unrd1');

    await expect(propose()).rejects.toMatchObject({
      code: 'ORPHAN_NEAR_UNREADABLE',
      details: {
        unreadable: [
          {
            rowId: 'rr2unrd1',
            date: 'The winter after the second siege; undated',
            words: expect.stringContaining('The Ashgate walls are raised again') as unknown,
          },
        ],
      },
    });
    expect(w.stack.mock.calls.slice(n).filter((c) => c.method !== 'GET')).toEqual([]);
    expect(w.liveEvents(tl()).some((e) => e.id === 'er2walls')).toBe(true);
  });

  it('marking the row table-only lifts the block; clearing the mark brings it back', async () => {
    await w.stack.runtime.chronology.markTableOnly('owner', PROJECT, { age: FOURTH, rowId: 'rr2unrd1' });
    const dry = await dryRun();
    expect(dry.body.status, dry.text).toBe('dry_run');
    w.stack.runtime.chronology.unmarkTableOnly('owner', PROJECT, { age: FOURTH, rowId: 'rr2unrd1' });
    const again = await dryRun();
    expect((again.body.error as { code?: string } | undefined)?.code, again.text).toBe(
      'ORPHAN_NEAR_UNREADABLE',
    );
  });

  it('fixing the row’s date lifts the block', async () => {
    const para = dateCell('rr2unrd1');
    const was = para.content;
    para.content = [{ text: '4A 702' }];
    try {
      const dry = await dryRun();
      expect(dry.body.status, dry.text).toBe('dry_run');
    } finally {
      para.content = was;
    }
  });

  it('a row whose date cannot be read added after the proposal stops it inside the lock', async () => {
    await w.stack.runtime.chronology.markTableOnly('owner', PROJECT, { age: FOURTH, rowId: 'rr2unrd1' });
    const fix = await propose();
    expect(fix.status).toBe('proposal_captured');
    // Before the owner approves, another row whose date cannot be read appears in the table.
    addRow('rr2unrd2', 'Some years later', 'The harbour chain is forged', '');
    syncCount();
    const p = await approve(fix.proposalId);
    expect(p.state).not.toBe('executed');
    expect(w.liveEvents(tl()).some((e) => e.id === 'er2walls')).toBe(true);
  });
});
