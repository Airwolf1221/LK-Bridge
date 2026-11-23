/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * v3 F7b (ADR 0071): the test world of `arkona_get_art`. F7's owners world (the mock LegendKeeper, its asset host
 * `assets.test`, the Arkona pack approved), with Nadira al-Khalid's art added the way the owner adds it, through
 * `arkona_add_character_art` (so her Art page holds each image under its label heading with its alt text and the
 * interpretation paragraph under it):
 *
 * - a design piece, "Primary Reference - Character Portrait" (in her own folder);
 * - an outfit, "Silk Robe", two pieces (so `Wardrobe / Silk Robe`), recorded, with the alias "Evening Silks".
 *
 * `snapshot()` takes a full snapshot and waits for the appraisal's index (the authority's source).
 */
import sharp from 'sharp';
import { expect } from 'vitest';
import { fixture } from '../images/world.js';
import { approve, C } from '../packs/world.js';
import { ownersWorld, PROJECT, type OwnersWorld } from '../packs/owners-world.js';

export { C, PROJECT };

export const CHARACTER = 'Nadira al-Khalid';
export const DESIGN_LABEL = 'Primary Reference - Character Portrait';
export const DESIGN_TEXT =
  'Establishes her face, her dark hair and her grey eyes; it takes precedence over any description of her features.';
export const OUTFIT = 'Silk Robe';
export const ALIAS = 'Evening Silks';

export interface ArtWorld extends OwnersWorld {
  snapshot(): Promise<void>;
  /** Asset ids by role: `design`, `robeFront`, `robeBack`. */
  readonly ids: { design: string; robeFront: string; robeBack: string };
  /** The tool's JSON (the first content block) and its image blocks. */
  getArt(args: Record<string, unknown>): Promise<{
    isError: boolean;
    body: Record<string, any>;
    images: { mimeType: string; data: string }[];
    text: string;
  }>;
  /** The governor's count of reads (the `key-day` tier) so far. */
  readsUsed(): number;
  /** Downloads the asset host answered so far. */
  downloads(): number;
  /** Adds an image asset to the mock in `folderId`, served with `bytes`; its file URL's stem is `stem`. */
  addImage(name: string, folderId: string | null, bytes: Buffer, stem: string): { id: string; url: string };
  /** The Art page's id. */
  artPageId(): string;
  /**
   * The bridge's asset tree reads the library's root live (images a test added there). F7's URL check reads the whole
   * listing at most once every five minutes, so a test that adds images after another call has looked puts them in the
   * tree this way.
   */
  syncTree(): Promise<void>;
}

let nth = 0;

export async function artWorld(): Promise<ArtWorld> {
  const w = await ownersWorld();
  const stage = async (file: string) => {
    const r = await w.call('upload_image', {
      data_base64: fixture(file).toString('base64'),
      name: `f7b stage ${nth}`,
      stage: true,
      deduplicate: false,
      operation_id: `f7b-stage-${nth++}`,
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    return String(r.body.staged_id);
  };
  const add = async (args: Record<string, unknown>) => {
    const p = await w.call('arkona_add_character_art', { character: CHARACTER, project: 'test', ...args });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
  };
  await add({
    images: [{ staged_id: await stage('alpha.png'), label: DESIGN_LABEL, interpretation: DESIGN_TEXT }],
  });
  await add({
    outfit: OUTFIT,
    images: [
      {
        staged_id: await stage('orientation-6.jpg'),
        label: 'Outfit Reference - Front',
        interpretation: 'The robe from the front: ivory silk, a jade sash.',
      },
      {
        staged_id: await stage('png-named.jpg'),
        label: 'Outfit Reference - Back',
        interpretation: 'The robe from the back.',
      },
    ],
  });
  const byName = (n: string) => w.assets.byName(n)[0]!.id;
  const ids = {
    design: byName(`${CHARACTER} - ${DESIGN_LABEL}`),
    robeFront: byName(`${CHARACTER} - ${OUTFIT} - Outfit Reference - Front`),
    robeBack: byName(`${CHARACTER} - ${OUTFIT} - Outfit Reference - Back`),
  };
  const charFolder = w.assets.byName(CHARACTER).find((a) => a.type === 'FOLDER')!;
  const rec = w.stack.runtime.outfits.forCharacter(PROJECT, charFolder.id).find((o) => o.name === OUTFIT)!;
  w.stack.runtime.outfits.addAlias(PROJECT, rec.id, ALIAS, 'owner');

  const reader = w.stack.newToken('f7b-reader', 'read');
  const readClient = await w.stack.connect(reader.token);
  const lk = () => w.stack.runtime.projects.client(PROJECT)!;
  return Object.assign(w, {
    ids,
    async snapshot() {
      await w.stack.runtime.snapshots.full(PROJECT, 'manual');
      await w.stack.runtime.audits.settled();
      await w.stack.runtime.appraisal.index.settled();
    },
    async getArt(args: Record<string, unknown>) {
      const r = await readClient.callTool({
        name: 'arkona_get_art',
        arguments: { project: 'test', ...args },
      });
      const content = r.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      const text = content[0]?.text ?? '';
      const json = text.slice(0, text.lastIndexOf('\n') > 0 ? text.lastIndexOf('\n') : text.length);
      let body: Record<string, any>;
      try {
        body = JSON.parse(json) as Record<string, any>;
      } catch {
        body = { raw: text };
      }
      return {
        isError: r.isError === true,
        body,
        text,
        images: content
          .filter((c) => c.type === 'image')
          .map((c) => ({ mimeType: c.mimeType ?? '', data: c.data ?? '' })),
      };
    },
    readsUsed: () => lk().governor.snapshot().tiers['key-day'].used,
    downloads: () => w.gets.length,
    addImage(name: string, folderId: string | null, bytes: Buffer, stem: string) {
      const url = `https://assets.test:${w.port}/a/${stem}.webp`;
      const id = w.assets.image(name, folderId, { url });
      w.served.set(stem, bytes);
      return { id, url };
    },
    async syncTree() {
      const r = await w.stack.runtime.assets.refreshFolder(PROJECT, null, { depth: 1 });
      expect(r.ok, r.error).toBe(true);
    },
    artPageId: () =>
      [...w.repo.res.values()].find(
        (r) => r.deletedAt === null && r.name === `[BSRC] ${CHARACTER} - Character Art`,
      )!.id,
  });
}

/** An RGB noise image (no alpha), which compresses badly: for the size limits. */
export async function noise(width: number, height: number, seed = 1): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    raw[i] = x & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}
