/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed tool results */
/**
 * RV4: a recreate (restore_snapshot, scope deleted, mode recreate; ADR 0042) that stops part-way. The page now exists, so
 * scope `deleted` refuses it (NOT_DELETED); what is left must be finishable by calling restore_snapshot again for what
 * is missing. Here the job stops at its first `createProperty` (LegendKeeper answers 500, nothing applied): the page and
 * its documents are there, its sidebar is not.
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

async function approve(r: ToolCall, asCanon = false) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  if (asCanon) await pol.commands.approveAsCanon('owner', id);
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

it('a recreate stopped at the sidebar can be finished by restoring the sidebar from the same snapshot', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  await call('delete_resource', { page: S.atlas, confirm: true });
  w.repo.res.delete(S.atlas); // purged: the id is free again
  w.sidebars.pages.delete(S.atlas); // and its sidebar with it (the model keeps sidebars apart from pages)
  const r = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'deleted',
    mode: 'recreate',
  });
  // The first property create fails (500, not applied).
  w.stack.mock.inject((x) => x.method === 'POST' && /\/resources\/[^/]+\/properties\/?$/.test(x.path), {
    kind: 'status',
    status: 500,
    code: 'INTERNAL',
  });
  const res = await approve(r, true);
  expect(res.state).toBe('failed');
  // The page and its documents are back; its sidebar is not.
  expect(w.repo.live(S.atlas)).toBeTruthy();
  expect(w.repo.liveDocs(w.repo.live(S.atlas)!).length).toBe(5);
  expect(w.sidebars.pages.get(S.atlas)?.props ?? []).toHaveLength(0);
  await w.stack.runtime.tree.sweep(PROJECT);
  // Calling again: the page is not deleted any more...
  const again = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'deleted',
    mode: 'recreate',
  });
  expect(again.body.error?.code, again.text).toBe('NOT_DELETED');
  // ...and the sidebar restore cannot bring a missing property back. E4 fixed the answer (never "already matches"
  // when it lists what differs); finishing a stopped recreate is open (docs/reviews/E4-2026-11.md, E4-OPEN-1).
  const sb = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'sidebar' });
  if (sb.body.status === 'nothing_to_do') {
    expect(sb.body.hint).not.toMatch(/already matches/);
    expect(sb.body.hint).toMatch(/NOT simply as it was/);
    expect(JSON.stringify(sb.body.notRestored ?? sb.body)).toMatch(/PROPERTIES|property/);
    return;
  }
  expect(sb.body.status, sb.text).toBe('proposal_captured');
  const done = await approve(sb, true);
  expect(done.state, JSON.stringify(done.job?.lastError ?? null)).toBe('executed');
  expect(w.sidebars.rows(S.atlas).map((x) => x.key)).toEqual(
    expect.arrayContaining(['Scope', 'Status', 'Region']),
  );
});

it('a recreate stopped part-way through its documents can be finished by restoring the page from the same snapshot', async () => {
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
  // The first timeline event create fails (500, not applied): the lanes are there, the events are not.
  w.stack.mock.inject((x) => x.method === 'POST' && /\/events\/?$/.test(x.path), {
    kind: 'status',
    status: 500,
    code: 'INTERNAL',
  });
  const res = await approve(r, true);
  expect(res.state).toBe('failed');
  const page = w.repo.live(S.atlas)!;
  const chronicle = w.repo.liveDocs(page).find((d) => d.name === 'Chronicle')!;
  expect(w.events.get(chronicle.id) ?? []).toHaveLength(0);
  await w.stack.runtime.tree.sweep(PROJECT);
  const pg = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'page' });
  // E4: never "already matches" while it lists documents it cannot match; the resume itself is open (E4-OPEN-1).
  if (pg.body.status === 'nothing_to_do') {
    expect(pg.body.hint).not.toMatch(/already matches/);
    expect(pg.body.hint).toMatch(/NOT simply as it was/);
    return;
  }
  expect(pg.body.status, pg.text).toBe('proposal_captured');
  const done = await approve(pg, true);
  expect(done.state, JSON.stringify(done.job?.lastError ?? null)).toBe('executed');
  expect(w.events.get(chronicle.id) ?? []).toHaveLength(3);
});
