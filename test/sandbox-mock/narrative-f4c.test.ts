/**
 * CR-2026-11-R4 (the owner's request S): the `narrative-f4c` sandbox check (`test/sandbox/narrative-f4c.ts`) run against
 * the mock LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run: every item must
 * pass. Twice: with Main CANON already under Narratives (found), and without it (made with the raw client, then deleted).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatNarrativeReport, runNarrativeCheck } from '../sandbox/narrative-f4c.js';
import { N, narrativeWorld, NT, type NarrativeWorld } from '../narrative/world.js';
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
    // CR-2026-11-R4: a template copy as LegendKeeper makes one (its documents and their content, in an order it does not
    // state): the Chapter template has a second page document, listed first in a copy (N3's failure on the owner's run).
    w.repo.outside.addDocument(NT.chapter, 'Draft Notes', 'page');
    w.repo.copyTemplateDocuments = 'reversed';
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (C1, N1 to N5), and the throwaway story is gone afterwards', async () => {
    const items = await runNarrativeCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    expectEveryItemPasses(items, formatNarrativeReport(items));
    // Nothing the check made is left on the mock (its story, and Main CANON when it made it).
    const left = [
      ...(w.repo as unknown as { res: Map<string, { name: string; deletedAt: string | null }> }).res.values(),
    ]
      .filter((r) => r.deletedAt === null && /lk-bridge f4c check/.test(r.name))
      .map((r) => r.name);
    expect(left).toEqual([]);
    if (!main)
      expect(w.repo.children(N.narratives).filter((r) => r.name === '[INDEX] Main CANON')).toEqual([]);
  });
});
