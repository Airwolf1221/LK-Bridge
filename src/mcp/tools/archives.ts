/**
 * v3 F7c (ADR 0075; the owner-approved design LK-Bridge-F7c-art-archives-design.md): the image archive tools.
 *
 * - `upload_image_archive` (W): a zip of images, from ChatGPT's `file` (declared in `openai/fileParams`) or a prepared
 *   binary upload (`upload_id`). Every entry is listed at once (Z9.1) with its folder and the folder's suggested outfit
 *   (Z10); with `character`, each folder is checked against that character's outfits. Nothing is converted until an
 *   art call uses an entry, or `stageAll: true`. Staging only: nothing is proposed and nothing reaches LegendKeeper.
 * - `bridge_archive_status` (free, read): the rows of one archive, or this connection's recent archives; `retry`
 *   retries failed entries.
 */
import { rename } from 'node:fs/promises';
import * as z from 'zod';
import { ArchiveError } from '../../images/archive-zip.js';
import { suggestedOutfitOf } from '../../images/archives.js';
import type { ImageService } from '../../images/service.js';
import { ZIP_CONTENT_TYPE } from '../../images/slots.js';
import { archiveOutfitHints } from '../../packs/character-tools.js';
import { readOnlyReason } from '../../policy/gate.js';
import { currentFrame } from '../../workstreams/context.js';
import type { McpToolContext, McpToolProvider } from '../server.js';
import { withRequest, type CreateOutcome } from './create-support.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { operationIdArg } from './resources.js';
import {
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';
import { fetchToFile, UploadHttpError } from './upload-http.js';
import { FILE_URL_EXPIRED_HINT } from './upload-source.js';

const TOOL = 'upload_image_archive';

/** Z8: what every answer says about using the rows. */
export const ARCHIVE_GUIDANCE = [
  'Look at the images yourself (in ChatGPT, open the zip in your own code tool and write each image’s interpretation).',
  'Then call arkona_add_character_art with images given as { "archive": { "id": "<archive_id>", "entry": "<entry>" }, "label": …, "interpretation": … }; an entry is converted only when a call uses it.',
  'A folder is a suggestion: look at the images; use suggestedOutfit when it fits. For each top-level image, decide yourself whether it is a design piece or a single-piece outfit (no outfit is guessed for it); if you are unsure, ask the owner.',
  'Held entries finish on their own: never upload them again; follow bridge_archive_status.',
];

const fileArg = z
  .object({
    download_url: z.string().min(1).max(8192),
    file_id: z.string().min(1).max(256),
    mime_type: z.string().max(200).optional(),
    file_name: z.string().max(500).optional(),
  })
  .strict();

function svcOf(pd: ProjectDeps): ImageService | null {
  return pd.services?.images ?? null;
}

const unavailable = (pd: ProjectDeps) =>
  errorResult(
    { code: 'IMAGES_UNAVAILABLE', message: 'The image pipeline is not available on this bridge.' },
    pd,
  );

const uploadSchema = z.object({
  file: fileArg
    .optional()
    .describe(
      'In ChatGPT: the attached zip (ChatGPT fills this in). The bridge downloads it during the call.',
    ),
  upload_id: z
    .string()
    .max(64)
    .optional()
    .describe(
      'A zip received by the binary endpoint (prepare_image_upload with content_type application/zip).',
    ),
  character: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Optional: a character (name, alias or id). Each folder of the zip is then checked against its outfits (outfitMatch: exact, near or new). Costs a live read of its asset folders.',
    ),
  stageAll: z
    .boolean()
    .optional()
    .describe('true: convert and stage every entry now, rather than only those an art call uses.'),
  operation_id: operationIdArg,
  project: projectArg,
});
type UploadArgs = z.infer<typeof uploadSchema>;

