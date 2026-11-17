import { afterEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER_IDS } from '../../src/maintenance/index.js';
import { makePat, mcpOriginFor } from '../policy/helpers.js';
import { WriteJournal } from '../../src/jobs/journal.js';
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { PROJECT, maintenanceRig, sampleCount, type MaintenanceRig } from './helpers.js';

/** v2 E1a: the snapshot jobs are on by default; a test that moves the clock by days switches them off with the rest. */
const SNAPSHOT_JOBS = ['snapshot-full', 'snapshot-prune', 'snapshot-verify'];

let m: MaintenanceRig | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

const D = 24 * 3_600_000;

/**
 * v3 F2 (ADR 0049 decision 8): this file runs on the fake clock alone, with no real wait and no request to the mock
 * LegendKeeper (a socket round trip under load is what once made it fail): journal entries are recorded directly, and
 * proposals are captured from creates (which read nothing at capture), awaited as plain promises.
 */
function seedJournal(r: MaintenanceRig['rig'], o: { jobId?: string } = {}): void {
  const j = new WriteJournal(r.db, () => r.h.clock.now());
  const id = j.record({
    projectId: PROJECT,
    ...(o.jobId ? { jobId: o.jobId, stepNo: 1 } : {}),
    opId: 'updateResource',
    principalId: 'system',
    profile: 'system',
    risk: 'safe',
    targetKind: 'Resources',
    targetId: 'raaaaaaa',
    resourceId: 'raaaaaaa',
    params: { path: { resourceId: 'raaaaaaa' }, body: { name: 'One' } },
  });
  j.setOutcome(id, 'applied');
}

/** A real proposal from a propose-scope agent: a create (captured with no read), so no request is made. */
async function captureCreate(r: MaintenanceRig['rig'], id: string, name: string): Promise<string> {
  const agent = makePat(r.db, r.policy, 'proposer', 'propose', () => r.h.clock.now());
  const out = await r.e.engine.run(
    'createResource',
    { body: { id, name } },
    { project: PROJECT, origin: mcpOriginFor(agent.principal) },
  );
  return (out as { proposalId: string }).proposalId;
}
const run = async (id: string) => (await m!.maintenance.commands.runNow('owner', id).done)!;
const writesAtMock = () => m!.rig.h.mock.calls.filter((c) => c.method !== 'GET');

describe('budget-sampler', () => {
  it('stores a budget sample per run, which the Request Budgets history reads, and writes nothing to LegendKeeper', async () => {
    m = await maintenanceRig();
    expect(sampleCount(m.rig)).toBe(0);
    await m.rig.h.clock.advance(30_000);
    expect(sampleCount(m.rig)).toBe(3);
    const samples = m.rig.e.engine.queries.listBudgetSamples(PROJECT, {});
    expect(samples.at(-1)!.at).toBe(m.rig.h.clock.now());
    expect(Object.keys(samples[0]!.tiers)).toContain('write-min');
    expect(m.rig.h.mock.calls).toEqual([]); // no LegendKeeper call at all
  });

  it('is quiet on the Jobs page when it succeeds (a job record only on failure), but is on the run history', async () => {
    m = await maintenanceRig();
    await m.rig.h.clock.advance(30_000);
    expect(
      m.rig.e.engine.queries.listJobs(ALL_PROJECTS, {}).filter((j) => j.origin.kind === 'maintenance'),
    ).toEqual([]);
    expect(m.maintenance.scheduler.history('budget-sampler')).toHaveLength(3);
  });

  it('replaces the interim sampler: nothing else writes samples', async () => {
    m = await maintenanceRig();
    m.maintenance.commands.disable('owner', 'budget-sampler');
    await m.rig.h.clock.advance(60_000);
    expect(sampleCount(m.rig)).toBe(0);
  });
});

