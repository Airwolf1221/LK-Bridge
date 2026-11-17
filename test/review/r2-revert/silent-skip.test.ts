/**
 * R2-revert, attack (c): a target silently skipped, so the revert reports success (and marks the item reviewed) without
 * the owner's confirmation of a partial revert.
 *
 * src/review/targets.ts section 6 marks EVERY `createAssetFolder` step of a job as handled ("part of the image's
 * placement (they stay)"), whether or not the job placed an image. A folder the agent made on its own is therefore not
 * a target at all: not listed as "not revertible" (ADR 0055 B3: "Revert never deletes what a job made (... a folder
 * ...): it lists it as not revertible"), so the all-or-nothing default does not ask for a partial confirmation, the
 * revert "succeeds", and the Review item is marked reviewed (via revert) with the folder still there and never shown.
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
  agent = (await writeAgent(w.stack, 'r2-skip-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const folderNamed = (name: string) =>
  [...w.assets.assets.values()].find((a) => a.type === 'FOLDER' && a.name === name) ?? null;

describe('nothing the job made is left out of the revert’s list', () => {
  it('a folder made next to an alias change: listed as not revertible, so a full revert needs confirmation', async () => {
    const page = 'bk00000c';
    const r = await call('lk_api_batch', {
      onError: 'stop',
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: page }, body: { aliases: ['Stray note'] } },
        },
        { operationId: 'createAssetFolder', params: { body: { name: 'R2 stray folder' } } },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    const done = await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(done.status, JSON.stringify(done.lastError)).toBe('succeeded');
    expect(folderNamed('R2 stray folder')).not.toBeNull();

    const preview = await rt().reverts.preview(PROJECT, jobId);
    const kinds = preview.targets.map((t) => `${t.kind}:${t.state}`);
    const { r: rv, job } = await revertAndWait(w.stack, jobId);
    const item = rt().review.store.get(PROJECT, jobId)!;
    expect(folderNamed('R2 stray folder')).not.toBeNull(); // Revert never deletes it: right
    // But the folder must be listed (not revertible), and the default all-or-nothing revert refused until confirmed.
    expect(
      { preview: kinds, revert: rv.status, reviewedVia: item.reviewedVia },
      `revert job ${job?.status ?? '-'}`,
    ).toEqual({
      preview: ['resource:ready', 'none:not_revertible'],
      revert: 'refused',
      reviewedVia: null,
    });
  });

  it('a job that only made a folder: the refusal must not say everything is already as it was', async () => {
    const r = await call('lk_api_write', {
      operationId: 'createAssetFolder',
      params: { body: { name: 'R2 lone folder' } },
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(folderNamed('R2 lone folder')).not.toBeNull();
    // Listed on the Review page (it wrote something) …
    expect(
      rt()
        .review.list(PROJECT)
        .some((i) => i.jobId === jobId),
    ).toBe(true);
    // … and its revert must not claim the job changed nothing that is still there.
    const rv = await rt().reverts.revert('owner', PROJECT, jobId);
    expect(rv.status).toBe('refused');
    expect((rv as { message: string }).message).not.toMatch(/already as it was before/);
  });
});
