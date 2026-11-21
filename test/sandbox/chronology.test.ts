/**
 * v2 D1 (ADR 0038), opt-in and READ-ONLY: the calendar engine and the chronology on the real test world, every age
 * (test/sandbox/chronology.ts). Runs with `npm run test:sandbox` when LKB_SANDBOX_PROJECT names the sandbox project (on
 * the server, `deploy/sandbox-test.sh --project test`); `npm run test:sandbox -- chronology` runs it alone. The same
 * guard as the other sandbox tests (a registered sandbox project, its own key). It writes nothing.
 *
 * Two date styles (v2 D1.1, ADR 0039): LegendKeeper writes a year with no thousands separator on events (`AA 1988119`);
 * the tables write one (`AA 1,988,119`). The report compares event text in LegendKeeper's style and table cells in the
 * table style, so the separator alone is never a failure (the owner's run of 11 November 2026 had 242 of those). Drift
 * between the tables and the timelines is reported under its own heading, apart from the engine's failures: the test
 * fails on the engine's and structure's failures only.
 *
 * The chronology resource is the one the owner confirmed on the dashboard (the bridge's stored settings), else
 * LKB_CHRONOLOGY_RESOURCE, else the test world's Universal Chronology (`h0gczxh7`, PLAN-v2 section 2)
 * (`chronologyResourceFor`). The ordinary suite runs the check against the mock in test/chronology/sandbox-dryrun.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chronologyResourceFor, runChronologySandbox } from './chronology.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: the calendar engine and the chronology (read-only)',
  () => {
    // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
    const steps = sandboxRun({ name: 'chronology' });
    let runtime: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await runtime?.close();
      }
    }, steps.hookTimeoutMs);

    it('reads every age table and timeline and checks them against the engine', async () => {
      const target = resolveSandboxTarget(projectName);
      const resourceId = chronologyResourceFor(process.env.DB_PATH ?? './data/bridge.db', target.projectId);
      const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
        createSoakRuntime({
          apiKey: target.apiKey,
          project: target.name,
          ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
        }),
      );
      runtime = sandbox;
      const report = await runChronologySandbox({
        run: steps,
        resourceId,
        read: (op, params) =>
          sandbox.runtime.engine.internalRead(sandbox.projectId, op, params, {
            priority: 'P2',
            notFoundIsAnswer: true,
          }),
      });
      process.stdout.write(`${report.text}\n`);
      process.stdout.write(
        `requests: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport)\n`,
      );
      process.stdout.write(
        `drift between the tables and the timelines: ${report.drift.length} finding${report.drift.length === 1 ? '' : 's'}\n`,
      );
      expect(sandbox.counters.writes).toBe(0);
      expect(report.failures, report.text).toEqual([]);
    }, 900_000);
  },
);
