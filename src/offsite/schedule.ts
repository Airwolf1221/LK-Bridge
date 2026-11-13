/**
 * When the off-site runner's scheduled work is due (v2 E1b, ADR 0043). The systemd timer only wakes the runner every 15
 * minutes; the schedule itself is the owner's, in the database, so it is edited on the dashboard without touching a unit:
 *
 * - **copy:** daily at `copyTime` (London). Due when no copy has started since the latest such time.
 * - **verify:** monthly on `verifyDay` at `verifyTime` (London). Due when no verify has started since the latest such time.
 */
import { londonToUtc, nextDailyRun } from '../maintenance/schedule.js';

/** The latest daily London time at or before `now`. */
export function latestDailySlot(now: number, time: string): number {
  let s = nextDailyRun(now - 3 * 86_400_000, time);
  for (;;) {
    const n = nextDailyRun(s, time);
    if (n > now) return s;
    s = n;
  }
}

const ymFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
});
function londonYearMonth(ms: number): { y: number; m: number } {
  const p: Record<string, number> = {};
  for (const x of ymFormat.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month! };
}

function monthlySlot(y: number, m: number, day: number, time: string): number {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return londonToUtc(y, m, day, hh, mm);
}

/** The latest monthly slot (day and London time) at or before `now`. */
export function latestMonthlySlot(now: number, day: number, time: string): number {
  let { y, m } = londonYearMonth(now);
  for (let i = 0; i < 3; i++) {
    const s = monthlySlot(y, m, day, time);
    if (s <= now) return s;
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  throw new Error('latestMonthlySlot: none found'); // unreachable
}

export function nextMonthlySlot(now: number, day: number, time: string): number {
  let { y, m } = londonYearMonth(now);
  for (let i = 0; i < 3; i++) {
    const s = monthlySlot(y, m, day, time);
    if (s > now) return s;
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  throw new Error('nextMonthlySlot: none found'); // unreachable
}

/** Whether a scheduled run is due: nothing of that kind started since the latest slot. */
export function isDue(latestSlot: number, lastStartedAt: number | null | undefined): boolean {
  return lastStartedAt === null || lastStartedAt === undefined || lastStartedAt < latestSlot;
}

/** The timer wakes the runner on every quarter hour, so a scheduled run starts up to this long after its time. */
export const TIMER_TICK_MS = 15 * 60_000;

export { nextDailyRun };
