/**
 * CR-2026-11 round 2 (write scope): a restore that brings an Authoritative page back (ADR 0049 decision 5: "the canon
 * guard judges the sidebar the page comes back with as a new page's facts, so an Authoritative page comes back only as
 * a canonical proposal"). LegendKeeper's restoreResource "restores a deleted resource together with every descendant
 * deleted by the same operation" (spec), which the mock tree models (a shared deletedAt).
 *
 * Every test asserts the SAFE behaviour: an Authoritative page does not come back without the owner's canonical
 * approval, whether it is restored on its own or with the page it was deleted under.
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

describe('restoring canon', () => {
  it('C1-control: Old Harbour deleted on its own in the app, restored through lk_api_write: a canonical proposal', async () => {
    w.repo.res.get(S.harbour)!.deletedAt = new Date().toISOString();
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await call('lk_api_write', {
      operationId: 'restoreResource',
      params: { path: { resourceId: S.harbour } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.requiresCanonicalApproval, r.text).toBe(true);
    expect(w.repo.live(S.harbour)).toBeUndefined();
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
    // Back as it was, by hand in the app, for the next test.
    w.repo.res.get(S.harbour)!.deletedAt = null;
    await w.stack.runtime.tree.sweep(PROJECT);
  });

  it('C1: [INDEX] Locations deleted with its pages in the app, restored with restore_resource: Old Harbour (Authoritative) only with canonical approval', async () => {
    w.repo.outside.delete(S.locations);
    expect(w.repo.live(S.harbour)).toBeUndefined();
    await w.stack.runtime.tree.sweep(PROJECT);
    let r = await call('restore_resource', { page: S.locations });
    if (r.body.error?.code === 'NOT_IN_REPOSITORY')
      r = await call('lk_api_write', {
        operationId: 'restoreResource',
        params: { path: { resourceId: S.locations } },
      });
    expect(
      {
        canonical: r.body.status === 'proposal_captured' && r.body.requiresCanonicalApproval === true,
        harbourBack: w.repo.live(S.harbour) !== undefined,
      },
      r.text,
    ).toEqual({ canonical: true, harbourBack: false });
  });
});
