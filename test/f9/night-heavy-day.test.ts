/**
 * v3 F9 amendment 1 (ADR 0074): F9's night on Arkona (test/f9/night-p4.test.ts) with a heavy day before it, on the
 * governor's fake clock at LegendKeeper's PUBLISHED limits. This measures; the figures are in the ADR's amendment.
 *
 * The day: the owner's and agents' work from 08:00 to 23:00 on 24 November, spread evenly (P1 reads), N requests in
 * all. LegendKeeper's day is taken as a rolling window, as the governor models it: a unit counts for 24 hours after it
 * was spent. (If it resets on a fixed boundary instead, the bridge snaps its count to LegendKeeper's reset and the whole
 * day frees at once at the reset: see the ADR.)
 *
 * The night, as F9's: the full snapshot at 00:30 (3,400 sequential P4 reads with first claim, giving way while agents'
 * work is queued), the link sweep at 01:15 (1,600), the tree check at 02:30 (1,500), the asset check at 02:50 (300),
 * four reads in flight each; routine P3 work every 5 minutes (a fix of five reads and a write) and the hourly tree sweep
 * (40 reads); light agent traffic (a tool call of six P1 reads a minute, a P2 job of 40 reads and 20 writes every 15
 * minutes).
 *
 * Scenarios:
 * - A: the day at 18,500 by 23:00 (the live case was 18,009 at 23:15), the new default floors;
 * - B: the same day under the floors before the amendment (one fraction for every tier, so bulk stopped at 30% of the
 *   day): the snapshot stalls until the day's first units leave the window;
 * - C: a very heavy day, 45,000 by 23:00, the new defaults: bulk meets its day floor (85%) and waits there.
 *
 * Every dispatch is recorded with its class; the day's count at each bulk dispatch is computed from those records,
 * independently of the governor's own windows.
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OLD_DAY_FLOORS = { P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.7 };

interface Sent {
  at: number;
  p: PriorityClass;
}

interface Finished {
  readonly kind: 'finished';
  readonly snapshotAt: number;
  readonly passes: readonly { name: string; from: number; finishedAt: number }[];
  readonly lastAt: number;
  readonly dayAt2315: number;
  readonly heldBy: string | null;
  readonly maxDayAtBulk: number;
  readonly p3Waits: number;
  readonly p3WaitTiers: readonly string[];
  readonly p3MinDayAtWait: number | null;
  readonly p3MaxDelay: number;
  readonly p3Requests: number;
  readonly nightAt: number;
}

interface Stopped {
  readonly kind: 'stopped';
  readonly stoppedAt: number;
  readonly snapshotReads: number;
  readonly heldBy: string | null;
  readonly dayAtStop: number;
  readonly dayAt2315: number;
}

async function simulate(o: {
  dayRequests: number;
  dayFloors?: typeof OLD_DAY_FLOORS;
  stopAt?: number;
}): Promise<Finished | Stopped> {
  const start = Date.UTC(2026, 10, 24, 8, 0, 0); // 08:00 on 24 November
  const nightAt = Date.UTC(2026, 10, 25, 0, 30, 0); // 00:30 on 25 November
  const clock = new FakeClock(start);
  const sent: Sent[] = [];
  const governor = new Governor({
    settings: defaultGovernorSettings({
      writeSpacingMs: 500,
      ...(o.dayFloors ? { dayReserveFloors: o.dayFloors } : {}),
    }),
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

  // Budget waits are slept out, as the real callers do; P3's are counted.
  let p3Waits = 0;
  const p3WaitDays: number[] = [];
  const p3WaitTiers = new Set<string>();
  const p3Delays: number[] = [];
  const timed = async (p: PriorityClass, write: boolean, out: number[] | null, jobId?: string) => {
    const asked = clock.now();
    const before = sent.length;
    for (;;) {
      try {
        await call(p, write, jobId);
        break;
      } catch (e) {
        if (!(e instanceof BudgetWaitError)) throw e;
        if (p === 'P3') {
          p3Waits++;
          p3WaitTiers.add(e.tier);
          p3WaitDays.push(governor.snapshot().tiers['key-day'].used);
        }
        await sleep(clock, Math.max(1000, e.retryAtMs - clock.now()));
      }
    }
    const mine = sent.slice(before).find((x) => x.p === p);
    out?.push((mine?.at ?? clock.now()) - asked);
  };

  // The day: N P1 reads, evenly over 08:00 to 23:00.
  const dayMs = 15 * HOUR;
  const day = (async () => {
    for (let i = 0; i < o.dayRequests; i++) {
      const due = start + Math.floor((i * dayMs) / o.dayRequests);
      if (due > clock.now()) await sleep(clock, due - clock.now());
      await timed('P1', false, null, 'day');
    }
  })();

  // The night.
  const progress = { snapshot: 0 };
  const night = (async () => {
    await sleep(clock, nightAt - clock.now());
    const t0 = clock.now();
    const snap = (async () => {
      for (let i = 0; i < 3400; i++) {
        for (let k = 0; k < 240 && busy(); k++) await sleep(clock, 250);
        await call('P4', false, 'snapshot', true);
        progress.snapshot++;
      }
      return clock.now();
    })();
    const passes = [
      { name: 'link sweep', at: 45 * MIN, reads: 1600 },
      { name: 'tree check', at: 120 * MIN, reads: 1500 },
      { name: 'asset check', at: 140 * MIN, reads: 300 },
    ].map(async (b) => {
      await sleep(clock, t0 + b.at - clock.now());
      let next = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < b.reads) {
            next++;
            await call('P4', false, b.name);
          }
        }),
      );
      return { name: b.name, from: t0 + b.at, finishedAt: clock.now() };
    });
    return { snapshotAt: await snap, passes: await Promise.all(passes) };
  })();

  let on = true;
  const routine = (async () => {
    await sleep(clock, nightAt - clock.now());
    let tick = 0;
    const runs: Promise<void>[] = [];
    while (on) {
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
  const agents = (async () => {
    await sleep(clock, nightAt - clock.now());
    let tick = 0;
    const jobs: Promise<void>[] = [];
    while (on) {
      if (tick % 15 === 0) {
        const id = `job${tick}`;
        jobs.push(
          (async () => {
            for (let i = 0; i < 40; i++) await timed('P2', false, null, id);
            for (let i = 0; i < 20; i++) await timed('P2', true, null, id);
          })(),
        );
      }
      jobs.push(
        (async () => {
          for (let i = 0; i < 6; i++) await timed('P1', false, null);
        })(),
      );
      tick++;
      await sleep(clock, MIN);
    }
    await Promise.all(jobs);
  })();

  let result: Awaited<typeof night> | null = null;
  void night.then((r) => (result = r));
  // Held at 23:15? The day's count when the live case stopped, and what holds bulk then.
  await clock.runUntil(() => clock.now() >= Date.UTC(2026, 10, 24, 23, 15, 0), DAY);
  const dayAt2315 = governor.snapshot().tiers['key-day'].used;
  let heldBy = null as string | null;
  const off = governor.on('class-wait', (e) => {
    if (e.priority === 'P4' && e.wait?.row === 'day' && heldBy === null) heldBy = e.wait.text;
  });
  if (o.stopAt !== undefined) {
    // Stopped at a set time (the run would not finish within a day): what it had done by then.
    await clock.runUntil(() => clock.now() >= o.stopAt!, 2 * DAY);
    off();
    on = false;
    return {
      kind: 'stopped',
      stoppedAt: o.stopAt,
      snapshotReads: progress.snapshot,
      heldBy,
      dayAtStop: governor.snapshot().tiers['key-day'].used,
      dayAt2315,
    };
  }
  await clock.runUntil(() => result !== null, 2 * DAY);
  off();
  on = false;
  await clock.advance(20 * MIN);
  await Promise.all([day, routine, agents]);

  // The day's count (every request in the 24 hours before) at each bulk dispatch, from the records alone.
  let lo = 0;
  let maxDayAtBulk = 0;
  for (let hi = 0; hi < sent.length; hi++) {
    while (sent[lo]!.at <= sent[hi]!.at - DAY) lo++;
    if (sent[hi]!.p === 'P4') maxDayAtBulk = Math.max(maxDayAtBulk, hi - lo + 1);
  }
  const r = result!;
  return {
    kind: 'finished',
    snapshotAt: r.snapshotAt,
    passes: r.passes,
    lastAt: Math.max(r.snapshotAt, ...r.passes.map((x) => x.finishedAt)),
    dayAt2315,
    heldBy,
    maxDayAtBulk,
    p3Waits,
    p3WaitTiers: [...p3WaitTiers],
    p3MinDayAtWait: p3WaitDays.length > 0 ? Math.min(...p3WaitDays) : null,
    p3MaxDelay: Math.max(...p3Delays),
    p3Requests: p3Delays.length,
    nightAt,
  };
}

const clockOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate() === 25 ? '' : `${d.getUTCDate()} Nov `}${d.toISOString().slice(11, 16)}`;
};
const finished = (r: Finished | Stopped): Finished => {
  if (r.kind !== 'finished') throw new Error('the run was stopped');
  return r;
};
const report = (label: string, r: Finished) =>
  process.stdout.write(
    [
      `${label}:`,
      `  the day at 23:15: ${r.dayAt2315.toLocaleString('en-GB')} of 60,000`,
      `  full snapshot (from 00:30): finished at ${clockOf(r.snapshotAt)} UTC, after ${((r.snapshotAt - r.nightAt) / MIN).toFixed(1)} min`,
      ...r.passes.map(
        (x) => `  ${x.name} (from ${clockOf(x.from)}): finished at ${clockOf(x.finishedAt)} UTC`,
      ),
      `  the day's count at any bulk dispatch: at most ${r.maxDayAtBulk.toLocaleString('en-GB')} of 60,000`,
      `  held by the daily tier: ${r.heldBy ?? 'never'}`,
      `  P3: ${r.p3Requests} requests, ${r.p3Waits} budget waits${r.p3Waits > 0 ? ` (on ${r.p3WaitTiers.join(', ')}, the day at ${r.p3MinDayAtWait?.toLocaleString('en-GB')} or more)` : ''}, max dispatch delay ${r.p3MaxDelay} ms`,
    ].join('\n') + '\n',
  );

it('A: a heavy day (18,500 by 23:00), the new defaults: the night as if the day had been quiet', async () => {
  const r = finished(await simulate({ dayRequests: 18_500 }));
  report('A: heavy day, new default floors (day: bulk 15%, maintenance 10%)', r);
  expect(r.dayAt2315).toBeGreaterThanOrEqual(18_009);
  expect(r.heldBy).toBeNull();
  // As F9's night (test/f9/night-p4.test.ts): the snapshot first, all done before the 05:30 sweep's data is needed.
  for (const x of r.passes) expect(r.snapshotAt).toBeLessThan(x.finishedAt);
  expect(r.snapshotAt).toBeLessThan(Date.UTC(2026, 10, 25, 4, 0, 0));
  expect(r.lastAt).toBeLessThan(Date.UTC(2026, 10, 25, 6, 0, 0));
  expect(r.maxDayAtBulk).toBeLessThanOrEqual(51_000);
  expect(r.p3Waits).toBe(0);
  expect(r.p3MaxDelay).toBeLessThan(1000);
});

it('B: the same day under the floors before the amendment: bulk barred by the day until its first units leave', async () => {
  // It would not finish the next day (the night's agents keep the rolling day near bulk's 18,000): stopped at noon.
  const noon = Date.UTC(2026, 10, 25, 12, 0, 0);
  const r = (await simulate({ dayRequests: 18_500, dayFloors: OLD_DAY_FLOORS, stopAt: noon })) as Stopped;
  process.stdout.write(
    [
      'B: heavy day, the floors before the amendment (bulk 70% of every tier, the day included):',
      `  the day at 23:15: ${r.dayAt2315.toLocaleString('en-GB')} of 60,000`,
      `  held by the daily tier: ${r.heldBy ?? 'never'}`,
      `  full snapshot by 12:00 UTC: ${r.snapshotReads.toLocaleString('en-GB')} of 3,400 reads (${Math.floor((r.snapshotReads / 3400) * 100)}%); the day then at ${r.dayAtStop.toLocaleString('en-GB')}`,
    ].join('\n') + '\n',
  );
  expect(r.heldBy).toMatch(/^bulk waiting: the daily tier is at 30\.\d% and bulk may use it up to 30%/);
  expect(r.snapshotReads).toBeLessThan(3400);
});

it('C: a very heavy day (45,000 by 23:00): bulk waits at 85% of the day and never takes it past that', async () => {
  const r = finished(await simulate({ dayRequests: 45_000 }));
  report('C: very heavy day, new default floors', r);
  expect(r.heldBy).toMatch(/^bulk waiting: the daily tier is at 85\.0% and bulk may use it up to 85%/);
  expect(r.maxDayAtBulk).toBeLessThanOrEqual(51_000);
  expect(r.maxDayAtBulk).toBeGreaterThan(50_000);
  // Routine P3 waits only on its own day floor (90%: 54,000), which agents' night traffic reaches after bulk has
  // stopped at 85%; bulk never takes the day there.
  if (r.p3Waits > 0) {
    expect(r.p3WaitTiers).toEqual(['key-day']);
    expect(r.p3MinDayAtWait).toBeGreaterThanOrEqual(54_000);
  }
});
