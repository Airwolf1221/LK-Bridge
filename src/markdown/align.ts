/**
 * Sequence alignment for block matching: which items of `a` (the current page) and `b` (the parsed Markdown) are the
 * same, given integer fingerprints. Common prefix and suffix first (most edits touch one place), then an exact longest
 * common subsequence when the middle is small enough, else patience-style anchors (items unique on both sides) with the
 * same treatment recursively between them. A 3,000-row table with one edited row aligns in well under a millisecond.
 *
 * Identical items ("twins", such as two empty paragraphs) make the longest common subsequence ambiguous. Ties are broken
 * by position: of all the longest subsequences, the one whose pairs sit closest to their own place (least total
 * |i − j|, counted from the start of the part being solved) wins; exact ties are settled the same way every time
 * (match first, then skip the current item). So an in-place edit of one twin never moves another twin's id or
 * attributes. pairGap breaks its ties the same way.
 */

/**
 * Largest middle part solved exactly by dynamic programming (per cell a Uint16 length and a Uint32 displacement, about
 * 24 MB at the limit).
 */
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
  // For the suffixes a[i..], b[j..]: the longest common subsequence's length `t` and, among those, the least total
  // displacement `c` (sum of |i − j| over its pairs). Lengths fit in 16 bits: a container holds at most 10,000 blocks;
  // a displacement total is at most n·m ≤ DP_LIMIT.
  const t = n < 65_535 && m < 65_535 ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w);
  const c = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[a0 + i];
    for (let j = m - 1; j >= 0; j--) {
      const k = i * w + j;
      // Skip a[i] or b[j], whichever leaves the better rest (longer, then less displaced).
      const down = k + w;
      const right = k + 1;
      let bestT = t[down]!;
      let bestC = c[down]!;
      if (t[right]! > bestT || (t[right] === bestT && c[right]! < bestC)) {
        bestT = t[right]!;
        bestC = c[right]!;
      }
      if (ai === b[b0 + j]) {
        const mt = t[down + 1]! + 1;
        const mc = c[down + 1]! + Math.abs(i - j);
        if (mt > bestT || (mt === bestT && mc <= bestC)) {
          bestT = mt;
          bestC = mc;
        }
      }
      t[k] = bestT;
      c[k] = bestC;
    }
  }
  // Walk the optimum, preferring a match, then skipping a[i], then skipping b[j] (deterministic on exact ties).
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const k = i * w + j;
    if (a[a0 + i] === b[b0 + j] && t[k + w + 1]! + 1 === t[k] && c[k + w + 1]! + Math.abs(i - j) === c[k]) {
      out.push([a0 + i, b0 + j]);
      i++;
      j++;
    } else if (t[k + w] === t[k] && c[k + w] === c[k]) i++;
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
  // A kind with exactly one candidate on each side pairs whatever the text: the usual "one block edited" case. Likewise
  // a run of identical current blocks ("twins", such as empty paragraphs) with as many candidates on each side: they
  // were edited in place, and similarity cannot tell them apart (an empty text is similar to nothing).
  const count = (list: typeof a) => {
    const c = new Map<string, number>();
    for (const x of list) if (x.pairable) c.set(x.kind, (c.get(x.kind) ?? 0) + 1);
    return c;
  };
  const ca = count(a);
  const cb = count(b);
  // Per kind: whether every current candidate has the same text (the first one's).
  const firstText = new Map<string, string>();
  const twins = new Map<string, boolean>();
  for (const x of a) {
    if (!x.pairable) continue;
    const first = firstText.get(x.kind);
    if (first === undefined) {
      firstText.set(x.kind, x.text);
      twins.set(x.kind, true);
    } else if (first !== x.text) twins.set(x.kind, false);
  }
  const score = (i: number, j: number): number => {
    const x = a[i]!;
    const y = b[j]!;
    if (!x.pairable || !y.pairable || x.kind !== y.kind) return 0;
    if (ca.get(x.kind) === cb.get(x.kind) && twins.get(x.kind) === true) return 1;
    const s = similarity(x.text, y.text);
    return s >= 0.3 ? s : 0;
  };
  // Maximum total similarity, order preserved (a weighted LCS); among equal totals, the least total displacement
  // |i − j|, so identical candidates pair in place.
  const EPS = 1e-9;
  const w = m + 1;
  const t = new Float64Array((n + 1) * w);
  const c = new Float64Array((n + 1) * w);
  const better = (s1: number, c1: number, s2: number, c2: number) =>
    s1 > s2 + EPS || (Math.abs(s1 - s2) <= EPS && c1 < c2);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const k = i * w + j;
      let bs = t[k + w]!;
      let bc = c[k + w]!;
      if (better(t[k + 1]!, c[k + 1]!, bs, bc)) {
        bs = t[k + 1]!;
        bc = c[k + 1]!;
      }
      const s = score(i, j);
      if (s > 0) {
        const ms = t[k + w + 1]! + s;
        const mc = c[k + w + 1]! + Math.abs(i - j);
        if (!better(bs, bc, ms, mc)) {
          bs = ms;
          bc = mc;
        }
      }
      t[k] = bs;
      c[k] = bc;
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const k = i * w + j;
    const s = score(i, j);
    if (s > 0 && t[k] === t[k + w + 1]! + s && c[k] === c[k + w + 1]! + Math.abs(i - j)) {
      out.push([i, j]);
      i++;
      j++;
    } else if (t[k] === t[k + w] && c[k] === c[k + w]) i++;
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
