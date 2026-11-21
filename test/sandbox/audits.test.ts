/**
 * v2 E2 (ADR 0044), opt-in, WRITES then cleans up: the audits' assumptions on the real sandbox project
 * (test/sandbox/audits.ts). On the server: `deploy/sandbox-test.sh --project test -- audits`. The same guard as the other
 * sandbox tests (a registered sandbox project, its own key). Its runtime, database and snapshot store live in their own
 * temporary directory, removed at the end. WRITTEN, NOT RUN.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatAuditsReport, runAuditsSandbox } from './audits.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the audits (writes, then cleans up)', () => {
  // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
  const steps = sandboxRun({ name: 'audits' });
  let runtime: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await runtime?.close();
    }
  }, steps.hookTimeoutMs);

  it('snapshots a throwaway page, audits it, splits a paragraph through a proposal, and cleans up', async () => {
    const target = resolveSandboxTarget(projectName);
    const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    runtime = sandbox;
    const report = await runAuditsSandbox(
      {
        runtime: sandbox.runtime,
        db: sandbox.db,
        projectId: sandbox.projectId,
        counters: sandbox.counters,
      },
      { run: steps },
    );
    process.stdout.write(formatAuditsReport(report, sandbox.counters));
    const failed = report.findings.filter((f) => f.verdict === 'fail');
    expect(failed.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  }, 3_600_000);
});
