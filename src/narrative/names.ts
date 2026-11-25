/**
 * v3 F4c (ADR 0065; the owner-approved design docs/design/F4c-fiction.md, E1): the narrative pages' names and their
 * order. Pure, over the pack's narrative rules (data): `Story Map`, `Act <n> Map`, `Chapter <n> Plan`, `Act <n> -
 * <Title>`, `Chapter <n> - <Title>`, and the optional Chronology Map of a continuity.
 *
 * **The order inside Narratives** (E1, an exception to "INDEX pages first, then alphabetical"): the Story Map (or a
 * continuity's Chronology Map) first; then acts and chapters in NUMBER order (Act 10 after Act 9, never alphabetically),
 * act indexes before chapters; plans under their maps in number order; anything else after them, by the ordinary rule.
 */
import { compareSiblings, type Orderable, type SiblingCompare } from '../registry/ordering.js';
import type { NarrativeRules } from '../packs/types.js';

export type NamedKind = 'storyMap' | 'actMap' | 'chapterPlan' | 'act' | 'chapter' | 'chronologyMap';

export interface ParsedName {
  readonly kind: NamedKind;
  /** The act's or chapter's number (an Act Map's act, a plan's chapter). */
  readonly n?: number;
  /** The title after the number (an act index, a chapter). */
  readonly title?: string;
}

const DASH = '\\s*[-‐‑‒–—―]\\s*';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A name pattern as a regular expression: `{n}` a number, `{Title}` the rest; any dash with any spacing. */
export function patternRegex(pattern: string): RegExp {
  const parts = pattern.split(/(\{n\}|\{Title\})/);
  const src = parts
    .map((p) =>
      p === '{n}'
        ? '(?<n>\\d{1,5})'
        : p === '{Title}'
          ? '(?<title>.+?)'
          : p
              .split(/\s*[-‐‑‒–—―]\s*/)
              .map((x) => escape(x).replace(/\s+/g, '\\s+'))
              .join(DASH),
    )
    .join('');
  return new RegExp(`^\\s*${src}\\s*$`, 'iu');
}

/** A name from a pattern (`{n}`, `{Title}`). */
export function formatName(pattern: string, n?: number, title?: string): string {
  return pattern
    .replace('{n}', n === undefined ? '' : String(n))
    .replace('{Title}', (title ?? '').trim())
    .replace(/\s+/g, ' ')
    .trim();
}

const keyOf = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');

/**
 * What a narrative page's display name says it is: act indexes are indexes (`[INDEX] Act 2 - The Siege`), every other
 * kind a page. Null: not a narrative name.
 */
export function parseNarrativeName(
  rules: NarrativeRules,
  displayName: string,
  isIndex: boolean,
): ParsedName | null {
  const n = rules.names;
  const num = (m: RegExpExecArray | null) => (m?.groups?.n !== undefined ? Number(m.groups.n) : undefined);
  if (isIndex) {
    const m = patternRegex(n.act).exec(displayName);
    if (m) return { kind: 'act', n: num(m)!, title: (m.groups?.title ?? '').trim() };
    return null;
  }
  if (keyOf(displayName) === keyOf(n.storyMap)) return { kind: 'storyMap' };
  if (n.chronologyMap.some((x) => keyOf(x) === keyOf(displayName))) return { kind: 'chronologyMap' };
  let m = patternRegex(n.actMap).exec(displayName);
  if (m) return { kind: 'actMap', n: num(m)! };
  m = patternRegex(n.chapterPlan).exec(displayName);
  if (m) return { kind: 'chapterPlan', n: num(m)! };
  m = patternRegex(n.chapter).exec(displayName);
  if (m) return { kind: 'chapter', n: num(m)!, title: (m.groups?.title ?? '').trim() };
  return null;
}

export type { SiblingCompare };

/** The order inside Narratives (see the module comment). */
export function narrativeCompare(
  rules: NarrativeRules,
  /** v3 F6b (ADR 0079): the order of what the narrative order does not place (T11's when the approved pack has it). */
  fallback: SiblingCompare = compareSiblings,
): SiblingCompare {
  const rank = (x: Pick<Orderable, 'displayName' | 'kind'>): [number, number] => {
    const p = parseNarrativeName(rules, x.displayName, x.kind === 'index');
    if (!p) return [3, 0];
    switch (p.kind) {
      case 'storyMap':
      case 'chronologyMap':
        return [0, 0];
      case 'act':
      case 'actMap':
        return [1, p.n ?? 0];
      case 'chapter':
      case 'chapterPlan':
        return [2, p.n ?? 0];
    }
  };
  return (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[0] === 3) return fallback(a, b);
    return ra[1] - rb[1] || fallback(a, b);
  };
}

/** Whether a name holds the reserved word ("CANON") as a whole word (only the main continuity index may). */
export function holdsReservedWord(rules: NarrativeRules, name: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(rules.reservedWord)}([^\\p{L}\\p{N}]|$)`, 'u').test(name);
}

/** The dateline (E5.3): the In-world Date as written, then the separator and the place when one is given. */
export function datelineOf(rules: NarrativeRules, inWorldDate: string, place?: string | null): string {
  const d = inWorldDate.replace(/\s+/g, ' ').trim();
  const p = (place ?? '').replace(/\s+/g, ' ').trim();
  return p === '' ? d : `${d} ${rules.dateline.separator.trim()} ${p}`;
}
