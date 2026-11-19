/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 3.3: an agent resumes, with `bridge_job_resume`, "only its own job,
 * only one the owner did not approve (OWNER_APPROVED_JOB), only at scope write (SCOPE)". The attempts: a job the OWNER
 * cancelled; a job whose connection was moved to a lower scope; a job resumed after the owner switched a safety rail on
 * (ADR 0055 C); another agent's job; a job the owner approved; a revoked connection.
 *
 * Modelled: the agent's direct, resumable job is submitted through the engine with the agent's principal and
 * `resumable: { kind: 'package' }`, exactly as test/packs/resume.test.ts models one (a setting-pack tool switched to
 * "follow the scope" submits the same shape through `runWriteJob`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approve } from '../../packs/world.js';
import { C, P, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import type { JobOrigin } from '../../../src/jobs/types.js';
import { PROJECT, intercept, proposeRename, settle } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let open: RenameWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

type Tok = { token: string; patId: string; profileId: string };
const originOf = (tok: Tok): JobOrigin => ({
  kind: 'mcp',
  client: 'test',
  tool: 'test_package',
  principal: { principalId: tok.patId, profile: tok.profileId, label: 'agent' },
});

/** The agent's direct job: three page edits (tags, or descriptor renames), resumable like a package. */
async function directJob(
  w: RenameWorld,
  tok: Tok,
  steps: { id: string; body: Record<string, unknown> }[],
  title: string,
): Promise<string> {
  const sub = await w.stack.runtime.engine.submit({
    kind: 'batch_ops',
    project: PROJECT,
    onError: 'stop',
    priority: 'P1',
    origin: originOf(tok),
    title,
    resumable: { kind: 'package', recheck: [] },
    steps: steps.map((s) => ({ op: 'updateResource', params: { path: { resourceId: s.id }, body: s.body } })),
  } as never);
  expect(sub, JSON.stringify(sub)).toHaveProperty('jobId');
  return (sub as { jobId: string }).jobId;
}

const jobByTitle = (w: RenameWorld, title: string): string | undefined =>
  (w.stack.db.prepare('SELECT id FROM jobs WHERE title = ?').get(title) as { id: string } | undefined)?.id;

const TAGS = (x: string) => ['CANON', 'Character', x];

describe('bridge_job_resume: whose job, and when', () => {
  // CR-2026-11-R3 (R3-54): OPEN (docs/reviews/CR-2026-11-R3.md section 7), kept as an expected failure: owner decision 3 (ADR 0061): whose cancel an agent's Resume may undo.
  it.fails('AP-30 a direct job the OWNER cancelled part-way is not resumed by the agent', async () => {
    const w = (open = await renameWorld());
    const a = w.stack.newToken('ap30-agent', 'write');
    const title = 'ap30: three tag edits';
    // The owner cancels (Jobs page, Cancel) while the second edit is in flight: the third is never sent.
    intercept(w, 'PATCH', /\/resources\/nadirart$/, (n) => {
      if (n === 0) w.stack.runtime.engine.controls.cancel(PROJECT, jobByTitle(w, title)!);
      return undefined;
    });
    const jobId = await directJob(
      w,
      a,
      [
        { id: P.nadiraBio, body: { tags: TAGS('One') } },
        { id: P.nadiraArt, body: { tags: TAGS('Two') } },
        { id: R.archiveNotes, body: { tags: TAGS('Three') } },
      ],
      title,
    );
    const stopped = await settle(w, jobId);
    expect(stopped.status).toBe('cancelled');
    expect(w.repo.live(R.archiveNotes)!.tags).not.toContain('Three');
    const ca = await w.stack.connect(a.token);
    const r = await w.stack.call(ca, 'bridge_job_resume', { jobId });
    await settle(w, jobId);
    // SAFE: the owner's cancel stands; the agent cannot undo it.
    expect(
      { refused: r.isError === true, third: w.repo.live(R.archiveNotes)!.tags.includes('Three') },
      `the agent resumed the job the owner cancelled: ${r.text.slice(0, 300)}`,
    ).toEqual({ refused: true, third: false });
  });

  it('AP-31 a connection moved to scope propose cannot resume (SCOPE), and read cannot see the tool', async () => {
    const w = (open = await renameWorld());
    const a = w.stack.newToken('ap31-agent', 'write');
    w.failNext('PATCH', /\/resources\/nadirart$/, 0);
    const jobId = await directJob(
      w,
      a,
      [
        { id: P.nadiraBio, body: { tags: TAGS('One') } },
        { id: P.nadiraArt, body: { tags: TAGS('Two') } },
      ],
      'ap31',
    );
    expect((await settle(w, jobId)).status).toBe('failed');
    w.stack.runtime.policy.commands.setScope('owner', a.profileId, 'propose');
    const ca = await w.stack.connect(a.token);
    const r = await w.stack.call(ca, 'bridge_job_resume', { jobId });
    expect((r.body.error as { code?: string } | undefined)?.code, r.text).toBe('SCOPE');
    w.stack.runtime.policy.commands.setScope('owner', a.profileId, 'read');
    const r2 = await w.stack.call(ca, 'bridge_job_resume', { jobId });
    expect(r2.isError, r2.text).toBe(true);
    expect(w.repo.live(P.nadiraArt)!.tags).not.toContain('Two');
  });

  // CR-2026-11-R3 (R3-55): OPEN (docs/reviews/CR-2026-11-R3.md section 7), kept as an expected failure: owner decision 4 (ADR 0061): whether an agent's Resume re-judges the safety rails (ADR 0055 C3 judges them at entry).
  it.fails(
    'AP-32 after the renames-and-moves rail is switched on, the agent’s resume renames nothing',
    async () => {
      const w = (open = await renameWorld());
      const a = w.stack.newToken('ap32-agent', 'write');
      // Rails as a new profile has them: renames and moves OFF, so the job ran directly.
      w.failNext('PATCH', /\/resources\/hollowwk$/, 0);
      // Two Working pages (not canon): their renames run directly at scope write while the rail is off.
      const jobId = await directJob(
        w,
        a,
        [
          { id: C.draft, body: { name: '[BWRK] Draft Notes (old)' } },
          { id: P.hollowWorking, body: { name: '[BWRK] Hollow Court Draft (old)' } },
        ],
        'ap32',
      );
      expect((await settle(w, jobId)).status).toBe('failed');
      expect(w.repo.live(C.draft)!.name).toBe('[BWRK] Draft Notes (old)');
      // The owner now wants every rename by this agent to be a proposal.
      w.stack.runtime.policy.commands.setRails('owner', a.profileId, { renamesMoves: true });
      const ca = await w.stack.connect(a.token);
      const r = await w.stack.call(ca, 'bridge_job_resume', { jobId });
      await settle(w, jobId);
      // SAFE: the rename the rail now covers does not run directly (refused, or proposed).
      expect(
        w.repo.live(P.hollowWorking)!.name,
        `the rail switched on before the resume was not applied: ${r.text.slice(0, 200)}`,
      ).toBe('[BWRK] Hollow Court Draft');
    },
  );

  it('AP-33 another agent’s job, the owner-approved rename, and a revoked connection are refused', async () => {
    const w = (open = await renameWorld());
    const a = w.stack.newToken('ap33-agent-a', 'write');
    const b = w.stack.newToken('ap33-agent-b', 'write');
    w.failNext('PATCH', /\/resources\/nadirart$/, 0);
    const jobId = await directJob(
      w,
      a,
      [
        { id: P.nadiraBio, body: { tags: TAGS('One') } },
        { id: P.nadiraArt, body: { tags: TAGS('Two') } },
      ],
      'ap33',
    );
    expect((await settle(w, jobId)).status).toBe('failed');
    const cb = await w.stack.connect(b.token);
    const other = await w.stack.call(cb, 'bridge_job_resume', { jobId });
    expect((other.body.error as { code?: string } | undefined)?.code).toBe('JOB_NOT_FOUND');
    // The rename the owner approved, stopped part-way: the proposer cannot resume it.
    const id = await proposeRename(w);
    w.failNext('PUT', /\/blocks\/[^/]+$/, 0);
    const done = await approve(w, id);
    expect(done.job?.status).toBe('failed');
    const proposer = await w.stack.call(await w.stack.connect(), 'bridge_job_resume', { jobId: done.jobId! });
    expect((proposer.body.error as { code?: string } | undefined)?.code).toBe('OWNER_APPROVED_JOB');
    // A revoked connection reaches nothing.
    const ca = await w.stack.connect(a.token);
    w.stack.runtime.policy.commands.revoke('owner', a.patId);
    const revoked = await w.stack.call(ca, 'bridge_job_resume', { jobId }).catch((e: unknown) => ({
      isError: true,
      text: String(e),
      body: {},
    }));
    expect(revoked.isError).toBe(true);
    expect(w.repo.live(P.nadiraArt)!.tags).not.toContain('Two');
  });
  it('AP-34 a REVERTED direct job is never continued: not by Resume, nor by a step Retry', async () => {
    const w = (open = await renameWorld());
    const a = w.stack.newToken('ap34-agent', 'write');
    w.failNext('PATCH', /\/resources\/nadirart$/, 0);
    const jobId = await directJob(
      w,
      a,
      [
        { id: P.nadiraBio, body: { tags: TAGS('One') } },
        { id: P.nadiraArt, body: { tags: TAGS('Two') } },
      ],
      'ap34',
    );
    const failed = await settle(w, jobId);
    expect(failed.status).toBe('failed');
    expect(w.repo.live(P.nadiraBio)!.tags).toContain('One');
    // The owner reverts what it did (Review page, Revert): the Biography's tags go back.
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId, { confirmPartial: true });
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    await settle(w, (rv as { revertJobId: string }).revertJobId);
    expect(w.repo.live(P.nadiraBio)!.tags).not.toContain('One');
    expect(w.stack.runtime.resume.view(PROJECT, jobId).reason?.code).toBe('REVERTED');
    const ca = await w.stack.connect(a.token);
    const agent = await w.stack.call(ca, 'bridge_job_resume', { jobId });
    expect((agent.body.error as { code?: string } | undefined)?.code).toBe('REVERTED');
    // The Jobs page also offers Retry on the failed step (POST /jobs/:id/steps/:n/retry → engine.controls.retryStep).
    const failedStep = failed.steps.find((st) => st.status === 'failed')!.stepNo;
    let retried: string;
    try {
      w.stack.runtime.engine.controls.retryStep(PROJECT, jobId, failedStep);
      retried = 'accepted';
      await settle(w, jobId);
    } catch (e) {
      retried = (e as { code?: string }).code ?? 'refused';
    }
    // What the Review queue says of the job now (it was marked reviewed by the revert).
    const row = w.stack.db
      .prepare('SELECT reviewed_at, reviewed_via FROM direct_writes WHERE job_id = ?')
      .get(jobId) as { reviewed_at: number | null; reviewed_via: string | null } | undefined;
    // SAFE: the reverted job does not go on writing on top of its revert (and never behind a "reviewed" mark).
    expect(
      {
        continued: retried === 'accepted',
        art: w.repo.live(P.nadiraArt)!.tags.includes('Two'),
        queue: row?.reviewed_via ?? 'unreviewed',
      },
      `the reverted job was continued by a step retry (${retried})`,
    ).toEqual({ continued: false, art: false, queue: 'revert' });
  });
  it('AP-35 a direct job whose revert stopped part-way is not resumed by the agent', async () => {
    const w = (open = await renameWorld());
    const a = w.stack.newToken('ap35-agent', 'write');
    w.failNext('PATCH', /\/resources\/nadarchv$/, 0);
    const jobId = await directJob(
      w,
      a,
      [
        { id: P.nadiraBio, body: { tags: TAGS('One') } },
        { id: P.nadiraArt, body: { tags: TAGS('Two') } },
        { id: R.archiveNotes, body: { tags: TAGS('Three') } },
      ],
      'ap35',
    );
    expect((await settle(w, jobId)).status).toBe('failed');
    // The owner reverts it; the revert job's second write is refused, so only one of the two pages is put back.
    let n = 0;
    intercept(w, 'PATCH', /\/resources\/(nadirbio|nadirart)$/, () =>
      ++n === 2
        ? {
            status: 400,
            body: { message: 'model VALIDATION_ERROR (injected)', code: 'VALIDATION_ERROR', requestId: 'x' },
          }
        : undefined,
    );
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId, { confirmPartial: true });
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    const revertJob = await settle(w, (rv as { revertJobId: string }).revertJobId);
    expect(revertJob.status).toBe('failed');
    // The revert job is the bridge's own (system): the agent cannot see it, let alone resume it.
    const sys = await w.stack.call(await w.stack.connect(a.token), 'bridge_job_resume', {
      jobId: revertJob.id,
    });
    expect((sys.body.error as { code?: string } | undefined)?.code, sys.text).toBe('JOB_NOT_FOUND');
    const reverted = [P.nadiraBio, P.nadiraArt].filter(
      (id) => !w.repo.live(id)!.tags.some((t) => t === 'One' || t === 'Two'),
    );
    expect(reverted).toHaveLength(1);
    const view = w.stack.runtime.resume.view(PROJECT, jobId, {
      kind: 'agent',
      principalId: a.patId,
      scope: 'write',
    });
    const ca = await w.stack.connect(a.token);
    const r = await w.stack.call(ca, 'bridge_job_resume', { jobId });
    await settle(w, jobId);
    // SAFE: a job the owner has (partly) reverted is not continued on top of the half-done revert.
    expect(
      { resumable: view.resumable, third: w.repo.live(R.archiveNotes)!.tags.includes('Three') },
      `resumed on top of a half-done revert: ${r.text.slice(0, 200)}`,
    ).toEqual({ resumable: false, third: false });
  });
});
