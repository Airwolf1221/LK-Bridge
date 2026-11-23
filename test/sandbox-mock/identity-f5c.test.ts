/**
 * v3 F5c (ADR 0069; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `identity-f5c`
 * sandbox check (`test/sandbox/identity-f5c.ts`, I1 to I7) run against the mock LegendKeeper, through the same runtime
 * and harness as the owner's run: every item must pass, nothing but the probe pages is written, and the throwaway index
 * is gone afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatIdentityReport, runIdentityCheck } from '../sandbox/identity-f5c.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('identity-f5c on the mock', () => {
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

  it('every item passes (I1 to I7), only the probe pages are written, and the throwaway index is gone', async () => {
    const before = new Map(
      [...w.repo.res.values()].map((r) => [r.id, JSON.stringify({ n: r.name, t: r.tags })]),
    );
    const items = await runIdentityCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatIdentityReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['I1 pass', 'I2 pass', 'I3 pass', 'I4 pass', 'I5 pass', 'I6 pass', 'I7 pass']);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f5c/.test(r.name)),
      report,
    ).toEqual([]);
    for (const r of w.repo.res.values())
      if (before.has(r.id) && r.deletedAt === null)
        expect(JSON.stringify({ n: r.name, t: r.tags }), r.id).toBe(before.get(r.id));
  });
});
