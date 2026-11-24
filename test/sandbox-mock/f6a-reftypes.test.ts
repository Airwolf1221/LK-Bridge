/**
 * v3 F6a (ADR 0076; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f6a-reftypes`
 * sandbox check (test/sandbox/f6a-reftypes.ts, F0 to F6) against the faithful mock, through the same runtime and harness
 * as the owner's run: every item passes, the world's own governance is never written, and the throwaway index is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatRefTypesReport, runRefTypesCheck } from '../sandbox/f6a-reftypes.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('f6a-reftypes on the mock', () => {
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

  it('every item passes (F0 to F6); the world’s governance untouched; the throwaway index gone', async () => {
    const governance = w.stack.runtime.packs.get('arkona')!.governance;
    const before = governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null));
    const items = await runRefTypesCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatRefTypesReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['F0 pass', 'F1 pass', 'F2 pass', 'F3 pass', 'F4 pass', 'F5 pass', 'F6 pass']);
    expect(items.find((i) => i.id === 'F2')?.detail, report).toContain(
      'ROW value="Historical Cultural Reference" category=Culture count=1 status=open suggestion=Culture Reference',
    );
    expect(governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null))).toEqual(
      before,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f6a/.test(r.name)),
      report,
    ).toEqual([]);
  });
});
