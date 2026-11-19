/**
 * CR-2026-11-R3, R3-02 (High): a read a registered check could not make for budget was judged "changed since the write
 * was planned". Every setting-pack job (a package, a rename, a split, a retag batch) starts with registered checks; when
 * one of their reads met LegendKeeper's budget (a 429 whose Retry-After is longer than the bridge waits in place, or a
 * queue wait past 30 s), the engine turned the `BudgetWaitError` into a `VERSION_CONFLICT` ("subject changed since the
 * write was planned … actual: Rate budget for tier key-min is exhausted"): the job failed, nothing had changed, and the
 * owner was told the page had. Found while measuring a 700-page rename for the owner's fix B (its first check reads
 * every page it edits). Now the step is parked for the budget and runs again; the job then finishes.
 * Engine level, the mock LegendKeeper on a fake clock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { harness, origin, PROJECT, type Harness } from '../../jobs/helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('R3-02: a registered check that meets the budget is parked, never a false conflict', () => {
  it('the job waits for the budget, checks again and finishes; nothing is reported as changed', async () => {
    h = await harness();
    h.model.seedResource('r1', { name: 'Page' });
    const e = h.newEngine();
    let reads = 0;
    e.engine.registerAsyncChecker('r3.subject', async (ctx) => {
      reads++;
      const r = await ctx.read('getResource', { path: { resourceId: 'r1' } });
      const name = (r.body as { name?: string } | undefined)?.name;
      return name === 'Page'
        ? { differences: [] }
        : { differences: [{ path: 'subject', expected: 'Page', actual: name ?? '(gone)' }] };
    });
    // LegendKeeper refuses the check's read for 45 s (longer than the bridge waits in place).
    h.mock.inject((c) => c.method === 'GET' && /\/resources\/r1\/?$/.test(c.path), {
      kind: 'rate-limit',
      tier: 'key-min',
      retryAfterS: 45,
    });
    const sub = await e.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      internal: true,
      steps: [
        {
          op: 'bridge.expect',
          params: {
            body: { checks: [{ label: 'subject', kind: 'registered', checker: 'r3.subject', input: 1 }] },
          },
        },
        { op: 'updateResource', params: { path: { resourceId: 'r1' }, body: { name: 'Renamed' } } },
      ],
    });
    if (!('jobId' in sub)) throw new Error('expected a job');
    const job = () => e.engine.queries.getJob(PROJECT, sub.jobId)!;
    await h.drive(e, () => ['waiting_budget', 'failed', 'succeeded'].includes(job().status));
    // On the reviewed code: failed, VERSION_CONFLICT, "subject changed since the write was planned".
    expect(job().status, JSON.stringify(job().lastError)).toBe('waiting_budget');
    expect(job().lastError).toBeNull();
    expect(h.model.count('updateResource')).toBe(0);
    // The budget comes back: the check runs again, passes, and the write is made once.
    await h.drive(e, () => ['failed', 'succeeded', 'cancelled'].includes(job().status));
    expect(job().status, JSON.stringify(job().lastError)).toBe('succeeded');
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(h.model.count('updateResource')).toBe(1);
    expect(h.model.resources.get('r1')!.name).toBe('Renamed');
  });
});
