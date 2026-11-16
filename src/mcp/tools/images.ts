/**
 * The image tools (v2 D3, ADR 0041; PLAN-v2 section 5, the Assets row):
 *
 * - `upload_image` (W): exactly one source (`data_base64`, `url`, `upload_id` or `staged_id`), the WebP pipeline, and a
 *   destination from the asset tree and the type registry; or `stage: true`. Everything runs as a job, or a proposal at
 *   scope `propose`: there the image is staged (uploaded, verified, hidden) and its PLACEMENT is the proposal, so the
 *   proposal holds no image bytes.
 * - `prepare_image_upload` (W): a single-use capability for the binary endpoint (`POST /uploads/<upload_id>`), with
 *   ready-made Python and curl scripts for agents with a shell.
 */
import * as z from 'zod';
import type { AssetPlan } from '../../assets/plan.js';
import { ImageError, displayNameOf, type ConvertedImage } from '../../images/convert.js';
import type { DestinationInput } from '../../images/destination.js';
import { ImageServiceError, type ImageService } from '../../images/service.js';
import { CAPABILITY_SCHEME } from '../../images/slots.js';
import type { ImageUploadRow, UploadSource } from '../../images/store.js';
import type { JobView } from '../../jobs/index.js';
import { readOnlyReason } from '../../policy/gate.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { withRequest, type CreateOutcome } from './create-support.js';
import { defineTool } from './define.js';
import { liveRead } from './repo.js';
import { operationIdArg } from './resources.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';
import { FILE_URL_EXPIRED_HINT, resolveImage, UploadSourceError } from './upload-source.js';

const TOOL = 'upload_image';
const name200 = z.string().trim().min(1).max(200);

const destinationArg = z
  .object({
    folder: z
      .union([z.string().min(1).max(2000), z.array(name200).min(1).max(20)])
      .optional()
      .describe(
        'An asset folder id, or a path from the library’s root such as "Characters / Beastkin / Qishen / Mehrana al-Khalid" ' +
          '(or a list of folder names). Missing folders are created.',
      ),
    for_page: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe(
        'A page by name or id. A character’s page (Core, Reference or index, Working or Archived included) or one of its specialist pages (“{name} - Art”) gives the character’s folder, the race read from its Race / Species fact; any other page also needs folder.',
      ),
    for_character: z
      .object({
        name: name200.describe('The character’s name.'),
        race: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe(
            'As in create_character. Omitted or unknown: Undetermined / Unknown. A race that does not resolve fails.',
          ),
        type: z.string().min(1).max(100).optional(),
      })
      .strict()
      .optional()
      .describe(
        'The character’s folder (an existing one reused wherever it is), else Characters / Group / Race / Name.',
      ),
    subfolders: z
      .union([z.string().min(1).max(2000), z.array(name200).max(10)])
      .optional()
      .describe(
        'Literal folders appended to the derived path, in order: a list of names, or ONE path written like the folder chain, ' +
          'for example "Wardrobe" or "Wardrobe / Qipao" (Qipao inside Wardrobe). An empty part, "." and ".." are refused. ' +
          'Existing folders are reused, missing ones created in order, a non-folder of the same name is a conflict.',
      ),
  })
  .strict();

const WAIT = z
  .number()
  .int()
  .min(0)
  .max(25)
  .optional()
  .describe('How long to wait for the result. Default 10.');

/** The Race / Species fact of a live getResource answer: the text of the row, or null (no such row, or it is empty). */
function raceFactOf(resource: unknown, rowName: string): string | null {
  const props = (resource as { properties?: unknown } | null)?.properties;
  if (!Array.isArray(props)) return null;
  const want = rowName.trim().toLowerCase();
  for (const p of props) {
    const block = p as { kind?: unknown; rows?: unknown };
    if (block.kind !== 'keyValue' || !Array.isArray(block.rows)) continue;
    for (const r of block.rows as { key?: unknown; text?: unknown; content?: unknown }[]) {
      if (typeof r.key !== 'string' || r.key.trim().toLowerCase() !== want) continue;
      const t =
        typeof r.text === 'string'
          ? r.text
          : Array.isArray(r.content)
            ? (r.content as { text?: unknown }[])
                .map((c) => (typeof c.text === 'string' ? c.text : ''))
                .join('')
            : '';
      return t.trim() === '' ? null : t.trim();
    }
  }
  return null;
}

/**
 * Plans a destination (v2 E3b, ADR 0045). A `for_page` that leads to a character whose Race / Species the repository tree
 * does not hold (`RACE_NOT_READ`) costs ONE live read of that character's Core or Reference, then plans again with it.
 * When that read cannot be made or says nothing, the first answer stands: it says exactly what to pass instead.
 */
