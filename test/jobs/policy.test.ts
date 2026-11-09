/** Principals and policy hooks: the PolicyGate at entry, PolicyDeniedError, the ProposalSink, approvedBy. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  PolicyDeniedError,
  SYSTEM_PRINCIPAL,
  type JobEngineEvents,
  type PolicyGate,
  type Principal,
  type ProposalSink,
  type ProposedOp,
} from '../../src/jobs/index.js';
import { harness, origin, queue, settle, type Harness, PROJECT } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const ada: Principal = { principalId: 'pat_ada', profile: 'editor', label: 'Ada (PAT)' };
const asAda = { ...origin, principal: ada };

/** A gate that records what it was asked and answers from a table (default allow). */
function gate(answers: Record<string, ReturnType<PolicyGate['authorize']>> = {}) {
  const asked: { principal: Principal; op: string; kind: string; stepIndex?: number }[] = [];
  /** Chunk 8: the engine also asks before each step of a queued job runs (`phase: 'execute'`). */
  const executed: { op: string; stepIndex?: number }[] = [];
  const g: PolicyGate = {
    authorize(principal, opMeta, _params, ctx) {
      if (ctx.phase === 'execute') {
        executed.push({
          op: opMeta.operationId,
          ...(ctx.stepIndex !== undefined ? { stepIndex: ctx.stepIndex } : {}),
        });
        return answers[opMeta.operationId] ?? { decision: 'allow' };
      }
      asked.push({
        principal,
        op: opMeta.operationId,
        kind: opMeta.kind,
        ...(ctx.stepIndex !== undefined ? { stepIndex: ctx.stepIndex } : {}),
      });
      return answers[opMeta.operationId] ?? { decision: 'allow' };
    },
  };
  return { g, asked, executed };
}

describe('default gate and principals', () => {
  it('behaves as before, and records the system principal by default', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    const r = await settle(
      h,
      e,
      e.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'x' } },
        { project: PROJECT, origin },
      ),
    );
    expect(r.value).toMatchObject({ status: 'succeeded' });
    const job = e.engine.queries.listJobs(PROJECT)[0]!;
    expect(job).toMatchObject({
      principalId: 'system',
      profile: 'system',
      approvedBy: null,
      origin: { principal: SYSTEM_PRINCIPAL },
    });
    expect(e.engine.queries.journalLookup(PROJECT)[0]).toMatchObject({
      principalId: 'system',
      profile: 'system',
      approvedBy: null,
    });
  });

  it('records principal and profile on jobs, errors and journal rows, with filters, events and approvedBy', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const e = h.newEngine();
    const stepEvents: JobEngineEvents['step'][] = [];
    e.engine.events.on('step', (ev) => stepEvents.push(ev));
    const jobEvents: JobEngineEvents['job'][] = [];
    e.engine.events.on('job', (ev) => jobEvents.push(ev));

    await settle(
      h,
      e,
      e.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'y' } },
        { project: PROJECT, origin: { ...asAda, approvedBy: 'owner' } },
      ),
    );
    await settle(
      h,
      e,
      e.engine.run('getResource', { path: { resourceId: 'missing' } }, { project: PROJECT, origin: asAda }),
    ); // a failed read
    await settle(
      h,
      e,
      e.engine.run('getResource', { path: { resourceId: 'missing2' } }, { project: PROJECT, origin }),
    );

    const [job] = e.engine.queries.listJobs(PROJECT, { principalId: 'pat_ada' });
    expect(job).toMatchObject({ principalId: 'pat_ada', profile: 'editor', approvedBy: 'owner' });
    expect(e.engine.queries.listJobs(PROJECT, { principalId: 'system' })).toHaveLength(0);
    expect(e.engine.queries.listJobs(PROJECT, { profile: 'editor' })).toHaveLength(1);

    const journal = e.engine.queries.journalLookup(PROJECT, { principalId: 'pat_ada' });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      opId: 'updateResource',
      principalId: 'pat_ada',
      profile: 'editor',
      approvedBy: 'owner',
    });
    expect(e.engine.queries.journalLookup(PROJECT, { principalId: 'system' })).toHaveLength(0);

    const adaErrors = e.engine.queries.listErrors(PROJECT, { principalId: 'pat_ada' });
    expect(adaErrors).toHaveLength(1);
    expect(adaErrors[0]).toMatchObject({ opId: 'getResource', principalId: 'pat_ada', profile: 'editor' });
    expect(e.engine.queries.listErrors(PROJECT, { principalId: 'system' })).toHaveLength(1);
    expect(e.engine.queries.listErrorGroups(PROJECT, { principalId: 'pat_ada' })[0]?.count).toBe(1);

    expect(stepEvents[0]).toMatchObject({ principalId: 'pat_ada', profile: 'editor' });
    expect(jobEvents.every((ev) => ev.job.principalId === 'pat_ada')).toBe(true);
  });
});

