import { describe, expect, it } from 'vitest';
import { parseRateHeaders, parseRetryAfter } from '../../src/lk/governor/headers.js';
import type { SampleEvent, ThrottledEvent } from '../../src/lk/governor/types.js';
import { json, lkError, rate, READ, setup, track, WRITE } from './governor-helpers.js';

describe('rate header parsing', () => {
  it('parses limit, remaining and reset (Unix seconds)', () => {
    const h = new Headers(rate(300, 12, 1_700_000_060_000));
    expect(parseRateHeaders(h)).toEqual({ limit: 300, remaining: 12, resetAtMs: 1_700_000_060_000 });
    expect(parseRateHeaders(new Headers())).toBeNull();
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '7' }), 0)).toBe(7000);
    const now = Date.UTC(2026, 10, 7, 12, 0, 0);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Sat, 07 Nov 2026 12:00:30 GMT' }), now)).toBe(
      30_000,
    );
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
  });
});

describe('snapping to the server', () => {
  it('raises the matching tier to the server count (shared project tier used by another key)', async () => {
    const env = setup();
    const samples: SampleEvent[] = [];
    env.governor.on('sample', (s) => samples.push(s));
    const reset = env.clock.now() + 1800_000;
    env.setResponder(() => json(200, {}, rate(12_000, 2_000, reset)));
    await env.call();
    const snap = env.governor.snapshot().tiers['project-hour'];
    expect(snap.used).toBe(10_000);
    expect(snap.drift).toMatchObject({ observedUsed: 10_000, modelledUsed: 1, delta: 9_999 });
    expect(snap.resetAtMs).toBe(reset);
    expect(samples[0]).toMatchObject({
      tier: 'project-hour',
      limit: 12_000,
      remaining: 2_000,
      modelledUsed: 1,
    });
    // The phantom units leave the window at the server's reset, not a full hour from now.
    await env.clock.advanceTo(reset);
    expect(env.used('project-hour')).toBe(1);
  });

  it('lowers the local count when the server reports fewer (e.g. a call LK never counted)', async () => {
    const env = setup();
    for (let i = 0; i < 50; i++) await env.call();
    expect(env.used('key-min')).toBe(50);
    env.setResponder(() => json(200, {}, rate(300, 290, env.clock.now() + 60_000)));
    await env.call();
    expect(env.used('key-min')).toBe(10);
  });

  it('counts other in-flight calls on top of the server figure', async () => {
    const env = setup();
    const holds: Array<() => void> = [];
    env.setResponder((_req, i) =>
      i < 3
        ? new Promise<Response>((r) => holds.push(() => r(json(200, {}))))
        : json(200, {}, rate(300, 299, env.clock.now() + 60_000)),
    );
    const held = [track(env.call()), track(env.call()), track(env.call())];
    await env.call(); // server: 1 used; three others are still in flight
    expect(env.used('key-min')).toBe(4);
    holds.forEach((h) => h());
    await env.clock.advance(0);
    expect(held.every((h) => h.done)).toBe(true);
  });

  it('matches write headers to the write tier by limit', async () => {
    const env = setup();
    env.setResponder(() => json(200, {}, rate(120, 20, env.clock.now() + 60_000)));
    await env.call({ costs: WRITE });
    expect(env.used('write-min')).toBe(100);
    expect(env.used('key-min')).toBe(1);
  });

  it('adopts a lower server limit when LK changes a tier (matched by window)', async () => {
    const env = setup();
    env.setResponder(() => json(200, {}, rate(100, 99, env.clock.now() + 50_000)));
    await env.call({ costs: WRITE });
    const t = env.governor.snapshot().tiers['write-min'];
    expect(t.limit).toBe(100);
    expect(t.configuredLimit).toBe(120);
  });

  it('refunds calls LK refuses before counting (401 without rate headers)', async () => {
    const env = setup({}, () => lkError(401, 'UNAUTHENTICATED'));
    await expect(env.call()).rejects.toMatchObject({ classification: 'auth' });
    expect(env.used('key-min')).toBe(0);
  });

  it('keeps counting a 404 (it carries rate headers and was counted)', async () => {
    const env = setup();
    env.setResponder(() => lkError(404, 'NOT_FOUND', rate(300, 299, env.clock.now() + 60_000)));
    await expect(env.call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(env.used('key-min')).toBe(1);
  });
});

describe('429 marks a tier exhausted until Retry-After', () => {
  it('blocks the reported tier for every queued call, then resumes', async () => {
    const env = setup();
    const throttled: ThrottledEvent[] = [];
    env.governor.on('throttled', (e) => throttled.push(e));
    let first = true;
    env.setResponder(() => {
      if (first) {
        first = false;
        return lkError(429, 'RATE_LIMITED', {
          ...rate(300, 0, env.clock.now() + 10_000),
          'retry-after': '10',
        });
      }
      return json(200, {});
    });
    const t0 = env.clock.now();
    const a = track(env.call());
    await env.clock.advance(0);
    expect(env.governor.snapshot().tiers['key-min'].blockedUntilMs).toBe(t0 + 10_000);
    expect(throttled[0]).toMatchObject({ tiers: ['key-min'], code: 'RATE_LIMITED', retryAtMs: t0 + 10_000 });
    const b = track(env.call({ costs: READ }));
    await env.clock.advance(9_999);
    expect(env.seen).toHaveLength(1);
    await env.clock.advance(1);
    expect(a.done && b.done).toBe(true);
    expect(env.seen.slice(1).every((s) => s.atMs === t0 + 10_000)).toBe(true);
  });
});
