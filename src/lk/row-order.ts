/**
 * LegendKeeper's ONE row order (hotfix, 10 November 2026; ADR 0032's consequences).
 *
 * LegendKeeper returns the same key-value rows in different orders from different endpoints: `listProperties`,
 * `getProperty` and `getResource` give a property's rows in the order they were stored, `listPropertyRows` gives them
 * sorted by `rank`. On a page where a row was ever inserted between two others the two orders differ, so anything that
 * compares rows read from two endpoints must first put them in the same order. The bridge's order is LegendKeeper's
 * display order: by `rank` as a plain string in code-unit order (what `<` does on JavaScript strings, never
 * `localeCompare`), ties broken by id.
 *
 * A row without a rank is one the bridge plans to create (LegendKeeper gives it its rank, from the `after` / `before`
 * placement). It keeps its place relative to the ranked rows around it: it stays after the ranked row it followed in
 * the list given (or at the head when none). A list in which no row has a rank is returned as given.
 */

/** Anything with an optional `rank` and `id` (a raw LegendKeeper row, a normalised one, a planned one). */
export interface Ranked {
  readonly id?: unknown;
  readonly rank?: unknown;
}

const rankOf = (r: Ranked): string | null => (typeof r.rank === 'string' && r.rank !== '' ? r.rank : null);
const idOf = (r: Ranked): string => (typeof r.id === 'string' ? r.id : '');

/** Code-unit order (never locale order): what LegendKeeper's rank sort does. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders two ranked rows: by rank, then by id. */
export function compareRanked(a: Ranked, b: Ranked): number {
  return compareCodeUnits(rankOf(a) ?? '', rankOf(b) ?? '') || compareCodeUnits(idOf(a), idOf(b));
}

/** The rows in LegendKeeper's display order (see the module comment). Never changes the list it is given. */
export function inRankOrder<T extends Ranked>(rows: readonly T[]): T[] {
  const head: T[] = [];
  const ranked: { row: T; followers: T[] }[] = [];
  let last: { row: T; followers: T[] } | null = null;
  for (const r of rows) {
    if (rankOf(r) === null) {
      (last ? last.followers : head).push(r);
      continue;
    }
    last = { row: r, followers: [] };
    ranked.push(last);
  }
  if (ranked.length === 0) return [...rows];
  // A stable sort, so equal (rank, id) pairs keep the order given.
  ranked.sort((a, b) => compareRanked(a.row, b.row));
  return [...head, ...ranked.flatMap((x) => [x.row, ...x.followers])];
}

/** Whether every row with a rank is already in rank order (rows without one are ignored). */
export function isInRankOrder(rows: readonly Ranked[]): boolean {
  let prev: Ranked | null = null;
  for (const r of rows) {
    if (rankOf(r) === null) continue;
    if (prev && compareRanked(prev, r) > 0) return false;
    prev = r;
  }
  return true;
}

/** `rows` of a raw LegendKeeper object (a key-value property, a stats block) in rank order; other values as given. */
export function rawRowsInRankOrder(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  const objs = rows as unknown[];
  if (!objs.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))) return rows;
  return inRankOrder(objs as Ranked[]);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A sidebar read (`getProperty`: one property; `getResource`: `properties`; `listProperties`: `data`) with every
 * key-value property's rows in rank order, for a fingerprint or a comparison that must not depend on which endpoint
 * (and so which order) the rows came from. Anything else is returned as given.
 */
export function sidebarInRankOrder(body: unknown): unknown {
  if (!isObj(body)) return body;
  const prop = (p: unknown): unknown =>
    isObj(p) && Array.isArray(p.rows) ? { ...p, rows: rawRowsInRankOrder(p.rows) } : p;
  if (Array.isArray(body.properties))
    return { ...body, properties: (body.properties as unknown[]).map(prop) };
  if (Array.isArray(body.data)) return { ...body, data: (body.data as unknown[]).map(prop) };
  return prop(body);
}
