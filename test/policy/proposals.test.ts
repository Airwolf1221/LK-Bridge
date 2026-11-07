/**
 * The proposal workflow against the mock LK: capture sends no write, approval executes exactly once (double
 * approval, crash and restart), conflicts, the unsupported-block guard, expiry, read-only and paused writes, partial
 * failure, rejection, attribution, and the approval token that stops approval from looping.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  PolicyDeniedError,
  UnsupportedBlockLossError,
  type BatchSubmit,
  type JobEngineEvents,
} from '../../src/jobs/index.js';
import { issueApprovalToken } from '../../src/policy/approval.js';
import { hashJson, proposalTools, type PolicyError } from '../../src/policy/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import type { Block } from '../jobs/lk-model.js';
import { settle } from '../jobs/helpers.js';
import { makePat, mcpOriginFor, policyRig, type PolicyRig } from './helpers.js';

let rig: PolicyRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const writesAtMock = (r: PolicyRig) => r.h.mock.calls.filter((c) => c.method !== 'GET');

async function setup(
  scope: 'propose' | 'write' | 'read' = 'propose',
  o: Parameters<typeof policyRig>[0] = {},
) {
  rig = await policyRig(o);
  const r = rig;
  const doc = r.h.model.seedResource('raaaaaaa', {
    blocks: [
      { id: 'p1', kind: 'paragraph', content: [{ text: 'hello' }] },
      { id: 'u1', kind: 'unsupported' },
    ],
  });
  r.h.model.seedResource('rbbbbbbb');
  const agent = makePat(r.db, r.policy, 'chatgpt', scope, () => r.h.clock.now(), 'chatgpt');
  return { r, doc, agent, origin: mcpOriginFor(agent.principal) };
}

const keepU1: Block[] = [
  { kind: 'paragraph', content: [{ text: 'rewritten' }] },
  { kind: 'unsupported', id: 'u1' },
];

async function propose(r: PolicyRig, p: Promise<unknown>) {
  const out = await settle(r.h, r.e, p);
  if (out.error) throw out.error as Error;
  const v = out.value as { status: string; proposalId: string; summary: string };
  expect(v.status).toBe('proposal_captured');
  return v;
}

async function approveAndRun(r: PolicyRig, id: string) {
  const out = await settle(r.h, r.e, r.policy.commands.approve('owner', id));
  if (out.error) throw out.error as Error;
  await r.h.drive(r.e, () => r.policy.proposals.isFinal(r.policy.proposals.state(id)!));
  return r.policy.proposals.get(id)!;
}

describe('capture', () => {
  it('sends only reads to LegendKeeper, and records versions and pre-state', async () => {
    const { r, doc, origin } = await setup();
    const res = await propose(
      r,
      r.e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId: doc.resourceId, documentId: doc.documentId }, body: { blocks: keepU1 } },
        { origin },
      ),
    );
    expect(res.summary).toContain('replaceDocumentBlocks');
    expect(writesAtMock(r)).toEqual([]);
    expect(r.h.model.mutations).toEqual([]);
    expect(r.e.engine.queries.listJobs()).toEqual([]);
    const detail = r.policy.commands.getProposal('owner', res.proposalId);
    expect(detail).toMatchObject({ state: 'pending', profile: 'chatgpt', opCount: 1, jobKind: 'single_op' });
    expect(detail.ops[0]).toMatchObject({
      op: 'replaceDocumentBlocks',
      version: 'v1',
      targetExists: true,
      target: { op: 'getDocumentBlocks' },
      unsupportedLoss: [],
    });
    expect(detail.ops[0]!.changes).toHaveLength(1); // the whole block list is replaced
    expect(JSON.stringify(detail.ops[0]!.preState)).toContain('hello');
  });

  it('captures a multi-operation request as ONE proposal', async () => {
    const { r, doc, origin } = await setup();
    const res = await propose(
      r,
      r.e.engine.submit({
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'updateResource', params: { path: { resourceId: 'rbbbbbbb' }, body: { name: 'Renamed' } } },
          {
            op: 'replaceDocumentBlocks',
            params: {
              path: { resourceId: doc.resourceId, documentId: doc.documentId },
              body: { blocks: keepU1 },
            },
          },
          { op: 'createResource', params: { body: { name: 'New' } } },
        ],
      }),
    );
    const all = r.policy.commands.listProposals('owner');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: res.proposalId, opCount: 3, jobKind: 'batch_ops' });
    const d = r.policy.commands.getProposal('owner', res.proposalId);
    expect(d.ops.map((o) => o.op)).toEqual(['updateResource', 'replaceDocumentBlocks', 'createResource']);
    expect(d.ops[0]!.changes).toEqual([{ path: 'name', before: 'rbbbbbbb', after: 'Renamed' }]);
    expect(d.ops[2]!.target).toBeNull(); // a create has nothing to compare
    expect(writesAtMock(r)).toEqual([]);
  });

  it('dry-runs the guards: a lossy replace or an unconfirmed cascade is refused at capture', async () => {
    const { r, doc, origin } = await setup();
    const lossy = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId: doc.resourceId, documentId: doc.documentId }, body: { blocks: [] } },
        { origin },
      ),
    );
    expect(lossy.error).toBeInstanceOf(UnsupportedBlockLossError);
    const cascade = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'deleteResource',
        { path: { resourceId: 'rbbbbbbb' }, query: { cascade: true } },
        { origin },
      ),
    );
    expect((cascade.error as { code?: string }).code).toBe('CASCADE_CONFIRM_REQUIRED');
    expect(r.policy.commands.listProposals('owner')).toEqual([]);
    expect(writesAtMock(r)).toEqual([]);
  });

  it('read scope is refused with a clear message; reads still work', async () => {
    const { r, origin } = await setup('read');
    const w = await settle(
      r.h,
      r.e,
      r.e.engine.run('updateResource', { path: { resourceId: 'rbbbbbbb' }, body: { name: 'x' } }, { origin }),
    );
    expect(w.error).toBeInstanceOf(PolicyDeniedError);
    expect((w.error as Error).message).toContain('read-only');
    const rd = await settle(
      r.h,
      r.e,
      r.e.engine.run('getResource', { path: { resourceId: 'rbbbbbbb' } }, { origin }),
    );
    expect(rd.value).toMatchObject({ status: 'succeeded' });
    expect(writesAtMock(r)).toEqual([]);
  });
});

describe('approval', () => {
  it('executes exactly once, creates no new proposal, and attributes proposer and approver', async () => {
    const { r, doc, agent, origin } = await setup();
    const events: JobEngineEvents['proposal'][] = [];
    r.e.engine.events.on('proposal', (e) => events.push(e));
    const { proposalId } = await propose(
      r,
      r.e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId: doc.resourceId, documentId: doc.documentId }, body: { blocks: keepU1 } },
        { origin },
      ),
    );
    // Double click: two approvals at once. Exactly one wins.
    const [a, b] = await Promise.allSettled([
      r.policy.commands.approve('owner', proposalId),
      r.policy.commands.approve('owner', proposalId),
    ]);
    const outcomes = [a, b].map((x) => x.status);
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
    const lost = [a, b].find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as PolicyError).code).toBe('INVALID_TRANSITION');
    await r.h.drive(r.e, () => r.policy.proposals.state(proposalId) === 'executed');

    expect(r.h.model.count('replaceDocumentBlocks')).toBe(1);
    expect(r.policy.commands.listProposals('owner')).toHaveLength(1); // no new proposal
    const p = r.policy.proposals.get(proposalId)!;
    expect(p).toMatchObject({ state: 'executed', decidedBy: 'owner' });
    const job = r.e.engine.queries.getJob(p.jobId!)!;
    expect(job).toMatchObject({
      kind: 'batch_ops',
      principalId: agent.patId,
      profile: 'chatgpt',
      approvedBy: 'owner',
      status: 'succeeded',
    });
    expect(job.origin).toMatchObject({ detail: `proposal:${proposalId}`, approval: { proposalId } });
    const journal = r.e.engine.queries.journalLookup({ jobId: p.jobId! });
    expect(journal[0]).toMatchObject({ principalId: agent.patId, profile: 'chatgpt', approvedBy: 'owner' });
    // The executed write was pinned to the captured version.
    expect(r.e.engine.queries.getJob(p.jobId!)!.steps[0]!.ifMatch).toBe('v1');

    // Approving again (a retry) does nothing.
    await expect(r.policy.commands.approve('owner', proposalId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(r.h.model.count('replaceDocumentBlocks')).toBe(1);
    expect(events.map((e) => e.state)).toEqual(['pending', 'approved', 'executing', 'executed']);
    expect(r.policy.commands.listAudit('owner').map((x) => x.action)).toEqual(
      expect.arrayContaining(['proposal.approve', 'proposal.executed']),
    );
  });

  it("the owner's approval wins even if the proposer's scope was lowered meanwhile", async () => {
    const { r, agent, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.run('updateResource', { path: { resourceId: 'rbbbbbbb' }, body: { name: 'Z' } }, { origin }),
    );
    r.policy.commands.setScope('owner', agent.profileId, 'read');
    expect((await approveAndRun(r, proposalId)).state).toBe('executed');
    expect(r.h.model.count('updateResource')).toBe(1);
  });

  it('detects a conflict when the page changed between proposing and approving, and runs nothing', async () => {
    const { r, doc, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.submit({
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'updateResource', params: { path: { resourceId: 'rbbbbbbb' }, body: { name: 'Q' } } },
          {
            op: 'replaceDocumentBlocks',
            params: {
              path: { resourceId: doc.resourceId, documentId: doc.documentId },
              body: { blocks: keepU1 },
            },
          },
        ],
      }),
    );
    r.h.model.outsideEdit(doc.documentId, (blocks) =>
      blocks.push({ id: 'p9', kind: 'paragraph', content: [] }),
    );
    const p = await approveAndRun(r, proposalId);
    expect(p.state).toBe('conflicted');
    expect(p.conflict).toMatchObject({
      index: 1,
      op: 'replaceDocumentBlocks',
      capturedVersion: 'v1',
      currentVersion: 'v2',
    });
    expect(writesAtMock(r)).toEqual([]);
    expect(r.e.engine.queries.listJobs()).toEqual([]);
    const view = r.policy.proposals.agentView(p);
    expect(view.conflict).toMatchObject({ operation: 2, op: 'replaceDocumentBlocks' });
  });

  it('the unsupported-block guard applies again at execution; a partial failure ends failed with the job', async () => {
    const { r, doc, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.submit({
        kind: 'batch_ops',
        origin,
        steps: [
          { op: 'updateResource', params: { path: { resourceId: doc.resourceId }, body: { name: 'First' } } },
          {
            op: 'replaceDocumentBlocks',
            params: {
              path: { resourceId: doc.resourceId, documentId: doc.documentId },
              body: { blocks: keepU1 },
            },
          },
        ],
      }),
    );
    // Hold the first write; meanwhile someone adds an unsupported block in the LK app.
    const release = r.e.hold((w) => w.method === 'PATCH');
    const approved = await settle(r.h, r.e, r.policy.commands.approve('owner', proposalId));
    expect(approved.value).toMatchObject({ state: 'executing' });
    await r.h.until(() => r.e.sent.some((w) => w.method === 'PATCH'));
    r.h.model.outsideEdit(doc.documentId, (blocks) => blocks.push({ id: 'u9', kind: 'unsupported' }));
    release();
    await r.h.drive(r.e, () => r.policy.proposals.isFinal(r.policy.proposals.state(proposalId)!));
    const p = r.policy.proposals.get(proposalId)!;
    expect(p.state).toBe('failed');
    expect(p.error).toMatchObject({ code: 'JOB_FAILED', jobId: p.jobId, stepsDone: 1, stepsTotal: 2 });
    expect(r.h.model.count('updateResource')).toBe(1);
    expect(r.h.model.count('replaceDocumentBlocks')).toBe(0); // u9 survives
    const job = r.e.engine.queries.getJob(p.jobId!)!;
    expect(job.steps[1]!.error).toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS' });
  });

  it('is refused while read-only or while writes are paused; the proposal stays pending', async () => {
    const { r, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.run('updateResource', { path: { resourceId: 'rbbbbbbb' }, body: { name: 'R' } }, { origin }),
    );
    r.e.engine.controls.setReadOnly(true);
    await expect(r.policy.commands.approve('owner', proposalId)).rejects.toMatchObject({
      code: 'BRIDGE_READ_ONLY',
    });
    expect(r.policy.proposals.state(proposalId)).toBe('pending');
    r.e.engine.controls.setReadOnly(false);
    r.e.engine.controls.pauseWrites();
    await expect(r.policy.commands.approve('owner', proposalId)).rejects.toMatchObject({
      code: 'WRITES_PAUSED',
    });
    expect(r.policy.proposals.state(proposalId)).toBe('pending');
    r.e.engine.controls.resumeWrites();
    expect((await approveAndRun(r, proposalId)).state).toBe('executed');
    expect(r.h.model.count('updateResource')).toBe(1);
  });

  it('expires pending proposals on the timer, and an expired one cannot be approved', async () => {
    const { r, origin } = await setup('propose', {
      policy: { proposalExpiryMs: 3_600_000, expirySweepMs: 60_000 },
    });
    const { proposalId } = await propose(
      r,
      r.e.engine.run('updateResource', { path: { resourceId: 'rbbbbbbb' }, body: { name: 'E' } }, { origin }),
    );
    await r.h.clock.advance(3_600_000 + 60_000);
    expect(r.policy.proposals.state(proposalId)).toBe('expired');
    await expect(r.policy.commands.approve('owner', proposalId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(writesAtMock(r)).toEqual([]);
  });

  it('rejects with a reason the agent can read; bulk commands report each result', async () => {
    const { r, agent, origin } = await setup();
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      ids.push(
        (
          await propose(
            r,
            r.e.engine.run(
              'updateResource',
              { path: { resourceId: 'rbbbbbbb' }, body: { name } },
              { origin },
            ),
          )
        ).proposalId,
      );
    }
    r.policy.commands.reject('owner', ids[0]!, 'Wrong page, try the other one');
    const bulk = r.policy.commands.bulkReject('owner', [ids[0]!, ids[1]!]);
    expect(bulk).toEqual([
      {
        id: ids[0],
        ok: false,
        state: 'rejected',
        error: expect.objectContaining({ code: 'INVALID_TRANSITION' }) as unknown,
      },
      { id: ids[1], ok: true, state: 'rejected' },
    ]);
    const approved = await settle(r.h, r.e, r.policy.commands.bulkApprove('owner', [ids[2]!, 'prop_nope']));
    expect(approved.value).toEqual([
      { id: ids[2], ok: true, state: 'executing' },
      {
        id: 'prop_nope',
        ok: false,
        state: 'unknown',
        error: expect.objectContaining({ code: 'PROPOSAL_NOT_FOUND' }) as unknown,
      },
    ]);
    const [status] = proposalTools(r.policy.proposals);
    const ctx = { principal: agent.principal } as unknown as McpToolContext;
    const out = await status!.handler({ proposalId: ids[0] }, ctx);
    expect(JSON.parse((out.content[0] as { text: string }).text)).toMatchObject({
      state: 'rejected',
      rejectReason: 'Wrong page, try the other one',
    });
  });
});

describe('approval cannot loop, and cannot be forged', () => {
  it('a forged approvedBy or approval from an agent has no effect', async () => {
    const { r, origin } = await setup();
    for (const extra of [{ approvedBy: 'owner' }, { approval: { proposalId: 'prop_x' } }]) {
      const out = await settle(
        r.h,
        r.e,
        r.e.engine.run(
          'updateResource',
          { path: { resourceId: 'rbbbbbbb' }, body: { name: 'F' } },
          {
            origin: { ...origin, ...extra },
          },
        ),
      );
      expect(out.error).toBeInstanceOf(PolicyDeniedError);
    }
    expect(r.policy.commands.listProposals('owner')).toEqual([]);
    expect(writesAtMock(r)).toEqual([]);
  });

  it("one proposal's token cannot execute another's operations, nor be reused", async () => {
    const { r, agent, origin } = await setup();
    const a = await propose(
      r,
      r.e.engine.run('updateResource', { path: { resourceId: 'rbbbbbbb' }, body: { name: 'A' } }, { origin }),
    );
    const bParams = { path: { resourceId: 'raaaaaaa' }, body: { name: 'B' } };
    const b = await propose(r, r.e.engine.run('updateResource', bParams, { origin }));
    // Put A into the state the token is honoured in, as approve does.
    r.db.prepare(`UPDATE proposals SET state = 'approved' WHERE id = ?`).run(a.proposalId);
    const aParams = { path: { resourceId: 'rbbbbbbb' }, body: { name: 'A' } };
    const tokenA = issueApprovalToken(
      a.proposalId,
      agent.principal.principalId,
      [{ op: 'updateResource', paramsHash: hashJson(aParams) }],
      r.h.clock.now(),
    );
    const submitWith = (params: object, approval: unknown): BatchSubmit => ({
      kind: 'batch_ops',
      steps: [{ op: 'updateResource', params }],
      origin: { ...origin, approvedBy: 'owner', approval },
    });
    // B's operation under A's token: refused.
    const wrong = await settle(r.h, r.e, r.e.engine.submit(submitWith(bParams, tokenA)));
    expect(wrong.error).toBeInstanceOf(PolicyDeniedError);
    // A consumed token: refused.
    tokenA.consume();
    const spent = await settle(r.h, r.e, r.e.engine.submit(submitWith(aParams, tokenA)));
    expect(spent.error).toBeInstanceOf(PolicyDeniedError);
    expect(r.policy.proposals.state(b.proposalId)).toBe('pending');
    expect(r.policy.commands.listProposals('owner')).toHaveLength(2);
    expect(writesAtMock(r)).toEqual([]);
  });
});

describe('crash during approval', () => {
  it('a job already submitted finishes once after a restart, and the proposal follows it', async () => {
    const { r, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'Crash' } },
        { origin },
      ),
    );
    r.e.hold((w) => w.method === 'PATCH');
    await settle(r.h, r.e, r.policy.commands.approve('owner', proposalId));
    await r.h.until(() => r.e.sent.some((w) => w.method === 'PATCH'));
    // The process dies with the write held (never reached LK), and with the proposal's job link lost too.
    r.db.prepare(`UPDATE proposals SET state = 'approved', job_id = NULL WHERE id = ?`).run(proposalId);
    r.restart({ crash: true });
    await r.h.drive(r.e, () => r.policy.proposals.state(proposalId) === 'executed');
    expect(r.h.model.count('updateResource')).toBe(1);
    expect(r.e.engine.queries.listJobs()).toHaveLength(1);
    await expect(r.policy.commands.approve('owner', proposalId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('an approval that never reached the engine goes back to pending; approving again runs it once', async () => {
    const { r, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'Again' } },
        { origin },
      ),
    );
    r.db
      .prepare(`UPDATE proposals SET state = 'approved', decided_by = 'owner' WHERE id = ?`)
      .run(proposalId);
    r.restart({ crash: true });
    expect(r.policy.proposals.state(proposalId)).toBe('pending');
    expect((await approveAndRun(r, proposalId)).state).toBe('executed');
    expect(r.h.model.count('updateResource')).toBe(1);
    expect(r.policy.commands.listAudit('owner').map((a) => a.action)).toContain(
      'proposal.approval_interrupted',
    );
  });
});

describe('member administration', () => {
  it('is denied at propose and write scope unless LK_ALLOW_MEMBER_ADMIN=true', async () => {
    const { r, origin } = await setup('write');
    const proposer = makePat(r.db, r.policy, 'proposer', 'propose', () => r.h.clock.now());
    for (const o of [origin, mcpOriginFor(proposer.principal)]) {
      const out = await settle(
        r.h,
        r.e,
        r.e.engine.run('removeMember', { path: { userId: 'u1' } }, { origin: o }),
      );
      expect(out.error).toBeInstanceOf(PolicyDeniedError);
      expect((out.error as Error).message).toContain('LK_ALLOW_MEMBER_ADMIN');
    }
    expect(r.policy.commands.listProposals('owner')).toEqual([]);
    expect(writesAtMock(r)).toEqual([]);
  });
});
