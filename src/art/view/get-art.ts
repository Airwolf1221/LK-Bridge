/**
 * v3 F7b (ADR 0071; the owner-approved design LK-Bridge-F7b-art-download-design.md): `arkona_get_art`, so an agent can
 * SEE a character's art and use it as a literal visual reference. Read-only: it never writes to LegendKeeper.
 *
 * - **D1, what**: exactly one selector. `asset` (1 to 6 ids or file URLs, both URL forms); `character` (all of its art,
 *   or one `outfit` by name or alias through F7's record and matcher, or `design: true` for the pieces in its own
 *   folder), its folders read LIVE first (F7's G9: never the cached tree); `page` (every image block of the page in
 *   document order, all its page documents or `document`), read live. At most 6 images a call; more are paged with
 *   `nextCursor`.
 * - **D2, authority**: each image with the paragraphs the owner wrote under it, on every page that embeds it
 *   (src/art/view/authority.ts); `none` with a warning when nothing does.
 * - **D3, link**: the asset's own `url`, exactly as LegendKeeper gives it, and `howToView` (browse it, never code).
 * - **D4, inline**: one MCP `image` block per image after the JSON, in order, resized (src/art/view/derive.ts), at most
 *   6 MB of image data a result (the rest `inlineSkipped: "result size"`); a failed download or resize keeps the link
 *   and the authority, with `inline: { ok: false, reason }`.
 * - **D6, cost**: bytes come only through `downloadAsset` (the governor, the guarded transport, LK_ASSET_HOSTS), each
 *   download counted as one read; a cached derivative (src/art/view/cache.ts) costs nothing; `link` never downloads.
 */
import { createHash } from 'node:crypto';
import type { McpToolContent, McpToolContext, McpToolResult } from '../../mcp/server.js';
import { liveRead, repoContext, resolvePage, type RepoCtx } from '../../mcp/tools/repo.js';
import { pickDocument } from '../../mcp/tools/read-document.js';
import type { LkClient } from '../../lk/client.js';
import type { CostSpec } from '../../lk/governor/index.js';
import type { ArtCache } from './cache.js';
import { errorResult, render, type ProjectDeps } from '../../mcp/tools/shape.js';
import { downloadAsset, isAssetUrl } from '../../images/download.js';
import { requireOperation } from '../../lk/registry.js';
import { cleanPrefixes, key as nameKey, subjectOf } from '../../registry/names.js';
import { findCharacters, type CharacterHit } from '../../packs/engine/plan.js';
import { hookFor } from '../../packs/hooks.js';
import { textKey } from '../../packs/engine/text.js';
import { liveArtFolder } from '../../packs/art-place.js';
import { DEFAULT_ART_VIEW, type ArtViewRules } from '../../packs/types.js';
import { decidePlacement, knownOutfits } from '../placement.js';
import type { ArtLayout, LibItem } from '../layout.js';
import type { TreeNode } from '../../tree/index.js';
import { AuthorityIndex, imageUrlsIn, type Authority, type LivePage } from './authority.js';
import { deriveInline } from './derive.js';

type Obj = Record<string, unknown>;

export const MAX_IMAGES = 6;
/** D4: the image data one result may carry (6 MB). */
export const RESULT_IMAGE_CAP = 6_000_000;
/**
 * The limits in force: `resultImageCap` (RESULT_IMAGE_CAP) and the derivative's byte target. A TEST SEAM only (six
 * derivatives under 1 MB each never reach 6 MB, so the cap's test lowers it); nothing in the bridge changes them.
 */
export const ART_VIEW_LIMITS: { resultImageCap: number; maxBytes: number | undefined } = {
  resultImageCap: RESULT_IMAGE_CAP,
  maxBytes: undefined,
};
export const HOW_TO_VIEW =
  'Open each url with your web browsing tool, not with code: code sandboxes cannot reach this host.';
export const COST_LINE = 'Cost: none for links; 1 read per image downloaded for inline (cached).';
const DOWNLOAD_OP = 'arkona_get_art.download';

