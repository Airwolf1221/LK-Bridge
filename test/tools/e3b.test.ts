/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * v2 E3b (ADR 0045): the owner's decisions on the E3 review and the fixes for what the evaluation showed.
 *
 * - P1 to P3: `get_resources`, `bridge_proposals_mine` and `bridge_job_wait` are merged into `get_resource`,
 *   `bridge_proposal_status` and `bridge_job_status`; the old names answer "renamed to …" and are never listed.
 * - P4, P5: `lk_upload_image` and `create_bare_resource` are hidden by default (still callable; listed with the setting).
 * - Steering: an AMBIGUOUS answer for one character's pages names the roles and where the facts live; `get_resource` on a
 *   character's [INDEX] names the Core.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFECYCLE, resourcesWorld, T, type ResourcesWorld } from '../resources/world.js';

let w: ResourcesWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown> = {}) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const HINT =
  "a character's facts and Scope live on its Character Core (or Character Reference for a compact character)";

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('get_resource takes one page or several (P1)', () => {
  it('one page, as before; several as one job, each failure in its own entry', async () => {
    const one = await call('get_resource', { resource: 'miyabi01', live: false });
    expect(one.isError, one.text).toBe(false);
    expect(one.body.resource).toMatchObject({ id: 'miyabi01' });
    const many = await call('get_resource', { resources: ['miyabi01', 'No Such Page'], live: false });
    expect(many.isError, many.text).toBe(false);
    expect(many.body.count).toBe(2);
    expect(many.body.resources[0]).toMatchObject({ ok: true, id: 'miyabi01' });
    expect(many.body.resources[1]).toMatchObject({ ok: false });
    const live = await call('get_resource', { resources: ['miyabi01', 'kaede001'] });
    expect(live.body.resources.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(live.body.jobId).toBeTypeOf('string');
    expect(live.body.resources[0].factsVersion).toBeTypeOf('string');
  });

  it('asks for confirmation above ten live reads, as get_resources did', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `bk${i.toString(36).padStart(6, '0')}`);
    const est = await call('get_resource', { resources: ids });
    expect(est.body).toMatchObject({ status: 'estimate', pages: 12 });
    expect(est.body.hint).toMatch(/confirm: true/);
  });

  it('wants exactly one of `resource` and `resources`', async () => {
    const none = await call('get_resource', {});
    expect(none.isError).toBe(true);
    expect(none.body.error).toMatchObject({ code: 'RESOURCE_REQUIRED' });
    const both = await call('get_resource', { resource: 'miyabi01', resources: ['miyabi01'] });
    expect(both.body.error).toMatchObject({ code: 'RESOURCE_REQUIRED' });
  });
});

describe('the old names answer “renamed to …” (P1 to P3)', () => {
  it.each([
    ['get_resources', { resources: ['miyabi01'] }, 'get_resource', /`resources`/],
    ['bridge_proposals_mine', {}, 'bridge_proposal_status', /`proposalId` out/],
    ['bridge_job_wait', { jobId: 'job_x', seconds: 5 }, 'bridge_job_status', /`wait_seconds`/],
  ])('%s', async (old, args, now, how) => {
    const r = await call(old, args);
    expect(r.isError).toBe(true);
    // A short answer with no budget line (it touches no project), so it is parsed whole.
    const error = (JSON.parse(r.text) as { error: { code: string; message: string; hint: string } }).error;
    expect(error.code).toBe('TOOL_RENAMED');
    expect(error.message).toContain(`${old} was renamed to ${now}`);
    expect(error.message).toMatch(how);
    expect(error.hint).toContain(`Call ${now} instead`);
    // Nothing was done: no request to LegendKeeper.
  });

  it('are never listed, at any profile, and cost nothing', async () => {
    for (const scope of ['read', 'propose', 'write'] as const) {
      const t = w.stack.newToken(`renamed-${scope}`, scope);
      w.stack.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
      const names = (await (await w.stack.connect(t.token)).listTools()).tools.map((x) => x.name);
      for (const n of ['get_resources', 'bridge_proposals_mine', 'bridge_job_wait'])
        expect(names, n).not.toContain(n);
    }
    const before = w.stack.mock.calls.length;
    await call('get_resources', { resources: ['miyabi01'] });
    expect(w.stack.mock.calls.length).toBe(before);
  });
});

describe('bridge_job_status waits (P3)', () => {
  it('wait_seconds waits for the job and says done; without it, it answers at once; it needs a jobId', async () => {
    const b = await call('lk_api_batch', {
      calls: [{ operationId: 'getResource', params: { path: { resourceId: 'miyabi01' } } }],
    });
    expect(b.body.jobId, b.text).toBeTypeOf('string');
    const waited = await call('bridge_job_status', { jobId: b.body.jobId, wait_seconds: 10 });
    expect(waited.body).toMatchObject({ status: 'succeeded', done: true });
    const plain = await call('bridge_job_status', { jobId: b.body.jobId });
    expect(plain.body).toMatchObject({ jobId: b.body.jobId, done: true });
    const bare = await call('bridge_job_status', { wait_seconds: 5 });
    expect(bare.body.error).toMatchObject({ code: 'JOB_ID_REQUIRED' });
    const list = await call('bridge_job_status', {});
    expect(list.body.jobs.length).toBeGreaterThan(0);
    const tooLong = await call('bridge_job_status', { jobId: b.body.jobId, wait_seconds: 60 });
    expect(tooLong.isError).toBe(true); // the schema: at most 25
  });

  it('another connection’s job answers like an unknown one, waiting or not', async () => {
    const b = await call('lk_api_batch', {
      calls: [{ operationId: 'getResource', params: { path: { resourceId: 'miyabi01' } } }],
    });
    const other = w.stack.newToken('someone-else', 'write');
    const oc = await w.stack.connect(other.token);
    const theirs = await w.stack.call(oc, 'bridge_job_status', {
      project: 'test',
      jobId: b.body.jobId,
      wait_seconds: 1,
    });
    expect(theirs.isError).toBe(true);
    expect(theirs.body.error.code).toBe('JOB_NOT_FOUND');
  });
});

