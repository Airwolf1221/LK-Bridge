import { describe, expect, it } from 'vitest';
import {
  describeHit,
  isPlainText,
  parseQuery,
  positiveText,
  runSearch,
  searchable,
  SearchSyntaxError,
  underValues,
  type Expr,
} from '../../src/discover/search.js';
import type { TreeNode } from '../../src/tree/index.js';

function node(id: string, name: string, o: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    rawName: `[BSRC] ${name}`,
    displayName: name,
    kind: 'bsrc',
    parentId: 'root',
    rank: null,
    depth: 1,
    path: { ids: ['root', id], names: ['AI REPOSITORY', name] },
    tags: [],
    aliases: [],
    documents: [],
    isHidden: false,
    isLocked: false,
    referenceType: null,
    scope: null,
    indexScope: null,
    canonicalDisplayName: null,
    propertiesFound: true,
    templateId: null,
    lastReadAt: 0,
    lastReadBy: 'build',
    propertiesPending: false,
    stale: false,
    staleReason: null,
    ...o,
  };
}

const NODES = [
  node('n1', 'Miyabi'),
  node('n2', 'Miyabi Asagiri', { tags: ['elder'] }),
  node('n3', 'Asagiri Kaede', { aliases: ['Miyabi’s sister'], tags: ['canon'] }),
  node('n4', 'Foxians', { kind: 'index', referenceType: 'Index', scope: 'Arkona; Beastkin' }),
  node('n5', 'Shrine of Miyabi', { referenceType: 'Character Core', scope: 'A quiet shrine' }),
  node('n6', 'The Hollow Court', { canonicalDisplayName: 'Hollow Court (Foxian)', tags: ['draft', 'elder'] }),
  node('n7', 'Compact Miyabi', { referenceType: 'Compact Character Reference' }),
];
const found = (q: string | Expr, ctx: { under?: Map<string, string>; content?: Set<string> } = {}) =>
  runSearch(typeof q === 'string' ? parseQuery(q) : q, NODES.map(searchable), {
    under: ctx.under ?? new Map(),
    ...(ctx.content ? { content: ctx.content } : {}),
  }).map((r) => r.node.id);

describe('parsing', () => {
  it('reads words, phrases, filters and operators', () => {
    expect(parseQuery('a b')).toEqual({
      t: 'and',
      items: [
        { t: 'text', value: 'a', phrase: false },
        { t: 'text', value: 'b', phrase: false },
      ],
    });
    expect(parseQuery('"a b"')).toEqual({ t: 'text', value: 'a b', phrase: true });
    expect(parseQuery('tag:elder')).toEqual({ t: 'field', field: 'tag', value: 'elder' });
    expect(parseQuery('type:"Character Core"')).toEqual({
      t: 'field',
      field: 'type',
      value: 'Character Core',
    });
    expect(parseQuery('TAG:Elder')).toEqual({ t: 'field', field: 'tag', value: 'Elder' });
  });

  it('gives NOT the tightest binding, then AND, then OR', () => {
    expect(parseQuery('a OR b c')).toEqual({
      t: 'or',
      items: [
        { t: 'text', value: 'a', phrase: false },
        {
          t: 'and',
          items: [
            { t: 'text', value: 'b', phrase: false },
            { t: 'text', value: 'c', phrase: false },
          ],
        },
      ],
    });
    expect(parseQuery('NOT a b')).toEqual({
      t: 'and',
      items: [
        { t: 'not', item: { t: 'text', value: 'a', phrase: false } },
        { t: 'text', value: 'b', phrase: false },
      ],
    });
    expect(parseQuery('-a OR b')).toEqual({
      t: 'or',
      items: [
        { t: 'not', item: { t: 'text', value: 'a', phrase: false } },
        { t: 'text', value: 'b', phrase: false },
      ],
    });
    expect(parseQuery('a AND b')).toEqual(parseQuery('a b'));
    expect(parseQuery('(a OR b) c')).toMatchObject({ t: 'and', items: [{ t: 'or' }, { t: 'text' }] });
  });

  it('treats lower-case or/and/not and a dash inside a word as plain words', () => {
    expect(parseQuery('salt or pepper')).toMatchObject({ t: 'and', items: [{}, { value: 'or' }, {}] });
    expect(parseQuery('al-Khalid')).toEqual({ t: 'text', value: 'al-Khalid', phrase: false });
    expect(parseQuery('"OR"')).toEqual({ t: 'text', value: 'OR', phrase: true });
  });

  it('collects under: values and the free text for LegendKeeper', () => {
    const e = parseQuery('foxian "hollow court" -draft under:Characters tag:x');
    expect(underValues(e)).toEqual(['Characters']);
    expect(positiveText(e)).toEqual(['foxian', 'hollow court']);
    expect(isPlainText(parseQuery('a OR (b c)'))).toBe(true);
    expect(isPlainText(parseQuery('a tag:b'))).toBe(false);
    expect(isPlainText(parseQuery('a -b'))).toBe(false);
  });

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['"never closed', /never closed/],
    ['(a b', /never closed with \)/],
    ['a b)', /no matching \(/],
    ['a OR', /needs a term after it/],
    ['OR a', /term is expected/],
    ['a OR OR b', /needs a term after it/],
    ['NOT', /must be followed/],
    ['a -', /followed by the term/],
    ['AND a', /needs a term on both sides/],
    ['colour:red', /not a search filter/],
    ['tag:', /needs a value/],
    ['tag:""', /empty/],
    ['""', /empty/],
    ['a'.repeat(501), /longer than 500/],
    [`${'('.repeat(14)}a${')'.repeat(14)}`, /nested/],
    [Array.from({ length: 41 }, (_, i) => `w${i}`).join(' '), /More than 40 terms/],
  ])('refuses the malformed query %j with an explanation', (q, message) => {
    let error: unknown;
    try {
      parseQuery(q);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SearchSyntaxError);
    expect((error as SearchSyntaxError).message).toMatch(message);
    expect((error as SearchSyntaxError).position).toBeGreaterThanOrEqual(1);
  });
});

