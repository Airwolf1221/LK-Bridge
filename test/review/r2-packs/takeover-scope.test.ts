/**
 * R2-PACKS ATK-08: the staged-image takeover (ADR 0052 decision 10) when the package is NOT a proposal.
 *
 * The takeover was designed (and is only tested, test/packs/takeover.test.ts, with every switch on "always propose")
 * for a package that is captured as a proposal: finishPackage (src/packs/run.ts:334-367) withdraws the image's own
 * pending placement proposal AFTER runWriteJob returns. With the seed's switch, `arkona_add_character_art` follows the
 * scope, so at scope `write` runWriteJob submits a direct job and WAITS for it (src/mcp/tools/write-job.ts:119-123):
 * the job's own `pack.absent` check (src/packs/engine/checks.ts:211-230) still sees the placement proposal pending (not
 * this job's), refuses STAGED_IMAGE_BUSY and the job fails; only then does finishPackage withdraw the owner's pending
 * placement proposal ("superseded by package job_…", a job that placed nothing) and point the staged image at the
 * failed job (`placementJobId`), so the image can no longer be placed by anything (planImages refuses
 * STAGED_IMAGE_BUSY on any placementJobId, src/packs/engine/plan.ts:1895-1904).
 *
 * Safe behaviour asserted: either the package places the image, or the placement proposal it named is left pending and
 * the image stays usable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../../images/world.js';
import { packWorld, type PackWorld } from '../../packs/world.js';
import { PROJECT, settle, writeAgent } from './helpers.js';

let w: PackWorld;
let writer: Awaited<ReturnType<typeof writeAgent>>;
let proposer: Awaited<ReturnType<typeof writeAgent>>;
beforeAll(async () => {
  w = await packWorld({ toolModes: 'seed' });
  writer = await writeAgent(w, 'r2-writer');
  const { token } = w.stack.newToken('r2-proposer', 'propose');
  const client = await w.stack.connect(token);
  proposer = (name, args) => w.stack.call(client, name, args);
});
afterAll(async () => {
  await w?.close();
});

describe('ATK-08: a package at scope write names a staged image whose own placement proposal is pending', () => {
  it('the package places it, or the placement proposal is not withdrawn and the image stays usable', async () => {
    // At scope propose, upload_image with a destination stages the image AND proposes its placement.
    const up = await proposer('upload_image', {
      data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([91, 2])]).toString('base64'),
      name: 'Tamsin portrait',
      destination: { for_character: { name: 'Tamsin Reed', race: 'Human' } },
      project: 'test',
    });
    expect(up.body.status, up.text).toBe('proposal_captured');
    const placement = String(up.body.proposalId);
    const staged = String(up.body.staged_id);
    // A write-scope agent puts it on the Working character's Art page (the art tool follows the scope: a direct job).
    const r = await writer('arkona_add_character_art', {
      character: 'Tamsin Reed',
      images: [{ staged_id: staged, label: 'Primary Reference - Portrait', interpretation: 'Her face.' }],
      project: 'test',
    });
    const jobId = typeof r.body.jobId === 'string' ? r.body.jobId : null;
    const job = jobId ? await settle(w, jobId) : null;
    const p = w.stack.runtime.policy.proposals.get(placement)!;
    const row = w.stack.runtime.images.staged(PROJECT, staged)!;
    const placed = job?.status === 'succeeded' && row.staged === false;
    const outcome = {
      placed,
      // When it did not place the image, the owner's pending placement proposal must still be pending...
      placementProposal: placed ? 'n/a' : p.state,
      // ...and the image must not point at a job that placed nothing.
      imageStuckOnFailedJob: !placed && row.placementJobId !== null && row.placementJobId === jobId,
    };
    expect(outcome, JSON.stringify({ job: job?.lastError, reject: p.rejectReason })).toEqual(
      placed
        ? { placed: true, placementProposal: 'n/a', imageStuckOnFailedJob: false }
        : { placed: false, placementProposal: 'pending', imageStuckOnFailedJob: false },
    );
  });
});

describe('ATK-08b (probe): a package by ANOTHER agent takes over a staged image’s pending placement', () => {
  it('agent A’s package must not withdraw agent B’s pending placement proposal', async () => {
    const other = w.stack.newToken('r2-other-proposer', 'propose');
    const client = await w.stack.connect(other.token);
    const agentA = (name: string, args: Record<string, unknown>) => w.stack.call(client, name, args);
    // Agent B (r2-proposer) stages an image for Nadira with a destination: its placement is proposed.
    const up = await proposer('upload_image', {
      data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([92, 3])]).toString('base64'),
      name: 'Nadira portrait (B)',
      destination: { for_character: { name: 'Nadira al-Khalid', race: 'Qishen' } },
      project: 'test',
    });
    expect(up.body.status, up.text).toBe('proposal_captured');
    const placementB = String(up.body.proposalId);
    // Agent A names B's staged image in its own package (a proposal at scope propose).
    const pkg = await agentA('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [
        { staged_id: String(up.body.staged_id), label: 'Primary Reference - Portrait', interpretation: 'x' },
      ],
      project: 'test',
    });
    const p = w.stack.runtime.policy.proposals.get(placementB)!;
    if (pkg.body.proposalId)
      w.stack.runtime.policy.commands.reject('owner', String(pkg.body.proposalId), 'r2');
    expect({ placementB: p.state, reason: p.rejectReason ?? null }).toEqual({
      placementB: 'pending',
      reason: null,
    });
  });
});
