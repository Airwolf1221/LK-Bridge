/**
 * CR-2026-11-R4, opt-in, WRITES then cleans up: what the fourth review's fixes assume of LegendKeeper (Z1–Z3; see
 * `assumptions-r5.ts`). Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r5
 */
import { describe, expect, it } from 'vitest';
import { formatAssumptionsR5Report, runAssumptionsR5 } from './assumptions-r5.js';
import { createSoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

describe.skipIf(!projectName)('LegendKeeper sandbox: what the fourth review’s fixes assume (Z1–Z3)', () => {
  it('confirms each assumption on the real API, and cleans up', async () => {
    // Refuses (throws) before any request unless the project is a registered sandbox with a key.
    const target = resolveSandboxTarget(projectName);
    const sb = await createSoakRuntime({
      apiKey: target.apiKey,
      project: target.name,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    try {
      const items = await runAssumptionsR5(sb);
      process.stdout.write(formatAssumptionsR5Report(items));
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    } finally {
      await sb.close();
    }
  }, 900_000);
});
