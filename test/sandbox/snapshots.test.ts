/**
 * v2 E1a (ADR 0042), opt-in, WRITES then cleans up: snapshots, restores and the rehearsal on the real sandbox project
 * (test/sandbox/snapshots.ts). On the server: `deploy/sandbox-test.sh --project test -- snapshots`. The same guard as the
 * other sandbox tests (a registered sandbox project, its own key). Its runtime, database and snapshot store live in their
 * own temporary directory, removed at the end.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { formatSnapshotsReport, runSnapshotsSandbox } from './snapshots.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: snapshots, restores and the rehearsal (writes, then cleans up)',
  () => {
    // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
    const steps = sandboxRun({ name: 'snapshots' });
    let runtime: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await runtime?.close();
      }
    }, steps.hookTimeoutMs);

    it('snapshots a throwaway subtree, restores every piece, probes the icon forms, rehearses, and cleans up', async () => {
      const target = resolveSandboxTarget(projectName);
      const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
        createSoakRuntime({
          apiKey: target.apiKey,
          project: target.name,
          ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
        }),
      );
      runtime = sandbox;
      const report = await runSnapshotsSandbox(
        {
          runtime: sandbox.runtime,
          db: sandbox.db,
          projectId: sandbox.projectId,
          counters: sandbox.counters,
        },
        { run: steps },
      );
      process.stdout.write(formatSnapshotsReport(report, sandbox.counters));
      const failed = report.findings.filter((f) => f.verdict === 'fail');
      expect(failed.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    }, 3_600_000);
  },
);
