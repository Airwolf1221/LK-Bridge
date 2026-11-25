/**
 * v3 F10 (ADR 0078), opt-in, WRITES then cleans up: a row added directly to an age table, its change snapshot, the
 * delayed check (shortened here) and the automation's sync at Apply, on a THROWAWAY chronology (test/sandbox/
 * f10-chronology.ts says what each step does and prints). Written for the owner; never run by an agent or in CI. On the
 * server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f10-chronology
 *
 * Clean-up: the throwaway chronology and governance page, in the run's own `finally` and again in this file's `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import {
  F10_SANDBOX_DELAY_MS,
  formatChronologyRepairReport,
  runChronologyRepairCheck,
} from './f10-chronology.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: a direct table edit synced to the timeline by the bridge (F10, K0–K4)',
  () => {
    const steps = sandboxRun({ name: 'f10-chronology' });
    let sb: SoakRuntime | undefined;
    afterAll(async () => {
      try {
        await cleanupAfterAll(steps);
      } finally {
        await sb?.close();
      }
    }, steps.hookTimeoutMs);

    it('a row added with write_page gets its event from the delayed check and the automation, verified', async () => {
      const target = resolveSandboxTarget(projectName);
      const started = await steps.step('runtime', 'the sandbox runtime started', () =>
        createSoakRuntime({
          apiKey: target.apiKey,
          project: target.name,
          chronologyCheckDelayMs: F10_SANDBOX_DELAY_MS,
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
      const items = await runChronologyRepairCheck(started, raw, target.name, {
        bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
        run: steps,
      });
      process.stdout.write(formatChronologyRepairReport(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    }, 1_800_000);
  },
);
