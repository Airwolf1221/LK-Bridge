/**
 * v3 F5a (ADR 0067; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `tagging-f5a`
 * sandbox check (`test/sandbox/tagging-f5a.ts`, T1 to T6) run against the mock LegendKeeper, through the same runtime
 * and harness as the owner's run: every item must pass, and the throwaway index is gone afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatTaggingReport, runTaggingCheck } from '../sandbox/tagging-f5a.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('tagging-f5a on the mock', () => {
  let w: RetagWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await retagWorld());
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (T1 to T6), and the throwaway index is gone afterwards', async () => {
    const items = await runTaggingCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatTaggingReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['T1 pass', 'T2 pass', 'T3 pass', 'T4 pass', 'T5 pass', 'T6 pass']);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f5a/.test(r.name)),
      report,
    ).toEqual([]);
    // R4.1: no full snapshot of the test world: the temporary database's only full snapshot is the empty base.
    expect(
      on.sb.runtime.snapshots.index
        .snapshots(on.sb.projectId, { kind: 'full', limit: 10 })
        .map((x) => x.pages),
    ).toEqual([0]);
  });
});
