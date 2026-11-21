/**
 * CR-2026-11-R4, opt-in, WRITES then cleans up: what the fourth review's fixes assume of LegendKeeper (Z1–Z3; see
 * `assumptions-r5.ts`). Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r5
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatAssumptionsR5Report, runAssumptionsR5 } from './assumptions-r5.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: what the fourth review’s fixes assume (Z1–Z3)', () => {
  // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
  const steps = sandboxRun({ name: 'assumptions-r5' });
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
    const sb = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    runtime = sb;
    const items = await runAssumptionsR5(sb, steps);
    process.stdout.write(formatAssumptionsR5Report(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 900_000);
});
