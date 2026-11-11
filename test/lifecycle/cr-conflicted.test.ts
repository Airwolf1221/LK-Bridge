/**
 * CR-2026-11, finding CR-05: a proposal whose approved job is stopped by the bridge's own check inside the lock (the
 * page changed between the approval's re-read and the job taking the lock) wrote nothing, so it is `conflicted`, as
 * when the approval's re-read sees the change (ADR 0031 decision 8). C1 did this for `write_page` only: a lifecycle,
 * set_facts or C2b proposal (high-level operations, `operations`) ended `failed`, a final state that says something
 * went wrong in the writes.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
beforeAll(async () => {
  w = await lifecycleWorld();
});
afterAll(async () => w.close());

it('archive_page approved, then the page changes before the job takes the lock: conflicted, nothing written', async () => {
  const c = await w.stack.connect();
  const r = await w.stack.call(c, 'archive_page', { project: 'test', page: 'Old Harbour' });
  expect(r.body.status).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const page = w.repo.res.get(L.harbour)!;
  const nameBefore = page.name;
  // The approval's re-read of the page is answered; then, before the job's own check, someone tags it in the app.
  w.sidebars.after(new RegExp(`^GET /resources/${L.harbour}/?$`), 0, () => {
    page.tags = [...page.tags, 'tagged-in-the-app'];
  });
  await w.stack.runtime.policy.commands.approveAsCanon('owner', id);
  const proposals = w.stack.runtime.policy.proposals;
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  const p = proposals.get(id)!;
  const job = w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId!)!;
  expect(job.lastError?.code).toBe('VERSION_CONFLICT');
  expect(page.name).toBe(nameBefore); // nothing was written
  expect(p.state).toBe('conflicted');
  expect(p.conflict).toMatchObject({ op: 'bridge.expect' });
});
