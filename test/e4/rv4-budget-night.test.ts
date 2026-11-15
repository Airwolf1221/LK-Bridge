/**
 * RV4, budgets (PLAN §5.2, ADR 0042): a night on Arkona on the governor's own fake clock, at LegendKeeper's PUBLISHED
 * limits and the default floors (P1 10 %, P2 25 %, P3 50 %). This measures; it does not find a defect.
 *
 * - the nightly full snapshot: 3,400 sequential P3 reads (ADR 0042's Arkona figure), giving way while P1 or P2 work is
 *   queued (the service's 250 ms waits, at most a minute a page) and waiting out a BudgetWaitError (its reader's loop);
 * - two more P3 jobs at once (the link sweep at 01:15, 45 minutes after the snapshot's 00:30, and the tree check), each
 *   at four reads in flight as the tree's passes read: 1,600 and 1,500 reads;
 * - agents throughout: a tool call of six sequential P1 reads every 15 s, and a P2 job (40 reads, 20 writes) every 5 min.
 *
 * Each request takes 40 ms of fake time. Every dispatch is recorded with its class, so the sliding-window maxima are
 * computed afterwards, independently of the governor's own windows.
 */
import { expect, it, vi } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import type { PriorityClass } from '../../src/config/lk.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import { FakeClock, sleep } from '../../src/lk/governor/clock.js';
import { Governor } from '../../src/lk/governor/governor.js';
import { json, READ, WRITE } from '../unit/governor-helpers.js';

vi.setConfig({ testTimeout: 600_000 });

const LAT = 40;

