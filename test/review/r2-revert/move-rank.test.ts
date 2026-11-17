/**
 * R2-revert, attack (a)/(c)/(d): a move target is compared by its parent only, never by its place among its siblings.
 *
 * An agent re-orders a page within its parent (a `moveResource` to the same parent with an anchor: what update_resource's
 * re-placing rename, the appraisal's sibling-order fix or a raw move does). Afterwards the owner drags the page to
 * another place under the same parent in the app. The page is no longer where the job left it, so Revert must not move
 * it (ADR 0055 B4: "A target that differs from what the job left is not reverted ... An outside edit is never
 * overwritten").
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-move-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;

describe('a move target is compared by its place, not only its parent', () => {
  it('the owner re-orders the page under the same parent after the job: Revert must not move it back', async () => {
    const page = 'bk000008'; // under [INDEX] Great Chronicles with four siblings
    const parent = w.repo.live(page)!.parentId!;
    const order = () => w.repo.children(parent).map((c) => c.id);
    const original = order();
    expect(original.length).toBeGreaterThanOrEqual(4);
    expect(original[0]).not.toBe(page);

    // The agent puts the page first among its siblings (same parent).
    const r = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: page }, body: { parentId: parent, before: original[0] } },
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(order()[0]).toBe(page);

    // The owner drags it to the end of the same index in the app.
    w.repo.outside.move(page, parent);
    const ownersOrder = order();
    expect(ownersOrder.at(-1)).toBe(page);

    const preview = await rt().reverts.preview(PROJECT, jobId);
    const { r: rv, job } = await revertAndWait(w.stack, jobId);
    // Safe behaviour: the move target is "changed" (refused), or at least the owner's order survives.
    expect(
      { order: order(), preview: preview.targets.map((t) => `${t.kind}:${t.state}`), revert: rv.status },
      `revert job: ${job?.status ?? 'none'}`,
    ).toEqual({ order: ownersOrder, preview: ['move:changed'], revert: 'refused' });
  });

  it('the owner re-orders it while the revert job waits (writes paused): the check inside the lock must catch it', async () => {
    const page = 'bk00000g';
    const parent = w.repo.live(page)!.parentId!;
    const order = () => w.repo.children(parent).map((c) => c.id);
    const original = order();
    const r = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: page }, body: { parentId: parent, before: original[0] } },
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(order()[0]).toBe(page);
    // Everything ready: the owner reverts; writes are paused before the revert job's write.
    rt().engine.controls.pauseWrites('owner');
    let revertJobId: string;
    try {
      const rv = await rt().reverts.revert('owner', PROJECT, jobId);
      expect(rv.status, JSON.stringify(rv)).toBe('submitted');
      revertJobId = (rv as { revertJobId: string }).revertJobId;
      // Meanwhile the owner puts the page at the end in the app.
      w.repo.outside.move(page, parent);
    } finally {
      rt().engine.controls.resumeWrites('owner');
    }
    const ownersOrder = order();
    const job = await rt().engine.wait(PROJECT, revertJobId, 25_000);
    expect({ status: job.status, order: order() }).toEqual({ status: 'failed', order: ownersOrder });
  });
});
