/**
 * Escaping fuzz: every Markdown-significant character at every position of a run, in every place text can sit, plus
 * nested and overlapping marks, empty runs, whitespace at run edges, CJK, right-to-left text, combining characters,
 * emoji and very long paragraphs. Each case must render without a keep region, read back as exactly its projection,
 * restore exactly against its page, and render again byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { fromMarkdown, projectDocument, toMarkdown } from '../../src/markdown/index.js';
import type { LkBlock, LkRun } from '../../src/markdown/types.js';
import { assignIds } from './arbitraries.js';
import { parsedProjection } from './helpers.js';

/** Asserts the four exactness properties for one page; returns its Markdown. */
export function assertExact(blocks: LkBlock[]): string {
  const page = assignIds(blocks);
  const r = toMarkdown(page);
  expect(r.warnings, r.markdown).toEqual([]);
  expect(r.regions, r.markdown).toEqual([]);
  expect(parsedProjection(r.markdown), r.markdown).toEqual(projectDocument(page));
  const back = fromMarkdown(r.markdown, page);
  expect(back.blocks).toEqual(page);
  expect(back.plan.empty).toBe(true);
  const fresh = fromMarkdown(r.markdown, []).blocks;
  expect(toMarkdown(fresh).markdown, r.markdown).toBe(r.markdown);
  return r.markdown;
}

const SIGNIFICANT = [
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
  ':',
  '"',
  "'",
  '.',
];
const TOKENS = [
  '1.',
  '1)',
  '123456789.',
  '&amp;',
  '&#32;',
  '&copy;',
  '**',
  '__',
  '~~',
  '```',
  '---',
  '***',
  '[ ]',
  '[x]',
  '[!info]',
  '[[Name]]',
  '<br>',
  '<!-- x -->',
  'http://x.y',
  '![a](b)',
  '[a](b)',
  '\\*',
];
const PLACES = (c: string) => [
  c,
  `${c}a`,
  `a${c}`,
  `a${c}b`,
  `${c}${c}`,
  ` ${c} `,
  `a ${c} b`,
  `${c}${c}${c}`,
];

const para = (content: LkRun[]): LkBlock => ({ kind: 'paragraph', content });
/** The places text can sit, each a page builder. */
const CONTEXTS: Record<string, (runs: LkRun[]) => LkBlock[]> = {
  paragraph: (runs) => [para(runs)],
  heading: (runs) => [{ kind: 'heading', level: 2, content: runs }],
  'list item': (runs) => [{ kind: 'bulletList', children: [{ kind: 'listItem', children: [para(runs)] }] }],
  'numbered item': (runs) => [
    { kind: 'orderedList', start: 7, children: [{ kind: 'listItem', children: [para(runs)] }] },
  ],
  task: (runs) => [{ kind: 'taskList', children: [{ kind: 'taskItem', checked: true, content: runs }] }],
  quote: (runs) => [{ kind: 'quote', children: [para(runs)] }],
  callout: (runs) => [{ kind: 'callout', tone: 'note', children: [para(runs)] }],
  'table cell': (runs) => [
    {
      kind: 'table',
      children: [
        {
          kind: 'tableRow',
          children: [
            { kind: 'tableCell', header: true, children: [para(runs)] },
            { kind: 'tableCell', header: true, children: [para([{ text: 'h' }])] },
          ],
        },
        {
          kind: 'tableRow',
          children: [
            { kind: 'tableCell', children: [para(runs)] },
            { kind: 'tableCell', children: [para([])] },
          ],
        },
      ],
    },
  ],
};
const text = (t: string): LkRun[] => [{ text: t }];
const RUN_SHAPES: Record<string, (t: string) => LkRun[]> = {
  plain: text,
  bold: (t) => [{ text: 'x' }, { text: t, bold: true }, { text: 'y' }],
  italic: (t) => [{ text: t, italic: true }],
  strike: (t) => [{ text: 'a ' }, { text: t, strike: true }],
  underline: (t) => [{ text: t, underline: true }, { text: 'z' }],
  sup: (t) => [{ text: 'E=mc' }, { text: t, sup: true }],
  sub: (t) => [{ text: 'H' }, { text: t, sub: true }, { text: 'O' }],
  code: (t) => [{ text: t, code: true }],
  link: (t) => [{ text: t, link: 'https://example.com/a_(b)' }],
  'mention label': (t) => [{ mention: { resourceId: 'abcd1234', text: t } }],
  'bold italic link': (t) => [{ text: t, bold: true, italic: true, link: 'https://example.com' }],
};

