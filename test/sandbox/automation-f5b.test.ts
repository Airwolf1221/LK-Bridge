/**
 * v3 F5b (ADR 0068), opt-in, WRITES then cleans up: the automation framework end to end on the real API, on the test
 * world (test/sandbox/automation-f5b.ts says what each step does). Written for the owner;
 * never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- automation-f5b
 *
 * Clean-up: the throwaway index deleted with everything under it, in the run's own `finally` and again in this file's
 * `afterAll` (its own timeout); the report names what must be deleted by hand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { formatAutomationReport, runAutomationCheck } from './automation-f5b.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: automatic actions for audits (F5b, A1–A6)', () => {
  const steps = sandboxRun({ name: 'automation-f5b' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('switches two codes to Apply, runs automation on two probe pages, verifies both fixes and their paragraphs, then switches them Off', async () => {
    const target = resolveSandboxTarget(projectName);
    const started = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    sb = started;
    const raw = rawLk({
      lk: started.lk,
      projectId: started.projectId,
      apiKey: target.apiKey,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    const items = await runAutomationCheck(started, raw, target.name, {
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      run: steps,
    });
    process.stdout.write(formatAutomationReport(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
