/**
 * v3 F12 (ADR 0081): an agent at scope `write`, through the real server, MCP transport, policy gate, guards and engine
 * against the mock LegendKeeper. Every change below used to be a proposal; now each runs directly, is on the owner's
 * Review page, and comes back with Revert:
 *
 * - a canon lifecycle change (move_to_working of an Authoritative page: rename, Status, tags, move), then Revert;
 * - CANON taken off and put on (the protected Continuity Type), then Revert;
 * - a page with two children deleted (a cascade): the copy kept before (D3), then Revert: all three back;
 * - an asset deleted: its bytes kept before, then Revert: uploaded again in its folder under its name;
 * - the owner's dashboard restore as one confirmed action: a job at once, no proposal.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';
import { copyOf } from '../../src/snapshots/delete-copy.js';

vi.setConfig({ testTimeout: 120_000 });

const C = { root: 'cascroot', kidA: 'cascadea', kidB: 'cascadeb' } as const;

let w: SnapshotsWorld;
let agent: Client;
let snapshotId: string;

beforeAll(async () => {
  w = await snapshotsWorld({
    seed: (world) => {
      world.repo.seed({ id: C.root, name: 'Cascade Root', parentId: S.locations, tags: ['test'] });
      world.repo.seed({ id: C.kidA, name: 'Cascade Child A', parentId: C.root });
      world.repo.seed({ id: C.kidB, name: 'Cascade Child B', parentId: C.root });
    },
  });
  const t = w.stack.newToken('f12-agent', 'write');
  w.stack.runtime.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
  agent = await w.stack.connect(t.token);
  snapshotId = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
});
afterAll(async () => w?.close());

const rt = () => w.stack.runtime;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const settle = async (id: string) => {
  let j = await rt().engine.wait(PROJECT, id, 25_000);
  for (let i = 0; i < 10 && !['succeeded', 'failed', 'cancelled'].includes(j.status); i++)
    j = await rt().engine.wait(PROJECT, id, 25_000);
  return j;
};
const jobOf = (r: { body: Record<string, unknown> }): string =>
  typeof r.body.jobId === 'string' ? r.body.jobId : String((r.body.job as { id?: unknown } | undefined)?.id);
const onReview = (jobId: string) =>
  rt()
    .review.list(PROJECT, { state: 'all', limit: 500 })
    .some((i) => i.jobId === jobId);
const proposalCount = () =>
  (w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
const noProposalSince = (n: number) => proposalCount() === n;

/** The owner's Revert from the Review page, and its job (with its follow-ups) settled. */
async function revert(jobId: string) {
  const preview = await rt().reverts.preview(PROJECT, jobId);
  const r = await rt().reverts.revert('owner', PROJECT, jobId);
  expect(r.status, JSON.stringify({ r, preview: preview.targets })).toBe('submitted');
  if (r.status !== 'submitted') throw new Error('not submitted');
  const job = await settle(r.revertJobId);
  expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  // The follow-ups (LegendKeeper's restore, an upload again) run after the job: wait for their record.
  for (let i = 0; i < 400; i++) {
    const row = w.stack.db
      .prepare('SELECT targets FROM job_reverts WHERE revert_job_id = ?')
      .get(r.revertJobId) as { targets: string } | undefined;
    const note = row ? (JSON.parse(row.targets) as { followUps?: unknown[]; followUpsDone?: unknown[] }) : {};
    if (!note.followUps || note.followUpsDone) return { preview, note };
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('the follow-ups did not finish');
}

describe('canon and lifecycle at scope write: direct, on Review, reverted', () => {
  it('move_to_working of an Authoritative page runs directly; Revert puts its name, parent, tags and Status back', async () => {
    const before = { ...w.repo.live(S.harbour)! };
    const proposals = proposalCount();
    const r = await call('move_to_working', { page: S.harbour });
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.requiresCanonicalApproval).toBeUndefined();
    expect(noProposalSince(proposals)).toBe(true);
    const jobId = jobOf(r);
    expect(w.repo.live(S.harbour)).toMatchObject({ name: '[BWRK] Old Harbour' });
    expect(onReview(jobId)).toBe(true);
    await revert(jobId);
    expect(w.repo.live(S.harbour)).toMatchObject({
      name: before.name,
      parentId: before.parentId,
      tags: before.tags,
    });
  });

  it('CANON off (Continuity Type) runs directly; Revert puts it back', async () => {
    const proposals = proposalCount();
    const read = await call('get_resource', { page: S.atlas });
    const r = await call('set_facts', {
      page: S.atlas,
      facts: { 'Continuity Type': 'AU' },
      ...(read.body.factsVersion ? { baseFactsVersion: read.body.factsVersion } : {}),
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    expect(noProposalSince(proposals)).toBe(true);
    const jobId = jobOf(r);
    expect((await settle(jobId)).status).toBe('succeeded');
    expect(onReview(jobId)).toBe(true);
    await revert(jobId);
    const after = await call('get_resource', { page: S.atlas });
    expect(JSON.stringify(after.body)).not.toContain('"AU"');
  });
});

describe('deletes at scope write: a copy first, then Revert brings them back (D3)', () => {
  it('a page with two children: deleted directly with a copy of all three; Revert restores all three', async () => {
    const r = await call('delete_resource', { page: C.root, confirm: true, cascade: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const jobId = jobOf(r);
    const job = await settle(jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    for (const id of Object.values(C)) expect(w.repo.live(id), id).toBeFalsy();
    // The copy: a change snapshot of the three pages, read just before the delete, named by the delete's journal entry.
    const del = rt()
      .engine.stepRecords(PROJECT, jobId)!
      .find((s) => s.opId === 'deleteResource')!;
    const copy = copyOf(w.stack.db, jobId, del.stepNo)!;
    expect(copy.pages.map((p) => p.id)).toEqual([C.root, C.kidA, C.kidB]);
    expect(rt().snapshots.index.snapshot(copy.snapshotId)?.kind).toBe('change');
    expect(copy.reads).toBeGreaterThan(3);
    expect(onReview(jobId)).toBe(true);
    const { preview, note } = await revert(jobId);
    expect(preview.targets.find((t) => t.kind === 'entity')).toMatchObject({
      state: 'ready',
      deletion: true,
    });
    expect(note.followUpsDone?.[0]).toMatchObject({ restoredBy: 'LegendKeeper', pages: 3 });
    for (const id of Object.values(C)) expect(w.repo.live(id), id).toBeTruthy();
    expect(w.repo.live(C.kidA)!.parentId).toBe(C.root);
  });

  it('an asset: deleted directly with its bytes kept; Revert uploads it again in its folder under its name', async () => {
    const before = w.assets.assets.get(S.imgSea)!;
    const r = await call('lk_api_write', {
      operationId: 'deleteAsset',
      params: { path: { assetId: S.imgSea } },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).toBe('succeeded');
    const jobId = jobOf(r);
    const gone = w.assets.assets.get(S.imgSea);
    expect(!gone || Boolean((gone as { deletedAt?: unknown }).deletedAt)).toBe(true);
    expect(rt().images.store.keptRefs(PROJECT, S.imgSea)).toHaveLength(1);
    const { note } = await revert(jobId);
    const again = w.assets.byName(before.name, before.folderId).filter((a) => a.id !== S.imgSea);
    expect(
      again,
      `a new asset, same folder and name: ${JSON.stringify(
        rt()
          .engine.stepRecords(
            PROJECT,
            String((note.followUpsDone?.[0] as { jobId?: string } | undefined)?.jobId),
          )
          ?.map((x) => [x.opId, x.status, x.params, x.result]),
      )}`,
    ).toHaveLength(1);
    // The page that showed the old image shows the new one (it had not changed since).
    expect(JSON.stringify(w.repo.blocks.get(w.d.main)!.blocks)).toContain(w.url(again[0]!.id));
  });
});

describe('the owner’s dashboard restore: one confirmed action', () => {
  it('runs at once as one job (no proposal to approve next)', async () => {
    const proposals = proposalCount();
    await call('write_page', {
      page: S.atlas,
      mode: 'append',
      markdown: 'A line to restore away.',
    });
    const r = await rt().restores.propose(
      { projectId: PROJECT, pageId: S.atlas, snapshotId, scope: 'page' },
      {
        kind: 'ui',
        client: 'owner',
        tool: 'snapshots.restore',
        principal: { principalId: 'system', profile: 'system', label: 'system' },
        ownerConfirmed: true,
      },
      'owner',
    );
    expect(r.status).toBe('submitted');
    if (r.status !== 'submitted') return;
    expect((await settle(r.jobId)).status).toBe('succeeded');
    expect(noProposalSince(proposals)).toBe(true);
    expect(rt().restores.record(PROJECT, r.restoreId)).toMatchObject({ state: 'executed', jobId: r.jobId });
    expect(JSON.stringify(w.repo.blocks.get(w.d.main)!.blocks)).not.toContain('A line to restore away.');
  });

  it('ownerConfirmed is refused on any origin but the dashboard’s', async () => {
    await expect(
      rt().engine.submit({
        kind: 'batch_ops',
        project: PROJECT,
        steps: [{ op: 'updateResource', params: { path: { resourceId: S.atlas }, body: { tags: ['x'] } } }],
        origin: { kind: 'maintenance', tool: 'x', ownerConfirmed: true },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
