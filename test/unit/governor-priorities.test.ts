import { describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import type { PriorityClass } from '../../src/lk/governor/types.js';
import { READ, setup, track, WRITE } from './governor-helpers.js';

// key-min = 100 makes the floor arithmetic easy to read: P0 100, P1 90, P2 75, P3 50.
const tierLimits = { ...defaultGovernorSettings().tierLimits, 'key-min': 100 };

async function burst(priority: PriorityClass, n: number) {
  const env = setup({ tierLimits, maxInFlight: 1000 });
  const calls = Array.from({ length: n }, () => track(env.call({ priority })));
  await env.clock.advance(0);
  return { env, calls, done: calls.filter((c) => c.done && !c.error).length };
}

describe('reserve floors', () => {
  it.each([
    ['P0', 100],
    ['P1', 90],
    ['P2', 75],
    ['P3', 50],
  ] as const)('%s may use the tier down to its floor (%i of 100)', async (priority, allowed) => {
    const { env, done } = await burst(priority, 120);
    expect(done).toBe(allowed);
    expect(env.used('key-min')).toBe(allowed);
  });

  it('a call that would wait past maxQueueWaitMs surfaces BudgetWaitError with tier and retry time', async () => {
    const { env, calls } = await burst('P2', 80);
    const waits = calls.filter((c) => c.error instanceof BudgetWaitError);
    expect(waits).toHaveLength(5);
    const err = waits[0]!.error as BudgetWaitError;
    expect(err.tier).toBe('key-min');
    expect(err.retryAtMs).toBe(env.clock.now() + 60_000);
    expect(err.classification).toBe('budget');
  });

  it('queues (rather than failing) when room frees within maxQueueWaitMs', async () => {
    const env = setup({ tierLimits, maxInFlight: 1000 });
    for (let i = 0; i < 75; i++) void env.call({ priority: 'P2' });
    await env.clock.advance(40_000);
    const late = track(env.call({ priority: 'P2' })); // oldest unit leaves at 60 s, 20 s from now
    await env.clock.advance(19_999);
    expect(late.done).toBe(false);
    await env.clock.advance(1);
    expect(late.done).toBe(true);
    expect(late.error).toBeUndefined();
  });

  it('floors are configurable', async () => {
    const env = setup({ tierLimits, maxInFlight: 1000, reserveFloors: { P0: 0, P1: 0.1, P2: 0.5, P3: 0.8 } });
    const calls = Array.from({ length: 60 }, () => track(env.call({ priority: 'P2' })));
    await env.clock.advance(0);
    expect(calls.filter((c) => c.done && !c.error)).toHaveLength(50);
  });
});

describe('priority classes and fair share', () => {
  it('dispatches higher classes first when budget frees', async () => {
    const env = setup();
    const order: string[] = [];
    await env.call({ costs: WRITE, priority: 'P0' }); // starts the pacing gap
    const p2 = env.call({ costs: WRITE, priority: 'P2' }).then(() => order.push('P2'));
    const p1 = env.call({ costs: WRITE, priority: 'P1' }).then(() => order.push('P1'));
    const p0 = env.call({ costs: WRITE, priority: 'P0' }).then(() => order.push('P0'));
    await env.clock.advance(2000);
    await Promise.all([p0, p1, p2]);
    expect(order).toEqual(['P0', 'P1', 'P2']);
  });

  it('P3 runs only while no P1/P2 work is queued', async () => {
    const env = setup();
    const order: string[] = [];
    await env.call({ costs: WRITE, priority: 'P0' });
    const job = env.call({ costs: WRITE, priority: 'P2' }).then(() => order.push('P2 write'));
    const maint = env.call({ costs: READ, priority: 'P3' }).then(() => order.push('P3 read'));
    await env.clock.advance(100);
    expect(order).toEqual([]); // the P3 read is free to go budget-wise but waits for the queued P2
    await env.clock.advance(400);
    await Promise.all([job, maint]);
    expect(order).toEqual(['P2 write', 'P3 read']);
  });

  it('reads are not held up by write pacing in other lanes', async () => {
    const env = setup();
    await env.call({ costs: WRITE, priority: 'P2', jobId: 'a' });
    const w = track(env.call({ costs: WRITE, priority: 'P2', jobId: 'a' }));
    const r = track(env.call({ costs: READ, priority: 'P2', jobId: 'b' }));
    await env.clock.advance(0);
    expect(w.done).toBe(false);
    expect(r.done).toBe(true);
  });

  it('is FIFO within a job and round-robin across jobs', async () => {
    const env = setup();
    await env.call({ costs: WRITE, priority: 'P2', jobId: 'warmup' });
    const order: string[] = [];
    const all: Promise<unknown>[] = [];
    for (const job of ['A', 'B']) {
      for (let i = 1; i <= 3; i++) {
        all.push(env.call({ costs: WRITE, priority: 'P2', jobId: job }).then(() => order.push(`${job}${i}`)));
      }
    }
    for (let i = 1; i <= 2; i++) {
      all.push(env.call({ costs: WRITE, priority: 'P2', jobId: 'C' }).then(() => order.push(`C${i}`)));
    }
    await env.clock.advance(10_000);
    await Promise.all(all);
    expect(order).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3']);
  });

  it('reports queue depth per class', async () => {
    const env = setup();
    await env.call({ costs: WRITE, priority: 'P0' });
    void env.call({ costs: WRITE, priority: 'P1' });
    void env.call({ costs: WRITE, priority: 'P2' });
    void env.call({ costs: WRITE, priority: 'P2' });
    await env.clock.advance(0);
    expect(env.governor.snapshot().queues).toEqual({ P0: 0, P1: 1, P2: 2, P3: 0 });
    await env.clock.advance(5000);
  });

  it('caps concurrent in-flight requests', async () => {
    const releases: Array<() => void> = [];
    const env = setup(
      { maxInFlight: 2 },
      () => new Promise<Response>((r) => releases.push(() => r(new Response('{}')))),
    );
    const calls = Array.from({ length: 3 }, () => track(env.call()));
    await env.clock.advance(0);
    expect(env.seen).toHaveLength(2);
    releases[0]!();
    await env.clock.advance(0);
    expect(env.seen).toHaveLength(3);
    releases.forEach((r) => r());
    await env.clock.advance(0);
    expect(calls.every((c) => c.done)).toBe(true);
  });
});