export interface GetArtInput {
  readonly asset?: readonly string[] | undefined;
  readonly character?: string | undefined;
  readonly outfit?: string | undefined;
  readonly design?: boolean | undefined;
  readonly page?: string | undefined;
  readonly document?: string | undefined;
  readonly delivery?: 'both' | 'link' | 'inline' | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/** One image to deliver, before its delivery. */
interface Target {
  readonly assetId: string | null;
  readonly name: string | null;
  readonly folderId: string | null;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly size: number | null;
  /** The page selector: where the block is. */
  readonly block?: {
    readonly documentId: string;
    readonly blockId: string | null;
    readonly alt: string | null;
  };
  /** Where the character selector found it (`design`, `Wardrobe`, an outfit's name, a legacy folder). */
  readonly group?: string;
  readonly note?: string;
}

interface NotFound {
  readonly input: string;
  readonly code: string;
  readonly message: string;
}

/** A selection's key: a cursor from one selection is refused by another. */
function selectionKey(i: GetArtInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        i.asset ?? null,
        i.character ?? null,
        i.outfit ?? null,
        i.design ?? null,
        i.page ?? null,
        i.document ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

export function encodeCursor(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ k: key, o: offset })).toString('base64url');
}

function decodeCursor(c: string, key: string): number | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { k?: unknown; o?: unknown };
    if (v.k !== key || typeof v.o !== 'number' || !Number.isInteger(v.o) || v.o < 0) return null;
    return v.o;
  } catch {
    return null;
  }
}

const formatOf = (url: string): string | null => {
  try {
    const m = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
    return m ? m[1]!.toLowerCase().replace('jpg', 'jpeg') : null;
  } catch {
    return null;
  }
};

