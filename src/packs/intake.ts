/**
 * Image intake for a setting pack's art (v3 F3b, ADR 0052; design section 3): an image given as a ChatGPT conversation
 * attachment (`file`) or a prepared binary upload (`upload_id`) is staged on the bridge's server exactly as
 * `upload_image { stage: true }` with no destination stages it (v3 F2, ADR 0049 decision 10): converted to WebP, kept
 * on the bridge's disk, nothing sent to LegendKeeper and nothing proposed. The package then places it like any staged
 * image, on the owner's approval. The same original sent again is the same staged image (deduplicated by its hash).
 */
import { ImageError, displayNameOf } from '../images/convert.js';
import { ImageServiceError } from '../images/service.js';
import type { UploadSource } from '../images/store.js';
import type { McpToolContext } from '../mcp/server.js';
import type { ProjectDeps } from '../mcp/tools/shape.js';
import { FILE_URL_EXPIRED_HINT, resolveImage, UploadSourceError } from '../mcp/tools/upload-source.js';
import { mcpOrigin } from '../policy/mcp.js';
import type { PackageImage } from './engine/plan.js';

/** A ChatGPT conversation attachment as ChatGPT fills a declared file parameter (ADR 0049 decision 11). */
export interface ChatGptFile {
  readonly download_url: string;
  readonly file_id: string;
  readonly mime_type?: string | undefined;
  readonly file_name?: string | undefined;
}

