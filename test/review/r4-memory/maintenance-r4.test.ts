/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- runtime introspection */
/**
 * CR-2026-11-R4, scope item 8 (opt-in measurement: LKB_MEASURE=1): R3's measurement of every maintenance job
 * (`test/review/r3-memory/maintenance-jobs.test.ts`) ran on a world of Polity pages with no characters, chronology or
 * Narratives, so the work F4a, F4b, F4c and F4.1 added to the scheduled audit (the governance, consistency and narrative
 * categories, the facts index brought up to date over the overlay) did almost nothing there. This runs every
 * implemented job through the bridge's own scheduler, three times each, on the narrative world scaled up with
 * `LKB_R4_CHARACTERS` characters (default 300; identity sidebars with births and deaths, a prose birth each) and a story
 * of `LKB_R4_CHAPTERS` drafted chapters (default 20), and measures the heap after a full collection once each run has
 * finished. A job that kept any is measured again once its requests' 35-second SDK timers have run out (R3-65).
 *
 *   LKB_MEASURE=1 npx vitest run test/review/r4-memory/maintenance-r4.test.ts
 */
import { appendFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SidebarModel } from '../../resources/world.js';
import { IDENTITY_KEYS } from '../../packs/world.js';
import { C } from '../../packs/world.js';
import { PROJECT, narrativeWorld } from '../../narrative/world.js';

vi.setConfig({ testTimeout: 7_200_000, hookTimeout: 7_200_000 });
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
const PEOPLE = Number(process.env.LKB_R4_CHARACTERS ?? 300);
const CHAPTERS = Number(process.env.LKB_R4_CHAPTERS ?? 20);
const REPORT = process.env.R4_MEMORY_REPORT;

async function settledMb(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / MB;
}
const say = (line: string) => {
  console.info(line);
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
};

describe.skipIf(process.env.LKB_MEASURE !== '1')('every maintenance job on a world with characters and a story', () => {
  it(`${PEOPLE} characters, ${CHAPTERS} chapters, each job three times`, async () => {
    const w = await narrativeWorld();
    try {
      const months = ['Camue', 'Jehet', 'Kumikas', 'Selaphos', 'Zahras'];
      for (let i = 0; i < PEOPLE; i++) {
        const id = `r4p${String(i).padStart(5, '0')}`;
        const name = `Varan Holt ${i}`;
        const born = `${months[i % months.length]} ${(i % 27) + 1}st, 4A ${100 + (i % 600)}`;
        w.repo.seed({
          id,
          name: `[BSRC] ${name} - Character Reference`,
          parentId: C.humans,
          referenceType: 'Compact Character Reference',
          canonical: name,
          tags: ['CANON', 'Character', 'Human'],
        });
        const v: Record<string, string> = {
          Status: 'Authoritative',
          'Continuity Type': 'CANON',
          Continuity: 'Main',
          Inheritance: 'None',
          Subject: name,
          'Canonical Display Name': name,
          'Personal / Given Name': 'Varan',
          'Family / Surname': `Holt ${i}`,
          Aliases: `the Holt of ${i}, Varan the ${i}th`,
          'Naming Culture': 'Velaran',
          'Reference Type': 'Compact Character Reference',
          Scope: `${name}, a person of Arkona`,
          'Race / Species': 'Human',
          'Temporal Scope': i % 3 === 0 ? `Born ${born}; Died 4A ${800 + (i % 100)}` : `Born ${born}`,
          'Life State': i % 3 === 0 ? 'Deceased' : 'Alive',
          'Last Major Revision': '2026-11-01',
          Supersedes: 'None',
        };
        w.sidebars.page(id, [
          SidebarModel.kv(
            `kv${id}`.slice(0, 8),
            'PROPERTIES',
            IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
          ),
          SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
        ]);
        w.setBody(
          id,
          Array.from({ length: 12 }, (_, k) => ({
            id: `${id}b${k}`,
            kind: 'paragraph',
            content: [
              {
                text:
                  k === 0
                    ? `${name} was born on ${born} in the harbour town.`
                    : `${name} kept the harbour roll, line ${k}, and the stores were counted again. `.repeat(2),
              },
            ],
          })),
        );
      }
      w.rebuildTree();
      await w.snapshot();
      const story = 'Holt Chronicle';
      expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: story })).status).toBe(
        'written',
      );
      for (let n = 1; n <= CHAPTERS; n++) {
        await w.tool('arkona_chapter_plan', { story, number: n, questionGate: 'closed' });
        const b = await w.tool('arkona_chapter_save', {
          story,
          number: n,
          title: `Roll ${n}`,
          inWorldDate: `4A ${300 + n}`,
          pov: 'Harun al-Saffar',
          charactersPresent: ['Harun al-Saffar'],
          locations: [],
          draftStatus: 'Draft',
          markdown: `Harun al-Saffar counted the roll for the ${n}th time. Varan Holt ${n} was born in 4A ${150 + n}.`,
        });
        expect(b.status, JSON.stringify(b).slice(0, 300)).toBe('written');
      }
      await w.snapshot();
      const rt: any = w.stack.runtime;
      const scheduler = rt.maintenance.scheduler;
      const jobs = (scheduler.list() as any[]).filter((j) => j.implemented).map((j) => j.id as string);
      say(`[R4 jobs] ${jobs.length} implemented jobs: ${jobs.join(', ')}`);
      const rows: { job: string; runs: number[]; outcome: string; ms: number; later?: number }[] = [];
      const start = await settledMb();
      say(`[R4 jobs] baseline ${start.toFixed(1)} MB (${PEOPLE} characters, ${CHAPTERS} chapters)`);
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
        let later: number | undefined;
        if (runs.some((x) => x >= 1)) {
          await new Promise((r) => setTimeout(r, 36_000));
          later = Math.round((await settledMb()) - jobStart);
        }
        rows.push({ job, runs, outcome, ms, ...(later !== undefined ? { later } : {}) });
        say(
          `[R4 jobs] ${job}: heap kept per run ${JSON.stringify(runs)} MB (${outcome}, ${ms} ms)` +
            (later !== undefined ? `; after the requests' 35-second timers, ${later} MB kept by the three runs` : ''),
        );
      }
      const all = Math.round((await settledMb()) - start);
      say(`[R4 jobs] all jobs: ${all} MB kept in all`);
      // The audit's findings of the new categories exist: the measurement exercised them.
      const cats = new Set(
        (rt.audits.list(PROJECT, { limit: 1000 }).findings as any[]).map((f) => String(f.code).split('_')[0]),
      );
      say(`[R4 jobs] finding categories after the audits: ${[...cats].sort().join(', ')}`);
      for (const r of rows) {
        expect(
          r.runs.slice(1).every((x) => x < 10),
          `${r.job} ${JSON.stringify(r.runs)}`,
        ).toBe(true);
        if (r.later !== undefined) expect(r.later, `${r.job} after the timers`).toBeLessThan(10);
      }
      expect(all).toBeLessThan(20);
    } finally {
      await w.close();
    }
  });
});
