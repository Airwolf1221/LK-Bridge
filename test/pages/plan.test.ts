/**
 * write_page's planning (src/pages/plan.ts), pure: every mode, sections at every heading level (first, last, nested),
 * every refusal the converter makes, the empty plan, the baseVersion rules, the counts, twins, and B1's real-page
 * fixtures (the [BSRC] article, the infobox / collection / unsupported page, the Fourth Age table page).
 */
import { describe, expect, it } from 'vitest';
import {
  getSection,
  MarkdownError,
  stubResolver,
  toMarkdown,
  type LkBlock,
} from '../../src/markdown/index.js';
import {
  PageVersionConflictError,
  planPageWrite,
  sha256,
  type CurrentDocument,
  type PageEditInput,
} from '../../src/pages/index.js';
import { bsrcPage, fourthAgeTablePage, richPage } from '../markdown/fixtures.js';

let minted = 0;
const ctx = {
  resolveMention: stubResolver({ 'Asagiri Kaede': 'kaede001', Ashgate: ['ashg0001', 'ashg0002'] }),
  mintBlockId: () => `n${String(minted++).padStart(7, '0')}`,
};
const h = (id: string, level: number, text: string): LkBlock => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const p = (id: string, text: string): LkBlock => ({ id, kind: 'paragraph', content: [{ text }] });

/** Headings at every level: the page title, a first and a last section, and a nested path down to level 6. */
function levels(): LkBlock[] {
  return [
    h('h1title', 1, 'Chronicle'),
    p('pintro', 'Introduction.'),
    h('h2first', 2, 'Prologue'),
    p('pprolog', 'Before the beginning.'),
    h('h2mid', 2, 'Middle'),
    h('h3bat', 3, 'Battles'),
    h('h4sie', 4, 'Siege'),
    p('psiege', 'The siege lasted a winter.'),
    h('h5wal', 5, 'Walls'),
    p('pwalls', 'The walls held.'),
    h('h6gate', 6, 'Gate'),
    p('pgate', 'The gate fell.'),
    h('h4aft', 4, 'Aftermath'),
    p('paft', 'Rebuilding.'),
    h('h2last', 2, 'Epilogue'),
    p('pepil', 'The end.'),
  ];
}
const doc = (blocks: LkBlock[], version = 'v5'): CurrentDocument => ({ version, blocks });
const plan = (blocks: LkBlock[], edit: PageEditInput, o = {}) => planPageWrite(doc(blocks), edit, ctx, o);
const ids = (bs: readonly LkBlock[]) => bs.map((b) => b.id);
const textOf = (b: LkBlock | undefined) =>
  ((b?.content as { text?: string }[]) ?? []).map((r) => r.text ?? '').join('');

