/**
 * The `search` tool's query language and its evaluator (v2 B2, ADR 0029). Pure: no database, no LegendKeeper.
 *
 * Syntax
 * - words (all must match), `"quoted phrases"`, `OR`, `AND` (the default between terms), `NOT` or a leading `-`,
 *   parentheses, and field filters `name:` `tag:` `type:` `kind:` `under:` `scope:`.
 * - `NOT`/`-` binds tightest, then `AND` (spaces), then `OR`. `OR`, `AND` and `NOT` are operators only in capitals.
 * - A bare term matches a page's display name, aliases, Canonical Display Name and Scope (case-insensitive substrings).
 *
 * Ranking (best first): exact name, name prefix, a word of the name, text inside a name, an alias or Canonical
 * Display Name, Scope. A result states why it matched.
 */
import { nameKey } from '../tree/index.js';
import type { TreeNode } from '../tree/index.js';

export const SEARCH_FIELDS = ['name', 'tag', 'type', 'kind', 'under', 'scope'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** v2 C2c: `bwrk` (Working) and `barc` (Archived) pages beside `bsrc`. */
export const SEARCH_KINDS = ['index', 'bsrc', 'bwrk', 'barc', 'unclassified'] as const;

export type Expr =
  | { readonly t: 'text'; readonly value: string; readonly phrase: boolean }
  | { readonly t: 'field'; readonly field: SearchField; readonly value: string }
  | { readonly t: 'and'; readonly items: readonly Expr[] }
  | { readonly t: 'or'; readonly items: readonly Expr[] }
  | { readonly t: 'not'; readonly item: Expr };

/** A malformed query, with where it went wrong (1-based character position) and how to fix it. */
export class SearchSyntaxError extends Error {
  readonly code = 'SEARCH_SYNTAX';
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

export const MAX_QUERY_CHARS = 500;
const MAX_TERMS = 40;
const MAX_DEPTH = 12;

// ------------------------------------------------------------------------------------------------ tokens

type Token =
  | { readonly k: 'lparen' | 'rparen' | 'minus' | 'or' | 'and' | 'not'; readonly pos: number }
  | { readonly k: 'word' | 'phrase'; readonly value: string; readonly pos: number }
  | {
      readonly k: 'field';
      readonly field: SearchField;
      readonly value: string;
      readonly phrase: boolean;
      readonly pos: number;
    };

const isSpace = (c: string): boolean => /\s/.test(c);

function readQuoted(q: string, start: number): { value: string; end: number } {
  let value = '';
  let i = start + 1;
  while (i < q.length) {
    const c = q[i]!;
    if (c === '\\' && (q[i + 1] === '"' || q[i + 1] === '\\')) {
      value += q[i + 1]!;
      i += 2;
      continue;
    }
    if (c === '"') return { value, end: i + 1 };
    value += c;
    i++;
  }
  throw new SearchSyntaxError(
    `The quote opened at position ${start + 1} is never closed. Close it with another " (write a literal quote as \\").`,
    start + 1,
  );
}

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (isSpace(c)) {
      i++;
      continue;
    }
    const pos = i + 1;
    if (c === '(') {
      out.push({ k: 'lparen', pos });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ k: 'rparen', pos });
      i++;
      continue;
    }
    if (c === '"') {
      const { value, end } = readQuoted(q, i);
      if (value.trim() === '')
        throw new SearchSyntaxError(`The quoted phrase at position ${pos} is empty.`, pos);
      out.push({ k: 'phrase', value, pos });
      i = end;
      continue;
    }
    if (c === '-') {
      const next = q[i + 1];
      if (next === undefined || isSpace(next) || next === ')') {
        throw new SearchSyntaxError(
          `A "-" at position ${pos} must be followed by the term to exclude (for example -draft). Write NOT instead, or quote the dash, to search for it.`,
          pos,
        );
      }
      out.push({ k: 'minus', pos });
      i++;
      continue;
    }
    // A run of ordinary characters; a field filter is `name:` followed by a word or a quoted phrase.
    let j = i;
    while (j < q.length && !isSpace(q[j]!) && q[j] !== '(' && q[j] !== ')' && q[j] !== '"') j++;
    const word = q.slice(i, j);
    const m = /^([A-Za-z]+):(.*)$/.exec(word);
    if (m) {
      const field = m[1]!.toLowerCase();
      if (!(SEARCH_FIELDS as readonly string[]).includes(field)) {
        throw new SearchSyntaxError(
          `"${m[1]}:" at position ${pos} is not a search filter. The filters are ${SEARCH_FIELDS.map((f) => `${f}:`).join(' ')}. To search for the text itself, put it in quotes.`,
          pos,
        );
      }
      if (m[2] === '' && q[j] === '"') {
        const { value, end } = readQuoted(q, j);
        if (value.trim() === '')
          throw new SearchSyntaxError(`The quoted value of "${field}:" at position ${pos} is empty.`, pos);
        out.push({ k: 'field', field: field as SearchField, value, phrase: true, pos });
        i = end;
        continue;
      }
      if (m[2] === '') {
        throw new SearchSyntaxError(
          `"${field}:" at position ${pos} needs a value after the colon, for example ${field}:Foxians.`,
          pos,
        );
      }
      out.push({ k: 'field', field: field as SearchField, value: m[2]!, phrase: false, pos });
      i = j;
      continue;
    }
    i = j;
    if (word === 'OR') out.push({ k: 'or', pos });
    else if (word === 'AND') out.push({ k: 'and', pos });
    else if (word === 'NOT') out.push({ k: 'not', pos });
    else out.push({ k: 'word', value: word, pos });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ parser

