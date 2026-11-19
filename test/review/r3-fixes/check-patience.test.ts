/**
 * CR-2026-11-R3, R3-62 (High): a job whose first check needs more reads than an hour's budget allows never finished.
 * Found measuring the 700-page rename for the owner's fix B: its first check makes about 6,000 reads, and a job may use
 * 90% of LegendKeeper's 6,000 an hour (the reserve floors). Two things stopped it:
 *
 * 1. Once the hour was spent, the check's next read had to wait longer than the bridge waits in a queue (30 s): the step
 *    was parked (R3-02) and, an hour later, ran again from its start, read the same pages again, and parked again.
 * 2. Even a check that finished had spent the hour, so the first write then waited for the budget too; and a job that
 *    goes on after a wait before its first write runs its checks again whole (R2-29): the same hour again, every time.
 *
 * On the reviewed code the read failed the job with a false VERSION_CONFLICT (R3-02). Now a check's (and a read-back's)
 * reads, in a job holding no job-level lock, wait for the budget in their queue (behind every call of a higher priority;
 * a cancel, a pause or a restart still ends the wait at once), and a check of more than 300 estimated reads runs again
 * light after a wait: only its governance checks (the ones R2-29 is about), keeping its result; what it judged of each
 * page is judged again inside each write's lock. Engine level, the mock LegendKeeper on a fake clock; the hourly tier
 * set to 200 reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIER_LIMITS } from '../../../src/config/index.js';
import { harness, origin, PROJECT, type Harness } from '../../jobs/helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PAGES = 310;
const id = (i: number) => `pg${String(i).padStart(4, '0')}`;

async function world() {
  h = await harness();
  for (let i = 0; i < PAGES; i++) h.model.seedResource(id(i), { name: `Page ${i}` });
  const e = h.newEngine({ governor: { tierLimits: { ...DEFAULT_TIER_LIMITS, 'key-hour': 200 } } });
  const reads = new Map<string, number>();
  let governance = 0;
  e.engine.registerAsyncChecker('r3.page', async (ctx) => {
    const page = ctx.input as string;
    await ctx.read('getResource', { path: { resourceId: page } });
    reads.set(page, (reads.get(page) ?? 0) + 1);
    return { differences: [] };
  });
  e.engine.registerAsyncChecker('r3.governance', () => {
    governance++;
    return Promise.resolve({ differences: [] });
  });
  e.engine.markRelockCheck('r3.governance');
  const sub = await e.engine.submit({
    project: PROJECT,
    kind: 'batch_ops',
    origin,
    internal: true,
    steps: [
      {
        op: 'bridge.expect',
        params: {
          body: {
            checks: [
              { label: 'governance', kind: 'registered', checker: 'r3.governance', input: 1 },
              ...Array.from({ length: PAGES }, (_, i) => ({
                label: `page ${i}`,
                kind: 'registered',
                checker: 'r3.page',
                input: id(i),
              })),
            ],
          },
        },
      },
      { op: 'updateResource', params: { path: { resourceId: id(0) }, body: { name: 'Renamed' } } },
    ],
  });
  if (!('jobId' in sub)) throw new Error('expected a job');
  return { e, reads, governance: () => governance, jobId: sub.jobId };
}

describe('R3-62: a check needing more reads than an hour allows finishes, and the job writes', () => {
  it('each page is read once, the governance is checked again after the wait, and the write is made', async () => {
    const { e, reads, governance, jobId } = await world();
    const job = () => e.engine.queries.getJob(PROJECT, jobId)!;
    // The first write meets the budget too, before anything is sent: LegendKeeper refuses its read inside the lock (the
    // second read of that page; the check made the first) for two minutes. The job waits, then goes on, its check run
    // again light.
    let seen = 0;
    h!.mock.inject((c) => c.method === 'GET' && /\/resources\/pg0000\/?$/.test(c.path) && ++seen === 2, {
      kind: 'rate-limit',
      tier: 'key-min',
      retryAfterS: 120,
    });
    const started = h!.clock.now();
    await h!.drive(e, () => ['failed', 'succeeded', 'cancelled'].includes(job().status), 6 * 3600_000);
    // On the reviewed code: failed (a false VERSION_CONFLICT); with R3-02 alone, the check started over every hour.
    expect(job().status, JSON.stringify(job().lastError)).toBe('succeeded');
    expect(reads.size).toBe(PAGES);
    expect([...reads.values()].every((n) => n === 1)).toBe(true); // never read again
    expect(h!.model.resources.get(id(0))!.name).toBe('Renamed');
    // It waited for the hourly budget, and the governance check ran again when the job went on after its wait.
    expect(h!.clock.now() - started).toBeGreaterThan(30 * 60_000);
    expect(governance()).toBeGreaterThanOrEqual(2);
  });

  it('a cancel ends the wait at once: nothing is written', async () => {
    const { e, reads, jobId } = await world();
    const job = () => e.engine.queries.getJob(PROJECT, jobId)!;
    // Run until the check has spent the hour and its next read waits in the queue.
    await h!.drive(e, () => reads.size >= 150, 10 * 60_000);
    e.engine.controls.cancel(PROJECT, jobId);
    await h!.drive(e, () => ['failed', 'succeeded', 'cancelled'].includes(job().status), 60_000);
    expect(job().status).toBe('cancelled');
    expect(h!.model.count('updateResource')).toBe(0);
  });
});