describe('modes', () => {
  it('append adds at the end, prepend at the start; every other block is the same object, with its id', () => {
    const base = levels();
    const a = plan(base, { mode: 'append', markdown: 'Appended.' });
    expect(ids(a.blocks).slice(0, base.length)).toEqual(ids(base));
    expect(textOf(a.blocks.at(-1))).toBe('Appended.');
    expect(a.blocks.at(-1)!.id).toMatch(/^n\d{7}$/); // minted: the verify read can compare ids
    expect(a.counts).toEqual({
      kept: 16,
      changed: 0,
      added: 1,
      removed: 0,
      moved: 0,
      regionsKept: 0,
      regionsDropped: 0,
    });
    const pre = plan(base, { mode: 'prepend', markdown: '> A quote.' });
    expect(pre.blocks[0]!.kind).toBe('quote');
    expect(ids(pre.blocks).slice(1)).toEqual(ids(base));
    expect(pre.counts.added).toBe(2); // the quote and its paragraph
  });
  it('replace keeps unchanged blocks and their ids, edits in place, adds and removes', () => {
    const base = levels();
    const md = toMarkdown(base)
      .markdown.replace('The siege lasted a winter.', 'The siege lasted two winters.')
      .replace('Rebuilding.\n\n', '');
    const r = plan(base, { mode: 'replace', markdown: md });
    expect(r.blocks.find((b) => b.id === 'psiege')).toMatchObject({
      content: [{ text: 'The siege lasted two winters.' }],
    });
    expect(ids(r.blocks)).not.toContain('paft');
    expect(r.counts).toMatchObject({ changed: 1, removed: 1, added: 0 });
    expect(r.before).toBe(toMarkdown(base).markdown);
    expect(r.after).toContain('two winters');
  });
  it('replace_section at every heading level, with and without the heading; nothing outside it moves', () => {
    for (const [path, heading, level] of [
      ['Chronicle', 'h1title', 1],
      ['Prologue', 'h2first', 2],
      ['Middle > Battles', 'h3bat', 3],
      ['Battles > Siege', 'h4sie', 4],
      ['Siege > Walls', 'h5wal', 5],
      ['Chronicle > Middle > Battles > Siege > Walls > Gate', 'h6gate', 6],
      ['Epilogue', 'h2last', 2],
    ] as const) {
      const base = levels();
      const start = base.findIndex((b) => b.id === heading);
      const body = plan(base, { mode: 'replace_section', section: path, markdown: 'New body.' });
      // The heading stays; the body is replaced up to the next heading of the same or a higher level.
      expect(body.blocks[start]!.id, path).toBe(heading);
      expect(textOf(body.blocks[start + 1]), path).toBe('New body.');
      const next = base.findIndex(
        (b, i) => i > start && b.kind === 'heading' && (b.level as number) <= level,
      );
      const tail = next < 0 ? [] : ids(base.slice(next));
      expect(ids(body.blocks).slice(body.blocks.length - tail.length), path).toEqual(tail);
      expect(ids(body.blocks).slice(0, start), path).toEqual(ids(base.slice(0, start)));
      expect(body.section?.hash, path).toMatch(/^[0-9a-f]{64}$/);
      // Starting the Markdown with a heading of that level replaces the heading too (and keeps its id: an edit).
      const withHeading = plan(base, {
        mode: 'replace_section',
        section: path,
        markdown: `${'#'.repeat(level)} Renamed\n\nNew body.`,
      });
      expect(withHeading.blocks[start], path).toMatchObject({
        kind: 'heading',
        level,
        content: [{ text: 'Renamed' }],
      });
      expect(ids(withHeading.blocks).slice(withHeading.blocks.length - tail.length), path).toEqual(tail);
      // A section with no sub-headings: the one heading is an edit of the same block, so it keeps its id.
      if (['h2first', 'h6gate', 'h2last'].includes(heading))
        expect(withHeading.blocks[start]!.id, path).toBe(heading);
    }
  });
  it('append_to_section adds at the end of the section, before the next heading of its level or higher', () => {
    const base = levels();
    const r = plan(base, { mode: 'append_to_section', section: 'Siege', markdown: 'Added to the siege.' });
    // Siege (level 4) runs over Walls (5) and Gate (6) to Aftermath (4).
    const at = r.blocks.findIndex((b) => textOf(b) === 'Added to the siege.');
    expect(r.blocks[at + 1]!.id).toBe('h4aft');
    expect(r.blocks[at - 1]!.id).toBe('pgate');
    const first = plan(base, { mode: 'append_to_section', section: 'Prologue', markdown: 'More prologue.' });
    expect(first.blocks[first.blocks.findIndex((b) => textOf(b) === 'More prologue.') + 1]!.id).toBe('h2mid');
    const last = plan(base, { mode: 'append_to_section', section: 'Epilogue', markdown: 'After the end.' });
    expect(textOf(last.blocks.at(-1))).toBe('After the end.');
    expect(last.counts).toMatchObject({ kept: 16, added: 1 });
  });
  it('an edit that changes nothing is an empty plan (and the after Markdown equals the before)', () => {
    const base = levels();
    const same = plan(base, { mode: 'replace', markdown: toMarkdown(base).markdown });
    expect(same.plan.empty).toBe(true);
    expect(same.after).toBe(same.before);
    expect(plan(base, { mode: 'append', markdown: '' }).plan.empty).toBe(true);
    expect(
      plan(base, { mode: 'replace_section', section: 'Prologue', markdown: 'Before the beginning.' }).plan
        .empty,
    ).toBe(true);
  });
});

