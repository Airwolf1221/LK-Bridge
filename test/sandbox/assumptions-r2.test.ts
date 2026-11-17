/**
 * Opt-in: round 2 of the assumptions about LegendKeeper (W1–W12: the asset library, table rows and nested blocks, event
 * pages), checked on a REAL sandbox project (test/sandbox/assumptions-r2.ts). Runs with `npm run test:sandbox` when
 * LKB_SANDBOX_PROJECT names the sandbox project (on the server, `deploy/sandbox-test.sh --project test`);
 * `npm run test:sandbox -- assumptions-r2` runs it alone (`-- assumptions.test` runs only round 1). Skipped otherwise.
 * The same guard as the smoke: it refuses to run unless the project is a registered sandbox and the key's own project is
 * exactly that one.
 *
 * It prints a report (PASS / FAIL / INCONCLUSIVE / NOTED with what LegendKeeper answered) and the run's cost, and fails
 * when a check FAILs or the clean-up does: every FAIL is a place where the bridge's code relies on LegendKeeper behaving
 * otherwise than it does. NOTED is a fact recorded, never a failure. Dry run against the mock:
 * test/tools/assumptions-r2-dryrun.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { formatAssumptionsR2Report, runAssumptionsR2 } from './assumptions-r2.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the newer code’s assumptions, round 2 (W1–W12)', () => {
  it('confirms each assumption on the real API, and cleans up', async () => {
    // Refuses (throws) before any request unless the project is a registered sandbox with a key.
    const target = resolveSandboxTarget(projectName);
    const sandbox = await createSoakRuntime({
      apiKey: target.apiKey,
      project: target.name,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    try {
      const tally = { downloads: 0, puts: 0 };
      const findings = await runAssumptionsR2(
        {
          engine: sandbox.runtime.engine,
          lk: sandbox.lk,
          projectId: sandbox.projectId,
          baseUrl: sandbox.runtime.config.lk.baseUrl,
          apiKey: target.apiKey,
        },
        target.projectId,
        { assetHosts: sandbox.runtime.images.settings.images.assetHosts, tally },
      );
      const report = formatAssumptionsR2Report(findings);
      process.stdout.write(report);
      process.stdout.write(
        `requests: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport); ` +
          `${tally.downloads} downloads from the asset host and ${tally.puts} PUT to the upload host (no API tier)\n`,
      );
      const failed = findings.filter((f) => f.verdict === 'fail');
      expect(
        failed.map((f) => `${f.id}: ${f.detail}`),
        report,
      ).toEqual([]);
    } finally {
      await sandbox.close();
    }
  }, 900_000);
});
