/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON replies */
/**
 * The 25 November 2026 Snapshots freeze (ADR 0042 amendment 2, ADR 0061 amendment 2) at Arkona's scale: about 1,500
 * pages, one full snapshot and 300 change snapshots (`world.ts`), against the mock LegendKeeper.
 *
 * The three routes the dashboard's Snapshots page calls (`GET /snapshots`, `GET /snapshots/pages`,
 * `GET /snapshots/pages/:id`) each answer within 300 ms with the event loop never held for 100 ms, on their own and
 * while a full snapshot runs; browsing them again and again leaves the heap where it started.
 *
 * Before the fix (measured on this world): `/snapshots/pages` took 1.6 s and `/snapshots/pages/:id` 1.6 s, each one
 * synchronous block (`SnapshotDb.pagesWithHistory`: a correlated subquery SQLite answered from the
 * `snapshot_pieces_name` index, so every page's name scanned every settings and sidebar row of the project: pages ×
 * rows), growing with every snapshot kept (12 nightly full snapshots: 21 s; the live Arkona, 67 s). This file failed
 * there. `SCALE_SAMPLES=<file>` writes the measurements.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gc, measure, PROJECT, snapScaleWorld, type Sample, type SnapScaleWorld } from './world.js';

let s: SnapScaleWorld;
const samples: Sample[] = [];
const PAGES = Number(process.env.SCALE_PAGES ?? 1500);
const CHANGES = Number(process.env.SCALE_CHANGES ?? 300);
const EXTRA_FULLS = Number(process.env.SCALE_EXTRA_FULLS ?? 0);

const ROUTE_MS = 300;
const LAG_MS = 100;

beforeAll(async () => {
  s = await snapScaleWorld({ pages: PAGES, changes: CHANGES, extraFulls: EXTRA_FULLS });
}, 900_000);
afterAll(async () => {
  if (process.env.SCALE_SAMPLES)
    writeFileSync(
      process.env.SCALE_SAMPLES,
      JSON.stringify(
        samples.map(({ step, status, ms, heapMb, rssMb, lagMaxMs }) => ({
          step,
          status,
          ms,
          heapMb,
          rssMb,
          lagMaxMs,
        })),
        null,
        1,
      ),
    );
  await s?.close();
});

/** The three routes as the Snapshots page calls them (the page's first load, the page finder, one page's history). */
async function browse(label: string, page: string): Promise<Sample[]> {
  const out: Sample[] = [];
  out.push(await measure(`${label} GET /snapshots`, () => s.http.get('/snapshots')));
  out.push(await measure(`${label} GET /snapshots/pages`, () => s.http.get('/snapshots/pages?limit=50')));
  out.push(
    await measure(`${label} GET /snapshots/pages/:id`, () => s.http.get(`/snapshots/pages/${page}?limit=50`)),
  );
  for (const x of out) expect(x.status, x.step).toBe(200);
  samples.push(...out);
  return out;
}

describe('Snapshots browsing at Arkona’s scale', () => {
  it('each route answers within 300 ms and never holds the loop for 100 ms', async () => {
    await browse('warm-up', s.pageIds[5]!);
    for (let i = 0; i < 3; i++) {
      for (const x of await browse(`alone ${i}`, s.pageIds[(i * 101) % s.pageIds.length]!)) {
        expect(x.ms, x.step).toBeLessThan(ROUTE_MS);
        expect(x.lagMaxMs, x.step).toBeLessThan(LAG_MS);
      }
    }
  }, 600_000);

  it('the same while a full snapshot runs, and the list shows its progress', async () => {
    const svc = s.w.stack.runtime.snapshots;
    const running = svc.full(PROJECT, 'manual');
    try {
      // The run is under way: some pages done, most still to do.
      for (let i = 0; i < 2000; i++) {
        const run = svc.index.runningRun(PROJECT, 'full');
        if (run && run.done >= 20) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const run = svc.index.runningRun(PROJECT, 'full');
      expect(run, 'the full snapshot is running').not.toBeNull();
      for (let i = 0; i < 3; i++) {
        const xs = await browse(`during ${i}`, s.pageIds[(i * 211 + 7) % s.pageIds.length]!);
        for (const x of xs) {
          expect(x.ms, x.step).toBeLessThan(ROUTE_MS);
          expect(x.lagMaxMs, x.step).toBeLessThan(LAG_MS);
        }
      }
      const list = await s.http.get('/snapshots');
      const progress = list.json.running ?? null;
      expect(progress, 'the running snapshot’s progress').not.toBeNull();
      expect(progress.total).toBeGreaterThan(PAGES);
      expect(progress.done).toBeGreaterThan(0);
      expect(progress.done).toBeLessThanOrEqual(progress.total);
    } finally {
      const run = svc.index.runningRun(PROJECT, 'full');
      if (run) svc.abandonRun(run.id);
      await running.catch(() => undefined);
    }
  }, 900_000);

  it('browsing again and again returns the heap to where it started', async () => {
    gc();
    const start = process.memoryUsage().heapUsed / 1048576;
    let last: Sample[] = [];
    for (let i = 0; i < 15; i++) last = await browse(`repeat ${i}`, s.pageIds[(i * 97) % s.pageIds.length]!);
    for (const x of last) expect(x.heapMb - start, x.step).toBeLessThan(24);
  }, 600_000);
});
