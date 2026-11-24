/**
 * v3 F7d (ADR 0077; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f7d-art-set`
 * sandbox check (test/sandbox/f7d-art-set.ts, D0 to D4) against the faithful mock with its asset host, through the same
 * runtime and harness as the owner's run: every item passes, and the throwaway character is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatArtSetReport, runArtSetCheck } from '../sandbox/f7d-art-set.js';
import { ownersWorld, TPL, type OwnersWorld } from '../packs/owners-world.js';
import { SidebarModel } from '../resources/world.js';
import { ART_KEYS } from '../f7d/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, type OnMock } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('f7d-art-set on the mock', () => {
  let w: OwnersWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await ownersWorld());
    // The Character Art template as the test world's has it (the identity copies among its rows).
    w.sidebars.page(TPL.art, [
      SidebarModel.kv(
        'kvtart0',
        'PROPERTIES',
        ART_KEYS.map((k) => [k, ''] as [string, string]),
      ),
      SidebarModel.links('dptart0', 'Dependencies', []),
      SidebarModel.links('rltart0', 'Related Sources', []),
      { id: 'tgtart0', kind: 'unsupported' as const, title: 'TAGS' },
    ]);
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: ['assets.test'] });
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (D0 to D4), and the throwaway character is gone', async () => {
    const items = await runArtSetCheck(on.sb, on.raw, 'test', {
      bridgeDbPath: on.bridgeDbPath,
      wait: { waitMs: 2_000, maxWaits: 30 },
    });
    const report = formatArtSetReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['D0 pass', 'D1 pass', 'D2 pass', 'D3 pass', 'D4 pass', 'cleanup pass']);
    expect(items.find((i) => i.id === 'D3')?.detail, report).toMatch(
      /^F7D PLAN items=Art page \| Design pieces \| Outfits\(Probe Gala\) \| Outfits\(Probe Hunt\); job \w+ succeeded and verified; placed Design pieces 1, Outfit Probe Gala 2, Outfit Probe Hunt 1$/,
    );
    expect(items.find((i) => i.id === 'D4')?.detail, report).toMatch(
      /^F7D SET index=\[INDEX\] Probe \w+ core=\[BWRK\] Probe \w+ - Character Core referenceType=Character Core folders=Wardrobe, Wardrobe \/ Probe Gala \(2\) looseInWardrobe=1 designPieces=1 art=\[BWRK\] Probe \w+ - Character Art headings=.*Reference Images.*Probe Gala.*Probe Hunt.* images=4 copies=.* dependsOnCore=true$/,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /^\[(BWRK|INDEX)\] Probe /.test(r.name)),
      report,
    ).toEqual([]);
  });
});
