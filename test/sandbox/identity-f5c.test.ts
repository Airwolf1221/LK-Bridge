/**
 * v3 F5c (ADR 0069), opt-in, WRITES then cleans up: `arkona_identity_reconcile`, `query_facts` and the workstream report
 * end to end on the real API, on the test world (test/sandbox/identity-f5c.ts says what each step does). Written for
 * the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- identity-f5c
 *
 * Clean-up: the throwaway index deleted with everything under it, in the run's own `finally` and again in this file's
 * `afterAll` (its own timeout); the report names what must be deleted by hand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { formatIdentityReport, runIdentityCheck } from './identity-f5c.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: identity reconcile, query_facts, workstreams (F5c, I1–I7)',
  () => {
    const steps = sandboxRun({ name: 'identity-f5c' });
    let sb: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await sb?.close();
      }
    }, steps.hookTimeoutMs);

    it('reconciles two throwaway characters (dry run, then for real), reads them back, queries them and reports the workstream', async () => {
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
      const items = await runIdentityCheck(started, raw, target.name, {
        bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
        run: steps,
      });
      process.stdout.write(formatIdentityReport(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    }, 1_800_000);
  },
);
