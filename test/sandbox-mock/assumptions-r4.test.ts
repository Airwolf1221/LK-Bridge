/**
 * CR-2026-11-R4 (the owner's request S): the `assumptions-r4` sandbox check (`test/sandbox/assumptions-r4.ts`, Y1 to Y3)
 * run against the mock LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run
 * (`createSoakRuntime` pointed at the mock): every item must pass, and its page is gone afterwards. Y2 reached the owner
 * broken (its table in a shape the registry refuses); here it would have failed the build first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatAssumptionsR4Report, runAssumptionsR4 } from '../sandbox/assumptions-r4.js';
import { sandboxWorld, type SandboxWorld } from './world.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('assumptions-r4 on the mock', () => {
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

  it('every item passes (Y1 to Y3), and its throwaway page is gone afterwards', async () => {
    const items = await runAssumptionsR4(on.sb);
    const report = formatAssumptionsR4Report(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['Y1 pass', 'Y2 pass', 'Y3 pass']);
    expect(w.liveNamed(/^lk-bridge r4 check /), report).toEqual([]);
  });
});
