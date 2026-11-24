/**
 * v3 F9 (ADR 0074): a night on Arkona with the bulk class, on the governor's own fake clock, at LegendKeeper's
 * PUBLISHED limits and the default floors (P1 10%, P2 25%, P3 50%, P4 70%). This measures; the figures are in the ADR.
 * It is RV4's night (test/e4/rv4-budget-night.test.ts, everything at P3) with the passes at P4 and routine P3 work
 * beside them:
 *
 * - the nightly full snapshot at 00:30: 3,400 sequential P4 reads (ADR 0042's Arkona figure, about 2.2 a page for
 *   about 1,500 pages), giving way while P1 or P2 work is queued (the service's 250 ms waits, at most a minute a page);
 * - the other bulk passes at their own times, four reads in flight each: the link sweep at 01:15 (1,600 reads), the tree
 *   check at 02:30 (1,500) and the asset check at 02:50 (300);
 * - routine P3 work throughout: an automation-style fix (five reads and a write) every 5 minutes, and the hourly tree
 *   sweep (40 reads);
 * - agents through the night, lighter than RV4's daytime load: a tool call of six sequential P1 reads a minute, and a P2
 *   job (40 reads, 20 writes) every 15 minutes (about 10% of the key's hourly tier). (At RV4's load, a quarter of the
 *   hourly tier for agents alone, bulk stalls while they work and routine P3 work can meet its own floor: agents first,
 *   by design. ADR 0074 says so.)
 *
 * Each request takes 40 ms of fake time. Every dispatch is recorded with its class, so the sliding-window maxima are
 * computed independently of the governor's own windows. A second run measures the full snapshot alone.
 */
import { expect, it, vi } from 'vitest';
import { defaultGovernorSettings, type PriorityClass } from '../../src/config/lk.js';
import { FakeClock, sleep } from '../../src/lk/governor/clock.js';
import { Governor } from '../../src/lk/governor/governor.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import { json, READ, WRITE } from '../unit/governor-helpers.js';

vi.setConfig({ testTimeout: 600_000 });

const LAT = 40;
const MIN = 60_000;

