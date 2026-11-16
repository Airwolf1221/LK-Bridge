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
 * owner's own example, `-1,988,119`), ` - ` between the ends (as the date forms), and, for a range whose two ends fall
 * in the same KCY, the single value (v3 F2.1, the owner, 16 November 2026: `Kumikas 17th - 24th, 4A 611` is
 * `1,250,918`; it was a range, after the Jehet 4A 424 row). Either way of writing such a range is accepted by the
 * check (`kcyWrittenAlike`).
 */
export const DEFAULT_KCY_STYLE: KcyStyle = {
  grouping: ',',
  minus: '-',
  rangeSeparator: ' - ',
  sameYearRange: 'single',
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

/**
 * v3 F2.1 (the owner, 16 November 2026): whether a KCY cell is written as the style writes this value. A range whose
 * two ends fall in the same KCY may be written either way, the single value (`1,250,918`) or the range (`1,250,918 -
 * 1,250,918`): neither is "written differently".
 */
export function kcyWrittenAlike(cell: string, v: KcyValue, s: KcyStyle): boolean {
  const t = cell.trim();
  if (t === formatKcy(v, s)) return true;
  if (v.end === null || v.end !== v.start) return false;
  return (
    t === formatKcy(v, { ...s, sameYearRange: 'single' }) ||
    t === formatKcy(v, { ...s, sameYearRange: 'range' })
  );
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

/**
 * v2 E6 (ADR 0048): the KCY cell of a qualified row, its words counted as text, never as errors: `1,250,870
 * (approximate)`, `1,250,926 - 1,250,931`, `1,250,872 (year only)`, `1,250,937 onward`, `Unassigned - approximate
 * date`. `text`: no number at all (an unassigned KCY is fine); `value`: one value or one range, with the words around
 * it; `unclear`: more numbers than one value or range (not checked).
 */
export type QualifiedKcy =
  | { readonly kind: 'text' }
  | { readonly kind: 'value'; readonly start: number; readonly end: number | null; readonly words: string }
  | { readonly kind: 'unclear' };

const Q_NUM = String.raw`\d{1,3}(?:,\d{3})+|\d+`;
// A minus sign only when it touches the number and starts the cell or follows a space or bracket (so the dash of
// `Unassigned - 1,250,870` is never read as a sign).
const Q_CORE = new RegExp(
  String.raw`(?:(?<=^|[\s(])([-−–]))?(${Q_NUM})(?:\s*(?:[-–—]|to)\s*([-−–](?=\d))?(${Q_NUM}))?`,
  'u',
);

export function readQualifiedKcy(text: string): QualifiedKcy {
  const t = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!/\d/.test(t)) return { kind: 'text' };
  const m = Q_CORE.exec(t);
  if (!m) return { kind: 'unclear' };
  const words = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.trim();
  if (/\d/.test(words)) return { kind: 'unclear' };
  const val = (sign: string | undefined, num: string) => {
    const n = Number(num.replace(/,/g, ''));
    return sign ? -n : n;
  };
  return {
    kind: 'value',
    start: val(m[1], m[2]!),
    end: m[4] !== undefined ? val(m[3], m[4]) : null,
    words,
  };
}

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
