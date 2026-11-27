/**
 * v3 F6d (ADR 0082; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f6d-names` sandbox
 * check (test/sandbox/f6d-names.ts, N0 to N6) against the faithful mock, through the same runtime and harness as the
 * owner's run: every item passes, the world's own governance is never written, and the throwaway index is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatNamesReport, runNamesCheck } from '../sandbox/f6d-names.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('f6d-names on the mock', () => {
  let w: RetagWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await retagWorld({ bulk: 20 }));
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (N0 to N6); the world’s governance untouched; the throwaway index gone', async () => {
    const governance = w.stack.runtime.packs.get('arkona')!.governance;
    const before = governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null));
    const items = await runNamesCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatNamesReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['N0 pass', 'N1 pass', 'N2 pass', 'N3 pass', 'N4 pass', 'N5 pass', 'N6 pass']);
    expect(governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null))).toEqual(
      before,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f6d/.test(r.name)),
      report,
    ).toEqual([]);
  });
});
