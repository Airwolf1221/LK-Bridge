/**
 * Identical neighbouring blocks ("twins"): an in-place edit of one twin must change that twin only, and every unchanged
 * twin must keep its own id and attributes, in its own place. Ids and attributes never move between twins.
 *
 * Regression for the property test "editing one paragraph changes that block only", which failed once in CI on an
 * `unsupported` block followed by two empty paragraphs: the exact LCS of align.ts broke ties by skipping base blocks
 * first, so the first draft twin matched the LAST base twin; the first twin's id was then dropped and the edit became a
 * new block (`removed` + `added` instead of one `changed`).
 */
import { describe, expect, it } from 'vitest';
import { lcsPairs, pairGap } from '../../src/markdown/align.js';
import { applyEdit, fromMarkdown, toMarkdown } from '../../src/markdown/index.js';
import type { LkBlock, LkRun } from '../../src/markdown/types.js';
import { allBlocks } from './helpers.js';

const NEW: LkRun[] = [{ text: 'Rewritten by an agent' }];

let seq = 0;
const nextId = () => `t${(seq++).toString(36).padStart(7, '0')}`;
const para = (text: string, attrs: Record<string, unknown> = {}): LkBlock => ({
  id: nextId(),
  kind: 'paragraph',
  content: text === '' ? [] : [{ text }],
  ...attrs,
});
const unsupported = (): LkBlock => ({ id: nextId(), kind: 'unsupported' });
const infobox = (): LkBlock => ({
  id: nextId(),
  kind: 'infobox',
  layout: 'wrapRight',
  width: 40,
  rows: [{ id: 'prop1', kind: 'keyValue', title: 'Facts', rows: [{ key: 'Race', text: 'Foxian' }] }],
});
const heading = (text: string): LkBlock => ({ id: nextId(), kind: 'heading', level: 2, content: [{ text }] });
const item = (text: string): LkBlock => ({ id: nextId(), kind: 'listItem', children: [para(text)] });
const list = (...texts: string[]): LkBlock => ({
  id: nextId(),
  kind: 'bulletList',
  children: texts.map(item),
});
const row = (...texts: string[]): LkBlock => ({
  id: nextId(),
  kind: 'tableRow',
  children: texts.map((t) => ({ id: nextId(), kind: 'tableCell', children: [para(t)] })),
});
const table = (...rows: string[][]): LkBlock => ({
  id: nextId(),
  kind: 'table',
  children: rows.map((r, i) => {
    const out = row(...r);
    if (i === 0) for (const c of out.children as LkBlock[]) c.header = true;
    return out;
  }),
});
const quote = (...children: LkBlock[]): LkBlock => ({ id: nextId(), kind: 'quote', children });
const callout = (...children: LkBlock[]): LkBlock => ({
  id: nextId(),
  kind: 'callout',
  tone: 'info',
  children,
});

type Change = (b: LkBlock) => LkBlock;
const rewrite: Change = (b) => ({ ...b, content: NEW });

/** The page with the blocks of `ids` changed in place (as an agent edits them in the Markdown). */
function editInPlace(
  blocks: readonly LkBlock[],
  ids: ReadonlySet<string>,
  change: Change = rewrite,
): LkBlock[] {
  const walk = (b: LkBlock): LkBlock => {
    let out = b;
    if (ids.has(b.id!)) out = change(b);
    if (Array.isArray(b.children)) out = { ...out, children: (b.children as LkBlock[]).map(walk) };
    return out;
  };
  return blocks.map(walk);
}

/** Every block not on the path to an edited block is in the result unchanged (id and every attribute), in its own place. */
function expectUntouchedSame(
  base: readonly LkBlock[],
  res: readonly LkBlock[],
  ids: ReadonlySet<string>,
): void {
  const touched = (b: LkBlock): boolean =>
    ids.has(b.id!) || (Array.isArray(b.children) && (b.children as LkBlock[]).some(touched));
  const walk = (a: readonly LkBlock[], r: readonly LkBlock[]) => {
    expect(r).toHaveLength(a.length);
    a.forEach((x, i) => {
      if (!touched(x)) {
        expect(r[i]).toEqual(x);
        return;
      }
      expect(r[i]!.id).toBe(x.id);
      if (Array.isArray(x.children)) walk(x.children as LkBlock[], r[i]!.children as LkBlock[]);
    });
  };
  walk(base, res);
}

