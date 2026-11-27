/**
 * CR-2026-11 round 2 (write scope): a restore that brings an Authoritative page back (ADR 0049 decision 5: "the canon
 * guard judges the sidebar the page comes back with as a new page's facts, so an Authoritative page comes back only as
 * a canonical proposal"). LegendKeeper's restoreResource "restores a deleted resource together with every descendant
 * deleted by the same operation" (spec), which the mock tree models (a shared deletedAt).
 *
 * v3 F12 (ADR 0081): at scope `write` a restore of canon is direct: the Authoritative page comes back at once, whether
 * restored on its own or with the page it was deleted under, and the job is on the owner's Review page (with Revert).
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../../snapshots/world.js';
import { writeAgent, type Agent } from './helpers.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld;
let a: Agent;

beforeAll(async () => {
  w = await snapshotsWorld();
  // A full snapshot holds every page as it is now (Old Harbour: Status Authoritative, CANON).
  await w.stack.runtime.snapshots.full(PROJECT, 'manual');
  a = await writeAgent(w, 'r2-restore-agent');
}, 120_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);

const onReview = (jobId: string) =>
  w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === jobId);

describe('restoring canon', () => {
  it('C1-control: Old Harbour deleted on its own in the app, restored through lk_api_write: directly, on Review', async () => {
    w.repo.res.get(S.harbour)!.deletedAt = new Date().toISOString();
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await call('lk_api_write', {
      operationId: 'restoreResource',
      params: { path: { resourceId: S.harbour } },
    });
    expect(r.body.status, r.text).toBe('succeeded');
    const jobId = String(r.body.jobId);
    expect((await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000)).status).toBe('succeeded');
    expect(w.repo.live(S.harbour)).toBeDefined();
    expect(onReview(jobId)).toBe(true);
  });

  it('C1: [INDEX] Locations deleted with its pages in the app, restored with restore_resource: Old Harbour (Authoritative) back directly, on Review', async () => {
    w.repo.outside.delete(S.locations);
    expect(w.repo.live(S.harbour)).toBeUndefined();
    await w.stack.runtime.tree.sweep(PROJECT);
    let r = await call('restore_resource', { page: S.locations });
    if (r.body.error?.code === 'NOT_IN_REPOSITORY')
      r = await call('lk_api_write', {
        operationId: 'restoreResource',
        params: { path: { resourceId: S.locations } },
      });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const jobId = String(r.body.jobId);
    expect((await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000)).status, r.text).toBe('succeeded');
    expect({ harbourBack: w.repo.live(S.harbour) !== undefined, onReview: onReview(jobId) }, r.text).toEqual({
      harbourBack: true,
      onReview: true,
    });
  });
});
