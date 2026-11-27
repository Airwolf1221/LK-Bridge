/**
 * v3 F12 follow-up (ADR 0081 amendment 1): look-alike text by Unicode's own confusables data (UTS #39, Unicode
 * Security Mechanisms, section 4 "Confusable Detection"), not by a hand-made list. Two strings are confusable when their
 * skeletons are equal: `skeleton(s)` is NFD, every code point replaced by its prototype from `confusables.txt`, NFD again
 * (src/text/confusables.generated.ts, from spec/unicode/confusables.txt by scripts/gen-confusables.ts).
 *
 * `lookalikeOf(value, allowed)` answers the allowed value a value only looks like: one whose skeleton it shares, case
 * aside and with invisible characters (Unicode's default-ignorable code points) taken out, while it is not that value
 * itself (after NFC, case aside). So "Authoritаtive" with a Cyrillic а, "Authoritative" with a zero-width space, and
 * "Αuthoritative" with a Greek capital alpha all answer "Authoritative"; "authoritative" answers null (the value itself).
 */
import { CONFUSABLES_DATA } from './confusables.generated.js';

let table: Map<number, string> | null = null;

/** The prototype of each confusable code point (built once, on first use). */
function prototypes(): Map<number, string> {
  if (table) return table;
  const t = new Map<number, string>();
  for (const row of CONFUSABLES_DATA.split('|')) {
    const [src, target] = row.split(':') as [string, string];
    t.set(
      Number.parseInt(src, 16),
      String.fromCodePoint(...target.split(' ').map((h) => Number.parseInt(h, 16))),
    );
  }
  table = t;
  return t;
}

/** UTS #39's skeleton of a string. */
export function skeleton(s: string): string {
  const t = prototypes();
  let out = '';
  for (const ch of s.normalize('NFD')) out += t.get(ch.codePointAt(0)!) ?? ch;
  return out.normalize('NFD');
}

const invisible = (s: string) => s.replace(/\p{Default_Ignorable_Code_Point}/gu, '');
const lower = (s: string) => s.toLocaleLowerCase('en-GB');
const plain = (s: string) => lower(s.normalize('NFC').trim());
/** The skeleton, case aside: taken before lower-casing (the table maps capitals as they are: Cherokee Ꭺ is "A"). */
const shape = (s: string) => lower(skeleton(invisible(s).trim()));

/** The allowed value `value` only looks like (confusable with, but not it), or null. */
export function lookalikeOf(value: string, allowed: readonly string[]): string | null {
  if (allowed.some((a) => plain(a) === plain(value))) return null;
  const s = shape(value);
  // The allowed value in each casing (a disguise may copy any of them: "Authoritative", "AUTHORITATIVE", "authoritative").
  return allowed.find((a) => [a, a.toLocaleUpperCase('en-GB'), lower(a)].some((x) => shape(x) === s)) ?? null;
}