describe('refusals (B1 errors, typed, with their details)', () => {
  const refuse = (blocks: LkBlock[], edit: PageEditInput): MarkdownError => {
    try {
      plan(blocks, edit);
    } catch (e) {
      if (e instanceof MarkdownError) return e;
      throw e;
    }
    throw new Error('not refused');
  };
  it('missing keep regions, with their ids; dropRegions drops them; unsupported blocks never', () => {
    const rich = richPage();
    const md = toMarkdown(rich).markdown;
    const noInfobox = md.replace(/<!-- lk:keep id="infobx01"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    const e = refuse(rich, { mode: 'replace', markdown: noInfobox });
    expect(e.code).toBe('KEEP_REGIONS_MISSING');
    expect(e.details.ids).toEqual(['infobx01']);
    const dropped = plan(rich, { mode: 'replace', markdown: noInfobox, dropRegions: ['infobx01'] });
    expect(dropped.counts).toMatchObject({ regionsDropped: 1, removed: 1 });
    // The unsupported block: write_page has no allowUnsupportedLoss, so dropping it is always refused.
    const noUnsupported = md.replace(/<!-- lk:keep id="unsup001"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    const u = refuse(rich, { mode: 'replace', markdown: noUnsupported, dropRegions: ['unsup001'] });
    expect(u.code).toBe('UNSUPPORTED_BLOCK_LOSS');
    expect(u.details.blockIds).toEqual(['unsup001']);
  });
  it('mentions: not found, and ambiguous with the candidates', () => {
    expect(refuse(levels(), { mode: 'append', markdown: 'See [[Nobody]].' }).code).toBe('MENTION_NOT_FOUND');
    const amb = refuse(levels(), { mode: 'append', markdown: 'See [[Ashgate]].' });
    expect(amb.code).toBe('MENTION_AMBIGUOUS');
    expect(JSON.stringify(amb.details)).toContain('ashg0002');
    const ok = plan(levels(), { mode: 'append', markdown: 'Sister: [[Asagiri Kaede]].' });
    expect(JSON.stringify(ok.blocks.at(-1))).toContain('"resourceId":"kaede001"');
  });
  it('editor limits and field limits', () => {
    const editor = refuse(levels(), {
      mode: 'append',
      markdown:
        '```lk-block\n{ "kind": "callout", "tone": "info", "color": "#7A3E9D", "children": [{ "kind": "paragraph", "content": [{ "text": "x" }] }] }\n```',
    });
    expect(editor.code).toBe('EDITOR_LIMIT');
    expect(editor.details.rule).toBe('callout.color');
    const field = refuse(levels(), { mode: 'append', markdown: 'x'.repeat(100_001) });
    expect(field.code).toBe('FIELD_LIMIT');
  });
  it('sections: missing (with the headings available) and duplicate (with the options)', () => {
    const nf = refuse(levels(), { mode: 'replace_section', section: 'Nope', markdown: 'x' });
    expect(nf.code).toBe('SECTION_NOT_FOUND');
    expect((nf.details.available as { path: string }[]).map((a) => a.path)).toContain(
      'Chronicle > Middle > Battles',
    );
    const twice = [h('a', 2, 'Notes'), p('a1', 'one'), h('b', 2, 'Notes'), p('b1', 'two')];
    const amb = refuse(twice, { mode: 'append_to_section', section: 'Notes', markdown: 'x' });
    expect(amb.code).toBe('SECTION_AMBIGUOUS');
    expect((amb.details.options as { choose: string }[]).map((o) => o.choose)).toEqual([
      'Notes [1]',
      'Notes [2]',
    ]);
    const second = plan(twice, { mode: 'append_to_section', section: 'Notes [2]', markdown: 'three' });
    expect(textOf(second.blocks.at(-1))).toBe('three');
  });
});

describe('the baseVersion rules', () => {
  const base = levels();
  const md = toMarkdown(base).markdown;
  it('the current version, or none: plan on the current page', () => {
    expect(
      planPageWrite(doc(base, 'v5'), { mode: 'append', markdown: 'x' }, ctx, { baseVersion: 'v5' }).version,
    ).toBe('v5');
  });
  it('an older version in replace, append or prepend: a conflict with the current version', () => {
    for (const mode of ['replace', 'append', 'prepend'] as const) {
      try {
        planPageWrite(doc(base, 'v5'), { mode, markdown: md }, ctx, {
          baseVersion: 'v4',
          markdownAt: () => md,
        });
        throw new Error('not refused');
      } catch (e) {
        expect(e).toBeInstanceOf(PageVersionConflictError);
        expect((e as PageVersionConflictError).toJSON()).toMatchObject({
          code: 'VERSION_CONFLICT',
          reason: 'version_changed',
          sentVersion: 'v4',
          currentVersion: 'v5',
        });
      }
    }
  });
  it('an older version in a section mode: goes ahead when the section is unchanged since then', () => {
    // At v4 the Epilogue was the same; something else on the page changed since.
    const older = toMarkdown([
      ...base.slice(0, 1),
      p('gone', 'An old paragraph.'),
      ...base.slice(1),
    ]).markdown;
    const r = planPageWrite(
      doc(base, 'v5'),
      { mode: 'append_to_section', section: 'Epilogue', markdown: 'More.' },
      ctx,
      {
        baseVersion: 'v4',
        markdownAt: (v) => (v === 'v4' ? older : undefined),
      },
    );
    expect(r.rebasedFrom).toBe('v4');
    expect(r.version).toBe('v5');
    expect(textOf(r.blocks.at(-1))).toBe('More.');
  });
  it('…and refuses when the section changed, or the bridge does not remember the version, with the current section', () => {
    const changed = md.replace('The end.', 'An earlier end.');
    const conflict = (markdownAt: (v: string) => string | undefined) => {
      try {
        planPageWrite(doc(base, 'v5'), { mode: 'replace_section', section: 'Epilogue', markdown: 'x' }, ctx, {
          baseVersion: 'v4',
          markdownAt,
        });
      } catch (e) {
        if (e instanceof PageVersionConflictError) return e.toJSON();
        throw e;
      }
      throw new Error('not refused');
    };
    expect(conflict(() => changed)).toMatchObject({
      reason: 'section_changed',
      currentVersion: 'v5',
      section: 'Chronicle > Epilogue',
      currentSection: '## Epilogue\n\nThe end.\n',
    });
    expect(conflict(() => undefined)).toMatchObject({
      reason: 'base_unknown',
      currentSection: '## Epilogue\n\nThe end.\n',
    });
    expect(conflict(() => '# Chronicle\n\nNo epilogue then.\n')).toMatchObject({
      reason: 'section_missing_at_base',
    });
  });
});

describe('twins: edits next to identical paragraphs land on the right block (B1 hotfix, end to end through the plan)', () => {
  const twins = (): LkBlock[] => [
    h('tw0', 2, 'Litany'),
    p('tw1', 'Praise the dawn.'),
    p('tw2', 'Praise the dawn.'),
    p('tw3', 'Praise the dawn.'),
    h('tw4', 2, 'After'),
    p('tw5', 'Done.'),
  ];
  it('editing the middle twin changes that block only, keeping the others’ ids in their places', () => {
    const md = toMarkdown(twins()).markdown.split('\n');
    const i = md.indexOf('Praise the dawn.', md.indexOf('Praise the dawn.') + 1);
    md[i] = 'Praise the dusk.';
    const r = plan(twins(), { mode: 'replace', markdown: md.join('\n') });
    expect(r.plan.changed.map((c) => c.id)).toEqual(['tw2']);
    expect(r.blocks.map((b) => [b.id, textOf(b)])).toEqual([
      ['tw0', 'Litany'],
      ['tw1', 'Praise the dawn.'],
      ['tw2', 'Praise the dusk.'],
      ['tw3', 'Praise the dawn.'],
      ['tw4', 'After'],
      ['tw5', 'Done.'],
    ]);
  });
  it('a replace_section that adds a fourth twin keeps the three in place and adds a new block at the end', () => {
    const r = plan(twins(), {
      mode: 'replace_section',
      section: 'Litany',
      markdown: 'Praise the dawn.\n\nPraise the dawn.\n\nPraise the dawn.\n\nPraise the dawn.',
    });
    expect(ids(r.blocks).slice(0, 4)).toEqual(['tw0', 'tw1', 'tw2', 'tw3']);
    expect(r.blocks[4]!.id).toMatch(/^n/);
    expect(r.plan.added).toHaveLength(1);
    expect(r.plan.changed).toHaveLength(0);
  });
});

describe('real-page fixtures from B1', () => {
  it('the [BSRC] article: an append_to_section keeps every block, mentions and the image as they were', () => {
    const page = bsrcPage();
    const r = plan(page, {
      mode: 'append_to_section',
      section: 'Biography',
      markdown: 'She became head maiden in 4A 900.',
    });
    expect(r.counts).toMatchObject({ changed: 0, removed: 0, added: 1, moved: 0 });
    const kept = r.blocks.filter((b) => b.id !== r.plan.added[0]!.block.id);
    expect(kept).toEqual(page); // every original block, byte for byte, in order
  });
  it('the infobox / collection / unsupported page: a section replace that leaves out its keep regions is refused', () => {
    // Customs holds an icon paragraph (a keep region) and the unsupported block.
    try {
      plan(richPage(), {
        mode: 'replace_section',
        section: 'Customs',
        markdown: 'Offerings are left at dusk.',
      });
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(MarkdownError);
      expect((e as MarkdownError).code).toBe('KEEP_REGIONS_MISSING');
      expect((e as MarkdownError).details.ids).toEqual(['richp002', 'unsup001']);
    }
  });
  it('the infobox page: a section edit that keeps the regions goes through, and the unsupported block is echoed', () => {
    const page = richPage();
    const section = toMarkdown(page).markdown;
    const customs = section.slice(section.indexOf('## Customs'));
    const edited = customs.replace('Offerings are left at dawn.', 'Offerings are left at dusk.');
    const r = plan(page, { mode: 'replace_section', section: 'Customs', markdown: edited });
    expect(r.counts).toMatchObject({ changed: 1, added: 0, removed: 0, regionsKept: 4 });
    expect(r.blocks.find((b) => b.id === 'unsup001')).toEqual({ id: 'unsup001', kind: 'unsupported' });
    expect(r.blocks.find((b) => b.id === 'infobx01')).toEqual(page.find((b) => b.id === 'infobx01'));
  });
  it('the Fourth Age table page (335 rows): an append_to_section on a later heading leaves the table byte-identical', () => {
    const page = fourthAgeTablePage(335);
    const tableBefore = JSON.stringify(page.find((b) => b.id === 't4age001'));
    const r = plan(page, {
      mode: 'append_to_section',
      section: 'Notes',
      markdown: 'A new note on the disputed dates.',
    });
    expect(JSON.stringify(r.blocks.find((b) => b.id === 't4age001'))).toBe(tableBefore);
    expect(r.counts).toMatchObject({ changed: 0, removed: 0, moved: 0, added: 1 });
    expect(r.counts.kept).toBeGreaterThan(335 * 7);
    expect(r.section?.hash).toBe(sha256(getSection(toMarkdown(page).markdown, 'Notes').markdown));
  });
});
