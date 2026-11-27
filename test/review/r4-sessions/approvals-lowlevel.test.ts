/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), approving a low-level removal, as ADR 0081 now has it (the owner, 26 November 2026:
 * "A code at sign-in is enough"): approving a proposal never asks for a fresh authenticator code, a low-level removal
 * included (ADR 0062 decision 5 had asked for one). The case: an agent at scope `propose` sends a removal through a
 * low-level tool (`deleteBlock`, `deletePropertyRow`, a whole-list write that drops entries, a page delete), which is a
 * proposal (since F12 the rails that made one at scope `write` are gone); a dashboard session signed in but not stepped
 * up approves it, and it goes ahead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, PUBLIC_URL } from '../../tools/helpers.js';
import { type Agent } from '../r2-writescope/helpers.js';
import { ownerSession, type Owner } from './helpers.js';

let w: FactsWorld;
let a: Agent;
let owner: Owner;

beforeAll(async () => {
  w = await factsWorld({
    env: {
      MCP_EXPOSE_PER_OP_TOOLS: 'true',
      LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }),
    },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  // A connection at scope propose, with the low-level tools: its writes are proposals.
  const t = w.stack.newToken('r4-sessions-agent', 'propose');
  w.stack.runtime.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
  a = { client: await w.stack.connect(t.token), profileId: t.profileId, patId: t.patId };
  owner = ownerSession(w.stack, PUBLIC_URL); // signed in, never stepped up
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const blocksOf = async () => {
  const r = await call('lk_api_read', {
    operationId: 'getDocumentBlocks',
    params: { path: { resourceId: 'age40001', documentId: w.docs.ageMain } },
    detail: 'full',
  });
  const v = (r.body.result ?? r.body) as { version?: string; blocks?: { id: string }[] };
  return { version: String(v.version ?? ''), ids: (v.blocks ?? []).map((b) => b.id), blocks: v.blocks ?? [] };
};
const approve = (id: string) =>
  owner.call('POST', `/api/admin/proposals/${id}/approve?project=${PROJECT}`, {});
const settle = async (proposalId: string) => {
  for (let i = 0; i < 500; i++) {
    const p = w.stack.runtime.policy.proposals.get(proposalId)!;
    const j = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
    if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    if (p.state === 'pending' || p.state === 'conflicted') return undefined;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
};

describe('a low-level removal proposed at scope propose, approved by a session not stepped up (ADR 0081: it goes ahead)', () => {
  it('SE-05: lk_op_deleteBlock (a whole chronology table) — approved without a step-up, the table goes', async () => {
    const before = await blocksOf();
    expect(before.ids).toContain('tbl1');
    const r = await call('lk_op_deleteBlock', {
      path: { resourceId: 'age40001', documentId: w.docs.ageMain, blockId: 'tbl1' },
      ifMatch: before.version,
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const res = await approve(String(r.body.proposalId));
    await settle(String(r.body.proposalId));
    const after = await blocksOf();
    expect({
      status: res.status,
      code: res.json?.error?.code ?? null,
      tableKept: after.ids.includes('tbl1'),
    }).toEqual({ status: 200, code: null, tableKept: false });
  });

  it('SE-06: lk_api_write replaceDocumentBlocks that drops a block — approved without a step-up', async () => {
    const before = await blocksOf();
    const keep = before.blocks.filter((b) => b.id !== before.ids.at(-1));
    const r = await call('lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: 'age40001', documentId: w.docs.ageMain },
        ifMatch: before.version,
        body: { blocks: keep },
      },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const res = await approve(String(r.body.proposalId));
    expect({ status: res.status, code: res.json?.error?.code ?? null }).toEqual({ status: 200, code: null });
  });

  it('SE-07: lk_api_batch deletePropertyRow (a sidebar row) — approved without a step-up', async () => {
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'deletePropertyRow',
          params: { path: { resourceId: P.miyabi, propertyId: 'kvmiya01', rowId: 'kvmiya01r1' } },
        },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const res = await approve(String(r.body.proposalId));
    expect({ status: res.status, code: res.json?.error?.code ?? null }).toEqual({ status: 200, code: null });
  });

  it('SE-08: a page delete through the same low-level tool is approved without a step-up', async () => {
    const r = await call('lk_api_write', {
      operationId: 'deleteResource',
      params: { path: { resourceId: P.miyabi } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const res = await approve(String(r.body.proposalId));
    expect({ status: res.status, code: res.json?.error?.code ?? null }).toEqual({ status: 200, code: null });
  });
});
