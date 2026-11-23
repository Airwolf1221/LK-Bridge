/**
 * v3 F7 (ADR 0070), opt-in, WRITES then cleans up: guided art's folder layout on the real API (one outfit piece, then a
 * second: the folder made and the first piece moved in) and the titled-block probe for the verifier (G10), on the test
 * world (test/sandbox/f7-art.ts says what each step does). Written for the owner; never run by an agent or in CI. On the
 * server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-art
 *
 * Clean-up: the throwaway asset folder and page, in the run's own `finally` and again in this file's `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rawLk } from './f4b-probe.js';
import { formatArtReport, runArtCheck } from './f7-art.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: guided character art (F7, B0–B3)', () => {
  const steps = sandboxRun({ name: 'f7-art' });
  let sb: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await sb?.close();
    }
  }, steps.hookTimeoutMs);

  it('one outfit piece, then a second: the folder made and the first moved in; then the titled-block probe', async () => {
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
    const items = await runArtCheck(started, raw, { run: steps });
    process.stdout.write(formatArtReport(items));
    expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
  }, 1_800_000);
});
