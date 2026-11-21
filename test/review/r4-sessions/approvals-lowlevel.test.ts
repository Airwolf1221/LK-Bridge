/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), the guarded rails at approval (ADR 0062 decision 5): "approving a proposal that deletes
 * anything ... judged by the rails' own rules at their defaults on the proposal's operations, however it came to be
 * proposed (a rail, a scope, the owner's own request)" needs the step-up. ADR 0057 decision 4 makes a removal through a
 * low-level tool (`deleteBlock`, `deletePropertyRow`, a whole-list write that drops entries) a delete for the deletes
 * rail. The attempt: an agent at scope `write` (default rails) sends such a removal; the deletes rail turns it into a
 * proposal ("proposed because: delete ..."); a dashboard session that has NOT stepped up approves it.
 *
 * The safe behaviour asserted: the approval answers 403 REAUTH_REQUIRED and nothing is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, PUBLIC_URL } from '../../tools/helpers.js';
import { writeAgent, type Agent } from '../r2-writescope/helpers.js';
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
  a = await writeAgent(w, 'r4-sessions-agent');
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

describe('a low-level removal the deletes rail made a proposal, approved without the step-up', () => {
  it('SE-05: lk_op_deleteBlock (a whole chronology table) — the approval asks for the step-up; nothing is deleted', async () => {
    const before = await blocksOf();
    expect(before.ids).toContain('tbl1');
    const r = await call('lk_op_deleteBlock', {
      path: { resourceId: 'age40001', documentId: w.docs.ageMain, blockId: 'tbl1' },
      ifMatch: before.version,
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toBe('proposed because: delete (1 block)'); // the deletes rail made it a proposal
    const res = await approve(String(r.body.proposalId));
    await settle(String(r.body.proposalId));
    const after = await blocksOf();
    expect({
      status: res.status,
      code: res.json?.error?.code ?? null,
      tableKept: after.ids.includes('tbl1'),
    }).toEqual({ status: 403, code: 'REAUTH_REQUIRED', tableKept: true });
  });

  it('SE-06: lk_api_write replaceDocumentBlocks that drops a block — the approval asks for the step-up', async () => {
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
    expect(r.body.proposedBecause).toMatch(/delete \(1 document replace that drops blocks\)/);
    const res = await approve(String(r.body.proposalId));
    expect({ status: res.status, code: res.json?.error?.code ?? null }).toEqual({
      status: 403,
      code: 'REAUTH_REQUIRED',
    });
  });

  it('SE-07: lk_api_batch deletePropertyRow (a sidebar row) — the approval asks for the step-up', async () => {
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'deletePropertyRow',
          params: { path: { resourceId: P.miyabi, propertyId: 'kvmiya01', rowId: 'kvmiya01r1' } },
        },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause, r.text).toMatch(/delete \(1 sidebar row\)/);
    const res = await approve(String(r.body.proposalId));
    expect({ status: res.status, code: res.json?.error?.code ?? null }).toEqual({
      status: 403,
      code: 'REAUTH_REQUIRED',
    });
  });

  it('SE-08 (control): a page delete through the same low-level tool asks for the step-up at approval', async () => {
    const r = await call('lk_api_write', {
      operationId: 'deleteResource',
      params: { path: { resourceId: P.miyabi } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const res = await approve(String(r.body.proposalId));
    expect({ status: res.status, code: res.json?.error?.code ?? null }).toEqual({
      status: 403,
      code: 'REAUTH_REQUIRED',
    });
  });
});
