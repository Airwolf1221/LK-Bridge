/**
 * v1.0.1 (F-14): the governor's per-tier counts survive a restart. A second governor built on the same store (as after
 * a restart) starts with the first one's recent counts, minus anything older than each tier's window.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { FakeClock, flushMicrotasks } from '../../src/lk/governor/clock.js';
import { Governor } from '../../src/lk/governor/governor.js';
import {
  createSqliteCounterStore,
  toBuckets,
  type CounterStore,
  type PersistedCounters,
} from '../../src/lk/governor/persist.js';
import type { CostSpec } from '../../src/lk/governor/types.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import type { TierId } from '../../src/lk/registry-types.js';
import { json, lkError, track, WRITE } from './governor-helpers.js';

/** An in-memory store that records what was saved. */
function memoryStore(initial?: unknown) {
  let data: unknown = initial;
  const saves: PersistedCounters[] = [];
  const store: CounterStore = {
    load: () => data,
    save: (c) => {
      saves.push(c);
      data = JSON.parse(JSON.stringify(c)) as unknown;
    },
  };
  return { store, saves, set: (d: unknown) => (data = d) };
}

const settings = () =>
  // No pacing, so a full minute of writes can be sent at once; the windows are the published ones.
  defaultGovernorSettings({ writeSpacingMs: 0, writeSpacingStretchedMs: 0 });

function build(
  clock: FakeClock,
  store?: CounterStore,
  warnings: string[] = [],
  respond = () => json(200, { ok: 1 }),
) {
  const sent: number[] = [];
  const governor = new Governor({
    settings: settings(),
    clock,
    random: () => 0.5,
    transport: () => {
      sent.push(clock.now());
      return Promise.resolve(respond());
    },
    ...(store ? { persistence: { store, warn: (m: string) => warnings.push(m) } } : {}),
  });
  const write = (costs: CostSpec = WRITE) =>
    governor.execute<Response>({
      opId: 'test.write',
      kind: 'write',
      costs,
      priority: 'P0', // the full budget, no reserve: a full tier is really full
      idempotencyKey: `k${Math.random()}`,
      run: (signal) => governor.fetch('http://lk.test/api/v3/x', { method: 'POST', signal }),
    });
  const used = (tier: TierId) => governor.snapshot().tiers[tier].used;
  return { governor, write, sent, used };
}

const MIN = 60_000;

