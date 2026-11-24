/**
 * v3 F7d (ADR 0077), opt-in, WRITES then cleans up: a character's whole art set in one call and one proposal
 * (test/sandbox/f7d-art-set.ts says what each step does and prints). Written
 * for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7d-art-set
 *
 * Clean-up: the throwaway character, its asset folder and the archive, in the run's own `finally` and again in this file's `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatArtSetReport, runArtSetCheck } from './f7d-art-set.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: one call, one proposal for a whole art set (F7d, D0–D4)',
  () => {
    const steps = sandboxRun({ name: 'f7d-art-set' });
    let sb: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await sb?.close();
      }
    }, steps.hookTimeoutMs);

    it('a compact character’s whole art set in one call: its Core, its folders, one Art page with its sidebar', async () => {
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
      const items = await runArtSetCheck(started, raw, target.name, {
        bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
        run: steps,
      });
      process.stdout.write(formatArtSetReport(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    }, 1_800_000);
  },
);