export async function getArt(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: { readonly packId: string; readonly tool: string; readonly input: GetArtInput },
): Promise<McpToolResult> {
  const input = o.input;
  const fail = (code: string, message: string, more: Obj = {}) => errorResult({ code, message, ...more }, pd);

  // ------------------------------------------------------------------------------------------ the call's shape
  const selectors = [
    input.asset !== undefined,
    input.character !== undefined,
    input.page !== undefined,
  ].filter(Boolean).length;
  if (selectors !== 1)
    return fail(
      'SELECTOR_REQUIRED',
      'Give exactly one of asset (1 to 6 ids or URLs), character (optionally with outfit, or design: true) or page.',
    );
  if ((input.outfit !== undefined || input.design !== undefined) && input.character === undefined)
    return fail('INVALID_INPUT', 'outfit and design go with character.');
  if (input.outfit !== undefined && input.design === true)
    return fail(
      'INVALID_INPUT',
      'Give outfit or design: true, not both (design pieces belong to no outfit).',
    );
  if (input.document !== undefined && input.page === undefined)
    return fail('INVALID_INPUT', 'document goes with page.');
  const delivery = input.delivery ?? 'both';
  const limit = Math.min(MAX_IMAGES, Math.max(1, input.limit ?? MAX_IMAGES));
  const key = selectionKey(input);
  let offset = 0;
  if (input.cursor !== undefined) {
    const at = decodeCursor(input.cursor, key);
    if (at === null)
      return fail(
        'CURSOR_INVALID',
        'This nextCursor belongs to another selection (or is not one): call again with the same selector, or without cursor.',
      );
    offset = at;
  }

  // ------------------------------------------------------------------------------------------ the pack
  const packs = pd.services?.packs;
  if (!packs) return fail('TOOL_UNAVAILABLE', 'Setting packs are not available here.');
  const pack = packs.get(o.packId);
  if (!pack) return fail('PACK_NOT_FOUND', `No pack ${o.packId}.`);
  if (!packs.attachment(pack.id, pd.project.id)) {
    const attached = packs.view(pack.id)?.attachments.map((a) => a.projectName) ?? [];
    return fail(
      'PACK_NOT_ATTACHED',
      `The ${pack.name} pack is not attached to the project ${pd.project.name}; its tools work only on ${attached.join(', ') || 'no project yet'}.`,
      { attachedTo: attached },
    );
  }
  const type = pack.rules.types.find((t) => hookFor(t)?.name === 'character');
  if (!type) return fail('PACK_TYPE_NOT_FOUND', `The ${pack.name} pack has no character type.`);
  const view: ArtViewRules = pack.rules.artView ?? DEFAULT_ART_VIEW;
  const assets = pd.services?.assets;
  if (!assets) return fail('TOOL_UNAVAILABLE', 'The asset tree is not available here.');
  const rc = repoContext(pd);
  if (!rc.ok) return rc.result;
  const ctx = rc.ctx;
  const projectId = ctx.projectId;
  const hosts = pd.settings.images.assetHosts;

  let reads = 0;
  const notes: string[] = [];
  const notFound: NotFound[] = [];
  const live = new Map<string, LivePage>();
  let all: Target[] = [];
  const body: Obj = {};
  let character: { hit: CharacterHit; subject: string; setIds: Set<string>; artName: string | null } | null =
    null;

  const fromItem = (it: LibItem, group?: string): Target | null => {
    const a = assets.queries.asset(projectId, it.id).data;
    if (a && a.type !== 'IMAGE') return null;
    const url = a?.url ?? it.url ?? null;
    if (!url) return null;
    return {
      assetId: it.id,
      name: a?.name ?? it.name,
      folderId: a?.folderId ?? null,
      url,
      width: a?.width ?? null,
      height: a?.height ?? null,
      size: a?.size ?? null,
      ...(group ? { group } : {}),
    };
  };

  // ------------------------------------------------------------------------------------------ D1: asset
  if (input.asset !== undefined) {
    const seen = new Set<string>();
    const urlMisses: string[] = [];
    const byUrl = new Map<string, string>();
    for (const raw of input.asset) {
      const s = raw.trim();
      if (/^https?:\/\//i.test(s)) {
        if (!isAssetUrl(s, hosts)) {
          notFound.push({
            input: s,
            code: 'NOT_ASSET_URL',
            message: `Not a LegendKeeper asset URL (an https URL on ${hosts.join(' or ')}).`,
          });
          continue;
        }
        if (!assets.queries.assetByUrl(projectId, s).data) urlMisses.push(s);
        byUrl.set(raw, s);
      }
    }
    let urlCheck: Awaited<ReturnType<NonNullable<typeof assets.checkUrls>>> | null = null;
    if (urlMisses.length > 0 && assets.checkUrls) {
      urlCheck = await assets.checkUrls(projectId, urlMisses);
      reads += urlCheck.requests;
    }
    for (const raw of input.asset) {
      const s = raw.trim();
      let id: string;
      if (byUrl.has(raw)) {
        const hit = assets.queries.assetByUrl(projectId, s).data;
        if (!hit) {
          notFound.push({
            input: s,
            code: 'ASSET_NOT_FOUND',
            message: urlCheck?.refreshed
              ? 'No image asset of this project has exactly this URL (the asset listing was read live just now).'
              : urlCheck?.retryAfter
                ? `No image asset of this project in the asset tree has exactly this URL; the listing was read live at ${new Date(urlCheck.refreshedAt ?? 0).toISOString()}, and can be read again after ${new Date(urlCheck.retryAfter).toISOString()}.`
                : 'No image asset of this project in the asset tree has exactly this URL.',
          });
          continue;
        }
        id = hit.id;
      } else if (/^https?:\/\//i.test(s)) continue;
      else id = s;
      if (seen.has(id)) continue;
      seen.add(id);
      const a = assets.queries.asset(projectId, id).data;
      if (!a) {
        const r = await liveRead(pd, mctx, o.tool, 'getAsset', { path: { assetId: id } });
        reads++;
        const v = r.ok ? (r.value as Obj | null) : null;
        if (!v || typeof v.id !== 'string') {
          notFound.push({
            input: s,
            code: 'ASSET_NOT_FOUND',
            message: `No asset ${id} (read live just now).`,
          });
          continue;
        }
        if (v.type !== 'IMAGE' || typeof v.url !== 'string') {
          notFound.push({
            input: s,
            code: 'NOT_AN_IMAGE',
            message: `${id} is not an image asset (${String(v.type)}).`,
          });
          continue;
        }
        all.push({
          assetId: v.id,
          name: typeof v.name === 'string' ? v.name : null,
          folderId: typeof v.folderId === 'string' ? v.folderId : null,
          url: v.url,
          width: typeof v.width === 'number' ? v.width : null,
          height: typeof v.height === 'number' ? v.height : null,
          size: null,
          note: 'read live (the asset tree did not hold it)',
        });
        continue;
      }
      if (a.type !== 'IMAGE' || !a.url) {
        notFound.push({
          input: s,
          code: 'NOT_AN_IMAGE',
          message: `${id} is not an image asset (${a.type}).`,
        });
        continue;
      }
      all.push({
        assetId: a.id,
        name: a.name,
        folderId: a.folderId,
        url: a.url,
        width: a.width,
        height: a.height,
        size: a.size,
      });
    }
  }

  // ------------------------------------------------------------------------------------------ D1: character
  if (input.character !== undefined) {
    const q = input.character;
    const found = findCharacters(ctx, cleanPrefixes(q).name.trim() || q);
    if (found.subjects.length !== 1)
      return found.subjects.length === 0
        ? fail(
            'CHARACTER_NOT_FOUND',
            `No character matches “${q}” (by id, name, alias or Canonical Display Name).`,
          )
        : fail(
            'CHARACTER_AMBIGUOUS',
            `“${q}” names ${found.subjects.length} characters; pass the id of the one meant.`,
            {
              candidates: found.subjects.map((s) => ({
                id: s.identity.id,
                name: s.identity.rawName,
                path: s.identity.path,
              })),
            },
          );
    const hit = found.subjects[0]!;
    const index = indexOf(ctx, hit);
    const subject = index?.displayName ?? (hit.subject || subjectOf(hit.identity.displayName, null));
    const set = index
      ? ctx.tree.subtree(projectId, index.id, { limit: 500 }).data.entries.map((e) => e.node.id)
      : [hit.identity.id];
    const artRole = type.roles.find((r) => r.role === type.assets.role);
    character = {
      hit,
      subject,
      setIds: new Set(set),
      artName: artRole ? artRole.name.replace('{Name}', subject) : null,
    };
    const folder = await liveArtFolder({ pd, mctx, tool: o.tool, ctx, type }, hit, subject);
    if (!folder.ok) return folder.result;
    reads += folder.value.live.requests;
    const layout = folder.value.layout;
    body.character = {
      name: subject,
      identityPage: { id: hit.identity.id, name: hit.identity.rawName },
      folder: layout ? layout.character.path.join(' / ') : null,
      foldersReadLive: folder.value.live.requests,
    };
    if (!layout) notes.push(`${subject} has no asset folder yet, so no art.`);
    else if (input.outfit !== undefined) {
      const records = pd.services?.outfits?.forCharacter(projectId, layout.character.id) ?? [];
      const p = decidePlacement({ character: subject, layout, records, outfit: input.outfit, arriving: 0 });
      if (!p.ok) return fail(p.code, p.message, p.candidates ? { candidates: p.candidates } : {});
      if (p.kind !== 'outfit' || p.outfit.source === 'new')
        return fail(
          'OUTFIT_NOT_FOUND',
          `${subject} has no outfit named “${input.outfit}” (by name or alias, read live).`,
          {
            outfits: knownOutfits(layout, records, subject).map((x) => ({
              name: x.name,
              aliases: x.aliases,
            })),
          },
        );
      body.outfit = {
        name: p.outfit.name,
        ...(p.outfit.via && p.outfit.via !== p.outfit.name ? { matchedAlias: p.outfit.via } : {}),
        known: p.outfit.source,
        folder: p.folderId ? [...layout.character.path, ...p.subfolders].join(' / ') : null,
      };
      notes.push(...p.notes);
      all = p.existing.map((it) => fromItem(it, p.outfit.name)).filter((t): t is Target => t !== null);
    } else all = layoutTargets(layout, input.design === true, fromItem);
  }

  // ------------------------------------------------------------------------------------------ D1: page
  if (input.page !== undefined) {
    const r = resolvePage(ctx, input.page);
    if (!r.ok) return r.result;
    const node = r.node;
    let docs = node.documents.filter((d) => d.type === 'page');
    if (input.document !== undefined) {
      const d = pickDocument(ctx, node, input.document);
      if (!d.ok) return d.result;
      docs = [d.doc];
    }
    const read: LivePage['documents'][number][] = [];
    for (const d of docs) {
      const b = await liveRead(pd, mctx, o.tool, 'getDocumentBlocks', {
        path: { resourceId: node.id, documentId: d.id },
      });
      reads++;
      if (!b.ok) return b.result;
      const blocks = (b.value as { blocks?: unknown[] } | null)?.blocks ?? [];
      read.push({ id: d.id, name: d.name, blocks });
    }
    live.set(node.id, { id: node.id, name: node.rawName, documents: read });
    body.page = {
      id: node.id,
      name: node.rawName,
      documents: read.map((d) => ({ id: d.id, name: d.name })),
      readLive: read.length,
    };
    for (const d of read)
      for (const im of imageUrlsIn(d.blocks))
        all.push({
          assetId: null,
          name: null,
          folderId: null,
          url: im.url,
          width: null,
          height: null,
          size: null,
          block: { documentId: d.id, blockId: im.blockId, alt: im.alt },
        });
  }

  // ------------------------------------------------------------------------------------------ the page of results
  const slice = all.slice(offset, offset + limit);
  if (input.page !== undefined) {
    // The page's blocks name URLs: each found in the asset tree (one live listing for those it lacks, as G11).
    const misses = slice
      .filter((t) => isAssetUrl(t.url, hosts) && !assets.queries.assetByUrl(projectId, t.url).data)
      .map((t) => t.url);
    if (misses.length > 0 && assets.checkUrls) reads += (await assets.checkUrls(projectId, misses)).requests;
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i]!;
      const a = assets.queries.assetByUrl(projectId, t.url).data;
      slice[i] = a
        ? {
            ...t,
            assetId: a.id,
            name: a.name,
            folderId: a.folderId,
            width: a.width,
            height: a.height,
            size: a.size,
          }
        : {
            ...t,
            note: 'not an image asset of this project in the asset tree (F7’s URL check: the listing is read live at most every five minutes)',
          };
    }
  }

  // ------------------------------------------------------------------------------------------ D2: authority
  const index = await AuthorityIndex.open(pd.services?.appraisal, projectId);
  const isOwnerPage = (pageId: string): boolean => {
    const n = ctx.tree.node(projectId, pageId).data;
    if (!n) return false;
    const refs = view.ownerPages.referenceTypes.map(textKey);
    const tags = view.ownerPages.tags.map(textKey);
    if (n.referenceType && refs.includes(textKey(n.referenceType))) return true;
    if (n.tags.some((t) => tags.includes(textKey(t)))) return true;
    return (
      character !== null &&
      character.artName !== null &&
      nameKey(n.displayName) === nameKey(character.artName)
    );
  };

  // ------------------------------------------------------------------------------------------ D3, D4: delivery
  const cache = pd.services?.artCache;
  const lk = pd.projects.client(projectId);
  const costs: CostSpec = { tiers: requireOperation('getAsset').costs };
  let imageBytes = 0;
  let downloads = 0;
  let cacheHits = 0;
  const images: McpToolContent[] = [];
  const out: Obj[] = [];
  let linkFallback = false;
  for (const [i, t] of slice.entries()) {
    const authority: Authority = await index.authorityOf(t.url, {
      textChars: view.textChars,
      isOwnerPage,
      live,
    });
    const folder = t.folderId
      ? assets.queries
          .path(projectId, t.folderId)
          .data.map((f) => f.name)
          .join(' / ')
      : null;
    const entry: Obj = {
      n: offset + i + 1,
      assetId: t.assetId,
      name: t.name,
      folder,
      width: t.width,
      height: t.height,
      format: formatOf(t.url),
      bytes: t.size,
      url: t.url,
      ...(t.group ? { group: t.group } : {}),
      ...(t.block ? { block: t.block } : {}),
      ...(t.note ? { note: t.note } : {}),
      authority,
    };
    if (delivery !== 'link') {
      const inline = await deliverInline(pd, mctx, t, { cache, lk, costs, hosts });
      if (inline.downloaded) downloads++;
      if (inline.cached) cacheHits++;
      if (!inline.ok) {
        entry.inline = { ok: false, reason: inline.reason };
        linkFallback = true;
      } else if (imageBytes + inline.bytes.length > ART_VIEW_LIMITS.resultImageCap) {
        entry.inlineSkipped = 'result size';
        linkFallback = true;
      } else {
        imageBytes += inline.bytes.length;
        images.push({ type: 'image', data: inline.bytes.toString('base64'), mimeType: inline.mimeType });
        entry.inline = {
          ok: true,
          content: images.length,
          format: inline.format,
          width: inline.width,
          height: inline.height,
          bytes: inline.bytes.length,
          cached: inline.cached,
          ...(inline.overTarget ? { overTarget: true } : {}),
        };
        if (entry.bytes === null) entry.bytes = inline.sourceBytes;
        if (entry.width === null) entry.width = inline.sourceWidth;
        if (entry.height === null) entry.height = inline.sourceHeight;
      }
    }
    out.push(entry);
  }

  const next = offset + limit < all.length ? encodeCursor(key, offset + limit) : null;
  const result: Obj = {
    delivery,
    ...body,
    images: out,
    shown: out.length,
    total: all.length,
    ...(next ? { nextCursor: next } : {}),
    ...(delivery !== 'inline' || linkFallback ? { howToView: HOW_TO_VIEW } : {}),
    ...(notFound.length ? { notFound } : {}),
    ...(notes.length ? { notes } : {}),
    authorityFrom: index.available
      ? {
          from: 'the bridge’s asset reference and full-text index (the newest snapshot), never LegendKeeper’s search',
          newestSnapshot:
            index.source.newestSnapshotAt !== null
              ? new Date(index.source.newestSnapshotAt).toISOString()
              : null,
          ...(live.size ? { readLive: [...live.values()].map((p) => p.name) } : {}),
          note: 'The authority text governs: read each image together with it.',
        }
      : { unavailable: index.source.reason ?? 'no index' },
    reads: { live: reads, downloads, cacheHits },
    cost: COST_LINE,
  };
  if (delivery !== 'link' && images.length > 0) result.inlineImages = images.length;
  const rendered = fitResult(result, pd);
  return { ...rendered, content: [...rendered.content, ...images] };
}

