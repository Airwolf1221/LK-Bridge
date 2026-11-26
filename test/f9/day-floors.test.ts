/**
 * v3 F9 amendment 1 (ADR 0074): the daily tier has floors of its own, on the governor's fake clock.
 *
 * The live case (25 November 2026, 23:15): Arkona's key-day at 18,009 of 60,000, the hourly tiers almost empty, and the
 * full snapshot stopped at 66% because RESERVE_FLOOR_BULK (0.7) applied to the day too (30% of 60,000 is 18,000).
 *
 * - the day floors apply to the daily tier only, and the minute and hour floors to their tiers only;
 * - with the day at 18,009 and the hour empty, P4 runs under the new defaults; P4 stops at 85% of the day;
 * - the same for P3 (its old trap was 50% of the day, 30,000; it now stops at 90%);
 * - the waiting reason names the tier, the floor and when it frees;
 * - a bulk pass held by the daily tier waits (patient) and goes on from where it was the moment the tier frees.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DAY_FLOORS, floorRowOf } from '../../src/config/floors.js';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import { TIER_IDS } from '../../src/lk/registry-types.js';
import { json, rate, READ, setup, track } from '../unit/governor-helpers.js';

const DAY = 86_400_000;
const MIN = 60_000;

/**
 * Seeds the governor's count of a tier as LegendKeeper reports it: one P0 read whose response carries that tier's rate
 * headers (matched to the tier by its limit), so `used` becomes exactly `used`.
 */
async function seed(env: ReturnType<typeof setup>, limit: number, used: number, resetAtMs: number) {
  env.setResponder(() => json(200, { ok: true }, rate(limit, limit - used, resetAtMs)));
  await env.call({ priority: 'P0' });
  env.setResponder(() => json(200, { ok: true }));
}

/** The floors as they were before the amendment: one fraction for every tier, the day included. */
const OLD_DAY = { P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.7 };

describe('which floors apply to which tier', () => {
  it('every counted tier falls under one row: key-day under the day floors, every other under the minute and hour floors', () => {
    const s = defaultGovernorSettings();
    const rows = Object.fromEntries(
      TIER_IDS.filter((t) => s.tierWindowsMs[t] !== null).map((t) => [t, floorRowOf(s.tierWindowsMs[t]!)]),
    );
    expect(rows).toEqual({
      'write-min': 'minute-hour',
      'write-hour': 'minute-hour',
      'key-min': 'minute-hour',
      'key-hour': 'minute-hour',
      'key-day': 'day',
      'project-hour': 'minute-hour',
      'items-min': 'minute-hour',
      'items-hour': 'minute-hour',
    });
    // The upload tier has no published numbers (reactive only): no window, no floor.
    expect(s.tierWindowsMs.upload).toBeNull();
    // A learned tier follows its inferred window: a day's window is the day row.
    expect(floorRowOf(MIN)).toBe('minute-hour');
    expect(floorRowOf(3_600_000)).toBe('minute-hour');
    expect(floorRowOf(DAY)).toBe('day');
    // The defaults.
    expect(s.dayReserveFloors).toEqual({ P0: 0, P1: 0.02, P2: 0.05, P3: 0.1, P4: 0.15 });
    expect(DEFAULT_DAY_FLOORS).toEqual({ interactive: 0.02, job: 0.05, maintenance: 0.1, bulk: 0.15 });
    expect(s.reserveFloors).toEqual({ P0: 0, P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.7 });
  });

  it('the day floors hold the daily tier only: changing them never moves an hourly wait', async () => {
    const env = setup();
    await seed(env, 6000, 1800, env.clock.now() + 3_600_000); // key-hour at bulk's 30%
    const held = track(env.call({ priority: 'P4' }));
    await env.clock.advance(10);
    expect(held.done).toBe(false);
    expect(env.governor.waitOf('P4')).toMatchObject({
      cause: 'tier',
      tier: 'key-hour',
      row: 'minute-hour',
      floor: 0.7,
    });
    // The day floors, even at nothing, do not free an hourly wait.
    env.governor.setDayReserveFloors({ P1: 0, P2: 0, P3: 0, P4: 0 });
    await env.clock.advance(10);
    expect(held.done).toBe(false);
    // The hourly floor does.
    env.governor.setReserveFloors({ P1: 0.1, P2: 0.25, P3: 0.5, P4: 0.6 });
    await env.clock.advance(10);
    expect(held.done).toBe(true);
  });

  it('the minute and hour floors hold their tiers only: lowering them never frees a daily wait', async () => {
    const env = setup({ dayReserveFloors: OLD_DAY });
    await seed(env, 60_000, 18_009, env.clock.now() + 1_195_000);
    const held = track(env.call({ priority: 'P4' }));
    await env.clock.advance(10);
    expect(held.done).toBe(false);
    expect(env.governor.waitOf('P4')).toMatchObject({
      cause: 'tier',
      tier: 'key-day',
      row: 'day',
      floor: 0.7,
    });
    env.governor.setReserveFloors({ P1: 0, P2: 0, P3: 0, P4: 0 });
    await env.clock.advance(10);
    expect(held.done).toBe(false);
    env.governor.setDayReserveFloors({ P1: 0.02, P2: 0.05, P3: 0.1, P4: 0.15 });
    await env.clock.advance(10);
    expect(held.done).toBe(true);
  });

  it('the day floors keep the order, and P0 is always 0', () => {
    const env = setup();
    expect(() => env.governor.setDayReserveFloors({ P1: 0.1, P2: 0.05, P3: 0.1, P4: 0.15 })).toThrow(
      /day floor for job \(5%\) is below the day floor for interactive \(10%\)/,
    );
    expect(() => env.governor.setDayReserveFloors({ P1: 0.02, P2: 0.05, P3: 0.2, P4: 0.15 })).toThrow(
      /day floor for bulk \(15%\) is below the day floor for maintenance \(20%\)/,
    );
    expect(() => env.governor.setDayReserveFloors({ P1: 0.02, P2: 0.05, P3: 0.1, P4: 1.5 })).toThrow(
      RangeError,
    );
    env.governor.setDayReserveFloors({ P1: 0.03, P2: 0.06, P3: 0.12, P4: 0.2 });
    expect(env.governor.settings.dayReserveFloors).toEqual({ P0: 0, P1: 0.03, P2: 0.06, P3: 0.12, P4: 0.2 });
    // The minute and hour floors are untouched by it.
    expect(env.governor.settings.reserveFloors.P4).toBe(0.7);
  });
});

