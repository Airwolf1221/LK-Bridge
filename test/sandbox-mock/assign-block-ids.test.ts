/**
 * CR-2026-11-R4 (the owner's request S): the `assign-block-ids` sandbox check (`test/sandbox/assign-block-ids.ts`) run
 * against the mock LegendKeeper in the ordinary suite, through the same runtime and harness as the owner's run
 * (`createSoakRuntime` pointed at the mock, the verdict recorded in the bridge's database as the real run records it):
 * every item must pass. Twice: on its own throwaway page, and on a legacy page named as `LKB_BLOCKIDS_DOCUMENT` names one.
 */
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_VERSION,
  formatBlockIdsReport,
  recordBlockIdsVerdict,
  runBlockIdsCheck,
} from '../sandbox/assign-block-ids.js';
import { B } from '../blockids/world.js';
import { sandboxWorld, type SandboxWorld } from './world.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('assign-block-ids on the mock', () => {
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

  const recorded = () => {
    const db = new Database(on.bridgeDbPath, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare('SELECT bridge_version, verdict FROM block_id_sandbox_checks ORDER BY rowid DESC LIMIT 1')
        .get() as { bridge_version: string; verdict: string } | undefined;
    } finally {
      db.close();
    }
  };

  it('its own throwaway page: every item passes, the verdict is recorded, and the page is gone afterwards', async () => {
    const r = await runBlockIdsCheck(on.sb);
    const where = recordBlockIdsVerdict(on.bridgeDbPath, 'test', r.verdict, r.summary.slice(0, 3900));
    const report = formatBlockIdsReport(r, where, on.sb.counters);
    expectEveryItemPasses(r.items, report);
    expect(where, report).toBe(
      `recorded ${r.verdict} for bridge version ${BRIDGE_VERSION} in ${on.bridgeDbPath}`,
    );
    expect(recorded(), report).toEqual({ bridge_version: BRIDGE_VERSION, verdict: r.verdict });
    expect(w.liveNamed(/^lk-bridge block-ids check /), report).toEqual([]);
  });

  // The API cannot make a legacy document on the faithful mock (as on LegendKeeper: blocks written without ids are given
  // ids), so the steps 1 to 4 run on the world's own legacy pages, named as the owner names one on a disposable copy.
  it.each([
    { page: B.missing, label: 'blocks without ids and an unsupported block' },
    { page: B.duplicate, label: 'one id used twice and an unsupported block' },
  ])(
    'a legacy page named as LKB_BLOCKIDS_DOCUMENT names one ($label): every item passes (1 to 4)',
    async ({ page }) => {
      const named = `${page}/${w.mainOf(page)}`;
      const r = await runBlockIdsCheck(on.sb, { named });
      const report = formatBlockIdsReport(r, 'not recorded (the named-document run)', on.sb.counters);
      expectEveryItemPasses(r.items, report);
      expect(
        r.items.map((i) => `${i.id} ${i.verdict}`),
        report,
      ).toEqual(['1 pass', '2 pass', '3 pass', '4 pass']);
      expect(r.verdict, report).toBe('PASS');
    },
  );
});
