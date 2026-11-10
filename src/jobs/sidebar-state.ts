/**
 * The state of sidebar properties, normalised for comparison (v2 C2a, ADR 0032). Shared by the bridge's own check
 * step (`bridge.expect`: is the property still what the plan was built on?), the in-step check of an unversioned
 * property write (`expectCurrent`), and the generic verify step (`bridge.verify`: did the writes land as planned?).
 *
 * What counts, and what does not (taken from LegendKeeper's spec 3.0.0, as for page writes in verify-blocks.ts):
 * - a key-value row is its id, its key and its value as runs; the runs are normalised as LegendKeeper normalises them
 *   (empty text runs dropped, neighbours with the same marks merged), and a mention's `name` (read-only: the page's
 *   current name) is ignored. A row's `rank` and `text` are not compared: the order of the list is the order, and the
 *   text is derived from the runs;
 * - a link collection item is its id, its page and its document; the collection's `filter` is compared whole.
 */
import { createHash } from 'node:crypto';
import { normaliseRuns } from './verify-blocks.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One key-value row, normalised. `id` is null for a row the plan creates (LegendKeeper gives it its id). */
export interface RowState {
  readonly id: string | null;
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

/** A row's value as normalised runs: its `content`, or its `text` as one run when there is no content. */
export function normaliseContent(content: unknown, text?: unknown): Obj[] {
  const runs = Array.isArray(content)
    ? (content as unknown[]).filter(isObj)
    : typeof text === 'string' && text !== ''
      ? [{ text }]
      : [];
  return normaliseRuns(runs).map((r) =>
    isObj(r.mention) ? { ...r, mention: withoutKey(r.mention, 'name') } : r,
  );
}

function withoutKey(o: Obj, key: string): Obj {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

/** Rows as LegendKeeper returns them (a key-value property's `rows`, or `listPropertyRows`' `data`), normalised. */
export function rowsState(rows: unknown): RowState[] {
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[]).filter(isObj).map((r) => ({
    id: typeof r.id === 'string' && r.id !== '' ? r.id : null,
    key: typeof r.key === 'string' ? r.key : '',
    content: normaliseContent(r.content, r.text),
  }));
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
 * order, without their ids (a row the same job created a moment ago has an id the plan could not know).
 */
export function rowsContentHash(rows: readonly RowState[]): string {
  return stateHash(rows.map((r) => ({ key: r.key, content: r.content })));
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

/**
 * Rows compared position by position: the same number of rows, each with the same key and value, and the same id
 * where the expectation names one (a row the plan created has `id: null`, and any id is accepted for it).
 */
export function compareRows(
  label: string,
  expected: readonly RowState[],
  actual: readonly RowState[],
  out: StateDifference[] = [],
): StateDifference[] {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e || !a) {
      out.push({
        path: `${label} rows[${i}]`,
        expected: e ? short(e) : '(no row)',
        actual: a ? short(a) : '(no row)',
      });
      continue;
    }
    if (e.id !== null && e.id !== a.id)
      out.push({ path: `${label} rows[${i}].id`, expected: e.id, actual: a.id });
    if (e.key !== a.key) out.push({ path: `${label} rows[${i}].key`, expected: e.key, actual: a.key });
    if (stableJson(e.content) !== stableJson(a.content))
      out.push({ path: `${label} rows[${i}].value`, expected: short(e.content), actual: short(a.content) });
  }
  return out;
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
