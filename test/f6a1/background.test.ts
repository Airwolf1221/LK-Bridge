/**
 * v3 F6a.1 (ADR 0076 amendment 1): the runtime's background work (src/background.ts): a re-check an action starts is
 * debounced, runs one at a time per key, and is aborted and awaited when the bridge stops.
 */
import { describe, expect, it } from 'vitest';
import { BackgroundRunner } from '../../src/background.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BackgroundRunner', () => {
  it('debounces: a burst of triggers for one key is one run', async () => {
    const b = new BackgroundRunner({ debounceMs: 30 });
    let runs = 0;
    for (let i = 0; i < 5; i++) b.trigger('governance:arkona', 'check', () => Promise.resolve(runs++));
    await sleep(10);
    expect(runs).toBe(0);
    await b.settled();
    expect(runs).toBe(1);
  });

  it('one run at a time per key: a trigger during a run makes exactly one more after it', async () => {
    const b = new BackgroundRunner({ debounceMs: 5 });
    let active = 0;
    let most = 0;
    let runs = 0;
    const fn = async () => {
      active++;
      most = Math.max(most, active);
      runs++;
      await sleep(40);
      active--;
    };
    b.trigger('k', 'check', fn);
    await sleep(15); // running now
    b.trigger('k', 'check', fn);
    b.trigger('k', 'check', fn);
    b.trigger('k', 'check', fn);
    await b.settled();
    expect(most).toBe(1);
    expect(runs).toBe(2);
  });

  it('different keys run independently', async () => {
    const b = new BackgroundRunner({ debounceMs: 5 });
    const seen: string[] = [];
    b.trigger('a', 'a', () => Promise.resolve(seen.push('a')));
    b.trigger('b', 'b', () => Promise.resolve(seen.push('b')));
    await b.settled();
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('stop: pending debounces dropped, running work aborted and awaited, nothing new starts', async () => {
    const warned: string[] = [];
    const quiet: string[] = [];
    const b = new BackgroundRunner({
      debounceMs: 5,
      log: { warn: (_o, m) => warned.push(m), debug: (_o, m) => quiet.push(m) },
    });
    let finished = false;
    let sawAbort = false;
    b.trigger('running', 'a long check', async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          setTimeout(resolve, 20); // it takes a moment to wind down: stop waits for it
        });
      });
      finished = true;
      signal.throwIfAborted();
    });
    let pendingRan = false;
    await sleep(15);
    b.trigger('pending', 'a debounced check', () => Promise.resolve((pendingRan = true)), {
      debounceMs: 1000,
    });
    expect(await b.stop(1000)).toBe(true);
    expect(sawAbort).toBe(true);
    expect(finished).toBe(true);
    expect(pendingRan).toBe(false);
    // An abort is not an error.
    expect(warned).toEqual([]);
    expect(quiet).toEqual(['background work stopped with the bridge']);
    let late = false;
    b.trigger('late', 'after stop', () => Promise.resolve((late = true)), { debounceMs: 1 });
    await sleep(10);
    expect(late).toBe(false);
  });

  it('track: work already started is awaited on stop; a failure is logged, never thrown', async () => {
    const warned: string[] = [];
    const b = new BackgroundRunner({ log: { warn: (_o, m) => warned.push(m) } });
    let done = false;
    void b.track(
      'a follow-up',
      sleep(30).then(() => (done = true)),
    );
    void b.track('a failing follow-up', Promise.reject(new Error('boom')));
    expect(b.pending()).toBe(2);
    await b.stop(1000);
    expect(done).toBe(true);
    expect(warned).toEqual(['a failing follow-up failed']);
  });

  it('stop is bounded: work that never ends does not hold the stop for ever', async () => {
    const b = new BackgroundRunner();
    void b.track('stuck', new Promise(() => undefined));
    const t0 = Date.now();
    expect(await b.stop(50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
