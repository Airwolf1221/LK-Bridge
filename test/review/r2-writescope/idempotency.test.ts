/**
 * CR-2026-11 round 2 (write scope): `operation_id` and proposals (ADR 0055 F: "operation_id gives the same answer at
 * both scopes … (a repeat returns the same proposal)") and the engine's per-step re-check of a direct job ("a direct job
 * is asked again by the gate before each step (a revoked connection or a lowered scope stops it)").
 *
 * The safety rails were removed (v3 F12, ADR 0081), so the proposals here come from a connection at scope `propose`
 * that the owner then raises to `write`; the rail-only test (G3: a rail switched on while a delete waits) went with them.
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
let pa: Agent;

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-idem-agent');
  const t = w.stack.newToken('r2-idem-propose', 'propose');
  pa = { client: await w.stack.connect(t.token), profileId: t.profileId, patId: t.patId };
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const pcall = (tool: string, args: Record<string, unknown>) => w.stack.call(pa.client, tool, args);
const cmd = () => w.stack.runtime.policy.commands;
const items = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `[INDEX] ${tag} ${i}`, parent: ROOT }));

describe('operation_id and proposals', () => {
  it('G1: a proposal repeated with the same operation_id after the owner raises the scope to write is still that proposal', async () => {
    const args = { items: items(11, 'Idem A'), operation_id: 'r2-idem-a' };
    const first = await pcall('create_many_resources', args);
    expect(first.body.status, first.text).toBe('proposal_captured');
    cmd().setScope('owner', pa.profileId, 'write');
    const before = w.repo.mutations.length;
    let again;
    try {
      again = await pcall('create_many_resources', args);
    } finally {
      cmd().setScope('owner', pa.profileId, 'propose');
    }
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

  it('G2: after the owner rejects a proposal, the same operation_id does not run it directly (scope now write)', async () => {
    const args = { items: items(11, 'Idem B'), operation_id: 'r2-idem-b' };
    const first = await pcall('create_many_resources', args);
    expect(first.body.status, first.text).toBe('proposal_captured');
    cmd().reject('owner', String(first.body.proposalId), 'no');
    cmd().setScope('owner', pa.profileId, 'write');
    const before = w.repo.mutations.length;
    let again;
    try {
      again = await pcall('create_many_resources', args);
    } finally {
      cmd().setScope('owner', pa.profileId, 'propose');
    }
    expect({ made: w.repo.mutations.length - before, jobId: again.body.jobId ?? null }, again.text).toEqual({
      made: 0,
      jobId: null,
    });
  });

  it('G2b: the same operation_id with a smaller request (10 pages) is refused, not run', async () => {
    const before = w.repo.mutations.length;
    const again = await pcall('create_many_resources', {
      items: items(10, 'Idem B'),
      operation_id: 'r2-idem-b',
    });
    expect(again.body.error?.code, again.text).toBe('OPERATION_ID_REUSED');
    expect(w.repo.mutations.length - before).toBe(0);
  });
});

describe('a direct job accepted, then queued, while the owner tightens the profile', () => {
  it('G4: lowering the scope to propose stops a queued direct delete before it is sent', async () => {
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
    }
  });
});
