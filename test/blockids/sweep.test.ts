/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- JSON replies of the admin API in tests */
/**
 * v3 F3.5 (ADR 0056) end to end: the block-id sweep (`assign-block-ids-sweep`) through the REAL runtime, engine,
 * policy, snapshots, appraisal overlay, maintenance scheduler and admin API, against the mock LegendKeeper (which gives
 * ids as `assignBlockIds` is documented to, or misbehaves on purpose). Mocks and fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import type { BlockIdSweep } from '../../src/blockids/index.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { B, PROJECT, S, blockIdsWorld, missingBlocks, type BlockIdsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON replies

let w: BlockIdsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const ID = 'assign-block-ids-sweep';
const rt = () => w!.stack.runtime;
const sweep = (): BlockIdSweep => rt().maintenance.blockIds!;
const pass = () =>
  sweep().store.recordSandboxCheck({
    bridgeVersion: sweep().prerequisite().version,
    project: 'test',
    verdict: 'PASS',
  });
/** Runs the job now for the project, as the owner's Run now does, and waits for it. */
const runNow = async () => {
  const { done } = rt().maintenance.commands.runNow('owner', ID, { id: PROJECT, name: 'test' });
  return (await done)!;
};
const journalOf = (jobId: string) =>
  w!.stack.db.prepare('SELECT * FROM write_journal WHERE job_id = ? ORDER BY step_no').all(jobId) as {
    op_id: string;
    pre_image: string | null;
    principal_id: string;
    id: number;
  }[];
const sweepJobs = () =>
  rt()
    .engine.queries.listJobs(PROJECT, { originKind: 'maintenance', limit: 200 })
    .filter((j) => j.origin.tool === ID && j.kind === 'batch_ops');

