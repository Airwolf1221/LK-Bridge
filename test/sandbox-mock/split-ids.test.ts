/**
 * CR-2026-11-R4 (the owner's request S): the `split-ids` sandbox check (`test/sandbox/split-ids.ts`) run against the mock
 * LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run (`createSoakRuntime`
 * pointed at the mock): every item must pass (4 is NOTED by design), and both throwaway pages are gone afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatSplitIdsReport, runSplitIdsCheck } from '../sandbox/split-ids.js';
import { sandboxWorld, type SandboxWorld } from './world.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('split-ids on the mock', () => {
  let w: SandboxWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = await sandboxWorld();
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (1 to 3; 4 noted), and both throwaway pages are gone afterwards', async () => {
    const items = await runSplitIdsCheck(on.sb);
    const report = formatSplitIdsReport(items, on.sb.counters);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['1 pass', '2 pass', '3 pass', '4 noted']);
    expect(w.liveNamed(/^lk-bridge split check /), report).toEqual([]);
  });
});
