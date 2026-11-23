/**
 * v3 F7 (ADR 0070; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f7-art` sandbox
 * check (test/sandbox/f7-art.ts, B0 to B3) against the faithful mock with its image hosts, through the same runtime as
 * the owner's run: every item passes or is NOTED, and nothing is left behind.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatArtReport, runArtCheck } from '../sandbox/f7-art.js';
import { imagesWorld, type ImagesWorld } from '../images/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, MOCK_LIMITS, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('f7-art on the mock', () => {
  let w: ImagesWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(
      await imagesWorld({ env: { LK_TIER_LIMITS: JSON.stringify(MOCK_LIMITS) }, limits: MOCK_LIMITS }),
    );
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: ['assets.test'] });
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (B0 to B2; the probe NOTED), and the throwaway folder and page are gone', async () => {
    const items = await runArtCheck(on.sb, on.raw, { wait: { waitMs: 2_000, maxWaits: 30 } });
    const report = formatArtReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.filter((i) => i.id === 'B3' && i.verdict === 'noted'),
      report,
    ).toHaveLength(8);
    expect(items.find((i) => /F7 PROBE image:/.test(i.detail))?.detail, report).toMatch(/title=/);
    expect(
      [...w.assets.assets.values()].filter((a) => /lk-bridge f7 check/.test(a.name)),
      report,
    ).toEqual([]);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f7 probe/.test(r.name)),
      report,
    ).toEqual([]);
  });
});