describe('bridge_proposal_status shows one proposal or lists yours (P2)', () => {
  it('with proposalId one; without it yours, newest first, filtered by state; never another connection’s', async () => {
    const p = w.stack.newToken('proposer-e3b', 'propose');
    const pc = await w.stack.connect(p.token);
    const made = await w.stack.call(pc, 'create_resource', {
      project: 'test',
      name: 'E3b Proposal Page',
      template: T.general,
    });
    expect(made.body, made.text).toMatchObject({ status: 'proposal_captured' });
    const id = made.body.proposalId as string;
    const one = await w.stack.call(pc, 'bridge_proposal_status', { project: 'test', proposalId: id });
    expect(one.body).toMatchObject({ proposalId: id, state: 'pending' });
    const mine = await w.stack.call(pc, 'bridge_proposal_status', { project: 'test' });
    expect(mine.body.proposals.map((x: { proposalId: string }) => x.proposalId)).toEqual([id]);
    const none = await w.stack.call(pc, 'bridge_proposal_status', { project: 'test', state: 'rejected' });
    expect(none.body.proposals).toEqual([]);
    const other = w.stack.newToken('proposer-other', 'propose');
    const oc = await w.stack.connect(other.token);
    expect((await w.stack.call(oc, 'bridge_proposal_status', { project: 'test' })).body.proposals).toEqual(
      [],
    );
    const theirs = await w.stack.call(oc, 'bridge_proposal_status', { project: 'test', proposalId: id });
    expect(theirs.isError).toBe(true);
  });
});

describe('hidden by default, callable, listed with the setting (P4, P5, P6)', () => {
  it('lk_upload_image and create_bare_resource are not listed until the profile shows low-level and rarely used tools', async () => {
    const t = w.stack.newToken('rare-tools', 'write');
    const list = async () => (await (await w.stack.connect(t.token)).listTools()).tools.map((x) => x.name);
    for (const n of ['lk_upload_image', 'create_bare_resource']) expect(await list(), n).not.toContain(n);
    w.stack.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
    for (const n of ['lk_upload_image', 'create_bare_resource']) expect(await list(), n).toContain(n);
  });

  it('are still callable when hidden (hiding is cosmetic; policy decides)', async () => {
    const bare = await call('create_bare_resource', { name: '[BWRK] E3b Bare', dryRun: true });
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.body).toMatchObject({ status: 'dry_run' });
    const reader = w.stack.newToken('rare-reader', 'read');
    const rc = await w.stack.connect(reader.token);
    const refused = await rc.callTool({
      name: 'create_bare_resource',
      arguments: { project: 'test', name: '[BWRK] E3b Nope' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toMatch(/read-only/);
  });
});

describe('steering towards the Core', () => {
  let indexId: string;
  let coreId: string;
  beforeAll(async () => {
    const made = await call('create_character', { kind: 'core', name: 'E3 Eval Ren', race: 'Foxian' });
    expect(made.body, made.text).toMatchObject({ status: 'written' });
    const pages = made.body.pages as { id: string; name: string }[];
    indexId = pages.find((p) => p.name.startsWith('[INDEX]'))!.id;
    coreId = pages.find((p) => p.name.includes('Character Core'))!.id;
    await w.stack.runtime.tree.sweep('proj_mock');
  });

  it('AMBIGUOUS for one character’s pages lists each with its role and says where the facts live', async () => {
    const r = await call('get_resource', { resource: 'E3 Eval Ren' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('AMBIGUOUS');
    const roles = Object.fromEntries(
      r.body.error.candidates.map((c: { id: string; role: string }) => [c.id, c.role]),
    );
    expect(roles[indexId]).toBe('character index');
    expect(roles[coreId]).toBe('Character Core');
    expect(r.body.error.hint).toContain(HINT);
    // A write is still never chosen for the agent.
    const write = await call('set_facts', { page: 'E3 Eval Ren', facts: { Scope: 'x' } });
    expect(write.isError).toBe(true);
    expect(write.body.error.code).toBe('AMBIGUOUS');
  });

  it('AMBIGUOUS for unrelated pages carries no such hint', async () => {
    const r = await call('get_resource', { resource: 'Ashgate' });
    expect(r.body.error.code).toBe('AMBIGUOUS');
    expect(JSON.stringify(r.body.error)).not.toContain('Character Core (or Character Reference');
  });

  it('get_resource on a character’s [INDEX] names the Core, with its id, and the same sentence', async () => {
    const r = await call('get_resource', { resource: indexId });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.character.note).toContain(HINT);
    expect(r.body.character.note).toContain(`id ${coreId}`);
    expect(r.body.character.core).toMatchObject({ id: coreId, role: 'Character Core' });
    const viaMany = await call('get_resource', { resources: [indexId, coreId], live: false });
    expect(viaMany.body.resources[0].character.core.id).toBe(coreId);
    expect(viaMany.body.resources[1].character).toBeUndefined();
  });

  it('the Core itself, and an ordinary index, carry no character note', async () => {
    const core = await call('get_resource', { resource: coreId, live: false });
    expect(core.body.character).toBeUndefined();
    const idx = await call('get_resource', { resource: LIFECYCLE.working, live: false });
    expect(idx.body.character).toBeUndefined();
  });
});
