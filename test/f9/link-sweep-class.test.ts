/**
 * v3 F9 (ADR 0074): the link sweep (src/lifecycle/index.ts) reads every page of the AI REPOSITORY: bulk (P4), in its
 * own fair-share lane.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LINK_SWEEP_PRIORITY } from '../../src/lifecycle/index.js';
import { lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';
import { PROJECT } from '../tools/helpers.js';
import { recordClasses } from './priority-spy.js';

const LIMITS = {
  'key-min': 5000,
  'write-min': 2000,
  'key-hour': 60000,
  'write-hour': 30000,
  'project-hour': 60000,
};

let w: LifecycleWorld;
beforeAll(async () => {
  w = await lifecycleWorld({ env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) }, limits: LIMITS });
});
afterAll(async () => w.close());

describe('the link sweep', () => {
  it('asks for P4 for every read, in the link-sweep lane', async () => {
    expect(LINK_SWEEP_PRIORITY).toBe('P4');
    const spy = recordClasses(w.stack.runtime.projects.client(PROJECT)!.governor);
    const run = await w.stack.runtime.maintenance.scheduler.runNow('link-sweep').done;
    expect(run).toMatchObject({ outcome: 'succeeded' });
    expect(spy.seen.length).toBeGreaterThan(5);
    expect(spy.classes()).toEqual(['P4']);
    expect([...new Set(spy.seen.map((s) => s.jobId))]).toEqual(['link-sweep']);
    spy.restore();
  });
});
