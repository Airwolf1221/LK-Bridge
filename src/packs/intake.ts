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
          message: 'The file has not been received yet: run the script prepare_image_upload gave, then call again.',
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
        pd.settings.upload,
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
    if (e instanceof ImageServiceError) return { ok: false, code: e.code, message: e.message, details: e.details };
    throw e;
  }
}
