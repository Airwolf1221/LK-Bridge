/**
 * The concurrency sandbox script's own logic (test/sandbox/concurrency.ts), dry-run against the mock LegendKeeper: the
 * guard, the set-up, the three checks and the clean-up. The mock answers one request at a time, so it behaves as an
 * atomic compare-and-swap (C1 and C2 PASS); the real API is what the owner's run records.
 *
 * CR-2026-11-R4 (the owner's request S): through the same runtime and harness as the owner's run (`createSoakRuntime`
 * pointed at the faithful mock, test/sandbox-mock/harness.ts), and every item must pass: a FAIL, or anything but PASS or
 * NOTED, fails the build with the whole report printed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatConcurrencyReport, runConcurrencySandbox } from '../sandbox/concurrency.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { pagesWorld, type PagesWorld } from '../pages/world.js';
import { makeFaithful } from '../sandbox-mock/faithful.js';
import { expectEveryItemPasses, MOCK_LIMITS, sandboxOnMock, type OnMock } from '../sandbox-mock/harness.js';
import { API_KEY, PROJECT } from '../tools/helpers.js';

let w: PagesWorld;
let on: OnMock;
beforeAll(async () => {
  w = makeFaithful(
    await pagesWorld({ env: { LK_TIER_LIMITS: JSON.stringify(MOCK_LIMITS) }, limits: MOCK_LIMITS }),
  );
  on = await sandboxOnMock(w.stack);
}, 60_000);
afterAll(async () => {
  await on?.close();
  await w?.close();
});

// The real run's target (test/sandbox/concurrency.test.ts): the sandbox runtime's engine, client and key.
const target = () => ({
  engine: on.sb.runtime.engine,
  lk: on.sb.lk,
  projectId: on.sb.projectId,
  baseUrl: on.sb.runtime.config.lk.baseUrl,
  apiKey: API_KEY,
});

describe('the concurrency sandbox script (dry run against the mock)', () => {
  it('refuses another project before writing anything', async () => {
    const before = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    await expect(runConcurrencySandbox(target(), 'proj_somebody_else')).rejects.toBeInstanceOf(
      SandboxGuardError,
    );
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
  });

  it('every item passes (set-up, C1 to C3, the clean-up), and its page is gone afterwards', async () => {
    const { findings } = await runConcurrencySandbox(target(), PROJECT, { sleep: () => Promise.resolve() });
    const report = formatConcurrencyReport(findings);
    expectEveryItemPasses(findings, report);
    const by = Object.fromEntries(findings.map((f) => [f.id, f]));
    for (const id of ['setup', 'C1', 'C2', 'C3', 'cleanup'])
      expect(by[id]?.verdict, `${id}: ${by[id]?.detail}\n${report}`).toBe('pass');
    const left = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^lk-bridge concurrency /.test(r.name),
    );
    expect(left, report).toEqual([]);
  });
});