function night() {
  const clock = new FakeClock(Date.UTC(2026, 10, 25, 0, 30, 0));
  const t0 = clock.now();
  const sent: { at: number; p: PriorityClass }[] = [];
  const governor = new Governor({
    settings: defaultGovernorSettings({ writeSpacingMs: 500 }),
    clock,
    random: () => 0.5,
    transport: async (input) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      sent.push({ at: clock.now(), p: u.searchParams.get('p') as PriorityClass });
      await sleep(clock, LAT);
      return json(200, { ok: true });
    },
  });
  let n = 0;
  const call = (p: PriorityClass, write = false, jobId?: string, firstClaim = false) =>
    governor.execute<Response>({
      opId: write ? 'updateResource' : 'getResource',
      kind: write ? 'write' : 'read',
      costs: write ? WRITE : READ,
      priority: p,
      ...(jobId ? { jobId } : {}),
      ...(firstClaim ? { firstClaim: true } : {}),
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
  return { clock, t0, sent, governor, call, busy };
}

const maxIn = (sent: { at: number }[], windowMs: number) => {
  const ev = sent.map((x) => x.at);
  let lo = 0;
  let best = 0;
  for (let hi = 0; hi < ev.length; hi++) {
    while (ev[lo]! <= ev[hi]! - windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
};
const pct = (xs: number[], q: number) =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
const min = (ms: number) => (ms / MIN).toFixed(1);

async function snapshotPass(env: ReturnType<typeof night>, reads: number) {
  let done = 0;
  for (let i = 0; i < reads; i++) {
    for (let k = 0; k < 240 && env.busy(); k++) await sleep(env.clock, 250);
    // Patient (never a BudgetWaitError from the queue), and first claim within P4, as the service sends them.
    await env.call('P4', false, 'snapshot', true);
    done++;
  }
  return { done, finishedAt: env.clock.now() };
}

it('a night on Arkona with the bulk class: the passes at P4 beside routine P3 work and agents', async () => {
  const env = night();
  const { clock, t0, sent, call } = env;

  const snap = snapshotPass(env, 3400);
  const bulk = [
    { name: 'link sweep', at: 45 * MIN, reads: 1600 },
    { name: 'tree check', at: 120 * MIN, reads: 1500 },
    { name: 'asset check', at: 140 * MIN, reads: 300 },
  ].map(async (b) => {
    await sleep(clock, b.at);
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < b.reads) {
          next++;
          await call('P4', false, b.name);
        }
      }),
    );
    return { ...b, finishedAt: clock.now() };
  });

  // Routine P3 work, each request timed from asking to sending; a budget wait is slept out, as the real callers do.
  const p3Delays: number[] = [];
  let p3Waits = 0;
  let routineOn = true;
  const timed = async (p: PriorityClass, write: boolean, out: number[], jobId?: string) => {
    const asked = clock.now();
    const before = sent.length;
    for (;;) {
      try {
        await call(p, write, jobId);
        break;
      } catch (e) {
        if (!(e instanceof BudgetWaitError)) throw e;
        if (p === 'P3') p3Waits++;
        await sleep(clock, Math.max(1000, e.retryAtMs - clock.now()));
      }
    }
    const mine = sent.slice(before).find((x) => x.p === p);
    out.push((mine?.at ?? clock.now()) - asked);
  };
  const routine = (async () => {
    let tick = 0;
    const runs: Promise<void>[] = [];
    while (routineOn) {
      const id = `fix${tick}`;
      runs.push(
        (async () => {
          for (let i = 0; i < 5; i++) await timed('P3', false, p3Delays, id);
          await timed('P3', true, p3Delays, id);
        })(),
      );
      if (tick % 12 === 0)
        runs.push(
          (async () => {
            for (let i = 0; i < 40; i++) await timed('P3', false, p3Delays, `sweep${tick}`);
          })(),
        );
      tick++;
      await sleep(clock, 5 * MIN);
    }
    await Promise.all(runs);
  })();

  // Agents for the whole night.
  const p1Delays: number[] = [];
  let agentsOn = true;
  const agents = (async () => {
    let tick = 0;
    const jobs: Promise<void>[] = [];
    while (agentsOn) {
      if (tick % 15 === 0) {
        const id = `job${tick}`;
        jobs.push(
          (async () => {
            for (let i = 0; i < 40; i++) await timed('P2', false, [], id);
            for (let i = 0; i < 20; i++) await timed('P2', true, [], id);
          })(),
        );
      }
      jobs.push(
        (async () => {
          for (let i = 0; i < 6; i++) await timed('P1', false, p1Delays);
        })(),
      );
      tick++;
      await sleep(clock, MIN);
    }
    await Promise.all(jobs);
  })();

  let snapDone: { done: number; finishedAt: number } | null = null;
  let bulkDone: Awaited<(typeof bulk)[number]>[] | null = null;
  void snap.then((s) => (snapDone = s));
  void Promise.all(bulk).then((b) => (bulkDone = b));
  await clock.runUntil(() => snapDone !== null && bulkDone !== null, 10 * 3600_000);
  routineOn = false;
  agentsOn = false;
  await clock.advance(20 * MIN);
  await Promise.all([routine, agents]);

  const s = snapDone!;
  const b = bulkDone!;
  const p4 = sent.filter((x) => x.p === 'P4');
  const minute = { all: maxIn(sent, MIN), p4: maxIn(p4, MIN) };
  const hour = { all: maxIn(sent, 3_600_000), p4: maxIn(p4, 3_600_000) };
  const clockOf = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  process.stdout.write(
    [
      'night on Arkona with the bulk class (fake clock, published limits, floors P1 10% P2 25% P3 50% P4 70%):',
      `  full snapshot 3,400 reads (from 00:30): finished at ${clockOf(s.finishedAt)} UTC, after ${min(s.finishedAt - t0)} min`,
      ...b.map(
        (x) =>
          `  ${x.name} ${x.reads} reads (from ${clockOf(t0 + x.at)}): finished at ${clockOf(x.finishedAt)} UTC`,
      ),
      `  max in any minute: ${minute.all} (P4 ${minute.p4}) of 300; max in any hour: ${hour.all} (P4 ${hour.p4}) of 6,000`,
      `  P3 budget waits: ${p3Waits}; P3 dispatch delay: n=${p3Delays.length} median ${pct(p3Delays, 0.5)} ms, p99 ${pct(p3Delays, 0.99)} ms, max ${Math.max(...p3Delays)} ms`,
      `  P1 dispatch delay: n=${p1Delays.length} median ${pct(p1Delays, 0.5)} ms, max ${Math.max(...p1Delays)} ms`,
    ].join('\n') + '\n',
  );

  // Bulk kept to its 30% share of key-min (90) and key-hour (1,800) together, and LegendKeeper's limits held.
  expect(minute.p4).toBeLessThanOrEqual(90);
  expect(hour.p4).toBeLessThanOrEqual(1800);
  expect(minute.all).toBeLessThanOrEqual(300);
  expect(hour.all).toBeLessThanOrEqual(6000);
  // Everything finished; routine work and agents went at once (bulk never sat in front of them).
  expect(s.done).toBe(3400);
  // First claim within P4 (the owner's review): the snapshot finishes before every other bulk pass.
  for (const x of b) expect(s.finishedAt, x.name).toBeLessThan(x.finishedAt);
  expect(p3Waits).toBe(0);
  expect(Math.max(...p3Delays)).toBeLessThan(1000);
  expect(Math.max(...p1Delays)).toBeLessThan(1000);
});

it('the full snapshot alone at 30%: how long 3,400 reads take', async () => {
  const env = night();
  let r: { done: number; finishedAt: number } | null = null;
  void snapshotPass(env, 3400).then((x) => (r = x));
  await env.clock.runUntil(() => r !== null, 6 * 3600_000);
  const took = r!.finishedAt - env.t0;
  process.stdout.write(`full snapshot alone at P4 (30%): 3,400 reads in ${min(took)} min\n`);
  // key-hour bounds it: 1,800 an hour at 30%, so the second hour's window is needed for the rest.
  expect(took).toBeGreaterThan(60 * MIN);
  expect(took).toBeLessThan(90 * MIN);
});
