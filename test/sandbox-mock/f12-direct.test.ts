/**
 * v3 F12 (ADR 0081; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f12-direct` sandbox
 * check (test/sandbox/f12-direct.ts, D0 to D5) against the faithful mock, through the same runtime and harness as the
 * owner's run: every item passes, and nothing it made is left behind.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatF12Report, runF12Check } from '../sandbox/f12-direct.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('f12-direct on the mock', () => {
  let w: RetagWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await retagWorld());
    // The upload host and the asset host on loopback (D4 uploads a tiny image, then Revert uploads it again).
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: ['assets.test'] });
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (D0 to D5); nothing it made is left', async () => {
    const items = await runF12Check(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatF12Report(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['D0 pass', 'D1 pass', 'D2 pass', 'D3 pass', 'D4 pass', 'D5 pass', 'cleanup pass']);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f12/.test(r.name)),
      report,
    ).toEqual([]);
  });
});
