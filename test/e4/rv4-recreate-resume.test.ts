/**
 * RV4, finished in v3 F2 (ADR 0049 decision 6; E4-OPEN-1): a recreate (restore_snapshot, scope deleted, mode recreate;
 * ADR 0042) that stops part-way can be finished: the same request again (or "Finish" on the dashboard) compares the page
 * it made (its id minted when the restore was planned) with the snapshot and writes only what is missing. Never a
 * second page or document. Each case stops the job at one kind of step (LegendKeeper refuses it, nothing applied).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerConfirmedOrigin } from '../../src/admin/routes/util.js';
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

/** v3 F12 (ADR 0081): at scope write a restore is direct, one job (on the Review page); how that job ended. */
async function ran(r: ToolCall) {
  // A job that failed answers as an error that names it.
  const jobId = (r.body.jobId ?? (r.body.error as { jobId?: string } | undefined)?.jobId) as
    string | undefined;
  expect(jobId, r.text).toBeTruthy();
  const job = await w!.stack.runtime.engine.wait(PROJECT, jobId!, 20_000);
  return { state: job.status, job };
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
    w.stack.mock.inject(match, { kind: 'status', status: 400, code: 'VALIDATION_ERROR' });
    const r = await call('restore_snapshot', args);
    expect((await ran(r)).state).toBe('failed');
    await w.stack.runtime.tree.sweep(PROJECT);
    const again = await call('restore_snapshot', args);
    expect(again.body.status, again.text).toBe('written');
    expect((await ran(again)).state).toBe('succeeded');
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

it('"Finish" on the dashboard runs the same as one confirmed job: only what the recreated page lacks', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  await call('delete_resource', { page: S.atlas, confirm: true });
  w.repo.res.delete(S.atlas);
  w.sidebars.pages.delete(S.atlas);
  w.stack.mock.inject((x) => x.method === 'POST' && /\/properties\/?$/.test(x.path), {
    kind: 'status',
    status: 400,
    code: 'VALIDATION_ERROR',
  });
  const r = await call('restore_snapshot', {
    page: S.atlas,
    snapshot: snap,
    scope: 'deleted',
    mode: 'recreate',
  });
  expect((await ran(r)).state).toBe('failed');
  await w.stack.runtime.tree.sweep(PROJECT);
  const rec = w.stack.runtime.restores.list(PROJECT, { limit: 5 })[0]!;
  // v3 F12 (ADR 0081): the owner's confirmed dashboard action runs at once, as one job.
  const f = await w.stack.runtime.restores.finish(
    PROJECT,
    rec.id,
    ownerConfirmedOrigin('snapshots.finish_recreate'),
    'owner',
  );
  expect(f.status).toBe('submitted');
  const done = f as { jobId: string; summary: string };
  expect(done.summary).toMatch(/finish the recreate \(only what is missing\)/);
  expect((await w.stack.runtime.engine.wait(PROJECT, done.jobId, 20_000)).status).toBe('succeeded');
  expect(w.sidebars.rows(S.atlas).length).toBeGreaterThan(0);
});