async function planDestination(
  pd: ProjectDeps,
  mctx: McpToolContext,
  svc: ImageService,
  dest: DestinationInput,
): Promise<ReturnType<ImageService['plan']>> {
  const first = svc.plan(pd.project.id, dest);
  if (first.ok || first.error.code !== 'RACE_NOT_READ') return first;
  const coreId = (first.error.details?.core as { id?: unknown } | undefined)?.id;
  if (typeof coreId !== 'string') return first;
  const read = await liveRead(pd, mctx, TOOL, 'getResource', { path: { resourceId: coreId } });
  if (!read.ok) return first;
  const speciesRow =
    pd.services?.registry
      .forProject(pd.project.id)
      .store.listTypes()
      .find((t) => t.placementKind === 'character' && t.placement)?.placement?.speciesRow ?? 'Race / Species';
  return svc.plan(pd.project.id, {
    ...dest,
    pageRace: { core: coreId, race: raceFactOf(read.value, speciesRow) },
  });
}

function svcOf(pd: ProjectDeps): ImageService | null {
  return pd.services?.images ?? null;
}

const unavailable = (pd: ProjectDeps) =>
  errorResult(
    { code: 'IMAGES_UNAVAILABLE', message: 'The image pipeline is not available on this bridge.' },
    pd,
  );

function imageFacts(img: ConvertedImage) {
  return {
    originalFormat: img.source.format,
    originalBytes: img.source.bytes,
    originalSha256: img.source.sha256,
    width: img.output.width,
    height: img.output.height,
    frames: img.output.frames,
    hasAlpha: img.output.hasAlpha,
    webpBytes: img.output.bytes,
    webpSha256: img.output.sha256,
    conversion: img.mode,
    ...(img.quality !== null ? { quality: img.quality } : {}),
    ...(img.source.orientation !== null && img.source.orientation !== 1
      ? { orientationApplied: img.source.orientation }
      : {}),
    convertMs: img.ms,
  };
}

function rowFacts(r: ImageUploadRow) {
  return {
    originalFormat: r.original.format,
    originalBytes: r.original.bytes,
    originalSha256: r.original.sha256,
    width: r.width,
    height: r.height,
    frames: r.frames,
    hasAlpha: r.hasAlpha,
    webpBytes: r.webp.bytes,
    webpSha256: r.webp.sha256,
    conversion: r.conversionMode,
    ...(r.quality !== null ? { quality: r.quality } : {}),
    ...(r.original.orientation !== null && r.original.orientation !== 1
      ? { orientationApplied: r.original.orientation }
      : {}),
  };
}

function planFacts(plan: AssetPlan) {
  return {
    path: plan.destination.path,
    ...(plan.destination.folderId ? { folderId: plan.destination.folderId } : {}),
    createsFolders: plan.wouldCreate.map((s) => s.path.join(' / ')),
    ...(plan.notes.length ? { notes: plan.notes } : {}),
  };
}

/** The answer about an upload row, as it stands now. */
function rowAnswer(pd: ProjectDeps, r: ImageUploadRow, job: JobView | undefined): Record<string, unknown> {
  const asset = (job?.result as { asset?: Record<string, unknown> } | null | undefined)?.asset;
  const placed = r.state === 'uploaded' && !r.staged;
  return {
    status:
      r.state === 'uploaded'
        ? r.staged
          ? 'staged'
          : 'uploaded'
        : r.state === 'failed'
          ? 'failed'
          : job?.status === 'waiting_budget'
            ? 'waiting_budget'
            : 'queued',
    ...(r.staged || r.placedAt !== null ? { staged_id: r.id } : {}),
    ...(r.staged && r.serverSha256 ? { onServer: true } : {}),
    ...(r.assetId
      ? {
          asset: {
            id: r.assetId,
            name: r.name,
            ...(typeof asset?.url === 'string' ? { url: asset.url } : {}),
            folderId: r.folderId,
            ...(r.folderPath ? { folderPath: r.folderPath.join(' / ') } : {}),
            hidden: r.staged,
          },
          storedBytesVerified: r.storedVerified === true,
          ...(r.storedVerified !== true && r.verifyReason ? { unverifiedReason: r.verifyReason } : {}),
        }
      : {}),
    ...(r.jobId ? { jobId: r.jobId } : {}),
    image: rowFacts(r),
    ...(r.error ? { error: r.error } : {}),
    ...(placed && typeof asset?.url === 'string'
      ? { use: `Put it on a page with write_page: ![${r.name}](${asset.url})` }
      : {}),
  };
}

const QUEUED_HINT =
  'Accepted and NOT failed: it runs by itself. Never send it again: follow it with bridge_job_status (wait_seconds waits for it), or call upload_image with the ' +
  'same operation_id.';

// ================================================================================================ upload_image

