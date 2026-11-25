/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies and log lines */
/**
 * v3 F6a.1 (ADR 0076 amendment 1): the 24 November 2026 hang, at Arkona's scale (1,500 pages, about 200 values in 20
 * categories, real-sized sidebars and snapshot blocks), against the mock LegendKeeper: the Reference Types page's "Accept
 * all confident suggestions" driven as the page drives it (load, accept all, reload), then 20 reloads, measuring heap
 * and RSS after every request and the event loop's lag during each.
 *
 * Before F6a.1 the bulk accept rebuilt the whole report for every row inside one synchronous loop (each build asked the
 * tree for every id on every page's path: 1,700 status reads with freshly prepared statements, whose native memory is
 * released only once the event loop turns). Measured on this world: 10 rows took 6.7 s with the loop blocked for all of
 * it and RSS +955 MB; the whole filter (131 rows) grew the test process to 13 GB in three seconds and the kernel killed
 * it. This file fails there (killed, or with the lag and RSS bounds below at a smaller world).
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptAllBody, gc, measure, PAGE_QUERY, scaleWorld, type Sample, type ScaleWorld } from './world.js';

let s: ScaleWorld;
const samples: Sample[] = [];
const PAGES = Number(process.env.F6A1_PAGES ?? 1500);

beforeAll(async () => {
  s = await scaleWorld({ pages: PAGES });
}, 300_000);
afterAll(async () => s?.close());

describe('Accept all at Arkona’s scale', () => {
  it('a full Accept all plus 20 reloads: heap bounded, RSS flat, the event loop never held', async () => {
    gc();
    const start = process.memoryUsage();
    const load = await measure('load', () => s.http.get(PAGE_QUERY));
    expect(load.status, JSON.stringify(load.json)).toBe(200);
    samples.push(load);
    // Before F6a.1 the page counted the confident rows among the 500 it fetched (the server listed none).
    const offered: number =
      load.json.confident?.count ??
      (await s.http.get(PAGE_QUERY.replace('limit=100', 'limit=500'))).json.report.rows.filter(
        (r: any) => r.status === 'open' && r.suggestion.kind === 'suggested',
      ).length;
    expect(offered).toBeGreaterThanOrEqual(PAGES >= 1500 ? 120 : 50);
    const bulk = await measure('accept all', () =>
      s.http.post('/reference-types/bulk-accept', acceptAllBody(load.json)),
    );
    samples.push(bulk);
    expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
    expect(bulk.json.accepted).toBe(offered);
    for (let i = 0; i <= 20; i++) {
      const r = await measure(`reload ${i}`, () => s.http.get(PAGE_QUERY));
      expect(r.status).toBe(200);
      samples.push(r);
    }
    // The measurements, for a report (F6A1_SAMPLES=<file>).
    if (process.env.F6A1_SAMPLES)
      writeFileSync(
        process.env.F6A1_SAMPLES,
        JSON.stringify(
          samples.map(({ step, ms, heapMb, rssMb, lagMaxMs }) => ({ step, ms, heapMb, rssMb, lagMaxMs })),
        ),
      );
    const startHeapMb = start.heapUsed / 1048576;
    const startRssMb = start.rss / 1048576;
    // The event loop: never held for half a second, the bulk accept included.
    expect(bulk.lagMaxMs).toBeLessThan(500);
    for (const x of samples) expect(x.lagMaxMs, x.step).toBeLessThan(500);
    // The heap: within a fixed bound of where it started, after every request.
    for (const x of samples) expect(x.heapMb - startHeapMb, x.step).toBeLessThan(64);
    // RSS: the bulk accept does not step it up, and the reloads do not grow it pass by pass.
    expect(bulk.rssMb - startRssMb).toBeLessThan(128);
    const reloads = samples.filter((x) => x.step.startsWith('reload'));
    expect(reloads.at(-1)!.rssMb - reloads[0]!.rssMb).toBeLessThan(32);
  }, 300_000);

  it('running it again touches only the rows still open (nothing, here)', async () => {
    const load = await s.http.get(PAGE_QUERY);
    expect(load.json.confident.count).toBe(0);
    const again = await s.http.post('/reference-types/bulk-accept', {
      ids: (await s.http.get('/reference-types?status=mapped&limit=500')).json.report.rows.map(
        (r: any) => r.id,
      ),
      confirm: true,
    });
    expect(again.status).toBe(200);
    expect(again.json.accepted).toBe(0);
    expect(new Set((again.json.skippedRows as any[]).map((x) => x.reason))).toEqual(
      new Set(['already_decided']),
    );
  });
});
