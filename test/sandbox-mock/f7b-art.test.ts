/**
 * v3 F7b (ADR 0071; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f7b-art` sandbox
 * check (test/sandbox/f7b-art.ts, A0 to A4) against the faithful mock with its asset host, through the same runtime and
 * harness as the owner's run: every item passes, and the throwaway folder and page are gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatArtViewReport, runArtViewCheck } from '../sandbox/f7b-art.js';
import { ownersWorld, type OwnersWorld } from '../packs/owners-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('f7b-art on the mock', () => {
  let w: OwnersWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await ownersWorld());
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: ['assets.test'] });
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (A0 to A4), and the throwaway folder and page are gone', async () => {
    const items = await runArtViewCheck(on.sb, on.raw, 'test', {
      bridgeDbPath: on.bridgeDbPath,
      wait: { waitMs: 2_000, maxWaits: 30 },
    });
    const report = formatArtViewReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['A0 pass', 'A1 pass', 'A2 pass', 'A3 pass', 'A4 pass', 'cleanup pass']);
    expect(items.find((i) => i.id === 'A2')?.detail, report).toMatch(/^URL https:\/\/assets\.test/);
    expect(items.find((i) => i.id === 'A3')?.detail, report).toMatch(/inline block \d+ bytes/);
    expect(items.find((i) => i.id === 'A4')?.detail, report).toMatch(/cache hit: cached true/);
    expect(
      [...w.assets.assets.values()].filter((a) => /lk-bridge f7b check/.test(a.name)),
      report,
    ).toEqual([]);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f7b probe/.test(r.name)),
      report,
    ).toEqual([]);
  });
});
