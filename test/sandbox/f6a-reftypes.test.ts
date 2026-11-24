/**
 * v3 F6a (ADR 0076), opt-in, WRITES then cleans up: three throwaway pages with variant Reference Types, the report, one
 * mapping, the noncanonical fix through its job, the page read back live, and the vocabulary published to a THROWAWAY
 * governance page (test/sandbox/f6a-reftypes.ts says what each step does and prints). Written for the owner; never run
 * by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6a-reftypes
 *
 * Clean-up: the throwaway index deleted with everything under it, in the run's own `finally` and again in this file's
 * `afterAll` (its own timeout); the report names what must be deleted by hand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatRefTypesReport, runRefTypesCheck } from './f6a-reftypes.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: Reference Types, a mapping and its fix (F6a, F0–F6)',
  () => {
    const steps = sandboxRun({ name: 'f6a-reftypes' });
    let sb: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await sb?.close();
      }
    }, steps.hookTimeoutMs);

    it('reports three variants, maps one, applies the fix and reads it back, publishes to a throwaway page', async () => {
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
      const items = await runRefTypesCheck(started, raw, target.name, {
        bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
        run: steps,
      });
      process.stdout.write(formatRefTypesReport(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    }, 1_800_000);
  },
);
