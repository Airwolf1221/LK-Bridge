/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * v3 F7b (ADR 0071): `arkona_get_art` against the mock LegendKeeper. Selectors (asset by id and both URL forms,
 * character, outfit by name and alias, a near miss refused, design pieces only, page in document order across several
 * documents); authority (the Art page's label and text, several pages with Authoritative first, none with the warning,
 * the 1,200-character trim); delivery (links only: no download and no budget; inline: image blocks in order; a failed
 * download keeps the link; the result cap); the cache (a hit costs nothing; a changed URL is fetched again); paging.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ART_VIEW_LIMITS, HOW_TO_VIEW } from '../../src/art/view/get-art.js';
import { NO_AUTHORITY_WARNING } from '../../src/art/view/authority.js';
import {
  ALIAS,
  artWorld,
  C,
  CHARACTER,
  DESIGN_LABEL,
  DESIGN_TEXT,
  noise,
  OUTFIT,
  PROJECT,
  type ArtWorld,
} from './world.js';

let w: ArtWorld;
const LONG = `${'The robe is ivory silk. '.repeat(100)}`.trim();
let loose: { id: string; url: string };
let newForm: { id: string; url: string };
let oldForm: { id: string; url: string };
let alternates: string;

const mainBlocks = (pageId: string) => {
  const doc = w.repo.liveDocs(w.repo.res.get(pageId)!).find((d) => d.name === 'Main')!;
  if (!w.repo.blocks.get(doc.id)) w.repo.blocks.set(doc.id, { version: 1, blocks: [] });
  return w.repo.blocks.get(doc.id)!.blocks as Record<string, unknown>[];
};
const urlOf = (id: string) => w.assets.assets.get(id)!.url!;

beforeAll(async () => {
  w = await artWorld();
  // The design piece also embedded on Nadira's Core (Authoritative) and on a Working page; the robe's front on the
  // Working page with a long text.
  mainBlocks(C.nadira).push(
    { id: 'f7bcor01', kind: 'image', url: urlOf(w.ids.design), alt: 'Portrait (Core)' },
    { id: 'f7bcor02', kind: 'paragraph', content: [{ text: 'On her Core: the portrait as she is now.' }] },
  );
  mainBlocks(C.draft).push(
    { id: 'f7bdra01', kind: 'heading', level: 2, content: [{ text: 'Draft images' }] },
    { id: 'f7bdra02', kind: 'image', url: urlOf(w.ids.design) },
    { id: 'f7bdra03', kind: 'paragraph', content: [{ text: 'A draft note on the portrait.' }] },
    { id: 'f7bdra04', kind: 'image', url: urlOf(w.ids.robeFront), alt: 'Robe (draft)' },
    { id: 'f7bdra05', kind: 'paragraph', content: [{ text: LONG }] },
  );
  // Images the asset tree does not hold yet: in the library's root, in both URL forms.
  const bytes = await noise(64, 48, 21);
  loose = w.addImage('Loose Sketch', null, bytes, `f7b-loose-${randomUUID()}`);
  newForm = w.addImage(
    'New Form',
    null,
    await noise(32, 32, 22),
    `cmretrj150aph43prgyxsdbsn_${randomUUID()}`,
  );
  oldForm = w.addImage('Old Form', null, await noise(32, 32, 23), randomUUID());
  // A second page document on the Art page, holding two images.
  const art = w.artPageId();
  const doc = w.repo.outside.addDocument(art, 'Alternates', 'page');
  alternates = doc.id;
  w.repo.blocks.set(doc.id, {
    version: 1,
    blocks: [
      { id: 'f7balt01', kind: 'image', url: urlOf(w.ids.robeBack), alt: 'Back again' },
      { id: 'f7balt02', kind: 'paragraph', content: [{ text: 'The back, in the alternates.' }] },
      { id: 'f7balt03', kind: 'image', url: urlOf(w.ids.design) },
    ],
  });
  await w.stack.runtime.tree.sweep(PROJECT, 'manual');
  await w.stack.runtime.tree.whenIdle();
  await w.snapshot();
}, 180_000);
afterAll(async () => w?.close());

