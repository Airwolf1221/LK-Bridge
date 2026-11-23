/**
 * `arkona_visual_hygiene` (v3 F3c, ADR 0054; the design's A5): the visual references, read from the bridge's asset tree
 * and the snapshots (the images each page shows, the library's stored bytes). Every finding is a **candidate**, never a
 * defect to repair automatically: "Visual conclusions require inspectable imagery and the written owner" (Visual
 * References). The checks:
 *
 * - an asset name that includes a file extension (the one candidate with a deterministic repair: a rename);
 * - a non-WebP image (its format read from the first bytes the snapshot store holds; unknown when it holds none);
 * - an asset outside its subject's `Characters / <race path> / <Name>` folder (and its Wardrobe and outfit folders), for
 *   the images a character's pages show (the folder worked out as the pack's art tool works it out);
 * - orphan candidates: image assets no page shows (a whole-library run only);
 * - broken image references: image blocks whose asset is gone from the library;
 * - Art page images with no interpretation text after them;
 * - two images labelled as one subject's Primary Reference.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { textKey } from '../packs/engine/text.js';
import type { PackRules } from '../packs/types.js';
import { cleanPrefixes } from '../registry/names.js';
import type { Draft } from './owner.js';
import { characterType } from './owner.js';
import type { PageReader } from './reader.js';
import { urlPath } from './extract.js';

type Obj = Record<string, unknown>;

export interface LibraryAsset {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly folderId: string | null;
  readonly path: readonly string[];
  readonly url: string | null;
  readonly hidden: boolean;
  readonly sha256: string | null;
}

export interface ShownImage {
  readonly pageId: string;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly kind: 'block' | 'other';
  readonly url: string;
  readonly urlPath: string;
  readonly label: string | null;
  readonly interpretation: boolean;
  readonly section: string | null;
}

export interface VisualContext {
  readonly projectId: string;
  readonly reader: PageReader;
  readonly rules: PackRules;
  readonly assets: readonly LibraryAsset[];
  readonly images: readonly ShownImage[];
  /** The asset hosts (a block whose URL is elsewhere is not an asset of the library). */
  readonly assetHosts: readonly string[];
  /** The character's expected folder path (`Characters / <race path> / <Name>`), from the image planner. */
  readonly characterFolder: (subject: string, race: string | null) => readonly string[] | null;
  /** The format of stored bytes (`webp`, `png`…), or null when the store holds none. */
  readonly formatOf: (sha256: string) => Promise<string | null>;
  readonly referenceTypeRow: string;
  /** The pages in scope (null: everything, the orphans included). */
  readonly pageIds: ReadonlySet<string> | null;
}

export const EXTENSION = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|heif)$/i;
const PRIMARY = /primary reference/i;