describe('matching', () => {
  it('requires every word', () => {
    // Each word may match a different field: n3 has Asagiri in its name and Miyabi in an alias. Name matches rank first.
    expect(found('miyabi asagiri')).toEqual(['n2', 'n3']);
    expect(found('miyabi asagiri kaede')).toEqual(['n3']);
    expect(found('miyabi zzz')).toEqual([]);
  });
  it('matches aliases, Canonical Display Names and Scope with no field', () => {
    expect(found('sister')).toEqual(['n3']);
    expect(found('"hollow court (foxian)"')).toEqual(['n6']);
    expect(found('beastkin')).toEqual(['n4']);
    expect(found('quiet')).toEqual(['n5']);
  });
  it('supports OR, NOT, - and parentheses', () => {
    expect(new Set(found('kaede OR foxians'))).toEqual(new Set(['n3', 'n4']));
    expect(found('miyabi NOT asagiri')).not.toContain('n2');
    expect(found('miyabi -asagiri')).not.toContain('n2');
    expect(new Set(found('(kaede OR foxians) -kind:index'))).toEqual(new Set(['n3']));
    expect(found('NOT miyabi').includes('n1')).toBe(false);
  });
  it('applies every filter', () => {
    expect(new Set(found('tag:elder'))).toEqual(new Set(['n2', 'n6']));
    expect(found('tag:ELDER -tag:draft')).toEqual(['n2']);
    expect(new Set(found('type:character'))).toEqual(new Set(['n5', 'n7']));
    expect(found('type:"Character Core"')).toEqual(['n5']);
    expect(found('kind:index')).toEqual(['n4']);
    expect(found('scope:arkona')).toEqual(['n4']);
    expect(found('name:court')).toEqual(['n6']);
    expect(found('name:"The Hollow Court"')).toEqual(['n6']);
  });
  it('limits under: to the pages below the one it names, never the page itself', () => {
    const below = node('n8', 'Deep', {
      path: { ids: ['root', 'n4', 'n8'], names: ['AI REPOSITORY', 'Foxians', 'Deep'] },
    });
    const all = [...NODES, below].map(searchable);
    const r = runSearch(parseQuery('under:Foxians'), all, { under: new Map([['Foxians', 'n4']]) });
    expect(r.map((x) => x.node.id)).toEqual(['n8']);
  });
  it('matches ignoring case, accents’ composition and surplus spaces', () => {
    expect(found('  MIYABI   asagiri ')).toEqual(['n2', 'n3']);
    expect(found('shrine of')).toContain('n5');
  });
});

describe('ranking and reasons', () => {
  it('orders exact name, prefix, word, contains, alias, then scope', () => {
    const list = [
      node('s', 'Xfoo scope', { scope: 'fox country' }),
      node('a', 'Zed', { aliases: ['Old Fox'] }),
      node('c', 'Redfox'),
      node('w', 'The fox den'),
      node('p', 'Foxhound'),
      node('e', 'Fox'),
    ];
    const r = runSearch(parseQuery('fox'), list.map(searchable), { under: new Map() });
    expect(r.map((x) => x.node.id)).toEqual(['e', 'p', 'w', 'c', 'a', 's']);
    expect(r.map((x) => describeHit(x.hits[0]!))).toEqual([
      'name (exact)',
      'name (prefix)',
      'name (word)',
      'name (contains)',
      'alias "Old Fox"',
      'scope "fox country"',
    ]);
  });
  it('states why each term matched, filters included', () => {
    const r = runSearch(parseQuery('miyabi tag:elder'), NODES.map(searchable), { under: new Map() });
    const top = r.find((x) => x.node.id === 'n2')!;
    expect(top.hits.map(describeHit)).toEqual(['name (exact)'.replace('exact', 'prefix'), 'tag elder']);
  });
  it('is deterministic for equal scores (by name, then path)', () => {
    const a = runSearch(parseQuery('miyabi'), NODES.map(searchable), { under: new Map() }).map(
      (r) => r.node.id,
    );
    const b = runSearch(parseQuery('miyabi'), [...NODES].reverse().map(searchable), { under: new Map() }).map(
      (r) => r.node.id,
    );
    expect(a).toEqual(b);
  });
});

describe('page-text results', () => {
  it('count a free-text term as met, still apply filters, and rank below name matches', () => {
    const content = new Set(['n4', 'n6']);
    const r = runSearch(parseQuery('winter kind:index'), NODES.map(searchable), {
      under: new Map(),
      content,
    });
    expect(r.map((x) => x.node.id)).toEqual(['n4']);
    expect(r[0]!.textOnly).toBe(false); // the filter was a tree hit, the word a text hit
    const mixed = runSearch(parseQuery('miyabi OR winter'), NODES.map(searchable), {
      under: new Map(),
      content,
    });
    const ids = mixed.map((x) => x.node.id);
    expect(ids.indexOf('n1')).toBeLessThan(ids.indexOf('n6'));
    expect(mixed.find((x) => x.node.id === 'n6')!.hits.map(describeHit)).toContain('page text');
  });
  it('never uses page text to satisfy a negated term', () => {
    const content = new Set(['n1', 'n2']);
    const r = runSearch(parseQuery('miyabi -asagiri'), NODES.map(searchable), { under: new Map(), content });
    expect(r.map((x) => x.node.id)).not.toContain('n2');
  });
});
