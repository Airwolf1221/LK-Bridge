/**
 * CR-2026-11-R3 (fix A, the owner's clean shutdown): `Governor.stopWaits`. A restart ends every wait at once (a call
 * queued for budget or pacing, a retry's back-off) without sending anything, lets a call that can go at once still go
 * (a step already under way finishes its reads), and lets a request already in flight finish.
 */
import { describe, expect, it } from 'vitest';
import { BudgetWaitError, RestartWaitError } from '../../src/lk/errors.js';
import { json, lkError, rate, READ, setup, track, WRITE } from './governor-helpers.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('Governor.stopWaits (a restart)', () => {
  it('a call queued for budget is refused at once, as a parked budget wait, and never sent', async () => {
    const g = setup();
    // The write-minute tier is spent until 20 s from now: the next write must wait (under the 30 s queue limit).
    g.setResponder(() => json(200, { ok: true }, rate(120, 0, g.clock.now() + 20_000)));
    await g.call({ costs: WRITE, method: 'POST' });
    const waiting = track(g.call({ costs: WRITE, method: 'POST' }));
    await flush();
    expect(waiting.done).toBe(false);
    expect(g.seen).toHaveLength(1);
    g.governor.stopWaits();
    await flush();
    expect(waiting.done).toBe(true);
    expect(waiting.error).toBeInstanceOf(RestartWaitError);
    expect(waiting.error).toBeInstanceOf(BudgetWaitError); // every caller parks it: nothing lost
    expect((waiting.error as BudgetWaitError).retryAtMs).toBe(g.clock.now());
    expect(g.seen).toHaveLength(1); // nothing more was sent
  });

  it('after it, a call that can go at once still goes; one that would wait (write pacing) is refused', async () => {
    const g = setup({ writeSpacingMs: 500 });
    await g.call({ costs: WRITE, method: 'POST' });
    g.governor.stopWaits();
    const read = await g.call({ costs: READ });
    expect(read.status).toBe(200);
    const paced = track(g.call({ costs: WRITE, method: 'POST' }));
    await flush();
    expect(paced.error).toBeInstanceOf(RestartWaitError);
    expect(g.seen.map((s) => s.method)).toEqual(['POST', 'GET']);
  });

  it("a retry's back-off ends at once: no second attempt is sent", async () => {
    const g = setup();
    g.setResponder(() => lkError(503, 'SERVICE_UNAVAILABLE'));
    const call = track(g.call({ costs: READ }));
    await flush();
    expect(g.seen).toHaveLength(1); // the first attempt failed; the back-off (250 ms or more) has begun
    g.governor.stopWaits();
    await flush();
    expect(call.error).toBeInstanceOf(RestartWaitError);
    await g.clock.advance(10_000);
    expect(g.seen).toHaveLength(1);
  });

  it('a request already in flight finishes, and its answer is kept', async () => {
    const g = setup();
    let answer: (r: Response) => void = () => {};
    g.setResponder(() => new Promise<Response>((resolve) => (answer = resolve)));
    const call = track(g.call({ costs: WRITE, method: 'POST' }));
    await flush();
    expect(g.seen).toHaveLength(1);
    g.governor.stopWaits();
    await flush();
    expect(call.done).toBe(false); // not cut
    answer(json(200, { id: 'kept' }));
    await flush();
    await flush();
    expect(call.done).toBe(true);
    expect(call.error).toBeUndefined();
    expect(await (call.value as Response).json()).toEqual({ id: 'kept' });
  });

  it('is idempotent, and close() still works after it', async () => {
    const g = setup();
    g.governor.stopWaits();
    g.governor.stopWaits();
    expect(g.governor.waitsHaveStopped).toBe(true);
    g.governor.close();
    const after = track(g.call({ costs: READ }));
    await flush();
    expect(after.error).toBeDefined();
  });
});
