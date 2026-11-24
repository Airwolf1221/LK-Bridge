/**
 * v3 F6a (ADR 0076; design T2): the suggestion for a Reference Type value in use, by RULES only (never from a page's
 * content, never a nearest guess). For a value and the page's primary category:
 *
 * 1. The value as it is: canonical when the vocabulary lists it exactly (in any category: a value canonical in another
 *    category is the category mismatch check's, and has no suggestion here).
 * 2. Its comparable form: case, spacing and punctuation ignored, `&` and `and` the same, a missing or extra "Reference";
 *    then a type's name, a variant the vocabulary lists for it (`aliases`), or its role word, within the page's primary
 *    category.
 * 3. Synonyms normalised word by word (`Cultural` → `Culture`), then time words (`Historical`: Temporal Scope carries
 *    time) and scope adjectives (`Regional`, `Shared`…: geography is placement, detail is Scope) stripped; the words
 *    moved are named in the reason, so the owner sees what belongs in Temporal Scope or Scope. Then step 2 again.
 * 4. Matched only within the page's primary category. A value naming two roles ("Historical Polity and Institution
 *    Reference") or two categories, or matching only another category's type, has NO confident suggestion: its
 *    candidates are listed and the choice is the owner's. A page without a primary category tag has none either.
 */
import type { ReferenceTypeRules } from '../types.js';
import { typeKey, type VocabularyLists } from './vocabulary.js';

export interface Candidate {
  readonly name: string;
  readonly category: string;
  readonly role: string;
}

export interface Suggestion {
  /** `canonical`: the value is in the vocabulary as it is. `suggested`: one confident suggestion. `none`: no confident one. */
  readonly kind: 'canonical' | 'suggested' | 'none';
  /** The canonical value suggested (the value itself when canonical), or null. */
  readonly value: string | null;
  /** Why, in words (the rules applied, the words moved), or why there is no confident suggestion. */
  readonly reason: string;
  /** The category the value is canonical in (a `canonical` value; maybe not the page's). */
  readonly canonicalIn?: string;
  /** Words the rules took out, for the owner: time words (Temporal Scope), scope adjectives (placement or Scope). */
  readonly moved: { readonly time: readonly string[]; readonly scope: readonly string[] };
  /** Synonyms normalised (`Cultural → Culture`). */
  readonly synonyms: readonly string[];
  /** With no confident suggestion: the types it could be, for the owner to choose (never chosen by the bridge). */
  readonly candidates: readonly Candidate[];
}

type Normalise = ReferenceTypeRules['normalise'];

/** The comparable form without a final "Reference" (a missing or extra "Reference" is the same value). */
export const coreKey = (s: string): string =>
  typeKey(s)
    .replace(/(?:^|\s)references?$/, '')
    .trim();

interface Entry extends Candidate {
  readonly keys: readonly string[];
}

function entriesOf(v: VocabularyLists): Entry[] {
  return v.categories.flatMap((c) =>
    c.types.map((x) => ({
      name: x.name,
      category: c.category,
      role: x.role,
      keys: [...new Set([x.name, ...(x.aliases ?? []), x.role].map(coreKey).filter((k) => k !== ''))],
    })),
  );
}

const sameCat = (a: string | null, b: string) => a !== null && typeKey(a) === typeKey(b);
const cand = (e: Entry): Candidate => ({ name: e.name, category: e.category, role: e.role });
const uniq = (list: readonly Entry[]): Entry[] => [...new Map(list.map((e) => [e.name, e])).values()];