export type IntakeResult =
  | { readonly ok: true; readonly stagedId: string; readonly deduplicated: boolean; readonly source: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

/** Stages one image (see the module comment). `name` is the staged record's name (the image's label). */
export async function stageForPack(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  src: { readonly upload_id: string } | { readonly file: ChatGptFile },
  name: string,
): Promise<IntakeResult> {
  const svc = pd.services?.images;
  if (!svc) return { ok: false, code: 'TOOL_UNAVAILABLE', message: 'Images cannot be staged here.' };
  const origin = mcpOrigin(mctx, tool);
  const principal = origin.principal?.principalId ?? 'system';
  let bytes: Buffer;
  let source: UploadSource;
  let slot: ReturnType<typeof svc.slots.slotFor> = null;
  let seen: string;
  try {
    if ('upload_id' in src) {
      source = 'upload_id';
      seen = `upload ${src.upload_id}`;
      slot = svc.slots.slotFor(src.upload_id, pd.project.id, principal);
      if (!slot)
        return {
          ok: false,
          code: 'UPLOAD_ID_UNKNOWN',
          message: `No upload ${src.upload_id} was prepared by this connection in this project. Call prepare_image_upload first.`,
        };
      if (slot.state === 'prepared' || slot.state === 'receiving')
        return {
          ok: false,
          code: 'UPLOAD_NOT_RECEIVED',
          message:
            'The file has not been received yet: run the script prepare_image_upload gave, then call again.',
        };
      if (slot.state === 'consumed')
        return {
          ok: false,
          code: 'UPLOAD_ID_USED',
          message: `Upload ${slot.id} was already used (each upload_id works once); its image is staged: pass its staged_id.`,
        };
      const b = slot.state === 'received' ? await svc.slots.read(slot) : null;
      if (!b)
        return {
          ok: false,
          code: 'UPLOAD_EXPIRED',
          message: `Upload ${slot.id} expired (a received file waits 15 minutes) or was refused. Prepare a new one.`,
        };
      bytes = b;
    } else {
      source = 'chatgpt_file';
      seen = `file ${src.file.file_id}`;
      const img = await resolveImage(
        { fileUrl: src.file.download_url },
        { ...pd.settings.upload, allowFileSource: svc.fileSourceEnabled(pd.project.id) },
        pd.uploadGuard,
        mctx.signal,
      );
      bytes = Buffer.from(img.dataBase64, 'base64');
    }
  } catch (e) {
    if (e instanceof UploadSourceError)
      return {
        ok: false,
        code: e.code,
        message: e.message,
        ...(e.code === 'FILE_URL_EXPIRED' ? { details: { hint: FILE_URL_EXPIRED_HINT } } : {}),
      };
    throw e;
  }
  let converted;
  try {
    converted = await svc.convert(bytes);
  } catch (e) {
    if (e instanceof ImageError) return { ok: false, code: e.code, message: e.message, details: e.details };
    throw e;
  }
  const dup = svc.findDuplicate(pd.project.id, converted.source.sha256);
  if (dup) {
    if (slot) await svc.slots.consume(slot);
    if (dup.staged && dup.serverSha256 && dup.state === 'uploaded')
      return { ok: true, stagedId: dup.id, deduplicated: true, source: seen };
    return {
      ok: false,
      code: 'IMAGE_ALREADY_IN_LIBRARY',
      message: `This image was uploaded before (${dup.id}${dup.assetId ? `, asset ${dup.assetId}` : ''}, ${dup.state}); the same original is never uploaded twice. Put the existing asset on the Art page with write_page, or ask the owner.`,
      details: { existing: { staged_id: dup.id, assetId: dup.assetId, folder: dup.folderPath } },
    };
  }
  try {
    const row = await svc.stageOnServer({
      projectId: pd.project.id,
      image: converted,
      name: displayNameOf(name),
      description: undefined,
      intended: null,
      source,
      origin,
    });
    if (slot) await svc.slots.consume(slot);
    return { ok: true, stagedId: row.id, deduplicated: false, source: seen };
  } catch (e) {
    if (e instanceof ImageServiceError)
      return { ok: false, code: e.code, message: e.message, details: e.details };
    throw e;
  }
}

// ============================================================================================ archive entries (v3 F7c)

/** v3 F7c (ADR 0075, Z4): an art image given as an entry of an image archive. */
export interface ArchiveImageRef {
  readonly id: string;
  readonly entry: string;
}

/** v3 F7c: an archive image resolved for a package, or why it cannot be used (that image only; never the others). */
export type ArchiveImageResult =
  | {
      readonly ok: true;
      readonly image: PackageImage;
      readonly staged: boolean;
      readonly entry: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * v3 F7c (ADR 0075, Z4): `{ archive: { id, entry } }` as a package image. A staged entry is its staged image (exactly
 * like its staged_id). Any other entry still stageable is asked for and given its reserved staged id; the image is
 * planned from its header (`pending`), and the package's job waits for it. A refused, discarded or failed entry is
 * not available (the caller leaves that image out with the reason and goes on with the others).
 */
export function archiveImage(
  pd: ProjectDeps,
  ref: ArchiveImageRef,
  label: string,
  interpretation: string | undefined,
): ArchiveImageResult {
  const svc = pd.services?.images;
  if (!svc) return { ok: false, code: 'IMAGES_UNAVAILABLE', message: 'The image pipeline is not available.' };
  const r = svc.archives.forArt(pd.project.id, ref);
  if (r.kind === 'unavailable') return { ok: false, code: r.code, message: r.message };
  const base = {
    staged_id: r.stagedId,
    label,
    ...(interpretation !== undefined ? { interpretation } : {}),
  };
  if (r.kind === 'staged') return { ok: true, image: base, staged: true, entry: r.entry.path };
  const e = r.entry;
  const a = svc.archives.store.archive(e.archiveId)!;
  return {
    ok: true,
    staged: false,
    entry: e.path,
    image: {
      ...base,
      pending: {
        archiveId: e.archiveId,
        path: e.path,
        format: e.format ?? 'unknown',
        width: e.width ?? 0,
        height: e.height ?? 0,
        frames: e.frames ?? 1,
        bytes: e.bytes,
        sha256: e.sha256 ?? '',
        principalId: a.principalId,
      },
    },
  };
}

/** v3 F7c: an art image as a tool receives it (one source: staged_id, upload_id, archive, or the attached file). */
export interface ArtImageIn {
  readonly staged_id?: string | undefined;
  readonly upload_id?: string | undefined;
  readonly archive?: ArchiveImageRef | undefined;
  readonly label: string;
  readonly interpretation?: string | undefined;
}

/** v3 F7c: an art image after its archive entry (if any) was resolved. */
export interface ArtImageOut {
  readonly staged_id?: string | undefined;
  readonly upload_id?: string | undefined;
  readonly label: string;
  readonly interpretation?: string | undefined;
  readonly pending?: PackageImage['pending'];
}

/**
 * v3 F7c (ADR 0075, Z4): a call's images with every `archive` image resolved: those that cannot be used are left out,
 * each with its reason (`notUsed`), and the others go ahead.
 */
export function resolveArchiveImages(
  pd: ProjectDeps,
  images: readonly ArtImageIn[],
): {
  readonly images: ArtImageOut[];
  readonly notUsed: { label: string; archive: ArchiveImageRef; code: string; reason: string }[];
  readonly fromArchives: { label: string; archive: ArchiveImageRef; staged_id: string; staged: boolean }[];
} {
  const out: ArtImageOut[] = [];
  const notUsed: { label: string; archive: ArchiveImageRef; code: string; reason: string }[] = [];
  const fromArchives: { label: string; archive: ArchiveImageRef; staged_id: string; staged: boolean }[] = [];
  for (const im of images) {
    if (!im.archive) {
      out.push(im);
      continue;
    }
    const r = archiveImage(pd, im.archive, im.label, im.interpretation);
    if (!r.ok) {
      notUsed.push({ label: im.label, archive: im.archive, code: r.code, reason: r.message });
      continue;
    }
    out.push(r.image);
    fromArchives.push({
      label: im.label,
      archive: im.archive,
      staged_id: r.image.staged_id,
      staged: r.staged,
    });
  }
  return { images: out, notUsed, fromArchives };
}
