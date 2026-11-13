/**
 * v2 E1a: the snapshot sandbox script (test/sandbox/snapshots.ts) run against the mock (no real LegendKeeper): it sets up
 * its subtree, snapshots it, restores every piece it set up, undeletes and recreates a page, probes the icon forms, notes the
 * updatedAt fact, rehearses into its own root, and cleans everything up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newCounters } from '../sandbox/soak.js';
import { formatSnapshotsReport, runSnapshotsSandbox } from '../sandbox/snapshots.js';
import { PROJECT } from '../tools/helpers.js';
import { snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 300_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('the snapshot sandbox script (dry run against the mock)', () => {
  it('runs every check and leaves nothing behind', async () => {
    w = await snapshotsWorld();
    // The mock's own call log stands in for the transport's counters (every request it received).
    const calls = w.stack.mock.calls;
    const counters = Object.defineProperties(newCounters(), {
      reads: { get: () => calls.filter((c) => c.method === 'GET').length },
      writes: { get: () => calls.filter((c) => c.method !== 'GET').length },
    });
    const report = await runSnapshotsSandbox(
      { runtime: w.stack.runtime, db: w.stack.db, projectId: PROJECT, counters },
      { wait: { waitMs: 5_000, maxWaits: 30 } },
    );
    process.stdout.write(formatSnapshotsReport(report, counters));
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    for (const id of [
      'setup',
      'S',
      'R.page',
      'R.map',
      'R.time',
      'R.board',
      'R.sidebar',
      'D1',
      'D2',
      'H',
      'cleanup',
    ])
      expect(byId[id]?.verdict, `${id}: ${byId[id]?.detail}`).toBe('pass');
    // The updatedAt checks are gone: one NOTED fact stays for the record.
    expect(byId.U?.verdict).toBe('noted');
    for (const id of ['U.a', 'U.b', 'U.c', 'U.d', 'U.e']) expect(byId[id], id).toBeUndefined();
    // D2 reports which icon form LegendKeeper accepts (the mock takes the bare name and refuses the read form).
    expect(byId.D2?.detail).toMatch(/"fas fa-book" REFUSED/);
    expect(byId.D2?.detail).toMatch(/"book" ACCEPTED, which reads back as "fas fa-book"/);
    expect(byId.D2?.detail).toMatch(/its icon came back as it was/);
    // Nothing of the run is left: its root (and the rehearsal's) deleted, its image deleted.
    const live = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^lk-bridge (snapshots|rehearsal) /.test(r.name),
    );
    expect(live.map((r) => r.name)).toEqual([]);
  });
});
