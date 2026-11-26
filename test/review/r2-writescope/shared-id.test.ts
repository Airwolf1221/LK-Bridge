/**
 * CR-2026-11 round 2 (write scope): a proposal and a direct write sharing an id. A proposal fixes the ids of the pages
 * it will create when it is captured ("ids of new pages are fixed now and kept at approval", the agent is told, and they
 * are in its answer). At scope `write` an agent can create a page with any free client id directly. v3 F12 (ADR 0081):
 * a canonical proposal now comes only from a connection at scope `propose`; the squat is a write-scope connection's.
 *
 * The SAFE behaviour asserted: when the owner approves (as canon) the proposal to create `[BSRC] Lantern Wardens`, the
 * job either creates that page, or does not run as approved (failed or conflicted, said plainly): it never reports the
 * approved create as done while the page under that id is one the agent made directly, with another name and place.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCanon } from '../../resources/world.js';
import { lifecycleWorld, type LifecycleWorld } from '../../lifecycle/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeAgent, type Agent } from './helpers.js';

let w: LifecycleWorld;
let a: Agent;
let pa: Agent;

beforeAll(async () => {
  w = await lifecycleWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-shared-id-agent');
  const t = w.stack.newToken('r2-shared-id-propose', 'propose');
  pa = { client: await w.stack.connect(t.token), profileId: t.profileId, patId: t.patId };
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const pcall = (tool: string, args: Record<string, unknown>) => w.stack.call(pa.client, tool, args);

describe('an id a pending canonical proposal fixed, taken first by a direct write', () => {
  it('S1: create_many_resources (an Authoritative page) approved as canon after the agent squats its id', async () => {
    const r = await pcall('create_many_resources', {
      items: [{ key: 'w', name: '[BSRC] Lantern Wardens', status: 'authoritative', parent: 'locs0001' }],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.requiresCanonicalApproval, r.text).toBe(true);
    const proposalId = String(r.body.proposalId);
    // The id the proposal fixed (the agent sees it in its answer).
    const detail = w.stack.runtime.policy.proposals.detail(proposalId)!;
    const create = detail.ops.find((o) => o.op === 'createManyResources')!;
    const id = (create.params as { body: { resources: { id: string }[] } }).body.resources[0]!.id;
    expect(r.text).toContain(id);
    // An agent at scope write creates a page of its own with that id, directly (a plain page, elsewhere).
    const squat = await call('lk_api_write', {
      operationId: 'createResource',
      params: { body: { id, name: 'Decoy notes', parentId: 'loose001' } },
    });
    expect(squat.body.status, squat.text).toBe('succeeded');
    // The owner, seeing "create [BSRC] Lantern Wardens under Locations", accepts it as canon.
    const done = await asCanon(w, r);
    const p = w.stack.runtime.policy.proposals.get(proposalId)!;
    const page = w.repo.live(id)!;
    const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
    expect(
      {
        // Either the approved page exists as approved, or the approval did not report success.
        madeAsApproved: page.name === '[BSRC] Lantern Wardens' && page.parentId === 'locs0001',
        reportedDone: job?.status === 'succeeded' && p.state === 'executed',
      },
      `proposal ${p.state}; job ${job?.status}; verified ${JSON.stringify(done.body.verified)}; page ${page.name} under ${page.parentId}; job result ${JSON.stringify(job?.result).slice(0, 1500)}`,
    ).not.toEqual({ madeAsApproved: false, reportedDone: true });
  });
});
