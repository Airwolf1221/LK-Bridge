/**
 * CR-2026-11-R3, R3-64 (High): a long run of steps that need no request blocked the bridge. Found measuring the
 * 700-page rename for the owner's fix B: its ~1,400 Last Major Revision decisions (each "not a major revision") and the
 * row writes they skip completed one after another without giving the event loop a turn, for about 10 seconds: the
 * bridge answered nothing meanwhile (MCP, the dashboard, its health check), and its memory rose by about 350 MB that was
 * not given back (the rename's peak was +561 to +683 MB over the baseline, above the owner's 400 MB ceiling; now about
 * +330 MB). The job runner now yields every few steps. Engine level, the mock LegendKeeper on a fake clock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { harness, origin, PROJECT, type Harness } from '../../jobs/helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('R3-64: a job of request-free steps gives the event loop a turn as it goes', () => {
  it('other work runs while 400 such steps do', async () => {
    h = await harness();
    const e = h.newEngine();
    e.engine.registerAsyncChecker('r3.noop', () => Promise.resolve({ differences: [] }));
    // The event loop's turns, counted while the job runs.
    let turns = 0;
    let ticking = true;
    const tick = () => {
      turns++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const at: Record<string, number> = {};
    const off = e.engine.events.on('job', (ev: { job: { status: string } }) => {
      if (at[ev.job.status] === undefined) at[ev.job.status] = turns;
    });
    const sub = await e.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      origin,
      internal: true,
      steps: Array.from({ length: 400 }, (_, i) => ({
        op: 'bridge.expect',
        params: {
          body: { checks: [{ label: `noop ${i}`, kind: 'registered', checker: 'r3.noop', input: i }] },
        },
      })),
    });
    if (!('jobId' in sub)) throw new Error('expected a job');
    const job = () => e.engine.queries.getJob(PROJECT, sub.jobId)!;
    await h.drive(e, () => job().status === 'succeeded', 60_000);
    ticking = false;
    off();
    // On the reviewed code the 400 steps ran in one stretch: no turn of the event loop between running and succeeded.
    expect(at.succeeded! - at.running!, JSON.stringify(at)).toBeGreaterThanOrEqual(20);
  });
});