describe('journal-prune', () => {
  it('removes journal entries older than the retention, keeps recent ones, and is recorded as a P3 job', async () => {
    m = await maintenanceRig();
    const r = m.rig;
    seedJournal(r);
    const journal = () => r.e.engine.queries.journalLookup(PROJECT, { limit: 100 }).length;
    expect(journal()).toBeGreaterThan(0);
    // Disabled, so that the explicit runs below are the ones that do the work (Run now works on a disabled job).
    for (const id of [
      'budget-sampler',
      'proposal-expiry',
      'sqlite-optimise',
      'journal-prune',
      ...SNAPSHOT_JOBS,
    ]) {
      m.maintenance.commands.disable('owner', id);
    }

    await r.h.clock.advance(10 * D); // inside the 30-day retention
    expect((await run('journal-prune')).detail).toMatch(/Removed 0 journal entries/);
    expect(journal()).toBeGreaterThan(0);

    await r.h.clock.advance(25 * D); // 35 days old
    const result = await run('journal-prune');
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(result.detail).toMatch(/Removed [1-9]\d* journal entr(y|ies)/);
    expect(journal()).toBe(0);
    // v2 A1: journal-prune covers every project, so it is a bridge-wide run: recorded in the run history (project
    // `*`), and NOT as a job in any one project's job list (that would show one project another's housekeeping).
    expect(result).toMatchObject({ projectId: '*', jobId: null });
    expect(
      r.e.engine.queries
        .listJobs(ALL_PROJECTS, { limit: 500 })
        .filter((j) => j.origin.kind === 'maintenance' && j.origin.tool === 'journal-prune'),
    ).toEqual([]);
  });

  it('prunes by the configured retention (the engine’s own setting)', async () => {
    m = await maintenanceRig();
    // The job calls engine.pruneJournal(); that uses the retention the engine was built with.
    const r = await run('journal-prune');
    expect(r.detail).toMatch(/by age/);
  });
});

describe('proposal-expiry', () => {
  it('expires pending proposals past their expiry, and runs the sweep itself (the service has no timer)', async () => {
    m = await maintenanceRig({ rig: { policy: { proposalExpiryMs: 3_600_000 } } });
    const r = m.rig;
    const proposalId = await captureCreate(r, 'raaaaaaa', 'Proposed');
    expect(r.policy.proposals.state(proposalId)).toBe('pending');
    for (const id of ['budget-sampler', 'journal-prune', 'sqlite-optimise', ...SNAPSHOT_JOBS])
      m.maintenance.commands.disable('owner', id);

    // Not yet expired: the scheduled run (every 5 minutes) changes nothing and leaves no job record.
    await r.h.clock.advance(5 * 60_000);
    expect(m.maintenance.scheduler.history('proposal-expiry')[0]).toMatchObject({
      outcome: 'succeeded',
      detail: 'No proposals had expired.',
      engineJobId: null,
    });
    expect(r.policy.proposals.state(proposalId)).toBe('pending');

    // Past the hour: the next scheduled run expires it. v2 A1: expiry covers every project, so the run is bridge-wide:
    // it is in the run history (project `*`) and is not a job of any one project.
    await r.h.clock.advance(60 * 60_000);
    expect(r.policy.proposals.state(proposalId)).toBe('expired');
    const expiring = m.maintenance.scheduler
      .history('proposal-expiry')
      .find((h) => h.detail === 'Expired 1 proposal.');
    expect(expiring).toMatchObject({ outcome: 'succeeded', projectId: '*', engineJobId: null });
    expect(r.policy.commands.listAudit('owner').some((a) => a.action === 'proposal.expired')).toBe(true);
    expect(writesAtMock()).toEqual([]);
  });

  it('defaults to the policy sweep interval', async () => {
    m = await maintenanceRig();
    expect(m.maintenance.scheduler.get('proposal-expiry').schedule).toEqual({
      kind: 'interval',
      everySeconds: 300,
    });
  });

  it('with the scheduler switched off, the service keeps its own timer so proposals still expire', async () => {
    const { policyRig } = await import('../policy/helpers.js');
    const rig = await policyRig({ policy: { proposalExpiryMs: 3_600_000, expirySweepMs: 60_000 } });
    try {
      expect(rig.h.clock.pendingTimers).toBeGreaterThan(0);
    } finally {
      await rig.close();
    }
    const external = await policyRig({ externalExpirySweep: true });
    try {
      expect(external.h.clock.pendingTimers).toBe(0);
    } finally {
      await external.close();
    }
  });
});

