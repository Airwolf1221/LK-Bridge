/**
 * v3 F6c (ADR 0080), opt-in, WRITES then cleans up: a throwaway territory and nation, the seed, the owner’s decisions,
 * the two renames and the two category indexes at Apply, read back live
 * (test/sandbox/f6c-territory.ts says what each step does and prints). Written for the owner; never run
 * by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6c-territory
 *
 * Clean-up: the throwaway index deleted with everything under it, in the run's own `finally` and again in this file's
 * `afterAll` (its own timeout); the report names what must be deleted by hand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatTerritoryReport, runTerritoryCheck } from './f6c-territory.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: territories, nations and their subindexes (F6c, T0–T5)',
  () => {
    const steps = sandboxRun({ name: 'f6c-territory' });
    let sb: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await sb?.close();
      }
    }, steps.hookTimeoutMs);

    it('the unified subindex names and the missing category indexes, bound', async () => {
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
      const items = await runTerritoryCheck(started, raw, target.name, {
        bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
        run: steps,
      });
      process.stdout.write(formatTerritoryReport(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    }, 1_800_000);
  },
);
