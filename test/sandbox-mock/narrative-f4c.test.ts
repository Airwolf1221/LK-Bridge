/**
 * CR-2026-11-R4 (the owner's request S): the `narrative-f4c` sandbox check (`test/sandbox/narrative-f4c.ts`) run against
 * the mock LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run: every item must
 * pass. Twice: with Main CANON already under Narratives (found), and without it (made with the raw client, then deleted).
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { formatNarrativeReport, runNarrativeCheck } from '../sandbox/narrative-f4c.js';
import { narrativeWorld, type NarrativeWorld } from '../narrative/world.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe.each([
  { main: true, label: 'Main CANON found' },
  { main: false, label: 'Main CANON made by the check' },
])('narrative-f4c on the mock ($label)', ({ main }) => {
  let w: NarrativeWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = await narrativeWorld({ main });
    // Pages the check makes with the raw client get their sidebars modelled from their first property request.
    w.sidebars.adoptNewPages = (id) => w.repo.live(id) !== undefined;
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (C1, N1 to N5), and the throwaway story is gone afterwards', async () => {
    const items = await runNarrativeCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    expectEveryItemPasses(items, formatNarrativeReport(items));
  });
});
