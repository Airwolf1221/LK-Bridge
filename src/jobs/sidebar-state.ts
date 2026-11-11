/**
 * The state of sidebar properties, normalised for comparison (v2 C2a, ADR 0032). Shared by the bridge's own check
 * step (`bridge.expect`: is the property still what the plan was built on?), the in-step check of an unversioned
 * property write (`expectCurrent`), and the generic verify step (`bridge.verify`: did the writes land as planned?).
 *
 * What counts, and what does not (taken from LegendKeeper's spec 3.0.0, as for page writes in verify-blocks.ts):
 * - a key-value row is its id, its rank, its key and its value as runs; the runs are normalised as LegendKeeper
 *   normalises them (empty text runs dropped, neighbours with the same marks merged), and a mention's `name`
 *   (read-only: the page's current name) is ignored. A row's `text` is not compared (it is derived from the runs);
 * - rows are always put in LegendKeeper's ONE order first, by rank (src/lk/row-order.ts): its endpoints give the same
 *   rows in different orders (`listProperties`, `getProperty` and `getResource` in stored order, `listPropertyRows`
 *   sorted by rank), so a comparison by position across two endpoints saw a change on every row after the first one
 *   ever inserted between two others (the permanent VERSION_CONFLICT of 10 November 2026). Rows are compared by id:
 *   a row on one side only was added or removed, a changed rank is a reorder (a real change), and a planned new row
 *   (no id, no rank) is matched by key and must land where the plan put it;
 * - a link collection item is its id, its page and its document; the collection's `filter` is compared whole.
 */
import { createHash } from 'node:crypto';
import { inRankOrder } from '../lk/row-order.js';
import { normaliseRuns } from './verify-blocks.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One key-value row, normalised. `id` and `rank` are null for a row the plan creates (LegendKeeper gives it both).
 * `rank` is optional so an expectation stored before ranks were kept (no rank) still parses and compares by id.
 */
export interface RowState {
  readonly id: string | null;
  readonly rank?: string | null;
  readonly key: string;
  readonly content: readonly Obj[];
}

/** One link collection item, normalised. */
export interface ItemState {
  readonly id: string | null;
  readonly resourceId: string;
  readonly documentId: string | null;
}

/** A link collection's items and filter, normalised. */
export interface CollectionState {
  readonly items: readonly ItemState[];
  readonly filter: unknown;
}

/** Canonical JSON (sorted keys), so a hash does not depend on key order. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function stateHash(v: unknown): string {
  return createHash('sha256').update(stableJson(v)).digest('hex');
}

/**
 * C2d (ADR 0037; the OpenAPI schema, and the owner's sandbox run of 11 November 2026, B16): LegendKeeper trims a
 * leading or trailing `{ break: true }` run from a key-value row value. Every one of them is taken off here, so what the
 * bridge plans, sends and compares is what LegendKeeper stores. A value that is nothing but breaks becomes empty (no
 * runs): the row is cleared, as an empty value clears it.
 */
export function trimRowBreaks<T extends Obj>(runs: readonly T[]): T[] {
  let a = 0;
  let b = runs.length;
  while (a < b && runs[a]!.break === true) a++;
  while (b > a && runs[b - 1]!.break === true) b--;
  return runs.slice(a, b);
}

/**
 * A row's value as normalised runs: its `content`, or its `text` as one run when there is no content; leading and
 * trailing breaks trimmed, as LegendKeeper stores the value (C2d).
 */
export function normaliseContent(content: unknown, text?: unknown): Obj[] {
  const runs = Array.isArray(content)
    ? (content as unknown[]).filter(isObj)
    : typeof text === 'string' && text !== ''
      ? [{ text }]
      : [];
  return trimRowBreaks(normaliseRuns(runs)).map((r) =>
    isObj(r.mention) ? { ...r, mention: withoutKey(r.mention, 'name') } : r,
  );
}

