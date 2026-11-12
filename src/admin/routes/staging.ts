/**
 * The Staging page's API (v2 D3, ADR 0041; docs/dashboard.md › Staging), behind the owner session and CSRF like every
 * admin route:
 *
 * - `GET /staging`: the project's staged images (name, size, dimensions, who, when, intended destination, the asset URL
 *   for a thumbnail), those older than IMAGE_STAGING_REPORT_DAYS (reported, never removed), the staging folder, the bytes
 *   kept before deletes, and the owner's delete permissions.
 * - `POST /staging/upload?name=…` with the image as the raw body (`application/octet-stream`): the same pipeline and
 *   limits as `upload_image` (magic bytes, the caps, one conversion at a time, deduplication), staged, verified.
 * - `POST /staging/preview` (a destination, or a staged id for its intended one): a dry run of the folder plan, with no
 *   write: the full resolved path, the folders that would be created, and the refusal (a bad subfolder path, an
 *   ambiguous folder, a non-folder of the same name) exactly as placing would give it.
 * - `POST /staging/:id/place` (a destination; an optional new name) and `POST /staging/:id/discard` (the bytes are kept
 *   before the delete).
 * - `POST /staging/allow-delete` (re-authenticated): lets ONE delete of an asset go ahead although its bytes could not
 *   be kept (within an hour).
 *
 * Every change is audited (`staging.upload`, `staging.place`, `staging.discard`, `asset.delete_without_bytes`).
 */
import * as z from 'zod';
import { ImageError, displayNameOf } from '../../images/convert.js';
import { ImageServiceError, type ImageService } from '../../images/service.js';
import type { ImageUploadRow } from '../../images/store.js';
import { SYSTEM_PRINCIPAL, type JobOrigin } from '../../jobs/index.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register } from './util.js';