/** Parses a query. Throws {@link SearchSyntaxError} for anything malformed. */
export function parseQuery(query: string): Expr {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new SearchSyntaxError('The query is empty. Give at least one word, phrase or filter.', 1);
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new SearchSyntaxError(`The query is longer than ${MAX_QUERY_CHARS} characters.`, MAX_QUERY_CHARS);
  }
  const tokens = tokenize(query);
  let at = 0;
  let terms = 0;
  const peek = (): Token | undefined => tokens[at];

  function parseOr(depth: number): Expr {
    if (depth > MAX_DEPTH) {
      throw new SearchSyntaxError(`Parentheses are nested more than ${MAX_DEPTH} deep.`, peek()?.pos ?? 1);
    }
    const items: Expr[] = [parseAnd(depth)];
    while (peek()?.k === 'or') {
      const op = tokens[at++]!;
      const n = peek();
      if (n === undefined || n.k === 'rparen' || n.k === 'or') {
        throw new SearchSyntaxError(`OR at position ${op.pos} needs a term after it.`, op.pos);
      }
      items.push(parseAnd(depth));
    }
    return items.length === 1 ? items[0]! : { t: 'or', items };
  }

  function parseAnd(depth: number): Expr {
    const items: Expr[] = [];
    for (;;) {
      const n = peek();
      if (n === undefined || n.k === 'or' || n.k === 'rparen') break;
      if (n.k === 'and') {
        at++;
        const after = peek();
        if (items.length === 0 || after === undefined || after.k === 'or' || after.k === 'rparen') {
          throw new SearchSyntaxError(`AND at position ${n.pos} needs a term on both sides.`, n.pos);
        }
        continue;
      }
      items.push(parseUnary(depth));
    }
    if (items.length === 0) {
      const n = peek();
      throw new SearchSyntaxError(
        n === undefined
          ? 'The query ends where a term was expected.'
          : `A term is expected before position ${n.pos}.`,
        n?.pos ?? query.length,
      );
    }
    return items.length === 1 ? items[0]! : { t: 'and', items };
  }

  function parseUnary(depth: number): Expr {
    const n = peek();
    if (n === undefined)
      throw new SearchSyntaxError('The query ends where a term was expected.', query.length);
    if (n.k === 'not' || n.k === 'minus') {
      at++;
      const a = peek();
      if (a === undefined || a.k === 'rparen' || a.k === 'or' || a.k === 'and') {
        throw new SearchSyntaxError(
          `${n.k === 'not' ? 'NOT' : '-'} at position ${n.pos} must be followed by the term to exclude.`,
          n.pos,
        );
      }
      return { t: 'not', item: parseUnary(depth) };
    }
    at++;
    switch (n.k) {
      case 'lparen': {
        const inner = parseOr(depth + 1);
        const close = peek();
        if (close?.k !== 'rparen') {
          throw new SearchSyntaxError(`The ( at position ${n.pos} is never closed with ).`, n.pos);
        }
        at++;
        return inner;
      }
      case 'word':
      case 'phrase':
        if (++terms > MAX_TERMS) throw new SearchSyntaxError(`More than ${MAX_TERMS} terms.`, n.pos);
        return { t: 'text', value: n.value, phrase: n.k === 'phrase' };
      case 'field':
        if (++terms > MAX_TERMS) throw new SearchSyntaxError(`More than ${MAX_TERMS} terms.`, n.pos);
        return { t: 'field', field: n.field, value: n.value };
      case 'rparen':
        throw new SearchSyntaxError(`The ) at position ${n.pos} has no matching (.`, n.pos);
      default:
        throw new SearchSyntaxError(`Unexpected "${n.k.toUpperCase()}" at position ${n.pos}.`, n.pos);
    }
  }

  const expr = parseOr(0);
  const rest = peek();
  if (rest) {
    throw new SearchSyntaxError(
      rest.k === 'rparen'
        ? `The ) at position ${rest.pos} has no matching (.`
        : `Unexpected input at position ${rest.pos}.`,
      rest.pos,
    );
  }
  return expr;
}

