/**
 * CR-2026-11-R3, fix A (the owner's clean shutdown): a job waiting for an approval. A culture's rename changes its
 * identity token as a new pack version; once the owner approves the rename, its job is queued and waits for the owner to
 * approve that version (ADR 0058 decision 1.5, `waitFor`). A restart (stopped exactly as SIGTERM stops the bridge)
 * leaves it waiting, writes nothing, and once the owner approves the version after the restart the job runs to the end.
 * Mocks and fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../../tools/helpers.js';
import { renameWorld, R, type RenameWorld } from '../../packs/rename-world.js';

describe('CR-2026-11-R3 fix A: a job waiting for a pack version, across a restart', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('keeps waiting through the restart, writes nothing, and runs once the owner approves the version', async () => {
    const r = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    expect(r.isError, r.text).toBeFalsy();
    const proposalId = String(r.body.proposalId);
    await w.stack.runtime.policy.commands.approveAsCanon('owner', proposalId);
    const jobId = w.stack.runtime.policy.proposals.get(proposalId)!.jobId!;
    await new Promise((res) => setTimeout(res, 300));
    const before = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    expect(before.status).toBe('queued');
    expect(before.waitReason).toMatchObject({ held: 'waiting_for' });
    const writesBefore = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;

    const report = await w.stack.restart();
    expect(report.ms).toBeLessThan(5_000);
    expect(report.stillRunning).toEqual([]);

    // After the restart: still waiting for the same version; nothing written.
    await new Promise((res) => setTimeout(res, 300));
    const after = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    expect(after.status).toBe('queued');
    expect(after.waitReason).toMatchObject({ held: 'waiting_for' });
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writesBefore);

    // The owner approves the version on the new bridge: the job runs, once, to the end.
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    let job = after;
    for (let i = 0; i < 1000; i++) {
      job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.repo.live(R.velaran)!.name).toBe('[BSRC] Velarine - Culture Reference');
    for (const id of R.characters) expect(w.repo.live(id)!.tags, id).toContain('Velarine');
    console.info(`[R3 fix A] stop with a job waiting for a pack version: ${report.ms} ms`);
  }, 120_000);
});
