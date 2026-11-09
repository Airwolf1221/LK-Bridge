/**
 * Sequence alignment for block matching: which items of `a` (the current page) and `b` (the parsed Markdown) are the
 * same, given integer fingerprints. Common prefix and suffix first (most edits touch one place), then an exact longest
 * common subsequence when the middle is small enough, else patience-style anchors (items unique on both sides) with the
 * same treatment recursively between them. A 3,000-row table with one edited row aligns in well under a millisecond.
 */

/** Largest middle part solved exactly by dynamic programming (cells of a Uint16 table, about 8 MB). */
const DP_LIMIT = 4_000_000;

/** Returns the matched index pairs, increasing in both coordinates. Equal values only are matched. */
export function lcsPairs(a: readonly number[], b: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  solve(a, b, 0, a.length, 0, b.length, out);
  out.sort((x, y) => x[0] - y[0]);
  return out;
}

function solve(
  a: readonly number[],
  b: readonly number[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  out: [number, number][],
): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push([a0++, b0++]);
  const tail: [number, number][] = [];
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) tail.push([--a1, --b1]);
  const n = a1 - a0;
  const m = b1 - b0;
  if (n > 0 && m > 0) {
    if (n * m <= DP_LIMIT) dp(a, b, a0, a1, b0, b1, out);
    else patience(a, b, a0, a1, b0, b1, out);
  }
  out.push(...tail.reverse());
}

function dp(
  a: readonly number[],
  b: readonly number[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  out: [number, number][],
): void {
  const n = a1 - a0;
  const m = b1 - b0;
  const w = m + 1;
  // Lengths fit in 16 bits: a container holds at most 10,000 blocks.
  const t = n < 65_535 && m < 65_535 ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[a0 + i];
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] =
        ai === b[b0 + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out.push([a0 + i, b0 + j]);
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
    else j++;
  }
}

function patience(
  a: readonly number[],
  b: readonly number[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  out: [number, number][],
): void {
  const countA = new Map<number, number>();
  const countB = new Map<number, number>();
  const posB = new Map<number, number>();
  for (let i = a0; i < a1; i++) countA.set(a[i]!, (countA.get(a[i]!) ?? 0) + 1);
  for (let j = b0; j < b1; j++) {
    countB.set(b[j]!, (countB.get(b[j]!) ?? 0) + 1);
    posB.set(b[j]!, j);
  }
  const cand: [number, number][] = [];
  for (let i = a0; i < a1; i++) {
    const v = a[i]!;
    if (countA.get(v) === 1 && countB.get(v) === 1) cand.push([i, posB.get(v)!]);
  }
  if (cand.length === 0) return; // nothing unique in common: leave the middle unmatched
  // Longest increasing subsequence of the b positions (patience sorting).
  const tails: number[] = [];
  const prev = new Array<number>(cand.length).fill(-1);
  for (let k = 0; k < cand.length; k++) {
    const y = cand[k]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cand[tails[mid]!]![1] < y) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  }
  const anchors: [number, number][] = [];
  for (let k = tails[tails.length - 1]!; k >= 0; k = prev[k]!) anchors.push(cand[k]!);
  anchors.reverse();
  let pa = a0;
  let pb = b0;
  for (const [i, j] of anchors) {
    solve(a, b, pa, i, pb, j, out);
    out.push([i, j]);
    pa = i + 1;
    pb = j + 1;
  }
  solve(a, b, pa, a1, pb, b1, out);
}

/**
 * Pairs the unmatched items of one gap as "the same block, edited": same kind, in order, preferring similar content.
 * Returns pairs of indexes into `a` and `b` (the gap's own arrays).
 */
export function pairGap(
  a: readonly { kind: string; text: string; pairable: boolean }[],
  b: readonly { kind: string; text: string; pairable: boolean }[],
): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > DP_LIMIT) {
    // Huge gaps: pair in order by kind only.
    const out: [number, number][] = [];
    let j = 0;
    for (let i = 0; i < n && j < m; i++) {
      if (!a[i]!.pairable) continue;
      while (j < m && (!b[j]!.pairable || b[j]!.kind !== a[i]!.kind)) j++;
      if (j < m) out.push([i, j++]);
    }
    return out;
  }
  // A kind with exactly one candidate on each side pairs whatever the text: the usual "one block edited" case.
  const count = (list: typeof a) => {
    const c = new Map<string, number>();
    for (const x of list) if (x.pairable) c.set(x.kind, (c.get(x.kind) ?? 0) + 1);
    return c;
  };
  const ca = count(a);
  const cb = count(b);
  const score = (i: number, j: number): number => {
    const x = a[i]!;
    const y = b[j]!;
    if (!x.pairable || !y.pairable || x.kind !== y.kind) return 0;
    if (ca.get(x.kind) === 1 && cb.get(x.kind) === 1) return 1;
    const s = similarity(x.text, y.text);
    return s >= 0.3 ? s : 0;
  };
  // Maximum total similarity, order preserved (a weighted LCS).
  const w = m + 1;
  const t = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      t[i * w + j] = Math.max(
        t[(i + 1) * w + j]!,
        t[i * w + j + 1]!,
        s > 0 ? t[(i + 1) * w + j + 1]! + s : 0,
      );
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s > 0 && t[i * w + j] === t[(i + 1) * w + j + 1]! + s) {
      out.push([i, j]);
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

/** Dice coefficient on character bigrams (texts cut to 2,000 characters). 1 for two empty texts. */
export function similarity(x: string, y: string): number {
  const s = x.slice(0, 2000);
  const t = y.slice(0, 2000);
  if (s === t) return 1;
  if (s.length < 2 || t.length < 2) return s.length === 0 && t.length === 0 ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    const c = grams.get(g) ?? 0;
    if (c > 0) {
      common++;
      grams.set(g, c - 1);
    }
  }
  return (2 * common) / (s.length - 1 + (t.length - 1));
}