/** Every `under:` value in a query (they are resolved to pages before the search runs). */
export function underValues(e: Expr): string[] {
  switch (e.t) {
    case 'field':
      return e.field === 'under' ? [e.value] : [];
    case 'and':
    case 'or':
      return e.items.flatMap(underValues);
    case 'not':
      return underValues(e.item);
    default:
      return [];
  }
}

/** The positive free-text terms (not negated, not filters): what LegendKeeper's own search is asked for. */
export function positiveText(e: Expr, negated = false): string[] {
  switch (e.t) {
    case 'text':
      return negated ? [] : [e.value];
    case 'and':
    case 'or':
      return e.items.flatMap((x) => positiveText(x, negated));
    case 'not':
      return positiveText(e.item, !negated);
    default:
      return [];
  }
}

/** Whether the query is only words, phrases, AND, OR and parentheses (no filters, no NOT). */
export function isPlainText(e: Expr): boolean {
  switch (e.t) {
    case 'text':
      return true;
    case 'and':
    case 'or':
      return e.items.every(isPlainText);
    default:
      return false;
  }
}

// ------------------------------------------------------------------------------------------------ evaluation

/** How well a name matched, best (0) first. Aliases, Canonical Display Names and Scope rank below every name match. */
export const TIER = { exact: 0, prefix: 1, word: 2, contains: 3, alias: 4, scope: 5 } as const;

export interface SearchHit {
  /** Where the match was: `name`, `alias`, `canonical name`, `scope`, `tag`, `type`, `kind`, `under`, `page text`. */
  readonly field: string;
  /** How, for names: `exact`, `prefix`, `word`, `contains`. */
  readonly how?: string;
  /** The stored text that matched (an alias, a scope…). */
  readonly text?: string;
  /** Rank of the hit (see {@link TIER}); filters do not rank. */
  readonly tier: number | null;
}

export interface Searchable {
  readonly node: TreeNode;
  readonly nameKey: string;
  readonly aliasKeys: readonly { readonly key: string; readonly text: string }[];
  readonly canonical: { readonly key: string; readonly text: string } | null;
  readonly scopeKeys: readonly { readonly key: string; readonly text: string }[];
  readonly tagKeys: ReadonlySet<string>;
  readonly typeKey: string | null;
}

const fold = (s: string): string => nameKey(s.trim().replace(/\s+/g, ' '));

export function searchable(node: TreeNode): Searchable {
  const keyed = (t: string | null) => (t !== null && t.trim() !== '' ? { key: fold(t), text: t } : null);
  const scopes = [node.scope, node.indexScope]
    .map(keyed)
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return {
    node,
    nameKey: fold(node.displayName),
    aliasKeys: node.aliases.map(keyed).filter((x): x is NonNullable<typeof x> => x !== null),
    canonical: keyed(node.canonicalDisplayName),
    scopeKeys: scopes,
    tagKeys: new Set(node.tags.map(fold)),
    typeKey: node.referenceType ? fold(node.referenceType) : null,
  };
}