describe('escaping: every significant character, everywhere', () => {
  for (const [ctxName, build] of Object.entries(CONTEXTS)) {
    for (const [shapeName, shape] of Object.entries(RUN_SHAPES)) {
      it(`${shapeName} in a ${ctxName}`, () => {
        // One page per character (every place at once): a block that did not survive would show as a keep region.
        for (const c of [...SIGNIFICANT, ...TOKENS]) assertExact(PLACES(c).flatMap((t) => build(shape(t))));
      });
    }
  }
  it('expand titles', () => {
    for (const c of [...SIGNIFICANT, ...TOKENS])
      assertExact(
        PLACES(c).map((t): LkBlock => ({ kind: 'expand', title: t, children: [para(text('body'))] })),
      );
  });
  it('image alt text and URLs', () => {
    for (const c of [...SIGNIFICANT, ...TOKENS]) {
      for (const t of PLACES(c))
        assertExact([{ kind: 'image', url: `https://assets.example/${encodeURIComponent(t)}`, alt: t }]);
      assertExact([{ kind: 'image', url: `https://assets.example/a${c}b`, alt: 'x' }]);
    }
  });
  it('link URLs with awkward characters', () => {
    for (const url of [
      'https://e.x/a b',
      'https://e.x/(a)',
      'https://e.x/a)b',
      'https://e.x/<a>',
      'https://e.x/a\\b',
      'https://e.x/a&amp;b',
      'https://e.x/a|b',
      'https://e.x/a*b_c',
      'x',
      '#anchor',
    ])
      for (const build of Object.values(CONTEXTS))
        assertExact(build([{ text: 'go', link: url }, { text: ' on' }]));
  });
  it('code blocks with fences, tildes, indentation and languages', () => {
    for (const t of [
      '',
      '\n',
      '\n\n',
      'a\n',
      '```',
      '````\n```',
      '~~~',
      '    indented',
      '\tTab',
      'a\n\nb',
      '<!-- /lk:keep -->',
      '> q',
      '- x',
      '\\',
    ])
      for (const language of [undefined, 'ts', 'plain text', 'c++', 'objective-c'])
        for (const wrap of [
          (b: LkBlock) => [b],
          (b: LkBlock) => [{ kind: 'quote', children: [b] }],
          (b: LkBlock) => [
            {
              kind: 'bulletList',
              children: [
                {
                  kind: 'listItem',
                  children: [
                    para(text('i')),
                    { kind: 'bulletList', children: [{ kind: 'listItem', children: [para(text('j'))] }] },
                  ],
                },
              ],
            },
            b,
          ],
        ])
          assertExact(wrap({ kind: 'code', text: t, ...(language ? { language } : {}) }));
  });
});

