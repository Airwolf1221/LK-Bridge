/**
 * v3 F7c (ADR 0075, Z6): the image archives on the Asset Tree page, behind the owner session and CSRF like every admin
 * route:
 *
 * - `GET /archives`: the project's archives (most recent first), each with its rows (status, expected time, held by,
 *   queue position, reason), and the three limits kept apart (holding, processing, the hourly brake).
 * - `POST /archives/:id/discard` (re-authenticated, step-up): discards the archive: its unfinished entries are
 *   discarded (an art job waiting for one leaves that image out) and its server copy removed. Staged images stay staged.
 *
 * Server-local only: nothing here calls LegendKeeper. Every discard is audited (`archive.discard`).
 */
import * as z from 'zod';
import type { ImageService } from '../../images/service.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register } from './util.js';

const projectQuery = z.object({ project: projectParam });
const idParams = z.object({ id: z.string().regex(/^arc_[A-Za-z0-9_-]{8,40}$/) });

function images(ctx: Parameters<Register>[1]): ImageService {
  const svc = (ctx.deps.runtime as { images?: ImageService }).images;
  if (!svc) throw new AdminHttpError(503, 'IMAGES_UNAVAILABLE', 'The image pipeline is not available.');
  return svc;
}

export const registerArchives: Register = (api, ctx) => {
  api.get('/archives', (req) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    const svc = images(ctx);
    const rows = svc.archives.store.ofProject(project.id, 50);
    return {
      project,
      archives: rows.map((a) => ({
        ...svc.archives.archiveView(a),
        principalId: a.principalId,
        source: a.source,
        referenced: svc.archives.referenced(a.id),
      })),
      limits: svc.archives.limitsView(),
      now: ctx.now(),
    };
  });

  api.post('/archives/:id/discard', async (req) => {
    requireReauth(ctx.deps.services, req);
    const q = parseInput(projectQuery, req.query);
    const { id } = parseInput(idParams, req.params);
    const project = ctx.project(q.project);
    const svc = images(ctx);
    const a = svc.archives.store.archive(id);
    if (!a || a.projectId !== project.id)
      throw new AdminHttpError(404, 'ARCHIVE_NOT_FOUND', `No archive ${id} in this project.`);
    const before = { state: a.state, serverCopy: a.serverFile !== null };
    const r = await svc.archives.discard(id, 'owner');
    ctx.deps.runtime.policy.store.audit('owner', 'archive.discard', id, before, {
      state: 'discarded',
      discardedEntries: r?.discarded ?? 0,
    });
    return {
      archive: svc.archives.archiveView(svc.archives.store.archive(id)!),
      discarded: r?.discarded ?? 0,
    };
  });
};
