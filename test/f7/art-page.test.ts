/**
 * v3 F7 (ADR 0070, G5): outfit pieces on an existing Art page, placed when the job runs: under a heading naming the
 * outfit anywhere on the page (Soraya's page nests them under "Approved Rangawan Wardrobe"), else a new heading under
 * the first heading holding "Wardrobe", else a new "Wardrobe" section; and the lines naming a moved piece's old folder.
 */
import { describe, expect, it } from 'vitest';
import { appendImages, updatePathLines } from '../../src/packs/engine/checks.js';
import type { LkBlock } from '../../src/markdown/index.js';

const h = (id: string, level: number, text: string) => ({ id, kind: 'heading', level, content: [{ text }] });
const p = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const img = (id: string) => ({ id, kind: 'image', url: 'https://lk-bridge.invalid/staged/x', alt: 'Front' });
const planned = (outfit: string) => [
  h('n0', 2, outfit),
  h('n1', 3, 'Outfit Reference - Front'),
  img('n2'),
  p('n3', 'The front.'),
];
const fill = (blocks: unknown[], input: Record<string, unknown>) =>
  appendImages({
    projectId: 'p',
    jobId: 'j',
    stepNo: 1,
    input,
    planned: planned(String((input.outfit as { name: string }).name)),
    current: { version: 'v1', blocks },
  });
const shape = (blocks: readonly unknown[]) =>
  (blocks as { kind: string; level?: number; content?: { text?: string }[] }[]).map((b) =>
    b.kind === 'heading' ? `${b.level}:${b.content![0]!.text}` : b.kind,
  );

describe('G5: where outfit pieces go on the Art page', () => {
  const soraya = [
    h('a', 2, 'Purpose'),
    p('b', 'Approved references.'),
    h('c', 2, 'Reference Images'),
    h('d', 3, 'Primary Reference - Portrait'),
    img('e'),
    h('f', 2, 'Approved Rangawan Wardrobe'),
    h('g', 3, 'Jade Moon Kimono'),
    h('i', 4, 'Outfit Reference - View 1'),
    img('j'),
    h('k', 3, 'Moonflower Yukata'),
    img('l'),
    h('m', 2, 'Source Boundaries'),
  ];

  it('an existing heading naming the outfit (nested under “Approved Rangawan Wardrobe”): at the end of its section', () => {
    const r = fill(soraya, { outfit: { name: 'Jade Moon Kimono' }, boundaries: ['Source Boundaries'] });
    expect(shape(r.blocks)).toEqual([
      '2:Purpose',
      'paragraph',
      '2:Reference Images',
      '3:Primary Reference - Portrait',
      'image',
      '2:Approved Rangawan Wardrobe',
      '3:Jade Moon Kimono',
      '4:Outfit Reference - View 1',
      'image',
      '4:Outfit Reference - Front',
      'image',
      'paragraph',
      '3:Moonflower Yukata',
      'image',
      '2:Source Boundaries',
    ]);
  });

  it('an alias names the heading too', () => {
    const r = fill(soraya, { outfit: { name: 'Jade Kimono of the Moon', aliases: ['moonflower  yukata'] } });
    expect(shape(r.blocks).slice(9, 14)).toEqual([
      '3:Moonflower Yukata',
      'image',
      '4:Outfit Reference - Front',
      'image',
      'paragraph',
    ]);
  });

  it('else a new heading at the end of the first heading holding “Wardrobe”', () => {
    const r = fill(soraya, { outfit: { name: 'Harbour Coat' }, boundaries: ['Source Boundaries'] });
    expect(shape(r.blocks).slice(-6)).toEqual([
      'image',
      '3:Harbour Coat',
      '4:Outfit Reference - Front',
      'image',
      'paragraph',
      '2:Source Boundaries',
    ]);
  });

  it('else a new “Wardrobe” section before the boundary sections', () => {
    const page = [
      h('a', 2, 'Purpose'),
      p('b', 'x'),
      h('c', 2, 'Reference Images'),
      img('e'),
      h('m', 2, 'Source Boundaries'),
    ];
    const r = fill(page, { outfit: { name: 'Harbour Coat' }, boundaries: ['Source Boundaries'] });
    expect(shape(r.blocks)).toEqual([
      '2:Purpose',
      'paragraph',
      '2:Reference Images',
      'image',
      '2:Wardrobe',
      '3:Harbour Coat',
      '4:Outfit Reference - Front',
      'image',
      'paragraph',
      '2:Source Boundaries',
    ]);
  });
});

describe('G5: lines naming a moved piece’s old folder', () => {
  const base = 'Characters / Humans / Rangawan / Soraya bint al-Noor';
  const move = {
    fromPath: `${base} / Wardrobe`,
    fromId: 'wardrobe01',
    toPath: `${base} / Wardrobe / Silk Robe`,
    pieces: [{ id: 'asset0001', name: 'Soraya bint al-Noor - Silk Robe - Outfit Reference - Front' }],
  };
  it('a line naming the piece and its old folder’s path is updated; prose about the outfit is not touched', () => {
    const blocks = [
      p('a', `Soraya bint al-Noor - Silk Robe - Outfit Reference - Front: ${base} / Wardrobe.`),
      p('b', 'The Silk Robe is worn at court.'),
      p('c', `Everything else lives in ${base} / Wardrobe.`),
      p('d', `Soraya bint al-Noor - Silk Robe - Outfit Reference - Front sits in folder wardrobe01.`),
    ] as unknown as LkBlock[];
    const r = updatePathLines(blocks, move);
    const text = (i: number) => (r.blocks[i] as unknown as { content: { text: string }[] }).content[0]!.text;
    expect(text(0)).toBe(
      `Soraya bint al-Noor - Silk Robe - Outfit Reference - Front: ${base} / Wardrobe / Silk Robe.`,
    );
    expect(text(1)).toBe('The Silk Robe is worn at court.');
    expect(text(2)).toBe(`Everything else lives in ${base} / Wardrobe.`);
    expect(r.note.updated).toHaveLength(1);
    // By id: it cannot be matched exactly (the new folder's id is made by the job): listed for the owner.
    expect(r.note.forOwner).toEqual([text(3)]);
  });
});
