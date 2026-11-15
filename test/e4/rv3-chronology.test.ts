/**
 * RV3-5: update_timeline_event re-makes an event when a date range becomes a single date (LegendKeeper cannot take an
 * end away) or when the event moves to another age, from `eventBody` alone (name, start, end, detail, lane, link)
 * (src/mcp/tools/timelines.ts). Everything else the event had (its colour, icon, image, hidden flag, "show on
 * calendar") is dropped, though the caller asked only for a new date.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const FOURTH = 'Fourth Arkonan Age';

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  client = await w.stack.connect();
});
afterAll(async () => {
  await w.close();
});

const STYLE = {
  color: '#aa3300',
  iconGlyph: 'fas fa-bell',
  imageUrl: 'https://assets.test/a/bells.webp',
  showOnCalendar: false,
};

it('RV3-5: changing a range to a single date keeps the event’s colour, icon, image and calendar flag', async () => {
  const tl = w.ages[FOURTH]!.timeline;
  // In the app, the owner styled the event.
  const live = w.liveEvents(tl).find((e) => e.name === 'The Quiet Years')!;
  Object.assign(live, STYLE);
  const r = await call('update_timeline_event', {
    event: { date: '4A 881 - 4A 900', name: 'The Quiet Years' },
    date: '4A 890',
  });
  expect(r.body.status, r.text).toBe('written');
  const ev = w.events(tl).filter((e) => e.name === 'The Quiet Years');
  expect(ev).toHaveLength(1);
  expect(ev[0]!.end).toBeUndefined(); // the date changed, as asked
  // Safe: nothing else about the event changed.
  expect(ev[0]).toMatchObject({ color: STYLE.color, imageUrl: STYLE.imageUrl, showOnCalendar: false });
  expect(String(ev[0]!.iconGlyph)).toMatch(/bell/);
});
