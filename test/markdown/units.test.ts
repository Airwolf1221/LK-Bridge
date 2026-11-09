/**
 * Unit tests of the converter's parts: alignment, the spec validator, each editor rule, sections and page edits, the
 * write plan, and the read-only renderers for maps, timelines and boards.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lcsPairs, pairGap, similarity } from '../../src/markdown/align.js';
import {
  applyEdit,
  EDITOR_RULES,
  fromMarkdown,
  getSection,
  MAX_BLOCK_DEPTH,
  MAX_DOCUMENT_BLOCKS,
  outline,
  renderBoard,
  renderMap,
  renderTimeline,
  toMarkdown,
  validateAgainstSpec,
} from '../../src/markdown/index.js';
import { editorProblems } from '../../src/markdown/limits.js';
import type { LkBlock } from '../../src/markdown/types.js';
import { h, p } from './helpers.js';

describe('alignment', () => {
  const brute = (a: number[], b: number[]) => {
    const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    return t[0]![0]!;
  };
  it('finds a longest common subsequence (checked against brute force)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 40 }),
        fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 40 }),
        (a, b) => {
          const pairs = lcsPairs(a, b);
          expect(pairs.length).toBe(brute(a, b));
          for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
          for (let k = 1; k < pairs.length; k++) {
            expect(pairs[k]![0]).toBeGreaterThan(pairs[k - 1]![0]);
            expect(pairs[k]![1]).toBeGreaterThan(pairs[k - 1]![1]);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
  it('aligns 10,000 items with a few edits quickly (patience anchors past the DP limit)', () => {
    const a = Array.from({ length: 10_000 }, (_, i) => i + 1);
    const b = [...a.slice(0, 2000), 99_999, ...a.slice(2001, 7000), ...a.slice(7005), 88_888];
    const t = performance.now();
    const pairs = lcsPairs(a, b);
    expect(performance.now() - t).toBeLessThan(500);
    expect(pairs.length).toBe(10_000 - 1 - 5);
  });
  it('pairs edited blocks by kind and similarity', () => {
    expect(similarity('the long winter', 'the long winter came')).toBeGreaterThan(0.8);
    expect(similarity('abc', 'xyz')).toBe(0);
    const pairs = pairGap(
      [
        { kind: 'paragraph', text: 'The founding of Sarias', pairable: true },
        { kind: 'paragraph', text: 'Burning of the library', pairable: true },
      ],
      [
        { kind: 'paragraph', text: 'Burning of the great library', pairable: true },
        { kind: 'paragraph', text: 'Something new entirely', pairable: true },
      ],
    );
    expect(pairs).toEqual([[1, 0]]);
    // One of a kind on each side pairs whatever the text.
    expect(
      pairGap(
        [{ kind: 'image', text: 'a', pairable: true }],
        [{ kind: 'image', text: 'zzz', pairable: true }],
      ),
    ).toEqual([[0, 0]]);
    expect(
      pairGap(
        [{ kind: 'image', text: 'a', pairable: false }],
        [{ kind: 'image', text: 'a', pairable: true }],
      ),
    ).toEqual([]);
  });
});

describe('the spec validator', () => {
  it('accepts valid blocks and reports each problem with its path', () => {
    expect(
      validateAgainstSpec({ kind: 'paragraph', content: [{ text: 'a', bold: true }, { break: true }] }),
    ).toEqual([]);
    expect(validateAgainstSpec({ kind: 'heading', level: 7, content: [] })).toEqual([
      { path: 'level', keyword: 'maximum', message: 'must be at most 6' },
    ]);
    expect(
      validateAgainstSpec({ kind: 'paragraph', content: [{ text: 'x'.repeat(100_001) }] })[0],
    ).toMatchObject({
      path: 'content[0].text',
      keyword: 'maxLength',
    });
    expect(validateAgainstSpec({ kind: 'image', url: 'u', width: 5 })[0]).toMatchObject({
      path: 'width',
      keyword: 'minimum',
    });
    expect(validateAgainstSpec({ kind: 'nope' })[0]).toMatchObject({
      path: 'kind',
      keyword: 'discriminator',
    });
    expect(
      validateAgainstSpec({ kind: 'paragraph', content: [{ text: 'x', color: '#ff0000' }] })[0],
    ).toMatchObject({
      path: 'content[0].color',
      keyword: 'additionalProperties',
    });
    expect(
      validateAgainstSpec({ kind: 'callout', tone: 'custom', color: 'red', children: [] })[0],
    ).toMatchObject({
      path: 'color',
      keyword: 'pattern',
    });
  });
  it('validates a 3,000-row table in well under a second', () => {
    const row = (i: number) => ({
      kind: 'tableRow',
      id: `r${i}`,
      children: [0, 1, 2].map((j) => ({
        kind: 'tableCell',
        children: [{ kind: 'paragraph', content: [{ text: `cell ${i} ${j}` }] }],
      })),
    });
    const t = performance.now();
    expect(
      validateAgainstSpec({ kind: 'table', children: Array.from({ length: 3000 }, (_, i) => row(i)) }),
    ).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it('reads its limits from the spec', () => {
    expect(MAX_BLOCK_DEPTH).toBe(64);
    expect(MAX_DOCUMENT_BLOCKS).toBe(10_000);
  });
});

describe('editor rules', () => {
  const para: LkBlock = { kind: 'paragraph', content: [] };
  const at = (kinds: string[], index = 0) => ({ ancestors: kinds.map((kind) => ({ kind })), index });
  const cases: [string, LkBlock, ReturnType<typeof at>, LkBlock, ReturnType<typeof at>][] = [
    [
      'listItem.parent',
      { kind: 'listItem', children: [] },
      at([]),
      { kind: 'listItem', children: [] },
      at(['bulletList']),
    ],
    ['list.children', para, at(['bulletList']), { kind: 'listItem', children: [] }, at(['orderedList'])],
    [
      'listItem.firstChild',
      { kind: 'bulletList', children: [] },
      at(['bulletList', 'listItem']),
      para,
      at(['bulletList', 'listItem']),
    ],
    [
      'listItem.nested',
      para,
      at(['bulletList', 'listItem'], 1),
      { kind: 'orderedList', children: [] },
      at(['bulletList', 'listItem'], 1),
    ],
    [
      'taskItem.parent',
      { kind: 'taskItem', checked: false, content: [] },
      at([]),
      { kind: 'taskItem', checked: false, content: [] },
      at(['taskList']),
    ],
    [
      'taskList.children',
      para,
      at(['taskList']),
      { kind: 'taskItem', checked: true, content: [] },
      at(['taskList']),
    ],
    [
      'tableRow.parent',
      { kind: 'tableRow', children: [] },
      at(['quote']),
      { kind: 'tableRow', children: [] },
      at(['table']),
    ],
    ['table.children', para, at(['table']), { kind: 'tableRow', children: [] }, at(['table'])],
    [
      'tableCell.parent',
      { kind: 'tableCell', children: [] },
      at(['table']),
      { kind: 'tableCell', children: [] },
      at(['table', 'tableRow']),
    ],
    [
      'tableRow.children',
      para,
      at(['table', 'tableRow']),
      { kind: 'tableCell', children: [] },
      at(['table', 'tableRow']),
    ],
    [
      'layoutColumn.parent',
      { kind: 'layoutColumn', children: [] },
      at([]),
      { kind: 'layoutColumn', children: [] },
      at(['layout']),
    ],
    ['layout.children', para, at(['layout']), { kind: 'layoutColumn', children: [] }, at(['layout'])],
    [
      'tableCell.expandList',
      { kind: 'bulletList', children: [] },
      at(['table', 'tableRow', 'tableCell', 'expand']),
      { kind: 'bulletList', children: [] },
      at(['expand']),
    ],
    [
      'callout.color',
      { kind: 'callout', tone: 'info', color: '#ff0000', children: [] },
      at([]),
      { kind: 'callout', tone: 'custom', color: '#ff0000', children: [] },
      at([]),
    ],
    [
      'map.ids',
      { kind: 'map', resourceId: 'abc' },
      at([]),
      { kind: 'map', resourceId: 'abc', documentId: 'def' },
      at([]),
    ],
    [
      'run.codeAlone',
      { kind: 'paragraph', content: [{ text: 'x', code: true, link: 'u' }] },
      at([]),
      { kind: 'paragraph', content: [{ text: 'x', code: true }] },
      at([]),
    ],
    [
      'run.subSup',
      { kind: 'paragraph', content: [{ text: 'x', sub: true, sup: true }] },
      at([]),
      { kind: 'paragraph', content: [{ text: 'x', sup: true }] },
      at([]),
    ],
  ];
  it('every rule has a test, an explanation and a source', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual(EDITOR_RULES.map((r) => r.id).sort());
    for (const r of EDITOR_RULES) {
      expect(r.message.length).toBeGreaterThan(10);
      expect(r.source.length).toBeGreaterThan(5);
    }
  });
  for (const [id, bad, badCtx, good, goodCtx] of cases) {
    it(`${id}: refuses the bad shape and accepts the good one`, () => {
      expect(editorProblems(bad, badCtx).map((x) => x.rule)).toContain(id);
      expect(editorProblems(good, goodCtx).map((x) => x.rule)).not.toContain(id);
    });
  }
  it('rules apply to new and changed blocks only, not to what the page already holds', () => {
    // LegendKeeper returned a list item at the top level (as a keep region): writing the page back is fine.
    const page: LkBlock[] = [
      { id: 'li000001', kind: 'listItem', children: [p('x', 'lp000001')] },
      p('y', 'p0000001'),
    ];
    const md = toMarkdown(page).markdown;
    expect(fromMarkdown(md.replace('\ny\n', '\nz\n'), page).plan.changed.map((c) => c.id)).toEqual([
      'p0000001',
    ]);
  });
});

describe('sections and page edits', () => {
  const page: LkBlock[] = [
    h(1, 'Title', 'h0000001'),
    p('intro', 'p0000001'),
    h(2, 'Biography', 'h0000002'),
    h(3, 'Early Life', 'h0000003'),
    p('early', 'p0000002'),
    h(3, 'Later Life', 'h0000004'),
    p('later', 'p0000003'),
    h(2, 'Notes', 'h0000005'),
    p('notes', 'p0000004'),
  ];
  const md = toMarkdown(page).markdown;

  it('matches paths by suffix, in order, exactly then ignoring case', () => {
    expect(getSection(md, 'early life').heading.path).toBe('Title > Biography > Early Life');
    expect(getSection(md, 'Title > Early Life').heading.path).toBe('Title > Biography > Early Life');
    expect(getSection(md, 'Biography').markdown).toBe(
      '## Biography\n\n### Early Life\n\nearly\n\n### Later Life\n\nlater\n',
    );
    expect(getSection(md, 'Biography').body).toBe('### Early Life\n\nearly\n\n### Later Life\n\nlater\n');
    expect(getSection(md, 'Notes')).toMatchObject({ startLine: 15, endLine: 17 });
    expect(outline(md).map((o) => [o.level, o.line])).toEqual([
      [1, 1],
      [2, 5],
      [3, 7],
      [3, 11],
      [2, 15],
    ]);
  });
  it('append and prepend touch nothing else', () => {
    const a = applyEdit(page, { mode: 'append', markdown: 'end' });
    expect(a.plan.added.map((x) => [x.index, x.afterId])).toEqual([[9, 'p0000004']]);
    expect(a.plan.kept).toBe(page.length);
    const b = applyEdit(page, { mode: 'prepend', markdown: '# New title' });
    expect(b.plan.added.map((x) => [x.index, x.afterId])).toEqual([[0, null]]);
    expect(b.blocks.slice(1)).toEqual(page);
  });
  it('replace_section keeps the heading unless the Markdown starts with one', () => {
    const body = applyEdit(page, {
      mode: 'replace_section',
      section: 'Biography',
      markdown: '### Early Life\n\nearly, revised',
    });
    expect(body.plan.changed.map((c) => c.id)).toEqual(['p0000002']);
    expect(body.plan.removed.map((r) => r.id).sort()).toEqual(['h0000004', 'p0000003']);
    const whole = applyEdit(page, {
      mode: 'replace_section',
      section: 'Later Life',
      markdown: '### Old Age\n\nlater',
    });
    expect(whole.plan.changed.map((c) => c.id)).toEqual(['h0000004']);
  });
  it('a heading kept as a region still opens a section', () => {
    const iconHeading: LkBlock = {
      id: 'hicon001',
      kind: 'heading',
      level: 2,
      content: [{ text: 'Shrines ' }, { icon: 'torii' }],
    };
    const withIcon = [...page, iconHeading, p('shrine text', 'p0000005')];
    const m = toMarkdown(withIcon).markdown;
    expect(outline(m).map((o) => o.text)).toContain('Shrines (icon)');
    expect(getSection(m, 'Shrines (icon)').markdown).toContain('shrine text');
    const r = applyEdit(withIcon, { mode: 'append_to_section', section: 'Shrines', markdown: 'more' });
    expect(r.plan.added[0]!.afterId).toBe('p0000005');
  });
});

describe('the write plan', () => {
  const page: LkBlock[] = [
    {
      id: 'ul000001',
      kind: 'bulletList',
      children: ['a', 'b', 'c'].map((x, i) => ({
        id: `li00000${i}`,
        kind: 'listItem',
        children: [p(x, `lp00000${i}`)],
      })),
    },
    p('after', 'p0000001'),
  ];
  it('reports reordered blocks as moved, keeping their ids', () => {
    const r = fromMarkdown('- a\n- c\n- b\n\nafter\n', page);
    expect(r.plan.changed).toEqual([]);
    expect(r.plan.added).toEqual([]);
    expect(r.plan.removed).toEqual([]);
    expect(r.plan.moved.map((m) => [m.id, m.fromIndex, m.index])).toEqual([['li000001', 1, 2]]);
    const s = fromMarkdown('after\n\n- a\n- b\n- c\n', page);
    expect(s.plan.moved).toHaveLength(1); // either of the two swapped blocks
    expect(s.plan.kept).toBe(8);
    expect(s.blocks).toEqual([page[1], page[0]]);
  });
  it('keeps hidden attributes of edited table cells (row header flags)', () => {
    const table: LkBlock[] = [
      {
        id: 'tbl00001',
        kind: 'table',
        children: [
          {
            id: 'tr000000',
            kind: 'tableRow',
            children: [
              { id: 'tc000000', kind: 'tableCell', header: true, children: [p('Name', 'tp000000')] },
              { id: 'tc000001', kind: 'tableCell', header: true, children: [p('Value', 'tp000001')] },
            ],
          },
          {
            id: 'tr000001',
            kind: 'tableRow',
            children: [
              { id: 'tc000002', kind: 'tableCell', header: true, children: [p('Race', 'tp000002')] },
              { id: 'tc000003', kind: 'tableCell', children: [p('Foxian', 'tp000003')] },
            ],
          },
        ],
      },
    ];
    const md = toMarkdown(table).markdown;
    expect(md).toBe('| Name | Value |\n| --- | --- |\n| Race | Foxian |\n');
    const r = fromMarkdown('| Name | Value |\n| --- | --- |\n| Species | Foxian |\n', table);
    expect(r.plan.changed.map((c) => c.id)).toEqual(['tp000002']);
    const cell = ((r.blocks[0]!.children as LkBlock[])[1]!.children as LkBlock[])[0]!;
    expect(cell.header).toBe(true);
  });
  it('mints ids for new blocks when asked', () => {
    let n = 0;
    const r = fromMarkdown('- one\n- two', [], { mintBlockId: () => `m${String(++n).padStart(7, '0')}` });
    expect(r.blocks[0]!.id).toBe('m0000001');
    expect(n).toBe(5);
  });
});

describe('read-only renderers', () => {
  it('maps: features with type, name, position and link, folders nested', () => {
    const md = renderMap({
      name: 'The Eastern Forests',
      features: [
        { id: 'f1', type: 'folder', name: 'Shrines', rank: 'a0' },
        {
          id: 'f2',
          type: 'pin',
          name: 'Torii *Gate*',
          pos: [12.5, -40.25],
          uri: 'lk://resources/kq3v8a2m',
          parentId: 'f1',
          rank: 'a0',
        },
        {
          id: 'f3',
          type: 'region',
          name: 'Qishen lands',
          polygon: [
            [0, 0],
            [0, 10],
            [10, 10],
            [10, 0],
          ],
          rank: 'a1',
        },
        { id: 'f4', type: 'label', name: 'Hidden', pos: [1, 2], isHidden: true, rank: 'a2' },
      ],
    });
    expect(md).toBe(
      '# Map: The Eastern Forests\n\n4 feature(s).\n\n- **Shrines** (folder)\n  - **Torii \\*Gate\\*** (pin) at (12.5, -40.25) → [link](lk://resources/kq3v8a2m)\n- **Qishen lands** (region) around (5, 5), 4 points\n- **Hidden** (label) at (1, 2) (hidden)\n',
    );
  });
  it('timelines: lanes, then events in date order with LegendKeeper’s formatted dates', () => {
    const md = renderTimeline({
      name: 'Fourth Arkonan Age - Timeline',
      lanes: [{ id: 'l1', name: 'Historical Events', rank: 'a0', size: 'lg' }],
      events: [
        {
          id: 'e2',
          laneId: 'l1',
          type: 'event',
          start: 2000,
          name: 'Fall of Ashgate',
          formattedStart: '4A 139',
          uri: 'lk://resources/h0gczxh7/docs/bt0bm3pc',
        },
        {
          id: 'e1',
          laneId: 'l1',
          type: 'event',
          start: 1000,
          end: 1500,
          name: 'The Long Winter',
          formattedStart: 'Kumikas 19th, 4A 100',
          formattedEnd: 'Meshaph 10th, 4A 102',
        },
        { id: 'e3', laneId: 'gone', type: 'note', start: 5, name: 'Orphan' },
      ],
    });
    expect(md).toBe(
      '# Timeline: Fourth Arkonan Age - Timeline\n\n1 lane(s), 3 event(s).\n\n## Historical Events\n\n- Kumikas 19th, 4A 100 – Meshaph 10th, 4A 102: **The Long Winter**\n- 4A 139: **Fall of Ashgate** → [link](lk://resources/h0gczxh7/docs/bt0bm3pc)\n\n## (events of other lanes)\n\n- minute 5: **Orphan** (note)\n',
    );
  });
  it('boards: shapes with their text, then connections', () => {
    const md = renderBoard(
      {
        pages: [{ id: 'page:1', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} }],
        shapes: [
          {
            id: 'shape:a',
            type: 'geo',
            parentId: 'page:1',
            index: 'a1',
            props: { geo: 'rectangle', text: 'Miyabi' },
          },
          {
            id: 'shape:b',
            type: 'note',
            parentId: 'page:1',
            index: 'a2',
            props: {
              richText: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kaede' }] }],
              },
            },
          },
          { id: 'shape:f', type: 'frame', parentId: 'page:1', index: 'a3', props: { name: 'Family' } },
          { id: 'shape:c', type: 'text', parentId: 'shape:f', index: 'a1', props: { text: 'Mother' } },
          { id: 'shape:arrow', type: 'arrow', parentId: 'page:1', index: 'a4', props: { text: 'sister of' } },
        ],
        bindings: [
          {
            id: 'binding:1',
            type: 'arrow',
            fromId: 'shape:arrow',
            toId: 'shape:a',
            props: { terminal: 'start' },
          },
          {
            id: 'binding:2',
            type: 'arrow',
            fromId: 'shape:arrow',
            toId: 'shape:b',
            props: { terminal: 'end' },
          },
        ],
      },
      'Asagiri family',
    );
    expect(md).toBe(
      '# Board: Asagiri family\n\n5 shape(s) on 1 page(s).\n\n## Page 1\n\n- rectangle "Miyabi"\n- note "Kaede"\n- frame "Family"\n  - text "Mother"\n\n## Connections\n\n- rectangle "Miyabi" → note "Kaede" ("sister of")\n',
    );
  });
});
