/**
 * v3 F7.1 (ADR 0072), opt-in, WRITES then cleans up: a Compact Character Reference becomes the Character Core when its
 * character gains an index with several owners (test/sandbox/f7-1-core.ts says what each step does and prints). Written
 * for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-1-core
 *
 * Clean-up: the throwaway character and its asset folder, in the run's own `finally` and again in this file's `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatCoreUpgradeReport, runCoreUpgradeCheck } from './f7-1-core.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the Compact → Core upgrade (F7.1, C0–C3)', () => {
  const steps = sandboxRun({ name: 'f7-1-core' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('a compact character gains one art piece: its index, its Character Core and its Art page', async () => {
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
    const items = await runCoreUpgradeCheck(started, raw, target.name, {
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      run: steps,
    });
    process.stdout.write(formatCoreUpgradeReport(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
