/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- parsed JSON replies */
/**
 * v3 F6c (ADR 0080) at Arkona's scale (about 1,500 pages, 12 nations with 60 children), against the mock LegendKeeper:
 *
 * - **the 10% rule**: an audit run with the three territory and nation checks on takes at most 10% more than the same run
 *   with them switched off (the median of seven interleaved runs each, so one slow or fast run of the machine does not decide it);
 * - **the report**: the Nation Subindexes page driven as the dashboard drives it (load, a filter, ten reloads), each GET
 *   under 500 ms and the event loop never held for 100 ms (F11's limits); the base built in chunks that yield.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../discover/world.js';
import { PROJECT, retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';
import { measure, type Sample } from '../f6a1/world.js';

const NATIONS = 12;
const CHILDREN = [
  'Government & Institutions',
  'Institutions',
  'Military & Naval Affairs',
  'Cultures',
  'History',
];
const PAGES = 1500;
const CATEGORIES = [
  'Polities',
  'Cultures',
  'Historical Events',
  'Institutions',
  'Regions',
  'Settlements & Locations',
];

let w: RetagWorld;
let http: OwnerHttp;
const rt = () => w.stack.runtime;
const SWITCHES = ['checkNationSubindexNames', 'checkTerritoryCategories', 'checkCategoryHomes'];

beforeAll(async () => {
  const big = { 'key-min': 100_000, 'key-hour': 1_000_000, 'key-day': 10_000_000, 'project-hour': 1_000_000 };
  w = await retagWorld({
    bulk: 0,
    env: { LK_TIER_LIMITS: JSON.stringify(big) },
    limits: big,
    seed: (world) => {
      const r = world.repo;
      const cont = r.seed({
        id: 'f6scnts0',
        name: '[NAV] Arkona’s Continents',
        parentId: ROOT,
        tags: ['Navigation'],
      });
      // Where each kind of source lives: Culture sources in a Cultures index, Institution sources in an Institutions
      // index (the territory's or a nation's), as on Arkona; one in 50 is misplaced (the check's findings).
      const homes: Record<'Culture' | 'Institution', string[]> = { Culture: [], Institution: [] };
      const anywhere: string[] = [];
      for (let t = 0; t < 3; t++) {
        const terr = r.seed({
          id: `f6sterr${t}`,
          name: `[INDEX] Land ${t}`,
          parentId: cont.id,
          tags: ['Place'],
        });
        const cats = CATEGORIES.map((c, i) =>
          r.seed({
            id: `f6sc${t}${i}00`,
            name: `[NAV] Land ${t} ${c}`,
            parentId: terr.id,
            tags: ['Navigation'],
          }),
        );
        homes.Culture.push(cats[1]!.id);
        homes.Institution.push(cats[3]!.id);
        anywhere.push(...cats.map((c) => c.id));
        for (let n = 0; n < NATIONS / 3; n++) {
          const nat = r.seed({
            id: `f6sn${t}${n}00`,
            name: `[INDEX] Nation ${t}-${n}`,
            parentId: cats[0]!.id,
            tags: ['Polity'],
          });
          CHILDREN.forEach((c, i) => {
            const ch = r.seed({
              id: `f6sk${t}${n}${i}0`,
              name: `[NAV] ${c}`,
              parentId: nat.id,
              tags: ['Navigation'],
            });
            if (c === 'Cultures') homes.Culture.push(ch.id);
            if (c === 'Institutions') homes.Institution.push(ch.id);
          });
        }
      }
      for (let p = 0; p < PAGES; p++) {
        const kind = p % 3 === 0 ? 'Culture' : 'Institution';
        const list = p % 50 === 49 ? anywhere : homes[kind];
        r.seed({
          id: `f6sp${p.toString(36).padStart(4, '0')}`,
          name: `[BSRC] Source ${p} - ${kind} Reference`,
          parentId: list[p % list.length]!,
          tags: ['CANON', kind],
        });
      }
    },
  });
  await rt().packs.commands.approve('owner', 'arkona');
  await w.snapshot();
  // The owner's classification and seed, as the dashboard would make them.
  await rt().indexClassify.prepare(PROJECT);
  const ids = rt().indexClassify.approvable(PROJECT, {});
  rt().indexClassify.bulkApprove('owner', PROJECT, { ids: ids.slice(0, 500) });
  await rt().indexClassify.prepare(PROJECT);
  rt().nationTaxonomy.seed('owner', PROJECT, 'territory', 'seed');
  rt().nationTaxonomy.seed('owner', PROJECT, 'nation', 'seed');
  await rt().nationTaxonomy.prepare(PROJECT);
  for (const r of rt().nationTaxonomy.report(PROJECT, { status: ['proposed'] }, { limit: 500 }).rows)
    rt().nationTaxonomy.decide('owner', PROJECT, { pageId: r.id, action: 'accept' });
  http = ownerHttp(w);
  http.stepUp();
}, 900_000);
afterAll(async () => w?.close());

const auditMs = async (): Promise<number> => {
  const t0 = performance.now();
  await rt().audits.run(PROJECT, 'manual');
  return performance.now() - t0;
};

describe('territories and nations at Arkona’s scale', () => {
  it('the three checks add at most 10% to an audit run', async () => {
    const off: number[] = [];
    const on: number[] = [];
    // Warm both paths once (the model's first build, the caches).
    for (const k of SWITCHES) rt().projects.setSetting(PROJECT, k, true);
    await auditMs();
    for (let i = 0; i < 7; i++) {
      for (const k of SWITCHES) rt().projects.setSetting(PROJECT, k, false);
      off.push(await auditMs());
      for (const k of SWITCHES) rt().projects.setSetting(PROJECT, k, true);
      on.push(await auditMs());
    }
    const f = rt().audits.store.list(PROJECT, {
      code: ['nation_subindex_nonstandard'],
      state: 'open',
      limit: 5,
    });
    expect(f.findings.length).toBeGreaterThan(0);
    const best = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(
      best(on),
      `on ${on.map(Math.round).join(', ')} ms; off ${off.map(Math.round).join(', ')} ms`,
    ).toBeLessThanOrEqual(best(off) * 1.1);
  }, 600_000);

  it('the Nation Subindexes page: each GET under 500 ms, the loop never held for 100 ms', async () => {
    const samples: (Sample & { json: any })[] = [];
    const ourRows = (json: any): number =>
      (json.report.rows as { nation: { id: string } }[]).filter((r) => r.nation.id.startsWith('f6sn')).length;
    // A new tree version: the base is rebuilt on the first load, in chunks that yield.
    w.repo.res.get('f6sk0000')!.name = '[NAV] Government & Administration';
    await rt().tree.sweep(PROJECT, 'manual');
    await rt().tree.whenIdle();
    const first = await measure('first load', () => http.get('/nation-subindexes?limit=100'));
    expect(first.status, JSON.stringify(first.json).slice(0, 300)).toBe(200);
    // The world's own nations (Salahad's) have children too: only this fixture's are counted.
    const ours = await http.get('/nation-subindexes?limit=500');
    expect(ourRows(ours.json)).toBe(NATIONS * CHILDREN.length);
    samples.push(first);
    samples.push(await measure('unmatched', () => http.get('/nation-subindexes?status=unmatched&limit=100')));
    for (let i = 0; i < 10; i++)
      samples.push(await measure(`reload ${i}`, () => http.get('/nation-subindexes?limit=100')));
    for (const x of samples) {
      expect(x.status).toBe(200);
      expect(x.ms, `${x.step} took ${x.ms} ms`).toBeLessThan(500);
      expect(x.lagMaxMs, `${x.step} held the loop ${x.lagMaxMs} ms`).toBeLessThan(100);
    }
    expect(ourRows(samples[1]!.json)).toBe(NATIONS * 2); // Military & Naval Affairs, History
  }, 300_000);
});
