/**
 * CR-2026-11-R2 (R2-05): "Finish" on a recreate that stopped part-way (ADR 0049 decision 6) compares the page the
 * recreate made with the snapshot and writes only what is missing. A timeline's events come 100 to a page
 * (`listEvents` is paged); the finish must read every page, or an event already made past the first hundred is made
 * again (or, with its original id, refused, so the finish never completes).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld;
let c: Client;
beforeAll(async () => {
  w = await snapshotsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000, 'write-hour': 20000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000, 'write-hour': 20000 },
  });
  c = await w.stack.connect();
});
afterAll(async () => w?.close());

const call = (name: string, args: Record<string, unknown>) =>
  w.stack.call(c, name, { project: 'test', ...args });

async function approve(r: ToolCall) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w.stack.runtime.policy;
  if (pol.proposals.get(id)!.requiresCanonicalApproval) await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 3000 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  return pol.proposals.get(id)!.state;
}

it('a finish reads every page of a timeline’s events: none is made twice, and it completes', async () => {
  // The Chronicle timeline with 123 events: more than one page of listEvents.
  const list = w.events.get(w.d.chronicle)!;
  for (let i = 0; i < 120; i++)
    list.push({
      id: `evx${String(i).padStart(5, '0')}`,
      laneId: 'lane0001',
      type: 'event',
      name: `Extra event ${i}`,
      start: 1000 + i,
      end: 1000 + i,
      detail: 1,
      rank: `b${String(i).padStart(3, '0')}`,
    });
  const total = list.length;
  expect(total).toBe(123);
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  await call('delete_resource', { page: S.atlas, confirm: true });
  w.repo.res.delete(S.atlas); // purged: the id is free again
  w.sidebars.pages.delete(S.atlas);
  const args = { page: S.atlas, snapshot: snap, scope: 'deleted', mode: 'recreate' };
  const first = await call('restore_snapshot', args);
  // The recreate stops at its 110th event: 109 are made.
  let posted = 0;
  w.stack.mock.inject((x) => x.method === 'POST' && /\/events\/?$/.test(x.path) && ++posted === 110, {
    kind: 'status',
    status: 400,
    code: 'VALIDATION_ERROR',
  });
  expect(await approve(first)).toBe('failed');
  const chronicle = () => w.repo.liveDocs(w.repo.live(S.atlas)!).find((d) => d.name === 'Chronicle')!;
  expect((w.events.get(chronicle().id) ?? []).length).toBe(109);

  await w.stack.runtime.tree.sweep(PROJECT);
  const again = await call('restore_snapshot', args);
  expect(await approve(again)).toBe('executed');
  const made = (w.events.get(chronicle().id) ?? []).map((e) => `${String(e.name)}@${String(e.start)}`);
  expect(new Set(made).size, 'no event is made twice').toBe(made.length);
  expect(made.length, 'every event of the snapshot, once').toBe(total);
});
