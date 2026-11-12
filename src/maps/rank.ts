/**
 * Fractional order keys for map features (v2 D2, ADR 0040).
 *
 * A feature's `rank` is "a fractional index ordering the feature among its siblings under `parentId`", compared as a
 * plain string (LegendKeeper's text, as for resources; the example is `"a0"`). The owner orders map features by hand, so
 * a new or moved feature takes the rank between its real neighbours, computed here with the usual base-62 fractional
 * indexing (the algorithm of the `fractional-indexing` package: an integer part whose first letter gives its length,
 * then a fraction with no trailing zero), and the bridge never sorts a map alphabetically.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;
const LAST = DIGITS[DIGITS.length - 1]!;
const SMALLEST = `A${ZERO.repeat(26)}`;

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new Error('trailing zero');
  if (b !== null) {
    // Drop the longest common prefix, padding `a` with zeros as it runs out.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  // The first digits are consecutive.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const n = integerLength(key[0]!);
  if (n > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, n);
}

function validate(key: string): void {
  if (key === SMALLEST) throw new Error(`invalid order key: ${key}`);
  const i = integerPart(key);
  if (key.slice(i.length).endsWith(ZERO)) throw new Error(`invalid order key: ${key}`);
}

function increment(x: string): string | null {
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') return `a${ZERO}`;
    if (head === 'z') return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') digs.push(ZERO);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

function decrement(x: string): string | null {
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) digs[i] = LAST;
    else {
      digs[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') return `Z${LAST}`;
    if (head === 'A') return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') digs.push(LAST);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

/** Whether `key` is a usable order key (the algorithm can place something next to it). */
export function isOrderKey(key: unknown): boolean {
  if (typeof key !== 'string' || key === '') return false;
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * A key strictly between `a` and `b` (`null` is "no key": before the first, or after the last). Throws when `a >= b` or
 * a key is not a valid order key.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrement(ib);
    if (res === null) throw new Error('cannot decrement any more');
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = increment(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = increment(ia);
  if (i === null) throw new Error('cannot increment any more');
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

export interface Sibling {
  readonly id: string;
  readonly rank: string | null;
}

export type Placement =
  /** After the last sibling (the default). */
  | { readonly at: 'end' }
  | { readonly at: 'after'; readonly siblingId: string }
  | { readonly at: 'before'; readonly siblingId: string };

export type RankResult =
  | {
      readonly ok: true;
      readonly rank: string;
      readonly after: string | null;
      readonly before: string | null;
    }
  | { readonly ok: false; readonly code: 'SIBLING_NOT_FOUND' | 'RANK_UNUSABLE'; readonly message: string };

const byRank = (a: Sibling, b: Sibling): number =>
  (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0;

/**
 * The rank for a feature placed among `siblings` (the other features under the same parent, in any order; the feature
 * being placed is not among them). The neighbours are the REAL ones: siblings are taken in rank order (a tie keeps the
 * list's order, as the app shows it), and "after X" means after X and every sibling that shares X's rank, "before X"
 * before X and every sibling that shares its rank (as LegendKeeper places resources: its guide says an anchor's
 * rank-mates are passed too). `after` and `before` name the neighbours the new rank lies between, for the verify step.
 */
export function rankAmong(siblings: readonly Sibling[], placement: Placement): RankResult {
  const sorted = [...siblings].sort(byRank);
  let prev: Sibling | undefined;
  let next: Sibling | undefined;
  if (placement.at === 'end') {
    prev = sorted[sorted.length - 1];
  } else {
    const at = sorted.findIndex((s) => s.id === placement.siblingId);
    if (at < 0) {
      return {
        ok: false,
        code: 'SIBLING_NOT_FOUND',
        message: `The feature to place it ${placement.at} (${placement.siblingId}) is not among its siblings.`,
      };
    }
    const anchor = sorted[at]!;
    const mates = (s: Sibling) => (s.rank ?? '') === (anchor.rank ?? '');
    if (placement.at === 'after') {
      let i = at;
      while (i + 1 < sorted.length && mates(sorted[i + 1]!)) i++;
      prev = sorted[i];
      next = sorted[i + 1];
    } else {
      let i = at;
      while (i - 1 >= 0 && mates(sorted[i - 1]!)) i--;
      next = sorted[i];
      prev = sorted[i - 1];
    }
  }
  // A neighbour with no rank sorts first and is passed over; one with a rank this scheme cannot read cannot be placed beside.
  for (const s of [prev, next]) {
    if (s && s.rank !== null && s.rank !== '' && !isOrderKey(s.rank)) {
      return {
        ok: false,
        code: 'RANK_UNUSABLE',
        message: `A neighbouring feature (${s.id}) has the order key “${s.rank}”, which the bridge cannot place a feature beside. Place it in the app, or give a different neighbour.`,
      };
    }
  }
  const a = prev && prev.rank ? prev.rank : null;
  const b = next && next.rank ? next.rank : null;
  try {
    return { ok: true, rank: keyBetween(a, b), after: prev?.id ?? null, before: next?.id ?? null };
  } catch (e) {
    return {
      ok: false,
      code: 'RANK_UNUSABLE',
      message: `No order key fits between its neighbours (${e instanceof Error ? e.message : String(e)}).`,
    };
  }
}