describe('escaping: marks, whitespace and scripts', () => {
  it('nested and overlapping marks', () => {
    const cases: LkRun[][] = [
      [
        { text: 'a', bold: true },
        { text: 'b', bold: true, italic: true },
        { text: 'c', italic: true },
      ],
      [
        { text: 'a', italic: true },
        { text: 'b', bold: true },
      ],
      [
        { text: 'a', bold: true },
        { text: 'b', italic: true },
      ],
      [
        { text: 'a', strike: true, bold: true },
        { text: 'b', strike: true },
        { text: 'c', bold: true, strike: true },
      ],
      [
        { text: 'a', underline: true, sup: true },
        { text: 'b', underline: true },
        { text: 'c', sub: true, underline: true },
      ],
      [
        { text: 'a', link: 'https://x.y', bold: true },
        { text: 'b', link: 'https://x.y' },
        { text: 'c', bold: true },
      ],
      [
        { text: 'a', link: 'https://x.y' },
        { text: 'b', link: 'https://z.y' },
      ],
      [
        { text: 'x', code: true },
        { text: '`' },
        { text: 'y`', code: true },
        { text: '``' },
        { text: '`z', code: true },
      ],
      [
        { text: '*', bold: true },
        { text: '*', italic: true },
        { text: '_', bold: true },
      ],
      [{ text: '(a)', italic: true }, { text: 'b' }],
      [{ text: 'a' }, { text: '(b)', bold: true }, { text: 'c' }],
      [
        { text: 'a', bold: true },
        { mention: { resourceId: 'abcd1234', text: 'm' } },
        { text: 'b', bold: true },
      ],
      [{ text: 'a', bold: true }, { break: true }, { text: 'b', italic: true }],
      [{ break: true }],
      [{ break: true }, { break: true }],
      [{ text: 'Wow!' }, { text: 'link', link: 'https://x.y' }],
      [{ text: 'Wow!' }, { mention: { resourceId: 'abcd1234', text: 'm' } }],
      [{ text: '🦊', bold: true }, { text: 'x' }],
      [{ text: 'x' }, { text: '«a»', italic: true }, { text: 'y' }],
    ];
    for (const build of Object.values(CONTEXTS)) assertExact(cases.flatMap((runs) => build(runs)));
  });
  it('empty runs and runs to merge are normalised the way LegendKeeper does', () => {
    const page = assignIds([
      para([{ text: '' }, { text: 'a', bold: true }, { text: 'b', bold: true }, { text: '', italic: true }]),
    ]);
    const r = toMarkdown(page);
    expect(r.markdown).toBe('**ab**\n');
    expect(parsedProjection(r.markdown)).toEqual(projectDocument(page));
    // The page itself is still restored verbatim (nothing to write).
    expect(fromMarkdown(r.markdown, page).plan.empty).toBe(true);
  });
  it('whitespace at run edges and block edges', () => {
    for (const ws of [' ', '  ', '\t', ' \t ', ' ', ' '])
      for (const runs of [
        [{ text: `${ws}lead` }],
        [{ text: `trail${ws}` }],
        [{ text: ws }],
        [{ text: `bold${ws}`, bold: true }, { text: 'next' }],
        [{ text: 'prev' }, { text: `${ws}bold`, bold: true }],
        [{ text: `${ws}it${ws}`, italic: true }],
        [{ text: `${ws}code${ws}`, code: true }],
        [{ text: `${ws}`, strike: true }],
        [{ text: 'a' }, { text: ws, link: 'https://x.y' }, { text: 'b' }],
      ])
        for (const build of Object.values(CONTEXTS)) assertExact(build(runs));
  });
  it('CJK, right-to-left, combining characters and emoji', () => {
    const samples = [
      '漢字かな交じり文',
      '한국어 문장',
      'مرحبا بالعالم',
      'שלום עולם',
      'é ä ñ',
      'א‏ב',
      '🦊👍🏽👨‍👩‍👧🏳️‍🌈',
      'Ünïcödé ß',
      '**漢**',
      '_مرحبا_',
      '‮RLO‬',
    ];
    for (const shape of Object.values(RUN_SHAPES))
      for (const build of Object.values(CONTEXTS)) assertExact(samples.flatMap((s) => build(shape(s))));
  });
  it('text colours and highlights (not in the API yet): rendered, read back, and restored from the page', () => {
    const page = assignIds([
      para([
        { text: 'red', color: '#ff0000' },
        { text: ' both', color: '#ff0000', highlight: '#FFFF00' },
        { text: ' marked', highlight: '#FFFF00', bold: true },
      ]),
    ]);
    const r = toMarkdown(page);
    expect(r.markdown).toBe(
      '<span style="color:#ff0000">red<span style="background-color:#FFFF00"> both</span></span><span style="background-color:#FFFF00"><strong> marked</strong></span>\n',
    );
    expect(parsedProjection(r.markdown)).toEqual(projectDocument(page));
    expect(fromMarkdown(r.markdown, page).plan.empty).toBe(true);
  });
  it('very long paragraphs (100,000 characters with syntax all through)', () => {
    const chunk = 'Lorem *ipsum* _dolor_ [sit] `amet` <consectetur> #adipiscing & elit | 1. ~sed~ \\ do! ';
    const long = chunk.repeat(Math.ceil(100_000 / chunk.length)).slice(0, 100_000);
    const md = assertExact([
      para([{ text: long }]),
      para([{ text: long.slice(0, 50_000), bold: true }, { text: long.slice(50_000) }]),
    ]);
    expect(md.length).toBeGreaterThan(200_000);
  });
});