it('a night on Arkona: the full snapshot and two sweeps at P3 beside agents at P1 and P2', async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 16, 0, 30, 0));
  const t0 = clock.now();
  const sent: { at: number; p: PriorityClass; write: boolean }[] = [];
  const governor = new Governor({
    settings: defaultGovernorSettings({ writeSpacingMs: 500 }),
    clock,
    random: () => 0.5,
    transport: async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      sent.push({
        at: clock.now(),
        p: u.searchParams.get('p') as PriorityClass,
        write: init?.method !== 'GET',
      });
      await sleep(clock, LAT);
      return json(200, { ok: true });
    },
  });
  let n = 0;
  const call = (p: PriorityClass, write = false, jobId?: string) =>
    governor.execute<Response>({
      opId: write ? 'updateResource' : 'getResource',
      kind: write ? 'write' : 'read',
      costs: write ? WRITE : READ,
      priority: p,
      ...(jobId ? { jobId } : {}),
      ...(write ? { idempotencyKey: `k${n++}` } : {}),
      run: (signal) =>
        governor.fetch(`http://lk.test/api/v3/x?p=${p}`, {
          method: write ? 'PATCH' : 'GET',
          signal,
          headers: {},
        }),
    });
  const busy = () => {
    const q = governor.snapshot().queues;
    return q.P1 + q.P2 > 0;
  };
  /** A P3 read as the snapshot's and the tree's readers make it: a budget wait is slept out, then tried again. */
  const p3 = async (jobId: string, waits: { n: number; ms: number }) => {
    for (;;) {
      try {
        return await call('P3', false, jobId);
      } catch (e) {
        if (!(e instanceof BudgetWaitError)) throw e;
        const ms = Math.max(1000, e.retryAtMs - clock.now());
        waits.n++;
        waits.ms += ms;
        await sleep(clock, ms);
      }
    }
  };

  // --- the full snapshot: sequential, giving way while agents' work is queued.
  const snap = { done: 0, yields: 0, finishedAt: 0, waits: { n: 0, ms: 0 } };
  const snapshot = (async () => {
    for (let i = 0; i < 3400; i++) {
      for (let k = 0; k < 240 && busy(); k++) {
        snap.yields++;
        await sleep(clock, 250);
      }
      await p3('snapshot', snap.waits);
      snap.done++;
    }
    snap.finishedAt = clock.now();
  })();

  // --- two sweeps, four reads in flight each, from 45 minutes in.
  const sweeps: {
    name: string;
    reads: number;
    done: number;
    finishedAt: number;
    waits: { n: number; ms: number };
  }[] = [
    { name: 'link sweep', reads: 1600, done: 0, finishedAt: 0, waits: { n: 0, ms: 0 } },
    { name: 'tree check', reads: 1500, done: 0, finishedAt: 0, waits: { n: 0, ms: 0 } },
  ];
  const sweepRuns = sweeps.map(async (s) => {
    await sleep(clock, 45 * 60_000);
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < s.reads) {
          next++;
          await p3(s.name, s.waits);
          s.done++;
        }
      }),
    );
    s.finishedAt = clock.now();
  });

  // --- agents for three hours: P1 tool calls and P2 jobs.
  const p1Delays: number[] = [];
  const p2Delays: number[] = [];
  const timed = async (p: PriorityClass, write: boolean, out: number[], jobId?: string) => {
    const asked = clock.now();
    const before = sent.length;
    await call(p, write, jobId);
    const mine = sent.slice(before).find((x) => x.p === p);
    out.push((mine?.at ?? clock.now()) - asked);
  };
  let agentsOn = true;
  const agents = (async () => {
    let tick = 0;
    const jobs: Promise<void>[] = [];
    while (clock.now() - t0 < 3 * 3600_000) {
      if (tick % 20 === 0) {
        const id = `job${tick}`;
        jobs.push(
          (async () => {
            for (let i = 0; i < 40; i++) await timed('P2', false, p2Delays, id);
            for (let i = 0; i < 20; i++) await timed('P2', true, p2Delays, id);
          })(),
        );
      }
      jobs.push(
        (async () => {
          for (let i = 0; i < 6; i++) await timed('P1', false, p1Delays);
        })(),
      );
      tick++;
      await sleep(clock, 15_000);
    }
    await Promise.all(jobs);
    agentsOn = false;
  })();

  await clock.runUntil(
    () => snap.finishedAt > 0 && sweeps.every((s) => s.finishedAt > 0) && !agentsOn,
    6 * 3600_000,
  );
  await Promise.all([snapshot, ...sweepRuns, agents]);

  // --- independent sliding-window maxima from the dispatch log.
  const maxIn = (windowMs: number, pred: (x: (typeof sent)[number]) => boolean) => {
    const ev = sent.filter(pred).map((x) => x.at);
    let lo = 0;
    let best = 0;
    for (let hi = 0; hi < ev.length; hi++) {
      while (ev[lo]! <= ev[hi]! - windowMs) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    return best;
  };
  const all = () => true;
  const isP3 = (x: (typeof sent)[number]) => x.p === 'P3';
  const minute = { all: maxIn(60_000, all), p3: maxIn(60_000, isP3) };
  const hour = { all: maxIn(3_600_000, all), p3: maxIn(3_600_000, isP3) };
  const day = sent.length;
  const pct = (xs: number[], q: number) =>
    [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  // Gaps in the snapshot's dispatches longer than 5 minutes: where it stopped at the floor.
  const snapAt = sent.filter(isP3).map((x) => x.at);
  let longest = 0;
  for (let i = 1; i < snapAt.length; i++) longest = Math.max(longest, snapAt[i]! - snapAt[i - 1]!);
  const min = (ms: number) => (ms / 60_000).toFixed(1);
  process.stdout.write(
    [
      `night on Arkona (fake clock, published limits, floors P1 10% P2 25% P3 50%):`,
      `  full snapshot 3,400 reads: finished after ${min(snap.finishedAt - t0)} min; ${snap.yields} yields of 250 ms; ${snap.waits.n} budget waits (${min(snap.waits.ms)} min)`,
      ...sweeps.map(
        (s) =>
          `  ${s.name} ${s.reads} reads: finished after ${min(s.finishedAt - t0)} min; ${s.waits.n} budget waits (${min(s.waits.ms)} min)`,
      ),
      `  longest pause in P3 dispatches: ${min(longest)} min`,
      `  max in any minute: ${minute.all} (P3 ${minute.p3}) of 300; max in any hour: ${hour.all} (P3 ${hour.p3}) of 6,000; total requests ${day} (key-day 60,000)`,
      `  P1 dispatch delay: n=${p1Delays.length} median ${pct(p1Delays, 0.5)} ms, p99 ${pct(p1Delays, 0.99)} ms, max ${Math.max(...p1Delays)} ms`,
      `  P2 dispatch delay: n=${p2Delays.length} median ${pct(p2Delays, 0.5)} ms, p99 ${pct(p2Delays, 0.99)} ms, max ${Math.max(...p2Delays)} ms`,
    ].join('\n') + '\n',
  );

  // The floors held for P3 together (three jobs at once), and LegendKeeper's limits for everything.
  expect(minute.p3).toBeLessThanOrEqual(150);
  expect(hour.p3).toBeLessThanOrEqual(3000);
  expect(minute.all).toBeLessThanOrEqual(300);
  expect(hour.all).toBeLessThanOrEqual(6000);
  // The snapshot stopped at the maintenance floor (the key-hour's 3,000 for P3) and resumed when it freed.
  expect(snap.waits.n + sweeps.reduce((a, s) => a + s.waits.n, 0)).toBeGreaterThan(0);
  expect(snap.done).toBe(3400);
  // Agents were served promptly throughout: reads are not paced, so a P1 read never waits on P3.
  expect(Math.max(...p1Delays)).toBeLessThan(1000);
});
