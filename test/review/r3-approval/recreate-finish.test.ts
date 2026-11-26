/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 3.4 and departure 8 with ADR 0049 decision 6: a recreate that
 * stopped part-way is "resumed" by F2's Finish, which keeps its behaviour: a NEW proposal of only what is still
 * missing, never an in-place continuation of the stopped job, never an event made twice, and never by the agent that
 * asked for the restore (the owner approved it). The attempts: Resume as the owner (once, then twice before either
 * proposal is approved, both approved), the engine's in-place resume, and the agent's `bridge_job_resume`.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../../snapshots/world.js';
import { OWNER_ORIGIN, rejection } from './helpers.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let w: SnapshotsWorld;
let c: Client;
let writer: Client;
beforeAll(async () => {
  w = await snapshotsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000, 'write-hour': 20000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000, 'write-hour': 20000 },
  });
  // v3 F12 (ADR 0081): the restore is a proposal the owner approves only from a connection at scope propose.
  c = await w.stack.connect(w.stack.newToken('r3-recreate-proposer', 'propose').token);
  writer = await w.stack.connect();
});
afterAll(async () => w?.close());

const call = (name: string, args: Record<string, unknown>) =>
  w.stack.call(c, name, { project: 'test', ...args });

async function decide(id: string): Promise<string> {
  const pol = w.stack.runtime.policy;
  if (pol.proposals.get(id)!.requiresCanonicalApproval) await pol.commands.approveAsCanon('owner', id);
  else await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 3000 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  return pol.proposals.get(id)!.state;
}

const proposalOf = (r: ToolCall) => {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  return String(r.body.proposalId);
};

describe('a recreate stopped part-way, finished through Resume', () => {
  let jobId = '';
  const chronicle = () => w.repo.liveDocs(w.repo.live(S.atlas)!).find((d) => d.name === 'Chronicle')!;
  const events = () =>
    (w.events.get(chronicle().id) ?? []).map((e) => `${String(e.name)}@${String(e.start)}`);
  let total = 0;

  it('AP-50 setup: the recreate stops at its second event', async () => {
    total = w.events.get(w.d.chronicle)!.length;
    expect(total).toBeGreaterThanOrEqual(3);
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    const del = await w.stack.call(writer, 'delete_resource', { project: 'test', page: S.atlas, confirm: true });
    expect(del.body.status, del.text).toBe('written');
    await w.stack.runtime.engine.wait(PROJECT, String(del.body.jobId), 30_000);
    w.repo.res.delete(S.atlas); // purged: the id is free again
    w.sidebars.pages.delete(S.atlas);
    const first = proposalOf(
      await call('restore_snapshot', { page: S.atlas, snapshot: snap, scope: 'deleted', mode: 'recreate' }),
    );
    let posted = 0;
    w.stack.mock.inject((x) => x.method === 'POST' && /\/events\/?$/.test(x.path) && ++posted === 2, {
      kind: 'status',
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(await decide(first)).toBe('failed');
    jobId = w.stack.runtime.policy.proposals.get(first)!.jobId!;
    expect(events()).toHaveLength(1);
    const view = w.stack.runtime.resume.view(PROJECT, jobId);
    expect(view).toMatchObject({ resumable: true, kind: 'recreate' });
  });

  it('AP-51 the agent that asked for the restore cannot resume it; never continued in place', async () => {
    const r = await call('bridge_job_resume', { jobId });
    expect((r.body.error as { code?: string } | undefined)?.code, r.text).toBe('OWNER_APPROVED_JOB');
    const e = await rejection(() => w.stack.runtime.engine.controls.resumeStopped(PROJECT, jobId));
    expect(e?.message ?? '').toMatch(/cannot be resumed in place/);
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!.status).toBe('failed');
  });

  it('AP-52 Resume twice (two clicks) then both proposals approved: every event once, never in place', async () => {
    await w.stack.runtime.tree.sweep(PROJECT);
    const [a, b] = await Promise.allSettled([
      w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN),
      w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN),
    ]);
    const ids = [a, b]
      .filter(
        (x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof w.stack.runtime.resume.resume>>> =>
          x.status === 'fulfilled',
      )
      .map((x) => x.value)
      .filter((v) => v.status === 'proposal_captured')
      .map((v) => (v as { proposalId: string }).proposalId);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    // The stopped job itself is never continued.
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!.status).toBe('failed');
    for (const id of ids) {
      const st = await decide(id);
      expect(['executed', 'conflicted', 'failed']).toContain(st);
    }
    const made = events();
    expect(new Set(made).size, `an event was made twice: ${made.join(', ')}`).toBe(made.length);
    expect(made.length, 'every event of the snapshot, once').toBe(total);
    // Audited as a resume (and as F2's finish).
    const audit = w.stack.runtime.policy.store
      .listAudit({ action: 'job.resume' })
      .filter((x) => x.target === jobId);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});