/** Converts the Markdown of the edited page against `base`; the result must be exactly the edited page. */
function checkEdit(base: readonly LkBlock[], ids: readonly string[], change: Change = rewrite): void {
  const set = new Set(ids);
  const edited = editInPlace(base, set, change);
  const md = toMarkdown(edited).markdown;
  const res = fromMarkdown(md, base);
  const really = ids.filter((id) => {
    const b = allBlocks([...base]).find((x) => x.id === id)!;
    return JSON.stringify(b) !== JSON.stringify(change(b));
  });
  expect(res.blocks).toEqual(edited);
  expect(res.plan.added).toEqual([]);
  expect(res.plan.removed).toEqual([]);
  expect(res.plan.moved).toEqual([]);
  expect(res.plan.changed.map((c) => c.id).sort()).toEqual([...really].sort());
  expectUntouchedSame(base, res.blocks, set);
  // And the untouched page converts back to itself.
  const same = fromMarkdown(toMarkdown(base).markdown, base);
  expect(same.plan.empty).toBe(true);
  expect(same.blocks).toEqual(base);
}

/** Each single edit, and each pair of edits, of the twins in `twins` (ids). */
function checkAllEdits(base: readonly LkBlock[], twins: readonly string[], change: Change = rewrite): void {
  for (const a of twins) checkEdit(base, [a], change);
  for (let i = 0; i < twins.length; i++)
    for (let k = i + 1; k < twins.length; k++) checkEdit(base, [twins[i]!, twins[k]!], change);
}

describe('identical neighbouring blocks', () => {
  it('the CI counterexample: an unsupported block, then two empty paragraphs (either one edited)', () => {
    const base = [
      { id: 'b0000000', kind: 'unsupported' },
      { id: 'b0000001', kind: 'paragraph', content: [] },
      { id: 'b0000002', kind: 'paragraph', content: [] },
    ] as LkBlock[];
    checkEdit(base, ['b0000002']);
    checkEdit(base, ['b0000001']);
    const res = fromMarkdown(toMarkdown(editInPlace(base, new Set(['b0000002']))).markdown, base);
    expect(res.plan.changed.map((c) => c.id)).toEqual(['b0000002']);
    expect(res.blocks[1]).toEqual(base[1]);
  });

  const neighbours: [string, () => LkBlock[]][] = [
    ['nothing', () => []],
    ['an unsupported block', () => [unsupported()]],
    ['an infobox (keep region)', () => [infobox()]],
    ['a heading', () => [heading('Notes')]],
    ['a list', () => [list('a', 'b')]],
    ['a table', () => [table(['h1', 'h2'], ['c', 'd'])]],
    ['a paragraph', () => [para('other')]],
  ];
  for (const text of ['', 'same text']) {
    for (const count of [2, 3, 4]) {
      for (const [beforeName, before] of neighbours) {
        for (const [afterName, after] of neighbours) {
          it(`${count} ${text === '' ? 'empty' : 'identical'} paragraphs after ${beforeName}, before ${afterName}`, () => {
            const twins = Array.from({ length: count }, () => para(text));
            const base = [...before(), ...twins, ...after()];
            checkAllEdits(
              base,
              twins.map((t) => t.id!),
            );
          });
        }
      }
    }
  }

  it('twins on both sides of a keep region, and between two keep regions', () => {
    const a = [para(''), para('')];
    const b = [para(''), para('')];
    const base = [unsupported(), ...a, infobox(), ...b, unsupported()];
    checkAllEdits(
      base,
      [...a, ...b].map((x) => x.id!),
    );
  });

  it('twins whose hidden attributes differ keep their own attributes', () => {
    // Markdown shows an image's url and alt only, so these look identical; width and layout must not swap.
    const img = (attrs: Record<string, unknown>): LkBlock => ({
      id: nextId(),
      kind: 'image',
      url: 'https://assets.example/a.webp',
      title: 'Image',
      isTitleHidden: true,
      ...attrs,
    });
    const x = img({ width: 25, layout: 'wrapLeft' });
    const y = img({ width: 75 });
    const z = img({});
    const recaption: Change = (b) => ({ ...b, alt: 'A new caption' });
    checkAllEdits([unsupported(), x, y, z], [x.id!, y.id!, z.id!], recaption);
    checkAllEdits([x, y, z, infobox()], [x.id!, y.id!, z.id!], recaption);
    // Unchanged: each keeps its own attributes in its own place.
    checkEdit([unsupported(), x, y, z], []);
  });

  for (const [name, wrap] of [
    ['a quote', quote],
    ['a callout', callout],
  ] as const) {
    it(`twins at the start and at the end of ${name}`, () => {
      const s = [para(''), para('')];
      const e = [para('same'), para('same')];
      const base = [wrap(...s, para('middle'), ...e)];
      checkAllEdits(
        base,
        [...s, ...e].map((x) => x.id!),
      );
    });
    it(`twins after a keep region inside ${name}`, () => {
      const t = [para(''), para(''), para('')];
      const base = [para(''), wrap(unsupported(), ...t), para('')];
      checkAllEdits(
        base,
        t.map((x) => x.id!),
      );
    });
  }

  it('identical list items: editing one item changes that item only', () => {
    const l = list('same', 'same', 'same');
    const paras = (l.children as LkBlock[]).map((i) => (i.children as LkBlock[])[0]!.id!);
    checkAllEdits([unsupported(), l], paras);
    const e = list('', '', '');
    checkAllEdits(
      [e, unsupported()],
      (e.children as LkBlock[]).map((i) => (i.children as LkBlock[])[0]!.id!),
    );
  });

  it('identical table rows: editing a cell of one row changes that cell only', () => {
    const t = table(['h', 'h'], ['x', 'y'], ['x', 'y'], ['x', 'y']);
    const firstCells = (t.children as LkBlock[])
      .slice(1)
      .map((r) => ((r.children as LkBlock[])[0]!.children as LkBlock[])[0]!.id!);
    checkAllEdits([unsupported(), t, para('')], firstCells);
  });

  it('identical lists and tables next to each other keep their own ids', () => {
    const l1 = list('a');
    const l2 = list('a');
    const t1 = table(['h'], ['c']);
    const t2 = table(['h'], ['c']);
    const base = [unsupported(), l1, l2, para(''), t1, t2];
    const deep = (b: LkBlock) => allBlocks([b]).find((x) => x.kind === 'paragraph')!.id!;
    checkAllEdits(base, [deep(l1), deep(l2), deep(t1), deep(t2)]);
  });

  it('applyEdit replace_section with twins after a keep region', () => {
    const base = [heading('Notes'), unsupported(), para(''), para(''), heading('Next'), para('')];
    const r = applyEdit(base, {
      mode: 'replace_section',
      section: 'Notes',
      markdown: toMarkdown([base[0]!, base[1]!, base[2]!, { ...base[3]!, content: NEW }]).markdown,
    });
    expect(r.plan.changed.map((c) => c.id)).toEqual([base[3]!.id]);
    expect(r.plan.added).toEqual([]);
    expect(r.plan.removed).toEqual([]);
    expect(r.blocks[2]).toEqual(base[2]);
  });
});