describe('the live case: the day at 18,009 of 60,000, the hour empty', () => {
  it('before the amendment P4 was barred for the rest of the day; the reason now says so in words', async () => {
    const env = setup({ dayReserveFloors: OLD_DAY });
    const reset = env.clock.now() + 1_195_000;
    await seed(env, 60_000, 18_009, reset);
    const held = track(env.call({ priority: 'P4' }));
    const held2 = track(env.call({ priority: 'P4' }));
    await env.clock.advance(10);
    expect(held.done).toBe(false);
    const w = env.governor.snapshot().waits!.find((x) => x.priority === 'P4')!;
    expect(w).toMatchObject({
      queued: 2,
      cause: 'tier',
      tier: 'key-day',
      row: 'day',
      floor: 0.7,
      limit: 60_000,
    });
    expect(w.text).toBe(
      'bulk waiting: the daily tier is at 30.0% and bulk may use it up to 30% (frees in 20 min)',
    );
    expect(w.freesAtMs).toBe(Math.ceil(reset / 1000) * 1000);
    await env.clock.advance(1_200_000);
    expect(held.done && held2.done).toBe(true);
  });

  it('under the new defaults P4 runs at once', async () => {
    const env = setup();
    await seed(env, 60_000, 18_009, env.clock.now() + 1_195_000);
    const bulk = track(env.call({ priority: 'P4' }));
    await env.clock.advance(1);
    expect(bulk.done).toBe(true);
    expect(bulk.error).toBeUndefined();
    expect(env.governor.waitOf('P4')).toBeNull();
  });

  it('P4 stops at 85% of the day (51,000 of 60,000), leaving 9,000; P3 and agents still go', async () => {
    const env = setup();
    await seed(env, 60_000, 50_999, env.clock.now() + 6 * 3_600_000);
    // One more P4 read fits (51,000), the next does not.
    const first = track(env.call({ priority: 'P4' }));
    await env.clock.advance(1);
    expect(first.done).toBe(true);
    expect(env.used('key-day')).toBe(51_000);
    const second = track(env.call({ priority: 'P4' }));
    await env.clock.advance(10);
    expect(second.done).toBe(false);
    const w = env.governor.waitOf('P4')!;
    expect(w).toMatchObject({ cause: 'tier', tier: 'key-day', row: 'day', floor: 0.15 });
    expect(w.text).toMatch(
      /^bulk waiting: the daily tier is at 85\.0% and bulk may use it up to 85% \(frees in 6 h\)$/,
    );
    // Routine maintenance (90%) and an agent (98%) are not held by bulk's day floor.
    const p3 = track(env.call({ priority: 'P3' }));
    const p1 = track(env.call({ priority: 'P1' }));
    await env.clock.advance(10);
    expect(p3.done && p1.done).toBe(true);
    expect(second.done).toBe(false);
  });
});

