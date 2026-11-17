/**
 * R2-PACKS ATK-05: the pack job's run-time re-checks, against things that change between the job's own check step
 * (`bridge.expect` with `pack.governance` and `pack.absent`) and its first write.
 *
 * docs/packs.md ("Derived, never competing"): "every job reads them again, in the lock, before its first write
 * (PACK_GOVERNANCE_CHANGED stops it otherwise)". CR-06 (`recheckOnRelock`, src/jobs/engine.ts:2060) runs a job's
 * succeeded checks again when it takes its job-level lock again; but a pack job holds NO job-level lock
 * (src/packs/run.ts:305-329 passes no holdLock/holdMore/holdDocuments to runWriteJob), so `runJob`
 * (engine.ts:2005-2006) goes straight to `runSteps` and a check that succeeded before a hold is never repeated.
 *
 * The world keeps the seed's switches: `arkona_add_character_art` follows the agent's scope, so at scope `write` a
 * package for a Working character is ONE direct job. The owner pauses writes (the dashboard's kill switch) just after
 * the job's check step has read the last governance document (as CR-06's own test pauses after a check's read), so the
 * first write is held; then something changes; then writes resume. A budget wait, read-only mode or a restart between
 * the check and the first write opens the same window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest } from '../../contract/mock-lk.js';
import { fixture } from '../../images/world.js';
import type { ToolCall } from '../../tools/helpers.js';
import { packWorld, type PackWorld } from '../../packs/world.js';
import { PROJECT, liveNamed, settle, writeAgent } from './helpers.js';

let w: PackWorld;
let agent: Awaited<ReturnType<typeof writeAgent>>;
/** Pauses writes on the n-th read of the Tagging Standard's blocks after arming (1: the plan's; 2: the job's check). */
let armed: { seen: number; at: number } | null = null;
beforeAll(async () => {
  w = await packWorld({ toolModes: 'seed' });
  agent = await writeAgent(w);
  w.overrides.set(new RegExp(`/docs/${w.governanceDocs.tagging}/blocks$`), (req: MockRequest) => {
    if (armed && req.method === 'GET' && ++armed.seen === armed.at) {
      armed = null;
      w.stack.runtime.engine.controls.pauseWrites('test');
    }
    return undefined;
  });
});
afterAll(async () => {
  w?.stack.runtime.engine.controls.resumeWrites('test');
  await w?.close();
});

const engine = () => w.stack.runtime.engine;
const packs = () => w.stack.runtime.packs;
const until = async (fn: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms / 10 && !fn(); t++) await new Promise((r) => setTimeout(r, 10));
};
let salt = 40;
async function stage(): Promise<string> {
  const r = await agent('upload_image', {
    data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([salt++, 7])]).toString('base64'),
    name: `r2 stage ${salt}`,
    stage: true,
    project: 'test',
  });
  expect(r.isError, r.text).toBe(false);
  return String(r.body.staged_id);
}
const artFor = (staged: string, label: string) => ({
  character: 'Tamsin Reed',
  images: [{ staged_id: staged, label, interpretation: 'What this reference establishes.' }],
  project: 'test',
});

/**
 * Calls the art tool for a Working character (direct at scope write), with writes paused right after the job's check
 * step has read the governance; returns once that check has succeeded and the first write is held.
 */
async function heldAfterCheck(
  args: Record<string, unknown>,
): Promise<{ jobId: string; call: Promise<ToolCall> }> {
  const known = new Set(
    engine()
      .queries.listJobs(PROJECT, { limit: 200 })
      .map((j) => j.id),
  );
  armed = { seen: 0, at: 2 };
  const call = agent('arkona_add_character_art', args);
  let jobId = '';
  await until(() => {
    const j = engine()
      .queries.listJobs(PROJECT, { limit: 20 })
      .find((x) => !known.has(x.id) && x.title.startsWith('arkona_add_character_art'));
    if (j) jobId = j.id;
    return !!j && engine().queries.getJob(PROJECT, j.id)?.waitReason?.held === 'writes_paused';
  });
  const job = engine().queries.getJob(PROJECT, jobId);
  expect(job?.waitReason?.held, JSON.stringify(job ?? null).slice(0, 2000)).toBe('writes_paused');
  // The job's own check (the governance and the run-time re-checks) has run and succeeded; nothing was sent yet.
  expect(job?.steps.find((s) => s.opId === 'bridge.expect')?.status).toBe('succeeded');
  expect(job?.steps.filter((s) => s.opKind !== 'read' && s.status !== 'pending').map((s) => s.opId)).toEqual(
    [],
  );
  return { jobId, call };
}

describe('a direct pack job held between its check and its first write', () => {
  it('ATK-05a: the owner switches the tool to "always propose" (a new pack version) while it is held: the job must not write', async () => {
    const staged = await stage();
    const { jobId, call } = await heldAfterCheck(artFor(staged, 'Primary Reference - Portrait'));
    // The owner changes the switch on the Packs page (re-authenticated): a NEW version, not approved yet. The pack is
    // no longer current, and the tool now says "always propose".
    const after = packs().commands.setToolModes('owner', 'arkona', { arkona_add_character_art: 'propose' });
    expect(after.approved?.version).not.toBe(after.version);
    expect((await packs().governance('arkona')).state).toBe('rules_changed');
    engine().controls.resumeWrites('test');
    const job = await settle(w, jobId);
    await call;
    const made = liveNamed(w, '[BWRK] Tamsin Reed - Character Art');
    const assets = w.assets.byName('Tamsin Reed - Primary Reference - Portrait');
    // Put the pack back (approved) for the next test.
    packs().commands.setToolModes('owner', 'arkona', { arkona_add_character_art: 'scope' });
    await packs().commands.approve('owner', 'arkona');
    expect({
      status: job.status,
      code: job.lastError?.code,
      artPages: made.length,
      assets: assets.length,
    }).toEqual({ status: 'failed', code: 'PACK_GOVERNANCE_CHANGED', artPages: 0, assets: 0 });
  });

  it('ATK-05b: a governance page changes while it is held (drift): the job must not write', async () => {
    const staged = await stage();
    const { jobId, call } = await heldAfterCheck(artFor(staged, 'Detail Reference - Hands'));
    w.editGovernance('tagging');
    expect((await packs().governance('arkona')).state).toBe('changed');
    engine().controls.resumeWrites('test');
    const job = await settle(w, jobId);
    await call;
    const assets = w.assets.byName('Tamsin Reed - Detail Reference - Hands');
    await packs().commands.approve('owner', 'arkona');
    expect({ status: job.status, code: job.lastError?.code, assets: assets.length }).toEqual({
      status: 'failed',
      code: 'PACK_GOVERNANCE_CHANGED',
      assets: 0,
    });
  });
});
