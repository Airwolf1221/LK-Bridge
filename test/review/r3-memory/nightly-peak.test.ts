/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- runtime introspection */
/**
 * CR-2026-11-R3 (part B addition, measurement, opt-in: LKB_MEASURE=1): the heap's high-water mark while the night's
 * whole-repository maintenance runs (the full snapshot with the appraisal index built after it, then the scheduled audit
 * with its retag and split appraisal checks), at two repository sizes, and what is left after each. Mocks and fixtures
 * only; nothing here runs in the default suite.
 *
 *   LKB_MEASURE=1 LKB_NIGHT_PAGES=300,600 npx vitest run test/review/r3-memory/nightly-peak.test.ts
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CANON_ROWS, PROJECT, r3World, type SeedPage } from '../r3-retag/helpers.js';

vi.setConfig({ testTimeout: 3_600_000, hookTimeout: 3_600_000 });

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
const SIZES = (process.env.LKB_NIGHT_PAGES ?? '300,600').split(',').map(Number);
const BLOCKS = Number(process.env.LKB_NIGHT_BLOCKS ?? 30);

const settled = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

/** The heap's high-water mark while `fn` runs (sampled every 10 ms), and what is left after it (after a collection). */
async function peakOf(fn: () => Promise<unknown>): Promise<{ peakMb: number; leftMb: number; ms: number }> {
  const before = settled();
  let peak = process.memoryUsage().heapUsed;
  const t = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 10);
  const t0 = Date.now();
  try {
    await fn();
  } finally {
    clearInterval(t);
  }
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return {
    peakMb: Math.round((peak - before) / MB),
    leftMb: Math.round((settled() - before) / MB),
    ms: Date.now() - t0,
  };
}

describe.skipIf(process.env.LKB_MEASURE !== '1')('the night’s whole-repository maintenance: its peak', () => {
  for (const pages of SIZES)
    it(`${pages} pages of ${BLOCKS} blocks`, async () => {
      const id = (i: number) => `np${String(i).padStart(5, '0')}`;
      const seed: SeedPage[] = Array.from({ length: pages }, (_, i) => ({
        id: id(i),
        name: `[BSRC] Night Ledger ${i} - Polity Reference`,
        tags: ['CANON', 'Polity'],
        rows: CANON_ROWS,
      }));
      const w = await r3World(seed);
      try {
        for (let i = 0; i < pages; i++)
          w.repo.blocks.set(w.mainOf(id(i)), {
            version: 1,
            blocks: Array.from({ length: BLOCKS }, (_, k) =>
              k % 6 === 0
                ? { id: `${id(i)}h${k}`, kind: 'heading', level: 2, content: [{ text: `Section ${k}` }] }
                : {
                    id: `${id(i)}b${k}`,
                    kind: 'paragraph',
                    content: [
                      {
                        text: `Ledger ${i}, entry ${k}: the tide gate's stores were counted twice, sealed with the harbour mark, and carried up to the counting house before the evening bell. `.repeat(
                          3,
                        ),
                      },
                    ],
                  },
            ),
          });
        const rt: any = w.stack.runtime;
        const base = Math.round(settled() / MB);
        const full = await peakOf(async () => {
          await rt.snapshots.full(PROJECT, 'schedule');
          await rt.audits.settled();
          await rt.appraisal.index.settled();
        });
        const audit = await peakOf(() => rt.audits.run(PROJECT, 'schedule'));
        const maxRss = Math.round(process.resourceUsage().maxRSS / 1024);
        console.info(
          `[R3 night] ${pages} pages: base heap ${base} MB; full snapshot + index ${JSON.stringify(full)}; scheduled audit ${JSON.stringify(audit)}; process max RSS ${maxRss} MB`,
        );
        expect(full.leftMb).toBeLessThan(200);
      } finally {
        await w.close();
      }
    });
});
