/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON replies */
/**
 * v3 F6b (ADR 0079) at Arkona's scale (about 1,500 pages and 250 indexes), against the mock LegendKeeper: the Index
 * Classification page driven as the dashboard drives it (load, approve all, reload, 10 reloads), each request timed with
 * the event loop's longest delay. Within F11's limits: under 500 ms per admin GET, the loop never held for 100 ms; the
 * bulk approve one request, bounded, in one transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../discover/world.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';
import { measure, type Sample } from '../f6a1/world.js';

const GROUPS = 25;
const SUBS = 9; // 25 groups × 9 sub-indexes + 25 + the top: about 250 indexes
const PAGES = 1500;

let w: RetagWorld;
let http: OwnerHttp;
const samples: Sample[] = [];

beforeAll(async () => {
  const big = { 'key-min': 100_000, 'key-hour': 1_000_000, 'key-day': 10_000_000, 'project-hour': 1_000_000 };
  w = await retagWorld({
    bulk: 0,
    env: { LK_TIER_LIMITS: JSON.stringify(big) },
    limits: big,
    seed: (world) => {
      const r = world.repo;
      const top = r.seed({ id: 'nsclroot', name: '[INDEX] Arkona', parentId: ROOT });
      let n = 0;
      for (let g = 0; g < GROUPS; g++) {
        const group = r.seed({
          id: `nscg${g.toString(36).padStart(4, '0')}`,
          name: `[INDEX] Region ${g}`,
          parentId: top.id,
        });
        for (let s = 0; s < SUBS; s++) {
          const sub = r.seed({
            id: `nscs${g.toString(36).padStart(2, '0')}${s.toString(36).padStart(2, '0')}`,
            name: `[INDEX] Region ${g} ${['Polities', 'Cultures', 'Regions'][s % 3]} ${s}`,
            parentId: group.id,
          });
          for (let p = 0; p < Math.ceil(PAGES / (GROUPS * SUBS)) && n < PAGES; p++, n++)
            r.seed({
              id: `nscp${n.toString(36).padStart(4, '0')}`,
              name: `[BSRC] Source ${n} of region ${g}`,
              parentId: sub.id,
              tags: ['CANON', 'Culture'],
            });
        }
      }
    },
  });
  await w.stack.runtime.packs.commands.approve('owner', 'arkona');
  await w.snapshot();
  http = ownerHttp(w);
  http.stepUp();
}, 600_000);
afterAll(async () => w?.close());

describe('Index Classification at Arkona’s scale', () => {
  it('load, approve all, reload: each GET under 500 ms, the loop never held for 100 ms', async () => {
    const q = '/index-classification?limit=100';
    // The first load builds the cached base in chunks that yield.
    const first = await measure('first load', () => http.get(q));
    expect(first.status, JSON.stringify(first.json).slice(0, 500)).toBe(200);
    samples.push(first);
    expect(first.json.report.totalRows).toBeGreaterThanOrEqual(240);
    const load = await measure('load', () => http.get(`${q}&status=proposed`));
    samples.push(load);
    const ids: string[] = load.json.approvable;
    expect(ids.length).toBeGreaterThan(0);
    const bulk = await measure('approve all', () =>
      http.post('/index-classification/bulk-approve', {
        ids: ids.slice(0, load.json.bulkMax),
        confirm: true,
      }),
    );
    expect(bulk.status, JSON.stringify(bulk.json).slice(0, 500)).toBe(200);
    expect(bulk.json.approved).toBe(Math.min(ids.length, load.json.bulkMax));
    samples.push(bulk);
    for (let i = 0; i < 10; i++) {
      const r = await measure(`reload ${i}`, () => http.get(q));
      expect(r.status).toBe(200);
      samples.push(r);
    }
    for (const x of samples) {
      if (x.step !== 'approve all') expect(x.ms, `${x.step} took ${x.ms} ms`).toBeLessThan(500);
      expect(x.lagMaxMs, `${x.step} held the loop ${x.lagMaxMs} ms`).toBeLessThan(100);
    }
    // Idempotent: again, nothing new.
    const again = await http.post('/index-classification/bulk-approve', {
      ids: ids.slice(0, load.json.bulkMax),
      confirm: true,
    });
    expect(again.json.approved).toBe(0);
  }, 300_000);

  it('the tool pages the same report, free', async () => {
    const before = w.requests().all;
    const r = await w.callRead('arkona_index_classify', { project: 'test', limit: 20, offset: 20 });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.returned).toBe(20);
    expect(r.body.nextOffset).toBe(40);
    expect(w.requests().all).toBe(before);
  });
});
