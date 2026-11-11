/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * CR-2026-11, finding CR-19: an approved proposal's job runs as the agent that proposed it (so its scope and budget
 * apply), which let that agent cancel the owner's approved work part-way with `bridge_job_cancel`, leaving a lifecycle
 * change or an accepted canon change half made. Only the owner cancels approved work now (the dashboard).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, type FactsWorld } from './world.js';

let w: FactsWorld;
beforeAll(async () => {
  w = await factsWorld();
});
afterAll(async () => w.close());

it('the proposer cannot cancel the job the owner approved', async () => {
  const { token } = w.stack.newToken('cr19-proposer', 'propose');
  const c = await w.stack.connect(token);
  const r = await w.stack.call(c, 'set_facts', {
    project: 'test',
    page: 'Mehrana al-Khalid',
    facts: { Scope: 'Qishen scholar, approved' },
  });
  expect(r.body.status, r.text).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const p = await w.stack.runtime.policy.commands.approve('owner', id);
  expect(p.jobId).toBeTruthy();
  const job = w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId!)!;
  expect(job.approvedBy).toBe('owner');
  const cancel = await w.stack.call(c, 'bridge_job_cancel', { project: 'test', jobId: p.jobId });
  expect(cancel.isError, cancel.text).toBe(true);
  expect(cancel.body.error.code).toBe('OWNER_APPROVED_JOB');
  expect(w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId!)!.cancelRequested).toBe(false);
  void P;
});
