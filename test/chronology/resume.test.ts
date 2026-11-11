/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * A chronology change that stops part-way (v2 D1, ADR 0038): a failure at each of the three writes (the table row, the
 * timeline event, the Main count), then the same request again finishes only what is left (never replays); another
 * change of that age waits for it; the owner can mark one resolved. Plus the lane-delete pre-image (the CR note: the
 * lane's events too, on every route) and the refusal before the owner has confirmed the chronology.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { chronologyWorld, type ChronologyWorld } from './world.js';

let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const FOURTH = 'Fourth Arkonan Age';
const tl = () => w.ages[FOURTH]!.timeline;

beforeAll(async () => {
  w = await chronologyWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('a failure at each write, then the same request resumes', () => {
  for (const [op, n, label] of [
    ['insertBlock', 0, 'the table row'],
    ['createEvent', 0, 'the timeline event'],
    ['updateBlock', 0, 'the Main count'],
  ] as const) {
    it(`stops at ${label}; calling again does only what is left`, async () => {
      const args = {
        date: `Malakh 3rd, 4A ${op.length * 10}`,
        name: `Resume ${op}`,
        description: `Resumed after ${op} failed`,
      };
      const count = Number(w.count(FOURTH));
      w.failAt(op, n);
      const first = await call('create_timeline_event', args);
      expect(first.isError, first.text).toBe(true);
      expect(first.body.error.code).toMatch(/WRITTEN_IN_PART|LK_ERROR|VALIDATION_ERROR/);
      const rec = w.stack.runtime.chronology.store.incomplete(PROJECT);
      expect(rec).toHaveLength(1);
      // Another change of this age waits.
      const other = await call('create_timeline_event', {
        date: '4A 700',
        name: 'Other',
        description: 'Another event',
      });
      expect(other.body.error.code).toBe('CHRONOLOGY_INCOMPLETE');
      const again = await call('create_timeline_event', args);
      expect(again.body.status, again.text).toBe('written');
      expect(again.body.resumes).toMatchObject({ recordId: rec[0]!.id });
      // Only what was left was written (the steps the answer lists).
      const left = { insertBlock: 3, createEvent: 2, updateBlock: 1 }[op];
      expect(again.body.steps).toHaveLength(left);
      expect(w.rows(FOURTH).filter((x) => x.includes(`Resumed after ${op} failed`))).toHaveLength(1);
      expect(w.events(tl()).filter((e) => e.name === `Resume ${op}`)).toHaveLength(1);
      expect(w.count(FOURTH)).toBe(String(count + 1));
      expect(w.stack.runtime.chronology.store.incomplete(PROJECT)).toHaveLength(0);
    });
  }

  it('finishes a stopped delete and a stopped move between ages the same way', async () => {
    w.failAt('deleteEvent', 0);
    const d = await call('delete_timeline_event', {
      event: { date: 'Unknown, 4A 101', description: 'A comet is seen over Isar' },
      confirm: true,
    });
    expect(d.body.error.code, d.text).toBe('WRITTEN_IN_PART');
    expect(w.rows(FOURTH).some((x) => x.includes('A comet'))).toBe(false);
    const d2 = await call('delete_timeline_event', {
      event: { date: 'Unknown, 4A 101', description: 'A comet is seen over Isar' },
      confirm: true,
    });
    expect(d2.body.status, d2.text).toBe('written');
    expect(w.events(tl()).some((e) => String(e.name).includes('A comet'))).toBe(false);

    const counts = { a: Number(w.count(FOURTH)), b: Number(w.count('First Arkonan Age')) };
    w.failAt('updateBlock', 1); // the second count (the old age's)
    const m = await call('update_timeline_event', {
      event: { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
      date: 'Kumikas 3rd, 1A 881',
    });
    expect(m.body.error.code, m.text).toBe('WRITTEN_IN_PART');
    const m2 = await call('update_timeline_event', {
      event: { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
      date: 'Kumikas 3rd, 1A 881',
    });
    expect(m2.body.status, m2.text).toBe('written');
    expect(m2.body.steps).toHaveLength(1);
    expect(w.count(FOURTH)).toBe(String(counts.a - 1));
    expect(w.count('First Arkonan Age')).toBe(String(counts.b + 1));
  });

  it('lets the owner mark a stopped change resolved, after which other changes of the age go ahead', async () => {
    w.failAt('createEvent', 0);
    const r = await call('create_timeline_event', {
      date: '4A 702',
      name: 'Stuck',
      description: 'A stuck change',
    });
    expect(r.isError).toBe(true);
    const rec = w.stack.runtime.chronology.store.incomplete(PROJECT)[0]!;
    w.stack.runtime.chronology.resolve('owner', PROJECT, rec.id);
    const ok = await call('create_timeline_event', {
      date: '4A 703',
      name: 'Next',
      description: 'The next one',
    });
    expect(ok.body.status, ok.text).toBe('written');
  });
});

describe('a lane delete keeps the lane’s events in its journal pre-image, on every route', () => {
  it('lk_api_write deleteLane: the pre-image is the lane with its events', async () => {
    await call('create_timeline_lane', { page: 'Battle Plans', document: 'Campaign', name: 'Scouts' });
    const lane = w.lanes(w.planTimeline).find((l) => l.name === 'Scouts')!;
    await w.stack.runtime.engine.run(
      'createEvent',
      {
        path: { resourceId: 'plans001', documentId: w.planTimeline },
        body: { laneId: lane.id, type: 'event', name: 'Ride out', start: 1800, detail: 3 },
      },
      { project: PROJECT, origin: { kind: 'test' } },
    );
    const r = await call('lk_api_write', {
      operationId: 'deleteLane',
      params: { path: { resourceId: 'plans001', documentId: w.planTimeline, laneId: lane.id } },
    });
    expect(r.isError, r.text).toBe(false);
    const j = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
      opId: 'deleteLane',
      includePreImage: true,
      limit: 5,
    });
    const pre = j[0]!.preImage as { name?: string; events?: { name?: string }[] };
    expect(pre.name).toBe('Scouts');
    expect(pre.events?.map((e) => e.name)).toEqual(['Ride out']);
  });
});

describe('before the owner confirms the chronology', () => {
  it('every chronology tool refuses, saying what the owner must do', async () => {
    const u = await chronologyWorld({ confirm: false });
    try {
      const c = await u.stack.connect();
      const r = await u.stack.call(c, 'create_timeline_event', {
        project: 'test',
        date: '4A 5',
        name: 'x',
        description: 'y',
      });
      expect(r.body.error.code).toBe('CHRONOLOGY_NOT_CONFIGURED');
      expect(r.body.error.message).toContain('Chronology page');
      const d = await u.stack.call(c, 'delete_timeline_event', {
        project: 'test',
        event: { row_id: 'x', age: '4A' },
        confirm: true,
      });
      expect(d.body.error.code).toBe('CHRONOLOGY_NOT_CONFIGURED');
    } finally {
      await u.close();
    }
  });
});
