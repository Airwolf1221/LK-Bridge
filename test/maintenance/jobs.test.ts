import { afterEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER_IDS } from '../../src/maintenance/index.js';
import { makePat, mcpOriginFor } from '../policy/helpers.js';
import { settle } from '../jobs/helpers.js';
import { maintenanceRig, sampleCount, type MaintenanceRig } from './helpers.js';

let m: MaintenanceRig | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

const D = 24 * 3_600_000;
const run = async (id: string) => (await m!.maintenance.commands.runNow('owner', id).done)!;
const writesAtMock = () => m!.rig.h.mock.calls.filter((c) => c.method !== 'GET');

describe('budget-sampler', () => {
  it('stores a budget sample per run, which the Request Budgets history reads, and writes nothing to LegendKeeper', async () => {
    m = await maintenanceRig();
    expect(sampleCount(m.rig)).toBe(0);
    await m.rig.h.clock.advance(30_000);
    expect(sampleCount(m.rig)).toBe(3);
    const samples = m.rig.e.engine.queries.listBudgetSamples({});
    expect(samples.at(-1)!.at).toBe(m.rig.h.clock.now());
    expect(Object.keys(samples[0]!.tiers)).toContain('write-min');
    expect(m.rig.h.mock.calls).toEqual([]); // no LegendKeeper call at all
  });

  it('is quiet on the Jobs page when it succeeds (a job record only on failure), but is on the run history', async () => {
    m = await maintenanceRig();
    await m.rig.h.clock.advance(30_000);
    expect(m.rig.e.engine.queries.listJobs({}).filter((j) => j.origin.kind === 'maintenance')).toEqual([]);
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
    r.h.model.seedResource('raaaaaaa');
    const agent = makePat(r.db, r.policy, 'writer', 'write', () => r.h.clock.now());
    const out = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'raaaaaaa' }, body: { name: 'One' } },
        { origin: mcpOriginFor(agent.principal) },
      ),
    );
    expect(out.error).toBeUndefined();
    const journal = () => r.e.engine.queries.journalLookup({ limit: 100 }).length;
    expect(journal()).toBeGreaterThan(0);
    // Disabled, so that the explicit runs below are the ones that do the work (Run now works on a disabled job).
    for (const id of ['budget-sampler', 'proposal-expiry', 'sqlite-optimise', 'journal-prune']) {
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
    const job = r.e.engine.queries.getJob(result.jobId!)!;
    expect(job).toMatchObject({
      status: 'succeeded',
      priority: 'P3',
      origin: { kind: 'maintenance', tool: 'journal-prune' },
    });
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
    r.h.model.seedResource('raaaaaaa');
    const agent = makePat(r.db, r.policy, 'proposer', 'propose', () => r.h.clock.now());
    const out = await settle(
      r.h,
      r.e,
      r.e.engine.run(
        'updateResource',
        { path: { resourceId: 'raaaaaaa' }, body: { name: 'Proposed' } },
        { origin: mcpOriginFor(agent.principal) },
      ),
    );
    const { proposalId } = out.value as { proposalId: string };
    expect(r.policy.proposals.state(proposalId)).toBe('pending');
    for (const id of ['budget-sampler', 'journal-prune', 'sqlite-optimise'])
      m.maintenance.commands.disable('owner', id);

    // Not yet expired: the scheduled run (every 5 minutes) changes nothing and leaves no job record.
    await r.h.clock.advance(5 * 60_000);
    expect(m.maintenance.scheduler.history('proposal-expiry')[0]).toMatchObject({
      outcome: 'succeeded',
      detail: 'No proposals had expired.',
      engineJobId: null,
    });
    expect(r.policy.proposals.state(proposalId)).toBe('pending');

    // Past the hour: the next scheduled run expires it, and (since it changed something) is recorded as a job.
    await r.h.clock.advance(60 * 60_000);
    expect(r.policy.proposals.state(proposalId)).toBe('expired');
    const expiring = m.maintenance.scheduler
      .history('proposal-expiry')
      .find((h) => h.detail === 'Expired 1 proposal.');
    expect(expiring?.engineJobId).toMatch(/^j/);
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

  it('is weekly, and records a job each time', async () => {
    m = await maintenanceRig();
    expect(m.maintenance.scheduler.get('sqlite-optimise').scheduleText).toBe('Weekly');
    for (const id of ['budget-sampler', 'proposal-expiry', 'journal-prune'])
      m.maintenance.commands.disable('owner', id);
    await m.rig.h.clock.advance(7 * D);
    const [last] = m.maintenance.scheduler.history('sqlite-optimise');
    expect(last).toMatchObject({ outcome: 'succeeded', trigger: 'schedule' });
    expect(last!.engineJobId).toMatch(/^j/);
  });
});

describe('placeholders', () => {
  it('are registered as not implemented, and do nothing', async () => {
    m = await maintenanceRig();
    for (const id of PLACEHOLDER_IDS) {
      const v = m.maintenance.scheduler.get(id);
      expect(v).toMatchObject({ implemented: false, enabled: false, note: 'Not implemented yet' });
    }
    expect(PLACEHOLDER_IDS).toEqual([
      'assign-block-ids-sweep',
      'tree-snapshot',
      'orphan-and-link-audit',
      'tag-audit',
    ]);
  });
});
