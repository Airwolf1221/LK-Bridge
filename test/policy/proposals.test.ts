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
import { ProjectSelector } from '../../src/projects/index.js';
import { PROJECT, settle } from '../jobs/helpers.js';
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
        { project: PROJECT, origin },
      ),
    );
    expect(res.summary).toContain('replaceDocumentBlocks');
    expect(writesAtMock(r)).toEqual([]);
    expect(r.h.model.mutations).toEqual([]);
    expect(r.e.engine.queries.listJobs(PROJECT)).toEqual([]);
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
        project: PROJECT,
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
    const all = r.policy.commands.listProposals('owner', { project: PROJECT });
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
        { project: PROJECT, origin },
      ),
    );
    expect(lossy.error).toBeInstanceOf(UnsupportedBlockLossError);
    const cascade = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'deleteResource',
        { path: { resourceId: 'rbbbbbbb' }, query: { cascade: true } },
        { project: PROJECT, origin },
      ),
    );
    expect((cascade.error as { code?: string }).code).toBe('CASCADE_CONFIRM_REQUIRED');
    expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toEqual([]);
    expect(writesAtMock(r)).toEqual([]);
  });

  it('keeps at most 4 MiB of pre-state per proposal, however many operations target one big page (chunk 8, F-04)', async () => {
    const { r, origin } = await setup();
    const big = r.h.model.seedResource('rbigbigb', {
      blocks: Array.from({ length: 300 }, (_, i) => ({
        id: `b${i}`,
        kind: 'paragraph' as const,
        content: [{ text: `é${'x'.repeat(2000)}` }],
      })),
    });
    const path = { resourceId: big.resourceId, documentId: big.documentId };
    const readsBefore = r.h.mock.calls.length;
    const res = await propose(
      r,
      r.e.engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        origin,
        steps: Array.from({ length: 20 }, () => ({
          op: 'replaceDocumentBlocks',
          params: { path, body: { blocks: [{ kind: 'paragraph', content: [{ text: 'short' }] }] } },
          allowUnsupportedLoss: true,
        })),
      }),
    );
    // One read for the one target, as before.
    expect(r.h.mock.calls.length - readsBefore).toBe(1);
    const rows = r.db
      .prepare('SELECT pre_state, pre_state_truncated, fingerprint FROM proposal_ops WHERE proposal_id = ?')
      .all(res.proposalId) as {
      pre_state: string | null;
      pre_state_truncated: number;
      fingerprint: string;
    }[];
    const stored = rows.reduce((n, x) => n + Buffer.byteLength(x.pre_state ?? ''), 0);
    expect(stored).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(rows.every((x) => Buffer.byteLength(x.pre_state ?? '') <= 512 * 1024)).toBe(true);
    // Conflict detection still has what it needs on every operation.
    expect(rows.every((x) => typeof x.fingerprint === 'string' && x.fingerprint.length > 0)).toBe(true);
    expect(rows.at(-1)?.pre_state).toBeNull();
    expect(rows.at(-1)?.pre_state_truncated).toBe(1);
  });

  it('refuses a 51st pending proposal from one connection before reading anything (chunk 8, F-04)', async () => {
    const { r, doc, agent, origin } = await setup();
    const now = r.h.clock.now();
    const insert = r.db.prepare(
      `INSERT INTO proposals (id, project_id, principal_id, principal_label, profile, origin, job_kind, title,
         priority, summary, state, created_at, updated_at, expires_at)
       VALUES (?, '${PROJECT}', ?, 'x', 'chatgpt', '{"kind":"mcp"}', 'single_op', 't', 'P1', 's', 'pending', ?, ?, ?)`,
    );
    for (let i = 0; i < 50; i++)
      insert.run(`prop_seed${i}`, agent.principal.principalId, now, now, now + 86_400_000);
    const before = r.h.mock.calls.length;
    const out = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId: doc.resourceId, documentId: doc.documentId }, body: { blocks: keepU1 } },
        { project: PROJECT, origin },
      ),
    );
    expect(out.error).toBeInstanceOf(PolicyDeniedError);
    expect((out.error as PolicyDeniedError).message).toMatch(/50 proposals waiting/);
    expect(r.h.mock.calls.length).toBe(before);
    // Another connection is not affected.
    const other = makePat(r.db, r.policy, 'claude', 'propose', () => r.h.clock.now(), 'claude');
    await propose(
      r,
      r.e.engine.run(
        'replaceDocumentBlocks',
        { path: { resourceId: doc.resourceId, documentId: doc.documentId }, body: { blocks: keepU1 } },
        { project: PROJECT, origin: mcpOriginFor(other.principal) },
      ),
    );
  });

  it('read scope is refused with a clear message; reads still work', async () => {
    const { r, origin } = await setup('read');
    const w = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'x' } },
        { project: PROJECT, origin },
      ),
    );
    expect(w.error).toBeInstanceOf(PolicyDeniedError);
    expect((w.error as Error).message).toContain('read-only');
    const rd = await settle(
      r.h,
      r.e,
      r.e.engine.run('getResource', { path: { resourceId: 'rbbbbbbb' } }, { project: PROJECT, origin }),
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
        { project: PROJECT, origin },
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
    expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toHaveLength(1); // no new proposal
    const p = r.policy.proposals.get(proposalId)!;
    expect(p).toMatchObject({ state: 'executed', decidedBy: 'owner' });
    const job = r.e.engine.queries.getJob(PROJECT, p.jobId!)!;
    expect(job).toMatchObject({
      kind: 'batch_ops',
      principalId: agent.patId,
      profile: 'chatgpt',
      approvedBy: 'owner',
      status: 'succeeded',
    });
    expect(job.origin).toMatchObject({ detail: `proposal:${proposalId}`, approval: { proposalId } });
    const journal = r.e.engine.queries.journalLookup(PROJECT, { jobId: p.jobId! });
    expect(journal[0]).toMatchObject({ principalId: agent.patId, profile: 'chatgpt', approvedBy: 'owner' });
    // The executed write was pinned to the captured version.
    expect(r.e.engine.queries.getJob(PROJECT, p.jobId!)!.steps[0]!.ifMatch).toBe('v1');

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
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'Z' } },
        { project: PROJECT, origin },
      ),
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
        project: PROJECT,
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
    expect(r.e.engine.queries.listJobs(PROJECT)).toEqual([]);
    const view = r.policy.proposals.agentView(p);
    expect(view.conflict).toMatchObject({ operation: 2, op: 'replaceDocumentBlocks' });
  });

  it('the unsupported-block guard applies again at execution; a partial failure ends failed with the job', async () => {
    const { r, doc, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.submit({
        project: PROJECT,
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
    const job = r.e.engine.queries.getJob(PROJECT, p.jobId!)!;
    expect(job.steps[1]!.error).toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS' });
  });

  it('is refused while read-only or while writes are paused; the proposal stays pending', async () => {
    const { r, origin } = await setup();
    const { proposalId } = await propose(
      r,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'R' } },
        { project: PROJECT, origin },
      ),
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
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'E' } },
        { project: PROJECT, origin },
      ),
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
              { project: PROJECT, origin },
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
    const [status] = proposalTools(r.policy.proposals, {
      selector: new ProjectSelector(r.e.projects, true),
    });
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
          { project: PROJECT, origin: { ...origin, ...extra } },
        ),
      );
      expect(out.error).toBeInstanceOf(PolicyDeniedError);
    }
    expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toEqual([]);
    expect(writesAtMock(r)).toEqual([]);
  });

  it("one proposal's token cannot execute another's operations, nor be reused", async () => {
    const { r, agent, origin } = await setup();
    const a = await propose(
      r,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'rbbbbbbb' }, body: { name: 'A' } },
        { project: PROJECT, origin },
      ),
    );
    const bParams = { path: { resourceId: 'raaaaaaa' }, body: { name: 'B' } };
    const b = await propose(r, r.e.engine.run('updateResource', bParams, { project: PROJECT, origin }));
    // Put A into the state the token is honoured in, as approve does.
    r.db.prepare(`UPDATE proposals SET state = 'approved' WHERE id = ?`).run(a.proposalId);
    const aParams = { path: { resourceId: 'rbbbbbbb' }, body: { name: 'A' } };
    const tokenA = issueApprovalToken(
      a.proposalId,
      agent.principal.principalId,
      PROJECT,
      [{ op: 'updateResource', paramsHash: hashJson(aParams) }],
      r.h.clock.now(),
    );
    const submitWith = (params: object, approval: unknown): BatchSubmit => ({
      kind: 'batch_ops',
      project: PROJECT,
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
    expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toHaveLength(2);
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
        { project: PROJECT, origin },
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
    expect(r.e.engine.queries.listJobs(PROJECT)).toHaveLength(1);
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
        { project: PROJECT, origin },
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
        r.e.engine.run('removeMember', { path: { userId: 'u1' } }, { project: PROJECT, origin: o }),
      );
      expect((out.error as { code?: string }).code).toBe('MEMBER_ADMIN_DISABLED');
    }
    expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toEqual([]);
    expect(writesAtMock(r)).toEqual([]);
  });
});
