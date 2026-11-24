/**
 * v3 F9 (ADR 0074), opt-in, WRITES then cleans up: a small full snapshot (P4) with a change snapshot requested mid-way,
 * on the real sandbox project (test/sandbox/bulk-f9.ts). On the server:
 * `sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- bulk-f9`. Its runtime, database and
 * snapshot store live in their own temporary directory, removed at the end.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatBulkReport, runBulkSandbox } from './bulk-f9.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the bulk class P4 (writes, then cleans up)', () => {
  const steps = sandboxRun({ name: 'bulk-f9' });
  let runtime: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await runtime?.close();
    }
  }, steps.hookTimeoutMs);

  it('a small full snapshot at P4, a change snapshot mid-way at its job’s class, both finished', async () => {
    const target = resolveSandboxTarget(projectName);
    const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    runtime = sandbox;
    const report = await runBulkSandbox(
      { runtime: sandbox.runtime, db: sandbox.db, projectId: sandbox.projectId, counters: sandbox.counters },
      { run: steps },
    );
    process.stdout.write(formatBulkReport(report, sandbox.counters));
    expect(report.findings.filter((f) => f.verdict === 'fail').map((f) => `${f.id}: ${f.detail}`)).toEqual(
      [],
    );
  }, 3_600_000);
});
