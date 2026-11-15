/**
 * RV4, locks (PLAN §6.2, ADR 0037 decision 13, ADR 0038's held documents): jobs holding many job-level locks, given in
 * different orders, against single-page writes and a document-holding job, all at once and with writes paused and
 * resumed part-way: nobody deadlocks, nobody starves, every job finishes. Measures; passes.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: LifecycleWorld;
beforeAll(async () => {
  w = await lifecycleWorld({ bulk: 60 });
});
afterAll(async () => w.close());

const origin = { kind: 'system' as const, tool: 'rv4_locks' };
const page = (i: number) => `bk${i.toString(36).padStart(6, '0')}`;
const tag = (id: string, t: string) => ({
  op: 'updateResource',
  params: { path: { resourceId: id }, body: { tags: [...w.repo.res.get(id)!.tags, t] } },
});

it('overlapping many-lock jobs, single writes and a held document: all finish, with a pause in the middle', async () => {
  const engine = w.stack.runtime.engine;
  // 40 pages; three "sets" of 20 overlapping, each listing its pages in a different order.
  const ids = Array.from({ length: 40 }, (_, i) => page(i + 1)).filter((id) => w.repo.res.get(id));
  expect(ids.length).toBeGreaterThanOrEqual(40);
  const sets = [
    ids.slice(0, 20),
    ids.slice(10, 30).reverse(),
    [...ids.slice(5, 15), ...ids.slice(25, 35)].sort().reverse(),
  ];
  const jobs: string[] = [];
  const submit = async (req: Record<string, unknown>) => {
    const r = (await engine.submit({
      kind: 'batch_ops',
      project: PROJECT,
      origin,
      internal: true,
      ...req,
    } as never)) as {
      jobId?: string;
    };
    expect(r.jobId, JSON.stringify(r)).toBeTruthy();
    jobs.push(r.jobId!);
  };
  for (const [n, s] of sets.entries()) {
    await submit({
      holdLock: { resourceId: s[0]! },
      holdMore: { resources: s.slice(1) },
      steps: s.map((id) => tag(id, `set${n}`)),
    });
    // Single-page writes on pages of the set, in between.
    for (const id of s.filter((_, i) => i % 5 === 2)) await submit({ steps: [tag(id, `single${n}`)] });
  }
  // A job holding one page's lock and one of its documents (as a chronology or note job does).
  const doc = w.repo.liveDocs(w.repo.res.get(ids[12]!)!)[0]!;
  await submit({
    holdLock: { resourceId: ids[12]! },
    holdDocuments: [doc.id],
    steps: [tag(ids[12]!, 'doc-holder')],
  });
  // Pause writes for a moment while they run, then resume.
  await new Promise((r) => setTimeout(r, 30));
  engine.controls.pauseWrites('rv4');
  await new Promise((r) => setTimeout(r, 200));
  engine.controls.resumeWrites('rv4');
  const done = [];
  for (const id of jobs) done.push(await engine.wait(PROJECT, id, 25_000));
  for (let i = 0; i < 4 && done.some((j) => !['succeeded', 'failed', 'cancelled'].includes(j.status)); i++)
    for (const [k, id] of jobs.entries()) done[k] = await engine.wait(PROJECT, id, 25_000);
  process.stdout.write(
    `locks: ${jobs.length} jobs (3 holding 20 locks each, overlapping, given in different orders): ${done.filter((j) => j.status === 'succeeded').length} succeeded; ${
      done
        .map((j) => j.status)
        .filter((s) => s !== 'succeeded')
        .join(', ') || 'none other'
    }\n`,
  );
  expect(
    done.every((j) => j.status === 'succeeded'),
    JSON.stringify(done.map((j) => [j.status, j.lastError])),
  ).toBe(true);
});