const projectQuery = z.object({ project: projectParam });
const idParams = z.object({ id: z.string().regex(/^img_[A-Za-z0-9_-]{8,40}$/) });
const name200 = z.string().trim().min(1).max(200);
const destination = z
  .object({
    folder: z.union([z.string().min(1).max(2000), z.array(name200).min(1).max(20)]).optional(),
    for_page: z.string().min(1).max(300).optional(),
    for_character: z
      .object({
        name: name200,
        race: z.string().max(200).nullable().optional(),
        type: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    subfolders: z.union([z.string().min(1).max(2000), z.array(name200).max(10)]).optional(),
  })
  .strict();

const ORIGIN = (tool: string): JobOrigin => ({ kind: 'ui', tool, principal: SYSTEM_PRINCIPAL });
const WAIT_MS = 20_000;

function images(ctx: Parameters<Register>[1]): ImageService {
  const svc = (ctx.deps.runtime as { images?: ImageService }).images;
  if (!svc) throw new AdminHttpError(503, 'IMAGES_UNAVAILABLE', 'The image pipeline is not available.');
  return svc;
}

function view(svc: ImageService, r: ImageUploadRow, projectId: string, url: string | null) {
  return {
    stagedId: r.id,
    state: r.state,
    staged: r.staged,
    name: r.name,
    assetId: r.assetId,
    url,
    width: r.width,
    height: r.height,
    frames: r.frames,
    bytes: r.webp.bytes,
    originalFormat: r.original.format,
    originalBytes: r.original.bytes,
    conversion: r.conversionMode,
    storedVerified: r.storedVerified,
    verifyReason: r.verifyReason,
    principalId: r.principalId,
    source: r.source,
    createdAt: r.createdAt,
    intended: (r.intended as { path?: string[] } | null)?.path?.join(' / ') ?? null,
    intendedDestination: (r.intended as { destination?: unknown } | null)?.destination ?? null,
    placing: r.placementProposalId
      ? { proposalId: r.placementProposalId }
      : r.placementJobId
        ? { jobId: r.placementJobId }
        : null,
    discarding: r.discardJobId ? { jobId: r.discardJobId } : null,
    error: r.error,
    old: r.createdAt < Date.now() - svc.settings.images.stagingReportDays * 86_400_000,
    project: projectId,
  };
}

function refusal(e: unknown): never {
  if (e instanceof ImageError) throw new AdminHttpError(422, e.code, e.message, e.details);
  if (e instanceof ImageServiceError) throw new AdminHttpError(409, e.code, e.message, e.details);
  throw e;
}

export const registerStaging: Register = (api, ctx) => {
  const audit = (action: string, target: string, before?: unknown, after?: unknown) =>
    ctx.deps.runtime.policy.store.audit('owner', action, target, before, after);
  const urlOf = (projectId: string, assetId: string | null) => {
    if (!assetId) return null;
    try {
      return ctx.deps.runtime.assets.queries.asset(projectId, assetId).data?.url ?? null;
    } catch {
      return null;
    }
  };

  // The image arrives as the raw body. Only these routes read it (other admin routes take JSON only).
  api.addContentTypeParser(
    'application/octet-stream',
    {
      parseAs: 'buffer',
      bodyLimit:
        (ctx.deps.runtime as { images?: ImageService }).images?.settings.upload.maxBytes ?? 10 * 1024 * 1024,
    },
    (_req, body, done) => done(null, body),
  );

  api.get('/staging', (req) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    const svc = images(ctx);
    const staged = svc
      .listStaged(project.id)
      .map((r) => view(svc, r, project.id, urlOf(project.id, r.assetId)));
    return {
      project: project.name,
      folder: svc.stagingFolderName(project.id),
      reportDays: svc.settings.images.stagingReportDays,
      staged,
      old: staged.filter((s) => s.old).length,
      limits: {
        maxBytes: svc.settings.upload.maxBytes,
        maxPixels: svc.settings.images.maxPixels,
        maxFrames: svc.settings.images.maxFrames,
      },
      kept: {
        ...svc.store.keptTotals(),
        retentionDays: svc.settings.images.keptBytesRetentionDays,
        recent: svc.store.keptRefs(project.id).slice(0, 50),
      },
      overrides: svc.store.overrides(project.id),
    };
  });

  api.post('/staging/upload', async (req) => {
    const q = parseInput(z.object({ project: projectParam, name: name200 }), req.query);
    const project = ctx.project(q.project);
    const svc = images(ctx);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AdminHttpError(
        400,
        'INVALID_INPUT',
        'Send the image as the request body (application/octet-stream).',
      );
    }
    let img;
    try {
      img = await svc.convert(body);
    } catch (e) {
      refusal(e);
    }
    const dup = svc.findDuplicate(project.id, img.source.sha256);
    if (dup) {
      return { deduplicated: true, image: view(svc, dup, project.id, urlOf(project.id, dup.assetId)) };
    }
    const plan = svc.planStaging(project.id);
    if (!plan.ok) throw new AdminHttpError(409, plan.error.code, plan.error.message, plan.error.details);
    const name = displayNameOf(q.name);
    const started = await svc.startUpload({
      projectId: project.id,
      image: img,
      name,
      plan: plan.plan,
      staged: true,
      source: 'dashboard',
      origin: ORIGIN('staging.upload'),
    });
    if (!started.row) throw new AdminHttpError(409, 'NOT_STAGED', 'The upload was not accepted.');
    audit('staging.upload', started.row.id, undefined, {
      project: project.id,
      name,
      originalSha256: img.source.sha256,
      bytes: img.output.bytes,
      jobId: started.row.jobId,
    });
    await ctx.deps.runtime.engine.wait(project.id, started.row.jobId!, WAIT_MS);
    const row = svc.settle(svc.store.upload(project.id, started.row.id)!);
    return { deduplicated: false, image: view(svc, row, project.id, urlOf(project.id, row.assetId)) };
  });

  api.post('/staging/preview', (req) => {
    const q = parseInput(projectQuery, req.query);
    const b = parseInput(
      z
        .object({
          destination: destination.optional(),
          stagedId: z
            .string()
            .regex(/^img_[A-Za-z0-9_-]{8,40}$/)
            .optional(),
        })
        .strict(),
      req.body,
    );
    const project = ctx.project(q.project);
    const svc = images(ctx);
    let dest = b.destination;
    if (!dest && b.stagedId) {
      const row = svc.staged(project.id, b.stagedId);
      if (!row)
        throw new AdminHttpError(404, 'STAGED_NOT_FOUND', `No staged image ${b.stagedId} in this project.`);
      dest = (row.intended as { destination?: z.infer<typeof destination> } | null)?.destination;
    }
    if (!dest) throw new AdminHttpError(400, 'DESTINATION_REQUIRED', 'Choose where the image goes.');
    const plan = svc.plan(project.id, dest);
    if (!plan.ok) {
      throw new AdminHttpError(
        plan.error.code === 'INVALID_SUBFOLDER' ? 400 : 409,
        plan.error.code,
        plan.error.message,
        plan.error.details,
      );
    }
    const p = plan.plan;
    const created = new Set(p.wouldCreate.map((s) => s.path.join('\u0000')));
    return {
      // The whole path, folder by folder, each marked as existing or new (a new folder under another new one is new too).
      path: p.destination.path.join(' / '),
      segments: p.destination.path.map((name, i) => ({
        name,
        new: created.has(p.destination.path.slice(0, i + 1).join('\u0000')),
      })),
      newFolders: p.wouldCreate.length,
      exists: p.destination.exists,
      notes: p.notes,
      described: plan.described,
      dryRun: true,
    };
  });

  api.post('/staging/:id/place', async (req) => {
    const q = parseInput(projectQuery, req.query);
    const { id } = parseInput(idParams, req.params);
    const b = parseInput(
      z.object({ destination: destination.optional(), name: name200.optional() }).strict(),
      req.body,
    );
    const project = ctx.project(q.project);
    const svc = images(ctx);
    const row = svc.staged(project.id, id);
    if (!row) throw new AdminHttpError(404, 'STAGED_NOT_FOUND', `No staged image ${id} in this project.`);
    const dest =
      b.destination ?? (row.intended as { destination?: z.infer<typeof destination> } | null)?.destination;
    if (!dest) throw new AdminHttpError(400, 'DESTINATION_REQUIRED', 'Choose where the image goes.');
    const plan = svc.plan(project.id, dest);
    if (!plan.ok) {
      throw new AdminHttpError(
        plan.error.code === 'INVALID_SUBFOLDER' ? 400 : 409,
        plan.error.code,
        plan.error.message,
        plan.error.details,
      );
    }
    let placed;
    try {
      placed = await svc.place({
        projectId: project.id,
        row,
        plan: plan.plan,
        rename: b.name !== undefined ? displayNameOf(b.name) : undefined,
        origin: ORIGIN('staging.place'),
        tool: 'staging',
        described: plan.described,
      });
    } catch (e) {
      refusal(e);
    }
    audit(
      'staging.place',
      id,
      { folderPath: row.folderPath },
      { to: plan.plan.destination.path, name: b.name ?? row.name },
    );
    if (!('jobId' in placed.submitted)) return { proposalId: placed.submitted.proposalId };
    const job = await ctx.deps.runtime.engine.wait(project.id, placed.submitted.jobId, WAIT_MS);
    const now = svc.settle(svc.store.upload(project.id, id)!);
    return {
      jobId: job.id,
      status: job.status,
      verified: (job.result as { verified?: unknown } | null)?.verified ?? null,
      image: view(svc, now, project.id, urlOf(project.id, now.assetId)),
    };
  });

  api.post('/staging/:id/discard', async (req) => {
    const q = parseInput(projectQuery, req.query);
    const { id } = parseInput(idParams, req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(q.project);
    const svc = images(ctx);
    const row = svc.staged(project.id, id);
    if (!row) throw new AdminHttpError(404, 'STAGED_NOT_FOUND', `No staged image ${id} in this project.`);
    let submitted;
    try {
      submitted = await svc.discard({
        projectId: project.id,
        row,
        origin: ORIGIN('staging.discard'),
        by: 'owner',
      });
    } catch (e) {
      refusal(e);
    }
    audit('staging.discard', id, { assetId: row.assetId, name: row.name }, undefined);
    if (!('jobId' in submitted)) return { proposalId: submitted.proposalId };
    const job = await ctx.deps.runtime.engine.wait(project.id, submitted.jobId, WAIT_MS);
    const now = svc.settle(svc.store.upload(project.id, id)!);
    return {
      jobId: job.id,
      status: job.status,
      ...(job.lastError ? { error: job.lastError } : {}),
      image: view(svc, now, project.id, null),
    };
  });

  api.post('/staging/allow-delete', (req) => {
    requireReauth(ctx.deps.services, req);
    const q = parseInput(projectQuery, req.query);
    const b = parseInput(
      z.object({ assetId: z.string().min(1).max(64), confirm: z.literal(true) }).strict(),
      req.body,
    );
    const project = ctx.project(q.project);
    const svc = images(ctx);
    svc.store.grantOverride(project.id, b.assetId, 'owner', 3_600_000);
    audit('asset.delete_without_bytes', b.assetId, undefined, { project: project.id, validForMs: 3_600_000 });
    return { ok: true, assetId: b.assetId, expiresAt: Date.now() + 3_600_000 };
  });
};
