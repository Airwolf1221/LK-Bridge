/**
 * Pages modelled on the test world (fixtures.ts): exact Markdown, the empty plan for an unchanged page, typical agent
 * edits and what they change, keep-region behaviour, and the time a 3,000-block page takes both ways.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  fromMarkdown,
  getSection,
  MarkdownError,
  outline,
  stubResolver,
  toMarkdown,
} from '../../src/markdown/index.js';
import type { LkBlock } from '../../src/markdown/types.js';
import { bsrcPage, fourthAgeTablePage, mainChronologyPage, richPage } from './fixtures.js';
import { allBlocks } from './helpers.js';

const BSRC_MD = `# Asagiri Miyabi

**Asagiri Miyabi** is a Qishen shrine maiden of the [Foxians](lk://resources/x9fox001), born in the [Fourth Arkonan Age](lk://resources/h0gczxh7/docs/bt0bm3pc).

![Miyabi at the shrine](https://assets.example/miyabi-portrait.webp)

## Biography

### Early Life

Born on *Kumikas 1st, 4A 881*, in the village of Sarias.

She trained under the shrine’s elder for seven years — longer than any acolyte before her.

### Later Life

- Became head maiden in 4A 900.
- Travelled to:
  1. Ashgate
  2. the Hollow Court

<p></p>

## Relationships

Sister of [Asagiri Kaede](lk://resources/sis00001).
`;

const byId = (blocks: readonly LkBlock[], id: string) => allBlocks(blocks).find((b) => b.id === id)!;

function expectCode(fn: () => unknown, code: string): MarkdownError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MarkdownError);
    expect((e as MarkdownError).code).toBe(code);
    return e as MarkdownError;
  }
  throw new Error(`expected ${code}`);
}

describe('a [BSRC] article', () => {
  const page = bsrcPage();

  it('renders exactly the owner schema', () => {
    const r = toMarkdown(page);
    expect(r.markdown).toBe(BSRC_MD);
    expect(r.regions).toEqual([]);
  });

  it('writes back to an empty plan', () => {
    const r = fromMarkdown(BSRC_MD, page);
    expect(r.plan.empty).toBe(true);
    expect(r.blocks).toEqual(page);
  });

  it('outlines and addresses sections by heading path', () => {
    expect(outline(BSRC_MD).map((o) => o.path)).toEqual([
      'Asagiri Miyabi',
      'Asagiri Miyabi > Biography',
      'Asagiri Miyabi > Biography > Early Life',
      'Asagiri Miyabi > Biography > Later Life',
      'Asagiri Miyabi > Relationships',
    ]);
    const s = getSection(BSRC_MD, 'Biography > Early Life');
    expect(s.markdown).toBe(
      '### Early Life\n\nBorn on *Kumikas 1st, 4A 881*, in the village of Sarias.\n\nShe trained under the shrine’s elder for seven years — longer than any acolyte before her.\n',
    );
    expect(getSection(BSRC_MD, 'Biography').markdown).toContain('### Later Life');
    expect(getSection(BSRC_MD, 'Biography').markdown).not.toContain('## Relationships');
  });

  it('replaces one section and keeps every other block, image styling included', () => {
    const r = applyEdit(page, {
      mode: 'replace_section',
      section: 'Early Life',
      markdown:
        'Born on *Kumikas 1st, 4A 881*, in the village of Sarias.\n\nShe trained for **nine** years.\n',
    });
    expect(r.plan.changed.map((c) => c.id)).toEqual(['p0000002']);
    expect(r.plan.added).toEqual([]);
    expect(r.plan.removed).toEqual([]);
    expect(byId(r.blocks, 'img00001')).toEqual(page[2]);
    expect(byId(r.blocks, 'p0000002').content).toEqual([
      { text: 'She trained for ' },
      { text: 'nine', bold: true },
      { text: ' years.' },
    ]);
  });

  it('keeps an image’s layout, width and title when its alt text changes', () => {
    const md = BSRC_MD.replace('![Miyabi at the shrine]', '![Miyabi praying at the shrine]');
    const r = fromMarkdown(md, page);
    expect(r.plan.changed).toHaveLength(1);
    expect(byId(r.blocks, 'img00001')).toEqual({ ...page[2], alt: 'Miyabi praying at the shrine' });
  });

  it('reuses the original mention (no fixed label) when the text around it changes', () => {
    const md = BSRC_MD.replace('is a Qishen shrine maiden', 'is a celebrated Qishen shrine maiden');
    const r = fromMarkdown(md, page);
    expect(r.plan.changed.map((c) => c.id)).toEqual(['p0r1s2t3']);
    const content = byId(r.blocks, 'p0r1s2t3').content as unknown[];
    expect(content[2]).toEqual({ mention: { resourceId: 'x9fox001', name: 'Foxians' } });
  });

  it('appends to a section, resolving [[Name]] mentions', () => {
    const r = applyEdit(
      page,
      {
        mode: 'append_to_section',
        section: 'Relationships',
        markdown: 'Rival of [[Hollow King]] and [[Asagiri Kaede|her sister]].',
      },
      { resolveMention: stubResolver({ 'Hollow King': 'hk000001', 'Asagiri Kaede': 'sis00001' }) },
    );
    expect(r.plan.added).toHaveLength(1);
    expect(r.plan.added[0]!.afterId).toBe('p0000004');
    expect(r.plan.added[0]!.block.content).toEqual([
      { text: 'Rival of ' },
      { mention: { resourceId: 'hk000001' } },
      { text: ' and ' },
      { mention: { resourceId: 'sis00001', text: 'her sister' } },
      { text: '.' },
    ]);
  });

  it('replaces a section heading too when the Markdown starts with one', () => {
    const r = applyEdit(page, {
      mode: 'replace_section',
      section: 'Relationships',
      markdown: '## Family\n\nSister of nobody.',
    });
    expect(r.plan.changed.map((c) => c.id).sort()).toEqual(['p0000004', 'rel00001']);
    expect(byId(r.blocks, 'rel00001').content).toEqual([{ text: 'Family' }]);
  });
});

describe('the Fourth Arkonan Age table page', () => {
  const page = fourthAgeTablePage();

  it('is the size of the real page', () => {
    expect(allBlocks(page).length).toBeGreaterThanOrEqual(3000);
    expect(JSON.stringify(page).length).toBeGreaterThan(190_000);
  });

  it('renders a GFM table with one line per row', () => {
    const md = toMarkdown(page).markdown;
    const lines = md.split('\n');
    expect(lines.slice(6, 9)).toEqual([
      '| Historical Event | Date | KCY |',
      '| --- | --- | --- |',
      '| The Sundering of the Northern Reaches | Azah 18th, 4A 1 | 1250308 |',
    ]);
    expect(lines.filter((l) => l.startsWith('| ')).length).toBe(432);
    // The italic run starts with a space, which `*` cannot open on, so it is written with <em> (exact either way).
    expect(md).toContain('| [Birth of Asagiri Miyabi](lk://resources/bsrc0001)<em> (disputed)</em> |');
  });

  it('converts both ways in well under a second, and an unchanged write is empty', () => {
    toMarkdown(page); // warm up
    const t0 = performance.now();
    const md = toMarkdown(page).markdown;
    const t1 = performance.now();
    const back = fromMarkdown(md, page);
    const t2 = performance.now();
    expect(back.plan.empty).toBe(true);
    expect(back.plan.kept).toBe(allBlocks(page).length);
    // Typically about 250 ms here; the bound leaves room for a slow CI runner.
    expect(t2 - t0).toBeLessThan(1000);
    expect(t1 - t0).toBeLessThan(600);
  });

  it('editing one cell changes only that cell’s paragraph', () => {
    const md = toMarkdown(page).markdown.replace(
      '| Fall of Ashgate (3) |',
      '| Fall of Ashgate (3, retold) |',
    );
    const r = fromMarkdown(md, page);
    expect(r.plan.changed).toHaveLength(1);
    expect(r.plan.changed[0]!.kind).toBe('paragraph');
    expect(r.plan.added).toEqual([]);
    expect(r.plan.removed).toEqual([]);
    expect(r.plan.kept).toBe(allBlocks(page).length - 1);
  });

  it('inserting a row adds one row after the right one; deleting one removes it', () => {
    const md = toMarkdown(page).markdown;
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| Treaty of Reeds (2) |'));
    const inserted = [
      ...lines.slice(0, at + 1),
      '| The Ninth Accord | Isar 4th, 4A 7 | 1250314 |',
      ...lines.slice(at + 1),
    ].join('\n');
    const r = fromMarkdown(inserted, page);
    expect(r.plan.added).toHaveLength(1);
    expect(r.plan.added[0]!.kind).toBe('tableRow');
    const table = page[3]!.children as LkBlock[];
    const rowId = table.find((row) => JSON.stringify(row).includes('Treaty of Reeds (2)'))!.id;
    expect(r.plan.added[0]!.afterId).toBe(rowId);
    expect(r.plan.changed).toEqual([]);
    const deleted = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n');
    const d = fromMarkdown(deleted, page);
    expect(d.plan.removed.map((x) => x.id)).toEqual([rowId]);
    expect(d.plan.changed).toEqual([]);
  });

  it('appends to the Notes section', () => {
    const r = applyEdit(page, {
      mode: 'append_to_section',
      section: 'Notes',
      markdown: 'Revised in 4A 1210.',
    });
    expect(r.plan.added.map((a) => [a.parentId, a.index, a.afterId])).toEqual([[null, 8, 'p4age004']]);
  });
});

describe('the Main chronology page', () => {
  const page = mainChronologyPage();
  const md = toMarkdown(page).markdown;

  it('writes document mentions as lk://resources/<id>/docs/<docId>', () => {
    expect(md).toContain(
      '| Fourth Arkonan Age | 1,204 | [Fourth Arkonan Age - Table](lk://resources/h0gczxh7/docs/bt0bm3pc) | [Fourth Arkonan Age - Timeline](lk://resources/h0gczxh7/docs/g2lm1d0v) |',
    );
    expect(fromMarkdown(md, page).plan.empty).toBe(true);
  });

  it('changing an event count changes that cell only, and mentions written by hand become document mentions', () => {
    const r = fromMarkdown(md.replace('| 1,204 |', '| 1,205 |'), page);
    expect(r.plan.changed.map((c) => c.id)).toEqual(['mp3b']);
    const fresh = fromMarkdown('[Fourth - Timeline](lk://resources/h0gczxh7/docs/g2lm1d0v)', []);
    expect(fresh.blocks[0]!.content).toEqual([
      { mention: { resourceId: 'h0gczxh7', documentId: 'g2lm1d0v', text: 'Fourth - Timeline' } },
    ]);
  });
});

describe('a page with an infobox, a collection and an unsupported block', () => {
  const page = richPage();
  const md = toMarkdown(page).markdown;

  it('lists every keep region, and writes back to an empty plan', () => {
    expect(toMarkdown(page).regions.map((r) => [r.id, r.kind])).toEqual([
      ['infobx01', 'infobox'],
      ['coll0001', 'resourceCollection'],
      ['richp002', 'paragraph'],
      ['unsup001', 'unsupported'],
    ]);
    const r = fromMarkdown(md, page);
    expect(r.plan.empty).toBe(true);
    expect(r.blocks).toEqual(page);
  });

  it('refuses a replace that leaves a keep region out, naming it', () => {
    const without = md.replace(/<!-- lk:keep id="infobx01"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    const e = expectCode(() => fromMarkdown(without, page), 'KEEP_REGIONS_MISSING');
    expect(e.details.ids).toEqual(['infobx01']);
    expect(e.message).toContain('infobx01 (infobox)');
    const ok = fromMarkdown(without, page, {}, { dropRegions: ['infobx01'] });
    expect(ok.plan.removed.map((x) => x.id)).toEqual(['infobx01']);
    expect(ok.plan.droppedRegions.map((x) => x.id)).toEqual(['infobx01']);
  });

  it('dropping an unsupported block also needs allowUnsupportedLoss (the existing guard)', () => {
    const without = md.replace(/<!-- lk:keep id="unsup001"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    expectCode(() => fromMarkdown(without, page), 'KEEP_REGIONS_MISSING');
    const e = expectCode(
      () => fromMarkdown(without, page, {}, { dropRegions: ['unsup001'] }),
      'UNSUPPORTED_BLOCK_LOSS',
    );
    expect(e.details.blockIds).toEqual(['unsup001']);
    const ok = fromMarkdown(without, page, {}, { dropRegions: ['unsup001'], allowUnsupportedLoss: true });
    expect(ok.plan.removed.map((x) => x.id)).toEqual(['unsup001']);
  });

  it('ignores edits inside a keep region, with a warning', () => {
    const edited = md.replace('**Lifespan:** 300 years', '**Lifespan:** 900 years');
    const r = fromMarkdown(edited, page);
    expect(r.plan.empty).toBe(true);
    expect(r.warnings.map((w) => [w.code, w.at])).toEqual([['KEEP_REGION_EDITED', 'infobx01']]);
  });

  it('a keep region moved elsewhere moves its block', () => {
    const region = /<!-- lk:keep id="coll0001"[\s\S]*?<!-- \/lk:keep -->\n\n/.exec(md)![0];
    const moved = `${md.replace(region, '')}\n${region}`;
    const r = fromMarkdown(moved, page);
    expect(r.plan.moved.map((m) => m.id)).toContain('coll0001');
    expect(r.plan.changed).toEqual([]);
    expect(r.blocks[r.blocks.length - 1]).toEqual(page.find((b) => b.id === 'coll0001'));
  });

  it('an lk-block with a region’s id replaces that block', () => {
    const infobox = structuredClone(page[1]!);
    ((infobox.rows as LkBlock[])[0]!.rows as Record<string, unknown>[])[1]!.text = '900 years';
    delete ((infobox.rows as LkBlock[])[0]!.rows as Record<string, unknown>[])[1]!.content;
    const block = `\`\`\`lk-block\n${JSON.stringify(infobox, null, 2)}\n\`\`\`\n\n`;
    const replaced = md.replace(/<!-- lk:keep id="infobx01"[\s\S]*?<!-- \/lk:keep -->\n\n/, block);
    const r = fromMarkdown(replaced, page);
    expect(r.plan.changed.map((c) => c.id)).toEqual(['infobx01']);
    expect(r.plan.droppedRegions).toEqual([]);
  });

  it('editing a callout’s text keeps its icon', () => {
    const r = fromMarkdown(
      md.replace('Never enter a shrine after dusk.', 'Never enter a shrine after dark.'),
      page,
    );
    expect(r.plan.changed.map((c) => c.id)).toEqual(['richp004']);
    expect(byId(r.blocks, 'calt0001').icon).toBe('alert-triangle');
  });
});
