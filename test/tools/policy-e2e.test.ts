/**
 * Chunk 2b integration with chunk 3's tools, through the real boot path (`createBridge`), the real `/mcp` endpoint
 * and the official MCP client:
 * - the gate in use is the live policy gate, and every engine-backed tool sends the caller's principal and its name;
 * - jobs, errors and stored results are visible to their own principal only; the journal shows everyone's entries;
 * - uploads are not proposable;
 * - bridge_info reports the caller's profile and scope;
 * - the full read / propose / approve / lower / write loop.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PolicyDeniedError, SYSTEM_PRINCIPAL, type JobOrigin } from '../../src/jobs/index.js';
import { LivePolicyGate, UPLOAD_PROPOSE_REASON } from '../../src/policy/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { systemClock } from '../../src/lk/index.js';
import { BRIDGE_INFO_LOOKUP_ORIGIN } from '../../src/mcp/tools/bridge.js';
import { PROJECT, startStack, type Stack } from './helpers.js';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const WRITE_TOOLS = ['lk_api_write', 'lk_api_batch', 'lk_upload_image', 'bridge_job_cancel'];

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ id: 'p1', kind: 'paragraph', content: [{ text: 'Hi' }] }],
});
model.seedResource('res2', { name: 'Province' });
for (let i = 0; i < 5; i++) model.seedResource(`pg${i}`, { name: `Page ${i}` });

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ respond: model.respond });
});
afterAll(() => stack.close());

const writesAtMock = () => stack.mock.calls.filter((c) => c.method !== 'GET').length;
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

async function as(label: string, scope: 'read' | 'propose' | 'write') {
  const t = stack.newToken(label, scope);
  return { ...t, client: await stack.connect(t.token) };
}

/** An error result with every occurrence of `id` replaced, for "answers exactly like an unknown id". */
const masked = (body: unknown, id: string) => JSON.stringify(body).replaceAll(id, '<ID>');

