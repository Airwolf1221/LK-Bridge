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
