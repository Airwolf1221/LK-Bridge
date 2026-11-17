/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3.4 (ADR 0055 decision B): Revert of a direct chronology change, its table rows and timeline events kept in step
 * as the chronology tools keep them, against the mock chronology (the real server, MCP, policy, engine and the
 * chronology's own checkers): an added event and row deleted and the Main count put back; a changed description put
 * back; a changed date put back, the row moved back to its old place; an outside edit to the row blocks the revert; a
 * deletion is never reverted.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

let w: ChronologyWorld;
let client: Client;
let profileId: string;
const FOURTH = 'Fourth Arkonan Age';
const call = (tool: string, args: Record<string, unknown>) => w.stack.call(client, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const waitJob = (id: string) => rt().engine.wait(PROJECT, id, 25_000);
const jobOf = (r: { body: Record<string, unknown> }) => String(r.body.jobId);
const eventNames = () => w.events(w.ages[FOURTH]!.timeline).map((e) => String(e.name)).sort();

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  const t = w.stack.newToken('chronology-writer', 'write');
  profileId = t.profileId;
  client = await w.stack.connect(t.token);
});
afterAll(async () => w.close());

async function revert(jobId: string) {
  const r = await rt().reverts.revert('owner', PROJECT, jobId);
  expect(r.status, JSON.stringify(r)).toBe('submitted');
  if (r.status !== 'submitted') throw new Error('not submitted');
  return waitJob(r.revertJobId);
}

describe('Revert of a chronology change', () => {
  it('an added event: its row and event deleted, the count put back, in step', async () => {
    const rows = w.rows(FOURTH);
    const count = w.count(FOURTH);
    const events = eventNames();
    const r = await call('create_timeline_event', {
      date: 'Kumikas 3rd, 4A 881',
      name: 'Bells rung',
      description: 'The bells of Ashgate are rung for the fallen',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(w.count(FOURTH)).toBe(String(Number(count) + 1));
    const preview = await rt().reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`)).toEqual(['chronology:ready']);
    const job = await revert(jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.rows(FOURTH)).toEqual(rows);
    expect(w.count(FOURTH)).toBe(count);
    expect(eventNames()).toEqual(events);
  });

  it('a changed description: the row and the event get their old values back', async () => {
    const rows = w.rows(FOURTH);
    const events = w.events(w.ages[FOURTH]!.timeline).map((e) => JSON.stringify(e));
    const r = await call('update_timeline_event', {
      event: { date: '4A 881 - 4A 900', name: 'The Quiet Years' },
      description: 'The Quiet Years of the north',
      name: 'The Quiet North',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(w.rows(FOURTH)).not.toEqual(rows);
    const job = await revert(jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.rows(FOURTH)).toEqual(rows);
    expect(w.events(w.ages[FOURTH]!.timeline).map((e) => JSON.stringify(e))).toEqual(events);
  });

  it('a changed date: the row goes back to its old place with its old date', async () => {
    const rows = w.rows(FOURTH);
    const r = await call('update_timeline_event', {
      event: { date: 'Jehet 11th - 18th, 4A 424', description: 'The Week of Lanterns' },
      date: 'Isar 2nd, 4A 182',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(w.rows(FOURTH)).not.toEqual(rows);
    const job = await revert(jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.rows(FOURTH)).toEqual(rows);
  });

  it('a move to another age: the row and event back in their old age, both counts back', async () => {
    const THIRD = 'Third Arkonan Age';
    const before = { fourth: w.rows(FOURTH), third: w.rows(THIRD), c4: w.count(FOURTH), c3: w.count(THIRD) };
    const r = await call('update_timeline_event', {
      event: { date: 'Unknown, 4A 101', description: 'A comet is seen over Isar' },
      date: '3A 200',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    expect(w.count(FOURTH)).toBe(String(Number(before.c4) - 1));
    const job = await revert(jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect({ fourth: w.rows(FOURTH), third: w.rows(THIRD), c4: w.count(FOURTH), c3: w.count(THIRD) }).toEqual(before);
    expect(w.events(w.ages[FOURTH]!.timeline).some((e) => String(e.name).includes('comet'))).toBe(true);
    expect(w.events(w.ages[THIRD]!.timeline).some((e) => String(e.name).includes('comet'))).toBe(false);
  });

  it('an outside edit of the row the job added blocks the revert; nothing is written', async () => {
    const r = await call('create_timeline_event', {
      date: 'Kumikas 4th, 4A 881',
      name: 'Gates shut',
      description: 'The gates of Ashgate are shut',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    // Someone rewrites the new row's description in the app.
    const doc = w.ages[FOURTH]!.table;
    const json = JSON.stringify(w.repo.blocks.get(doc)!.blocks).replace(
      'The gates of Ashgate are shut',
      'The gates of Ashgate are shut at dusk',
    );
    w.repo.blocks.get(doc)!.blocks = JSON.parse(json) as never;
    const before = w.rows(FOURTH);
    const rv = await rt().reverts.revert('owner', PROJECT, jobId);
    expect(rv).toMatchObject({ status: 'refused', code: 'NOTHING_TO_REVERT' });
    const t = (rv as { readonly targets: readonly { kind: string; state: string }[] }).targets;
    expect(t).toEqual([expect.objectContaining({ kind: 'chronology', state: 'changed' })]);
    expect(w.rows(FOURTH)).toEqual(before);
  });

  it('a deleted event is never reverted', async () => {
    rt().policy.commands.setRails('owner', profileId, { deletes: false });
    const r = await call('delete_timeline_event', {
      event: { date: 'Kumikas 4th, 4A 881', description: 'The gates of Ashgate are shut at dusk' },
      confirm: true,
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await waitJob(jobId);
    const rv = await rt().reverts.revert('owner', PROJECT, jobId);
    expect(rv).toMatchObject({ status: 'refused', code: 'DELETION' });
    rt().policy.commands.setRails('owner', profileId, { deletes: true });
  });
});