function withoutKey(o: Obj, key: string): Obj {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

/**
 * Rows as LegendKeeper returns them (a key-value property's `rows`, or `listPropertyRows`' `data`), or as a plan
 * expects them, normalised and in LegendKeeper's one order (by rank; a planned row without one keeps its place).
 */
export function rowsState(rows: unknown): RowState[] {
  if (!Array.isArray(rows)) return [];
  return inRankOrder(
    (rows as unknown[]).filter(isObj).map((r) => ({
      id: typeof r.id === 'string' && r.id !== '' ? r.id : null,
      rank: typeof r.rank === 'string' && r.rank !== '' ? r.rank : null,
      key: typeof r.key === 'string' ? r.key : '',
      content: normaliseContent(r.content, r.text),
    })),
  );
}

/** A link collection (`resourceCollection` or `resourceLink`) as LegendKeeper returns it, normalised. */
export function collectionState(property: unknown): CollectionState {
  const p = isObj(property) ? property : {};
  const items = Array.isArray(p.items) ? (p.items as unknown[]).filter(isObj) : [];
  return {
    items: items.map((i) => ({
      id: typeof i.id === 'string' && i.id !== '' ? i.id : null,
      resourceId: typeof i.resourceId === 'string' ? i.resourceId : '',
      documentId: typeof i.documentId === 'string' && i.documentId !== '' ? i.documentId : null,
    })),
    filter: p.filter ?? null,
  };
}

/**
 * The hash an in-step check of a row write compares (`expectCurrent: { state: 'rows' }`): the rows' keys and values in
 * LegendKeeper's one order (by rank), without their ids or ranks (a row the same job created a moment ago has an id
 * and a rank the plan could not know; it sits where the plan put it, so the order still says whether it landed there).
 */
export function rowsContentHash(rows: readonly RowState[]): string {
  return stateHash(inRankOrder(rows).map((r) => ({ key: r.key, content: r.content })));
}

export interface StateDifference {
  /** Which target and where: `PROPERTIES rows[2].key`, `Dependencies items[3]`, `Dependencies filter`. */
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

const short = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > 300 ? `${s.slice(0, 300)}…` : (v ?? null);
};

const rowName = (label: string, r: RowState) => `${label} “${r.key}”${r.id ? ` (${r.id})` : ''}`;

/**
 * Rows compared in LegendKeeper's one order (by rank), BY ID (see the module comment):
 * - a row whose id is on one side only was removed (expected, not there) or added (there, not expected);
 * - a row on both sides must have the same key, the same value, and the same rank where both give one: a changed rank
 *   is a reorder, a real change;
 * - a planned new row (no id) is matched by key with a row the expectation does not name, and must stand where the
 *   plan put it among the matched rows (after the row it was placed after), so a row created in the wrong place is a
 *   difference;
 * - rows without an id on either side, left over, are compared position by position (the fallback).
 * Differences name the row: `PROPERTIES “Scope” (row id).value`.
 */
export function compareRows(
  label: string,
  expected: readonly RowState[],
  actual: readonly RowState[],
  out: StateDifference[] = [],
): StateDifference[] {
  const exp = inRankOrder(expected);
  const act = inRankOrder(actual);
  const actIndex = new Map(act.map((r, i) => [r, i]));
  const actById = new Map<string, RowState>();
  for (const a of act) if (a.id !== null && !actById.has(a.id)) actById.set(a.id, a);
  const pairs = new Map<RowState, RowState>();
  const used = new Set<RowState>();
  // 1. By id.
  for (const e of exp) {
    if (e.id === null) continue;
    const a = actById.get(e.id);
    if (a && !used.has(a)) {
      pairs.set(e, a);
      used.add(a);
    }
  }
  // 2. Planned new rows by key, among the rows the expectation does not name.
  const named = new Set(exp.flatMap((e) => (e.id !== null ? [e.id] : [])));
  for (const e of exp) {
    if (e.id !== null) continue;
    const a = act.find((x) => !used.has(x) && (x.id === null || !named.has(x.id)) && x.key === e.key);
    if (a) {
      pairs.set(e, a);
      used.add(a);
    }
  }
  // 3. The fallback: rows without an id on either side, by position.
  const restE = exp.filter((e) => !pairs.has(e) && e.id === null);
  const restA = act.filter((a) => !used.has(a) && a.id === null);
  restE.forEach((e, i) => {
    const a = restA[i];
    if (a) {
      pairs.set(e, a);
      used.add(a);
    }
  });

  const reordered = new Set<RowState>();
  for (const e of exp) {
    const a = pairs.get(e);
    if (!a) {
      out.push({ path: `${rowName(label, e)} (removed)`, expected: short(e), actual: '(no row)' });
      continue;
    }
    const name = rowName(label, e.id !== null ? e : { ...e, id: a.id });
    if (e.key !== a.key) out.push({ path: `${name}.key`, expected: e.key, actual: a.key });
    if (stableJson(e.content) !== stableJson(a.content))
      out.push({ path: `${name}.value`, expected: short(e.content), actual: short(a.content) });
    if (e.rank && a.rank && e.rank !== a.rank) {
      out.push({ path: `${name}.rank (reordered)`, expected: e.rank, actual: a.rank });
      reordered.add(e);
    }
  }
  // The order of the matched rows: those not on the longest run already in order were put somewhere else. Only rows
  // whose place the expectation knows count: a ranked row, or a planned new row (placed among ranked ones). A row of an
  // expectation stored before ranks were kept has no rank, and its list may be in stored order: it is matched by id.
  const matched = exp.filter((e) => pairs.has(e) && (e.rank || e.id === null));
  const pos = matched.map((e) => actIndex.get(pairs.get(e)!)!);
  for (const i of outOfOrder(pos)) {
    const e = matched[i]!;
    if (reordered.has(e)) continue;
    const a = pairs.get(e)!;
    const prevE = matched[i - 1];
    const prevA = act[actIndex.get(a)! - 1];
    out.push({
      path: `${rowName(label, e.id !== null ? e : { ...e, id: a.id })} (order)`,
      expected: prevE ? `after “${prevE.key}”` : 'first',
      actual: prevA ? `after “${prevA.key}”` : 'first',
    });
  }
  for (const a of act) {
    if (used.has(a)) continue;
    out.push({ path: `${rowName(label, a)} (added)`, expected: '(no row)', actual: short(a) });
  }
  return out;
}

/** The indexes of `pos` that are not on one longest increasing run (the rows that moved). */
function outOfOrder(pos: readonly number[]): number[] {
  const n = pos.length;
  if (n < 2) return [];
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (pos[j]! < pos[i]! && len[j]! + 1 > len[i]!) {
        len[i] = len[j]! + 1;
        prev[i] = j;
      }
    }
    if (len[i]! > len[best]!) best = i;
  }
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]!) keep.add(i);
  return [...Array(n).keys()].filter((i) => !keep.has(i));
}

