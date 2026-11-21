/**
 * v2 E4 (PLAN-v2 10.6 test 2), opt-in: simultaneous same-version writes sent straight to LegendKeeper (through the
 * governor's raw client, bypassing the bridge's locks) on a throwaway page, to RECORD LegendKeeper's real behaviour
 * (test/sandbox/concurrency.ts). It WRITES (one throwaway page, about 14 writes) and deletes everything at the end, even
 * after a failure. Runs with `npm run test:sandbox` when LKB_SANDBOX_PROJECT names the sandbox project (on the server,
 * `deploy/sandbox-test.sh --project test`); `npm run test:sandbox -- concurrency` runs it alone. The same guard as the
 * other sandbox tests. Its own runtime sends writes with no spacing (WRITE_SPACING_MS 0), so the racing writes really
 * leave together; NOTED (LegendKeeper accepted more than one) is a fact to report, not a failure.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatConcurrencyReport, runConcurrencySandbox } from './concurrency.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: simultaneous same-version writes (writes, then cleans up)',
  () => {
    // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
    const steps = sandboxRun({ name: 'concurrency' });
    let runtime: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await runtime?.close();
      }
    }, steps.hookTimeoutMs);

    it('records whether LegendKeeper accepts two writes with one If-Match, and deletes its page', async () => {
      const target = resolveSandboxTarget(projectName);
      const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
        createSoakRuntime({
          apiKey: target.apiKey,
          project: target.name,
          env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0' },
          ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
        }),
      );
      runtime = sandbox;
      const started = Date.now();
      const { findings } = await runConcurrencySandbox(
        {
          engine: sandbox.runtime.engine,
          lk: sandbox.lk,
          projectId: sandbox.projectId,
          baseUrl: sandbox.runtime.config.lk.baseUrl,
          apiKey: target.apiKey,
        },
        target.projectId,
        { run: steps },
      );
      const report = formatConcurrencyReport(findings);
      process.stdout.write(report);
      process.stdout.write(
        `cost: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport), ${Math.round((Date.now() - started) / 1000)} s\n`,
      );
      expect(
        findings.filter((f) => f.verdict === 'fail').map((f) => `${f.id}: ${f.detail}`),
        report,
      ).toEqual([]);
    }, 600_000);
  },
);
