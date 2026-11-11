/**
 * LegendKeeper's date format templates (the spec's `CalendarFormat`): `YYYY` year, `E` era abbreviation, `EE` era name,
 * `MMMM` month name, `MMM` month abbreviation, `M`/`MM` month number, `D`/`DD` day number, `DDDD` weekday name, `DDD`
 * weekday abbreviation, `H`/`HH` hour, `m`/`mm` minute; `^` after a number adds an ordinal suffix (`D^` is `1st`); text
 * in square brackets is literal. The engine both renders and parses with these, so nothing about a calendar's forms is
 * hard-coded (v2 D1, ADR 0038).
 */

export type TokenKind =
  | 'year'
  | 'era'
  | 'eraName'
  | 'month'
  | 'monthAbbr'
  | 'monthNum'
  | 'day'
  | 'weekday'
  | 'weekdayAbbr'
  | 'hour'
  | 'minute'
  | 'lit';

export interface Token {
  readonly kind: TokenKind;
  /** Literal text (`lit`), or the token as written. */
  readonly text: string;
  /** `MM`, `DD`, `HH`, `mm`: zero-padded to two digits. */
  readonly pad?: boolean;
  /** `^` after a number: an ordinal suffix. */
  readonly ordinal?: boolean;
}

/** The token kinds that name a part of the year below the year itself (month, day, weekday). */
export const DAY_PART: ReadonlySet<TokenKind> = new Set([
  'month',
  'monthAbbr',
  'monthNum',
  'day',
  'weekday',
  'weekdayAbbr',
]);
/** The token kinds that name the year or the era. */
export const YEAR_PART: ReadonlySet<TokenKind> = new Set(['year', 'era', 'eraName']);

const RULES: readonly { readonly re: RegExp; readonly kind: TokenKind; readonly pad?: boolean }[] = [
  { re: /^YYYY/, kind: 'year' },
  { re: /^MMMM/, kind: 'month' },
  { re: /^MMM/, kind: 'monthAbbr' },
  { re: /^MM/, kind: 'monthNum', pad: true },
  { re: /^M/, kind: 'monthNum' },
  { re: /^DDDD/, kind: 'weekday' },
  { re: /^DDD/, kind: 'weekdayAbbr' },
  { re: /^DD/, kind: 'day', pad: true },
  { re: /^D/, kind: 'day' },
  { re: /^EE/, kind: 'eraName' },
  { re: /^E/, kind: 'era' },
  { re: /^HH/, kind: 'hour', pad: true },
  { re: /^H/, kind: 'hour' },
  { re: /^mm/, kind: 'minute', pad: true },
  { re: /^m/, kind: 'minute' },
];

/** Splits a template into tokens; neighbouring literal text is merged. */
export function tokenize(template: string): Token[] {
  const out: Token[] = [];
  const lit = (s: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === 'lit') out[out.length - 1] = { kind: 'lit', text: last.text + s };
    else out.push({ kind: 'lit', text: s });
  };
  let i = 0;
  while (i < template.length) {
    const rest = template.slice(i);
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close > 0) {
        lit(rest.slice(1, close));
        i += close + 1;
        continue;
      }
    }
    const rule = RULES.find((r) => r.re.test(rest));
    if (rule) {
      const m = rule.re.exec(rest)![0];
      i += m.length;
      const ordinal =
        template[i] === '^' && (rule.kind === 'day' || rule.kind === 'monthNum' || rule.kind === 'year');
      if (ordinal) i++;
      out.push({
        kind: rule.kind,
        text: m,
        ...(rule.pad ? { pad: true } : {}),
        ...(ordinal ? { ordinal: true } : {}),
      });
      continue;
    }
    lit(template[i]!);
    i++;
  }
  return out;
}

/** English ordinal suffix: 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd. */
export function ordinal(n: number): string {
  const a = Math.abs(n);
  const t = a % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  switch (a % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** A whole number with a thousands separator (`''` for none). */
export function groupDigits(n: number, separator: string): string {
  const s = String(Math.abs(Math.trunc(n)));
  const body = separator === '' ? s : s.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return n < 0 ? `-${body}` : body;
}

/**
 * Where a day template divides into the part below the year (month and day) and the year part (era and year), with the
 * literal between them: `MMMM D^, E YYYY` is `MMMM D^` + `, ` + `E YYYY`. Null when the template does not divide so
 * (the compressed range forms are then not available).
 */
export interface SplitTemplate {
  readonly head: readonly Token[];
  readonly sep: string;
  readonly tail: readonly Token[];
}

export function splitTemplate(tokens: readonly Token[]): SplitTemplate | null {
  let lastDay = -1;
  let firstYear = -1;
  tokens.forEach((t, i) => {
    if (DAY_PART.has(t.kind)) lastDay = i;
    if (YEAR_PART.has(t.kind) && firstYear < 0) firstYear = i;
  });
  if (lastDay < 0 || firstYear < 0 || lastDay > firstYear) return null;
  const head = tokens.slice(0, lastDay + 1);
  const between = tokens.slice(lastDay + 1, firstYear);
  const tail = tokens.slice(firstYear);
  if (head.some((t) => YEAR_PART.has(t.kind)) || tail.some((t) => DAY_PART.has(t.kind))) return null;
  if (between.some((t) => t.kind !== 'lit')) return null;
  // A literal at the very start of the head or end of the tail stays with them.
  return { head, sep: between.map((t) => t.text).join(''), tail };
}