export function archiveTools(deps: ToolDeps): McpToolProvider[] {
  return [
    defineTool({
      name: TOOL,
      title: 'Upload an image archive (zip) for staging',
      access: 'write',
      description:
        'Stages art in bulk from ONE zip of images (PNG, JPEG, GIF or WebP; other files, __MACOSX and hidden files are refused or skipped; nested archives and encrypted entries are refused). In ChatGPT: attach the zip and pass it as `file` (ChatGPT fills it in); open the same zip in your own code tool to look at each image and write its interpretation. Elsewhere: prepare_image_upload with the zip (content_type application/zip), run its script, then call this with `upload_id`. ' +
        'Every entry is listed at once: its `entry` (base name), `path`, `folder` (null at the top level), `suggestedOutfit` (the folder name for display), format, size and SHA-256. Nothing is converted until an art call uses an entry, or `stageAll: true`. Then call arkona_add_character_art with images given as { "archive": { "id": archive_id, "entry": entry } }; one archive can feed several calls, and one call can draw from several archives. ' +
        'A folder is only a suggestion: look at the images; for each top-level image decide yourself whether it is a design piece or a single-piece outfit. With `character`, each folder is checked against that character’s outfits (`outfitMatch`: exact, near with its candidates, or new). ' +
        'The same zip again returns the same archive_id and entries (nothing is staged twice). An entry past the hourly brake or the staging capacity is `held` (with heldBy and expectedAt) and finishes on its own: never upload it again; follow bridge_archive_status. Staging only: nothing is proposed and nothing reaches LegendKeeper. Cost: nothing in LegendKeeper (with `character`, a live read of its asset folders).',
      inputSchema: uploadSchema,
      meta: { 'openai/fileParams': ['file'] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) => {
          const svc = svcOf(pd);
          if (!svc) return unavailable(pd);
          if (mctx.scope === 'read')
            return errorResult(
              { code: 'POLICY_DENIED', message: readOnlyReason(mctx.principal?.profile ?? 'this profile') },
              pd,
            );
          if ((args.file === undefined) === (args.upload_id === undefined))
            return errorResult(
              { code: 'INVALID_REQUEST', message: 'Give exactly one source: file (ChatGPT) or upload_id.' },
              pd,
            );
          // A ChatGPT link is a capability that changes with every link: the request's hash names the file by its id.
          const hashed = args.file
            ? {
                ...args,
                file: {
                  file_id: args.file.file_id,
                  ...(args.file.file_name ? { file_name: args.file.file_name } : {}),
                },
              }
            : args;
          return withRequest(pd, mctx, TOOL, hashed, null, () => uploadArchive(pd, mctx, svc, args));
        }),
    }),
    defineTool({
      name: 'bridge_archive_status',
      title: 'Image archive status',
      access: 'read',
      description:
        'Free (no LegendKeeper request). The rows of an image archive (`archive_id`): each entry’s status (listed, queued with its queuePosition, converting, held with heldBy rate|storage and expectedAt, staged with staged_id, refused or failed with the reason, duplicate with duplicateOf, discarded), and the three limits kept apart: holding (the staging capacity), processing (conversions at once) and the hourly brake; LegendKeeper’s own budgets are bridge_budget’s. Without archive_id: this connection’s recent archives. `retry`: entries that failed (by entry or path) are converted again; nothing already staged is redone. Held entries finish on their own: never upload them again.',
      inputSchema: z.object({
        archive_id: z.string().min(1).max(64).optional(),
        retry: z
          .array(z.string().min(1).max(1000))
          .min(1)
          .max(300)
          .optional()
          .describe('Failed entries to convert again (needs archive_id, and write or propose scope).'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', (pd) => {
          const svc = svcOf(pd);
          if (!svc) return unavailable(pd);
          const archives = svc.archives;
          const principal = mctx.principal?.principalId;
          if (args.archive_id === undefined) {
            if (args.retry)
              return errorResult({ code: 'INVALID_REQUEST', message: 'retry needs archive_id.' }, pd);
            const mine = principal ? archives.store.byPrincipal(principal, pd.project.id, 10) : [];
            return render(
              {
                archives: mine.map((a) => {
                  const { rows: _rows, ...rest } = archives.archiveView(a);
                  void _rows;
                  return rest;
                }),
                limits: archives.limitsView(principal),
                ...(mine.length === 0
                  ? {
                      note: 'This connection has no archives in this project (upload one with upload_image_archive).',
                    }
                  : { hint: 'Give archive_id for the rows.' }),
              },
              pd,
            );
          }
          const a = archives.store.archive(args.archive_id);
          if (!a || a.projectId !== pd.project.id)
            return errorResult(
              { code: 'ARCHIVE_NOT_FOUND', message: `No archive ${args.archive_id} in this project.` },
              pd,
            );
          let retried: unknown;
          if (args.retry) {
            if (mctx.scope === 'read')
              return errorResult(
                { code: 'POLICY_DENIED', message: readOnlyReason(mctx.principal?.profile ?? 'this profile') },
                pd,
              );
            retried = archives.retry(a.id, args.retry);
          }
          return render(
            {
              ...archives.archiveView(archives.store.archive(a.id)!),
              ...(retried ? { retried } : {}),
              limits: archives.limitsView(principal),
              guidance: ARCHIVE_GUIDANCE,
            },
            pd,
          );
        }),
    }),
  ];
}

