/**
 * CR-2026-11-R2 (R2-06): a recreate (restore_snapshot, scope deleted, mode recreate; ADR 0042, ADR 0049 decision 6)
 * promises "never a second page". While one recreate of a page from a snapshot is still a proposal, or its job is still
 * running, the same request again must be refused: planned meanwhile, it is a second recreate (with new ids, a second
 * page) or a "finish" planned from a page still being written (no lock and no check in its job: what the first job
 * writes after the plan is written twice).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld;
let c: Client;
beforeAll(async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
});
afterAll(async () => w?.close());

const call = (name: string, args: Record<string, unknown>) =>
  w.stack.call(c, name, { project: 'test', ...args });

async function approve(r: ToolCall) {
  const id = String(r.body.proposalId);
  const pol = w.stack.runtime.policy;
  if (pol.proposals.get(id)!.requiresCanonicalApproval) await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 1000 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  return pol.proposals.get(id)!.state;
}

it('the same recreate again, while the first is still a proposal, is refused: one page, never two', async () => {
  const name = w.repo.live(S.atlas)!.name;
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  await call('delete_resource', { page: S.atlas, confirm: true });
  w.repo.res.delete(S.atlas);
  w.sidebars.pages.delete(S.atlas);
  const args = { page: S.atlas, snapshot: snap, scope: 'deleted', mode: 'recreate', ids: 'new' };
  const first = await call('restore_snapshot', args);
  expect(first.body.status, first.text).toBe('proposal_captured');
  const second = await call('restore_snapshot', args);
  const refused = second.body.status !== 'proposal_captured';
  expect(await approve(first)).toBe('executed');
  if (!refused) await approve(second);
  const pages = [...w.repo.res.values()].filter((x) => x.deletedAt === null && x.name === name);
  expect(pages, 'one recreated page').toHaveLength(1);
  expect(refused, second.text).toBe(true);
  expect(second.text).toMatch(/RESTORE_IN_PROGRESS/);
});

it('a recreate while an undelete of the same page is still a proposal is refused too: never the original and a copy', async () => {
  const id = S.harbour;
  const name = w.repo.live(id)!.name;
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  const del = await call('delete_resource', { page: id, confirm: true });
  if (del.body.status === 'proposal_captured') expect(await approve(del)).toBe('executed');
  expect(w.repo.live(id), 'deleted (soft)').toBeUndefined();
  const undelete = await call('restore_snapshot', {
    page: id,
    snapshot: snap,
    scope: 'deleted',
    mode: 'undelete',
  });
  expect(undelete.body.status, undelete.text).toBe('proposal_captured');
  const recreate = await call('restore_snapshot', {
    page: id,
    snapshot: snap,
    scope: 'deleted',
    mode: 'recreate',
    ids: 'new',
  });
  const refused = recreate.body.status !== 'proposal_captured';
  expect(await approve(undelete)).toBe('executed');
  if (!refused) await approve(recreate);
  const pages = [...w.repo.res.values()].filter((x) => x.deletedAt === null && x.name === name);
  expect(pages, 'the original only').toHaveLength(1);
  expect(refused, recreate.text).toBe(true);
  expect(recreate.text).toMatch(/RESTORE_IN_PROGRESS/);
});
