import { describe, expect, it } from 'vitest';
import { setup, WRITE } from './governor-helpers.js';

describe('write pacing', () => {
  it('spaces writes at least 500 ms apart', async () => {
    const env = setup();
    const calls = Array.from({ length: 5 }, () => env.call({ costs: WRITE }));
    await env.clock.advance(5000);
    await Promise.all(calls);
    const t0 = env.seen[0]!.atMs;
    expect(env.seen.map((s) => s.atMs - t0)).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it('does not pace reads', async () => {
    const env = setup();
    const calls = Array.from({ length: 5 }, () => env.call());
    await env.clock.advance(0);
    await Promise.all(calls);
    expect(new Set(env.seen.map((s) => s.atMs)).size).toBe(1);
  });

  it('stretches to 1.2 s once the projected hourly write count would cross 3,000, and relaxes after', async () => {
    const env = setup();
    const calls = Array.from({ length: 60 }, () => env.call({ costs: WRITE }));
    await env.clock.advance(120_000);
    await Promise.all(calls);
    const gaps = env.seen.slice(1).map((s, i) => s.atMs - env.seen[i]!.atMs);
    // 51 writes inside a minute project to 3,060/h > 3,000: the 52nd waits 1.2 s.
    expect(gaps.slice(0, 50).every((g) => g === 500)).toBe(true);
    expect(gaps.slice(50).every((g) => g === 1200)).toBe(true);
    expect(env.governor.snapshot().writeSpacingMs).toBe(500); // 2 minutes on, the pace has dropped
  });

  it('stays stretched while the pace holds (hysteresis), so it does not flap at the threshold', async () => {
    const env = setup();
    const calls = Array.from({ length: 150 }, () => env.call({ costs: WRITE, priority: 'P0' }));
    await env.clock.advance(400_000);
    await Promise.all(calls);
    const gaps = env.seen.slice(1).map((s, i) => s.atMs - env.seen[i]!.atMs);
    expect(gaps.slice(50).every((g) => g === 1200)).toBe(true);
  });

  it('uses configured spacing values', async () => {
    const env = setup({ writeSpacingMs: 100, writeSpacingStretchedMs: 300, stretchHourlyWrites: 600 });
    const calls = Array.from({ length: 14 }, () => env.call({ costs: WRITE }));
    await env.clock.advance(60_000);
    await Promise.all(calls);
    const gaps = env.seen.slice(1).map((s, i) => s.atMs - env.seen[i]!.atMs);
    // 11 writes in a minute project to 660/h > 600.
    expect(gaps.slice(0, 10)).toEqual(Array(10).fill(100));
    expect(gaps.slice(10)).toEqual(Array(3).fill(300));
  });
});
