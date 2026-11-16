/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed tool results */
/**
 * RV4, finished in v3 F2 (ADR 0049 decision 6; E4-OPEN-1): a recreate (restore_snapshot, scope deleted, mode recreate;
 * ADR 0042) that stops part-way can be finished: the same request again (or "Finish" on the dashboard) compares the page
 * it made (its id minted when the proposal was captured) with the snapshot and writes only what is missing. Never a
 * second page or document. Each case stops the job at one kind of step (LegendKeeper refuses it, nothing applied).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function approve(r: ToolCall, asCanon?: boolean) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  if (asCanon ?? pol.proposals.get(id)!.requiresCanonicalApproval)
    await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  const p = pol.proposals.get(id)!;
  const job = p.jobId ? w!.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
  return { state: p.state, job };
}

const STOPS = [
  {
    at: 'the page itself',
    match: (x: { method: string; path: string }) => x.method === 'POST' && /\/resources\/?$/.test(x.path),
  },

  {
    at: 'a map feature',
    match: (x: { method: string; path: string }) => x.method === 'POST' && /\/features\/?$/.test(x.path),
  },
  {
    at: 'a timeline lane',
    match: (x: { method: string; path: string }) => x.method === 'POST' && /\/lanes\/?$/.test(x.path),
  },
  {
    at: 'a timeline event',
    match: (x: { method: string; path: string }) => x.method === 'POST' && /\/events\/?$/.test(x.path),
  },
  {
    at: 'the sidebar',
    match: (x: { method: string; path: string }) => x.method === 'POST' && /\/properties\/?$/.test(x.path),
  },
];

describe('a recreate stopped part-way is finished, never duplicated', () => {
  it.each(STOPS)('stopped at $at, then the same request again finishes it', async ({ match }) => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    const before = w.repo
      .liveDocs(w.repo.live(S.atlas)!)
      .map((d) => `${d.type}:${d.name}`)
      .sort();
    const sidebarBefore = w.sidebars.rows(S.atlas).map((x) => x.key);
    await call('delete_resource', { page: S.atlas, confirm: true });
    w.repo.res.delete(S.atlas); // purged: the id is free again
    w.sidebars.pages.delete(S.atlas);
    const args = { page: S.atlas, snapshot: snap, scope: 'deleted', mode: 'recreate' };
    const r = await call('restore_snapshot', args);
    w.stack.mock.inject(match, { kind: 'status', status: 400, code: 'VALIDATION_ERROR' });
    expect((await approve(r)).state).toBe('failed');
    await w.stack.runtime.tree.sweep(PROJECT);
    const again = await call('restore_snapshot', args);
    expect(again.body.status, again.text).toBe('proposal_captured');
    expect((await approve(again)).state).toBe('executed');
    // One page, with exactly the documents and facts it had: nothing twice.
    const pages = [...w.repo.res.values()].filter((x) => x.id === S.atlas && x.deletedAt === null);
    expect(pages).toHaveLength(1);
    expect(
      w.repo
        .liveDocs(w.repo.live(S.atlas)!)
        .map((d) => `${d.type}:${d.name}`)
        .sort(),
    ).toEqual(before);
    expect(w.sidebars.rows(S.atlas).map((x) => x.key)).toEqual(sidebarBefore);
    const chronicle = w.repo.liveDocs(w.repo.live(S.atlas)!).find((d) => d.name === 'Chronicle')!;
    expect(w.events.get(chronicle.id) ?? []).toHaveLength(3);
    // And a third time: nothing is missing now.
    await w.stack.runtime.tree.sweep(PROJECT);
    const third = await call('restore_snapshot', args);
    expect(third.body.status, third.text).toBe('nothing_to_do');
  });
});

it('"Finish" on the dashboard proposes the same: only what the recreated page lacks', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  await call('delete_resource', { page: S.atlas, confirm: true });
  w.repo.res.delete(S.atlas);
  w.sidebars.pages.delete(S.atlas);
  const r = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'deleted',
    mode: 'recreate',
  });
  w.stack.mock.inject((x) => x.method === 'POST' && /\/properties\/?$/.test(x.path), {
    kind: 'status',
    status: 400,
    code: 'VALIDATION_ERROR',
  });
  expect((await approve(r)).state).toBe('failed');
  await w.stack.runtime.tree.sweep(PROJECT);
  const rec = w.stack.runtime.restores.list(PROJECT, { limit: 5 })[0]!;
  const f = await w.stack.runtime.restores.finish(PROJECT, rec.id, { kind: 'ui', tool: 'test' }, 'owner');
  expect(f.status).toBe('proposal_captured');
  const summary = w.stack.runtime.policy.proposals.get((f as { proposalId: string }).proposalId)!.summary;
  expect(summary).toMatch(/finish the recreate \(only what is missing\)/);
});
