/**
 * `lk_upload_image`: the composite image upload (PLAN §4 rule 5). The image is resolved and verified first (base64,
 * or a public https URL when allowed), then an `upload_image` job runs three steps: createImageUpload (an LK call),
 * the PUT to the signed URL (NOT an LK call; src/mcp/tools/upload-step.ts) and createImageAsset (an LK call).
 */
import * as z from 'zod';
import { PolicyDeniedError, type JobView } from '../../jobs/index.js';
import { UPLOAD_PROPOSE_REASON } from '../../policy/gate.js';
import { defineTool } from './define.js';
import { submitBody } from './lk-api.js';
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
import { resolveImage, UploadSourceError } from './upload-source.js';

export function uploadTools(deps: ToolDeps) {
  const maxMb = Math.floor(deps.settings.upload.maxBytes / (1024 * 1024));
  return [
    defineTool({
      name: 'lk_upload_image',
      title: 'Upload an image to LegendKeeper',
      access: 'write',
      // v2 E3b (ADR 0045, P4): hidden by default; upload_image does everything this does and more.
      lowLevel: true,
      description: `Rarely needed (listed only with “Show low-level and rarely used tools”): the older three-step upload (createImageUpload, a PUT, createImageAsset) of a base64 or https image, with no conversion, folder planning or staging: prefer upload_image. PNG, JPEG, GIF or WebP up to ${maxMb} MB. Returns the asset, or a jobId to follow with bridge_job_status (wait_seconds waits for it); never repeat a call that returned a jobId. Cost: 2 writes.`,
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('Asset name, 1-200 characters.'),
        base64: z.string().min(1).optional().describe('The image bytes, base64 (a data: URI is accepted).'),
        url: z.string().max(2048).optional().describe('A public https URL of the image, instead of base64.'),
        contentType: z
          .enum(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])
          .optional()
          .describe('Optional; checked against the image data, which decides the type.'),
        description: z.string().max(10_000).optional(),
        folderId: z.string().max(256).optional().describe('An asset folder id (root if omitted).'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe('How long to wait for the result. Default 10.'),
        project: projectArg,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      // The project is settled first (v2 A1): a refused `project` fetches and sends nothing.
      handler: (input, ctx) =>
        withProject(deps, input.project, 'write', async (pd) => {
          // Chunk 8 (F-07): at scope `propose` the engine refuses uploads, but only after the image has been resolved,
          // which for a URL source means downloading it. Refuse first, so nothing is fetched for a refused upload.
          if (ctx.scope === 'propose') {
            return errorFromThrown(
              new PolicyDeniedError(
                'createImageUpload',
                UPLOAD_PROPOSE_REASON,
                ctx.principal?.principalId ?? 'unknown',
              ),
              pd,
            );
          }
          let image;
          try {
            image = await resolveImage(
              { base64: input.base64, url: input.url, contentType: input.contentType },
              deps.settings.upload,
              deps.uploadGuard,
              ctx.signal,
            );
          } catch (e) {
            if (e instanceof UploadSourceError) return errorResult({ code: e.code, message: e.message }, pd);
            return errorFromThrown(e, pd);
          }
          try {
            const r = await deps.engine.submit({
              kind: 'upload_image',
              project: pd.project.id,
              contentType: image.contentType,
              contentLength: image.contentLength,
              contentHash: image.sha256,
              dataBase64: image.dataBase64,
              name: input.name,
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
              origin: mcpOrigin(ctx, 'lk_upload_image'),
              priority: 'P1',
            });
            if (!('jobId' in r)) return render(submitBody(r, 3), pd);
            const job = await deps.engine.wait(pd.project.id, r.jobId, (input.waitSeconds ?? 10) * 1000);
            return render(...uploadOutcome(job, image, pd, submitBody(r, 3)));
          } catch (e) {
            return errorFromThrown(e, pd);
          }
        }),
    }),
  ];
}

function uploadOutcome(
  job: JobView,
  image: { contentType: string; contentLength: number },
  deps: ProjectDeps,
  submitted: Record<string, unknown>,
): [unknown, ProjectDeps, boolean] {
  const info = { contentType: image.contentType, bytes: image.contentLength };
  if (job.status === 'succeeded') {
    return [
      {
        status: 'succeeded',
        jobId: job.id,
        asset: (job.result as { asset?: unknown } | null)?.asset,
        image: info,
      },
      deps,
      false,
    ];
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return [
      {
        error: {
          code: 'UPLOAD_FAILED',
          message: job.lastError?.message ?? `The upload ${job.status}`,
          lkCode: job.lastError?.code,
        },
        status: job.status,
        jobId: job.id,
        uncertain: job.uncertain,
        hint: 'Check bridge_job_status for the failing step. If the image was not stored, upload it again.',
      },
      deps,
      true,
    ];
  }
  return [{ ...submitted, status: job.status, image: info }, deps, false];
}