describe('governor counters across restarts (v1.0.1, F-14)', () => {
  it('restart with a full write-minute tier: the next write waits until the minute has passed', async () => {
    const clock = new FakeClock();
    const t0 = clock.now();
    const mem = memoryStore();
    const a = build(clock, mem.store);
    await Promise.all(Array.from({ length: 120 }, () => a.write()));
    expect(a.used('write-min')).toBe(120);
    a.governor.close(); // the shutdown save
    expect(mem.saves.at(-1)!.tiers['write-min']!.buckets.reduce((s, [, n]) => s + n, 0)).toBe(120);

    await clock.advance(40_000); // the restart takes 40 s
    const b = build(clock, mem.store);
    expect(b.used('write-min')).toBe(120);
    expect(b.used('write-hour')).toBe(120);
    expect(b.used('key-day')).toBe(120);
    const next = track(b.write());
    await flushMicrotasks();
    expect(b.sent).toEqual([]); // waiting: the minute LegendKeeper still counts is full
    await clock.advanceTo(t0 + MIN - 1);
    expect(b.sent).toEqual([]);
    await clock.advanceTo(t0 + MIN);
    await flushMicrotasks();
    expect(b.sent).toEqual([t0 + MIN]);
    expect(next.done && next.error === undefined).toBe(true);
    b.governor.close();

    // Without persistence (the old behaviour) the same write would have gone at once.
    const c = build(new FakeClock(t0 + 40_000));
    await c.write();
    expect(c.sent).toEqual([t0 + 40_000]);
  });

  it('a restart long after the save keeps the hour and day but drops the stale minute', async () => {
    const clock = new FakeClock();
    const mem = memoryStore();
    const a = build(clock, mem.store);
    await Promise.all(Array.from({ length: 50 }, () => a.write()));
    a.governor.close();
    await clock.advance(MIN + 1_000);
    const b = build(clock, mem.store);
    expect(b.used('write-min')).toBe(0);
    expect(b.used('key-min')).toBe(0);
    expect(b.used('write-hour')).toBe(50);
    expect(b.used('key-day')).toBe(50);
    b.governor.close();
    await clock.advance(24 * 60 * MIN); // a day later: everything is stale
    const c = build(clock, mem.store);
    for (const tier of ['write-min', 'write-hour', 'key-hour', 'key-day', 'project-hour'] as const)
      expect(c.used(tier), tier).toBe(0);
  });

  it('a missing record starts empty; a corrupt or foreign one starts empty, warns and never crashes', async () => {
    const clock = new FakeClock();
    const t = clock.now();
    const cases: [string, unknown][] = [
      ['not an object', 'garbage'],
      ['wrong format version', { v: 2, savedAt: t, tiers: {} }],
      ['negative units', { v: 1, savedAt: t, tiers: { 'write-min': { buckets: [[t, -5]] } } }],
      ['not a number', { v: 1, savedAt: t, tiers: { 'write-min': { buckets: [['soon', 5]] } } }],
      ['no tiers', { v: 1, savedAt: t }],
    ];
    for (const [name, raw] of cases) {
      const warnings: string[] = [];
      const g = build(clock, memoryStore(raw).store, warnings);
      expect(g.used('write-min'), name).toBe(0);
      expect(warnings, name).toEqual([expect.stringMatching(/malformed; starting from empty counters/)]);
      await g.write(); // and it works
      expect(g.sent, name).toHaveLength(1);
      g.governor.close();
    }
    // A store that throws on load.
    const throwing: CounterStore = {
      load: () => {
        throw new Error('disk on fire');
      },
      save: () => undefined,
    };
    const warnings: string[] = [];
    const g = build(clock, throwing, warnings);
    expect(warnings).toEqual([expect.stringMatching(/Could not read the saved governor counters/)]);
    await g.write();
    expect(g.sent).toHaveLength(1);
    g.governor.close();
    // Missing: nothing to restore, nothing to warn about.
    const quiet: string[] = [];
    const m = build(clock, memoryStore(undefined).store, quiet);
    expect(quiet).toEqual([]);
    expect(m.used('write-min')).toBe(0);
    m.governor.close();
  });

  it('ignores unknown tiers, clamps future times to now and caps a tier at its limit', async () => {
    const clock = new FakeClock();
    const t = clock.now();
    const raw = {
      v: 1,
      savedAt: t,
      tiers: {
        'no-such-tier': { buckets: [[t, 5]] },
        'write-min': { buckets: [[t + 3_600_000, 10_000]] }, // a clock that went back an hour, and far too many
      },
    };
    const g = build(clock, memoryStore(raw).store);
    expect(g.used('write-min')).toBe(120); // capped at the limit
    await clock.advance(MIN); // clamped to "now", so it expires one window from now, not an hour later
    expect(g.used('write-min')).toBe(0);
    g.governor.close();
  });

  it('keeps an active 429 block across the restart', async () => {
    const clock = new FakeClock();
    const mem = memoryStore();
    const a = build(clock, mem.store, [], () => lkError(429, 'RATE_LIMITED', { 'retry-after': '600' }));
    await expect(a.write()).rejects.toBeInstanceOf(BudgetWaitError);
    a.governor.close();
    const b = build(clock, mem.store);
    const blocked = Object.values(b.governor.snapshot().tiers).filter((x) => x.blockedUntilMs !== null);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.blockedUntilMs).toBe(clock.now() + 600_000);
    b.governor.close();
  });

  it('saves at most every 10 s while counts change, and arms no timer while idle', async () => {
    const clock = new FakeClock();
    const mem = memoryStore();
    const g = build(clock, mem.store);
    expect(clock.pendingTimers).toBe(0); // idle: no timer
    await g.write();
    await g.write();
    expect(mem.saves).toHaveLength(0);
    expect(clock.pendingTimers).toBe(1); // one save armed for both
    await clock.advance(10_000);
    expect(mem.saves).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
    g.governor.close();
    expect(mem.saves).toHaveLength(2); // and once more on shutdown
  });

  it('a failing save is reported and the governor carries on', async () => {
    const clock = new FakeClock();
    const warnings: string[] = [];
    const g = build(
      clock,
      {
        load: () => undefined,
        save: () => {
          throw new Error('read-only database');
        },
      },
      warnings,
    );
    await g.write();
    await clock.advance(10_000);
    expect(warnings).toEqual([expect.stringMatching(/Could not save the governor counters/)]);
    await g.write();
    expect(g.sent).toHaveLength(2);
    g.governor.close();
  });

  it('buckets conservatively: never more than 60 per tier, each at the latest time in it', () => {
    const events = Array.from({ length: 600 }, (_, i) => ({ t: 1_000_000 + i * 100, n: 1 })); // one a tick, 60 s
    const b = toBuckets(events, MIN);
    expect(b.length).toBeLessThanOrEqual(61);
    expect(b.reduce((s, [, n]) => s + n, 0)).toBe(600);
    for (const [t] of b) expect(Math.floor(t / 1000) * 1000 + 900).toBeGreaterThanOrEqual(t); // the last tick of its second
    expect(b[0]![0]).toBe(1_000_900);
  });
});

describe('the SQLite counter store', () => {
  let dir: string | undefined;
  let db: Db | undefined;
  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = undefined;
    dir = undefined;
  });

  it('round-trips through table governor_counters (migration 0500), and a corrupt row starts empty', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-gov-'));
    db = openDatabase(join(dir, 'bridge.db'));
    runMigrations(db);
    const clock = new FakeClock();
    const a = build(clock, createSqliteCounterStore(db));
    await Promise.all(Array.from({ length: 30 }, () => a.write()));
    a.governor.close();
    const row = db.prepare('SELECT key, saved_at, data FROM governor_counters').all() as {
      key: string;
      saved_at: number;
    }[];
    expect(row).toEqual([expect.objectContaining({ key: 'lk', saved_at: clock.now() })]);
    await clock.advance(5_000);
    const b = build(clock, createSqliteCounterStore(db));
    expect(b.used('write-min')).toBe(30);
    b.governor.close();

    db.prepare(`UPDATE governor_counters SET data = '{not json'`).run();
    const warnings: string[] = [];
    const c = build(clock, createSqliteCounterStore(db), warnings);
    expect(c.used('write-min')).toBe(0);
    expect(warnings).toEqual([expect.stringMatching(/Could not read the saved governor counters/)]);
    c.governor.close();
  });
});
