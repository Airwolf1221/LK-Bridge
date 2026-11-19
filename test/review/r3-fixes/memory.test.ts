/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- tool JSON and the worlds' untyped fixtures */
/**
 * CR-2026-11-R3, fix B (the owner's request): the peak memory of the two largest jobs the bridge plans and runs at once,
 * measured in the mock (the owner's server: about 620 MB normally, a 760 MB peak, a 1.5 GB cap).
 *
 * - **A 700-page rename** of a heavily referenced character: the rename world's Nadira al-Khalid, named on 700 more
 *   Authoritative pages (one paragraph each), planned (dry run) and then proposed, approved and run to the end.
 * - **The largest split the fixtures build**: Zahra al-Rashid's monolith split into its six owners (art, relationship
 *   and universal material included), with her Biography grown to 2,000 paragraphs so that the job moves more than
 *   2,000 blocks verbatim.
 *
 * Each figure is the peak resident set size (and V8 heap) above the baseline taken once the world, its snapshot and
 * its index are built (the mock LegendKeeper lives in the same process; its data is in the baseline). The ceiling the
 * owner set is about 400 MB over baseline; the tests fail above it. Opt-in, as they take minutes:
 *
 *   LKB_MEASURE=1 npx vitest run test/review/r3-fixes/memory.test.ts
 *
 * Mocks and fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT } from '../../tools/helpers.js';

const MEASURE = process.env.LKB_MEASURE === '1';
const CEILING_MB = 400;
const MB = 1024 * 1024;

interface Peak {
  readonly rssMb: number;
  readonly heapMb: number;
}

function baseline(): { rss: number; heap: number } {
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed };
}

/** Samples memory every 10 ms while `fn` runs; the peak above `base`. */
async function peakDuring<T>(base: { rss: number; heap: number }, fn: () => Promise<T>): Promise<[T, Peak]> {
  let rss = 0;
  let heap = 0;
  const sample = () => {
    const m = process.memoryUsage();
    rss = Math.max(rss, m.rss);
    heap = Math.max(heap, m.heapUsed);
  };
  const t = setInterval(sample, 10);
  try {
    const out = await fn();
    sample();
    return [out, { rssMb: Math.round((rss - base.rss) / MB), heapMb: Math.round((heap - base.heap) / MB) }];
  } finally {
    clearInterval(t);
  }
}

/**
 * Waits for a job to end, reading only its status row (a full job view loads every step: polled every 50 ms through a
 * 2,000-step job, that is the test's own memory, not the bridge's), then returns the job as the engine shows it.
 */