async function uploadArchive(
  pd: ProjectDeps,
  mctx: McpToolContext,
  svc: ImageService,
  args: UploadArgs,
): Promise<CreateOutcome> {
  const answerError = (
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): CreateOutcome => ({
    kind: 'answer',
    result: errorResult({ code, message, ...extra }, pd),
  });
  const principal = mcpOrigin(mctx, TOOL).principal!.principalId;
  const archives = svc.archives;
  const limit = svc.settings.images.archiveMaxUncompressedBytes;
  let tmp: string;
  let source: 'chatgpt_file' | 'upload_id';
  let fileName: string | null;
  let consume: (() => Promise<unknown>) | null = null;
  if (args.upload_id !== undefined) {
    source = 'upload_id';
    const id = args.upload_id;
    if (!svc.slots.hold(id))
      return answerError('UPLOAD_ID_USED', `Upload ${id} is being used by another call at this moment.`);
    try {
      const slot = svc.slots.slotFor(id, pd.project.id, principal);
      if (!slot)
        return answerError(
          'UPLOAD_ID_UNKNOWN',
          `No upload ${id} was prepared by this connection in this project. Call prepare_image_upload first (content_type application/zip).`,
        );
      if (slot.contentType !== ZIP_CONTENT_TYPE)
        return answerError(
          'UPLOAD_NOT_AN_ARCHIVE',
          `Upload ${id} was prepared for an image (${slot.contentType}), not a zip: use upload_image with it.`,
        );
      if (slot.state === 'prepared' || slot.state === 'receiving')
        return answerError(
          'UPLOAD_NOT_RECEIVED',
          'The zip has not been received yet: run the script, then call again.',
        );
      if (slot.state === 'consumed')
        return answerError(
          'UPLOAD_ID_USED',
          `Upload ${slot.id} was already used; each upload_id works once.`,
        );
      const path = svc.slots.receivedPath(slot);
      if (!path)
        return answerError('UPLOAD_EXPIRED', `Upload ${slot.id} expired (a received file waits 15 minutes).`);
      tmp = await archives.tempPath();
      await rename(path, tmp);
      fileName = slot.name;
      consume = () => svc.slots.consume(slot);
    } finally {
      svc.slots.release(id);
    }
  } else {
    source = 'chatgpt_file';
    const f = args.file!;
    if (!svc.fileSourceEnabled(pd.project.id))
      return answerError(
        'UPLOAD_FILE_SOURCE_DISABLED',
        'ChatGPT’s file source is switched off for this project (the owner’s setting fileSourceEnabled); use prepare_image_upload with the zip, or ask the owner.',
      );
    fileName = f.file_name ?? null;
    tmp = await archives.tempPath();
    try {
      await fetchToFile(f.download_url, tmp, {
        ...(pd.uploadGuard ?? {}),
        maxBytes: limit,
        timeoutMs: Math.max(pd.settings.upload.fetchTimeoutMs, pd.settings.upload.putTimeoutMs ?? 120_000),
        signal: mctx.signal,
        maxRedirects: 3,
      });
    } catch (e) {
      if (e instanceof UploadHttpError) {
        if (e.reason === 'bad_status' && [401, 403, 404, 410].includes(e.status ?? 0))
          return answerError(
            'FILE_URL_EXPIRED',
            `The file's link no longer works (HTTP ${String(e.status)}): ChatGPT's file links are temporary.`,
            { hint: FILE_URL_EXPIRED_HINT.replace('upload_image', TOOL).replace('the image', 'the zip') },
          );
        if (e.reason === 'too_large')
          return answerError(
            'ARCHIVE_TOO_LARGE',
            `The zip is larger than IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES (${limit} bytes). Nothing was staged: split it.`,
          );
        if (['blocked_address', 'blocked_port', 'invalid_url', 'redirect'].includes(e.reason))
          return answerError('UPLOAD_URL_REFUSED', `The file's link was refused: ${e.message}`);
        return answerError('UPLOAD_URL_FAILED', `The zip could not be downloaded: ${e.message}`);
      }
      throw e;
    }
  }
  let got: Awaited<ReturnType<typeof archives.ingest>>;
  try {
    got = await archives.ingest({
      projectId: pd.project.id,
      principalId: principal,
      source,
      fileName,
      tmpPath: tmp,
      workstream: currentFrame()?.label ?? null,
    });
  } catch (e) {
    if (consume) await consume().catch(() => undefined);
    if (e instanceof ArchiveError) return answerError(e.code, e.message);
    throw e;
  }
  if (consume) await consume().catch(() => undefined);
  if (args.stageAll === true) archives.request(got.archive.id, 'all');
  const view = archives.archiveView(archives.store.archive(got.archive.id)!);
  // Z10: with a character, each distinct folder against its outfits (top-level entries are never classified).
  let character: Record<string, unknown> | undefined;
  let rows = view.rows as Record<string, unknown>[];
  if (args.character !== undefined) {
    const folders = [...new Set(got.entries.map((e) => e.folder).filter((f): f is string => f !== null))].map(
      (raw) => ({ raw, display: suggestedOutfitOf(raw) }),
    );
    const hints = await archiveOutfitHints(pd, mctx, TOOL, args.character, folders);
    if (hints.resolved) {
      character = {
        resolved: true,
        id: hints.character.id,
        name: hints.character.name,
        liveReads: hints.liveReads,
      };
      rows = rows.map((r) => {
        const m = typeof r.folder === 'string' ? hints.folders.get(r.folder) : undefined;
        return m ? { ...r, ...m } : r;
      });
    } else character = { resolved: false, given: args.character, reason: hints.reason };
  }
  const body = {
    ...view,
    rows,
    repeat: got.repeat,
    ...(got.repeat
      ? { note: 'This zip was uploaded before: the same archive and entries; nothing is staged twice.' }
      : {}),
    ...(character ? { character } : {}),
    ...(args.stageAll === true ? { stageAll: true } : {}),
    limits: archives.limitsView(principal),
    guidance: ARCHIVE_GUIDANCE,
  };
  return { kind: 'answer', result: render(body, pd), final: body };
}