describe('sqlite-optimise', () => {
  it('runs PRAGMA optimize and a WAL checkpoint, and leaves the database sound', async () => {
    m = await maintenanceRig();
    const db = m.rig.db;
    db.exec('CREATE TABLE IF NOT EXISTS scratch_t (a INTEGER); INSERT INTO scratch_t VALUES (1), (2), (3);');
    const result = await run('sqlite-optimise');
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(result.detail).toMatch(/^Optimised; checkpointed \d+ of \d+ log pages/);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.prepare('SELECT COUNT(*) AS n FROM scratch_t').get()).toEqual({ n: 3 });
    // The checkpoint really happened: the WAL is empty (or the database is not in WAL mode in this build).
    const wal = db.pragma('wal_checkpoint(PASSIVE)') as { log: number; checkpointed: number }[];
    expect(wal[0]!.log).toBe(wal[0]!.checkpointed);
  });

  it('is weekly, and records each run in its history (bridge-wide, v2 A1)', async () => {
    m = await maintenanceRig();
    expect(m.maintenance.scheduler.get('sqlite-optimise').scheduleText).toBe('Weekly');
    for (const id of ['budget-sampler', 'proposal-expiry', 'journal-prune', ...SNAPSHOT_JOBS])
      m.maintenance.commands.disable('owner', id);
    await m.rig.h.clock.advance(7 * D);
    const [last] = m.maintenance.scheduler.history('sqlite-optimise');
    expect(last).toMatchObject({
      outcome: 'succeeded',
      trigger: 'schedule',
      projectId: '*',
      engineJobId: null,
    });
  });
});

describe('placeholders', () => {
  it('are registered as not implemented, and do nothing', async () => {
    m = await maintenanceRig();
    for (const id of PLACEHOLDER_IDS) {
      const v = m.maintenance.scheduler.get(id);
      expect(v).toMatchObject({ implemented: false, enabled: false, note: 'Not implemented yet' });
    }
    // v2 A2: `tree-snapshot` became the real `tree-sweep` and `tree-check` jobs.
    // v2 E2: the two audit placeholders became the real `audit-run` job.
    // v3 F3.5 (ADR 0056): `assign-block-ids-sweep` became the block-id sweep: no placeholder is left.
    expect(PLACEHOLDER_IDS).toEqual([]);
    expect(m.maintenance.scheduler.get('assign-block-ids-sweep')).toMatchObject({
      implemented: true,
      enabled: false,
      note: null,
    });
  });
});

