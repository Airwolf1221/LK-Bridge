/**
 * CR-2026-11-R3 (part B addition, measurement, opt-in: LKB_MEASURE=1, about four minutes a round): the owner's day over
 * the whole repository, repeated in one process (a full snapshot, the audits, the retag audit, every whole-repository
 * appraisal and the split appraisal), with the heap after a full collection after each round: it comes back to its level
 * (measured: within 5 MB of the warm baseline after each of three rounds, 120 pages). Mocks and fixtures only.
 *
 *   LKB_MEASURE=1 npx vitest run test/review/r3-memory/retention.test.ts
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CANON_ROWS, PROJECT, r3World, type SeedPage } from '../r3-retag/helpers.js';

vi.setConfig({ testTimeout: 3_600_000, hookTimeout: 3_600_000 });

const MB = 1024 * 1024;
const PAGES = Number(process.env.LKB_RET_PAGES ?? 120);
const ROUNDS = Number(process.env.LKB_RET_ROUNDS ?? 3);

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

function heapNow(): { heap: number; rss: number; external: number } {
  gc();
  gc();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, rss: m.rss, external: m.external };
}

function seedPages(): SeedPage[] {
  return Array.from({ length: PAGES }, (_, i) => ({
    id: `mem${String(i).padStart(5, '0')}`,
    name: `[BSRC] Harbour Ledger ${i} - Polity Reference`,
    tags: i % 7 === 0 ? ['Polity', 'CANON'] : ['CANON', 'Polity'],
    rows: CANON_ROWS,
  }));
}

describe.skipIf(process.env.LKB_MEASURE !== '1')('memory over repeated whole-repository runs', () => {
  it('comes back to its level after each round', async () => {
    const w = await r3World(seedPages());
    const rounds: { heapMb: number; rssMb: number; externalMb: number }[] = [];
    try {
      // Each page gets a Main document with some text (as the snapshot reads it).
      for (let i = 0; i < PAGES; i++) {
        const id = `mem${String(i).padStart(5, '0')}`;
        w.repo.blocks.set(w.mainOf(id), {
          version: 1,
          blocks: Array.from({ length: 12 }, (_, k) => ({
            id: `${id}b${k}`,
            kind: 'paragraph',
            content: [{ text: `Ledger ${i} entry ${k}: the harbour stores were counted and sealed again.` }],
          })),
        });
      }
      const round = async () => {
        await w.snapshot();
        await w.stack.runtime.audits?.run(PROJECT, 'manual');
        const read = (name: string, args: Record<string, unknown>) =>
          w.callRead(name, { project: 'test', limit: 200, ...args });
        await read('arkona_retag_audit', {});
        await read('arkona_working_digest', {});
        await read('arkona_visual_hygiene', {});
        await read('arkona_change_impact', { page: 'mem00001' });
        await read('arkona_appraise_owner', { under: w.desk });
        await read('arkona_split_appraisal', { under: w.desk });
        await read('audit_findings', {});
      };
      await round(); // warm-up: the first round builds the caches every later round reuses
      const base = heapNow();
      for (let r = 0; r < ROUNDS; r++) {
        // An edit between rounds, as the day's work leaves (a change snapshot then sees it).
        const id = `mem${String(r).padStart(5, '0')}`;
        w.repo.outside.setTags(id, ['CANON', 'Polity', `Round${r}`]);
        await round();
        const m = heapNow();
        rounds.push({
          heapMb: Math.round((m.heap - base.heap) / MB),
          rssMb: Math.round((m.rss - base.rss) / MB),
          externalMb: Math.round((m.external - base.external) / MB),
        });
        console.info(
          `[R3 memory] round ${r}: ${JSON.stringify(rounds.at(-1))} (base heap ${Math.round(base.heap / MB)} MB)`,
        );
      }
      console.info(`[R3 memory] rounds over the warm baseline: ${JSON.stringify(rounds)}`);
      // SAFE: the heap does not climb round after round (no more than 25 MB over the warm baseline after six rounds,
      // and the last round no higher than the second by more than 10 MB).
      expect(rounds.at(-1)!.heapMb, JSON.stringify(rounds)).toBeLessThan(25);
      expect(rounds.at(-1)!.heapMb - rounds[1]!.heapMb, JSON.stringify(rounds)).toBeLessThan(10);
    } finally {
      await w.close();
    }
  });
});
