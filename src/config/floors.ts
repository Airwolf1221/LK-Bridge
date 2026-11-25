/**
 * The reserve floors' order and the bulk floor (v3 F9, ADR 0074). A leaf module (it imports nothing of the bridge's
 * own), so the environment schema (`./index.ts`) and the governor settings (`./lk.ts`) can both use it without the
 * import cycle between those two mattering at load time.
 */

/** Bulk (P4) may use at most 30% of each tier by default: it leaves 70% untouched. */
export const DEFAULT_BULK_FLOOR = 0.7;

/**
 * The bulk floor in force. An explicit value is used as it is (it was checked against the order when it was set);
 * without one, the default, raised to the maintenance floor if the owner has raised that above it, so the order
 * `maintenance <= bulk` always holds and a raised P3 floor never stops the bridge starting.
 */
export function effectiveBulkFloor(maintenance: number, explicit: number | null | undefined): number {
  return explicit ?? Math.max(DEFAULT_BULK_FLOOR, maintenance);
}

/** The refusal of a bulk floor below the maintenance floor, naming both (as percentages). */
export function bulkOrderMessage(maintenance: number, bulk: number): string {
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
  return (
    `The bulk floor (${pct(bulk)}) is below the maintenance floor (${pct(maintenance)}): bulk must leave at least as ` +
    'much of each tier untouched as maintenance (interactive <= job <= maintenance <= bulk).'
  );
}

/**
 * v3 F9 amendment 1 (ADR 0074, 25 November 2026): the floors of the DAILY tier (key-day, and any learned tier with a
 * day's window). The four floors above keep applying to the minute and hour tiers; on the day they would bar bulk for
 * the rest of a busy day while the hourly tiers sat almost empty (30% of 60,000 is 18,000 requests). The day floors'
 * only purpose is to keep a reserve of the day for the owner's interactive work, so they are small. The same order.
 */
export const DEFAULT_DAY_FLOORS = {
  interactive: 0.02,
  job: 0.05,
  maintenance: 0.1,
  bulk: 0.15,
} as const;

export interface DayFloors {
  readonly interactive: number;
  readonly job: number;
  readonly maintenance: number;
  readonly bulk: number;
}

/** The refusal of day floors out of order, naming the first pair that breaks it (as percentages); null when in order. */
export function dayOrderMessage(f: DayFloors): string | null {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const pairs: [keyof DayFloors, keyof DayFloors][] = [
    ['interactive', 'job'],
    ['job', 'maintenance'],
    ['maintenance', 'bulk'],
  ];
  for (const [lo, hi] of pairs) {
    if (f[lo] > f[hi]) {
      return (
        `The day floor for ${hi} (${pct(f[hi])}) is below the day floor for ${lo} (${pct(f[lo])}): the day floors ` +
        'must rise as the floors do (interactive <= job <= maintenance <= bulk).'
      );
    }
  }
  return null;
}

/**
 * v3 F9 amendment 1 (ADR 0074): which row of floors a tier falls under, by its window: a window longer than an hour
 * (key-day; a learned tier with a day's window) is the daily row, every other counted tier (write-min, write-hour,
 * key-min, key-hour, project-hour, items-min, items-hour, a learned tier of up to an hour) the minute-and-hour row.
 */
export type FloorRow = 'minute-hour' | 'day';
export function floorRowOf(windowMs: number): FloorRow {
  return windowMs > 3_600_000 ? 'day' : 'minute-hour';
}

/** The floor a class must leave of a tier with this window (P0 to P4, as the governor's settings keep them). */
export function floorFor<C extends string>(
  settings: {
    readonly reserveFloors: Readonly<Record<C, number>>;
    readonly dayReserveFloors: Readonly<Record<C, number>>;
  },
  cls: C,
  windowMs: number,
): number {
  return floorRowOf(windowMs) === 'day' ? settings.dayReserveFloors[cls] : settings.reserveFloors[cls];
}
