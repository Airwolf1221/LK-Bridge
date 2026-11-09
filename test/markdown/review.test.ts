/**
 * Regressions for the independent review of the converter (v2 B1): each case is a way an agent's ordinary edit, or a
 * legacy page, could have lost or changed data without a refusal.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  fromMarkdown,
  MarkdownError,
  outline,
  stubResolver,
  toMarkdown,
} from '../../src/markdown/index.js';
import type { LkBlock } from '../../src/markdown/types.js';
import { allBlocks, p } from './helpers.js';

const image: LkBlock = {
  id: 'img00001',
  kind: 'image',
  url: 'https://assets.example/ashgate.webp',
  alt: 'Map',
  title: 'Map of Ashgate',
  isTitleHidden: false,
  layout: 'wrapRight',
  width: 40,
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MarkdownError);
    return (e as MarkdownError).code;
  }
  return 'none';
}

describe('blocks moved into, out of, or between containers keep their ids and settings', () => {
  it('wrapping an image in a secret keeps the image exactly', () => {
    const md = toMarkdown([image]).markdown;
    const r = fromMarkdown(`> [!secret]\n>\n> ${md}`, [image]);
    expect(r.blocks).toEqual([{ kind: 'secret', children: [image] }]);
    expect(r.plan.moved.map((m) => m.id)).toEqual(['img00001']);
    expect(r.plan.removed).toEqual([]);
  });
  it('taking paragraphs out of a quote keeps them', () => {
    const base: LkBlock[] = [
      { id: 'quote001', kind: 'quote', children: [p('one', 'qp000001'), p('two', 'qp000002')] },
    ];
    const r = fromMarkdown('one\n\ntwo\n', base);
    expect(r.blocks).toEqual([p('one', 'qp000001'), p('two', 'qp000002')]);
    expect(r.plan.removed.map((x) => x.id)).toEqual(['quote001']);
  });
  it('turning a callout into a secret keeps what is inside', () => {
    const base: LkBlock[] = [
      {
        id: 'call0001',
        kind: 'callout',
        tone: 'info',
        icon: 'star',
        children: [p('inside', 'cp000001'), image],
      },
    ];
    const md = toMarkdown(base).markdown.replace('[!info]', '[!secret]');
    const r = fromMarkdown(md, base);
    expect(r.blocks[0]!.children).toEqual([p('inside', 'cp000001'), image]);
  });
  it('a paragraph copied into a quote while the original stays gives the copy a new block, not a second id', () => {
    const base: LkBlock[] = [p('A saying', 'p0000001'), p('More', 'p0000002')];
    const r = fromMarkdown('A saying\n\n> A saying\n\nMore\n', base);
    expect(r.blocks[0]).toEqual(base[0]);
    expect(r.blocks[1]!.children).toEqual([{ kind: 'paragraph', content: [{ text: 'A saying' }] }]);
    expect(r.plan.added).toHaveLength(1);
  });
  it('blocks outside an edited section are never taken by a move', () => {
    const base: LkBlock[] = [
      { id: 'h0000001', kind: 'heading', level: 2, content: [{ text: 'One' }] },
      p('shared text', 'p0000001'),
      { id: 'h0000002', kind: 'heading', level: 2, content: [{ text: 'Two' }] },
      p('other', 'p0000002'),
    ];
    const r = applyEdit(base, { mode: 'replace_section', section: 'Two', markdown: '> shared text' });
    expect(r.blocks[1]).toEqual(base[1]);
    expect(allBlocks(r.blocks).filter((b) => b.id === 'p0000001')).toHaveLength(1);
  });
});

describe('a legacy page that repeats a keep region’s id', () => {
  const base: LkBlock[] = [
    { id: 'dup', kind: 'embed', provider: 'youtube', url: 'https://y.example/A' },
    { id: 'dup', kind: 'embed', provider: 'youtube', url: 'https://y.example/B' },
  ];
  it('gives each region its own marker and writes back to an empty plan', () => {
    const md = toMarkdown(base).markdown;
    expect(toMarkdown(base).regions.map((r) => r.id)).toEqual(['anon-1', 'anon-2']);
    expect(fromMarkdown(md, base).plan.empty).toBe(true);
  });
  it('refuses to lose either one, and drops exactly the one named', () => {
    const md = toMarkdown(base).markdown;
    const second = md.slice(md.lastIndexOf('<!-- lk:keep'));
    const withoutB = md.replace(second, '');
    expect(code(() => fromMarkdown(withoutB, base))).toBe('KEEP_REGIONS_MISSING');
    const r = fromMarkdown(withoutB, base, {}, { dropRegions: ['anon-2'] });
    expect(r.blocks).toEqual([base[0]]);
  });
});

describe('mentions in an edited paragraph', () => {
  it('keep their own mention object, not an equal-looking one from elsewhere on the page', () => {
    const base: LkBlock[] = [
      {
        id: 'p0000001',
        kind: 'paragraph',
        content: [{ mention: { resourceId: 'kaede001', name: 'Asagiri Kaede' } }],
      },
      {
        id: 'p0000002',
        kind: 'paragraph',
        content: [
          { text: 'Signed ' },
          { mention: { resourceId: 'kaede001', text: 'Asagiri Kaede', name: 'Asagiri Kaede' } },
        ],
      },
    ];
    const md = toMarkdown(base).markdown;
    const r = fromMarkdown(md.replace('Signed', 'Signed by'), base);
    expect(r.blocks[1]!.content).toEqual([
      { text: 'Signed by ' },
      { mention: { resourceId: 'kaede001', text: 'Asagiri Kaede', name: 'Asagiri Kaede' } },
    ]);
    const s = fromMarkdown(
      `${md.replace('Signed', 'Signed by')}`.replace(/^\[Asagiri Kaede\]/, 'See [Asagiri Kaede]'),
      base,
    );
    expect(s.blocks[0]!.content).toEqual([
      { text: 'See ' },
      { mention: { resourceId: 'kaede001', name: 'Asagiri Kaede' } },
    ]);
  });
});

describe('tables written by hand', () => {
  const table = '| Name | Notes |\n| --- | --- |\n';
  it('a row with more cells than the header is refused (an unescaped | would split a cell)', () => {
    const resolveMention = stubResolver({ 'Asagiri Kaede': 'kaede001' });
    expect(
      code(() =>
        fromMarkdown(`${table}| Miyabi | Sister of [[Asagiri Kaede|Kaede]] |\n`, [], { resolveMention }),
      ),
    ).toBe('UNSUPPORTED_MARKDOWN');
    const ok = fromMarkdown(`${table}| Miyabi | Sister of [[Asagiri Kaede\\|Kaede]] |\n`, [], {
      resolveMention,
    });
    expect(JSON.stringify(ok.blocks)).toContain('"text":"Kaede"');
  });
  it('a short row gets empty cells at its end, as GFM shows it', () => {
    const r = fromMarkdown(`${table}| Miyabi |\n`, []);
    const row = (r.blocks[0]!.children as LkBlock[])[1]!;
    expect((row.children as LkBlock[]).map((c) => c.children)).toEqual([
      [{ kind: 'paragraph', content: [{ text: 'Miyabi' }] }],
      [{ kind: 'paragraph', content: [] }],
    ]);
    expect(toMarkdown(r.blocks).regions).toEqual([]);
  });
});

describe('Markdown that would vanish', () => {
  it('a link reference definition no link uses is refused; one a link uses is fine', () => {
    expect(
      code(() =>
        applyEdit([], { mode: 'append', markdown: '## Sources\n\n[1]: https://lore.example/ashgate\n' }),
      ),
    ).toBe('UNSUPPORTED_MARKDOWN');
    expect(code(() => fromMarkdown('[HP]: 45\n', []))).toBe('UNSUPPORTED_MARKDOWN');
    expect(fromMarkdown('\\[HP]: 45\n', []).blocks[0]!.content).toEqual([{ text: '[HP]: 45' }]);
    const used = fromMarkdown('See [the annals][1].\n\n[1]: https://lore.example/annals\n', []);
    expect(used.blocks).toEqual([
      {
        kind: 'paragraph',
        content: [
          { text: 'See ' },
          { text: 'the annals', link: 'https://lore.example/annals' },
          { text: '.' },
        ],
      },
    ]);
  });
});

describe('lk-blocks', () => {
  it('cannot create an unsupported block at any depth', () => {
    const md = '```lk-block\n{"kind":"quote","children":[{"kind":"unsupported","id":"zzzzzzzz"}]}\n```\n';
    expect(code(() => applyEdit([], { mode: 'append', markdown: md }))).toBe('UNSUPPORTED_KIND');
  });
});

describe('section paths read the same in Markdown and on the page', () => {
  it('a heading with a line break', () => {
    const base: LkBlock[] = [
      {
        id: 'h0000001',
        kind: 'heading',
        level: 2,
        content: [{ text: 'Early' }, { break: true }, { text: 'Life' }],
      },
    ];
    const path = outline(toMarkdown(base).markdown)[0]!.path;
    expect(path).toBe('Early Life');
    expect(
      applyEdit(base, { mode: 'append_to_section', section: path, markdown: 'x' }).plan.added,
    ).toHaveLength(1);
  });
  it('a heading with an inline icon (a keep region)', () => {
    const base: LkBlock[] = [
      { id: 'h0000001', kind: 'heading', level: 2, content: [{ text: 'Shrines ' }, { icon: 'torii' }] },
      p('text', 'p0000001'),
    ];
    const path = outline(toMarkdown(base).markdown)[0]!.path;
    expect(path).toBe('Shrines (icon)');
    expect(
      applyEdit(base, { mode: 'append_to_section', section: path, markdown: 'x' }).plan.added[0]!.afterId,
    ).toBe('p0000001');
  });
});
