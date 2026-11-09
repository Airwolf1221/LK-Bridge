/**
 * fast-check generators for LegendKeeper block trees within the spec's schema (spec/legendkeeper-openapi.json: Block,
 * Run), plus the content Markdown cannot express (keep regions). Text is built from units that stress the escaping:
 * every Markdown-significant character, entity look-alikes, numbered-list starts, whitespace (also at run edges),
 * CJK, right-to-left scripts, combining characters and emoji.
 */
import fc from 'fast-check';
import type { LkBlock, LkRun } from '../../src/markdown/types.js';

/** Text units: single characters and short tokens that matter to Markdown. */
export const TEXT_UNITS: readonly string[] = [
  // plain
  'a',
  'b',
  'Z',
  'x',
  'y',
  '0',
  '7',
  'word',
  'Arkona',
  ' ',
  ' ',
  '  ',
  '\t',
  // Markdown-significant characters
  '*',
  '_',
  '`',
  '[',
  ']',
  '(',
  ')',
  '|',
  '<',
  '>',
  '#',
  '!',
  '~',
  '\\',
  '&',
  '-',
  '+',
  '=',
  '.',
  ':',
  ';',
  '"',
  "'",
  '/',
  '{',
  '}',
  '^',
  '$',
  '%',
  '@',
  '?',
  ',',
  // tokens that look like syntax
  '**',
  '__',
  '~~',
  '``',
  '```',
  '***',
  '---',
  '[x]',
  '[ ]',
  '[!info]',
  '[[A]]',
  '](',
  '![',
  '<br>',
  '<u>',
  '</u>',
  '<!--',
  '-->',
  '&amp;',
  '&#32;',
  '&#x41;',
  '&lt;',
  '1.',
  '12)',
  '1. ',
  '# ',
  '> ',
  '- ',
  '+ ',
  '|---|',
  'http://example.com',
  'lk://resources/abc',
  // scripts and Unicode
  '漢',
  '字',
  'かな',
  '한국',
  'مرحبا',
  'שלום',
  'é',
  'é',
  'ä',
  ' ',
  ' ',
  '🦊',
  '👍🏽',
  '👨‍👩‍👧',
  '·',
  '—',
  '«',
  '»',
  '¿',
];

export const textArb = (maxLength = 12): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...TEXT_UNITS), { minLength: 1, maxLength }).map((a) => a.join(''));

const LINKS: readonly string[] = [
  'https://example.com',
  'https://example.com/a_b*c',
  'https://example.com/path (with) parens',
  'https://example.com/?q=1&amp;b=2',
  'https://example.com/x|y',
  'mailto:someone@example.com',
  'https://example.com/<angle>',
  'relative/page',
  'https://example.com/back\\slash',
];

const idArb = fc.stringMatching(/^[a-z][a-z0-9]{7}$/);

const markArb = fc.record(
  {
    bold: fc.constant(true),
    italic: fc.constant(true),
    strike: fc.constant(true),
    underline: fc.constant(true),
    sub: fc.constant(true),
    link: fc.constantFrom(...LINKS),
  },
  { requiredKeys: [] },
);

export const textRunArb: fc.Arbitrary<LkRun> = fc.oneof(
  { weight: 4, arbitrary: textArb().map((text) => ({ text })) },
  {
    weight: 4,
    arbitrary: fc.tuple(textArb(), markArb, fc.boolean()).map(([text, marks, sup]) => {
      const r: LkRun = { text, ...marks };
      if (sup && r.sub) {
        delete r.sub;
        r.sup = true;
      }
      return r;
    }),
  },
  { weight: 1, arbitrary: textArb(6).map((text) => ({ text, code: true })) },
);

