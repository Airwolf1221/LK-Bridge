/**
 * v3 F5b (ADR 0068; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `automation-f5b`
 * sandbox check (`test/sandbox/automation-f5b.ts`, A1 to A6) run against the mock LegendKeeper, through the same runtime
 * and harness as the owner's run: every item must pass, nothing but the probe pages is written, and the throwaway index
 * is gone afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatAutomationReport, runAutomationCheck } from '../sandbox/automation-f5b.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('automation-f5b on the mock', () => {
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

  it('every item passes (A1 to A6), only the probe pages are written, and the throwaway index is gone', async () => {
    const before = new Map(
      [...w.repo.res.values()].map((r) => [r.id, JSON.stringify({ n: r.name, t: r.tags })]),
    );
    const items = await runAutomationCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatAutomationReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['A1 pass', 'A2 pass', 'A3 pass', 'A4 pass', 'A5 pass', 'A6 pass']);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f5b/.test(r.name)),
      report,
    ).toEqual([]);
    // Nothing else of the test world was touched (its fixtures hold many findings the run must not act on).
    for (const r of w.repo.res.values())
      if (before.has(r.id) && r.deletedAt === null)
        expect(JSON.stringify({ n: r.name, t: r.tags }), r.id).toBe(before.get(r.id));
    expect(
      on.sb.runtime.snapshots.index
        .snapshots(on.sb.projectId, { kind: 'full', limit: 10 })
        .map((x) => x.pages),
    ).toEqual([0]);
  });
});