describe('boot: the live gate is in use', () => {
  it('runtime and server share the real policy gate, not allow-all', async () => {
    expect(stack.runtime.policy.gate).toBeInstanceOf(LivePolicyGate);
    const run = (origin: JobOrigin) =>
      stack.runtime.engine.run(
        'updateResource',
        { path: { resourceId: 'res2' }, body: { name: 'x' } },
        { project: PROJECT, origin },
      );
    const ghost = { principalId: 'pat_ghost', profile: 'tools-test', label: 'Ghost' };
    await expect(run({ kind: 'mcp', tool: 't', principal: ghost })).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(run({ kind: 'mcp', tool: 't', principal: SYSTEM_PRINCIPAL })).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(
      run({ kind: 'mcp', tool: 't', approvedBy: 'owner', principal: ghost }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(model.count('updateResource')).toBe(0);
  });
});

describe('every engine-backed tool acts as the caller', () => {
  it('sends the real principal and the tool name to the engine, never a placeholder or system', async () => {
    const me = await as('origins', 'write');
    // The low-level tools are hidden by default (v2 B2); this test calls every one.
    stack.runtime.policy.commands.setShowLowLevelTools('owner', me.profileId, true);
    const principal = stack.runtime.policy.store.lookupPrincipal(me.patId)!.principal;
    const engine = stack.runtime.engine;
    const seen: { tool: string; origin: JobOrigin; opId?: string }[] = [];
    const spies = {
      run: vi.spyOn(engine, 'run'),
      submit: vi.spyOn(engine, 'submit'),
      recordResult: vi.spyOn(engine, 'recordResult'),
    };
    const counts = () => [
      spies.run.mock.calls.length,
      spies.submit.mock.calls.length,
      spies.recordResult.mock.calls.length,
    ];
    const originsSince = ([r, sub, rec]: number[]): { origin: JobOrigin; opId?: string }[] => [
      ...spies.run.mock.calls.slice(r).map((c) => ({ origin: c[2].origin, opId: c[0] })),
      ...spies.submit.mock.calls.slice(sub).map((c) => ({ origin: c[0].origin })),
      ...spies.recordResult.mock.calls.slice(rec).map((c) => ({ origin: c[0].origin })),
    ];
    const args: Record<string, Record<string, unknown>> = {
      lk_api_read: { operationId: 'getResource', params: { path: { resourceId: 'res1' } } },
      lk_api_write: {
        operationId: 'updateResource',
        params: { path: { resourceId: 'res2' }, body: { name: 'Renamed' } },
      },
      lk_api_batch: { calls: [{ operationId: 'createResource', params: { body: { name: 'B' } } }] },
      lk_api_paginate_all: { operationId: 'listResources' },
      lk_upload_image: { name: 'pixel.png', base64: PNG_1PX, waitSeconds: 1 },
      bridge_info: {},
      bridge_journal_lookup: {},
      lk_api_describe_operation: { operationId: 'replaceDocumentBlocks' },
    };
    try {
      for (const name of await names(me.client)) {
        const before = counts();
        await stack.call(me.client, name, args[name] ?? {}).catch(() => undefined);
        for (const o of originsSince(before)) seen.push({ tool: name, ...o });
      }
    } finally {
      vi.restoreAllMocks();
    }
    const reached = new Set(seen.map((s) => s.tool));
    for (const t of [
      'lk_api_read',
      'lk_api_write',
      'lk_api_batch',
      'lk_api_paginate_all',
      'lk_upload_image',
      'bridge_info',
    ]) {
      expect(reached, t).toContain(t);
    }
    for (const s of seen) {
      // The one exception (v1.0.1, F-21): bridge_info's shared, cached project lookup is the bridge's own work. It
      // must be exactly that origin (system kind, no principal, no approver) and only its two reads.
      if (s.tool === 'bridge_info' && s.origin.kind === 'system') {
        expect(s.origin).toEqual(BRIDGE_INFO_LOOKUP_ORIGIN);
        expect(['getProject', 'listMembers']).toContain(s.opId);
        continue;
      }
      expect(s.origin, s.tool).toMatchObject({ kind: 'mcp', tool: s.tool, principal });
      expect(s.origin.principal?.principalId, s.tool).not.toBe('system');
      expect(s.origin.approvedBy, s.tool).toBeUndefined();
    }
  });

  it('no tool module keeps a placeholder principal', () => {
    const dir = join('src', 'mcp', 'tools');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/principalFor|SYSTEM_PRINCIPAL|profile: 'default'|principalId: '/);
    }
  });
});

describe('job, error and result visibility', () => {
  it("another principal's job, error or stored result answers exactly like an unknown one", async () => {
    const a = await as('agent-a', 'write');
    const b = await as('agent-b', 'write');
    const batch = await stack.call(a.client, 'lk_api_batch', {
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: 'res1' }, body: { name: 'A was here' } },
        },
      ],
    });
    const jobId = batch.body.jobId as string;
    expect((await stack.call(a.client, 'bridge_job_wait', { jobId, seconds: 10 })).body.status).toBe(
      'succeeded',
    );
    const pages = await stack.call(a.client, 'lk_api_paginate_all', { operationId: 'listResources' });
    await stack.call(a.client, 'bridge_job_wait', { jobId: pages.body.jobId, seconds: 10 });
    const handle = (await stack.call(a.client, 'bridge_job_status', { jobId: pages.body.jobId })).body.result
      .artifactId as string;
    expect((await stack.call(a.client, 'bridge_result_page', { handle })).isError).toBe(false);
    await stack.call(a.client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'nope' } },
    });

    // Owner of the work sees it.
    expect((await stack.call(a.client, 'bridge_job_status', { jobId })).body.jobId ?? jobId).toBe(jobId);
    expect(
      (await stack.call(a.client, 'bridge_job_status', {})).body.jobs.map((j: { jobId: string }) => j.jobId),
    ).toContain(jobId);
    const aErrors = await stack.call(a.client, 'bridge_errors_recent', { grouped: false });
    expect(aErrors.body.errors.some((e: { op: string }) => e.op === 'getResource')).toBe(true);

    // The other principal: same answers as for ids that do not exist.
    for (const [tool, extra] of [
      ['bridge_job_status', {}],
      ['bridge_job_wait', { seconds: 1 }],
      ['bridge_job_cancel', {}],
    ] as const) {
      const theirs = await stack.call(b.client, tool, { jobId, ...extra });
      const unknown = await stack.call(b.client, tool, { jobId: 'job_doesnotexist', ...extra });
      expect(theirs.isError, tool).toBe(true);
      expect(masked(theirs.body, jobId), tool).toBe(masked(unknown.body, 'job_doesnotexist'));
    }
    const theirPage = await stack.call(b.client, 'bridge_result_page', { handle });
    const noPage = await stack.call(b.client, 'bridge_result_page', { handle: 'art_doesnotexist' });
    expect(masked(theirPage.body, handle)).toBe(masked(noPage.body, 'art_doesnotexist'));
    expect((await stack.call(b.client, 'bridge_job_status', {})).body.jobs).toEqual([]);
    const bErrors = await stack.call(b.client, 'bridge_errors_recent', { grouped: false });
    expect(bErrors.body.errors).toEqual([]);
    expect((await stack.call(b.client, 'bridge_errors_recent', {})).body.groups).toEqual([]);
    expect(
      (await stack.call(b.client, 'bridge_errors_recent', { grouped: false, jobId })).body.errors,
    ).toEqual([]);
    // B's cancel did nothing.
    expect(stack.runtime.engine.queries.getJob(PROJECT, jobId)!.status).toBe('succeeded');

    // The journal: everyone's entries, with principal and profile; job ids only on your own.
    const forB = await stack.call(b.client, 'bridge_journal_lookup', { resourceId: 'res1' });
    const entry = forB.body.entries.find((e: { principalId: string }) => e.principalId === a.patId);
    expect(entry).toMatchObject({ profile: 'agent-a', jobId: null, mine: false, op: 'updateResource' });
    const forA = await stack.call(a.client, 'bridge_journal_lookup', { resourceId: 'res1' });
    expect(forA.body.entries.find((e: { principalId: string }) => e.principalId === a.patId)).toMatchObject({
      jobId,
      mine: true,
    });
    expect((await stack.call(b.client, 'bridge_journal_lookup', { jobId })).body.count).toBe(0);
  });

  it('a non-destructive write by one agent is in the journal for the other, with filters and paging (chunk 8, A)', async () => {
    const a = await as('xcheck-a', 'write');
    const b = await as('xcheck-b', 'read');
    const created = await stack.call(a.client, 'lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: 'Cross-checked' } },
    });
    expect(created.isError, created.text).toBe(false);
    const seenByB = await stack.call(b.client, 'bridge_journal_lookup', { profile: 'xcheck-a' });
    expect(seenByB.body.entries).toHaveLength(1);
    expect(seenByB.body.entries[0]).toMatchObject({
      op: 'createResource',
      outcome: 'applied',
      principalId: a.patId,
      profile: 'xcheck-a',
      approvedBy: null,
      jobId: null,
      mine: false,
    });
    expect(typeof seenByB.body.entries[0].target.id).toBe('string');
    expect(
      (await stack.call(b.client, 'bridge_journal_lookup', { principalId: a.patId, outcome: 'not_applied' }))
        .body.count,
    ).toBe(0);
    // Paging: a page of one gives a cursor; the next page continues below it.
    const p1 = await stack.call(b.client, 'bridge_journal_lookup', { limit: 1 });
    expect(p1.body.nextBefore).toBe(p1.body.entries[0].id);
    const p2 = await stack.call(b.client, 'bridge_journal_lookup', { limit: 1, before: p1.body.nextBefore });
    expect(p2.body.entries[0].id).toBeLessThan(p1.body.entries[0].id);
  });
});

