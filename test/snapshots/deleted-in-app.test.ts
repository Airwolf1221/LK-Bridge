/**
 * v3 F2 (ADR 0049 decision 5; ADR 0046 decision 4, the owner's amendment): a page deleted in the LegendKeeper app (the
 * bridge holds no delete record of it) can be restored when a full or change snapshot holds it. The lifecycle and canon
 * guards judge the restore from the snapshot's state (its prefix, Status and tags), as they would a create of that page:
 * an Authoritative page comes back as a canonical proposal at scope propose. Refused only when no snapshot holds it.
 * The result says which snapshot it came from and when it was taken. v3 F12 (ADR 0081): at scope write it is direct.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const call = (name: string, args: Record<string, unknown>): Promise<ToolCall> =>
  w!.stack.call(c, name, { project: 'test', ...args });

/** Deleted in the app: soft-deleted in LegendKeeper, with no request through the bridge (so no delete record). */
async function deleteInApp(world: SnapshotsWorld, id: string) {
  world.repo.res.get(id)!.deletedAt = new Date().toISOString();
  await world.stack.runtime.tree.sweep(PROJECT);
}

describe('a page deleted in the app', () => {
  it('a page comes back from the snapshot that holds it, at scope write directly (one job), naming the snapshot', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    await deleteInApp(w, S.atlas);
    const r = await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'deleted' });
    expect(r.body.status, r.text).toBe('written');
    const summary = String(r.body.summary);
    expect(summary).toContain(snap);
    expect(summary).toMatch(/taken \d{4}-\d{2}-\d{2}T/);
    expect((await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000)).status).toBe(
      'succeeded',
    );
    expect(w.repo.live(S.atlas)).toBeDefined();
  });

  it('an Authoritative page comes back as a canonical proposal at scope propose', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect(w.stack.newToken('deleted-in-app-propose', 'propose').token);
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    await deleteInApp(w, S.harbour);
    const r = await call('restore_snapshot', { page: S.harbour, snapshot: snap, scope: 'deleted' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const p = w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!;
    expect(p.requiresCanonicalApproval, r.text).toBe(true);
    expect(p.summary).toContain('Old Harbour');
  });

  it('refused only when no snapshot holds it', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    // A page made after the snapshot, then deleted in the app: no snapshot holds it.
    w.repo.seed({ id: 'newpage1', name: '[BSRC] Newcomer', parentId: S.locations });
    await w.stack.runtime.tree.sweep(PROJECT);
    await deleteInApp(w, 'newpage1');
    const r = await call('restore_snapshot', { page: 'newpage1', snapshot: snap, scope: 'deleted' });
    expect(r.isError).toBe(true);
    // The bridge has never seen it: no snapshot holds it, so it cannot even be named.
    expect(['NOT_IN_SNAPSHOT', 'NOT_IN_REPOSITORY']).toContain(
      (r.body.error as { code?: string } | undefined)?.code,
    );
  });
});
