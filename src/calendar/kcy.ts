/**
 * KCY cells (v2 D1, ADR 0038). KCY is the continuous year count (no era resets): the calendar engine works it out from
 * the definition (`CalendarEngine.kcyOf`). How a table WRITES it (a thousands separator, the minus sign, how a range is
 * joined, whether a range inside one year is written as one value or as a range) is learned from the real tables and
 * confirmed by the owner; nothing here invents a format: the style is an input.
 */
import { groupDigits } from './template.js';

export interface KcyStyle {
  /** Between groups of three digits (`1,250,308`); `''` for none. */
  readonly grouping: string;
  /** The sign of a negative KCY (the Archon Age): `-` or `−`. */
  readonly minus: string;
  /** Between the two values of a range, exactly as written (spaces included). */
  readonly rangeSeparator: string;
  /** A dated range whose two ends fall in the same year: one value, or a range with the same value at both ends. */
  readonly sameYearRange: 'single' | 'range';
}

/**
 * The style used until the owner confirms the one learned from the tables: thousands commas and a hyphen-minus (the
 * owner's own example, `-1,988,119`), ` - ` between the ends (as the date forms), and a range for every dated range
 * (the Jehet 4A 424 row has the same KCY at both ends). Each of these is checked against every row by the opt-in
 * sandbox test.
 */
export const DEFAULT_KCY_STYLE: KcyStyle = {
  grouping: ',',
  minus: '-',
  rangeSeparator: ' - ',
  sameYearRange: 'range',
};

export interface KcyValue {
  readonly start: number;
  /** Null for a single date (no end). */
  readonly end: number | null;
}

const one = (n: number, s: KcyStyle) => {
  const body = groupDigits(Math.abs(n), s.grouping);
  return n < 0 ? `${s.minus}${body}` : body;
};

/** A KCY value as the tables write it. */
export function formatKcy(v: KcyValue, s: KcyStyle): string {
  if (v.end === null) return one(v.start, s);
  if (v.end === v.start && s.sameYearRange === 'single') return one(v.start, s);
  return `${one(v.start, s)}${s.rangeSeparator}${one(v.end, s)}`;
}

/** A KCY cell read back: its values and how it is written (for style detection and the check). */
export interface KcyCell {
  readonly start: number;
  readonly end: number | null;
  /** The thousands separator seen (only from a number of 4 digits or more), `''` for none seen in such a number. */
  readonly grouping: string | null;
  /** The minus sign seen, if a value is negative. */
  readonly minus: string | null;
  /** The text between the two values, if a range. */
  readonly rangeSeparator: string | null;
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+|\d+`;
const SIGN = '[-−–]';
const CELL = new RegExp(
  String.raw`^\s*(${SIGN})?\s*(${NUM})(?:(\s*(?:[-–—]|to)\s*)(${SIGN})?\s*(${NUM}))?\s*$`,
  'u',
);

/** Reads a KCY cell (`1,250,308`, `-1,988,119`, `1,250,407 - 1,250,409`), or null when it is not one. */
export function parseKcyCell(text: string): KcyCell | null {
  const m = CELL.exec(text.normalize('NFKC'));
  if (!m) return null;
  const sepOf = (s: string) => (s.includes(',') ? ',' : s.includes('.') ? '.' : '');
  const val = (sign: string | undefined, num: string) => {
    const n = Number(num.replace(/[,.]/g, ''));
    return sign ? -n : n;
  };
  const nums = [m[2], m[5]].filter((x): x is string => x !== undefined);
  const long = nums.filter((n) => n.replace(/[,.]/g, '').length >= 4);
  return {
    start: val(m[1], m[2]!),
    end: m[5] !== undefined ? val(m[4], m[5]) : null,
    grouping: long.length > 0 ? sepOf(long[0]!) : null,
    minus: m[1] ?? m[4] ?? null,
    rangeSeparator: m[3] ?? null,
  };
}