describe('uploads under propose scope', () => {
  it('are refused before anything is sent, through lk_upload_image and the raw operations', async () => {
    const p = await as('proposer-up', 'propose');
    const before = stack.mock.calls.length;
    const up = await stack.call(p.client, 'lk_upload_image', { name: 'pixel.png', base64: PNG_1PX });
    expect(up.isError).toBe(true);
    expect(up.text).toContain('write');
    expect(up.text).toContain('owner can raise');
    // Chunk 8 (F-07): a URL source is refused before it is fetched (it used to be downloaded first; here the host
    // does not even resolve, so a fetch attempt would answer UPLOAD_URL_* instead of the policy refusal).
    const fromUrl = await stack.call(p.client, 'lk_upload_image', {
      name: 'remote.png',
      url: 'https://images.invalid/remote.png',
    });
    expect(fromUrl.isError).toBe(true);
    expect(fromUrl.body.error.code).toBe('POLICY_DENIED');
    expect(fromUrl.text).toContain('owner can raise');
    const raw = await stack.call(p.client, 'lk_api_write', {
      operationId: 'createImageUpload',
      params: { body: { contentType: 'image/png', contentLength: 68 } },
    });
    expect(raw.isError, raw.text).toBe(true);
    expect(raw.text).toContain('owner can raise');
    const batch = await stack.call(p.client, 'lk_api_batch', {
      calls: [{ operationId: 'createImageAsset', params: { body: { uploadKey: 'k', name: 'x' } } }],
    });
    expect(batch.isError).toBe(true);
    expect(batch.text).toContain('owner can raise');
    expect(stack.mock.calls.length).toBe(before);
    expect(
      stack.runtime.policy.commands.listProposals('owner', { project: ALL_PROJECTS, principalId: p.patId }),
    ).toEqual([]);
    expect(UPLOAD_PROPOSE_REASON).toContain('scope "write"');
  });
});