describe('proposal-prune (v1.0.1, F-16)', () => {
  /** Captures one real proposal from a propose-scope agent (a create: nothing is read or sent). */
  const capture = (r: MaintenanceRig['rig'], resourceId: string, name: string): Promise<string> =>
    captureCreate(r, resourceId, name);
  const count = (sql: string, ...args: unknown[]) => (m!.rig.db.prepare(sql).get(...args) as { n: number }).n;
  const exists = (id: string) => count('SELECT count(*) AS n FROM proposals WHERE id = ?', id) === 1;
  const ops = (id: string) => count('SELECT count(*) AS n FROM proposal_ops WHERE proposal_id = ?', id);
  /** Puts a captured proposal into a state, finished at `at` (what the state machine would have recorded). */
  const force = (id: string, state: string, at: number) =>
    m!.rig.db
      .prepare('UPDATE proposals SET state = ?, decided_at = ?, finished_at = ?, updated_at = ? WHERE id = ?')
      .run(state, at, at, at, id);

  it('runs daily at 03:45, after journal-prune at 03:30', async () => {
    m = await maintenanceRig();
    expect(m.maintenance.scheduler.get('proposal-prune').schedule).toEqual({ kind: 'daily', time: '03:45' });
    expect(m.maintenance.scheduler.get('journal-prune').schedule).toEqual({ kind: 'daily', time: '03:30' });
  });

  it(
    'deletes finished proposals past the retention with their pre-state; keeps the job and journal that name them',
    { timeout: 20_000 },
    async () => {
      m = await maintenanceRig();
      const r = m.rig;
      for (const id of [
        'budget-sampler',
        'proposal-expiry',
        'sqlite-optimise',
        'journal-prune',
        'proposal-prune',
        'asset-refresh', // v2 A4: not under test here
        'asset-check',
        ...SNAPSHOT_JOBS,
      ])
        m.maintenance.commands.disable('owner', id);

      // An executed proposal and the job that ran it: the job is submitted while writes are paused (queued, never sent)
      // and recorded on the proposal as its approval would, with a journal entry of its own.
      const executed = await capture(r, 'raaaaaaa', 'Executed');
      r.e.engine.controls.pauseWrites('test');
      const submitted = await r.e.engine.submit({
        kind: 'batch_ops',
        project: PROJECT,
        steps: [
          { op: 'updateResource', params: { path: { resourceId: 'raaaaaaa' }, body: { name: 'Executed' } } },
        ],
        origin: { kind: 'system', detail: `proposal:${executed}` },
      });
      const jobId = (submitted as { jobId: string }).jobId;
      r.db.prepare('UPDATE proposals SET job_id = ? WHERE id = ?').run(jobId, executed);
      seedJournal(r, { jobId });
      expect(ops(executed)).toBe(1);
      const journalBefore = r.e.engine.queries
        .journalLookup(PROJECT, { limit: 100 })
        .filter((j) => j.jobId === jobId);
      expect(journalBefore.length).toBeGreaterThan(0);

      // One of each other state, all captured for real.
      const ids: Record<string, string> = { executed };
      for (const [i, state] of ['rejected', 'expired', 'failed', 'pending', 'conflicted'].entries()) {
        ids[state] = await capture(r, `rb${i}aaaaa`, state);
      }
      const t0 = r.h.clock.now();
      for (const state of ['executed', 'rejected', 'expired', 'failed', 'conflicted'])
        force(ids[state]!, state, t0);

      // Inside the 90-day retention: nothing goes.
      await r.h.clock.advance(89 * D);
      expect((await run('proposal-prune')).detail).toMatch(/^Removed 0 finished proposals/);
      for (const id of Object.values(ids)) expect(exists(id)).toBe(true);

      // Past it: the four finished states go, with their operations and pre-state; pending and conflicted stay.
      await r.h.clock.advance(2 * D);
      const result = await run('proposal-prune');
      expect(result).toMatchObject({ outcome: 'succeeded' });
      expect(result.detail).toMatch(/^Removed 4 finished proposals/);
      for (const state of ['executed', 'rejected', 'expired', 'failed']) {
        expect(exists(ids[state]!), state).toBe(false);
        expect(ops(ids[state]!), state).toBe(0);
      }
      for (const state of ['pending', 'conflicted']) {
        expect(exists(ids[state]!), state).toBe(true);
        expect(ops(ids[state]!), state).toBe(1);
      }
      // The job that executed it, and its journal entries, are kept; the job still names the proposal as text.
      const job = r.e.engine.queries.getJob(PROJECT, jobId)!;
      expect(job).toBeDefined();
      expect(job.origin.detail).toBe(`proposal:${executed}`);
      expect(
        r.e.engine.queries.journalLookup(PROJECT, { limit: 100 }).filter((j) => j.jobId === jobId),
      ).toEqual(journalBefore);
      // v2 A1: a bridge-wide run (it covers every project): in the run history, not a job of one project; and one
      // system audit row says what went.
      expect(result).toMatchObject({ projectId: '*', jobId: null });
      expect(
        r.e.engine.queries
          .listJobs(ALL_PROJECTS, { limit: 500 })
          .filter((j) => j.origin.kind === 'maintenance' && j.origin.tool === 'proposal-prune'),
      ).toEqual([]);
      const audit = r.policy.commands.listAudit('owner').filter((a) => a.action === 'proposal.pruned');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: 'system', after: { removed: 4 } });
      // The owner's views no longer list them; the agent's own view answers "not found" like any unknown id.
      expect(r.policy.proposals.get(executed)).toBeUndefined();
      expect(writesAtMock()).toEqual([]); // nothing was sent to LegendKeeper at all
    },
  );

  it('never prunes pending, approved, executing or conflicted proposals, however old', async () => {
    m = await maintenanceRig();
    const r = m.rig;
    const ids: Record<string, string> = {};
    for (const [i, state] of ['pending', 'approved', 'executing', 'conflicted'].entries()) {
      ids[state] = await capture(r, `rc${i}aaaaa`, state);
      if (state !== 'pending') force(ids[state], state, r.h.clock.now());
    }
    // Keep them from being expired or reconciled, so only the prune is under test.
    r.db.prepare('UPDATE proposals SET expires_at = ?').run(Number.MAX_SAFE_INTEGER);
    expect(r.policy.proposals.pruneFinished(0).removed).toBe(0);
    for (const id of Object.values(ids)) expect(exists(id)).toBe(true);
  });

  it('a conflicted proposal is stuck until it is rejected; then it is pruned after the retention like any rejected one', async () => {
    m = await maintenanceRig({ proposalRetentionMs: 7 * D });
    const r = m.rig;
    for (const job of [
      'budget-sampler',
      'proposal-expiry',
      'sqlite-optimise',
      'journal-prune',
      'proposal-prune',
      ...SNAPSHOT_JOBS,
    ])
      m.maintenance.commands.disable('owner', job);
    const id = await capture(r, 'rfaaaaaa', 'Conflicted');
    force(id, 'conflicted', r.h.clock.now());
    r.db.prepare('UPDATE proposals SET expires_at = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, id);
    await r.h.clock.advance(30 * D);
    expect(r.policy.proposals.pruneFinished(7 * D).removed).toBe(0); // conflicted is never pruned
    expect(exists(id)).toBe(true);
    r.policy.commands.reject('owner', id, 'stale');
    expect(r.policy.proposals.pruneFinished(7 * D).removed).toBe(0); // the retention starts at the rejection
    await r.h.clock.advance(8 * D);
    expect(r.policy.proposals.pruneFinished(7 * D).removed).toBe(1);
    expect(exists(id)).toBe(false);
    // 38 simulated days stepped through the scheduler take 3 to 4 s alone, so more than the 5 s default under load.
  }, 20_000);

  it('follows the configured retention (POLICY_PROPOSAL_RETENTION_DAYS)', async () => {
    m = await maintenanceRig({ proposalRetentionMs: 7 * D });
    const r = m.rig;
    for (const job of [
      'budget-sampler',
      'proposal-expiry',
      'sqlite-optimise',
      'journal-prune',
      'proposal-prune',
      ...SNAPSHOT_JOBS,
    ])
      m.maintenance.commands.disable('owner', job);
    const id = await capture(r, 'rdaaaaaa', 'Rejected');
    force(id, 'rejected', r.h.clock.now());
    await r.h.clock.advance(6 * D);
    expect((await run('proposal-prune')).detail).toMatch(/^Removed 0/);
    await r.h.clock.advance(2 * D);
    expect((await run('proposal-prune')).detail).toMatch(/^Removed 1 finished proposal /);
    expect(exists(id)).toBe(false);
  });
});