async function settleJob(rt: any, db: any, jobId: string, ms = 1_800_000): Promise<any> {
  const until = Date.now() + ms;
  let said = Date.now();
  const row = db.prepare('SELECT status, wait_reason FROM jobs WHERE id = ?');
  for (;;) {
    const j = row.get(jobId) as { status: string; wait_reason: string | null };
    if (['succeeded', 'failed', 'cancelled'].includes(j.status) || Date.now() > until)
      return rt.engine.queries.getJob(PROJECT, jobId);
    // Once a minute, where it is (its state and what it waits for), so a long run says so.
    if (Date.now() - said > 60_000) {
      said = Date.now();
      console.info(`[R3 fix B] job ${j.status}; waiting for ${j.wait_reason ?? 'nothing'}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!MEASURE)('CR-2026-11-R3 fix B: peak memory of the largest rename and split', () => {
  it('a 700-page rename of a heavily referenced character: planned, then run to the end', async () => {
    const { renameWorld } = await import('../../packs/rename-world.js');
    const { C } = await import('../../packs/world.js');
    const { SidebarModel } = await import('../../resources/world.js');
    const w: any = await renameWorld();
    try {
      const N = Number(process.env.LKB_MEASURE_PAGES ?? 700);
      for (let i = 0; i < N; i++) {
        const id = `mr${String(i).padStart(6, '0')}`;
        w.repo.seed({
          id,
          name: `[BSRC] Harbour Ledger ${i} - General Source`,
          parentId: C.humans,
          referenceType: 'General Source',
          tags: ['CANON'],
        });
        w.sidebars.page(id, [
          SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', [
            ['Status', 'Authoritative'],
            ['Continuity Type', 'CANON'],
            ['Continuity', 'Main'],
            ['Reference Type', 'General Source'],
            ['Scope', `Harbour ledger ${i}`],
          ]),
        ]);
        w.repo.blocks.set(w.mainOf(id), {
          version: 1,
          blocks: [
            { id: `${id}h`, kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
            {
              id: `${id}p`,
              kind: 'paragraph',
              content: [
                { text: `Ledger ${i} records that Nadira al-Khalid inspected the harbour stores in person.` },
              ],
            },
          ],
        });
      }
      // The bridge's repository tree learns the new pages as a finished build leaves them (as the world's own are).
      const { buildModels } = await import('../../discover/world.js');
      buildModels(w.stack, w.repo, w.assets);
      await w.snapshot();
      const base = baseline();
      const [dry, planPeak] = await peakDuring<any>(base, () =>
        w.call('arkona_rename', {
          subject: C.nadira,
          newName: 'Laila al-Khalid',
          given: 'Laila',
          dryRun: true,
        }),
      );
      expect(dry.isError, dry.text.slice(0, 500)).toBeFalsy();
      console.info(`[R3 fix B] the plan's keys: ${Object.keys(dry.body).join(', ')}`);
      const [jobView, runPeak] = await peakDuring(base, async () => {
        const r = await w.call('arkona_rename', {
          subject: C.nadira,
          newName: 'Laila al-Khalid',
          given: 'Laila',
        });
        expect(r.isError, r.text.slice(0, 500)).toBeFalsy();
        // The answer is too large to inline: it comes back as a result handle (as designed); the proposal is the newest.
        const proposalId =
          typeof r.body.proposalId === 'string'
            ? r.body.proposalId
            : (
                w.stack.db
                  .prepare('SELECT id FROM proposals ORDER BY created_at DESC, rowid DESC LIMIT 1')
                  .get() as {
                  id: string;
                }
              ).id;
        await w.stack.runtime.policy.commands.approveAsCanon('owner', proposalId);
        const jobId = w.stack.runtime.policy.proposals.get(proposalId).jobId;
        return settleJob(w.stack.runtime, w.stack.db, jobId);
      });
      expect(jobView.status, JSON.stringify(jobView.lastError)).toBe('succeeded');
      const renamed = [...w.repo.res.values()].filter(
        (r: any) =>
          /^mr\d{6}$/.test(r.id) &&
          JSON.stringify(w.repo.blocks.get(w.mainOf(r.id))).includes('Laila al-Khalid'),
      ).length;
      console.info(
        `[R3 fix B] rename of ${N} referencing pages (${renamed} pages renamed): ` +
          `plan peak +${planPeak.rssMb} MB RSS (+${planPeak.heapMb} MB heap); ` +
          `propose, approve and run peak +${runPeak.rssMb} MB RSS (+${runPeak.heapMb} MB heap); baseline ` +
          `${Math.round(base.rss / MB)} MB RSS`,
      );
      expect(renamed).toBe(N);
      expect(planPeak.rssMb).toBeLessThan(CEILING_MB);
      expect(runPeak.rssMb).toBeLessThan(CEILING_MB);
    } finally {
      await w.close();
    }
  }, 3_600_000);

  it('the largest split the fixtures build: a monolith of more than 2,000 blocks into its six owners', async () => {
    const { splitWorld, zahraBody, S } = await import('../../packs/split-world.js');
    const { zahraSplit } = await import('../../packs/split-inputs.js');
    const { split, approveSplit } = await import('../../packs/split-helpers.js');
    const w: any = await splitWorld();
    try {
      // Her Biography grown to 2,000 paragraphs (the fixture's own section, the same shape, many times over).
      const doc = w.mainOf(S.zahra);
      const url = (id: string) => `https://assets.test:${w.port}/a/${id}.webp`;
      const body = zahraBody(url) as any[];
      const at = body.findIndex((b) => b.kind === 'heading' && b.content?.[0]?.text === 'Biography');
      const extra = Array.from({ length: 2_000 }, (_, k) => ({
        id: `zbx${String(k).padStart(5, '0')}`,
        kind: 'paragraph',
        content: [
          { text: `On the ${k + 1}th road Zahra al-Rashid kept the caravan's ledger and its water rights.` },
        ],
      }));
      body.splice(at + 1, 0, ...extra);
      w.repo.blocks.set(doc, { version: 1, blocks: body });
      await w.snapshot();
      const base = baseline();
      const [dry, planPeak] = await peakDuring<any>(base, () => split(w, { ...zahraSplit(), dryRun: true }));
      expect(dry.isError, dry.text.slice(0, 500)).toBeFalsy();
      const [done, runPeak] = await peakDuring(base, async () => {
        const r = await split(w, zahraSplit());
        expect(r.body.status, r.text.slice(0, 500)).toBe('proposal_captured');
        return approveSplit(w, String(r.body.proposalId));
      });
      expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
      console.info(
        `[R3 fix B] split of a ${body.length}-block monolith into its six owners: plan peak +${planPeak.rssMb} MB RSS ` +
          `(+${planPeak.heapMb} MB heap); propose, approve and run peak +${runPeak.rssMb} MB RSS ` +
          `(+${runPeak.heapMb} MB heap); baseline ${Math.round(base.rss / MB)} MB RSS`,
      );
      expect(planPeak.rssMb).toBeLessThan(CEILING_MB);
      expect(runPeak.rssMb).toBeLessThan(CEILING_MB);
    } finally {
      await w.close();
    }
  }, 3_600_000);
});