describe('bridge_info', () => {
  it("reports the calling connection's profile and scope", async () => {
    for (const scope of ['read', 'propose', 'write'] as const) {
      const c = await as(`info-${scope}`, scope);
      const info = await stack.call(c.client, 'bridge_info');
      expect(info.body).toMatchObject({ profile: `info-${scope}`, scope, principalId: c.patId });
    }
  });
});

describe('the full loop, end to end', () => {
  it('read: write tools hidden, a direct write call refused with the read-only message', async () => {
    const r = await as('loop-read', 'read');
    const listed = await names(r.client);
    for (const t of WRITE_TOOLS) expect(listed).not.toContain(t);
    expect(listed).toContain('lk_api_read');
    const before = writesAtMock();
    const w = await stack.call(r.client, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'res2' }, body: { name: 'nope' } },
    });
    expect(w.isError).toBe(true);
    expect(w.text).toContain('read-only');
    expect(w.text).toContain('owner can change');
    expect(writesAtMock()).toBe(before);
  });

  it('read: the 2025-era (stateless legacy) tools/list hides write tools too (chunk 8, F-11)', async () => {
    const r = await as('loop-read-legacy', 'read');
    const res = await fetch(`${stack.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${r.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
    const listed = (JSON.parse(json) as { result?: { tools?: { name: string }[] } }).result?.tools?.map(
      (t) => t.name,
    );
    expect(listed).toContain('lk_api_read');
    for (const t of WRITE_TOOLS) expect(listed).not.toContain(t);
  });

  it('propose → approve → executed once; lowering to read applies on the same token; write runs directly', async () => {
    const p = await as('loop-propose', 'propose');
    expect(await names(p.client)).toEqual(
      expect.arrayContaining(WRITE_TOOLS.filter((t) => t !== 'lk_upload_image')),
    );
    const before = writesAtMock();
    const res = await stack.call(p.client, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'res2' }, body: { name: 'Proposed name' } },
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.body).toMatchObject({ status: 'proposal_captured', operationId: 'updateResource' });
    expect(res.body.summary).toContain('updateResource');
    const proposalId = res.body.proposalId as string;
    expect(writesAtMock()).toBe(before); // nothing but reads reached LegendKeeper
    expect((await stack.call(p.client, 'bridge_proposal_status', { proposalId })).body.state).toBe('pending');

    const res2Writes = () =>
      model.mutations.filter((m) => m.op === 'updateResource' && m.id === 'res2').length;
    const writesBefore = res2Writes();
    const approved = await stack.runtime.policy.commands.approve('owner', proposalId);
    expect(approved.state).toBe('executing');
    const done = await stack.call(p.client, 'bridge_job_wait', { jobId: approved.jobId, seconds: 10 });
    expect(done.body.status).toBe('succeeded');
    const status = await stack.call(p.client, 'bridge_proposal_status', { proposalId });
    expect(status.body).toMatchObject({ state: 'executed', jobId: approved.jobId });
    expect(model.resources.get('res2')!.name).toBe('Proposed name');
    expect(res2Writes() - writesBefore).toBe(1); // exactly once
    await expect(stack.runtime.policy.commands.approve('owner', proposalId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(res2Writes() - writesBefore).toBe(1);
    expect(
      stack.runtime.policy.commands.listProposals('owner', { project: ALL_PROJECTS, principalId: p.patId }),
    ).toHaveLength(1);
    const journal = await stack.call(p.client, 'bridge_journal_lookup', {
      resourceId: 'res2',
      operationId: 'updateResource',
    });
    expect(journal.body.entries[0]).toMatchObject({
      principalId: p.patId,
      profile: 'loop-propose',
      approvedBy: 'owner',
      jobId: approved.jobId,
    });

    // Lower the profile to read: the SAME token, no reconnection.
    stack.runtime.policy.commands.setScope('owner', p.profileId, 'read');
    for (const t of WRITE_TOOLS) expect(await names(p.client)).not.toContain(t);
    const refused = await stack.call(p.client, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'res2' }, body: { name: 'again' } },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('read-only');
    expect(
      stack.runtime.policy.commands.listProposals('owner', { project: ALL_PROJECTS, principalId: p.patId }),
    ).toHaveLength(1);

    // Write scope: runs at once.
    const w = await as('loop-write', 'write');
    const direct = await stack.call(w.client, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'res1' }, body: { name: 'Written directly' } },
    });
    expect(direct.isError, direct.text).toBe(false);
    expect(direct.body.status).toBe('succeeded');
    expect(model.resources.get('res1')!.name).toBe('Written directly');
    expect(stack.runtime.engine.queries.getJob(PROJECT, direct.body.jobId)).toMatchObject({
      principalId: w.patId,
      profile: 'loop-write',
      approvedBy: null,
    });
  });
});