describe('alignment ties are broken by position', () => {
  it('lcsPairs matches twins in place when several longest subsequences exist', () => {
    // Unique items (fresh ids) first, then twins: each twin must match the one at its own offset.
    expect(lcsPairs([-1, 5, 5], [-2, 5, 9])).toEqual([[1, 1]]);
    expect(lcsPairs([-1, 5, 5], [-2, 9, 5])).toEqual([[2, 2]]);
    expect(lcsPairs([-1, 5, 5, 5], [-2, 5, 9, 5])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(lcsPairs([-1, 5, 5, 5], [-2, 9, 5, 5])).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(lcsPairs([-1, 5, 5, -3], [-2, 5, 9, -4])).toEqual([[1, 1]]);
  });
  it('lcsPairs is deterministic and still a longest common subsequence', () => {
    const a = [-1, 7, 7, 7, 3, 7, 7];
    const b = [-2, 7, 4, 7, 3, 7, 8];
    expect(lcsPairs(a, b)).toEqual(lcsPairs(a, b));
    expect(lcsPairs(a, b)).toEqual([
      [1, 1],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
  });
  it('pairGap pairs twins in place when they score the same', () => {
    const tw = { kind: 'paragraph', text: 'same text here', pairable: true };
    const ed = { kind: 'paragraph', text: 'same text there', pairable: true };
    expect(pairGap([tw, tw], [ed, ed])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(pairGap([tw, tw, tw], [{ kind: 'heading', text: 'x', pairable: true }, ed, ed])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(pairGap([{ kind: 'heading', text: 'x', pairable: true }, tw, tw], [ed, ed])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });
});
