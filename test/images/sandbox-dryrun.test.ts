/**
 * The image sandbox script (test/sandbox/images.ts) run against the mock (no real LegendKeeper): every check runs to
 * completion and cleans up. The clean-up's folder delete is throttled for longer than the governor waits inline, so it is
 * PARKED (`waiting_budget`): the script must wait for it rather than report it failed and leave the folder behind (the
 * owner's sandbox run of 12 November 2026).
 *
 * CR-2026-11-R4 (the owner's request S): through the same runtime and harness as the owner's run (`createSoakRuntime`
 * pointed at the faithful mock, with the world's asset and upload hosts: test/sandbox-mock/hosts.ts), and every item
 * must pass: a FAIL or an INCONCLUSIVE fails the build with the whole report printed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runImagesSandbox } from '../sandbox/images.js';
import { formatReport } from '../sandbox/smoke.js';
import { makeFaithful } from '../sandbox-mock/faithful.js';
import { expectEveryItemPasses, MOCK_LIMITS, type OnMock } from '../sandbox-mock/harness.js';
import { sandboxOnMockWithHosts } from '../sandbox-mock/hosts.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
let on: OnMock | undefined;
afterEach(async () => {
  await on?.close();
  await w?.close();
  on = undefined;
  w = undefined;
});

describe('the image sandbox script (dry run against the mock)', () => {
  it('every item passes, a parked clean-up is waited for, and it leaves nothing behind', async () => {
    w = makeFaithful(
      await imagesWorld({ env: { LK_TIER_LIMITS: JSON.stringify(MOCK_LIMITS) }, limits: MOCK_LIMITS }),
    );
    on = await sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: ['assets.test'] });
    w.web.set('sample.png', { type: 'image/png', body: fixture('alpha.png') });
    const engine = on.sb.runtime.engine;
    const parked = new Set<string>();
    const off = engine.events.on('job', (e) => {
      if (e.job.status === 'waiting_budget') parked.add(e.job.id);
    });
    // Throttle the first folder delete (the clean-up) for 31 s: longer than the governor waits inline.
    let armed = false;
    const run = engine.run.bind(engine);
    engine.run = (op, params, opts) => {
      if (op === 'deleteAsset' && !armed) {
        armed = true;
        w!.stack.mock.inject(
          (c) => c.method === 'DELETE',
          { kind: 'rate-limit', tier: 'write-min', retryAfterS: 31 },
          1,
        );
      }
      return run(op, params, opts);
    };
    try {
      // The real run's target (test/sandbox/images.test.ts), with the mock's public address and image host.
      const findings = await runImagesSandbox(
        {
          runtime: on.sb.runtime,
          projectId: on.sb.projectId,
          counters: on.sb.counters,
          publicUrl: w.stack.base,
          imageUrl: `https://assets.test:${w.port}/img/sample.png`,
          guard: w.guard,
        },
        { waitMs: 5_000, maxWaits: 30 },
      );
      const report = formatReport(findings).replace('sandbox smoke report', 'sandbox images report');
      expectEveryItemPasses(findings, report);
      const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
      for (const id of ['1.base64', '1.binary', '1.caddy', '1.url', '2', '3', '4', '5']) {
        expect(byId[id], `${id}\n${report}`).toBeDefined();
        expect(byId[id]!.verdict, `${id}: ${byId[id]!.detail}\n${report}`).toBe('pass');
      }
      expect(byId['5']!.detail).toContain('nothing left');
      expect(parked.size).toBeGreaterThanOrEqual(1);
      // Nothing of the run is left in the library.
      const left = [...w.assets.assets.values()].filter((a) => a.name.startsWith('lk-bridge images sandbox'));
      expect(left, report).toEqual([]);
      expect(on.sb.runtime.images.stagingFolderName(on.sb.projectId)).toBe('LK-Bridge staging');
    } finally {
      off();
      engine.run = run;
    }
  }, 180_000);
});