describe('policy gate', () => {
  it('is asked about every operation, reads included, before anything is queued', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const { g, asked } = gate();
    const e = h.newEngine({ policyGate: g });
    await settle(
      h,
      e,
      e.engine.run('getResource', { path: { resourceId: 'r1' } }, { project: PROJECT, origin: asAda }),
    );
    await queue(e.engine, { project: PROJECT, kind: 'paginate_all', origin: asAda, op: 'listResources' });
    await queue(e.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin: asAda,
      steps: [
        { op: 'getResource', params: { path: { resourceId: 'r1' } } },
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'z' } } },
      ],
    });
    expect(asked).toEqual([
      { principal: ada, op: 'getResource', kind: 'read' },
      { principal: ada, op: 'listResources', kind: 'read' },
      { principal: ada, op: 'getResource', kind: 'read', stepIndex: 0 },
      { principal: ada, op: 'updateResource', kind: 'write', stepIndex: 1 },
    ]);
  });

  it('is asked again before each step of a queued job runs (chunk 8, F-02)', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const { g, executed } = gate();
    const e = h.newEngine({ policyGate: g });
    const { jobId } = await queue(e.engine, {
      project: PROJECT,
      kind: 'batch_ops',
      origin: asAda,
      steps: [
        { op: 'getResource', params: { path: { resourceId: 'r1' } } },
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'z' } } },
      ],
    });
    await h.drive(e, () => e.engine.queries.getJob(PROJECT, jobId)?.status === 'succeeded');
    expect(executed).toEqual([
      { op: 'getResource', stepIndex: 0 },
      { op: 'updateResource', stepIndex: 1 },
    ]);
  });

  it('a deny throws PolicyDeniedError, records a `policy` error and queues nothing (reads included)', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const { g } = gate({
      getResource: { decision: 'deny', reason: 'not in your profile' },
      deleteResource: { decision: 'deny', reason: 'editors cannot delete' },
    });
    const e = h.newEngine({ policyGate: g });
    await expect(
      e.engine.run('getResource', { path: { resourceId: 'r1' } }, { project: PROJECT, origin: asAda }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    // One denied step denies the whole batch.
    const batch = e.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      origin: asAda,
      steps: [
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'a' } } },
        { op: 'deleteResource', params: { path: { resourceId: 'r1' } } },
      ],
    });
    await expect(batch).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      opId: 'deleteResource',
      stepIndex: 1,
      principalId: 'pat_ada',
    });
    expect(e.engine.queries.listJobs(PROJECT)).toHaveLength(0);
    expect(h.mock.calls).toHaveLength(0);
    const errors = e.engine.queries.listErrors(PROJECT);
    expect(errors).toHaveLength(2);
    for (const err of errors)
      expect(err).toMatchObject({
        classification: 'policy',
        code: 'POLICY_DENIED',
        principalId: 'pat_ada',
        profile: 'editor',
      });
    expect(errors.map((x) => x.opId).sort()).toEqual(['deleteResource', 'getResource']);
  });

  it('a gate that throws counts as a deny (fail closed)', async () => {
    h = await harness();
    const e = h.newEngine({
      policyGate: {
        authorize: () => {
          throw new Error('store unreachable');
        },
      },
    });
    await expect(e.engine.run('listTags', {}, { project: PROJECT, origin })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      reason: expect.stringContaining('store unreachable') as unknown,
    });
    expect(h.mock.calls).toHaveLength(0);
  });

  it('a propose hands the work to the proposal sink and queues nothing; a batch becomes one proposal', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const captured: { principal: Principal; ops: readonly ProposedOp[]; kind: string; title: string }[] = [];
    const sink: ProposalSink = {
      capture: (principal, ops, meta) => {
        captured.push({ principal, ops, kind: meta.kind, title: meta.title });
        return Promise.resolve({ proposalId: `prop_${captured.length}` });
      },
    };
    const { g } = gate({ deleteResource: { decision: 'propose' } });
    const e = h.newEngine({ policyGate: g, proposalSink: sink });

    const single = await e.engine.run(
      'deleteResource',
      { path: { resourceId: 'r1' } },
      { project: PROJECT, origin: asAda },
    );
    expect(single).toEqual({ status: 'proposal_captured', proposalId: 'prop_1' });

    const batch = await e.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      origin: asAda,
      title: 'tidy up',
      steps: [
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'a' } } },
        { op: 'deleteResource', params: { path: { resourceId: 'r1' } }, confirm: 'cascade' },
      ],
    });
    expect(batch).toEqual({ status: 'proposal_captured', proposalId: 'prop_2' });
    expect(captured[1]).toMatchObject({
      principal: ada,
      kind: 'batch_ops',
      title: 'tidy up',
      ops: [
        { op: 'updateResource', params: { body: { name: 'a' } } },
        { op: 'deleteResource', params: { path: { resourceId: 'r1' } }, confirm: 'cascade' },
      ],
    });
    expect(e.engine.queries.listJobs(PROJECT)).toHaveLength(0);
    expect(h.mock.calls).toHaveLength(0);
    expect(e.engine.queries.listErrors(PROJECT)).toHaveLength(0);
  });

  it('the default sink treats propose as deny', async () => {
    h = await harness();
    h.model.seedResource('r1');
    const { g } = gate({ updateResource: { decision: 'propose' } });
    const e = h.newEngine({ policyGate: g });
    await expect(
      e.engine.run(
        'updateResource',
        { path: { resourceId: 'r1' }, body: { name: 'q' } },
        { project: PROJECT, origin: asAda },
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(e.engine.queries.listJobs(PROJECT)).toHaveLength(0);
    expect(e.engine.queries.listErrors(PROJECT)[0]).toMatchObject({
      classification: 'policy',
      principalId: 'pat_ada',
    });
  });
});