const uploadSchema = z.object({
  data_base64: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The image bytes as base64 (a data: URI is accepted). Fine for small images; for large ones use upload_id.',
    ),
  url: z.string().max(2048).optional().describe('A public https URL of the image.'),
  upload_id: z
    .string()
    .max(64)
    .optional()
    .describe('An upload received by the binary endpoint (prepare_image_upload, then its script).'),
  staged_id: z
    .string()
    .max(64)
    .optional()
    .describe('A staged image to place (see the Staging page, or a stage: true upload).'),
  // v3 F2 (ADR 0049 decision 11): a ChatGPT conversation attachment, as ChatGPT fills it in (OpenAI Apps SDK, "Define
  // file inputs"): the bridge downloads the bytes itself, during the call.
  file: z
    .object({
      download_url: z.string().min(1).max(8192),
      file_id: z.string().min(1).max(256),
      mime_type: z.string().max(200).optional(),
      file_name: z.string().max(500).optional(),
    })
    .strict()
    .optional()
    .describe(
      'In ChatGPT: a conversation attachment (ChatGPT fills this in). The bridge downloads it during the call; its type is read from its bytes.',
    ),
  name: name200
    .optional()
    .describe(
      'The asset name; a file extension is dropped. Required with data_base64 or url; with file it defaults to the file’s name; with upload_id it defaults to the prepared name; with staged_id it renames.',
    ),
  description: z.string().max(10_000).optional(),
  destination: destinationArg.optional(),
  stage: z
    .boolean()
    .optional()
    .describe(
      'Stage instead of placing: uploaded, verified and hidden in the staging folder, to be placed later with staged_id. A destination given is kept as the intended one.',
    ),
  deduplicate: z
    .boolean()
    .optional()
    .describe(
      'Default true: the same original sent again returns the existing asset. false (with a new operation_id) uploads it again.',
    ),
  dryRun: z.boolean().optional().describe('Convert and plan, upload nothing.'),
  waitSeconds: WAIT,
  operation_id: operationIdArg,
  project: projectArg,
});
type UploadArgs = z.infer<typeof uploadSchema>;

export function imageTools(deps: ToolDeps): McpToolProvider[] {
  const max = deps.settings.upload.maxBytes;
  return [
    defineTool({
      name: TOOL,
      title: 'Upload or place an image',
      access: 'write',
      description:
        'Uploads an image as a LegendKeeper asset: converted to WebP (quality 90; orientation, transparency and animation kept), checked after storing, and filed in the right folder. Give exactly ONE source: `data_base64` (small images only: 2 MB is about 2.7 million characters), ' +
        (deps.settings.upload.allowUrlSource ? '`url` (a public https image)' : '`url` (switched off here)') +
        ', `file` (a ChatGPT conversation attachment), `upload_id` (from prepare_image_upload: for agents with a shell) or `staged_id` (an image already staged). In ChatGPT, pass a conversation attachment as `file` (ChatGPT fills it in); agents with a shell use `upload_id`; `data_base64` is for small images only. `destination`: `for_character` { name, race } (the character’s folder), `for_page` (a character’s page, Working or Archived included, or one of its specialist pages such as “{name} - Art”, gives its character’s folder; the race is read from its Race / Species fact) or `folder` (an id, or a path such as "Characters / Beastkin / Qishen / Mehrana al-Khalid"), plus `subfolders` (a list, or one path such as "Wardrobe / Qipao"); missing folders are created. dryRun lists the folders it would create. `stage: true` keeps the image hidden for later placement. The same original sent again returns the existing asset: never upload a copy to move an image. At scope propose the image is staged and its placement is the proposal. Never repeat a call that returned a jobId or proposalId. Then put the image on a page with write_page: ![alt](asset url). Example: { "data_base64": "…", "destination": { "for_character": { "name": "Asagiri Miyabi", "race": "Foxian" } }, "subfolders": "Wardrobe / Qipao", "project": "test" }. Cost: 2 writes (1 more per new folder), 1 read and 1 download to verify. PNG, JPEG, GIF or WebP up to ' +
        `${max} bytes.`,
      inputSchema: uploadSchema,
      // v3 F2 (ADR 0049 decision 11): ChatGPT replaces a conversation attachment given to `file` with a file object.
      meta: { 'openai/fileParams': ['file'] },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', (pd) => {
          const svc = svcOf(pd);
          if (!svc) return unavailable(pd);
          if (mctx.scope === 'read') {
            return errorResult(
              { code: 'POLICY_DENIED', message: readOnlyReason(mctx.principal?.profile ?? 'this profile') },
              pd,
            );
          }
          const sources = [args.data_base64, args.url, args.file, args.upload_id, args.staged_id].filter(
            (v) => v !== undefined,
          );
          if (sources.length !== 1) {
            return errorResult(
              {
                code: 'INVALID_REQUEST',
                message: 'Give exactly one source: data_base64, url, file, upload_id or staged_id.',
              },
              pd,
            );
          }
          // v3 F2: the file's name, else its own file_name (extension dropped); one is needed.
          if (args.file !== undefined && args.name === undefined && !args.file.file_name?.trim()) {
            return errorResult(
              {
                code: 'INVALID_REQUEST',
                message: 'The file has no file_name: give name (the asset’s name).',
              },
              pd,
            );
          }
          if (args.deduplicate === false && args.operation_id === undefined) {
            return errorResult(
              {
                code: 'INVALID_REQUEST',
                message:
                  'deduplicate: false uploads the same image again; give it a new operation_id, so a repeat of the call cannot upload it a third time.',
              },
              pd,
            );
          }
          if (args.staged_id !== undefined && args.stage === true) {
            return errorResult(
              {
                code: 'INVALID_REQUEST',
                message: 'staged_id places a staged image; stage: true makes no sense with it.',
              },
              pd,
            );
          }
          // The request's hash for operation_id leaves the bytes out (it covers their hash instead).
          const run = () =>
            args.staged_id !== undefined
              ? placeStaged(pd, mctx, svc, args)
              : uploadBytesOnce(pd, mctx, svc, args);
          // v3 F2: the file's download_url is a capability and changes with every link ChatGPT issues: the request's
          // hash names the file by its id instead, and the URL goes nowhere but the download.
          const hashed = args.file
            ? {
                ...args,
                file: {
                  file_id: args.file.file_id,
                  ...(args.file.file_name ? { file_name: args.file.file_name } : {}),
                },
              }
            : args;
          return withRequest(pd, mctx, TOOL, hashed, null, run);
        }),
    }),
    prepareTool(deps),
  ];
}

