/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3d (renames), ADR 0058 (the design's section 3, decision D6): resuming a job that stopped part-way, against the
 * mock LegendKeeper. A rename stopped at each stage (a page name, a block, an asset) continues from where it stopped,
 * after its in-lock check runs again, never repeating a write that succeeded; the resume is audited (`job.resume`); a
 * step that is no longer safe (an outside edit since) is refused with its reason; an agent resumes only its own job that
 * it ran at its own scope (never one the owner approved).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { approve } from './world.js';
import { C, P, renameWorld, type RenameWorld } from './rename-world.js';
import type { JobOrigin } from '../../src/jobs/types.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const OWNER_ORIGIN = {
  kind: 'ui',
  client: 'owner',
  tool: 'job.resume',
  principal: { principalId: 'system', profile: 'owner', label: 'owner' },
} as unknown as JobOrigin;

async function settle(w: RenameWorld, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
}

/** The writes the mock received to a path matching `re`. */
const writesTo = (w: RenameWorld, re: RegExp) =>
  w.stack.mock.calls.filter((c) => c.method !== 'GET' && re.test(c.path.replace(/\/$/, ''))).length;

describe.each([
  { stage: 'a page name', op: 'updateResource', method: 'PATCH', at: 2, path: /\/resources\/[^/]+$/ },
  { stage: 'a block', op: 'replaceBlock', method: 'PUT', at: 4, path: /\/blocks\/[^/]+$/ },
  { stage: 'an asset', op: 'updateAsset', method: 'PATCH', at: 1, path: /\/assets\/[^/]+$/ },
])('Resume: a rename stopped at $stage', ({ op, method, at, path }) => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('continues from where it stopped, never repeating a verified write; audited', async () => {
    const r = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: 'Laila al-Khalid',
      given: 'Laila',
    });
    const proposalId = String(r.body.proposalId);
    w.failNext(method, path, at);
    const before = writesTo(w, path);
    const done = await approve(w, proposalId);
    expect(done.job?.status).toBe('failed');
    const jobId = done.jobId!;
    // Where it stopped is recorded: its last verified step, and the step it stopped at.
    const view = w.stack.runtime.resume.view(PROJECT, jobId);
    expect(view.resumable).toBe(true);
    expect(view.stop!.lastVerifiedStep).toBeGreaterThanOrEqual(1);
    expect(view.stop!.stoppedStep).toBe(view.stop!.lastVerifiedStep + 1);
    const sentBefore = writesTo(w, path) - before;
    // The agent sees where it stopped, and that only the owner resumes work the owner approved.
    const status = await w.call('bridge_job_status', { jobId });
    expect(status.body.stoppedAt).toMatchObject({ youMayResume: false });
    const agent = await w.call('bridge_job_resume', { jobId });
    expect(agent.body.error?.code).toBe('OWNER_APPROVED_JOB');

    const out = await w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN);
    expect(out.status).toBe('resumed');
    const job = await settle(w, jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    // Every write to that path went once, and the one that failed once more.
    const planned = job.steps.filter((s) => s.opId === op).length;
    expect(writesTo(w, path) - before).toBe(planned + 1);
    expect(sentBefore).toBeLessThanOrEqual(planned);
    expect(w.repo.live(C.nadira)!.name).toBe('[BSRC] Laila al-Khalid - Character Core');
    expect(w.assets.assets.get('afnadir1')!.name).toBe('Laila al-Khalid');
    // Audited, with where it stopped and who approved the work; the proposal is executed after all.
    const audit = w.stack.runtime.policy.store
      .listAudit({ action: 'job.resume' })
      .find((a) => a.target === jobId)!;
    expect(audit.after).toMatchObject({
      kind: 'rename',
      lastVerifiedStep: view.stop!.lastVerifiedStep,
      stoppedStep: view.stop!.stoppedStep,
      approvedBy: 'owner',
    });
    expect(w.stack.runtime.policy.proposals.get(proposalId)!.state).toBe('executed');
    expect(w.stack.runtime.renames.byProposal(proposalId)!.state).toBe('done');
  });
});

describe('Resume: a step that is no longer safe', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('is refused with its reason: the check runs again first, and nothing more is written', async () => {
    const r = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: 'Laila al-Khalid',
      given: 'Laila',
    });
    const proposalId = String(r.body.proposalId);
    w.failNext('PUT', /\/blocks\/[^/]+$/, 1);
    const done = await approve(w, proposalId);
    expect(done.job?.status).toBe('failed');
    const jobId = done.jobId!;
    // Someone renames a page of her set (already renamed by the job) in the app. ADR 0058 amendment (A): a page of the
    // subject's own set is core, so the job's check stops it again (a changed restatement would only be skipped).
    w.repo.outside.rename(P.nadiraArt, '[BSRC] Laila al-Khalid - Portraits');
    const before = w.requests().writes;
    await w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN);
    const job = await settle(w, jobId);
    expect(job.status).toBe('failed');
    expect(JSON.stringify(job.lastError)).toContain('renamed meanwhile');
    expect(w.requests().writes).toBe(before);
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Laila al-Khalid - Portraits');
    // Still resumable: the owner can look, then resume or revert it.
    expect(w.stack.runtime.resume.view(PROJECT, jobId).resumable).toBe(true);
  });
});

describe('Resume: an agent’s own job', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('the agent that ran it resumes it at its scope; another agent cannot see it', async () => {
    const a = w.stack.newToken('resume-agent-a', 'write');
    const b = w.stack.newToken('resume-agent-b', 'write');
    const origin = (tok: { patId: string; profileId: string }): JobOrigin => ({
      kind: 'mcp',
      client: 'test',
      tool: 'test_package',
      principal: { principalId: tok.patId, profile: tok.profileId, label: 'agent' },
    });
    w.failNext('PATCH', /\/resources\/[^/]+$/, 1);
    const sub = await w.stack.runtime.engine.submit({
      kind: 'batch_ops',
      project: PROJECT,
      onError: 'stop',
      priority: 'P1',
      origin: origin(a),
      title: 'a package of two tags',
      resumable: { kind: 'package', recheck: [] },
      steps: [
        {
          op: 'updateResource',
          params: {
            path: { resourceId: P.nadiraBio },
            body: { tags: ['CANON', 'Character', 'Biography', 'One'] },
          },
        },
        {
          op: 'updateResource',
          params: {
            path: { resourceId: P.nadiraArt },
            body: { tags: ['CANON', 'Character', 'Character Art', 'Two'] },
          },
        },
      ],
    } as never);
    const jobId = (sub as { jobId: string }).jobId;
    const stopped = await settle(w, jobId);
    expect(stopped.status).toBe('failed');
    const ca = await w.stack.connect(a.token);
    const cb = await w.stack.connect(b.token);
    const other = await w.stack.call(cb, 'bridge_job_resume', { jobId });
    expect(other.body.error?.code).toBe('JOB_NOT_FOUND');
    const own = await w.stack.call(ca, 'bridge_job_resume', { jobId });
    expect(own.isError, own.text).toBeFalsy();
    const job = await settle(w, jobId);
    expect(job.status).toBe('succeeded');
    expect(w.repo.live(P.nadiraArt)!.tags).toContain('Two');
    const audit = w.stack.runtime.policy.store
      .listAudit({ action: 'job.resume' })
      .find((x) => x.target === jobId)!;
    expect(audit.actor).toBe(a.patId);
  });
});
