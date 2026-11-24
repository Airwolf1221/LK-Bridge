/**
 * v3 F9 (ADR 0074): the `bulk-f9` sandbox check (`test/sandbox/bulk-f9.ts`) run against the mock LegendKeeper in the
 * ordinary suite, through the same runtime and harness as the owner's run (`createSoakRuntime` pointed at the faithful
 * mock, with the world's asset hosts, its own temporary database and snapshot store): every item must pass, and the
 * throwaway subtree is gone afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBulkReport, runBulkSandbox } from '../sandbox/bulk-f9.js';
import { snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000 });

let w: SnapshotsWorld | undefined;
let on: OnMock | undefined;
afterEach(async () => {
  await on?.close();
  await w?.close();
  on = undefined;
  w = undefined;
});

describe('bulk-f9 on the mock', () => {
  it('every item passes (B1 to B3), it prints both timelines, and it leaves nothing behind', async () => {
    w = makeFaithful(await snapshotsWorld());
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: w.assetHosts });
    const report = await runBulkSandbox(
      { runtime: on.sb.runtime, db: on.sb.db, projectId: on.sb.projectId, counters: on.sb.counters },
      { wait: { waitMs: 5_000, maxWaits: 30 } },
    );
    const text = formatBulkReport(report, on.sb.counters);
    process.stdout.write(text);
    expectEveryItemPasses(report.findings, text);
    expect(
      report.findings.map((f) => `${f.id} ${f.verdict}`),
      text,
    ).toEqual(['setup pass', 'B1 pass', 'B2 pass', 'B3 pass', 'cleanup pass']);
    expect(text).toMatch(/full snapshot +started .* classes P4/);
    expect(text).toMatch(/change snapshot started .* classes P[12]/);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /^lk-bridge bulk-f9 /.test(r.name)),
      text,
    ).toEqual([]);
  });
});
