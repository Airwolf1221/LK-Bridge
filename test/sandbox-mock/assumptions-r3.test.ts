/**
 * CR-2026-11-R4 (the owner's request S): the `assumptions-r3` sandbox check (`test/sandbox/assumptions-r3.ts`, X1 to X8)
 * run against the mock LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run
 * (`createSoakRuntime` pointed at the mock): every item must pass or be NOTED, and nothing it made is left.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatAssumptionsR3Report, runAssumptionsR3 } from '../sandbox/assumptions-r3.js';
import { sandboxWorld, type SandboxWorld } from './world.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('assumptions-r3 on the mock', () => {
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

  it('every item passes or is noted (X1 to X8), and its pages and folder are gone afterwards', async () => {
    const assetsBefore = new Set(w.assets.assets.keys());
    const items = await runAssumptionsR3(on.sb);
    const report = formatAssumptionsR3Report(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => i.id),
      report,
    ).toEqual(['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8']);
    expect(w.liveNamed(/^lk-bridge r3 check /), report).toEqual([]);
    expect(
      [...w.assets.assets.values()].filter((a) => !assetsBefore.has(a.id)).map((a) => a.name),
      report,
    ).toEqual([]);
  });
});