describe('the P3 equivalent', () => {
  it('before: P3 barred at half the day (30,000); now it runs, and stops at 90% (54,000)', async () => {
    const before = setup({ dayReserveFloors: OLD_DAY });
    await before.call({ priority: 'P0' });
    await seed(before, 60_000, 30_001, before.clock.now() + 3_600_000);
    const barred = track(before.call({ priority: 'P3' }));
    await before.clock.advance(10);
    // A P3 call that is not patient is refused with the reason, rather than wait an hour.
    await before.clock.advance(31_000);
    expect(barred.error).toBeInstanceOf(BudgetWaitError);
    const err = barred.error as BudgetWaitError;
    expect(err.tier).toBe('key-day');
    expect(err.wait).toMatchObject({
      priority: 'P3',
      cause: 'tier',
      tier: 'key-day',
      row: 'day',
      floor: 0.5,
    });
    expect(err.wait!.text).toMatch(
      /^maintenance waiting: the daily tier is at 50\.0% and maintenance may use it up to 50% \(frees in /,
    );

    const env = setup();
    await seed(env, 60_000, 30_001, env.clock.now() + 3_600_000);
    const goes = track(env.call({ priority: 'P3' }));
    await env.clock.advance(1);
    expect(goes.done && goes.error === undefined).toBe(true);

    const full = setup();
    await seed(full, 60_000, 53_999, full.clock.now() + 3_600_000);
    const last = track(full.call({ priority: 'P3' }));
    await full.clock.advance(1);
    expect(last.done).toBe(true);
    expect(full.used('key-day')).toBe(54_000);
    // P3 is not patient: a wait of an hour is refused at once, with the reason.
    const over = track(full.call({ priority: 'P3' }));
    await full.clock.advance(10);
    expect(over.error).toBeInstanceOf(BudgetWaitError);
    expect((over.error as BudgetWaitError).wait).toMatchObject({ tier: 'key-day', row: 'day', floor: 0.1 });
    expect((over.error as BudgetWaitError).wait!.text).toMatch(
      /^maintenance waiting: the daily tier is at 90\.0% and maintenance may use it up to 90% \(frees in 1 h\)$/,
    );
  });
});

describe('the waiting reason', () => {
  it('names the hourly tier for an hourly wait, agents’ work while it is queued, and the class-wait event on each change', async () => {
    const env = setup();
    const events: { priority: string; text: string | null }[] = [];
    env.governor.on('class-wait', (e) => events.push({ priority: e.priority, text: e.wait?.text ?? null }));
    await seed(env, 6000, 1800, env.clock.now() + 1_800_000);
    const bulk = track(env.call({ priority: 'P4' }));
    await env.clock.advance(10);
    expect(env.governor.waitOf('P4')!.text).toBe(
      'bulk waiting: the hourly tier is at 30.0% and bulk may use it up to 30% (frees in 30 min)',
    );
    // An agent's call queued (held by the write gap) makes P4's reason agents' work.
    await env.call({
      priority: 'P0',
      costs: { tiers: ['write-min', 'write-hour', 'key-min', 'key-hour', 'key-day', 'project-hour'] },
      idempotencyKey: 'w0',
    });
    const agent = track(
      env.call({
        priority: 'P1',
        costs: { tiers: ['write-min', 'write-hour', 'key-min', 'key-hour', 'key-day', 'project-hour'] },
        idempotencyKey: 'w1',
      }),
    );
    await env.clock.advance(1);
    expect(env.governor.waitOf('P1')).toMatchObject({ cause: 'pacing' });
    expect(env.governor.waitOf('P1')!.text).toMatch(
      /^interactive waiting: the gap between writes \(frees in 1 s\)$/,
    );
    expect(env.governor.waitOf('P4')).toMatchObject({ cause: 'agents' });
    await env.clock.advance(1000);
    expect(agent.done).toBe(true);
    expect(env.governor.waitOf('P4')).toMatchObject({ cause: 'tier', tier: 'key-hour' });
    await env.clock.advance(1_800_000);
    expect(bulk.done).toBe(true);
    // Each change announced once: P4 held by the hour, by agents, by the hour again, then nothing.
    const p4 = events
      .filter((e) => e.priority === 'P4')
      .map((e) => e.text?.split(':')[1]?.trim().split(' ').slice(0, 3).join(' ') ?? null);
    expect(p4).toEqual(['the hourly tier', 'agents’ calls and', 'the hourly tier', null]);
  });

  it('a 429 on the daily tier is named as LegendKeeper’s refusal', async () => {
    const env = setup();
    env.setResponder(() =>
      json(
        429,
        { message: 'slow down', code: 'RATE_LIMITED' },
        { ...rate(60_000, 0, env.clock.now() + 3_600_000), 'retry-after': '3600' },
      ),
    );
    const r = track(env.call({ priority: 'P1' }));
    await env.clock.advance(10);
    expect(r.error).toBeInstanceOf(BudgetWaitError);
    expect((r.error as BudgetWaitError).wait).toMatchObject({ cause: 'refused', tier: 'key-day' });
    expect((r.error as BudgetWaitError).wait!.text).toMatch(
      /^interactive waiting: LegendKeeper refused the daily tier \(429\) \(frees in 1 h\)$/,
    );
  });
});

describe('a bulk pass held by the daily tier goes on from where it was when the tier frees', () => {
  it('rolling window: the held read is sent as the morning’s units leave the day; nothing is read twice', async () => {
    // A sequential pass (as the full snapshot reads: one page at a time, patient, first claim), with the day at bulk's
    // floor. No reset header: the day is a rolling window, so units leave 24 hours after they were spent.
    const env = setup({ dayReserveFloors: { P1: 0.02, P2: 0.05, P3: 0.1, P4: 0.15 } });
    // The day's work: 50,000 requests spread over an hour, 23 hours ago (the window keeps them until 24 h after).
    for (let i = 0; i < 50; i++) {
      await seed(env, 60_000, (i + 1) * 1000, env.clock.now() + DAY);
      await env.clock.advance(72_000);
    }
    await env.clock.advance(23 * 3_600_000 - 50 * 72_000);
    const pages: number[] = [];
    let page = 0;
    let errors = 0;
    const pass = (async () => {
      for (; page < 2000; page++) {
        try {
          await env.governor.execute<Response>({
            opId: 'getResource',
            kind: 'read',
            costs: READ,
            priority: 'P4',
            jobId: 'snapshot:run1',
            firstClaim: true,
            run: (signal) => env.governor.fetch(`http://lk.test/api/v3/p/${page}`, { method: 'GET', signal }),
          });
          pages.push(page);
        } catch {
          errors++;
        }
      }
    })();
    // Paced by the minute floor (90 a minute), the pass reaches bulk's share of the day (51,000) after 1,000 pages,
    // and is then held by the day.
    await env.clock.advance(20 * MIN);
    expect(pages.length).toBe(1000);
    expect(env.governor.waitOf('P4')).toMatchObject({
      cause: 'tier',
      tier: 'key-day',
      row: 'day',
      floor: 0.15,
    });
    expect(env.governor.waitOf('P4')!.text).toMatch(
      /^bulk waiting: the daily tier is at 85\.0% and bulk may use it up to 85% \(frees in 40 min\)$/,
    );
    await env.clock.advance(30 * MIN);
    expect(pages.length).toBe(1000); // still held: nothing of the day has left yet
    // Once the day's first units leave the window (24 h after they were spent), the pass goes on from the page it
    // reached, at the minute and hour floors' pace.
    await env.clock.advance(3 * 3_600_000);
    await pass;
    expect(errors).toBe(0);
    expect(pages).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    const sent = env.seen.filter((s) => s.url.includes('/p/')).map((s) => Number(s.url.split('/p/')[1]));
    expect(sent).toEqual(pages); // each page read once, in order: no restart, no re-read
  });

  it('fixed boundary: a pass held shortly before the day resets goes on at the reset and loses nothing', async () => {
    const env = setup();
    const reset = env.clock.now() + 10 * MIN;
    await seed(env, 60_000, 50_991, reset);
    const pages: number[] = [];
    const pass = (async () => {
      for (let page = 0; page < 40; page++) {
        await env.governor.execute<Response>({
          opId: 'getResource',
          kind: 'read',
          costs: READ,
          priority: 'P4',
          jobId: 'snapshot:run2',
          firstClaim: true,
          run: (signal) => env.governor.fetch(`http://lk.test/api/v3/p/${page}`, { method: 'GET', signal }),
        });
        pages.push(page);
      }
    })();
    await env.clock.advance(1000);
    expect(pages.length).toBe(9); // 50,991 + 9 = 51,000
    const w = env.governor.waitOf('P4')!;
    expect(w.freesAtMs).toBe(Math.ceil(reset / 1000) * 1000);
    expect(w.text).toMatch(/\(frees in 10 min\)$/);
    await env.clock.advance(10 * MIN);
    await pass;
    expect(pages).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
});
