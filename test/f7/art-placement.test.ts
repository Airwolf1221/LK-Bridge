/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F7 (ADR 0070; design G1 to G6, G9): guided character art against the mock LegendKeeper. One call, one target:
 * design pieces in the character's own folder; an outfit's only piece loose in Wardrobe; a second piece makes
 * Wardrobe/<Outfit> and moves the loose one in, in the same job; a batch of five goes straight into a new folder; an
 * outfit with its folder takes more there; a near match is refused unless newOutfit; an alias matches; and nothing an
 * agent passes makes a Forms, Outfits or Details folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve } from '../packs/world.js';
import { ownersWorld, PROJECT, type OwnersWorld } from '../packs/owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const FILES = ['alpha.png', 'orientation-6.jpg', 'already.webp', 'png-named.jpg', 'animated.gif'];
let nth = 0;
/** A distinct image each time (the fixtures, re-encoded with a different size so none is deduplicated). */
const stage = async () => {
  const file = FILES[nth % FILES.length]!;
  const r = await w.call('upload_image', {
    data_base64: fixture(file).toString('base64'),
    name: `f7 stage ${nth}`,
    stage: true,
    deduplicate: false,
    operation_id: `f7-stage-${nth++}`,
    project: 'test',
  });
  expect(r.isError, r.text).toBe(false);
  return String(r.body.staged_id);
};
const art = async (args: Record<string, unknown>) => {
  const p = await w.call('arkona_add_character_art', {
    character: 'Nadira al-Khalid',
    project: 'test',
    ...args,
  });
  return p;
};
const img = (id: string, label: string) => ({
  staged_id: id,
  label,
  interpretation: `What ${label} establishes.`,
});
const run = async (args: Record<string, unknown>) => {
  const p = await art(args);
  expect(p.body.status, p.text).toBe('proposal_captured');
  const done = await approve(w, String(p.body.proposalId));
  expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
  expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(true);
  return { p, done };
};
const folderNamed = (name: string) => w.assets.byName(name).filter((a) => a.type === 'FOLDER');
const charFolder = () => folderNamed('Nadira al-Khalid')[0]!;
const wardrobe = () => w.assets.byName('Wardrobe', charFolder().id)[0];
const outfitsOf = () => w.stack.runtime.outfits.forCharacter(PROJECT, charFolder().id);
const artPage = () =>
  [...w.repo.res.values()].find(
    (r) => r.deletedAt === null && r.name === '[BSRC] Nadira al-Khalid - Character Art',
  );
const pageBlocks = () => {
  const main = w.repo.liveDocs(w.repo.res.get(artPage()!.id)!).find((d) => d.name === 'Main')!;
  return w.repo.blocks.get(main.id)!.blocks as {
    kind: string;
    level?: number;
    content?: { text?: string }[];
    alt?: string;
  }[];
};
const headings = () =>
  pageBlocks()
    .filter((b) => b.kind === 'heading')
    .map((b) => `${b.level}:${(b.content ?? []).map((r) => r.text ?? '').join('')}`);

