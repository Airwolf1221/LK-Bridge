/**
 * Maintenance schedules: a fixed interval, or a daily time on the Europe/London clock (docs/maintenance.md).
 *
 * Daily times follow the British clocks change: "03:30" is 03:30 GMT in winter and 03:30 BST in summer, so the
 * gap between two runs is 23 or 25 hours across the change. A time that does not exist on the spring day (01:00 to
 * 01:59) runs at the same wall-clock reading after the gap (02:30 BST for 01:30); a time that happens twice on the
 * autumn day (01:00 to 01:59) runs at the first one.
 */
import * as z from 'zod';

export const LONDON = 'Europe/London';
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 31 * 86_400;

export type Schedule =
  | { readonly kind: 'interval'; readonly everySeconds: number }
  | { readonly kind: 'daily'; readonly time: string };

export const scheduleSchema: z.ZodType<Schedule> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    everySeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
  }),
  z.object({
    kind: z.literal('daily'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 03:30'),
  }),
]);

export function parseSchedule(value: unknown): Schedule {
  return scheduleSchema.parse(value);
}

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface LocalParts {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly hh: number;
  readonly mm: number;
}

function londonParts(utcMs: number): LocalParts & { readonly ss: number } {
  const get: Record<string, number> = {};
  for (const p of partsFormat.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') get[p.type] = Number(p.value);
  }
  return { y: get.year!, m: get.month!, d: get.day!, hh: get.hour!, mm: get.minute!, ss: get.second! };
}

/** London's offset from UTC at an instant, in minutes (0 in winter, 60 in summer). */
export function londonOffsetMinutes(utcMs: number): number {
  const p = londonParts(utcMs);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** The UTC instant of a London wall-clock reading (see the module comment for the two odd days). */
export function londonToUtc(y: number, m: number, d: number, hh: number, mm: number): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // Try summer time first so that an ambiguous reading resolves to the first of its two occurrences.
  for (const offset of [60, 0]) {
    const utc = naive - offset * 60_000;
    if (londonOffsetMinutes(utc) === offset) return utc;
  }
  return naive; // a reading inside the spring gap: the same reading on the far side of it
}

/** The first run strictly after `afterMs` of a daily London time. */
export function nextDailyRun(afterMs: number, time: string): number {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const today = londonParts(afterMs);
  // Try today and the next three London dates (three is more than enough; a day is never skipped by the clocks).
  for (let add = 0; add < 4; add++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + add));
    const utc = londonToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
    if (utc > afterMs) return utc;
  }
  throw new Error('nextDailyRun: no run found'); // unreachable
}

/**
 * When a job is next due, counting from `fromMs`: an interval from the moment a run starts or the job is enabled
 * (so a restart never queues a backlog), a daily time from the next occurrence.
 */
export function nextRun(schedule: Schedule, fromMs: number): number {
  return schedule.kind === 'interval'
    ? fromMs + schedule.everySeconds * 1000
    : nextDailyRun(fromMs, schedule.time);
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === 'daily') return `Daily at ${s.time} (London time)`;
  const n = s.everySeconds;
  if (n % 604_800 === 0) return n === 604_800 ? 'Weekly' : `Every ${n / 604_800} weeks`;
  if (n % 86_400 === 0) return n === 86_400 ? 'Daily' : `Every ${n / 86_400} days`;
  if (n % 3600 === 0) return n === 3600 ? 'Hourly' : `Every ${n / 3600} hours`;
  if (n % 60 === 0) return n === 60 ? 'Every minute' : `Every ${n / 60} minutes`;
  return `Every ${n} seconds`;
}
