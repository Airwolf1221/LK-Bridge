/**
 * v3 F6c (ADR 0080; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f6c-territory`
 * sandbox check (test/sandbox/f6c-territory.ts, T0 to T5) against the faithful mock, through the same runtime and
 * harness as the owner's run: every item passes, the world's own governance is never written, and the throwaway index
 * is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatTerritoryReport, runTerritoryCheck } from '../sandbox/f6c-territory.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('f6c-territory on the mock', () => {
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

  it('every item passes (T0 to T5); the world’s governance untouched; the throwaway index gone', async () => {
    const governance = w.stack.runtime.packs.get('arkona')!.governance;
    const before = governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null));
    const items = await runTerritoryCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatTerritoryReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['T0 pass', 'T1 pass', 'T2 pass', 'T3 pass', 'T4 pass', 'T5 pass']);
    expect(items.find((i) => i.id === 'T5')?.detail, report).toMatch(/Military & Technology/);
    expect(governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null))).toEqual(
      before,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f6c/.test(r.name)),
      report,
    ).toEqual([]);
  });
});