/** The value's words with synonyms replaced and time and scope words taken out (hyphenated words are one word). */
function rewrite(value: string, n: Normalise) {
  const words = value
    .normalize('NFKC')
    .replace(/[–—]/g, '-')
    .split(/\s+/)
    .filter((w) => w !== '');
  const lower = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en-GB');
  const syn = new Map(Object.entries(n.synonyms).map(([k, x]) => [lower(k), x]));
  const time = new Set(n.timeWords.map(lower));
  const scope = new Set(n.scopeWords.map(lower));
  const kept: string[] = [];
  const moved = { time: [] as string[], scope: [] as string[] };
  const synonyms: string[] = [];
  for (const w of words) {
    const bare = lower(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    if (time.has(bare)) moved.time.push(w);
    else if (scope.has(bare)) moved.scope.push(w);
    else if (syn.has(bare)) {
      synonyms.push(`${w} → ${syn.get(bare)!}`);
      kept.push(syn.get(bare)!);
    } else kept.push(w);
  }
  return { text: kept.join(' '), moved, synonyms };
}

function why(moved: { time: string[]; scope: string[] }, synonyms: string[]): string[] {
  return [
    ...(synonyms.length > 0 ? [`synonym${synonyms.length === 1 ? '' : 's'} ${synonyms.join(', ')}`] : []),
    ...(moved.time.length > 0
      ? [`“${moved.time.join(' ')}” is time: Temporal Scope carries it, not the Reference Type`]
      : []),
    ...(moved.scope.length > 0
      ? [`“${moved.scope.join(' ')}” is scope: placement or Scope carries it, not the Reference Type`]
      : []),
  ];
}

/** The parts a value names when it joins roles with "and", "&" or a comma. */
const partsOf = (text: string): string[] =>
  typeKey(text)
    .split(/\s+and\s+|\s*,\s*/)
    .map((p) => p.trim())
    .filter((p) => p !== '');

/**
 * The suggestion for `value` on a page whose primary category is `category` (null: no primary category tag), against
 * the vocabulary `v` and the rules' words `n`.
 */
export function suggest(
  value: string,
  category: string | null,
  v: VocabularyLists,
  n: Normalise,
): Suggestion {
  const all = entriesOf(v);
  const none = { time: [] as string[], scope: [] as string[] };
  const base = { moved: none, synonyms: [] as string[], candidates: [] as Candidate[] };
  const trimmed = value.trim();
  // 1. Canonical as it is (any category).
  const exact = all.find((e) => e.name === trimmed);
  if (exact)
    return {
      ...base,
      kind: 'canonical',
      value: exact.name,
      canonicalIn: exact.category,
      reason: sameCat(category, exact.category)
        ? 'canonical'
        : `canonical in ${exact.category}${category ? `, but the page’s primary category is ${category}` : ''}`,
    };
  const mine = all.filter((e) => sameCat(category, e.category));
  const others = all.filter((e) => !sameCat(category, e.category));
  const hit = (key: string, list: readonly Entry[]) => uniq(list.filter((e) => e.keys.includes(key)));
  const confident = (e: Entry, reasons: string[], moved = none, synonyms: string[] = []): Suggestion => ({
    kind: 'suggested',
    value: e.name,
    reason: reasons.join('; '),
    moved,
    synonyms,
    candidates: [],
  });
  const noConfident = (
    reason: string,
    list: readonly Entry[],
    moved = none,
    synonyms: string[] = [],
  ): Suggestion => ({
    kind: 'none',
    value: null,
    reason: `no confident suggestion: ${reason}`,
    moved,
    synonyms,
    candidates: uniq(list).slice(0, 10).map(cand),
  });
  if (category === null) {
    const k = coreKey(trimmed);
    const r = rewrite(trimmed, n);
    const k2 = coreKey(r.text);
    return noConfident(
      'the page has no primary category tag, so it cannot be matched within one',
      [...hit(k, all), ...hit(k2, all)],
      r.moved,
      r.synonyms,
    );
  }
  // 2. The comparable form, within the category.
  const k = coreKey(trimmed);
  const direct = hit(k, mine);
  if (direct.length === 1)
    return confident(direct[0]!, [
      `the same type written differently (${describeForm(trimmed, direct[0]!)})`,
    ]);
  if (direct.length > 1) return noConfident(`it reads as ${direct.length} types of ${category}`, direct);
  // 3. Synonyms, time words and scope adjectives.
  const r = rewrite(trimmed, n);
  const reasons = why(r.moved, r.synonyms);
  const k2 = coreKey(r.text);
  if (k2 !== '' && k2 !== k) {
    const after = hit(k2, mine);
    if (after.length === 1)
      return confident(
        after[0]!,
        [`read as “${r.text.trim() || trimmed}”, the type ${after[0]!.name}`, ...reasons],
        r.moved,
        r.synonyms,
      );
    if (after.length > 1)
      return noConfident(`it reads as ${after.length} types of ${category}`, after, r.moved, r.synonyms);
  }
  const key = k2 !== '' ? k2 : k;
  // 4. Another category's type, two roles or two categories: the owner's choice.
  const elsewhere = uniq([...hit(k, others), ...hit(key, others)]);
  if (elsewhere.length > 0)
    return noConfident(
      `it names ${elsewhere.map((e) => `${e.name} (${e.category})`).join(', ')}, not a type of ${category}`,
      elsewhere,
      r.moved,
      r.synonyms,
    );
  const parts = partsOf(r.text);
  if (parts.length >= 2) {
    const matched = parts.map((p) => hit(coreKey(p), all));
    if (matched.filter((m) => m.length > 0).length >= 2) {
      const list = uniq(matched.flat());
      const cats = new Set(list.map((e) => typeKey(e.category)));
      return noConfident(
        cats.size > 1
          ? `it names two categories (${[...new Set(list.map((e) => e.category))].join(' and ')})`
          : `it names two roles (${list.map((e) => e.role).join(' and ')})`,
        list,
        r.moved,
        r.synonyms,
      );
    }
  }
  // Nothing matched: the category's types sharing a distinctive word, for the owner (never suggested).
  const words = new Set(key.split(/\s+/).filter((w) => w.length > 2 && w !== 'and'));
  const near = mine.filter((e) => e.keys.some((x) => x.split(/\s+/).some((w) => words.has(w))));
  return noConfident(
    `no type of ${category} matches${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`,
    near,
    r.moved,
    r.synonyms,
  );
}

function describeForm(value: string, e: Entry): string {
  const a = value.trim();
  const out: string[] = [];
  if (/(?:^|\s)reference$/i.test(a) !== /(?:^|\s)reference$/i.test(e.name))
    out.push(/(?:^|\s)reference$/i.test(e.name) ? 'a missing “Reference”' : 'an extra “Reference”');
  if (/&/.test(a) !== /&/.test(e.name) || /\band\b/i.test(a) !== /\band\b/i.test(e.name))
    out.push('“and” for “&”');
  if (a.toLocaleLowerCase('en-GB') === e.name.toLocaleLowerCase('en-GB')) out.push('letter case');
  if (coreKey(a) === coreKey(e.role) && coreKey(e.role) !== coreKey(e.name))
    out.push(`its role word “${e.role}”`);
  if ((e as { keys: readonly string[] }).keys && out.length === 0) out.push('spacing or punctuation');
  return out.join(', ');
}
