/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- runtime introspection */
/**
 * CR-2026-11-R3, R3-65 (the owner's follow-up, measurement, opt-in: LKB_MEASURE=1): the live bridge's memory stepped up
 * by 74 MB between 17:15 and 17:20 with no request logged, so the owner asked to look first at the background work that
 * does not log. This runs every implemented maintenance job through the bridge's own scheduler, three times each, in a
 * repository of `LKB_JOBS_PAGES` pages (default 600), and measures the heap after a full collection once each run has
 * finished: what a job keeps after it is done shows as a step that does not come back; a job that kept any is measured
 * again once its LegendKeeper requests' 35-second SDK timers have run out (R3-65). Mocks and fixtures only.
 *
 *   LKB_MEASURE=1 npx vitest run test/review/r3-memory/maintenance-jobs.test.ts
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CANON_ROWS, PROJECT, r3World, type SeedPage } from '../r3-retag/helpers.js';

vi.setConfig({ testTimeout: 3_600_000, hookTimeout: 3_600_000 });

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
const PAGES = Number(process.env.LKB_JOBS_PAGES ?? 600);

async function settledMb(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / MB;
}

describe.skipIf(process.env.LKB_MEASURE !== '1')('every maintenance job: what it keeps once done', () => {
  it(`${PAGES} pages, each job three times`, async () => {
    const id = (i: number) => `mj${String(i).padStart(5, '0')}`;
    const seed: SeedPage[] = Array.from({ length: PAGES }, (_, i) => ({
      id: id(i),
      name: `[BSRC] Harbour Roll ${i} - Polity Reference`,
      tags: ['CANON', 'Polity'],
      rows: CANON_ROWS,
    }));
    const w = await r3World(seed);
    try {
      for (let i = 0; i < PAGES; i++)
        w.repo.blocks.set(w.mainOf(id(i)), {
          version: 1,
          blocks: Array.from({ length: 20 }, (_, k) => ({
            id: `${id(i)}b${k}`,
            kind: 'paragraph',
            content: [
              {
                text: `Roll ${i}, line ${k}: the harbour's stores were counted and sealed again. `.repeat(3),
              },
            ],
          })),
        });
      await w.snapshot();
      const rt: any = w.stack.runtime;
      const scheduler = rt.maintenance.scheduler;
      const jobs = (scheduler.list() as any[]).filter((j) => j.implemented).map((j) => j.id as string);
      const rows: { job: string; runs: number[]; outcome: string; ms: number; later?: number }[] = [];
      const start = await settledMb();
      for (const job of jobs) {
        const runs: number[] = [];
        const jobStart = await settledMb();
        let outcome = '';
        let ms = 0;
        for (let r = 0; r < 3; r++) {
          const before = await settledMb();
          const t0 = Date.now();
          try {
            const { done } = scheduler.runNow(job, job === 'budget-sampler' ? undefined : PROJECT);
            const run = await done;
            outcome = String(run?.outcome ?? 'none');
          } catch (e) {
            outcome = `refused: ${(e as Error).message.slice(0, 60)}`;
          }
          ms = Date.now() - t0;
          await rt.snapshots.settled();
          await rt.audits.settled();
          await rt.appraisal.index.settled();
          runs.push(Math.round((await settledMb()) - before));
        }
        // What a run keeps may be its LegendKeeper requests' 35-second timers (the SDK's AbortSignal.timeout, R3-65),
        // which end on their own: measured again once they have, from before the first run.
        let later: number | undefined;
        if (runs.some((x) => x >= 1)) {
          await new Promise((r) => setTimeout(r, 36_000));
          later = Math.round((await settledMb()) - jobStart);
        }
        rows.push({ job, runs, outcome, ms, ...(later !== undefined ? { later } : {}) });
        console.info(
          `[R3 jobs] ${job}: heap kept per run ${JSON.stringify(runs)} MB (${outcome}, ${ms} ms)` +
            (later !== undefined
              ? `; after the requests' 35-second timers, ${later} MB kept by the three runs`
              : ''),
        );
      }
      console.info(`[R3 jobs] all jobs: ${Math.round((await settledMb()) - start)} MB kept in all`);
      // What each job keeps once done: never a step that stays, run after run; once the requests' timers have run out,
      // little or nothing (measured 19 November 2026: -5, 4 and 5 MB for the three that hold any, 4 MB for all jobs).
      for (const r of rows) {
        expect(
          r.runs.slice(1).every((x) => x < 10),
          `${r.job} ${JSON.stringify(r.runs)}`,
        ).toBe(true);
        if (r.later !== undefined) expect(r.later, `${r.job} after the timers`).toBeLessThan(10);
      }
      expect(Math.round((await settledMb()) - start)).toBeLessThan(20);
    } finally {
      await w.close();
    }
  });
});