/** Whether `needle` occurs in `hay` starting at a word boundary. */
function atWordStart(hay: string, needle: string): boolean {
  for (let from = hay.indexOf(needle); from >= 0; from = hay.indexOf(needle, from + 1)) {
    if (from === 0 || !/[\p{L}\p{N}]/u.test(hay[from - 1]!)) return true;
  }
  return false;
}

/** The name tier of a term, or null when the name does not contain it. */
export function nameTier(nameKeyText: string, term: string): { tier: number; how: string } | null {
  if (nameKeyText === term) return { tier: TIER.exact, how: 'exact' };
  if (nameKeyText.startsWith(term)) return { tier: TIER.prefix, how: 'prefix' };
  if (atWordStart(nameKeyText, term)) return { tier: TIER.word, how: 'word' };
  if (nameKeyText.includes(term)) return { tier: TIER.contains, how: 'contains' };
  return null;
}

/** Whole-word match, for Reference Type and Scope: every word of `term` appears, in order, as whole words. */
export function containsWords(hay: string, term: string): boolean {
  const h = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const t = term.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (t.length === 0) return false;
  for (let i = 0; i + t.length <= h.length; i++) {
    if (t.every((w, k) => h[i + k] === w)) return true;
  }
  return false;
}

export interface EvalContext {
  /** `under:` value → the id of the page it names (resolved before the search). */
  readonly under: ReadonlyMap<string, string>;
  /**
   * Pages LegendKeeper's own search found by their text. A positive free-text term is taken as satisfied for them
   * (the bridge cannot tell which words were in the text); filters and negated terms are still checked on the tree.
   */
  readonly content?: ReadonlySet<string>;
  /**
   * v3 F3c (ADR 0054): the full-text index's answer for each free-text term (by `textTermKey`): the pages whose text holds
   * it. Unlike LegendKeeper's search, it says which words each page holds, so negated terms and OR are honoured on the
   * text too: a term is satisfied by a page's name, alias or Scope, or by its text.
   */
  readonly text?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** v3 F3c: the key of a free-text term in `EvalContext.text`. */
export const textTermKey = (t: { readonly value: string; readonly phrase: boolean }): string =>
  `${t.phrase ? 'p' : 'w'}:${t.value}`;

/** v3 F3c: every free-text term of a query (positive and negated), once each. */
export function textTerms(e: Expr): { value: string; phrase: boolean }[] {
  const out = new Map<string, { value: string; phrase: boolean }>();
  const walk = (x: Expr): void => {
    switch (x.t) {
      case 'text':
        out.set(textTermKey(x), { value: x.value, phrase: x.phrase });
        return;
      case 'and':
      case 'or':
        x.items.forEach(walk);
        return;
      case 'not':
        walk(x.item);
        return;
      default:
        return;
    }
  };
  walk(e);
  return [...out.values()];
}

/** v3 F3c: the positive free-text terms of a query, with whether each is a phrase (for a page's hits). */
export function positiveTerms(e: Expr, negated = false): { value: string; phrase: boolean }[] {
  switch (e.t) {
    case 'text':
      return negated ? [] : [{ value: e.value, phrase: e.phrase }];
    case 'and':
    case 'or':
      return e.items.flatMap((x) => positiveTerms(x, negated));
    case 'not':
      return positiveTerms(e.item, !negated);
    default:
      return [];
  }
}

interface Result {
  readonly ok: boolean;
  readonly hits: readonly SearchHit[];
}

const NO: Result = { ok: false, hits: [] };

function textHit(s: Searchable, raw: string): SearchHit | null {
  const term = fold(raw);
  if (term === '') return null;
  const n = nameTier(s.nameKey, term);
  if (n) return { field: 'name', how: n.how, tier: n.tier };
  for (const a of s.aliasKeys)
    if (a.key.includes(term)) return { field: 'alias', text: a.text, tier: TIER.alias };
  if (s.canonical?.key.includes(term))
    return { field: 'canonical name', text: s.canonical.text, tier: TIER.alias };
  for (const sc of s.scopeKeys)
    if (sc.key.includes(term)) return { field: 'scope', text: sc.text, tier: TIER.scope };
  return null;
}

function evaluate(e: Expr, s: Searchable, ctx: EvalContext, negated: boolean): Result {
  switch (e.t) {
    case 'text': {
      const hit = textHit(s, e.value);
      if (hit) return { ok: true, hits: [hit] };
      if (ctx.text) {
        return ctx.text.get(textTermKey(e))?.has(s.node.id)
          ? { ok: true, hits: [{ field: 'page text', tier: null }] }
          : NO;
      }
      if (!negated && ctx.content?.has(s.node.id)) {
        return { ok: true, hits: [{ field: 'page text', tier: null }] };
      }
      return NO;
    }
    case 'field': {
      const v = fold(e.value);
      switch (e.field) {
        case 'name': {
          const n = nameTier(s.nameKey, v);
          return n ? { ok: true, hits: [{ field: 'name', how: n.how, tier: n.tier }] } : NO;
        }
        case 'tag':
          return s.tagKeys.has(v) ? { ok: true, hits: [{ field: 'tag', text: e.value, tier: null }] } : NO;
        case 'type':
          return s.typeKey !== null && (s.typeKey === v || containsWords(s.typeKey, v))
            ? { ok: true, hits: [{ field: 'type', text: s.node.referenceType ?? e.value, tier: null }] }
            : NO;
        case 'kind':
          return s.node.kind === v
            ? { ok: true, hits: [{ field: 'kind', text: s.node.kind, tier: null }] }
            : NO;
        case 'scope': {
          const m = s.scopeKeys.find((x) => x.key === v || containsWords(x.key, v));
          return m ? { ok: true, hits: [{ field: 'scope', text: m.text, tier: null }] } : NO;
        }
        case 'under': {
          const top = ctx.under.get(e.value);
          return top !== undefined && s.node.id !== top && s.node.path.ids.includes(top)
            ? { ok: true, hits: [{ field: 'under', text: e.value, tier: null }] }
            : NO;
        }
      }
      return NO;
    }
    case 'and': {
      const hits: SearchHit[] = [];
      for (const x of e.items) {
        const r = evaluate(x, s, ctx, negated);
        if (!r.ok) return NO;
        hits.push(...r.hits);
      }
      return { ok: true, hits };
    }
    case 'or': {
      const hits: SearchHit[] = [];
      let ok = false;
      for (const x of e.items) {
        const r = evaluate(x, s, ctx, negated);
        if (r.ok) {
          ok = true;
          hits.push(...r.hits);
        }
      }
      return ok ? { ok, hits } : NO;
    }
    case 'not':
      return evaluate(e.item, s, ctx, !negated).ok ? NO : { ok: true, hits: [] };
  }
}

export interface Ranked {
  readonly node: TreeNode;
  readonly hits: readonly SearchHit[];
  /** Lower is better; the sum of the best tiers of the free-text terms. */
  readonly score: number;
  /** True when the page was found only through LegendKeeper's page-text search. */
  readonly textOnly: boolean;
}

const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Matches, ranks and orders `candidates` against a parsed query. */
export function runSearch(e: Expr, candidates: readonly Searchable[], ctx: EvalContext): Ranked[] {
  const out: Ranked[] = [];
  for (const s of candidates) {
    const r = evaluate(e, s, ctx, false);
    if (!r.ok) continue;
    const tiers = r.hits.map((h) => h.tier).filter((t): t is number => t !== null);
    const textOnly = r.hits.length > 0 && r.hits.every((h) => h.field === 'page text');
    out.push({
      node: s.node,
      hits: r.hits,
      // A page found only by its text ranks below every page found by name, alias or scope.
      score: tiers.length > 0 ? tiers.reduce((a, b) => a + b, 0) : textOnly ? 100 : 50,
      textOnly,
    });
  }
  return out.sort(
    (a, b) =>
      a.score - b.score ||
      COLLATOR.compare(a.node.displayName, b.node.displayName) ||
      COLLATOR.compare(a.node.path.names.join('/'), b.node.path.names.join('/')) ||
      (a.node.id < b.node.id ? -1 : 1),
  );
}

/** A hit as one short phrase: `name (prefix)`, `alias "Fox"`, `tag:draft`. */
export function describeHit(h: SearchHit): string {
  switch (h.field) {
    case 'name':
      return `name (${h.how})`;
    case 'alias':
    case 'canonical name':
    case 'scope':
      return `${h.field} "${h.text}"`;
    case 'tag':
    case 'type':
    case 'kind':
    case 'under':
      return `${h.field} ${h.text}`;
    default:
      return h.field;
  }
}