/** The rendered JSON, its later authority texts dropped when it would pass the result limit (said per page). */
function fitResult(result: Obj, pd: ProjectDeps): McpToolResult {
  let r = render(result, pd);
  const first = r.content[0];
  if (!first || first.type !== 'text' || first.text.length <= pd.settings.resultMaxChars) return r;
  for (const im of result.images as Obj[]) {
    const a = im.authority as { pages?: Obj[] };
    for (const [i, p] of (a.pages ?? []).entries())
      if (i > 0 && typeof p.text === 'string') {
        p.text = '';
        p.textOmitted = 'the result’s size: call with asset for this image alone';
      }
  }
  r = render(result, pd);
  return r;
}

/** The character's art in its folder's order: design pieces, then Wardrobe's loose pieces, its outfits, legacy folders. */
function layoutTargets(
  layout: ArtLayout,
  designOnly: boolean,
  fromItem: (it: LibItem, group?: string) => Target | null,
): Target[] {
  const out: (Target | null)[] = layout.root.map((it) => fromItem(it, 'design'));
  if (!designOnly) {
    out.push(...layout.loose.map((it) => fromItem(it, layout.wardrobe?.name ?? 'Wardrobe')));
    for (const f of [...layout.outfitFolders].sort((a, b) => a.name.localeCompare(b.name)))
      out.push(...f.items.map((it) => fromItem(it, f.name)));
    for (const l of layout.legacy) out.push(...l.items.map((it) => fromItem(it, l.name)));
  }
  return out.filter((t): t is Target => t !== null);
}

