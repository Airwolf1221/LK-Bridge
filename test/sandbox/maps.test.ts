/**
 * v2 D2 (ADR 0040), opt-in: the map-feature layer on a REAL sandbox project (test/sandbox/maps.ts). It WRITES (a
 * throwaway page `lk-bridge maps <time>`, a second page to link to, two generated PNGs, features of every type) and
 * cleans up everything at the end, even after a failure. Runs with `npm run test:sandbox` when LKB_SANDBOX_PROJECT names
 * the sandbox project (on the server, `deploy/sandbox-test.sh --project test`); `npm run test:sandbox -- maps` runs it
 * alone (`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- maps`). The same guard as the other
 * sandbox tests (a registered sandbox project, its own key). It prints PASS, FAIL or INCONCLUSIVE per check, and the
 * requests it made, counted at the transport.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatMapsReport, runMapsSandbox } from './maps.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: the map-feature layer (writes, then cleans up)', () => {
  // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
  const steps = sandboxRun({ name: 'maps', cleanupTimeoutMs: 10 * 60_000 });
  let runtime: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await runtime?.close();
    }
  }, steps.hookTimeoutMs);

  it('creates a throwaway map, checks pixels, links, folders and a cascade against the real API, and cleans up', async () => {
    // Refuses (throws) before any request unless the project is a registered sandbox with a key.
    const target = resolveSandboxTarget(projectName);
    const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    runtime = sandbox;
    const started = Date.now();
    const { findings } = await runMapsSandbox(
      {
        engine: sandbox.runtime.engine,
        lk: sandbox.lk,
        projectId: sandbox.projectId,
        baseUrl: sandbox.runtime.config.lk.baseUrl,
        apiKey: target.apiKey,
      },
      target.projectId,
      { run: steps },
    );
    const report = formatMapsReport(findings);
    process.stdout.write(report);
    process.stdout.write(
      `cost: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport), ${Math.round((Date.now() - started) / 1000)} s\n`,
    );
    const failed = findings.filter((f) => f.verdict === 'fail');
    expect(
      failed.map((f) => `${f.id}: ${f.detail}`),
      report,
    ).toEqual([]);
  }, 1_200_000);
});
