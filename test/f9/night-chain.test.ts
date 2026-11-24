/**
 * v3 F9 (ADR 0074, B5): the jobs that use what the night's full snapshot produces chain on its completion, not on a
 * clock time. The audit already runs on the snapshot's completion (its `afterFull` hook); the 05:30 block-id sweep and
 * the 06:30 automation run were clock-only, so a scheduled run of either now waits for the project's chain (the full
 * snapshot, then the audit of it), bounded, and a manual run goes at once.
 */
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/lk/governor/clock.js';
import { afterNightChain, withWaitNote } from '../../src/maintenance/chain.js';
import { builtinJobs, nightChainBusy } from '../../src/maintenance/jobs.js';
import type { MaintenanceContext, MaintenanceJobDef, RunTrigger } from '../../src/maintenance/types.js';

const PROJECT = 'proj_test';

function jobsWith(state: { snapshot: boolean; audit: boolean }, clock: FakeClock, calls: string[]) {
  const jobs = builtinJobs({
    engine: {} as never,
    projects: { activeIds: () => [PROJECT], anyClient: () => undefined },
    db: {} as never,
    proposals: { expireDue: () => 0, pruneFinished: () => ({ removed: 0, cutoff: 0 }) },
    proposalRetentionMs: 1,
    expirySweepMs: 300_000,
    blockIds: {
      run: () => {
        calls.push(`block-ids at ${clock.now()}`);
        return Promise.resolve({ summary: 'Assigned 0.' });
      },
      canEnable: () => null,
      enabled: () => {},
    },
    automation: {
      run: () => {
        calls.push(`automation at ${clock.now()}`);
        return Promise.resolve({ summary: 'Nothing to do.' });
      },
    },
    chain: {
      busy: nightChainBusy(
        {
          full: () => Promise.resolve({ summary: '' }),
          prune: () => Promise.resolve({ removed: 0, gc: { removed: 0, freed: 0, kept: 0 } }),
          verify: () => Promise.resolve({ summary: '', missing: 0, corrupt: 0, badManifests: 0 }),
          fullInProgress: () => state.snapshot,
        },
        { run: () => Promise.resolve({ summary: '', changed: false }), running: () => state.audit },
      ),
      clock,
    },
  });
  return (id: string) => jobs.find((j) => j.id === id)!;
}

const ctx = (trigger: RunTrigger, now: number): MaintenanceContext => ({
  jobId: 'x',
  trigger,
  now,
  db: {} as never,
  project: { id: PROJECT, name: 'test' },
  run: () => Promise.reject(new Error('not used')),
});

async function runJob(job: MaintenanceJobDef, c: MaintenanceContext) {
  return job.run!(c);
}

describe('the night chain (B5)', () => {
  for (const id of ['assign-block-ids-sweep', 'automation-run']) {
    it(`${id}: a scheduled run waits for the full snapshot and then its audit, and says so`, async () => {
      const clock = new FakeClock();
      const t0 = clock.now();
      const state = { snapshot: true, audit: false };
      const calls: string[] = [];
      const job = jobsWith(state, clock, calls)(id);
      let result: { summary: string } | undefined;
      const p = runJob(job, ctx('schedule', t0)).then((r) => (result = r));
      await clock.advance(40 * 60_000); // the snapshot runs on past the job's time
      expect(calls).toEqual([]);
      state.snapshot = false;
      state.audit = true; // its audit starts as it completes
      await clock.advance(60_000);
      expect(calls).toEqual([]);
      state.audit = false;
      await clock.advance(30_000);
      await p;
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toBe(`${id === 'automation-run' ? 'automation' : 'block-ids'} at ${t0}`);
      expect(result!.summary).toMatch(/^Waited \d+ min \(the night’s full snapshot was still running\)\. /);
    });

    it(`${id}: a manual run goes at once, whatever is running`, async () => {
      const clock = new FakeClock();
      const calls: string[] = [];
      const job = jobsWith({ snapshot: true, audit: true }, clock, calls)(id);
      await runJob(job, ctx('manual', clock.now()));
      expect(calls).toHaveLength(1);
    });

    it(`${id}: with nothing running, a scheduled run goes at once (no note)`, async () => {
      const clock = new FakeClock();
      const calls: string[] = [];
      const job = jobsWith({ snapshot: false, audit: false }, clock, calls)(id);
      const r = await runJob(job, ctx('schedule', clock.now()));
      expect(calls).toHaveLength(1);
      expect(r.summary).not.toMatch(/Waited/);
    });
  }

  it('gives up after the longest wait: the run is skipped with the reason, never run against a half-taken snapshot', async () => {
    const clock = new FakeClock();
    const p = afterNightChain(() => 'the night’s full snapshot was still running', PROJECT, 'catch-up', {
      clock,
      pollMs: 60_000,
      maxWaitMs: 10 * 60_000,
    });
    await clock.advance(10 * 60_000);
    const r = await p;
    expect(r.go).toBe(false);
    if (!r.go) {
      expect(r.result.skipped).toBe(true);
      expect(r.result.summary).toMatch(/still running after 10 minutes/);
    }
  });

  it('a stop ends the wait as a skip', async () => {
    const clock = new FakeClock();
    const stop = new AbortController();
    const p = afterNightChain(() => 'busy', PROJECT, 'schedule', { clock, signal: stop.signal });
    stop.abort();
    const r = await p;
    expect(r).toMatchObject({ go: false, result: { skipped: true } });
  });

  it('withWaitNote leaves a short wait unsaid', () => {
    expect(withWaitNote({ summary: 'Done.' }, 500, 'x')).toEqual({ summary: 'Done.' });
    expect(withWaitNote({ summary: 'Done.' }, 30 * 60_000, 'x').summary).toBe('Waited 30 min (x). Done.');
  });
});
