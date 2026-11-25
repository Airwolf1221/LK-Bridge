/**
 * v3 F10 (ADR 0078; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f10-chronology`
 * sandbox check (test/sandbox/f10-chronology.ts, K0 to K4) against the faithful mock, through the same runtime and
 * harness as the owner's run (its delay shortened as there), on the chronology world's mock (lanes and events) built on
 * the owners' world (the Arkona pack attached): every item passes, and the throwaway chronology is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  F10_SANDBOX_DELAY_MS,
  formatChronologyRepairReport,
  runChronologyRepairCheck,
} from '../sandbox/f10-chronology.js';
import { ownersWorld } from '../packs/owners-world.js';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('f10-chronology on the mock', () => {
  let w: ChronologyWorld;
  let on: OnMock;
  beforeAll(async () => {
    // The chronology world's mock (lanes and events of any timeline) on the owners' world (the pack attached).
    w = makeFaithful(
      await chronologyWorld({
        base: (x) => ownersWorld({ ...x, toolModes: 'seed' }),
        env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
        limits: { 'key-min': 5000, 'write-min': 2000 },
      }),
    );
    on = await sandboxOnMock(w.stack, { chronologyCheckDelayMs: F10_SANDBOX_DELAY_MS });
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (K0 to K4), and the throwaway chronology is gone', async () => {
    const items = await runChronologyRepairCheck(on.sb, on.raw, 'test', {
      bridgeDbPath: on.bridgeDbPath,
      waitMs: 60_000,
    });
    const report = formatChronologyRepairReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['K0 pass', 'K1 pass', 'K2 pass', 'K3 pass', 'K4 pass', 'cleanup pass']);
    expect(items.find((i) => i.id === 'K3')?.detail, report).toMatch(
      /^F10 SYNC .* verified=true workstream=f10-sandbox-/,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /^lk-bridge f10 /.test(r.name)),
      report,
    ).toEqual([]);
  });
});