/** The format of an image from its first bytes. */
export function sniff(head: Uint8Array): string {
  const b = Buffer.from(head);
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'webp';
  if (b.length >= 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'avif/heic';
  if (b.length >= 2 && b.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return 'other';
}

/** The first bytes of a gzipped store object, without reading the rest. */
export function headOf(file: string, n = 16): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let got = 0;
    let done = false;
    const src = createReadStream(file);
    const gz = createGunzip();
    const finish = (v: Buffer | null) => {
      if (done) return;
      done = true;
      src.destroy();
      gz.destroy();
      resolve(v);
    };
    gz.on('data', (c: Buffer) => {
      chunks.push(c);
      got += c.length;
      if (got >= n) finish(Buffer.concat(chunks).subarray(0, n));
    });
    gz.on('end', () => finish(got > 0 ? Buffer.concat(chunks) : null));
    gz.on('error', () => finish(null));
    src.on('error', () => finish(null));
    src.pipe(gz);
  });
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export async function visualHygiene(ctx: VisualContext): Promise<{ drafts: Draft[]; inspected: Obj }> {
  const drafts: Draft[] = [];
  const byPath = new Map<string, LibraryAsset>();
  for (const a of ctx.assets) if (a.url) byPath.set(urlPath(a.url), a);
  const inScope = (pageId: string) => ctx.pageIds === null || ctx.pageIds.has(pageId);
  const shown = ctx.images.filter((i) => inScope(i.pageId));
  const pathText = (a: LibraryAsset) => [...a.path, a.name].join(' / ');
  const pageName = (id: string) => ctx.reader.page(id)?.rawName ?? id;
  const isImage = (a: LibraryAsset) => a.type.toUpperCase() === 'IMAGE';

  // ---------------------------------------------------------------------------------- the assets in scope
  const scoped =
    ctx.pageIds === null
      ? ctx.assets
      : [...new Set(shown.map((i) => byPath.get(i.urlPath)).filter((a): a is LibraryAsset => !!a))];
  let unknownFormat = 0;
  for (const a of scoped) {
    if (EXTENSION.test(a.name)) {
      const newName = a.name.replace(EXTENSION, '').trim();
      drafts.push({
        check: 'asset_extension',
        pageId: null,
        key: a.id,
        message: `The asset “${pathText(a)}” has a file extension in its name.`,
        details: { asset: { id: a.id, name: a.name, path: a.path }, rename: newName },
        fixArgs: { assetId: a.id, name: a.name, newName, folderId: a.folderId },
      });
    }
    if (!isImage(a)) continue;
    const format = a.sha256 ? await ctx.formatOf(a.sha256) : null;
    if (format === null) {
      unknownFormat++;
      drafts.push({
        check: 'format_unknown',
        pageId: null,
        key: a.id,
        message: `The format of “${pathText(a)}” could not be read: the snapshot store holds no bytes of it yet.`,
        details: { asset: { id: a.id, name: a.name, path: a.path } },
      });
    } else if (format !== 'webp')
      drafts.push({
        check: 'asset_not_webp',
        pageId: null,
        key: a.id,
        message: `“${pathText(a)}” is ${format.toUpperCase()}, not WebP.`,
        details: { asset: { id: a.id, name: a.name, path: a.path }, format },
      });
  }

  // ---------------------------------------------------------------------------------- orphans (a whole-library run)
  if (ctx.pageIds === null) {
    const used = new Set(ctx.images.map((i) => i.urlPath));
    for (const a of ctx.assets) {
      if (!isImage(a) || !a.url || used.has(urlPath(a.url))) continue;
      drafts.push({
        check: 'asset_orphan',
        pageId: null,
        key: a.id,
        message: `No page shows “${pathText(a)}” (an orphan candidate: it may be kept deliberately).`,
        details: { asset: { id: a.id, name: a.name, path: a.path, hidden: a.hidden } },
      });
    }
  }

  // ---------------------------------------------------------------------------------- the images pages show
  const hosts = new Set(ctx.assetHosts.map((h) => h.toLowerCase()));
  for (const i of shown) {
    if (i.kind !== 'block') continue;
    const host = hostOf(i.url);
    if (host === null || !hosts.has(host)) continue;
    if (!byPath.has(i.urlPath))
      drafts.push({
        check: 'image_broken',
        pageId: i.pageId,
        key: `${i.documentId ?? ''}:${i.blockId ?? i.urlPath}`,
        documentId: i.documentId,
        blockId: i.blockId,
        message: `“${pageName(i.pageId)}” shows an image whose asset is gone from the library${i.label ? ` (“${i.label}”)` : ''}.`,
        details: { url: i.url, label: i.label, section: i.section },
      });
  }

  // ---------------------------------------------------------------------------------- characters: folders, Art, primary
  const t = characterType(ctx.rules);
  const artRole = t?.roles.find((r) => r.role === t.assets.role);
  const identityTypes = new Set(
    (t?.roles ?? [])
      .filter((r) => (r.role === 'core' || r.role === 'compact') && r.referenceType)
      .map((r) => textKey(r.referenceType!)),
  );
  const sets = new Map<string, { subject: string; race: string | null; pages: Set<string> }>();
  const factOf = async (id: string, key: string) =>
    (await ctx.reader.load(id))?.sidebar?.facts.get(key.trim().toLowerCase())?.text ?? null;
  const setOf = async (
    pageId: string,
  ): Promise<{ subject: string; race: string | null; pages: Set<string> } | null> => {
    const page = ctx.reader.page(pageId);
    if (!page) return null;
    const own = await factOf(pageId, ctx.referenceTypeRow);
    const identityHere = own !== null && identityTypes.has(textKey(own));
    const parent = page.parentId ? ctx.reader.page(page.parentId) : null;
    // The set: the character's index (when the page is in one), else the compact Reference alone.
    let identity: string | null = null;
    let key: string | null = null;
    if (parent && parent.kind === 'index')
      for (const k of ctx.reader.children(parent.id)) {
        const rt = await factOf(k.id, ctx.referenceTypeRow);
        if (rt !== null && identityTypes.has(textKey(rt))) {
          identity = k.id;
          key = parent.id;
          break;
        }
      }
    if (!identity && identityHere) {
      identity = pageId;
      key = pageId;
    }
    if (!identity || !key) return null;
    const hit = sets.get(key);
    if (hit) return hit;
    const idPage = ctx.reader.page(identity)!;
    const subject =
      (await factOf(identity, 'Subject')) ?? cleanPrefixes(idPage.rawName).name.split(' - ')[0]!.trim();
    const race = await factOf(identity, 'Race / Species');
    const pages = new Set<string>(key === identity ? [identity] : ctx.reader.children(key).map((x) => x.id));
    const s = { subject, race: race && race.trim() !== '' ? race.trim() : null, pages };
    sets.set(key, s);
    return s;
  };
  const primaries = new Map<
    string,
    { subject: string; images: Map<string, { pageId: string; label: string }> }
  >();
  for (const i of shown) {
    if (i.kind !== 'block') continue;
    const set = await setOf(i.pageId);
    if (!set) continue;
    const asset = byPath.get(i.urlPath);
    // Misplaced: the asset sits outside the character's folder (and its Wardrobe and outfit folders).
    if (asset) {
      const expected = ctx.characterFolder(set.subject, set.race);
      if (expected && expected.length > 0) {
        const inside =
          asset.path.length >= expected.length &&
          expected.every((n, k) => textKey(n) === textKey(asset.path[k] ?? ''));
        if (!inside)
          drafts.push({
            check: 'asset_misplaced',
            pageId: i.pageId,
            key: `${asset.id}:${i.pageId}`,
            documentId: i.documentId,
            blockId: i.blockId,
            message: `“${pageName(i.pageId)}” shows “${pathText(asset)}”, which is outside ${set.subject}’s folder (${expected.join(' / ')}).`,
            details: {
              asset: { id: asset.id, name: asset.name, path: asset.path },
              expected,
              subject: set.subject,
            },
          });
      }
    }
    // Art pages: every image has its interpretation after it.
    const rt = await factOf(i.pageId, ctx.referenceTypeRow);
    const isArt = !!artRole?.referenceType && rt !== null && textKey(rt) === textKey(artRole.referenceType);
    if (isArt && !i.interpretation)
      drafts.push({
        check: 'art_uninterpreted',
        pageId: i.pageId,
        key: `${i.documentId ?? ''}:${i.blockId ?? i.urlPath}`,
        documentId: i.documentId,
        blockId: i.blockId,
        message: `An image on “${pageName(i.pageId)}”${i.label ? ` (“${i.label}”)` : ''} has no interpretation text after it.`,
        details: { url: i.url, label: i.label, section: i.section },
      });
    // Primary references: by the label above the image, or the asset's own name.
    const label =
      i.label && PRIMARY.test(i.label) ? i.label : asset && PRIMARY.test(asset.name) ? asset.name : null;
    if (label) {
      const k = set.subject;
      const entry = primaries.get(k) ?? { subject: set.subject, images: new Map() };
      entry.images.set(i.urlPath, { pageId: i.pageId, label });
      primaries.set(k, entry);
    }
  }
  for (const p of primaries.values()) {
    if (p.images.size < 2) continue;
    const list = [...p.images.entries()].map(([path, v]) => ({
      url: path,
      page: pageName(v.pageId),
      label: v.label,
    }));
    const first = [...p.images.values()][0]!;
    drafts.push({
      check: 'primary_conflict',
      pageId: first.pageId,
      key: textKey(p.subject),
      message: `${p.images.size} images are labelled as ${p.subject}’s Primary Reference.`,
      details: { subject: p.subject, images: list },
    });
  }
  return {
    drafts,
    inspected: {
      assets: scoped.length,
      library: ctx.assets.length,
      imagesShown: shown.length,
      characterSets: sets.size,
      formatUnknown: unknownFormat,
      orphansChecked: ctx.pageIds === null,
    },
  };
}
