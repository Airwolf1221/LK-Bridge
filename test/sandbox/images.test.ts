/**
 * v2 D3 (ADR 0041), opt-in, WRITES then cleans up: the image pipeline on the real sandbox project
 * (test/sandbox/images.ts). On the server: `deploy/sandbox-test.sh --project test -- images`. The same guard as the other
 * sandbox tests (a registered sandbox project, its own key). LKB_SANDBOX_IMAGE_URL names a stable public test image for
 * the URL source (skipped without it); the Caddy check posts to BRIDGE_PUBLIC_URL (from LKB_ENV_FILE, or LKB_PUBLIC_URL).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readEnvFileValues } from '../../src/db/migrate.js';
import { runImagesSandbox } from './images.js';
import { formatReport } from './smoke.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { cleanupAfterAll, sandboxRun } from './steps.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

function publicUrl(): string | null {
  if (process.env.LKB_PUBLIC_URL) return process.env.LKB_PUBLIC_URL;
  const file = process.env.LKB_ENV_FILE?.trim();
  if (!file) return process.env.BRIDGE_PUBLIC_URL ?? null;
  try {
    return readEnvFileValues(file, ['BRIDGE_PUBLIC_URL']).BRIDGE_PUBLIC_URL ?? null;
  } catch {
    return null;
  }
}

describe.skipIf(!projectName)('LegendKeeper sandbox: the image pipeline (writes, then cleans up)', () => {
  // R4.1: each step printed as it starts and finishes, with its own timeout; the clean-up again here, with its own.
  const steps = sandboxRun({ name: 'images' });
  let runtime: SoakRuntime | undefined;
  afterAll(async () => {
    try {
      await cleanupAfterAll(steps);
    } finally {
      await runtime?.close();
    }
  }, steps.hookTimeoutMs);

  it('uploads, verifies, stages, places, discards and cleans up', async () => {
    const target = resolveSandboxTarget(projectName);
    const sandbox = await steps.step('runtime', 'the sandbox runtime started', () =>
      createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      }),
    );
    runtime = sandbox;
    const findings = await runImagesSandbox(
      {
        runtime: sandbox.runtime,
        projectId: sandbox.projectId,
        counters: sandbox.counters,
        publicUrl: publicUrl(),
        imageUrl: process.env.LKB_SANDBOX_IMAGE_URL ?? null,
      },
      {},
      steps,
    );
    process.stdout.write(formatReport(findings).replace('sandbox smoke report', 'sandbox images report'));
    process.stdout.write(
      `Total: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes to LegendKeeper.\n`,
    );
    expect(findings.filter((f) => f.verdict === 'fail').map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  }, 1_800_000);
});