function indexOf(ctx: RepoCtx, hit: CharacterHit): TreeNode | null {
  const node = ctx.tree.node(ctx.projectId, hit.identity.id).data;
  const parent = node?.parentId ? ctx.tree.node(ctx.projectId, node.parentId).data : null;
  const subject = hit.subject || subjectOf(hit.identity.displayName, null);
  return parent && parent.kind === 'index' && nameKey(parent.displayName) === nameKey(subject)
    ? parent
    : null;
}

type Inline =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly mimeType: string;
      readonly format: string;
      readonly width: number;
      readonly height: number;
      readonly overTarget: boolean;
      readonly sourceBytes: number;
      readonly sourceWidth: number;
      readonly sourceHeight: number;
      readonly cached: boolean;
      readonly downloaded: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly cached: false; readonly downloaded: boolean };

/** One image's inline derivative: from the cache (free), else downloaded (one read) and resized, then cached. */
async function deliverInline(
  pd: ProjectDeps,
  mctx: McpToolContext,
  t: Target,
  o: {
    readonly cache: ArtCache | undefined;
    readonly lk: LkClient | undefined;
    readonly costs: CostSpec;
    readonly hosts: readonly string[];
  },
): Promise<Inline> {
  const id = t.assetId ?? `url:${t.url}`;
  const hit = o.cache ? await o.cache.get(id, t.url) : null;
  if (hit)
    return {
      ok: true,
      bytes: hit.bytes,
      mimeType: hit.meta.mimeType,
      format: hit.meta.format,
      width: hit.meta.width,
      height: hit.meta.height,
      overTarget: hit.meta.overTarget,
      sourceBytes: hit.meta.source.bytes,
      sourceWidth: hit.meta.source.width,
      sourceHeight: hit.meta.source.height,
      cached: true,
      downloaded: false,
    };
  if (!o.lk) return { ok: false, reason: 'the project is not served now', cached: false, downloaded: false };
  let original: Buffer;
  try {
    const got = await downloadAsset(o.lk, t.url, {
      hosts: o.hosts,
      priority: 'P1',
      opId: DOWNLOAD_OP,
      signal: mctx.signal,
      costs: o.costs,
    });
    original = got.bytes;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      cached: false,
      downloaded: false,
    };
  }
  try {
    const d = await deriveInline(original, {
      maxPixels: pd.settings.images.maxPixels,
      timeoutMs: pd.settings.images.convertTimeoutMs,
      ...(ART_VIEW_LIMITS.maxBytes !== undefined ? { maxBytes: ART_VIEW_LIMITS.maxBytes } : {}),
    });
    if (o.cache)
      await o.cache.put(
        {
          assetId: id,
          url: t.url,
          format: d.format,
          mimeType: d.mimeType,
          width: d.width,
          height: d.height,
          quality: d.quality,
          source: d.source,
          overTarget: d.overTarget,
        },
        d.bytes,
      );
    return {
      ok: true,
      bytes: d.bytes,
      mimeType: d.mimeType,
      format: d.format,
      width: d.width,
      height: d.height,
      overTarget: d.overTarget,
      sourceBytes: d.source.bytes,
      sourceWidth: d.source.width,
      sourceHeight: d.source.height,
      cached: false,
      downloaded: true,
    };
  } catch (e) {
    return {
      ok: false,
      reason: `downloaded, but ${e instanceof Error ? e.message : String(e)}`,
      cached: false,
      downloaded: true,
    };
  }
}
