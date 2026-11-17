/**
 * CR-2026-11 round 2 (write scope): the rails' interplay with `operation_id` (ADR 0055 F: "operation_id gives the same
 * answer at both scopes, a rail's proposal included (a repeat returns the same proposal)") and with the engine's
 * per-step re-check of a direct job ("a direct job is asked again by the gate before each step (a revoked connection or
 * a lowered scope stops it)"; C3: "at entry only; a queued job is not asked again").
 *
 * Every test asserts the SAFE behaviour.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, ROOT, type DiscoverWorld } from '../../discover/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeAgent, type Agent } from './helpers.js';

let w: DiscoverWorld;
let a: Agent;

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-idem-agent');
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const cmd = () => w.stack.runtime.policy.commands;
const items = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `[INDEX] ${tag} ${i}`, parent: ROOT }));

describe('operation_id and the rails', () => {
  it('G1: a rail proposal repeated with the same operation_id after the owner switches the rail off is still that proposal', async () => {
    const args = { items: items(11, 'Idem A'), operation_id: 'r2-idem-a' };
    const first = await call('create_many_resources', args);
    expect(first.body.status, first.text).toBe('proposal_captured');
    cmd().setRails('owner', a.profileId, { bulk: false });
    const before = w.repo.mutations.length;
    const again = await call('create_many_resources', args);
    cmd().setRails('owner', a.profileId, { bulk: true });
    expect(
      {
        repeated: again.body.repeated,
        proposalId: again.body.proposalId,
        made: w.repo.mutations.length - before,
      },
      again.text,
    ).toEqual({
      repeated: true,
      proposalId: first.body.proposalId,
      made: 0,
    });
  });

  it('G2: after the owner rejects a rail proposal, the same operation_id does not run it directly', async () => {
    const args = { items: items(11, 'Idem B'), operation_id: 'r2-idem-b' };
    const first = await call('create_many_resources', args);
    expect(first.body.status, first.text).toBe('proposal_captured');
    cmd().reject('owner', String(first.body.proposalId), 'no');
    const before = w.repo.mutations.length;
    const again = await call('create_many_resources', args);
    expect({ made: w.repo.mutations.length - before, jobId: again.body.jobId ?? null }, again.text).toEqual({
      made: 0,
      jobId: null,
    });
  });

  it('G2b: the same operation_id with a smaller request (10 pages) is refused, not run', async () => {
    const before = w.repo.mutations.length;
    const again = await call('create_many_resources', {
      items: items(10, 'Idem B'),
      operation_id: 'r2-idem-b',
    });
    expect(again.body.error?.code, again.text).toBe('OPERATION_ID_REUSED');
    expect(w.repo.mutations.length - before).toBe(0);
  });
});

describe('a direct job accepted, then queued, while the owner tightens the profile', () => {
  it('G4: lowering the scope to propose stops a queued direct delete before it is sent', async () => {
    cmd().setRails('owner', a.profileId, { deletes: false });
    w.stack.runtime.engine.controls.pauseWrites('test');
    try {
      const r = await call('lk_api_write', {
        operationId: 'deleteResource',
        params: { path: { resourceId: 'bk00000a' } },
      });
      expect(r.body.status, r.text).toBe('queued');
      cmd().setScope('owner', a.profileId, 'propose');
      w.stack.runtime.engine.controls.resumeWrites('test');
      const done = await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 20_000);
      expect({ status: done.status, live: w.repo.live('bk00000a') !== undefined }).toEqual({
        status: 'failed',
        live: true,
      });
    } finally {
      w.stack.runtime.engine.controls.resumeWrites('test');
      cmd().setScope('owner', a.profileId, 'write');
      cmd().setRails('owner', a.profileId, { deletes: true });
    }
  });

  it('G3: switching the deletes rail on stops (or proposes) a queued direct delete before it is sent', async () => {
    cmd().setRails('owner', a.profileId, { deletes: false });
    w.stack.runtime.engine.controls.pauseWrites('test');
    let jobId: string;
    try {
      const r = await call('lk_api_write', {
        operationId: 'deleteResource',
        params: { path: { resourceId: 'bk00000b' } },
      });
      expect(r.body.status, r.text).toBe('queued');
      jobId = String(r.body.jobId);
      // The owner switches the deletes rail back on while the delete waits.
      cmd().setRails('owner', a.profileId, { deletes: true });
    } finally {
      w.stack.runtime.engine.controls.resumeWrites('test');
    }
    const done = await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000);
    expect({ status: done.status, live: w.repo.live('bk00000b') !== undefined }).toEqual({
      status: 'failed',
      live: true,
    });
  });
});
