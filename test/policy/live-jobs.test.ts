/**
 * Chunk 8 (F-02): the policy gate is asked again before every new step of a job that acts for an agent, so revoking a
 * connection or lowering its profile's scope also stops work it already queued. Work the owner approved, and
 * internal work, is not asked again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchSubmit } from '../../src/jobs/index.js';
import { queue } from '../jobs/helpers.js';
import { makePat, mcpOriginFor, policyRig, type PolicyRig } from './helpers.js';

let rig: PolicyRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const writesAtMock = (r: PolicyRig) => r.h.mock.calls.filter((c) => c.method !== 'GET');

async function setup() {
  rig = await policyRig();
  const r = rig;
  for (const id of ['raaaaaaa', 'rbbbbbbb', 'rccccccc']) r.h.model.seedResource(id);
  const agent = makePat(r.db, r.policy, 'claude', 'write', () => r.h.clock.now(), 'claude');
  const batch: BatchSubmit = {
    kind: 'batch_ops',
    steps: ['raaaaaaa', 'rbbbbbbb', 'rccccccc'].map((resourceId, i) => ({
      op: 'updateResource',
      params: { path: { resourceId }, body: { name: `Renamed ${i}` } },
    })),
    onError: 'continue',
    origin: mcpOriginFor(agent.principal),
  };
  return { r, agent, batch };
}

/** Queues the batch while writes are paused, so that nothing runs until `change` has been made. */
async function queueThenChange(r: PolicyRig, batch: BatchSubmit, change: () => void) {
  r.e.engine.controls.pauseWrites('owner');
  const { jobId } = await queue(r.e.engine, batch);
  await r.h.drive(r.e, () => r.e.engine.queries.getJob(jobId)?.waitReason?.held === 'writes_paused');
  change();
  r.e.engine.controls.resumeWrites('owner');
  await r.h.drive(r.e, () => {
    const s = r.e.engine.queries.getJob(jobId)?.status;
    return s === 'succeeded' || s === 'failed' || s === 'cancelled';
  });
  return r.e.engine.queries.getJob(jobId)!;
}

describe('a queued job follows the live scope of its connection', () => {
  it('stops when the connection is revoked: nothing is sent, the rest is cancelled', async () => {
    const { r, agent, batch } = await setup();
    const job = await queueThenChange(r, batch, () => {
      expect(r.policy.commands.revoke('owner', agent.patId)).toBe(true);
    });
    expect(job.status).toBe('failed');
    expect(job.lastError?.code).toBe('POLICY_DENIED');
    expect(job.lastError?.message).toMatch(/revoked/);
    expect(job.steps.map((s) => s.status)).toEqual(['failed', 'cancelled', 'cancelled']);
    expect(writesAtMock(r)).toHaveLength(0);
    const errors = r.e.engine.queries.listErrors({ principalId: agent.principal.principalId });
    expect(errors.some((e) => e.classification === 'policy' && e.jobId === job.id && e.stepNo === 1)).toBe(
      true,
    );
  });

  it('stops when the scope is lowered to read', async () => {
    const { r, agent, batch } = await setup();
    const job = await queueThenChange(r, batch, () => {
      r.policy.commands.setScope('owner', agent.profileId, 'read');
    });
    expect(job.status).toBe('failed');
    expect(job.lastError?.message).toMatch(/read-only/);
    expect(writesAtMock(r)).toHaveLength(0);
  });

  it('stops when the scope is lowered to propose, and says to submit again for a proposal', async () => {
    const { r, agent, batch } = await setup();
    const job = await queueThenChange(r, batch, () => {
      r.policy.commands.setScope('owner', agent.profileId, 'propose');
    });
    expect(job.status).toBe('failed');
    expect(job.lastError?.message).toMatch(/propose/);
    expect(writesAtMock(r)).toHaveLength(0);
  });

  it('runs to the end while the scope stays write', async () => {
    const { r, batch } = await setup();
    const job = await queueThenChange(r, batch, () => undefined);
    expect(job.status).toBe('succeeded');
    expect(writesAtMock(r)).toHaveLength(3);
  });

  it('stops part-way when the scope is lowered between steps', async () => {
    const { r, agent, batch } = await setup();
    const { jobId } = await queue(r.e.engine, batch);
    let lowered = false;
    const off = r.e.engine.events.on('step', (e) => {
      if (e.jobId === jobId && e.step.stepNo === 1 && !lowered) {
        lowered = true;
        r.policy.commands.setScope('owner', agent.profileId, 'read');
      }
    });
    await r.h.drive(r.e, () => {
      const s = r.e.engine.queries.getJob(jobId)?.status;
      return s === 'succeeded' || s === 'failed';
    });
    off();
    const job = r.e.engine.queries.getJob(jobId)!;
    expect(job.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(writesAtMock(r)).toHaveLength(1);
  });

  it('does not ask again for internal work', async () => {
    const { r, batch } = await setup();
    const { principal: _p, ...origin } = batch.origin;
    const job = await queueThenChange(r, { ...batch, origin: { ...origin, kind: 'ui' } }, () => undefined);
    expect(job.status).toBe('succeeded');
    expect(job.principalId).toBe('system');
  });
});
