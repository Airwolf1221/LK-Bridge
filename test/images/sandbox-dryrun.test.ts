/**
 * The image sandbox script (test/sandbox/images.ts) run against the mock (no real LegendKeeper): every check runs to
 * completion and cleans up. The clean-up's folder delete is throttled for longer than the governor waits inline, so it is
 * PARKED (`waiting_budget`): the script must wait for it rather than report it failed and leave the folder behind (the
 * owner's sandbox run of 12 November 2026).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runImagesSandbox } from '../sandbox/images.js';
import { newCounters } from '../sandbox/soak.js';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('the image sandbox script (dry run against the mock)', () => {
  it('runs every check, waits for a parked clean-up, and leaves nothing behind', async () => {
    w = await imagesWorld();
    w.web.set('sample.png', { type: 'image/png', body: fixture('alpha.png') });
    const parked = new Set<string>();
    const off = w.stack.runtime.engine.events.on('job', (e) => {
      if (e.job.status === 'waiting_budget') parked.add(e.job.id);
    });
    // Throttle the first folder delete (the clean-up) for 31 s: longer than the governor waits inline.
    let armed = false;
    const engine = w.stack.runtime.engine;
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
      const findings = await runImagesSandbox(
        {
          runtime: w.stack.runtime,
          projectId: PROJECT,
          counters: newCounters(),
          publicUrl: w.stack.base,
          imageUrl: `https://assets.test:${w.port}/img/sample.png`,
          guard: w.guard,
        },
        { waitMs: 5_000, maxWaits: 30 },
      );
      const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
      for (const id of ['1.base64', '1.binary', '1.caddy', '1.url', '2', '3', '4', '5']) {
        expect(byId[id], id).toBeDefined();
        expect(byId[id]!.verdict, `${id}: ${byId[id]!.detail}`).toBe('pass');
      }
      expect(byId['5']!.detail).toContain('nothing left');
      expect(parked.size).toBeGreaterThanOrEqual(1);
      // Nothing of the run is left in the library.
      const left = [...w.assets.assets.values()].filter((a) => a.name.startsWith('lk-bridge images sandbox'));
      expect(left).toEqual([]);
      expect(w.stack.runtime.images.stagingFolderName(PROJECT)).toBe('LK-Bridge staging');
    } finally {
      off();
      engine.run = run;
    }
  }, 180_000);
});
