/**
 * RV3-6: `updateEvent` and `updateLane` overwrite timeline content (LegendKeeper keeps no history of events or lanes)
 * but are journalled with no pre-image at all (src/jobs/op-meta.ts: `patch('event')`, `patch('lane')`; neither the
 * restore nor the chronology's event.update passes journalPreImage). Shown through a timeline restore. (Checked and
 * sound: deleteLane's pre-image does carry the lane's events, step-exec.ts ~1913, though op-meta's comment says not.)
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

async function approve(r: ToolCall) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  const p = pol.proposals.get(id)!;
  return { state: p.state, jobId: p.jobId! };
}

it('RV3-6: a timeline restore journals what its updateEvent and updateLane overwrote', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  // In the app, after the snapshot: an event and a lane renamed, and a new lane with an event of its own.
  const ev = w.events.get(w.d.chronicle)!;
  ev.find((e) => e.id === 'evt00001')!.name = 'Founding, as the owner rewrote it';
  w.lanes.get(w.d.chronicle)!.find((l) => l.id === 'lane0001')!.name = 'Lane renamed in the app';
  w.lanes.get(w.d.chronicle)!.push({ id: 'lane0009', name: 'Owner lane', rank: 'c' });
  ev.push({
    id: 'evt00009',
    laneId: 'lane0009',
    type: 'event',
    name: 'Owner event',
    start: 900,
    detail: 1,
    rank: 'z',
  });
  const r = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'document',
    document: 'Chronicle',
  });
  const res = await approve(r);
  expect(res.state).toBe('executed');
  const j = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
    jobId: res.jobId,
    includePreImage: true,
    limit: 50,
  });
  const pre = (op: string) => JSON.stringify(j.find((e) => e.opId === op)?.preImage ?? null);
  expect(j.map((e) => e.opId)).toEqual(expect.arrayContaining(['updateEvent', 'updateLane', 'deleteLane']));
  const all = {
    updateEvent: pre('updateEvent'),
    updateLane: pre('updateLane'),
    deleteLane: pre('deleteLane'),
  };
  // Safe: each entry keeps what the write replaced or removed.
  expect(all, JSON.stringify(all)).toBeDefined();
  expect(pre('updateEvent'), JSON.stringify(all)).toMatch(/as the owner rewrote it/);
  expect(pre('updateLane')).toMatch(/Lane renamed in the app/);
});

it('RV3-6b: a map restore journals the feature its updateFeature overwrote (update_map_feature does)', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  // In the app, after the snapshot: the region redrawn and recoloured.
  const reg = w.features.get(w.d.map)!.find((f) => f.id === 'reg00001')!;
  reg.polygon = [
    [-5, 5],
    [-6, 6],
    [-7, 5],
    [-5, 4],
  ];
  reg.color = '#990000';
  const r = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'document',
    document: 'Map',
  });
  const res = await approve(r);
  expect(res.state).toBe('executed');
  const j = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
    jobId: res.jobId,
    includePreImage: true,
    limit: 50,
  });
  const e = j.find((x) => x.opId === 'updateFeature');
  expect(e).toBeDefined();
  // Safe: the redrawn region (what the restore overwrote) is in the journal.
  expect(JSON.stringify(e!.preImage ?? null)).toMatch(/#990000/);
});
