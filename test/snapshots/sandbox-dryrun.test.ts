/**
 * v2 E1a: the snapshot sandbox script (test/sandbox/snapshots.ts) run against the mock (no real LegendKeeper): it sets up
 * its subtree, snapshots it, restores every piece it set up, undeletes and recreates a page, probes the icon forms, notes the
 * updatedAt fact, rehearses into its own root, and cleans everything up.
 *
 * CR-2026-11-R4 (the owner's request S): through the same runtime and harness as the owner's run (`createSoakRuntime`
 * pointed at the faithful mock, with the world's asset and upload hosts: test/sandbox-mock/hosts.ts; its own temporary
 * database and snapshot store), and every item must pass: a FAIL or an INCONCLUSIVE fails the build with the whole
 * report printed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSnapshotsReport, runSnapshotsSandbox } from '../sandbox/snapshots.js';
import { makeFaithful } from '../sandbox-mock/faithful.js';
import { expectEveryItemPasses, type OnMock } from '../sandbox-mock/harness.js';
import { sandboxOnMockWithHosts } from '../sandbox-mock/hosts.js';
import { snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 300_000 });

let w: SnapshotsWorld | undefined;
let on: OnMock | undefined;
afterEach(async () => {
  await on?.close();
  await w?.close();
  on = undefined;
  w = undefined;
});

describe('the snapshot sandbox script (dry run against the mock)', () => {
  it('every item passes (U noted), and it leaves nothing behind', async () => {
    w = makeFaithful(await snapshotsWorld());
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: w.assetHosts });
    // The real run's target (test/sandbox/snapshots.test.ts): the sandbox runtime, its database and its counters.
    const report = await runSnapshotsSandbox(
      { runtime: on.sb.runtime, db: on.sb.db, projectId: on.sb.projectId, counters: on.sb.counters },
      { wait: { waitMs: 5_000, maxWaits: 30 } },
    );
    const text = formatSnapshotsReport(report, on.sb.counters);
    expectEveryItemPasses(report.findings, text);
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
      expect(byId[id]?.verdict, `${id}: ${byId[id]?.detail}\n${text}`).toBe('pass');
    // The updatedAt checks are gone: one NOTED fact stays for the record.
    expect(byId.U?.verdict, text).toBe('noted');
    for (const id of ['U.a', 'U.b', 'U.c', 'U.d', 'U.e']) expect(byId[id], id).toBeUndefined();
    // D2 reports which icon form LegendKeeper accepts (the mock takes the bare name and refuses the read form).
    expect(byId.D2?.detail).toMatch(/"fas fa-book" REFUSED/);
    expect(byId.D2?.detail).toMatch(/"book" ACCEPTED, which reads back as "fas fa-book"/);
    expect(byId.D2?.detail).toMatch(/its icon came back as it was/);
    // Nothing of the run is left: its root (and the rehearsal's) deleted, its image deleted.
    const live = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^lk-bridge (snapshots|rehearsal) /.test(r.name),
    );
    expect(
      live.map((r) => r.name),
      text,
    ).toEqual([]);
  });
});
