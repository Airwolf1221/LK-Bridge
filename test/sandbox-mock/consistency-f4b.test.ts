/**
 * CR-2026-11-R4 (the owner's request S): the `consistency-f4b` sandbox check (`test/sandbox/consistency-f4b.ts`, F1 to
 * F6) run against the mock LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run
 * (`createSoakRuntime` pointed at the mock, `copyBridgeState` from the F4b world's database, the raw client of
 * `f4b-probe.ts`): every item must pass, and the throwaway index is gone afterwards. Its F2 reached the owner broken (a
 * governed create of a canon page, which the canon guard rightly refused); here it would have failed the build first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatConsistencyReport, runConsistencyCheck } from '../sandbox/consistency-f4b.js';
import { f4bWorld, type F4bWorld } from '../consistency/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('consistency-f4b on the mock', () => {
  let w: F4bWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await f4bWorld());
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (F1 to F6), and the throwaway index is gone afterwards', async () => {
    const items = await runConsistencyCheck(on.sb, on.raw, { bridgeDbPath: on.bridgeDbPath });
    const report = formatConsistencyReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['F1 pass', 'F2 pass', 'F3 pass', 'F4 pass', 'F5 pass', 'F6 pass']);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /^lk-bridge f4b /.test(r.name)),
      report,
    ).toEqual([]);
  });
});
