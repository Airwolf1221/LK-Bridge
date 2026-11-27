/**
 * v3 F12 follow-up (the owner, 27 November 2026; ADR 0081 amendment 1, decision 3): a chronology change that only
 * records a link between a row and its event (`sync_timeline_event` with `event_id` on an event that already agrees; no
 * LegendKeeper write) is direct at scope write, on the owner's Review page, and its Revert takes the link off; at scope
 * propose it is a proposal.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
const FOURTH = 'Fourth Arkonan Age';

let w: ChronologyWorld;
let writer: Client;
let proposer: Client;
beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  writer = await w.stack.connect(w.stack.newToken('f12-link-writer', 'write').token);
  proposer = await w.stack.connect(w.stack.newToken('f12-link-proposer', 'propose').token);
  // Two events tied with the row, so the agent must choose one (`event_id`): the one that agrees is linked.
  const tl = w.ages[FOURTH]!.timeline;
  const [harvest] = w.events(tl).filter((e: Obj) => e.name === 'The year of the long harvest');
  const list = w.liveEvents(tl);
  list.splice(
    list.findIndex((e) => e.id === (harvest as Obj).id),
    1,
  );
  const year = CAL.parser.parse('4A 881');
  for (const [i, name] of ['Harvest, one telling', 'Harvest, another telling'].entries())
    list.push({
      id: `f12lnk0${i}`,
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: `z${i}`,
      uri: `lk://resources/${C.resource}/docs/${w.ages[FOURTH]!.table}`,
      detail: 1,
      name,
      start: year.start,
    });
});
afterAll(() => w?.close());

const ROW = { date: '4A 881', description: 'The year of the long harvest' };
const links = () => w.stack.runtime.chronology.store.links(PROJECT, w.ages[FOURTH]!.table);
const linkedTo = (eventId: string) => links().some((l) => l.eventId === eventId);
const proposals = () => w.stack.runtime.policy.commands.listProposals('owner', { project: PROJECT }).length;

describe('a link-only chronology change', () => {
  it('at scope propose: a proposal, nothing recorded', async () => {
    const before = proposals();
    const r = await w.stack.call(proposer, 'sync_timeline_event', {
      project: 'test',
      row: ROW,
      event_id: 'f12lnk00',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(proposals()).toBe(before + 1);
    expect(linkedTo('f12lnk00')).toBe(false);
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'not now');
  });

  it('at scope write: direct (linked), on the Review page; Revert takes the link off', async () => {
    const before = proposals();
    const r = await w.stack.call(writer, 'sync_timeline_event', {
      project: 'test',
      row: ROW,
      event_id: 'f12lnk00',
    });
    expect(r.body.status, r.text).toBe('linked');
    expect(proposals()).toBe(before);
    const jobId = String(r.body.jobId);
    const job = await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(linkedTo('f12lnk00')).toBe(true);
    const onReview = () =>
      w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === jobId);
    for (let i = 0; i < 100 && !onReview(); i++) await new Promise((res) => setTimeout(res, 20));
    expect(onReview()).toBe(true);
    // The owner's Revert: the link taken off, nothing written to LegendKeeper.
    const preview = await w.stack.runtime.reverts.preview(PROJECT, jobId);
    expect(
      preview.targets.find((t) => t.kind === 'chronology'),
      JSON.stringify(preview.targets),
    ).toMatchObject({
      state: 'ready',
    });
    const writesBefore = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    if (rv.status !== 'submitted') return;
    const done = await w.stack.runtime.engine.wait(PROJECT, rv.revertJobId, 20_000);
    expect(done.status, JSON.stringify(done.lastError)).toBe('succeeded');
    expect(linkedTo('f12lnk00')).toBe(false);
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writesBefore);
  });
});