/**
 * v2 E4 (RV1-2): one `upload_id` is used by one call at a time. A received file is consumed only once the upload's job
 * is submitted, so two calls that read the slot together both saw it `received`; the second is now told it is in use.
 * The hold is in process (one bridge process per project, ADR 0023) and is released however the call ends.
 */
async function uploadBytesOnce(
  pd: ProjectDeps,
  mctx: McpToolContext,
  svc: ImageService,
  args: UploadArgs,
): Promise<CreateOutcome> {
  const id = args.upload_id;
  if (id === undefined) return uploadBytes(pd, mctx, svc, args);
  if (!svc.slots.hold(id)) {
    return {
      kind: 'answer',
      result: errorResult(
        {
          code: 'UPLOAD_ID_USED',
          message: `Upload ${id} is being used by another call at this moment; each upload_id works once. Follow that call's answer.`,
        },
        pd,
      ),
    };
  }
  try {
    return await uploadBytes(pd, mctx, svc, args);
  } finally {
    svc.slots.release(id);
  }
}

async function uploadBytes(
  pd: ProjectDeps,
  mctx: McpToolContext,
  svc: ImageService,
  args: UploadArgs,
): Promise<CreateOutcome> {
  const answer = (result: McpToolResult, final?: Record<string, unknown>): CreateOutcome => ({
    kind: 'answer',
    result,
    ...(final ? { final } : {}),
  });
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}) =>
    answer(errorResult({ code, message, ...extra }, pd));
  const principal = mcpOrigin(mctx, TOOL).principal!.principalId;
  const propose = mctx.scope === 'propose';

  // ---- the bytes
  let bytes: Buffer;
  let source: UploadSource;
  let name = args.name;
  let slot = null as ReturnType<ImageService['slots']['slotFor']>;
  // v3 F2: what the answer may say of a ChatGPT file: its id and its link's host (never the link).
  let fileSeen: { id: string; host: string } | null = null;
  try {
    if (args.upload_id !== undefined) {
      source = 'upload_id';
      slot = svc.slots.slotFor(args.upload_id, pd.project.id, principal);
      if (!slot) {
        return fail(
          'UPLOAD_ID_UNKNOWN',
          `No upload ${args.upload_id} was prepared by this connection in this project. Call prepare_image_upload first.`,
        );
      }
      if (slot.state === 'prepared' || slot.state === 'receiving') {
        return fail(
          'UPLOAD_NOT_RECEIVED',
          'The file has not been received yet: run the script prepare_image_upload gave, then call again.',
        );
      }
      if (slot.state === 'consumed')
        return fail('UPLOAD_ID_USED', `Upload ${slot.id} was already used; each upload_id works once.`);
      const b = slot.state === 'received' ? await svc.slots.read(slot) : null;
      if (!b) {
        return fail(
          'UPLOAD_EXPIRED',
          `Upload ${slot.id} expired (a received file waits 15 minutes) or was refused. Prepare a new one.`,
        );
      }
      bytes = b;
      name = name ?? slot.name;
    } else if (args.file !== undefined) {
      // v3 F2 (ADR 0049 decision 11): ChatGPT's file, downloaded now, at every scope (its link expires long before an
      // owner approves anything; at scope propose the bytes are staged and only the placement waits). Only the file's id
      // and the link's host are logged.
      source = 'chatgpt_file';
      name = name ?? args.file.file_name;
      let host = '';
      try {
        host = new URL(args.file.download_url).host;
      } catch {
        host = '(not a URL)';
      }
      fileSeen = { id: args.file.file_id, host };
      const img = await resolveImage(
        { fileUrl: args.file.download_url },
        pd.settings.upload,
        pd.uploadGuard,
        mctx.signal,
      );
      bytes = Buffer.from(img.dataBase64, 'base64');
    } else {
      source = args.data_base64 !== undefined ? 'data_base64' : 'url';
      if (name === undefined) return fail('INVALID_REQUEST', 'name is required with data_base64 or url.');
      const img = await resolveImage(
        { base64: args.data_base64, url: args.url },
        pd.settings.upload,
        pd.uploadGuard,
        mctx.signal,
      );
      bytes = Buffer.from(img.dataBase64, 'base64');
    }
  } catch (e) {
    if (e instanceof UploadSourceError)
      return fail(e.code, e.message, e.code === 'FILE_URL_EXPIRED' ? { hint: FILE_URL_EXPIRED_HINT } : {});
    throw e;
  }
  const displayName = displayNameOf(name!);

  // ---- conversion
  let img: ConvertedImage;
  try {
    img = await svc.convert(bytes);
  } catch (e) {
    if (e instanceof ImageError) return fail(e.code, e.message, e.details);
    throw e;
  }

  // ---- deduplication, by the original's hash
  if (args.deduplicate !== false) {
    const dup = svc.findDuplicate(pd.project.id, img.source.sha256);
    if (dup) {
      if (slot && !args.dryRun) await svc.slots.consume(slot);
      const job = dup.jobId ? pd.engine.queries.getJob(pd.project.id, dup.jobId) : undefined;
      const body = {
        ...rowAnswer(pd, dup, job),
        deduplicated: true,
        note:
          dup.state === 'uploading'
            ? 'The same image is already being uploaded; this is that upload. Nothing new was sent.'
            : `The same original was uploaded before${dup.staged ? ' (it is staged)' : ''}: this is that asset. Nothing new was uploaded. To upload it again anyway, call with deduplicate: false and a new operation_id.`,
      };
      return answer(render(body, pd), body);
    }
  }

  // ---- the destination (validated even when staging, so a bad one is refused before anything is sent)
  const stage = args.stage === true || propose;
  let intended: { destination: DestinationInput; path: readonly string[] } | null = null;
  let finalPlan: AssetPlan | null = null;
  if (args.destination) {
    const d = await planDestination(pd, mctx, svc, args.destination);
    if (!d.ok) return fail(d.error.code, d.error.message, d.error.details ?? {});
    finalPlan = d.plan;
    intended = { destination: args.destination, path: d.plan.destination.path };
  } else if (!stage) {
    return fail(
      'DESTINATION_REQUIRED',
      'Give a destination (folder, for_page or for_character), or stage: true to stage the image for placing later.',
    );
  }
  const target = stage ? svc.planStaging(pd.project.id) : null;
  if (target && !target.ok) return fail(target.error.code, target.error.message, target.error.details ?? {});
  const plan = target?.ok ? target.plan : finalPlan!;

  const head = {
    name: displayName,
    ...(fileSeen ? { file: fileSeen } : {}),
    image: imageFacts(img),
    destination: planFacts(plan),
    ...(stage
      ? { staging: true, ...(intended ? { intendedDestination: intended.path.join(' / ') } : {}) }
      : {}),
    ...(propose ? { scope: 'propose' } : {}),
  };
  if (args.dryRun) {
    const body = {
      ...head,
      status: 'dry_run',
      note:
        'Nothing was uploaded. ' +
        (propose
          ? 'At scope propose the image would be staged and its placement proposed to the owner.'
          : ''),
    };
    return answer(render(body, pd), body);
  }

  // ---- v3 F2 (ADR 0049 decision 10): staging keeps the image on the bridge's server; nothing goes to LegendKeeper.
  if (stage) {
    let staged: ImageUploadRow;
    try {
      staged = await svc.stageOnServer({
        projectId: pd.project.id,
        image: img,
        name: displayName,
        description: args.description,
        intended: intended ? { destination: intended.destination, path: intended.path } : null,
        source,
        origin: mcpOrigin(mctx, TOOL),
      });
    } catch (e) {
      if (e instanceof ImageServiceError) return fail(e.code, e.message, e.details);
      throw e;
    }
    if (slot) await svc.slots.consume(slot);
    const stagedHead = { ...head, destination: { path: [], createsFolders: [], onServer: true } };
    let body: Record<string, unknown> = { ...stagedHead, ...rowAnswer(pd, staged, undefined) };
    if (propose && intended) {
      const again = await planDestination(pd, mctx, svc, intended.destination);
      if (again.ok) {
        try {
          const placed = await svc.place({
            projectId: pd.project.id,
            row: staged,
            plan: again.plan,
            origin: mcpOrigin(mctx, TOOL),
            tool: TOOL,
            described: again.described,
          });
          if ('proposalId' in placed.submitted) {
            body = {
              ...body,
              status: 'proposal_captured',
              proposalId: placed.submitted.proposalId,
              hint:
                'The image is staged on the bridge’s server (nothing is in LegendKeeper yet). Placing it is a proposal for the owner and was NOT done: when approved, it is uploaded straight into its folder. ' +
                'Never retry it; follow it with bridge_proposal_status.',
            };
            return answer(render(body, pd), body);
          }
        } catch (e) {
          if (!(e instanceof ImageServiceError)) throw e;
          body = { ...body, placementError: { code: e.code, message: e.message } };
        }
      }
    }
    body = {
      ...body,
      hint: `Staged on the bridge’s server (nothing is in LegendKeeper until it is placed). Place it with upload_image { "staged_id": "${staged.id}"${intended ? '' : ', "destination": { … }'} }, or on the dashboard’s Staging page.`,
    };
    return answer(render(body, pd), body);
  }

  // ---- the upload job
  const started = await svc.startUpload({
    projectId: pd.project.id,
    image: img,
    name: displayName,
    description: args.description,
    plan,
    staged: stage,
    intended: stage && intended ? { destination: intended.destination, path: intended.path } : null,
    source,
    origin: mcpOrigin(mctx, TOOL),
  });
  if (!started.row) {
    // A proposal or a refusal for the upload itself (the gate refuses uploads at scope propose unless staging).
    const s = started.submitted as { proposalId?: string };
    const body = { ...head, status: 'proposal_captured', proposalId: s.proposalId };
    return answer(render(body, pd), body);
  }
  if (slot) await svc.slots.consume(slot);
  const labels = [
    ...plan.wouldCreate.map((c) => `create folder ${c.path.join(' / ')}`),
    'create the upload',
    'send the file',
    'create the image asset',
    'verify the stored file',
    ...(stage ? ['hide it'] : []),
  ];
  const view = await pd.engine.wait(pd.project.id, started.row.jobId!, (args.waitSeconds ?? 10) * 1000);
  let row = svc.settle(svc.store.upload(pd.project.id, started.row.id)!);
  let body: Record<string, unknown> = { ...head, ...rowAnswer(pd, row, view) };

  // At scope propose with a destination: the placement becomes the owner's proposal.
  if (propose && intended && row.state === 'uploaded' && row.staged) {
    const again = await planDestination(pd, mctx, svc, intended.destination);
    if (again.ok) {
      try {
        const placed = await svc.place({
          projectId: pd.project.id,
          row,
          plan: again.plan,
          origin: mcpOrigin(mctx, TOOL),
          tool: TOOL,
          described: again.described,
        });
        row = svc.store.upload(pd.project.id, row.id)!;
        if ('proposalId' in placed.submitted) {
          body = {
            ...body,
            status: 'proposal_captured',
            proposalId: placed.submitted.proposalId,
            hint:
              'The image is uploaded, verified and staged (hidden). Placing it is a proposal for the owner and was NOT done. ' +
              'Never retry it; follow it with bridge_proposal_status.',
          };
          return {
            kind: 'job',
            head,
            labels,
            result: render(body, pd),
            body,
            jobId: view.id,
            proposalId: placed.submitted.proposalId,
          };
        }
      } catch (e) {
        if (!(e instanceof ImageServiceError)) throw e;
        body = { ...body, placementError: { code: e.code, message: e.message } };
      }
    }
  }
  if (row.state === 'failed') {
    const err = {
      code: 'UPLOAD_FAILED',
      message: row.error ?? 'The upload failed.',
      ...body,
      jobId: view.id,
      hint: 'Check bridge_job_status for the failing step. Nothing is retried.',
    };
    return { kind: 'job', head, labels, result: errorResult(err, pd), body: err, jobId: view.id };
  }
  if (row.state === 'uploading') body = { ...body, hint: QUEUED_HINT };
  if (stage && row.state === 'uploaded' && !propose) {
    body = {
      ...body,
      hint: `Staged (hidden). Place it with upload_image { "staged_id": "${row.id}"${intended ? '' : ', "destination": { … }'} }, or on the dashboard’s Staging page.`,
    };
  }
  return { kind: 'job', head, labels, result: render(body, pd), body, jobId: view.id };
}

