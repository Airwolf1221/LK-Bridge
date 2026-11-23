/**
 * v3 F7.1 (ADR 0072; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f7-1-core`
 * sandbox check (test/sandbox/f7-1-core.ts, C0 to C3) against the faithful mock with its asset host, through the same
 * runtime and harness as the owner's run: every item passes, and the throwaway character is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatCoreUpgradeReport, runCoreUpgradeCheck } from '../sandbox/f7-1-core.js';
import { ownersWorld, type OwnersWorld } from '../packs/owners-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('f7-1-core on the mock', () => {
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

  it('every item passes (C0 to C3), and the throwaway character is gone', async () => {
    const items = await runCoreUpgradeCheck(on.sb, on.raw, 'test', {
      bridgeDbPath: on.bridgeDbPath,
      wait: { waitMs: 2_000, maxWaits: 30 },
    });
    const report = formatCoreUpgradeReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['C0 pass', 'C1 pass', 'C2 pass', 'C3 pass', 'cleanup pass']);
    expect(items.find((i) => i.id === 'C3')?.detail, report).toMatch(
      /^F7\.1 CORE index=\[INDEX\] Probe \w+ core=\[BWRK\] Probe \w+ - Character Core referenceType=Character Core wording=Core art=\[BWRK\] Probe \w+ - Character Art images=1$/,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /^\[(BWRK|INDEX)\] Probe /.test(r.name)),
      report,
    ).toEqual([]);
  });
});
