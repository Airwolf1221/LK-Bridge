/**
 * Drives a FakeClock against real HTTP I/O: virtual time only moves once every in-flight request has settled in
 * real time, which models a zero-latency network. Hung requests are given `settleRealMs` of real time, after
 * which virtual time moves on (so the governor's timeout can fire).
 */
import { flushMicrotasks, sleep, type FakeClock } from '../../src/lk/governor/clock.js';
import type { Governor } from '../../src/lk/governor/governor.js';
import { BudgetWaitError } from '../../src/lk/errors.js';

const realDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function settle(governor: Governor, settleRealMs: number): Promise<void> {
  const start = performance.now();
  await flushMicrotasks();
  while (governor.snapshot().inFlight > 0 && performance.now() - start < settleRealMs) {
    await realDelay(1);
    await flushMicrotasks();
  }
}

export async function drive(
  clock: FakeClock,
  governor: Governor,
  done: () => boolean,
  opts: { maxVirtualMs?: number; settleRealMs?: number } = {},
): Promise<void> {
  const limit = clock.now() + (opts.maxVirtualMs ?? 24 * 3600_000);
  const settleRealMs = opts.settleRealMs ?? 2000;
  let idle = 0;
  while (!done()) {
    await settle(governor, settleRealMs);
    if (done()) break;
    const next = clock.nextTimerAt();
    if (next === undefined) {
      if (++idle > 200) throw new Error('drive: nothing scheduled and work not done');
      await realDelay(5);
      continue;
    }
    idle = 0;
    if (next > limit) throw new Error('drive: virtual time limit reached');
    await clock.runNext();
  }
}

export interface RunLog {
  ok: number;
  parked: number;
  failed: unknown[];
}

/** Runs steps in order like a job: a BudgetWaitError parks the step until `retryAtMs`, then it is retried. */
export async function runSteps(
  clock: FakeClock,
  steps: Array<() => Promise<unknown>>,
  log: RunLog,
): Promise<void> {
  for (const step of steps) {
    for (;;) {
      try {
        await step();
        log.ok++;
        break;
      } catch (e) {
        if (e instanceof BudgetWaitError && Number.isFinite(e.retryAtMs)) {
          log.parked++;
          await sleep(clock, e.retryAtMs - clock.now());
          continue;
        }
        log.failed.push(e);
        break;
      }
    }
  }
}
