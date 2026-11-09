/**
 * Every typed error of the converter, and every warning, with the input that causes it. Refusals are never silent.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  collectMentionNames,
  fromMarkdown,
  mapResolver,
  MarkdownError,
  stubResolver,
  toMarkdown,
  type MarkdownErrorCode,
} from '../../src/markdown/index.js';
import { renderPage } from '../../src/markdown/render.js';
import type { LkBlock, MarkdownWarningCode } from '../../src/markdown/types.js';
import { h, p } from './helpers.js';

const base: LkBlock[] = [
  h(1, 'Title', 'h0000001'),
  p('Intro', 'p0000001'),
  { id: 'ib000001', kind: 'infobox', rows: [] },
  h(2, 'Notes', 'h0000002'),
  p('Note one', 'p0000002'),
  { id: 'un000001', kind: 'unsupported' },
  h(2, 'Notes', 'h0000003'),
  p('Note two', 'p0000003'),
];
const md = toMarkdown(base).markdown;

function refuse(code: MarkdownErrorCode, fn: () => unknown): MarkdownError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(MarkdownError);
  const e = caught as MarkdownError;
  expect(e.code, e.message).toBe(code);
  expect(e.message.length).toBeGreaterThan(20);
  expect(JSON.parse(JSON.stringify(e))).toMatchObject({ code });
  return e;
}

const warnings = (r: { warnings: readonly { code: MarkdownWarningCode }[] }) => r.warnings.map((w) => w.code);
const region = (id: string, kind = 'infobox') =>
  `<!-- lk:keep id="${id}" kind="${kind}" -->\n\nreadable\n\n<!-- /lk:keep -->`;
const lkBlock = (b: unknown) => `\`\`\`lk-block\n${JSON.stringify(b)}\n\`\`\``;

describe('typed errors', () => {
  it('KEEP_REGIONS_MISSING lists the missing regions', () => {
    const e = refuse('KEEP_REGIONS_MISSING', () => fromMarkdown('# Title\n\nIntro\n', base));
    expect(e.details.ids).toEqual(['ib000001', 'un000001']);
  });
  it('KEEP_REGION_UNKNOWN names the region', () => {
    const e = refuse('KEEP_REGION_UNKNOWN', () => fromMarkdown(`${md}\n${region('zzzzzzzz')}\n`, base));
    expect(e.details.id).toBe('zzzzzzzz');
  });
  it('KEEP_REGION_DUPLICATE: a region twice, a region repeated in an append, a region from another section', () => {
    refuse('KEEP_REGION_DUPLICATE', () => fromMarkdown(`${md}\n${region('ib000001')}\n`, base));
    refuse('KEEP_REGION_DUPLICATE', () => applyEdit(base, { mode: 'append', markdown: region('ib000001') }));
    refuse('KEEP_REGION_DUPLICATE', () =>
      applyEdit(base, {
        mode: 'replace_section',
        section: 'Title > Notes [1]',
        markdown: `Note one\n\n${region('ib000001')}`,
      }),
    );
  });
  it('KEEP_REGION_MALFORMED: unclosed, stray close, nested, empty id', () => {
    refuse('KEEP_REGION_MALFORMED', () =>
      fromMarkdown('<!-- lk:keep id="ib000001" kind="infobox" -->\n\nx\n', base),
    );
    refuse('KEEP_REGION_MALFORMED', () => fromMarkdown('x\n\n<!-- /lk:keep -->\n', base));
    refuse('KEEP_REGION_MALFORMED', () =>
      fromMarkdown(
        `<!-- lk:keep id="ib000001" kind="infobox" -->\n\n${region('un000001', 'unsupported')}\n\n<!-- /lk:keep -->\n`,
        base,
      ),
    );
    refuse('KEEP_REGION_MALFORMED', () =>
      fromMarkdown('<!-- lk:keep id="" kind="infobox" -->\n\n<!-- /lk:keep -->\n', base),
    );
  });
  it('UNSUPPORTED_BLOCK_LOSS: dropping an unsupported block needs allowUnsupportedLoss', () => {
    const without = md.replace(/<!-- lk:keep id="un000001"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    const e = refuse('UNSUPPORTED_BLOCK_LOSS', () =>
      fromMarkdown(without, base, {}, { dropRegions: ['un000001'] }),
    );
    expect(e.details.blockIds).toEqual(['un000001']);
  });
  it('MENTION_NOT_FOUND and MENTION_AMBIGUOUS list every problem; MENTION_RESOLVER_MISSING', () => {
    const resolveMention = stubResolver({ Miyabi: 'abcd1234', Kaede: ['kaede001', 'kaede002'] });
    const e1 = refuse('MENTION_NOT_FOUND', () =>
      fromMarkdown('[[Nobody]] and [[Miyabi]]', [], { resolveMention }),
    );
    expect(e1.details.problems).toEqual([{ name: 'Nobody', result: 'not_found' }]);
    const e2 = refuse('MENTION_AMBIGUOUS', () =>
      fromMarkdown('[[Kaede]], [[Nobody]]', [], { resolveMention }),
    );
    expect((e2.details.problems as unknown[]).length).toBe(2);
    refuse('MENTION_RESOLVER_MISSING', () => fromMarkdown('[[Miyabi]]', []));
  });
  it('INVALID_LK_BLOCK: not JSON, not an object, not a block the schema accepts', () => {
    refuse('INVALID_LK_BLOCK', () => fromMarkdown('```lk-block\n{ nope\n```', []));
    refuse('INVALID_LK_BLOCK', () => fromMarkdown('```lk-block\n[1, 2]\n```', []));
    const e = refuse('INVALID_LK_BLOCK', () =>
      fromMarkdown(lkBlock({ kind: 'heading', level: 9, content: [] }), []),
    );
    expect(JSON.stringify(e.details.issues)).toContain('level');
  });
  it('UNSUPPORTED_KIND: an unsupported block can be echoed, never created', () => {
    refuse('UNSUPPORTED_KIND', () => fromMarkdown(lkBlock({ kind: 'unsupported', id: 'new00001' }), []));
    refuse('UNSUPPORTED_KIND', () =>
      fromMarkdown(`${md}\n${lkBlock({ kind: 'unsupported', id: 'p0000001' })}`, base),
    );
  });
  it('DUPLICATE_BLOCK_ID: two lk-blocks with one id, or an lk-block reusing the id of a block kept elsewhere', () => {
    const b = lkBlock({ kind: 'paragraph', id: 'dup00001', content: [] });
    refuse('DUPLICATE_BLOCK_ID', () => fromMarkdown(`${b}\n\n${b}`, []));
    // The paragraph inside the layout's keep region is restored with the region, so its id cannot be reused.
    const layout: LkBlock[] = [
      {
        id: 'lay00001',
        kind: 'layout',
        children: [{ id: 'col00001', kind: 'layoutColumn', children: [p('left', 'lay0p001')] }],
      },
    ];
    const lmd = toMarkdown(layout).markdown;
    const e = refuse('DUPLICATE_BLOCK_ID', () =>
      fromMarkdown(
        `${lmd}\n${lkBlock({ kind: 'paragraph', id: 'lay0p001', content: [{ text: 'x' }] })}\n`,
        layout,
      ),
    );
    expect(e.details.ids).toEqual(['lay0p001']);
    // Reusing the id of a block the Markdown otherwise leaves out is a replacement, not a duplicate.
    const r = fromMarkdown(
      `${md}\n${lkBlock({ kind: 'paragraph', id: 'p0000003', content: [{ text: 'x' }] })}\n`,
      base,
    );
    expect(r.plan.changed.map((c) => c.id)).toEqual(['p0000003']);
    expect(r.plan.added.map((a) => a.block.content)).toEqual([[{ text: 'Note two' }]]);
  });
  it('EDITOR_LIMIT: a list item at the top level, a task holding a list, a list in an expand in a table cell, code with bold', () => {
    const e1 = refuse('EDITOR_LIMIT', () =>
      fromMarkdown(lkBlock({ kind: 'listItem', children: [{ kind: 'paragraph', content: [] }] }), []),
    );
    expect(e1.details.rule).toBe('listItem.parent');
    expect(refuse('EDITOR_LIMIT', () => fromMarkdown('- [ ] a\n  - b\n', [])).details.rule).toBe(
      'taskItem.content',
    );
    const cell = {
      kind: 'table',
      children: [
        {
          kind: 'tableRow',
          children: [
            {
              kind: 'tableCell',
              children: [
                {
                  kind: 'expand',
                  title: 'x',
                  children: [
                    {
                      kind: 'bulletList',
                      children: [{ kind: 'listItem', children: [{ kind: 'paragraph', content: [] }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(refuse('EDITOR_LIMIT', () => fromMarkdown(lkBlock(cell), [])).details.rule).toBe(
      'tableCell.expandList',
    );
    expect(refuse('EDITOR_LIMIT', () => fromMarkdown('**`x`**', [])).details.rule).toBe('run.codeAlone');
    expect(refuse('EDITOR_LIMIT', () => fromMarkdown('<sub><sup>x</sup></sub>', [])).details.rule).toBe(
      'run.subSup',
    );
  });
  it('FIELD_LIMIT: text over 100,000 characters, nesting deeper than 64', () => {
    const e = refuse('FIELD_LIMIT', () => fromMarkdown('x'.repeat(100_001), []));
    expect(e.message).toContain('100000');
    refuse('FIELD_LIMIT', () => fromMarkdown(`${'> '.repeat(65)}deep\n`, []));
  });
  it('SCHEMA_VIOLATION: a text colour the API cannot store yet', () => {
    const e = refuse('SCHEMA_VIOLATION', () => fromMarkdown('<span style="color:#ff0000">red</span>', []));
    expect(e.message).toContain('cannot store text colours');
  });
  it('IMAGE_URL_REFUSED: inline data, plain http, a URL that is not a project asset', () => {
    refuse('IMAGE_URL_REFUSED', () => fromMarkdown('![x](data:image/png;base64,AAAA)', []));
    refuse('IMAGE_URL_REFUSED', () => fromMarkdown('![x](http://example.com/a.png)', []));
    refuse('IMAGE_URL_REFUSED', () =>
      fromMarkdown('![x](https://elsewhere.example/a.png)', [], { isProjectAsset: () => false }),
    );
    expect(
      fromMarkdown('![x](https://assets.example/a.png)', [], { isProjectAsset: () => true }).warnings,
    ).toEqual([]);
  });
  it('INLINE_IMAGE: an image inside a line of text', () => {
    refuse('INLINE_IMAGE', () => fromMarkdown('See ![x](https://assets.example/a.png) here', []));
    refuse('INLINE_IMAGE', () => fromMarkdown('[![x](https://assets.example/a.png)](https://x.y)', []));
  });
  it('UNSUPPORTED_HTML: an HTML block, an unknown tag, an unknown style', () => {
    refuse('UNSUPPORTED_HTML', () => fromMarkdown('<div>\nx\n</div>\n', []));
    refuse('UNSUPPORTED_HTML', () => fromMarkdown('a <font color="red">b</font>', []));
    refuse('UNSUPPORTED_HTML', () => fromMarkdown('<span style="font-size:20px">b</span>', []));
    refuse('UNSUPPORTED_HTML', () => fromMarkdown('<u class="x">b</u>', []));
  });
  it('UNSUPPORTED_MARKDOWN: an lk:// link that is not a mention', () => {
    refuse('UNSUPPORTED_MARKDOWN', () => fromMarkdown('[x](lk://documents/abc)', []));
  });
  it('SECTION_NOT_FOUND and SECTION_AMBIGUOUS list the options; [n] picks one', () => {
    const e1 = refuse('SECTION_NOT_FOUND', () =>
      applyEdit(base, { mode: 'append_to_section', section: 'Missing', markdown: 'x' }),
    );
    expect(JSON.stringify(e1.details.available)).toContain('Title > Notes');
    const e2 = refuse('SECTION_AMBIGUOUS', () =>
      applyEdit(base, { mode: 'append_to_section', section: 'Notes', markdown: 'x' }),
    );
    expect((e2.details.options as { choose: string }[]).map((o) => o.choose)).toEqual([
      'Title > Notes [1]',
      'Title > Notes [2]',
    ]);
    const r = applyEdit(base, { mode: 'append_to_section', section: 'Notes [2]', markdown: 'Note three' });
    expect(r.plan.added[0]!.afterId).toBe('p0000003');
    refuse('SECTION_NOT_FOUND', () =>
      applyEdit(base, { mode: 'append_to_section', section: 'Notes [3]', markdown: 'x' }),
    );
  });
  it('INVALID_EDIT: unknown mode, a section mode without a section, a section on a whole-page mode', () => {
    refuse('INVALID_EDIT', () => applyEdit(base, { mode: 'rewrite' as never, markdown: 'x' }));
    refuse('INVALID_EDIT', () => applyEdit(base, { mode: 'replace_section', markdown: 'x' }));
    refuse('INVALID_EDIT', () => applyEdit(base, { mode: 'append', section: 'Notes', markdown: 'x' }));
    refuse('INVALID_EDIT', () =>
      applyEdit(base, { mode: 'append_to_section', section: ' > ', markdown: 'x' }),
    );
    refuse('INVALID_EDIT', () => applyEdit(base, { mode: 'append', markdown: 3 as never }));
  });
  it('RENDER_SELF_CHECK_FAILED when the Markdown would not convert back even with keep regions', () => {
    refuse('RENDER_SELF_CHECK_FAILED', () => renderPage([p('x', 'p0000009')], true, () => []));
  });
});

describe('warnings', () => {
  it('KEEP_REGION_EDITED and KEEP_REGION_KIND', () => {
    const edited = md.replace('**Infobox**', '**Infobox, edited**').replace('kind="infobox"', 'kind="table"');
    expect(warnings(fromMarkdown(edited, base))).toEqual(['KEEP_REGION_KIND', 'KEEP_REGION_EDITED']);
  });
  it('RENDERED_AS_KEEP_REGION when the self-check turns a block into a region', () => {
    let calls = 0;
    // The first (whole-page) check fails; every later one passes: the block is shown as a region.
    const page = renderPage([p('x', 'p0000009')], true, () =>
      calls++ === 0 ? [] : [{ t: 'keep', id: 'p0000009', kind: 'paragraph', inner: '', line: 1 }],
    );
    expect(page.warnings.map((w) => w.code)).toEqual(['RENDERED_AS_KEEP_REGION']);
    expect(page.markdown).toContain('<!-- lk:keep id="p0000009" kind="paragraph" -->');
  });
  it('HTML_COMMENT_IGNORED, HTML_TAG_UNBALANCED, TITLE_IGNORED, ALIGNMENT_IGNORED', () => {
    expect(warnings(fromMarkdown('<!-- note to self -->\n\ntext', []))).toEqual(['HTML_COMMENT_IGNORED']);
    expect(warnings(fromMarkdown('a <!-- inline --> b', []))).toEqual(['HTML_COMMENT_IGNORED']);
    expect(warnings(fromMarkdown('<u>open', []))).toEqual(['HTML_TAG_UNBALANCED']);
    expect(warnings(fromMarkdown('close</u>', []))).toEqual(['HTML_TAG_UNBALANCED']);
    expect(warnings(fromMarkdown('[a](https://x.y "title")', []))).toEqual(['TITLE_IGNORED']);
    expect(
      warnings(
        fromMarkdown('![a](https://assets.example/a.png "title")', [], { isProjectAsset: () => true }),
      ),
    ).toEqual(['TITLE_IGNORED']);
    expect(warnings(fromMarkdown('| a |\n| :-: |\n| b |', []))).toEqual(['ALIGNMENT_IGNORED']);
  });
  it('CALLOUT_TYPE_UNKNOWN, FORMATTING_IGNORED, TASK_LIST_NUMBERING', () => {
    const r = fromMarkdown('> [!important]\n> text', []);
    expect(warnings(r)).toEqual(['CALLOUT_TYPE_UNKNOWN']);
    expect(r.blocks[0]!.kind).toBe('quote');
    const e = fromMarkdown('> [!expand] **Bold** title\n> body', []);
    expect(warnings(e)).toEqual(['FORMATTING_IGNORED']);
    expect(e.blocks[0]).toMatchObject({ kind: 'expand', title: 'Bold title' });
    expect(warnings(fromMarkdown('1. [ ] a\n2. [x] b', []))).toEqual(['TASK_LIST_NUMBERING']);
  });
  it('IMAGE_URL_UNCHECKED, LK_BLOCK_VERSION_STRIPPED, DROP_REGION_NOT_MISSING', () => {
    expect(warnings(fromMarkdown('![a](https://assets.example/a.png)', []))).toEqual(['IMAGE_URL_UNCHECKED']);
    expect(warnings(fromMarkdown(lkBlock({ kind: 'rule', version: 'v9' }), []))).toEqual([
      'LK_BLOCK_VERSION_STRIPPED',
    ]);
    expect(warnings(fromMarkdown(md, base, {}, { dropRegions: ['p0000001'] }))).toEqual([
      'DROP_REGION_NOT_MISSING',
    ]);
  });
});

describe('mentions', () => {
  it('collects [[names]] for an asynchronous resolver and answers from a map', () => {
    const text =
      'With [[Asagiri Miyabi]], [[Kaede|her sister]] and \\[\\[not a mention\\]\\].\n\n| a |\n| --- |\n| [[Hollow King\\|the king]] |';
    expect(collectMentionNames(text)).toEqual(['Asagiri Miyabi', 'Kaede', 'Hollow King']);
    const resolve = mapResolver(
      new Map([
        ['Asagiri Miyabi', { status: 'resolved', resourceId: 'miyabi01' }],
        ['Kaede', { status: 'resolved', resourceId: 'kaede001' }],
        ['Hollow King', { status: 'resolved', resourceId: 'hollow01', documentId: 'doc00001' }],
      ] as const),
    );
    const r = fromMarkdown(text, [], { resolveMention: resolve });
    expect(r.blocks[0]!.content).toEqual([
      { text: 'With ' },
      { mention: { resourceId: 'miyabi01' } },
      { text: ', ' },
      { mention: { resourceId: 'kaede001', text: 'her sister' } },
      { text: ' and [[not a mention]].' },
    ]);
    expect(JSON.stringify(r.blocks[1])).toContain('"documentId":"doc00001","text":"the king"');
  });
});
