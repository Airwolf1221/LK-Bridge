/**
 * v3 F9 (ADR 0074): the bulk class, P4, on the governor's fake clock.
 *
 * - P4 waits while P1 or P2 work is queued, as P3 does;
 * - P3 goes before P4 when both are ready, and P4 goes when no P3 call is ready (it is not held up by queued P3 work);
 * - P4 uses a tier only down to its own floor (70% by default), so it never eats the headroom P3 relies on;
 * - a trickle of P3 work never starves a bulk pass;
 * - bulk lanes take turns;
 * - a P4 call is always patient (a long wait is waited, never a `BudgetWaitError` from the queue).
 */
import { describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import { formatBudgetFooter } from '../../src/lk/governor/footer.js';
import { sleep } from '../../src/lk/governor/clock.js';
import type { PriorityClass } from '../../src/lk/governor/types.js';
import { READ, setup, track, WRITE } from './governor-helpers.js';

// key-min = 100 makes the floors easy to read: P1 90, P2 75, P3 50, P4 30.
const tierLimits = { ...defaultGovernorSettings().tierLimits, 'key-min': 100 };

/** Who was sent, in order (each call tags its request). */
function tagged(env: ReturnType<typeof setup>) {
  return (tag: string, priority: PriorityClass, o: { write?: boolean; jobId?: string } = {}) =>
    env.call({
      priority,
      costs: o.write ? WRITE : READ,
      ...(o.write ? { idempotencyKey: `k-${tag}` } : {}),
      ...(o.jobId !== undefined ? { jobId: o.jobId } : {}),
      headers: { 'x-tag': tag },
    });
}
const sentTags = (env: ReturnType<typeof setup>) => env.seen.map((s) => s.headers.get('x-tag'));

describe('P4 (bulk) scheduling', () => {
  it('waits while P1 or P2 work is queued, exactly as P3 does', async () => {
    for (const agent of ['P1', 'P2'] as const) {
      const env = setup();
      const call = tagged(env);
      await call('warm', 'P0', { write: true }); // starts the write gap
      const job = track(call(agent, agent, { write: true }));
      const bulk = track(call('bulk', 'P4'));
      await env.clock.advance(100);
      expect(bulk.done).toBe(false); // free to go budget-wise, but the agent's write is queued
      await env.clock.advance(400);
      expect(job.done && bulk.done).toBe(true);
      expect(sentTags(env)).toEqual(['warm', agent, 'bulk']);
    }
  });

  it('P3 goes before P4 when both are ready (whatever order they were queued in)', async () => {
    const env = setup();
    const call = tagged(env);
    await call('warm', 'P0', { write: true });
    const order: string[] = [];
    const bulk = call('bulk', 'P4', { write: true }).then(() => order.push('P4'));
    const routine = call('routine', 'P3', { write: true }).then(() => order.push('P3'));
    await env.clock.advance(2000);
    await Promise.all([bulk, routine]);
    expect(order).toEqual(['P3', 'P4']);
  });

  it('goes when P3 is idle, and is not held up by P3 work that is not ready yet', async () => {
    const env = setup();
    const call = tagged(env);
    await call('warm', 'P0', { write: true });
    const routineWrite = track(call('routine', 'P3', { write: true })); // waits for the write gap
    const bulkRead = track(call('bulk', 'P4')); // ready now
    await env.clock.advance(0);
    expect(bulkRead.done).toBe(true);
    expect(routineWrite.done).toBe(false);
    await env.clock.advance(500);
    expect(routineWrite.done).toBe(true);
    expect(sentTags(env)).toEqual(['warm', 'bulk', 'routine']);
  });

  it('never goes past its floor (30 of 100), and leaves P3 its own headroom', async () => {
    const env = setup({ tierLimits, maxInFlight: 1000 });
    const bulk = Array.from({ length: 60 }, () => track(env.call({ priority: 'P4' })));
    await env.clock.advance(0);
    expect(bulk.filter((c) => c.done).length).toBe(30);
    expect(bulk.every((c) => !c.error)).toBe(true); // the rest wait (patient), none refused
    expect(env.used('key-min')).toBe(30);
    // Routine maintenance still has the 20 between bulk's 70% and its own 50% floor.
    const routine = Array.from({ length: 30 }, () => track(env.call({ priority: 'P3' })));
    await env.clock.advance(0);
    expect(routine.filter((c) => c.done && !c.error).length).toBe(20);
    expect(env.used('key-min')).toBe(50);
    expect(bulk.filter((c) => c.done).length).toBe(30);
  });

  it('uses the configured bulk floor, and the estimate uses it too', async () => {
    const env = setup({
      tierLimits,
      maxInFlight: 1000,
      reserveFloors: { P0: 0, P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.9 },
    });
    const calls = Array.from({ length: 20 }, () => track(env.call({ priority: 'P4' })));
    await env.clock.advance(0);
    expect(calls.filter((c) => c.done)).toHaveLength(10);
    const e = env.governor.estimate({ reads: 100, priority: 'P4' });
    expect(e.tiers.find((t) => t.tier === 'key-min')?.capacityPerWindow).toBe(10);
  });

  it('a trickle of P3 work never starves a bulk pass', async () => {
    const env = setup({ tierLimits, maxInFlight: 1000 });
    const t0 = env.clock.now();
    // Routine work: one P3 read every 4 seconds (15 a minute) for the whole test, each timed from asking to sending.
    const p3Delays: number[] = [];
    let trickling = true;
    const trickle = (async () => {
      while (trickling) {
        const asked = env.clock.now();
        const before = env.seen.length;
        await env.call({ priority: 'P3' });
        p3Delays.push((env.seen[before]?.atMs ?? env.clock.now()) - asked);
        await sleep(env.clock, 4000);
      }
    })();
    // A bulk pass: 300 sequential reads, each waited out however long (it is patient).
    let done = 0;
    let finishedAt = 0;
    const pass = (async () => {
      for (let i = 0; i < 300; i++) {
        await env.call({ priority: 'P4', jobId: 'snapshot' });
        done++;
      }
      finishedAt = env.clock.now();
    })();
    await env.clock.runUntil(() => finishedAt > 0, 2 * 3600_000);
    trickling = false;
    await env.clock.advance(5000);
    await Promise.all([pass, trickle]);
    expect(done).toBe(300);
    // 15 a minute for bulk at worst (its 30 less the trickle's 15): about 20 minutes, and well within 30.
    expect(finishedAt - t0).toBeLessThan(30 * 60_000);
    // Routine work went at once every time: bulk never sat in front of it.
    expect(Math.max(...p3Delays)).toBe(0);
  });

  it('bulk lanes take turns (two passes share P4 fairly)', async () => {
    const env = setup();
    const call = tagged(env);
    await call('warm', 'P0', { write: true });
    const all: Promise<unknown>[] = [];
    for (const lane of ['A', 'B'])
      for (let i = 1; i <= 3; i++) all.push(call(`${lane}${i}`, 'P4', { write: true, jobId: lane }));
    await env.clock.advance(10_000);
    await Promise.all(all);
    expect(sentTags(env).slice(1)).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
  });

  it('is patient: a long wait is waited, where the same call at P3 surfaces BudgetWaitError', async () => {
    const env = setup({ tierLimits, maxInFlight: 1000 });
    for (let i = 0; i < 50; i++) await env.call({ priority: 'P3' }); // the window is at P3's floor, and P4's is past
    const routine = track(env.call({ priority: 'P3' }));
    const bulk = track(env.call({ priority: 'P4' }));
    await env.clock.advance(0);
    expect(routine.error).toBeInstanceOf(BudgetWaitError); // ~60 s away, past maxQueueWaitMs (30 s)
    expect(bulk.done).toBe(false); // still queued
    await env.clock.advance(60_000);
    expect(bulk.done).toBe(true);
    expect(bulk.error).toBeUndefined();
  });

  it('shows in the queue depths and the budget footer', async () => {
    const env = setup();
    await env.call({ costs: WRITE, priority: 'P0', idempotencyKey: 'k0' });
    void env.call({ costs: WRITE, priority: 'P4', idempotencyKey: 'k1' });
    void env.call({ costs: WRITE, priority: 'P4', idempotencyKey: 'k2' });
    await env.clock.advance(0);
    const snap = env.governor.snapshot();
    expect(snap.queues).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0, P4: 2 });
    expect(formatBudgetFooter(snap)).toMatch(/queue P1:0 P2:0 P4:2$/);
    await env.clock.advance(5000);
    expect(formatBudgetFooter(env.governor.snapshot())).toMatch(/queue P1:0 P2:0$/);
  });
});

describe('P4 reserve floor ordering (setReserveFloors)', () => {
  it('keeps interactive <= job <= maintenance <= bulk', () => {
    const { governor } = setup();
    governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.8 });
    expect(governor.settings.reserveFloors).toEqual({ P0: 0, P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.8 });
    expect(() => governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.6, P4: 0.55 })).toThrow(
      /bulk floor \(55%\) is below the maintenance floor \(60%\)/,
    );
    expect(() => governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.5, P4: 1.2 })).toThrow(RangeError);
    expect(governor.settings.reserveFloors.P4).toBe(0.8); // a refused change leaves the floors as they were
  });

  it('without P4, the bulk floor is the default, raised to a P3 floor above it', () => {
    const { governor } = setup();
    governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.5 });
    expect(governor.settings.reserveFloors.P4).toBe(0.7);
    governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.85 });
    expect(governor.settings.reserveFloors.P4).toBe(0.85);
    expect(
      defaultGovernorSettings({ reserveFloors: { P0: 0, P1: 0.1, P2: 0.2, P3: 0.9 } }).reserveFloors.P4,
    ).toBe(0.9);
  });
});
