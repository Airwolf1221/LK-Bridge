/**
 * The block-id sweep's pure rules (v3 F3.5, ADR 0056): which documents are legacy, and whether `assignBlockIds` left a
 * document exactly as it was apart from its block ids.
 *
 * - **Legacy** is the rule `planBlockwise` refuses on (src/pages/blockwise.ts, refusal `ids`): a block with no id, or
 *   an id used more than once, anywhere in the tree. Blocks nest only in `children` (LegendKeeper's block schema), so
 *   the walk follows `children`, as `planBlockwise` does. A test pins the two rules together.
 * - **The comparison** strips every block's `id` and its read-only `version` (at every depth) and compares the rest
 *   canonically: block kinds, order, nesting, text runs and marks, every other field (rows, items, cells, settings).
 *   It also counts the `unsupported` blocks on each side. Anything else that differs is a verification failure.
 *
 * Pure: no LegendKeeper calls, no clock.
 */
import { stableJson } from '../jobs/sidebar-state.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What makes a document legacy (none of it: the document is clean). */
export interface LegacyProblems {
  /** Blocks in the tree (every depth). */
  readonly blocks: number;
  /** Blocks without an id (or with an empty one). */
  readonly missing: number;
  /** Ids used by more than one block (each listed once, sorted). */
  readonly duplicates: readonly string[];
  /** `unsupported` blocks in the tree (with or without an id). */
  readonly unsupported: number;
}

/** Walks a block tree through `children`, in document order. */
function walk(blocks: readonly unknown[], visit: (b: Obj) => void): void {
  const stack: unknown[] = [...blocks].reverse();
  let guard = 0;
  while (stack.length > 0) {
    const b = stack.pop();
    if (++guard > 1_000_000) break; // a pathological tree (LegendKeeper caps nesting at 64 and blocks at 10,000)
    if (!isObj(b)) continue;
    visit(b);
    if (Array.isArray(b.children)) for (let i = b.children.length - 1; i >= 0; i--) stack.push(b.children[i]);
  }
}

/** The legacy problems of a document's blocks. */
export function legacyProblems(blocks: readonly unknown[]): LegacyProblems {
  let n = 0;
  let missing = 0;
  let unsupported = 0;
  const seen = new Set<string>();
  const dup = new Set<string>();
  walk(blocks, (b) => {
    n++;
    if (b.kind === 'unsupported') unsupported++;
    const id = typeof b.id === 'string' && b.id !== '' ? b.id : null;
    if (id === null) missing++;
    else if (seen.has(id)) dup.add(id);
    else seen.add(id);
  });
  return { blocks: n, missing, duplicates: [...dup].sort(), unsupported };
}

/** True when a document has a block without an id, or an id used twice (a legacy page). */
export function isLegacy(blocks: readonly unknown[]): boolean {
  const p = legacyProblems(blocks);
  return p.missing > 0 || p.duplicates.length > 0;
}

/** Every `unsupported` block in a tree (with or without an id). */
export function unsupportedCount(blocks: readonly unknown[]): number {
  return legacyProblems(blocks).unsupported;
}

/** A copy of a block tree without any block's `id` or read-only `version` (every depth). Nothing else is touched. */
export function withoutBlockIds(blocks: readonly unknown[]): unknown[] {
  return blocks.map((b) => {
    if (!isObj(b)) return b;
    const o: Obj = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'id' || k === 'version') continue;
      o[k] = k === 'children' && Array.isArray(v) ? withoutBlockIds(v) : v;
    }
    return o;
  });
}

/** One difference the verification found (the engine's `StateDifference` shape). */
export interface BlockIdDifference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** The first differences between two trees with their block ids taken out (at most `max`). */
function treeDifferences(
  before: unknown,
  after: unknown,
  path: string,
  out: BlockIdDifference[],
  max: number,
) {
  if (out.length >= max) return;
  if (stableJson(before) === stableJson(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      out.push({ path: `${path}.length`, expected: before.length, actual: after.length });
      return;
    }
    for (let i = 0; i < before.length && out.length < max; i++)
      treeDifferences(before[i], after[i], `${path}[${i}]`, out, max);
    return;
  }
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      if (out.length >= max) return;
      treeDifferences(before[k], after[k], `${path}.${k}`, out, max);
    }
    return;
  }
  out.push({ path, expected: before ?? null, actual: after ?? null });
}

/** The outcome of the after-check: the document as read back against its pre-image. */
export interface BlockIdVerification {
  /** True when nothing but block ids changed, every block has an id and no id is used twice. */
  readonly ok: boolean;
  readonly differences: readonly BlockIdDifference[];
  readonly before: LegacyProblems;
  readonly after: LegacyProblems;
}

/**
 * Compares the document after `assignBlockIds` with its pre-image: identical apart from block ids (and the read-only
 * per-block versions), the same number of `unsupported` blocks, every block with an id, and no id twice.
 */
export function verifyAssigned(
  before: readonly unknown[],
  after: readonly unknown[],
  max = 20,
): BlockIdVerification {
  const differences: BlockIdDifference[] = [];
  const pb = legacyProblems(before);
  const pa = legacyProblems(after);
  if (pa.unsupported !== pb.unsupported)
    differences.push({ path: 'unsupported blocks', expected: pb.unsupported, actual: pa.unsupported });
  treeDifferences(withoutBlockIds(before), withoutBlockIds(after), 'blocks', differences, max);
  if (pa.missing > 0)
    differences.push({
      path: 'block ids',
      expected: 'every block has an id',
      actual: `${pa.missing} without one`,
    });
  if (pa.duplicates.length > 0)
    differences.push({
      path: 'block ids',
      expected: 'no id used twice',
      actual: `used more than once: ${pa.duplicates.slice(0, 10).join(', ')}`,
    });
  return { ok: differences.length === 0, differences: differences.slice(0, max + 3), before: pb, after: pa };
}