export const mentionRunArb: fc.Arbitrary<LkRun> = fc
  .tuple(
    idArb,
    fc.option(idArb, { nil: undefined }),
    fc.option(textArb(5), { nil: undefined }),
    fc.option(textArb(5), { nil: undefined }),
  )
  .map(([resourceId, documentId, text, name]) => ({
    mention: {
      resourceId,
      ...(documentId !== undefined ? { documentId } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(name !== undefined ? { name } : {}),
    },
  }));

export const runArb: fc.Arbitrary<LkRun> = fc.oneof(
  { weight: 8, arbitrary: textRunArb },
  { weight: 1, arbitrary: mentionRunArb },
  { weight: 1, arbitrary: fc.constant({ break: true }) },
);

export const runsArb = (max = 6): fc.Arbitrary<LkRun[]> => fc.array(runArb, { minLength: 0, maxLength: max });

const para = (content: LkRun[]): LkBlock => ({ kind: 'paragraph', content });

/** Blocks Markdown can express (no keep regions). */
export function expressibleBlockArb(depth: number): fc.Arbitrary<LkBlock> {
  const leaf: fc.Arbitrary<LkBlock>[] = [
    runsArb().map(para),
    fc
      .tuple(fc.integer({ min: 1, max: 6 }), runsArb(4))
      .map(([level, content]) => ({ kind: 'heading', level, content })),
    fc
      .tuple(
        fc.array(
          fc.constantFrom(
            'a',
            'b',
            ' ',
            '\t',
            '`',
            '```',
            '~~~',
            '\\',
            '<!--',
            '#',
            '\n',
            '\n\n',
            '    x',
            '漢',
          ),
          { maxLength: 12 },
        ),
        fc.constantFrom(undefined, 'ts', 'plain text', 'c++'),
      )
      .map(([parts, language]) => ({
        kind: 'code',
        text: parts.join(''),
        ...(language ? { language } : {}),
      })),
    fc.constant({ kind: 'rule' }),
    fc
      .tuple(
        fc.constantFrom('https://assets.example/a.webp', 'https://assets.example/b (1).png'),
        fc.option(textArb(4), { nil: undefined }),
      )
      .map(([url, alt]) => ({
        kind: 'image',
        url,
        ...(alt !== undefined ? { alt } : {}),
        title: 'Image',
        isTitleHidden: true,
      })),
    fc.array(fc.tuple(fc.boolean(), runsArb(3)), { minLength: 1, maxLength: 3 }).map((items) => ({
      kind: 'taskList',
      children: items.map(([checked, content]) => ({ kind: 'taskItem', checked, content })),
    })),
    tableArb(),
  ];
  if (depth <= 0) return fc.oneof(...leaf);
  const child = expressibleBlockArb(depth - 1);
  const kids = fc.array(child, { minLength: 1, maxLength: 3 });
  const containers: fc.Arbitrary<LkBlock>[] = [
    kids.map((children) => ({ kind: 'quote', children })),
    fc
      .tuple(fc.constantFrom('info', 'note', 'success', 'warning', 'error'), kids)
      .map(([tone, children]) => ({ kind: 'callout', tone, children })),
    fc.tuple(textArb(6), kids).map(([title, children]) => ({ kind: 'expand', title, children })),
    kids.map((children) => ({ kind: 'secret', children })),
    listArb(depth),
  ];
  return fc.oneof(
    { weight: 3, arbitrary: fc.oneof(...leaf) },
    { weight: 2, arbitrary: fc.oneof(...containers) },
  );
}

function listArb(depth: number): fc.Arbitrary<LkBlock> {
  const item: fc.Arbitrary<LkBlock> =
    depth > 1
      ? fc.tuple(runsArb(4), fc.option(listArb(depth - 1), { nil: undefined })).map(([content, nested]) => ({
          kind: 'listItem',
          children: nested ? [para(content), nested] : [para(content)],
        }))
      : runsArb(4).map((content) => ({ kind: 'listItem', children: [para(content)] }));
  return fc.oneof(
    fc.array(item, { minLength: 1, maxLength: 3 }).map((children) => ({ kind: 'bulletList', children })),
    fc
      .tuple(
        fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
        fc.array(item, { minLength: 1, maxLength: 3 }),
      )
      .map(([start, children]) => ({
        kind: 'orderedList',
        ...(start !== undefined ? { start } : {}),
        children,
      })),
  );
}

export function tableArb(): fc.Arbitrary<LkBlock> {
  return fc.integer({ min: 1, max: 4 }).chain((cols) =>
    fc
      .array(fc.array(runsArb(3), { minLength: cols, maxLength: cols }), { minLength: 1, maxLength: 4 })
      .map((rows) => ({
        kind: 'table',
        children: rows.map((cells, r) => ({
          kind: 'tableRow',
          children: cells.map((content) => ({
            kind: 'tableCell',
            ...(r === 0 ? { header: true } : {}),
            children: [para(content)],
          })),
        })),
      })),
  );
}

/** Blocks Markdown cannot express: keep regions. */
export const keepBlockArb: fc.Arbitrary<LkBlock> = fc.oneof(
  fc.constant({ kind: 'unsupported' }),
  fc.constant({
    kind: 'infobox',
    layout: 'wrapRight',
    width: 40,
    rows: [{ id: 'prop1', kind: 'keyValue', title: 'Facts', rows: [{ key: 'Race', text: 'Foxian' }] }],
  }),
  fc.constant({
    kind: 'embed',
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=x',
    title: 'Embed',
    isTitleHidden: true,
  }),
  fc.constant({ kind: 'meter', mode: 'bar', items: [{ name: 'HP', icon: 'heart', current: 3, max: 10 }] }),
  fc.constant({ kind: 'resourceCollection', title: 'Collection', items: [{ resourceId: 'abcdefgh' }] }),
  fc.constant({ kind: 'paragraph', content: [{ text: 'An icon: ' }, { icon: 'star' }] }),
  fc.constant({
    kind: 'table',
    children: [
      {
        kind: 'tableRow',
        children: [{ kind: 'tableCell', colspan: 2, children: [para([{ text: 'merged' }])] }],
      },
    ],
  }),
  fc.constant({ kind: 'callout', tone: 'custom', color: '#ff0000', children: [para([{ text: 'red' }])] }),
  fc.constant({
    kind: 'layout',
    children: [{ kind: 'layoutColumn', width: 50, children: [para([{ text: 'left' }])] }],
  }),
);

/** A whole page: expressible blocks with some keep regions mixed in. */
export function pageArb(
  opts: { keep?: boolean; depth?: number; max?: number } = {},
): fc.Arbitrary<LkBlock[]> {
  const block = opts.keep
    ? fc.oneof(
        { weight: 5, arbitrary: expressibleBlockArb(opts.depth ?? 2) },
        { weight: 1, arbitrary: keepBlockArb },
      )
    : expressibleBlockArb(opts.depth ?? 2);
  return fc.array(block, { minLength: 0, maxLength: opts.max ?? 6 }).map(assignIds);
}

/** Gives every block (at any depth, rows and cells included) a unique id, as LegendKeeper does. */
export function assignIds(blocks: LkBlock[]): LkBlock[] {
  let n = 0;
  const walk = (b: LkBlock): LkBlock => {
    const id = `b${(n++).toString(36).padStart(7, '0')}`;
    const out: LkBlock = { id, ...structuredClone(b) };
    if (Array.isArray(out.children)) out.children = (out.children as LkBlock[]).map(walk);
    return out;
  };
  return blocks.map(walk);
}