/** Items compared position by position (ids where expected), and the filter whole. */
export function compareCollection(
  label: string,
  expected: CollectionState,
  actual: CollectionState,
  out: StateDifference[] = [],
): StateDifference[] {
  const n = Math.max(expected.items.length, actual.items.length);
  for (let i = 0; i < n; i++) {
    const e = expected.items[i];
    const a = actual.items[i];
    if (
      !e ||
      !a ||
      (e.id !== null && e.id !== a.id) ||
      e.resourceId !== a.resourceId ||
      e.documentId !== a.documentId
    ) {
      out.push({
        path: `${label} items[${i}]`,
        expected: e ? short(e) : '(no item)',
        actual: a ? short(a) : '(no item)',
      });
    }
  }
  if (stableJson(expected.filter) !== stableJson(actual.filter))
    out.push({ path: `${label} filter`, expected: short(expected.filter), actual: short(actual.filter) });
  return out;
}

// ============================================================================================ v2 C2b: the whole sidebar

/**
 * One sidebar property as `factsVersion` sees it: a key-value property's rows (rank order, by id) or a link collection's
 * items and filter. Other kinds (text fields, images, `unsupported`) are not part of the facts and are left out.
 */
export interface SidebarPropertyState {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly rows?: readonly RowState[];
  readonly collection?: CollectionState;
}

const FACT_KINDS: ReadonlySet<string> = new Set(['keyValue', 'resourceCollection', 'resourceLink']);

/**
 * The facts of a sidebar, normalised: a `listProperties` answer (`{ data }`), a `getResource` answer (`{ properties }`)
 * or a list of properties. Properties are sorted by id and rows put in rank order, so every endpoint gives the same
 * state whatever order it lists them in.
 */
export function sidebarState(body: unknown): SidebarPropertyState[] {
  const list = Array.isArray(body)
    ? body
    : isObj(body) && Array.isArray(body.data)
      ? body.data
      : isObj(body) && Array.isArray(body.properties)
        ? body.properties
        : [];
  return (list as unknown[])
    .filter(isObj)
    .filter((p) => typeof p.kind === 'string' && FACT_KINDS.has(p.kind))
    .map((p) => {
      const base = {
        id: typeof p.id === 'string' ? p.id : '',
        kind: p.kind as string,
        title: typeof p.title === 'string' ? p.title : '',
      };
      return p.kind === 'keyValue'
        ? { ...base, rows: rowsState(p.rows) }
        : { ...base, collection: collectionState(p) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * `factsVersion` (v2 C2b): the bridge's own version of a page's sidebar facts, since LegendKeeper gives none that covers
 * the whole sidebar. A stable hash of `sidebarState`: the same on every read of an unchanged sidebar, from any endpoint;
 * different after any change to a row (key, value, rank, added or removed) or to a link collection (items or filter).
 *
 * C2d (ADR 0037): `fv2_`, the page's id hashed in. Copies of one template share their property, row and item ids
 * (LegendKeeper reuses them), so two untouched copies had the same `fv1_` version, and a version read on one page
 * passed as `baseFactsVersion` on its twin. A version now belongs to exactly one page.
 */
export function factsVersionOf(resourceId: string, state: readonly SidebarPropertyState[]): string {
  return `fv2_${stateHash({ page: resourceId, facts: state }).slice(0, 24)}`;
}

/** Every difference between two sidebar states, property by property (rows by id, items in order). */
export function compareSidebarStates(
  expected: readonly SidebarPropertyState[],
  actual: readonly SidebarPropertyState[],
  out: StateDifference[] = [],
): StateDifference[] {
  const byId = new Map(actual.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const e of expected) {
    const a = byId.get(e.id);
    const label = e.title || e.id;
    if (!a) {
      out.push({ path: `${label} (property removed)`, expected: 'present', actual: '(gone)' });
      continue;
    }
    seen.add(e.id);
    if (a.title !== e.title) out.push({ path: `${label} title`, expected: e.title, actual: a.title });
    if (e.rows || a.rows) compareRows(label, e.rows ?? [], a.rows ?? [], out);
    if (e.collection || a.collection)
      compareCollection(
        label,
        e.collection ?? { items: [], filter: null },
        a.collection ?? { items: [], filter: null },
        out,
      );
  }
  for (const a of actual) {
    if (!seen.has(a.id))
      out.push({ path: `${a.title || a.id} (property added)`, expected: '(no property)', actual: a.kind });
  }
  return out;
}
