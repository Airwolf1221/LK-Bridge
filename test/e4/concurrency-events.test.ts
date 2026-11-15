/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * PLAN-v2 10.6 test 3 for the events family (docs/reviews/E4-2026-11.md, section 4): an outside edit of a timeline
 * event between update_timeline_event's plan read and its job's in-lock check is caught there (events carry no version:
 * the check compares the event with what the plan read); nothing is written and the app's edit survives.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest } from '../contract/mock-lk.js';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

let w: ChronologyWorld;
let client: Client;
const FOURTH = 'Fourth Arkonan Age';
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  client = await w.stack.connect();
}, 60_000);
afterAll(() => w.close());

/** Runs `fn` before the n-th matching request (0-based) is answered, ahead of the world's own handlers. */
function before(match: (r: MockRequest) => boolean, n: number, fn: () => void): () => void {
  let seen = 0;
  const key = /E4EVENTS|.*/;
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(key, (req) => {
    if (match(req) && seen++ === n) fn();
    return undefined;
  });
  for (const [k, v] of rest) w.overrides.set(k, v);
  return () => w.overrides.delete(key);
}

describe('10.6 test 3, events: an outside edit between the plan and the write', () => {
  it('update_timeline_event: the event renamed in the app meanwhile is a conflict; nothing written, the rename kept', async () => {
    const tl = w.ages[FOURTH]!.timeline;
    const target = w.events(tl).find((e) => typeof e.name === 'string' && e.name.length > 0)!;
    const rowsBefore = w.rows(FOURTH);
    // The plan reads the timeline's events once; the job's in-lock check reads them again: edit in between.
    const off = before(
      (r) => r.method === 'GET' && r.path.includes(`/docs/${tl}/events`),
      1,
      () => {
        // The stored event itself (w.events gives copies): an edit made in the app.
        w.liveEvents(tl).find((e) => e.id === target.id)!.name = 'Renamed in the app';
      },
    );
    const r = await call('update_timeline_event', {
      event: { age: FOURTH, event_id: String(target.id) },
      name: 'Renamed by the bridge',
    });
    off();
    const now = w.events(tl).find((e) => e.id === target.id)!;
    // Refused as a conflict inside the lock (never written over an edit the plan did not see).
    expect(r.isError, r.text).toBe(true);
    expect(String(r.body.error.code), r.text).toMatch(/CONFLICT|CHANGED|DRIFT/);
    expect(now.name).toBe('Renamed in the app');
    expect(w.rows(FOURTH)).toEqual(rowsBefore);
  });
});
