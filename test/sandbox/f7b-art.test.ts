/**
 * v3 F7b (ADR 0071), opt-in, WRITES then cleans up: `arkona_get_art` on the real API and asset host, with each delivery
 * (test/sandbox/f7b-art.ts says what each step does and prints). Written for the owner; never run by an agent or in CI.
 * On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7b-art
 *
 * Clean-up: the throwaway asset folder and page, in the run's own `finally` and again in this file's `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatArtViewReport, runArtViewCheck } from './f7b-art.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: seeing character art (F7b, A0–A4)', () => {
  const steps = sandboxRun({ name: 'f7b-art' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('one image: its link, the image inline with its authority, then the cache hit', async () => {
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
    const items = await runArtViewCheck(started, raw, target.name, {
      bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
      run: steps,
    });
    process.stdout.write(formatArtViewReport(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
