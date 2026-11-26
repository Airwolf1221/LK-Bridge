/**
 * v3 F12 (ADR 0081), opt-in, WRITES then cleans up: an agent at scope `write` makes canon and lifecycle changes and a
 * delete directly, each on the owner's Review page, and Revert brings the deletes back from their copies
 * (test/sandbox/f12-direct.ts says what each step does and prints). Written for the owner; never run by an agent or in
 * CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f12-direct
 *
 * Clean-up: the throwaway index deleted with everything under it and the throwaway asset folder, in the run's own
 * `finally` and again in this file's `afterAll` (its own timeout); the report names what must be deleted by hand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatF12Report, runF12Check } from './f12-direct.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: direct writes at scope write (F12, D0–D5)', () => {
  const steps = sandboxRun({ name: 'f12-direct' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('canon, lifecycle and deletes direct, on Review, and reverted', async () => {
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
    const items = await runF12Check(started, raw, target.name, {
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      run: steps,
    });
    process.stdout.write(formatF12Report(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
