/**
 * CR-2026-11, opt-in: the write layer's assumptions about LegendKeeper, checked on a REAL sandbox project
 * (test/sandbox/assumptions.ts; the list is docs/reviews/CR-2026-11.md, section 6). Runs with `npm run test:sandbox`
 * when LKB_SANDBOX_PROJECT names the sandbox project (on the server, `deploy/sandbox-test.sh --project test`), beside
 * the smoke script; `npm run test:sandbox -- assumptions` runs it alone. Skipped otherwise. The same guard as the smoke:
 * it refuses to run unless the project is a registered sandbox and the key's own project is exactly that one.
 *
 * It prints a report (PASS / FAIL / INCONCLUSIVE with what LegendKeeper answered) and fails when an assumption FAILs or
 * the clean-up does: every FAIL is a place where the bridge's behaviour on the real API differs from what the review
 * relied on, to be looked at before E5.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatAssumptionsReport, runAssumptions } from './assumptions.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the write layer’s assumptions (CR-2026-11)', () => {
  // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
  const steps = sandboxRun({ name: 'assumptions', cleanupTimeoutMs: 20 * 60_000 });
  let runtime: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await runtime?.close();
    }
  }, steps.hookTimeoutMs);

  it('confirms each assumption on the real API, and cleans up', async () => {
    // Refuses (throws) before any request unless the project is a registered sandbox with a key.
    const target = resolveSandboxTarget(projectName);
    const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    runtime = sandbox;
    const findings = await runAssumptions(
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
    const report = formatAssumptionsReport(findings);
    process.stdout.write(report);
    process.stdout.write(
      `requests: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport)\n`,
    );
    const failed = findings.filter((f) => f.verdict === 'fail');
    expect(
      failed.map((f) => `${f.id}: ${f.detail}`),
      report,
    ).toEqual([]);
  }, 900_000);
});
