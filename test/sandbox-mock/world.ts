/**
 * CR-2026-11-R4 (the owner's request S): the mock world the sandbox checks run on in the ordinary suite. It is the
 * block-id sweep's world (`test/blockids/world.ts`: E1a's snapshot world, with `assignBlockIds`, map features, timeline
 * lanes and events, boards, the asset library and its hosts, the faithful sidebars and the templates), with the mock
 * models' FAITHFUL settings on: LegendKeeper as the owner's runs showed it, where the defaults (which the older tests
 * expect) differ. Nothing here can reach a real LegendKeeper: every host is on loopback.
 */
import type { Res } from '../tree/model.js';
import { blockIdsWorld, type BlockIdsWorld } from '../blockids/world.js';
import { makeFaithful } from './faithful.js';

export interface SandboxWorld extends BlockIdsWorld {
  /** The live resources whose names match (what a check left behind). */
  liveNamed(re: RegExp): string[];
}

export async function sandboxWorld(o: Parameters<typeof blockIdsWorld>[0] = {}): Promise<SandboxWorld> {
  const w = makeFaithful((await blockIdsWorld(o)) as SandboxWorld);
  w.liveNamed = (re) =>
    [...w.repo.res.values()].filter((r: Res) => r.deletedAt === null && re.test(r.name)).map((r) => r.name);
  return w;
}
