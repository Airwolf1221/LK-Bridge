/**
 * RV4: what a chronology change that stops part-way tells the agent (ADR 0038 decision 12, CR-07's honest outcomes).
 * The chronology job's labels include the bridge's own `record` steps, which `describeJob` (write-job.ts) counts as
 * LegendKeeper writes; and its WRITTEN_IN_PART hint says "Do not repeat this request" when repeating it is exactly how
 * a chronology change resumes.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

vi.setConfig({ testTimeout: 60_000 });

let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });

beforeAll(async () => {
  w = await chronologyWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('a chronology change that stops at its first LegendKeeper write', () => {
  it('says nothing was written in LegendKeeper, and tells the agent to repeat the same request to finish it', async () => {
    const args = { date: 'Malakh 3rd, 4A 77', name: 'Report probe', description: 'Stopped at the table row' };
    const rowsBefore = w.rows('Fourth Arkonan Age').length;
    w.failAt('insertBlock', 0);
    const first = await call('create_timeline_event', args);
    expect(first.isError, first.text).toBe(true);
    // Nothing was written in LegendKeeper: the row write was refused and no other write was sent.
    expect(w.rows('Fourth Arkonan Age').length).toBe(rowsBefore);
    const e = first.body.error as { code: string; written: string[]; hint?: string; message: string };
    // The bridge's own record step is not a LegendKeeper write.
    expect(e.written, first.text).toEqual([]);
    expect(e.code, first.text).not.toBe('WRITTEN_IN_PART');
    // And the agent is not told the opposite of how a chronology change resumes.
    expect(`${e.message} ${e.hint ?? ''}`, first.text).not.toMatch(/Do not repeat this request/);
    // Repeating it is what finishes it.
    const again = await call('create_timeline_event', args);
    expect(again.body.status, again.text).toBe('written');
  });
});