function owner(world: BlockIdsWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${world.stack.base}/api/admin${path}`, {
      method,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown = {}) => request('POST', path, body),
    put: (path: string, body: unknown = {}) => request('PUT', path, body),
    reauth: () =>
      world.stack.db
        .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
        .run(Math.floor(Date.now() / 1000), s.sessionHash(session)),
  };
}

describe('the candidates and a normal run', () => {
  it('counts the candidates from the latest snapshot; a run journals, assigns once, verifies, and touches nothing else', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    pass();
    const card = await sweep().card();
    const line = card.projects.find((p) => p.projectId === PROJECT)!;
    // The five legacy pages (Missing, Duplicate, Third, Fourth, the Authoritative harbour); Clean is not one.
    expect(line.candidates).toBe(5);
    expect(line.remaining).toBe(5);
    const docs = new Set((await sweep().candidates(PROJECT)).candidates.map((c) => c.resourceId));
    expect(docs).toEqual(new Set([B.missing, B.duplicate, B.third, B.fourth, S.harbour]));
    expect(card.statement.map((p) => p.key)).toEqual([
      'scope',
      'prerequisites',
      'transformation',
      'verification',
      'concurrency',
      'stop',
    ]);

    const lmrRowBefore = w.sidebars.rows(B.missing).find((r) => r.key === 'Last Major Revision')!.text;
    const run = await runNow();
    expect(run.outcome, run.detail ?? '').toBe('succeeded');
    expect(run.detail).toMatch(/^5 documents given block ids and verified\./);

    // assignBlockIds was called exactly once per document, and every block now has an id, once.
    for (const page of [B.missing, B.duplicate, B.third, B.fourth, S.harbour]) {
      expect(w.assigns.get(w.mainOf(page)), page).toBe(1);
      const ids: string[] = [];
      const walk = (l: Record<string, unknown>[]): void =>
        l.forEach((b) => {
          ids.push(b.id as string);
          if (Array.isArray(b.children)) walk(b.children as Record<string, unknown>[]);
        });
      walk(w.stored(page).blocks);
      expect(
        ids.every((x) => typeof x === 'string' && x !== ''),
        page,
      ).toBe(true);
      expect(new Set(ids).size, page).toBe(ids.length);
    }
    expect(w.assigns.has(w.mainOf(B.clean))).toBe(false);

    // One engine job per document: P3, the system principal, origin maintenance (the Jobs page), all succeeded.
    const jobs = sweepJobs();
    expect(jobs.length).toBe(5);
    for (const j of jobs) {
      expect(j).toMatchObject({ status: 'succeeded', priority: 'P3', principalId: 'system' });
      expect(j.origin.kind).toBe('maintenance');
    }

    // The pre-image: the whole document, as it was (no ids), journalled with the write.
    const missingJob = jobs.find((j) => j.title.includes('Old Missing'))!;
    const entry = journalOf(missingJob.id).find((e) => e.op_id === 'assignBlockIds')!;
    expect(entry.principal_id).toBe('system');
    const pre = JSON.parse(entry.pre_image!);
    expect(pre.version).toBe('v3');
    expect(pre.blocks).toEqual(missingBlocks());

    // Verified: the job's verify step and the sweep's own record.
    const steps = rt().engine.queries.getJob(PROJECT, missingJob.id)!.steps;
    expect(steps.map((s) => s.opId)).toEqual(['bridge.expect', 'assignBlockIds', 'bridge.verify']);
    expect(sweep().store.doc(PROJECT, w.mainOf(B.missing))).toMatchObject({
      status: 'done',
      jobId: missingJob.id,
      journalId: entry.id,
      assigned: 4,
    });

    // Last Major Revision is never set (lastMajorRevision "skip"): no decision step, the row unchanged.
    expect(steps.some((s) => s.opId === 'bridge.lmr')).toBe(false);
    expect(w.sidebars.rows(B.missing).find((r) => r.key === 'Last Major Revision')!.text).toBe(lmrRowBefore);

    // Not an agent's write: never on the Review page.
    for (const j of jobs) expect(rt().review.store.get(PROJECT, j.id)).toBeNull();
    expect(rt().review.list(PROJECT, { state: 'all' }).length).toBe(0);

    // The card counts them done; the next run has nothing to do.
    const after = (await sweep().card()).projects.find((p) => p.projectId === PROJECT)!;
    expect(after.counts.done).toBe(5);
    expect(after.remaining).toBe(0);
    const again = await runNow();
    expect(again.detail).toMatch(/^0 documents given block ids/);
    expect(sweepJobs().length).toBe(5);
  });
});

describe('concurrency', () => {
  it('a document edited after the read is skipped (nothing sent) and done on the next run', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    pass();
    sweep().setMaxPerRun('owner', 1);
    const doc = w.mainOf(B.duplicate);
    // Right after the sweep's pre-image read (the first GET of this run), someone edits the page in the app.
    const reads = w.stack.mock.calls.filter((c) => c.path.endsWith(`/docs/${doc}/blocks`)).length;
    w.afterRead(doc, reads, () =>
      w!.outsideEdit(B.duplicate, (b) =>
        b.push({ id: 'dp9', kind: 'paragraph', content: [{ text: 'new' }] }),
      ),
    );
    const first = await runNow();
    // Duplicate comes first in tree order ("Old Duplicate" < "Old Fourth" < …).
    expect(first.detail).toMatch(/1 edited since the read \(retried next run\)/);
    expect(w.assigns.has(doc)).toBe(false);
    expect(sweep().store.doc(PROJECT, doc)).toMatchObject({ status: 'moved' });
    const conflict = sweepJobs()[0]!;
    expect(conflict).toMatchObject({ status: 'failed', lastError: { code: 'VERSION_CONFLICT', stepNo: 1 } });

    const second = await runNow();
    expect(second.detail).toMatch(/^1 document given block ids and verified/);
    expect(w.assigns.get(doc)).toBe(1);
    expect(sweep().store.doc(PROJECT, doc)).toMatchObject({ status: 'done' });
    // The edit was kept, and its duplicate ids resolved.
    expect(w.stored(B.duplicate).blocks.map((b) => b.content?.[0]?.text ?? b.kind)).toEqual([
      'one',
      'two',
      'unsupported',
      'new',
    ]);
  });

  it('a document that gained ids since the snapshot is skipped by the live re-read', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    pass();
    sweep().setMaxPerRun('owner', 1);
    w.outsideEdit(B.duplicate, (b) => {
      b[1]!.id = 'dp2';
    });
    const r = await runNow();
    expect(r.detail).toMatch(/1 already had them/);
    expect(w.assigns.size).toBe(0);
    expect(sweepJobs().length).toBe(0);
  });
});

describe('limits', () => {
  it('does at most N documents a run', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    pass();
    sweep().setMaxPerRun('owner', 2);
    const r = await runNow();
    expect(r.detail).toMatch(/^2 documents given block ids and verified\. The limit of 2 a run was reached/);
    expect([...w.assigns.values()].reduce((a, b) => a + b, 0)).toBe(2);
    expect(rt().policy.store.listAudit({ action: 'blockids.max_per_run', limit: 1 })[0]!.after).toEqual({
      maxPerRun: 2,
    });
  });

  it('stops early when the P3 budget says wait', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    pass();
    const governor = rt().projects.anyClient(PROJECT)!.governor;
    // P3 may use almost nothing now: one more document would have to wait.
    governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.99 });
    const r = await runNow();
    expect(r.outcome).toBe('succeeded');
    expect(r.detail).toMatch(/Stopped early: the P3 budget says wait \(5 left for the next run\)/);
    expect(w.assigns.size).toBe(0);
  });
});

describe('a verification failure stops the sweep', () => {
  for (const mode of ['changeText', 'dropUnsupported'] as const) {
    it(`(${mode}): the run fails, the job disables itself, and the card shows it in red with the journal entry`, async () => {
      w = await blockIdsWorld();
      await w.snapshot();
      pass();
      expect(rt().maintenance.commands.enable('owner', ID).enabled).toBe(true);
      w.mode = mode;
      const r = await runNow();
      expect(r.outcome).toBe('failed');
      expect(r.detail).toMatch(/^Verification failed on “Old Duplicate”/);
      // The whole sweep stopped at the first document: nothing else was sent.
      expect([...w.assigns.values()].reduce((a, b) => a + b, 0)).toBe(1);
      expect(rt().maintenance.scheduler.get(ID).enabled).toBe(false);
      const audit = rt().policy.store.listAudit({ action: 'maintenance.disable', limit: 1 })[0]!;
      expect(audit).toMatchObject({ actor: 'system', target: ID });

      const card = await sweep().card();
      const job = sweepJobs()[0]!;
      const entry = journalOf(job.id).find((e) => e.op_id === 'assignBlockIds')!;
      expect(card.stop).toMatchObject({
        page: 'Old Duplicate',
        documentId: w.mainOf(B.duplicate),
        jobId: job.id,
        journalId: entry.id,
        acknowledgedAt: null,
      });
      expect(card.stop!.differences[0]!.path).toBe(
        mode === 'changeText' ? 'blocks[0].content[0].text' : 'unsupported blocks',
      );
      // The job's own verify step recorded the mismatch (Errors page).
      expect(rt().engine.queries.getJob(PROJECT, job.id)!.steps[2]!.status).toBe('succeeded');

      // A run while stopped does nothing; enabling again (with the PASS) acknowledges the stop.
      w.mode = 'normal';
      expect((await runNow()).detail).toMatch(/^Skipped: the sweep stopped after a verification failure/);
      rt().maintenance.commands.enable('owner', ID);
      expect((await sweep().card()).stop!.acknowledgedAt).not.toBeNull();
    });
  }
});

describe('prerequisite 2, the override, the dry run and the card (admin API)', () => {
  it('refuses to enable without a PASS or the override; the override needs re-authentication and is audited', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    const o = owner(w);
    // ADR 0062: switching a job on is a setting, so the step-up comes first; then the prerequisite.
    const unstepped = await o.post(`/maintenance/${ID}/enable`);
    expect(unstepped.status).toBe(403);
    expect(unstepped.json.error.code).toBe('REAUTH_REQUIRED');
    // The override: refused without a fresh re-authentication, then set and audited.
    const denied = await o.put(`/maintenance/${ID}/override`, { on: true });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('REAUTH_REQUIRED');
    o.reauth();
    const refused = await o.post(`/maintenance/${ID}/enable`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('PREREQUISITE_MISSING');
    // A run without either is skipped, saying why.
    expect((await runNow()).detail).toMatch(/^Skipped: the sandbox check has no recorded PASS/);

    const set = await o.put(`/maintenance/${ID}/override`, { on: true });
    expect(set.status).toBe(200);
    expect(set.json.prerequisite).toMatchObject({ ok: true, pass: null });
    expect(rt().policy.store.listAudit({ action: 'blockids.override', limit: 1 })[0]).toMatchObject({
      actor: 'owner',
      target: ID,
    });
    const enabled = await o.post(`/maintenance/${ID}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.json.job).toMatchObject({ enabled: true, scheduleText: 'Daily at 05:30 (London time)' });

    // Cleared again (no re-authentication needed to take a risk away): the job stays as it is, a run is skipped.
    await o.post(`/maintenance/${ID}/disable`);
    expect((await o.put(`/maintenance/${ID}/override`, { on: false })).json.prerequisite.ok).toBe(false);
    expect((await o.post(`/maintenance/${ID}/enable`)).status).toBe(409);

    // A recorded PASS for this bridge version is enough; one for another version is not.
    sweep().store.recordSandboxCheck({ bridgeVersion: '0.0.0-other', project: 'test', verdict: 'PASS' });
    expect(sweep().prerequisite().ok).toBe(false);
    pass();
    expect((await o.post(`/maintenance/${ID}/enable`)).status).toBe(200);
  });

  it('the dry run lists what the next run would do, with counts and cost, and writes (and reads) nothing', async () => {
    w = await blockIdsWorld();
    await w.snapshot();
    pass();
    const o = owner(w);
    // ADR 0062: the limit is a setting: refused without the step-up.
    expect((await o.put(`/maintenance/${ID}/limit`, { maxPerRun: 3 })).status).toBe(403);
    o.reauth();
    expect((await o.put(`/maintenance/${ID}/limit`, { maxPerRun: 3 })).json.maxPerRun).toBe(3);
    expect((await o.put(`/maintenance/${ID}/limit`, { maxPerRun: 0 })).status).toBe(400);
    const calls = w.stack.mock.calls.length;
    const dry = await o.post(`/maintenance/${ID}/dry-run`, { project: 'test' });
    expect(dry.status).toBe(200);
    expect(w.stack.mock.calls.length).toBe(calls);
    expect(dry.json.dryRun).toMatchObject({
      project: 'test',
      writesNothing: true,
      candidates: 5,
      remaining: 5,
      maxPerRun: 3,
      estimate: { reads: 12, writes: 3 },
    });
    expect(dry.json.dryRun.next.map((d: Json) => [d.page, d.missing, d.duplicates])).toEqual([
      ['Old Duplicate', 0, 1],
      ['Old Fourth', 1, 0],
      ['Old Missing', 4, 0],
    ]);
    expect(w.assigns.size).toBe(0);
    expect(sweepJobs().length).toBe(0);

    const card = await o.get(`/maintenance/${ID}/card`);
    expect(card.json.card.projects[0]).toMatchObject({ project: 'test', candidates: 5, remaining: 5 });
    expect(card.json.card.statement).toHaveLength(6);
  });
});
