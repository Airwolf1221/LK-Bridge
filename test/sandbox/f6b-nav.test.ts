/**
 * v3 F6b (ADR 0079), opt-in, WRITES then cleans up: a race index, a character index and a source in a throwaway tree,
 * the classification report, the owner’s decisions, index_prefix and index_tags at Apply, T11’s order, read back live
 * (test/sandbox/f6b-nav.ts says what each step does and prints). Written for the owner; never run
 * by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6b-nav
 *
 * Clean-up: the throwaway index deleted with everything under it, in the run's own `finally` and again in this file's
 * `afterAll` (its own timeout); the report names what must be deleted by hand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatNavReport, runNavCheck } from './f6b-nav.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: navigation and subject indexes (F6b, N0–N7)', () => {
  const steps = sandboxRun({ name: 'f6b-nav' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('a race [NAV] with Navigation, a character [INDEX] with Character, ordered NAV, INDEX, source', async () => {
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
    const items = await runNavCheck(started, raw, target.name, {
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      run: steps,
    });
    process.stdout.write(formatNavReport(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
