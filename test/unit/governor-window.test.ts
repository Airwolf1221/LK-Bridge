import { describe, expect, it } from 'vitest';
import { SlidingWindow } from '../../src/lk/governor/window.js';

describe('SlidingWindow', () => {
  it('counts units while now < t + window and expires them exactly at t + window', () => {
    const w = new SlidingWindow(60_000);
    w.add(0, 1);
    w.add(10_000, 2);
    expect(w.used(59_999)).toBe(3);
    expect(w.used(60_000)).toBe(2);
    expect(w.used(69_999)).toBe(2);
    expect(w.used(70_000)).toBe(0);
  });

  it('computes the earliest time a cost fits under a cap', () => {
    const w = new SlidingWindow(60_000);
    for (let t = 0; t < 5; t++) w.add(t * 1000, 1);
    expect(w.readyAt(5000, 1, 6)).toBe(5000); // 5 + 1 <= 6
    expect(w.readyAt(5000, 1, 5)).toBe(60_000); // oldest must leave
    expect(w.readyAt(5000, 3, 5)).toBe(62_000); // three oldest must leave
    expect(w.readyAt(5000, 6, 5)).toBe(Number.POSITIVE_INFINITY); // can never fit
  });

  it('weights events (createMany items)', () => {
    const w = new SlidingWindow(60_000);
    w.add(0, 100);
    w.add(1000, 100);
    expect(w.used(1000)).toBe(200);
    expect(w.readyAt(1000, 100, 250)).toBe(60_000);
  });

  it('refunds an event and removes units from the oldest first', () => {
    const w = new SlidingWindow(60_000);
    const a = w.add(0, 1);
    w.add(1000, 1);
    w.add(2000, 1);
    w.refund(2000, a);
    expect(w.used(2000)).toBe(2);
    w.refund(2000, a); // idempotent
    expect(w.used(2000)).toBe(2);
    w.removeOldest(2000, 1);
    expect(w.used(2000)).toBe(1);
    expect(w.nextExpiry(2000)).toBe(62_000);
  });

  it('inserts backdated (phantom) events in time order', () => {
    const w = new SlidingWindow(60_000);
    w.add(30_000, 1);
    w.add(30_000, 5, 10_000); // server correction: units that expire at 70 s
    expect(w.used(30_000)).toBe(6);
    expect(w.nextExpiry(30_000)).toBe(70_000);
    expect(w.used(70_000)).toBe(1);
    expect(w.clearsAt(70_000)).toBe(90_000);
  });

  it('stays exact over many events (compaction)', () => {
    const w = new SlidingWindow(1000);
    for (let t = 0; t < 10_000; t++) w.add(t, 1);
    expect(w.used(9999)).toBe(1000);
    expect(w.used(20_000)).toBe(0);
  });
});