async function placeStaged(
  pd: ProjectDeps,
  mctx: McpToolContext,
  svc: ImageService,
  args: UploadArgs,
): Promise<CreateOutcome> {
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}): CreateOutcome => ({
    kind: 'answer',
    result: errorResult({ code, message, ...extra }, pd),
  });
  const row = svc.staged(pd.project.id, args.staged_id!);
  if (!row) return fail('STAGED_NOT_FOUND', `No staged image ${args.staged_id} in this project.`);
  if (row.state === 'uploading') {
    return fail(
      'STAGED_NOT_READY',
      `${row.id} is still being uploaded (job ${row.jobId}); wait for it, then call again.`,
      { jobId: row.jobId },
    );
  }
  if (row.state !== 'uploaded' || !row.staged) {
    return fail(
      row.state === 'uploaded' ? 'ALREADY_PLACED' : 'NOT_STAGED',
      row.state === 'uploaded'
        ? `${row.id} is already placed (asset ${row.assetId}${row.folderPath ? ` in ${row.folderPath.join(' / ')}` : ''}).`
        : `${row.id} is ${row.state}; it cannot be placed.`,
      { assetId: row.assetId },
    );
  }
  const intended = (row.intended ?? {}) as { destination?: DestinationInput };
  const dest = args.destination ?? intended.destination;
  if (!dest) {
    return fail(
      'DESTINATION_REQUIRED',
      `${row.id} has no intended destination; give one (folder, for_page or for_character).`,
    );
  }
  const d = await planDestination(pd, mctx, svc, dest);
  if (!d.ok) return fail(d.error.code, d.error.message, d.error.details ?? {});
  const rename = args.name !== undefined ? displayNameOf(args.name) : undefined;
  const head = {
    staged_id: row.id,
    assetId: row.assetId,
    name: rename ?? row.name,
    image: rowFacts(row),
    storedBytesVerified: row.storedVerified === true,
    destination: planFacts(d.plan),
  };
  if (args.dryRun) {
    const body = { ...head, status: 'dry_run', note: 'Nothing was moved.' };
    return { kind: 'answer', result: render(body, pd), final: body };
  }
  let placed;
  try {
    placed = await svc.place({
      projectId: pd.project.id,
      row,
      plan: d.plan,
      rename,
      origin: mcpOrigin(mctx, TOOL),
      tool: TOOL,
      described: d.described,
    });
  } catch (e) {
    if (e instanceof ImageServiceError) return fail(e.code, e.message, e.details);
    return { kind: 'answer', result: errorFromThrown(e, pd) };
  }
  if ('proposalId' in placed.submitted) {
    const body = {
      ...head,
      status: 'proposal_captured',
      proposalId: placed.submitted.proposalId,
      hint: 'Placing the staged image needs the owner’s approval and was NOT done. Never retry it; follow it with bridge_proposal_status.',
    };
    return {
      kind: 'job',
      head,
      labels: placed.labels,
      result: render(body, pd),
      body,
      proposalId: placed.submitted.proposalId,
    };
  }
  const view = await pd.engine.wait(pd.project.id, placed.submitted.jobId, (args.waitSeconds ?? 10) * 1000);
  const now = svc.settle(svc.store.upload(pd.project.id, row.id)!);
  const verified = (view.result as { verified?: unknown } | null)?.verified;
  if (view.status === 'failed' || view.status === 'cancelled') {
    // v2 E4 (RV4-6): what the placement made before it stopped (a folder, for instance), as every other write says.
    const steps = pd.engine.stepResults(pd.project.id, view.id) ?? [];
    const isWrite = (n: number) => {
      const l = placed.labels[n - 1];
      return l !== undefined && l !== 'check' && l !== 'verify';
    };
    const written = steps
      .filter((x) => x.status === 'succeeded' && isWrite(x.stepNo))
      .map((x) => placed.labels[x.stepNo - 1]!);
    const uncertain = steps
      .filter((x) => x.status === 'uncertain' && isWrite(x.stepNo))
      .map((x) => placed.labels[x.stepNo - 1]!);
    const notWritten = steps
      .filter((x) => x.status !== 'succeeded' && x.status !== 'uncertain' && isWrite(x.stepNo))
      .map((x) => placed.labels[x.stepNo - 1]!);
    const err = {
      code: 'PLACE_FAILED',
      message: `${view.lastError?.message ?? `The placement ${view.status}.`}${written.length ? ` Written before it stopped: ${written.join('; ')}.` : ' Nothing was written.'}`,
      ...head,
      jobId: view.id,
      written,
      ...(uncertain.length ? { uncertain } : {}),
      notWritten,
      hint: 'The image is still staged. Nothing is retried; placing it again reuses what was made (a folder is not made twice). See bridge_job_status.',
    };
    return {
      kind: 'job',
      head,
      labels: placed.labels,
      result: errorResult(err, pd),
      body: err,
      jobId: view.id,
    };
  }
  const body = {
    ...head,
    status:
      view.status === 'succeeded' ? 'placed' : view.status === 'waiting_budget' ? 'waiting_budget' : 'queued',
    jobId: view.id,
    ...(view.status === 'succeeded'
      ? {
          placementVerified: verified === true,
          asset: {
            id: now.assetId,
            name: now.name,
            folderId: now.folderId,
            folderPath: now.folderPath?.join(' / ') ?? null,
            hidden: false,
          },
        }
      : { hint: QUEUED_HINT }),
  };
  return { kind: 'job', head, labels: placed.labels, result: render(body, pd), body, jobId: view.id };
}

