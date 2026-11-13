/**
 * v2 E1a (ADR 0042), opt-in, WRITES then cleans up: snapshots, restores and the rehearsal on the real sandbox project
 * (test/sandbox/snapshots.ts). On the server: `deploy/sandbox-test.sh --project test -- snapshots`. The same guard as the
 * other sandbox tests (a registered sandbox project, its own key). Its runtime, database and snapshot store live in their
 * own temporary directory, removed at the end.
 */
import { describe, expect, it } from 'vitest';
import { createSoakRuntime } from './soak.js';
import { formatSnapshotsReport, runSnapshotsSandbox } from './snapshots.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: snapshots, restores and the rehearsal (writes, then cleans up)',
  () => {
    it('snapshots a throwaway subtree, restores every piece, checks updatedAt, rehearses, and cleans up', async () => {
      const target = resolveSandboxTarget(projectName);
      const sandbox = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const report = await runSnapshotsSandbox({
          runtime: sandbox.runtime,
          db: sandbox.db,
          projectId: sandbox.projectId,
          counters: sandbox.counters,
        });
        process.stdout.write(formatSnapshotsReport(report, sandbox.counters));
        // The updatedAt checks report what LegendKeeper does (they decide the daily pass); the rest must hold.
        const failed = report.findings.filter((f) => f.verdict === 'fail' && !f.id.startsWith('U.'));
        expect(failed.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
      } finally {
        await sandbox.close();
      }
    }, 3_600_000);
  },
);