describe('G1/G2: one call, one target, the bridge decides the folder', () => {
  it('design pieces go in the character’s own folder', async () => {
    const id = await stage();
    const { p } = await run({ images: [img(id, 'Primary Reference - Character Portrait')] });
    const folder = charFolder();
    const a = w.assets.byName('Nadira al-Khalid - Primary Reference - Character Portrait')[0]!;
    expect(a.folderId).toBe(folder.id);
    expect(p.body.placement ?? p.body.extra?.placement ?? {}).toBeDefined();
    expect(headings()).toContain('2:Reference Images');
  });

  it('an outfit’s only piece goes loose in Wardrobe (made on first use), named <Character> - <Outfit> - <Label>', async () => {
    const id = await stage();
    await run({ outfit: 'Silk Robe', images: [img(id, 'Outfit Reference - Front')] });
    const a = w.assets.byName('Nadira al-Khalid - Silk Robe - Outfit Reference - Front')[0]!;
    expect(a.folderId).toBe(wardrobe()!.id);
    const rec = outfitsOf().find((o) => o.name === 'Silk Robe')!;
    expect(rec).toMatchObject({ folderId: null });
    expect(rec.pieces.map((x) => x.assetId)).toEqual([a.id]);
    // G5: the page had no heading holding "Wardrobe": a new Wardrobe section with the outfit's heading.
    expect(headings()).toEqual(
      expect.arrayContaining(['2:Wardrobe', '3:Silk Robe', '4:Outfit Reference - Front']),
    );
  });

  it('a second piece makes Wardrobe/<Outfit> and moves the loose piece into it, in the same job', async () => {
    const id = await stage();
    const dry = await art({
      outfit: 'silk  robe',
      images: [img(id, 'Outfit Reference - Back')],
      dryRun: true,
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(JSON.stringify(dry.body)).toContain('moved into the new folder');
    await run({ outfit: 'silk  robe', images: [img(id, 'Outfit Reference - Back')] });
    const folder = w.assets.byName('Silk Robe', wardrobe()!.id)[0]!;
    expect(folder.type).toBe('FOLDER');
    const first = w.assets.byName('Nadira al-Khalid - Silk Robe - Outfit Reference - Front')[0]!;
    const second = w.assets.byName('Nadira al-Khalid - Silk Robe - Outfit Reference - Back')[0]!;
    expect(first.folderId).toBe(folder.id);
    expect(second.folderId).toBe(folder.id);
    expect(
      w.assets.inside(wardrobe()!.id).filter((x) => x.type !== 'FOLDER' && x.folderId === wardrobe()!.id),
    ).toEqual([]);
    const rec = outfitsOf().find((o) => o.name === 'Silk Robe')!;
    expect(rec.folderId).toBe(folder.id);
    expect(rec.pieces).toHaveLength(2);
    // G5: the existing outfit heading takes the new piece.
    expect(headings().filter((h) => h === '3:Silk Robe')).toHaveLength(1);
    expect(headings()).toContain('4:Outfit Reference - Back');
    // G9: the cache followed the bridge's own move.
    expect(w.stack.runtime.assets.queries.asset(PROJECT, first.id).data?.folderId).toBe(folder.id);
  });

  it('an outfit with its folder takes one more piece there', async () => {
    const id = await stage();
    await run({ outfit: 'Silk Robe', images: [img(id, 'Detail Reference - Sash')] });
    const folder = w.assets.byName('Silk Robe', wardrobe()!.id)[0]!;
    expect(w.assets.byName('Nadira al-Khalid - Silk Robe - Detail Reference - Sash')[0]!.folderId).toBe(
      folder.id,
    );
    expect(outfitsOf().find((o) => o.name === 'Silk Robe')!.pieces).toHaveLength(3);
  });

  it('a five-piece batch of a new outfit goes straight into its new folder, nothing loose', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await stage());
    await run({
      outfit: 'Battle Harness',
      images: ids.map((id, i) => img(id, `Outfit Reference - View ${i + 1}`)),
    });
    const folder = w.assets.byName('Battle Harness', wardrobe()!.id)[0]!;
    expect(folder.type).toBe('FOLDER');
    expect(w.assets.inside(folder.id)).toHaveLength(5);
    expect(
      w.assets.byName('Nadira al-Khalid - Battle Harness - Outfit Reference - View 1', wardrobe()!.id),
    ).toEqual([]);
  });

  it('a near match is refused (OUTFIT_NEAR_MATCH, with the candidates), unless newOutfit: true', async () => {
    const id = await stage();
    const near = await art({
      outfit: 'Silk Robes',
      images: [img(id, 'Outfit Reference - Side')],
      dryRun: true,
    });
    expect(near.isError).toBe(true);
    expect(near.body.error?.code ?? near.body.code, near.text).toBe('OUTFIT_NEAR_MATCH');
    expect(JSON.stringify(near.body)).toContain('Silk Robe');
    const ok = await art({
      outfit: 'Silk Robes',
      newOutfit: true,
      images: [img(id, 'Outfit Reference - Side')],
      dryRun: true,
    });
    expect(ok.isError, ok.text).toBe(false);
  });

  it('an alias matches its outfit (case and spacing ignored)', async () => {
    const rec = outfitsOf().find((o) => o.name === 'Silk Robe')!;
    w.stack.runtime.outfits.addAlias(PROJECT, rec.id, 'Robe of Silk', 'owner');
    const id = await stage();
    await run({ outfit: 'robe  OF silk', images: [img(id, 'Detail Reference - Hem')] });
    const folder = w.assets.byName('Silk Robe', wardrobe()!.id)[0]!;
    expect(w.assets.byName('Nadira al-Khalid - Silk Robe - Detail Reference - Hem')[0]!.folderId).toBe(
      folder.id,
    );
  });

  it('never makes a Forms, Outfits or Details folder (G6)', async () => {
    const id = await stage();
    for (const outfit of ['Outfits', 'Forms', 'details', 'Wardrobe', 'Gown / Train', 'Gown - Train']) {
      const r = await art({ outfit, images: [img(id, 'Outfit Reference - Front')], dryRun: true });
      expect(r.body.error?.code ?? r.body.code, `${outfit}: ${r.text}`).toBe('OUTFIT_NAME_INVALID');
    }
    const old = await art({
      images: [{ ...img(id, 'Outfit Reference - Front'), subfolder: 'Outfits / Gown' }],
      dryRun: true,
    });
    expect(old.isError).toBe(true);
    const raw = await w.call('lk_api_write', {
      operationId: 'createAssetFolder',
      params: { body: { name: 'Forms', folderId: charFolder().id } },
      project: 'test',
    });
    expect(raw.body.error?.code ?? raw.body.code, raw.text).toBe('LEGACY_ART_FOLDER');
    const up = await w.call('upload_image', {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'stray',
      destination: { for_character: { name: 'Nadira al-Khalid' }, subfolders: 'Details' },
      deduplicate: false,
      operation_id: 'f7-legacy-upload',
      project: 'test',
    });
    expect(up.body.error?.code ?? up.body.code, up.text).toBe('LEGACY_ART_FOLDER');
    for (const n of ['Forms', 'Outfits', 'Details']) expect(folderNamed(n)).toEqual([]);
  });
});
