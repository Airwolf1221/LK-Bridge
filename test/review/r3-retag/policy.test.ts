/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- tool JSON */
/**
 * R3-RETAG (pass 3): "a policy or governance change (pack version, token map, governance document) stops the job
 * (audit again)", "no unknown token is ever proposed" (a token only in a pending pack version), and "at most 25
 * pages per apply" (a pending version does not raise it). v3 F12 (ADR 0081): the pack's "always propose" switch and the
 * bulk rail are gone (RT-73 and RT-75, which tested them, went with them): at scope write an apply runs directly, and
 * is tracked as a batch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../tools/helpers.js';
import { lifecycleFrom } from '../../../src/lifecycle/settings.js';
import { approve, audit, CANON_ROWS, PROJECT, propose, r3World, tagsOf, type R3World } from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

const P = {
  lifecycle: 'r3lcy001',
  gov: 'r3gov001',
  tokenRun: 'r3tok001',
  pending: 'r3pnd001',
} as const;
const BULK = Array.from({ length: 12 }, (_, i) => `r3blk${String(i).padStart(3, '0')}`);

let w: R3World;
let stopped: string;
let agent: (name: string, args: Record<string, unknown>) => Promise<ToolCall>;
beforeAll(async () => {
  w = await r3World([
    { id: P.gov, name: '[BSRC] Aaa Governance - Polity Reference', tags: ['Polity', 'CANON'] },
    { id: P.lifecycle, name: '[BSRC] Aab Lifecycle - Polity Reference', tags: ['Polity', 'CANON'] },
    { id: P.tokenRun, name: '[BSRC] Abb Token Run - Polity Reference', tags: ['Polity', 'CANON'] },
    {
      id: P.pending,
      name: '[BSRC] Acc Pending - Character Core',
      tags: ['CANON', 'Character', 'Fujimatsuan'],
      referenceType: 'Character Core',
      rows: [...CANON_ROWS, ['Race / Species', 'Starkin'], ['Naming Culture', 'Fujimatsuan']],
    },
    ...BULK.map((id, i) => ({
      id,
      name: `[BSRC] Bulk ${String(i).padStart(2, '0')} - Polity Reference`,
      tags: ['Polity', 'CANON'],
    })),
  ]);
  await w.snapshot();
  // An agent at scope write.
  const { token } = w.stack.newToken('r3-write-agent', 'write');
  const client = await w.stack.connect(token);
  agent = (name, args) => w.stack.call(client, name, args);
});
afterAll(async () => w?.close());

describe('a policy or governance change stops the apply', () => {
  it('RT-70: the Tagging Standard edited before the approval: the job stops, nothing written', async () => {
    const body = await audit(w, { page: P.gov });
    const p = await propose(w, body.runId, [P.gov]);
    const writes = w.requests().writes;
    w.editGovernance('tagging');
    const done = await approve(w, p.proposalId);
    expect(done.job?.status).toBe('failed');
    expect(done.job?.lastError?.code).toBe('RETAG_POLICY_CHANGED');
    expect(w.requests().writes).toBe(writes);
    expect(tagsOf(w, P.gov)).toEqual(['Polity', 'CANON']);
    stopped = done.jobId!;
  });

  it('RT-77: the owner re-approves the changed governance, then resumes the stopped job: still refused', async () => {
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    const rt = w.stack.runtime;
    const view = rt.resume.view(PROJECT, stopped);
    if (view.resumable) {
      await rt.resume.resume(PROJECT, stopped, { kind: 'owner' }, {
        kind: 'ui',
        client: 'owner',
        tool: 'job.resume',
        principal: { principalId: 'system', profile: 'owner', label: 'owner' },
      } as never);
      await rt.engine.wait(PROJECT, stopped, 25_000).catch(() => undefined);
    }
    const job = rt.engine.queries.getJob(PROJECT, stopped)!;
    // SAFE: the resumed job's policy check runs again and refuses (the digest names the approved governance versions).
    expect({ resumable: view.resumable, status: job.status, code: job.lastError?.code }).toEqual({
      resumable: true,
      status: 'failed',
      code: 'RETAG_POLICY_CHANGED',
    });
    expect(tagsOf(w, P.gov)).toEqual(['Polity', 'CANON']);
  });

  it('RT-71: a new approved version (token map changed) after the audit: the run cannot be proposed', async () => {
    const body = await audit(w, { page: P.tokenRun });
    expect(body.pages[0].disposition).toBe('correction');
    w.approveRetag({ race: { Moonkin: 'Moonkin' } });
    const r = await w.call('arkona_retag_apply', { project: 'test', runId: body.runId, pages: [P.tokenRun] });
    expect(r.body.error?.code).toBe('RETAG_POLICY_CHANGED');
  });

  it('RT-72: a token only in a pending (unapproved) version is never proposed', async () => {
    const packs = w.stack.runtime.packs;
    packs.commands.setTokens('owner', 'arkona', {
      race: { ...packs.get('arkona')!.rules.tags.race, Starkin: 'Starkin' },
    });
    expect(packs.get('arkona')!.approved!.version).toBeLessThan(packs.get('arkona')!.version);
    const body = await audit(w, { page: P.pending });
    expect(body.pages[0].disposition).toBe('hold');
    expect(body.pages[0].proposed).not.toContain('Starkin');
  });
});

describe('the cap, and a direct apply', () => {
  it('RT-74: a pending version with batchSize 100 does not raise the cap of the approved one', () => {
    const packs = w.stack.runtime.packs;
    const pack = packs.get('arkona')!;
    packs.store.newVersion(
      'arkona',
      { ...pack.rules, retag: { ...pack.rules.retag!, batchSize: 100 } },
      'pending',
    );
    expect(w.stack.runtime.retag.policyFor(PROJECT).rules.retag!.batchSize).toBe(25);
  });

  it('RT-76: at scope write a small batch runs directly and is still tracked', async () => {
    const body = await audit(w, { page: BULK[11] });
    const r = await agent('arkona_retag_apply', { project: 'test', runId: body.runId, pages: [BULK[11]] });
    expect(r.isError, r.text).toBe(false);
    const b = w.stack.runtime.retag.store.batches(PROJECT, { limit: 5 }).find((x) => x.runId === body.runId);
    expect(b, 'a direct retag job is recorded as a batch').toBeDefined();
    expect(b!.jobId).not.toBeNull();
    // Revert applies to it (its job, as for any direct write at scope write).
    expect(w.stack.runtime.retag.isApplyJob(PROJECT, b!.jobId!)).toBe(true);
    expect(tagsOf(w, BULK[11]!)).toEqual(['CANON', 'Polity']);
  });
});

describe('policy inputs outside the digest', () => {
  it('RT-78: the project’s status tags changed after the audit: the job stops or holds', async () => {
    w.approveRetag();
    const body = await audit(w, { page: P.lifecycle });
    expect(body.pages[0]).toMatchObject({ disposition: 'correction', proposed: ['CANON', 'Polity'] });
    const p = await propose(w, body.runId, [P.lifecycle]);
    // The owner renames the project's canon status tag (Projects page, Lifecycle): CANON is no longer a status tag.
    const projects = w.stack.runtime.projects;
    const { problem: _problem, ...lc } = lifecycleFrom(projects.resolve(PROJECT)?.settings);
    projects.setSetting(PROJECT, 'lifecycle', { ...lc, tags: { ...lc.tags, canon: 'Canon Source' } });
    try {
      const now = await audit(w, { page: P.lifecycle });
      const done = await approve(w, p.proposalId);
      const seen = { now: now.pages[0].disposition, job: done.job?.status, tags: tagsOf(w, P.lifecycle) };
      // SAFE: the verdict's policy changed (its status tags): the job stops ("audit again") or the page is held.
      expect(seen.tags, JSON.stringify(seen)).toEqual(['Polity', 'CANON']);
    } finally {
      projects.setSetting(PROJECT, 'lifecycle', lc);
    }
  });
});