// ================================================================================================ prepare_image_upload

function scripts(o: { url: string; token: string; sha256: string; length: number }) {
  const python = [
    '#!/usr/bin/env python3',
    '# Sends ONE file to LK-Bridge (standard library only). Usage: python3 upload.py /path/to/image',
    'import hashlib, sys, urllib.request',
    'path = sys.argv[1]',
    'data = open(path, "rb").read()',
    `if len(data) != ${o.length} or hashlib.sha256(data).hexdigest() != "${o.sha256}":`,
    '    sys.exit("This is not the file the upload was prepared for (its length or SHA-256 differs); nothing was sent.")',
    'req = urllib.request.Request(',
    `    "${o.url}",`,
    '    data=data,',
    '    method="POST",',
    `    headers={"Authorization": "${CAPABILITY_SCHEME} ${o.token}", "Content-Type": "application/octet-stream"},`,
    ')',
    'try:',
    '    with urllib.request.urlopen(req, timeout=300) as r:',
    '        print(r.read().decode())',
    'except urllib.error.HTTPError as e:',
    '    sys.exit(f"Refused: HTTP {e.code} {e.read().decode()}")',
  ].join('\n');
  const curl = [
    '#!/usr/bin/env bash',
    '# Sends ONE file to LK-Bridge. Usage: bash upload.sh /path/to/image',
    'set -euo pipefail',
    'f="${1:?give the path of the image}"',
    `[ "$(wc -c < "$f" | tr -d ' ')" = "${o.length}" ] || { echo "The file's length differs from the one prepared; nothing was sent." >&2; exit 1; }`,
    'sum=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1)',
    `[ "$sum" = "${o.sha256}" ] || { echo "The file's SHA-256 differs from the one prepared; nothing was sent." >&2; exit 1; }`,
    `curl --fail-with-body -sS -X POST -H "Authorization: ${CAPABILITY_SCHEME} ${o.token}" \\`,
    `  -H "Content-Type: application/octet-stream" --data-binary "@$f" "${o.url}"`,
  ].join('\n');
  return { python, curl };
}

