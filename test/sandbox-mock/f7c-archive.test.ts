/**
 * v3 F7c (ADR 0075; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f7c-archive`
 * sandbox check (test/sandbox/f7c-archive.ts, C0 to C4) against the faithful mock with its image hosts, through the same
 * runtime as the owner's run: every item passes or is NOTED, and nothing is left behind.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatArchiveReport, runArchiveCheck } from '../sandbox/f7c-archive.js';
import { imagesWorld, type ImagesWorld } from '../images/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, MOCK_LIMITS, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('f7c-archive on the mock', () => {
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

  it('every item passes (C0 to C4; the rows and the placement NOTED), and nothing is left behind', async () => {
    const items = await runArchiveCheck(on.sb, on.raw, { wait: { waitMs: 2_000, maxWaits: 30 } });
    const report = formatArchiveReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.filter((i) => /^F7C ROW /.test(i.detail)),
      report,
    ).toHaveLength(3);
    expect(items.find((i) => /^F7C PLACED /.test(i.detail))?.detail, report).toMatch(
      /storedBytesVerified=true/,
    );
    expect(
      [...w.assets.assets.values()].filter((a) => /lk-bridge f7c check/.test(a.name)),
      report,
    ).toEqual([]);
  });
});
