import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  londonOffsetMinutes,
  londonToUtc,
  nextDailyRun,
  nextRun,
  parseSchedule,
} from '../../src/maintenance/index.js';

const iso = (ms: number) => new Date(ms).toISOString();
const utc = (s: string) => Date.parse(s);

describe('intervals', () => {
  it('count from the moment given', () => {
    expect(nextRun({ kind: 'interval', everySeconds: 10 }, utc('2026-11-07T12:00:00Z'))).toBe(
      utc('2026-11-07T12:00:10Z'),
    );
    expect(nextRun({ kind: 'interval', everySeconds: 604_800 }, utc('2026-11-07T12:00:00Z'))).toBe(
      utc('2026-11-14T12:00:00Z'),
    );
  });

  it('are validated: whole seconds between 10 s and 31 days', () => {
    for (const bad of [0, 9, 1.5, 31 * 86_400 + 1, -5, '10']) {
      expect(() => parseSchedule({ kind: 'interval', everySeconds: bad })).toThrow();
    }
    expect(parseSchedule({ kind: 'interval', everySeconds: 10 })).toEqual({
      kind: 'interval',
      everySeconds: 10,
    });
  });
});

describe('daily times on the London clock', () => {
  it('03:30 is 03:30 GMT in winter and 03:30 BST in summer', () => {
    expect(iso(nextDailyRun(utc('2026-01-15T12:00:00Z'), '03:30'))).toBe('2026-01-16T03:30:00.000Z');
    expect(iso(nextDailyRun(utc('2026-07-15T12:00:00Z'), '03:30'))).toBe('2026-07-16T02:30:00.000Z');
  });

  it('is strictly after the instant given, today or tomorrow', () => {
    expect(iso(nextDailyRun(utc('2026-01-15T03:00:00Z'), '03:30'))).toBe('2026-01-15T03:30:00.000Z');
    expect(iso(nextDailyRun(utc('2026-01-15T03:30:00Z'), '03:30'))).toBe('2026-01-16T03:30:00.000Z');
  });

  it('spring forward (29 March 2026): the gap between two runs is 23 hours', () => {
    const before = nextDailyRun(utc('2026-03-27T12:00:00Z'), '03:30'); // Sat 28th, GMT
    const after = nextDailyRun(before, '03:30'); // Sun 29th, BST
    expect(iso(before)).toBe('2026-03-28T03:30:00.000Z');
    expect(iso(after)).toBe('2026-03-29T02:30:00.000Z');
    expect((after - before) / 3_600_000).toBe(23);
    expect(iso(nextDailyRun(after, '03:30'))).toBe('2026-03-30T02:30:00.000Z');
  });

  it('autumn back (25 October 2026): the gap between two runs is 25 hours', () => {
    const before = nextDailyRun(utc('2026-10-23T12:00:00Z'), '03:30'); // Sat 24th, BST
    const after = nextDailyRun(before, '03:30'); // Sun 25th, GMT
    expect(iso(before)).toBe('2026-10-24T02:30:00.000Z');
    expect(iso(after)).toBe('2026-10-25T03:30:00.000Z');
    expect((after - before) / 3_600_000).toBe(25);
  });

  it('a time inside the spring gap (01:30 does not exist on 29 March) runs at 02:30 BST, once', () => {
    const run = nextDailyRun(utc('2026-03-28T12:00:00Z'), '01:30');
    expect(iso(run)).toBe('2026-03-29T01:30:00.000Z'); // 02:30 BST
    expect(iso(nextDailyRun(run, '01:30'))).toBe('2026-03-30T00:30:00.000Z');
  });

  it('a time that happens twice (01:30 on 25 October) runs at the first one, once', () => {
    const run = nextDailyRun(utc('2026-10-24T12:00:00Z'), '01:30');
    expect(iso(run)).toBe('2026-10-25T00:30:00.000Z'); // 01:30 BST, the first of the two
    expect(iso(nextDailyRun(run, '01:30'))).toBe('2026-10-26T01:30:00.000Z'); // the next day, in GMT
  });

  it('midnight and 23:59 behave around the changes', () => {
    expect(iso(nextDailyRun(utc('2026-03-28T12:00:00Z'), '00:00'))).toBe('2026-03-29T00:00:00.000Z');
    expect(iso(nextDailyRun(utc('2026-03-29T12:00:00Z'), '00:00'))).toBe('2026-03-29T23:00:00.000Z');
    expect(iso(nextDailyRun(utc('2026-10-24T12:00:00Z'), '23:59'))).toBe('2026-10-24T22:59:00.000Z');
  });

  it('knows London’s offset', () => {
    expect(londonOffsetMinutes(utc('2026-01-01T00:00:00Z'))).toBe(0);
    expect(londonOffsetMinutes(utc('2026-07-01T00:00:00Z'))).toBe(60);
    expect(londonOffsetMinutes(utc('2026-03-29T00:59:59Z'))).toBe(0);
    expect(londonOffsetMinutes(utc('2026-03-29T01:00:00Z'))).toBe(60);
    expect(iso(londonToUtc(2026, 7, 1, 12, 0))).toBe('2026-07-01T11:00:00.000Z');
  });

  it('rejects anything that is not HH:MM', () => {
    for (const bad of ['3:30', '24:00', '03:60', '0330', '', '03:30:00']) {
      expect(() => parseSchedule({ kind: 'daily', time: bad }), bad).toThrow();
    }
  });
});

describe('describeSchedule', () => {
  it('reads naturally', () => {
    expect(describeSchedule({ kind: 'interval', everySeconds: 10 })).toBe('Every 10 seconds');
    expect(describeSchedule({ kind: 'interval', everySeconds: 300 })).toBe('Every 5 minutes');
    expect(describeSchedule({ kind: 'interval', everySeconds: 3600 })).toBe('Hourly');
    expect(describeSchedule({ kind: 'interval', everySeconds: 604_800 })).toBe('Weekly');
    expect(describeSchedule({ kind: 'daily', time: '03:30' })).toBe('Daily at 03:30 (London time)');
  });
});