describe('D1: the selectors', () => {
  it('needs exactly one selector, and outfit and design go with character', async () => {
    for (const args of [{}, { character: CHARACTER, page: 'x' }, { asset: ['a'], character: CHARACTER }]) {
      const r = await w.getArt(args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe('SELECTOR_REQUIRED');
    }
    expect((await w.getArt({ asset: [w.ids.design], outfit: OUTFIT })).body.error.code).toBe('INVALID_INPUT');
    expect((await w.getArt({ character: CHARACTER, outfit: OUTFIT, design: true })).body.error.code).toBe(
      'INVALID_INPUT',
    );
  });

  it('by asset: an id from the asset tree, and file URLs in both forms (checked against a live listing)', async () => {
    const r = await w.getArt({ asset: [w.ids.design, newForm.url, oldForm.url], delivery: 'link' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.images.map((i: any) => [i.assetId, i.name, i.url])).toEqual([
      [w.ids.design, `${CHARACTER} - ${DESIGN_LABEL}`, urlOf(w.ids.design)],
      [newForm.id, 'New Form', newForm.url],
      [oldForm.id, 'Old Form', oldForm.url],
    ]);
    expect(r.body.images[0].folder).toMatch(/Nadira al-Khalid$/);
    expect(r.body.images[0]).toMatchObject({ format: 'webp', width: expect.any(Number) });
    // The URLs the tree lacked were found by one live listing (G11), so the call made reads.
    expect(r.body.reads.live).toBeGreaterThan(0);
  });

  it('by asset: a URL that is no asset of the project, and one off the asset hosts, are listed, not fatal', async () => {
    const r = await w.getArt({
      asset: [
        `https://assets.test:${w.port}/a/${randomUUID()}.webp`,
        'https://example.org/x.webp',
        w.ids.design,
      ],
      delivery: 'link',
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.notFound.map((n: any) => n.code)).toEqual(['NOT_ASSET_URL', 'ASSET_NOT_FOUND']);
    expect(r.body.images).toHaveLength(1);
  });

  it('by character: every piece, design first, its folders read live', async () => {
    const r = await w.getArt({ character: CHARACTER, delivery: 'link' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.character.foldersReadLive).toBeGreaterThan(0);
    expect(r.body.images.map((i: any) => i.assetId)).toEqual([w.ids.design, w.ids.robeBack, w.ids.robeFront]);
    expect(r.body.images.map((i: any) => i.group)).toEqual(['design', OUTFIT, OUTFIT]);
  });

  it('by character + outfit: by name, by alias (case ignored); a near miss refused; an unknown outfit listed', async () => {
    const byName = await w.getArt({ character: CHARACTER, outfit: OUTFIT, delivery: 'link' });
    expect(byName.body.images.map((i: any) => i.assetId).sort()).toEqual(
      [w.ids.robeBack, w.ids.robeFront].sort(),
    );
    expect(byName.body.outfit).toMatchObject({ name: OUTFIT, known: 'record' });
    const byAlias = await w.getArt({ character: CHARACTER, outfit: ALIAS.toUpperCase(), delivery: 'link' });
    expect(byAlias.body.outfit).toMatchObject({ name: OUTFIT, matchedAlias: ALIAS });
    expect(byAlias.body.images).toHaveLength(2);
    const near = await w.getArt({ character: CHARACTER, outfit: 'Silk Robes', delivery: 'link' });
    expect(near.isError).toBe(true);
    expect(near.body.error.code).toBe('OUTFIT_NEAR_MATCH');
    expect(near.body.error.candidates[0]).toMatchObject({ name: OUTFIT });
    const none = await w.getArt({ character: CHARACTER, outfit: 'Battle Armour', delivery: 'link' });
    expect(none.body.error.code).toBe('OUTFIT_NOT_FOUND');
    expect(none.body.error.outfits.map((o: any) => o.name)).toContain(OUTFIT);
  });

  it('design: true: only the pieces in the character’s own folder', async () => {
    const r = await w.getArt({ character: CHARACTER, design: true, delivery: 'link' });
    expect(r.body.images.map((i: any) => i.assetId)).toEqual([w.ids.design]);
  });

  it('by page: every image block in document order, across its page documents, read live; or one document', async () => {
    const r = await w.getArt({ page: w.artPageId(), delivery: 'link' });
    expect(r.isError, r.text).toBe(false);
    const main = mainBlocks(w.artPageId())
      .filter((b) => b.kind === 'image')
      .map((b) => b.url);
    const expected = [...main, urlOf(w.ids.robeBack), urlOf(w.ids.design)];
    expect(r.body.images.slice(0, 6).map((i: any) => i.url)).toEqual(expected.slice(0, 6));
    expect(r.body.total).toBe(expected.length);
    expect(r.body.page.documents.map((d: any) => d.name)).toEqual(['Main', 'Alternates']);
    const one = await w.getArt({ page: w.artPageId(), document: 'Alternates', delivery: 'link' });
    expect(one.body.images.map((i: any) => [i.assetId, i.block.documentId, i.block.alt])).toEqual([
      [w.ids.robeBack, alternates, 'Back again'],
      [w.ids.design, alternates, null],
    ]);
    // The page read live stands in for its snapshot: its Alternates embedding is found, marked live.
    const back = one.body.images[0].authority.pages.find((p: any) => p.document.id === alternates);
    expect(back).toMatchObject({ from: 'live', text: 'The back, in the alternates.', label: 'Back again' });
  });

  it('pages: at most 6 a call, limit fewer; nextCursor continues; another selection’s cursor is refused', async () => {
    const first = await w.getArt({ character: CHARACTER, delivery: 'link', limit: 2 });
    expect(first.body.images).toHaveLength(2);
    expect(first.body.total).toBe(3);
    const next = await w.getArt({
      character: CHARACTER,
      delivery: 'link',
      limit: 2,
      cursor: first.body.nextCursor,
    });
    expect(next.body.images.map((i: any) => i.n)).toEqual([3]);
    expect(next.body.nextCursor).toBeUndefined();
    const wrong = await w.getArt({ character: CHARACTER, design: true, cursor: first.body.nextCursor });
    expect(wrong.body.error.code).toBe('CURSOR_INVALID');
  });
});

describe('D2: the written authority', () => {
  it('embedded on the Art page: the label (alt text), the section and the text under it', async () => {
    const r = await w.getArt({ asset: [w.ids.design], delivery: 'link' });
    const pages = r.body.images[0].authority.pages;
    expect(r.body.images[0].authority.status).toBe('found');
    expect(pages[0]).toMatchObject({
      page: { name: `[BSRC] ${CHARACTER} - Character Art` },
      document: { name: 'Main' },
      section: `Reference Images > ${DESIGN_LABEL}`,
      lifecycle: 'Authoritative',
      ownerPage: true,
      label: DESIGN_LABEL,
      text: DESIGN_TEXT,
      from: 'snapshot',
    });
  });

  it('embedded on several pages: all listed, Authoritative first (the Art page before the Core), Working after', async () => {
    const r = await w.getArt({ asset: [w.ids.design], delivery: 'link' });
    const pages = r.body.images[0].authority.pages.filter((p: any) => p.document.name === 'Main');
    expect(pages.map((p: any) => [p.lifecycle, p.ownerPage, p.page.id])).toEqual([
      ['Authoritative', true, w.artPageId()],
      ['Authoritative', false, C.nadira],
      ['Working', false, C.draft],
    ]);
    expect(pages[1]).toMatchObject({
      label: 'Portrait (Core)',
      text: 'On her Core: the portrait as she is now.',
    });
    expect(pages[2]).toMatchObject({
      section: 'Draft images',
      label: null,
      text: 'A draft note on the portrait.',
    });
  });

  it('the text under an image is trimmed to 1,200 characters with truncated: true', async () => {
    const r = await w.getArt({ asset: [w.ids.robeFront], delivery: 'link' });
    const draft = r.body.images[0].authority.pages.find((p: any) => p.page.id === C.draft);
    expect(draft.truncated).toBe(true);
    expect(draft.text).toHaveLength(1200);
    expect(LONG.startsWith(draft.text.slice(0, -1))).toBe(true);
    expect(r.body.images[0].authority.pages[0]).toMatchObject({
      lifecycle: 'Authoritative',
      ownerPage: true,
    });
  });

  it('embedded nowhere: status none, with the warning', async () => {
    const r = await w.getArt({ asset: [loose.url], delivery: 'link' });
    expect(r.body.images[0].authority).toEqual({ status: 'none', warning: NO_AUTHORITY_WARNING, pages: [] });
    expect(NO_AUTHORITY_WARNING).toBe('No owner page embeds this image; it establishes nothing about canon');
  });
});

describe('D3, D4, D6: delivery, cost and the cache', () => {
  it('links only: no download, no budget, no image block; every image has its url, and howToView', async () => {
    const reads = w.readsUsed();
    const gets = w.downloads();
    const r = await w.getArt({ asset: [w.ids.design, w.ids.robeBack], delivery: 'link' });
    expect(w.downloads()).toBe(gets);
    expect(w.readsUsed()).toBe(reads);
    expect(r.images).toHaveLength(0);
    expect(r.body.howToView).toBe(HOW_TO_VIEW);
    expect(r.body.reads).toEqual({ live: 0, downloads: 0, cacheHits: 0 });
    for (const i of r.body.images) {
      expect(i.url).toMatch(/^https:\/\/assets\.test:\d+\/a\/.+\.webp$/);
      expect(i.inline).toBeUndefined();
    }
    expect(r.body.cost).toBe('Cost: none for links; 1 read per image downloaded for inline (cached).');
  });

  it('inline: one image block per image after the JSON, in order; a download costs one read; a second look is free', async () => {
    const a = w.addImage('Inline One', null, await noise(300, 200, 31), `f7b-in1-${randomUUID()}`);
    const b = w.addImage('Inline Two', null, await noise(200, 300, 32), `f7b-in2-${randomUUID()}`);
    // Into the asset tree first (so the call itself makes no listing read).
    await w.syncTree();
    const reads = w.readsUsed();
    const gets = w.downloads();
    const r = await w.getArt({ asset: [a.id, b.id], delivery: 'inline' });
    expect(r.isError, r.text).toBe(false);
    expect(w.downloads() - gets).toBe(2);
    expect(w.readsUsed() - reads).toBe(2);
    expect(r.images).toHaveLength(2);
    expect(r.body.images.map((i: any) => i.inline.content)).toEqual([1, 2]);
    expect(r.body.images[0].inline).toMatchObject({ ok: true, width: 300, height: 200, cached: false });
    expect(r.body.images[1].inline).toMatchObject({ ok: true, width: 200, height: 300, cached: false });
    expect(r.images[0]!.mimeType).toBe(`image/${r.body.images[0].inline.format}`);
    expect(Buffer.from(r.images[0]!.data, 'base64').length).toBe(r.body.images[0].inline.bytes);
    // Every image delivered inline: no link advice needed.
    expect(r.body.howToView).toBeUndefined();
    // The cache: no download, no budget.
    const reads2 = w.readsUsed();
    const gets2 = w.downloads();
    const again = await w.getArt({ asset: [a.id, b.id], delivery: 'both' });
    expect(w.downloads()).toBe(gets2);
    expect(w.readsUsed()).toBe(reads2);
    expect(again.body.images.map((i: any) => i.inline.cached)).toEqual([true, true]);
    expect(again.body.reads).toMatchObject({ downloads: 0, cacheHits: 2 });
    expect(again.images.map((i) => i.data)).toEqual(r.images.map((i) => i.data));
    expect(again.body.howToView).toBe(HOW_TO_VIEW);
  });

  it('a changed URL is fetched again', async () => {
    const a = w.addImage('Changing', null, await noise(120, 120, 41), `f7b-ch-${randomUUID()}`);
    await w.syncTree();
    await w.getArt({ asset: [a.url], delivery: 'inline' });
    const stem = `f7b-ch2-${randomUUID()}`;
    w.served.set(stem, await noise(90, 60, 42));
    w.assets.assets.get(a.id)!.url = `https://assets.test:${w.port}/a/${stem}.webp`;
    await w.stack.runtime.assets.refreshFolder(PROJECT, null, { depth: 1 });
    const gets = w.downloads();
    const r = await w.getArt({ asset: [a.id], delivery: 'inline' });
    expect(w.downloads() - gets).toBe(1);
    expect(r.body.images[0].url).toContain(stem);
    expect(r.body.images[0].inline).toMatchObject({ ok: true, cached: false, width: 90, height: 60 });
  });

  it('a download that fails keeps the image’s link and authority, and never fails the call', async () => {
    const stem = `f7b-fail-${randomUUID()}`;
    const a = w.addImage('Failing', null, await noise(50, 50, 51), stem);
    w.failDownload.set(stem, 404);
    await w.syncTree();
    const r = await w.getArt({ asset: [a.url, w.ids.design], delivery: 'inline' });
    expect(r.isError, r.text.slice(0, 2000)).toBe(false);
    expect(r.body.images[0].inline.ok).toBe(false);
    expect(r.body.images[0].inline.reason).toMatch(/404/);
    expect(r.body.images[0].url).toBe(a.url);
    expect(r.body.images[0].authority.status).toBe('none');
    expect(r.body.images[1].inline.ok).toBe(true);
    expect(r.images).toHaveLength(1);
    expect(r.body.howToView).toBe(HOW_TO_VIEW);
  });

  it('the result’s image data is capped: images past it come as links, inlineSkipped "result size"', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push(w.addImage(`Cap ${i}`, null, await noise(200, 200, 60 + i), `f7b-cap-${i}-${randomUUID()}`));
    await w.syncTree();
    const first = await w.getArt({ asset: ids.map((x) => x.url), delivery: 'inline' });
    const sizes = first.body.images.map((i: any) => i.inline.bytes as number);
    const saved = ART_VIEW_LIMITS.resultImageCap;
    ART_VIEW_LIMITS.resultImageCap = sizes[0] + sizes[1];
    try {
      const r = await w.getArt({ asset: ids.map((x) => x.id), delivery: 'both' });
      expect(r.images).toHaveLength(2);
      expect(r.body.images[2].inlineSkipped).toBe('result size');
      expect(r.body.images[2].inline).toBeUndefined();
      expect(r.body.images[2].url).toBe(ids[2]!.url);
      expect(r.body.howToView).toBe(HOW_TO_VIEW);
    } finally {
      ART_VIEW_LIMITS.resultImageCap = saved;
    }
  });
});
