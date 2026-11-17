/**
 * R2-revert, attack (g): revert a job that is still running (held while writes are paused), a job that ran from a
 * proposal (here a rail's proposal, ADR 0055 C2, approved by the owner), or the bridge's own work. Controls: each
 * should HOLD.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, sleep, writeAgent } from './helpers.js';

let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-eligibility-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;

describe('which jobs may be reverted', () => {
  it('a direct write held while writes are paused is still running: JOB_RUNNING, nothing planned', async () => {
    rt().engine.controls.pauseWrites('owner');
    let jobId: string;
    try {
      const r = await call('update_resource', { page: P.ashgate, aliases: { add: ['Held alias'] } });
      jobId = jobOf(r);
      await sleep(200);
      expect(rt().engine.queries.getJob(PROJECT, jobId)!.status).not.toBe('succeeded');
      const rv = await rt().reverts.revert('owner', PROJECT, jobId);
      expect(rv).toMatchObject({ status: 'refused', code: 'JOB_RUNNING' });
    } finally {
      rt().engine.controls.resumeWrites('owner');
    }
    await rt().engine.wait(PROJECT, jobId, 25_000);
  });

  it('a rail’s proposal, approved by the owner: WAS_A_PROPOSAL', async () => {
    // The deletes rail (on by default for a new profile) makes a delete a proposal; the owner approves it.
    const r = await call('delete_resource', { page: 'bk000005', confirm: true });
    expect(r.body.status, r.text).toBe('proposal_captured');
    await rt().policy.commands.approve('owner', String(r.body.proposalId));
    let jobId: string | null = null;
    for (let i = 0; i < 200 && !jobId; i++) {
      jobId = rt().policy.proposals.get(String(r.body.proposalId))!.jobId;
      if (!jobId) await sleep(20);
    }
    await rt().engine.wait(PROJECT, jobId!, 25_000);
    expect(await rt().reverts.revert('owner', PROJECT, jobId!)).toMatchObject({
      status: 'refused',
      code: 'WAS_A_PROPOSAL',
    });
  });

  it('the bridge’s own work (a system job) is not a direct write', async () => {
    const r = await rt().engine.run(
      'updateResource',
      { path: { resourceId: 'bk000006' }, body: { aliases: ['Bridge alias'] } },
      { project: PROJECT, origin: { kind: 'ui', tool: 'test' } },
    );
    const jobId = (r as { jobId: string }).jobId;
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(await rt().reverts.revert('owner', PROJECT, jobId)).toMatchObject({
      status: 'refused',
      code: 'NOT_A_DIRECT_WRITE',
    });
  });
});