function prepareTool(deps: ToolDeps): McpToolProvider {
  const max = deps.settings.upload.maxBytes;
  return defineTool({
    name: 'prepare_image_upload',
    title: 'Prepare a binary image upload',
    access: 'write',
    description:
      'For agents with a shell or sandbox (Claude Code, scripts), so they need not paste megabytes of base64: give the file’s sha256 (lowercase hex), byte_length, content_type and name; you get an upload_id (a single-use capability: it works ONCE, for 5 minutes, for that file only) and ready-made Python and curl scripts. Run one with the file’s path, then call upload_image with the upload_id within 15 minutes. Never put the capability in a URL. Not for ChatGPT or any assistant whose code environment cannot reach the bridge: ChatGPT uses upload_image’s `file`. Cost: nothing in LegendKeeper until upload_image.',
    inputSchema: z.object({
      sha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, '64 hex characters')
        .describe('The file’s SHA-256, hex.'),
      byte_length: z.number().int().min(1).max(max).describe(`The file’s size in bytes (at most ${max}).`),
      content_type: z
        .enum(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])
        .describe('Checked against the file’s first bytes when it arrives.'),
      name: name200.describe('The asset name to use (a file extension is dropped).'),
      project: projectArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const svc = svcOf(pd);
        if (!svc) return unavailable(pd);
        if (mctx.scope === 'read') {
          return errorResult(
            { code: 'POLICY_DENIED', message: readOnlyReason(mctx.principal?.profile ?? 'this profile') },
            pd,
          );
        }
        if (!pd.publicUrl) {
          return errorResult(
            { code: 'IMAGES_UNAVAILABLE', message: 'The bridge’s public address is not configured.' },
            pd,
          );
        }
        let principal: string;
        try {
          principal = mcpOrigin(mctx, 'prepare_image_upload').principal!.principalId;
        } catch (e) {
          return errorFromThrown(e, pd);
        }
        const wait = svc.rate.prepare.retryAfterMs(principal);
        if (wait > 0) {
          return errorResult(
            {
              code: 'RATE_LIMITED',
              message: `Too many uploads prepared by this connection in the last hour (IMAGE_UPLOAD_RATE_PER_PRINCIPAL). Try again in ${Math.ceil(wait / 60_000)} minute(s).`,
              retryAfterSeconds: Math.ceil(wait / 1000),
            },
            pd,
          );
        }
        svc.rate.prepare.hit(principal);
        const contentType = args.content_type === 'image/jpg' ? 'image/jpeg' : args.content_type;
        const prepared = svc.slots.prepare({
          projectId: pd.project.id,
          principalId: principal,
          sha256: args.sha256.toLowerCase(),
          byteLength: args.byte_length,
          contentType,
          name: displayNameOf(args.name),
        });
        const url = `${pd.publicUrl.replace(/\/+$/, '')}/uploads/${prepared.uploadId}`;
        const s = scripts({
          url,
          token: prepared.token,
          sha256: args.sha256.toLowerCase(),
          length: args.byte_length,
        });
        return render(
          {
            upload_id: prepared.uploadId,
            endpoint: { method: 'POST', url },
            header: `Authorization: ${CAPABILITY_SCHEME} ${prepared.token}`,
            capability: prepared.token,
            capabilityExpiresAt: new Date(prepared.tokenExpiresAt).toISOString(),
            fileExpiresAt: new Date(prepared.expiresAt).toISOString(),
            bound: { sha256: args.sha256.toLowerCase(), byteLength: args.byte_length, contentType },
            scripts: s,
            next: `Run a script with the file's path (e.g. python3 upload.py ./image.png). It answers "received". Then call upload_image { "upload_id": "${prepared.uploadId}", "destination": { … } } within 15 minutes.`,
            note: 'The capability works once, for 5 minutes, only for this file in this project and this connection. Keep it out of URLs and logs.',
          },
          pd,
        );
      }),
  });
}
