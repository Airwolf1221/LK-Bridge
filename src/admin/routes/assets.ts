/**
 * The Asset Tree page API (v2 A4, docs/assets.md): each project's asset-tree status, counts, the running build's
 * progress and estimate, the last build, refresh and check, the correction log, a browsable folder tree, and a read-only
 * placement planner ("Try it"). Owner actions (start, confirm or cancel a build; refresh now) go through
 * `ctx.actions`, which audits them. Nothing here calls LegendKeeper except those actions, through the asset service's
 * governed reads; the planner reads only the stored models.
 */
import * as z from 'zod';
import type { PlanRequest } from '../../assets/index.js';
import { idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const projectQuery = z.object({ project: projectParam });

const plannerBody = z
  .object({
    characterResourceId: z.string().trim().min(1).max(200).optional(),
    characterName: z.string().max(400).optional(),
    subfolders: z.array(z.string().max(400)).max(20).optional(),
    folderPath: z.array(z.string().max(400)).max(20).optional(),
  })
  .strict();

export const registerAssets: Register = (api, ctx) => {
  const { assets } = ctx.deps.runtime;

  api.get('/asset-tree', (req) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    return { project, ...assets.overview(project.id), now: ctx.now() };
  });

  /** One folder level for browsing: a folder (the library's root when `id` is omitted), its path, subfolders and assets. */
  api.get('/asset-tree/children', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        id: idSchema.optional(),
        limit: limitSchema(200, 1000),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const folderId = q.id ?? null;
    const meta = assets.meta(project.id);
    const folder = folderId ? assets.queries.folder(project.id, folderId).data : null;
    return {
      tree: meta,
      folder,
      path: folderId ? assets.queries.path(project.id, folderId).data : [],
      folders: assets.queries.children(project.id, folderId).data,
      assets: assets.queries.assetsIn(project.id, folderId, { limit: q.limit, offset: q.offset }).data,
    };
  });

  /** The correction log, newest first (`before`: an entry id, for the next page). */
  api.get('/asset-tree/corrections', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        limit: limitSchema(50, 500),
        before: z.coerce.number().int().optional(),
        source: z.enum(['refresh', 'check', 'write', 'build']).optional(),
        pass: idSchema.optional(),
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const entries = assets.store.listLog(project.id, {
      limit: q.limit,
      before: q.before,
      source: q.source,
      passId: q.pass,
    });
    return { entries, next: entries.length === q.limit ? (entries.at(-1)?.id ?? null) : null };
  });

  /** Starts a build: it lists the root level, then waits for the owner to confirm the estimate. */
  api.post('/asset-tree/build', (req, reply) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    return reply.code(202).send({ pass: ctx.actions.assetsPrepareBuild(project.id) });
  });

  api.post('/asset-tree/build/confirm', (req) => {
    const q = parseInput(projectQuery, req.query);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(q.project);
    return { pass: ctx.actions.assetsConfirmBuild(project.id) };
  });

  api.post('/asset-tree/build/cancel', (req) => {
    const q = parseInput(projectQuery, req.query);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(q.project);
    return { pass: ctx.actions.assetsCancelBuild(project.id) };
  });

  /** Runs a refresh now, in the background (the page shows its progress and result). */
  api.post('/asset-tree/refresh', (req, reply) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    ctx.actions.assetsRefreshNow(project.id).catch(() => undefined);
    return reply.code(202).send({ started: true });
  });

  /**
   * "Try it": where would an asset for this character (or this literal folder path) go? A read-only plan from the
   * stored models: nothing is written, nothing is requested from LegendKeeper. A POST only because the request has a
   * body; it is not audited.
   */
  api.post('/asset-tree/plan', (req) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    const body = parseInput(plannerBody, req.body);
    // Whatever was sent goes to the planner as it is: a request that mixes a folderPath with a character is its
    // INVALID_REQUEST to give, not this route's.
    const request = {
      folderPath: body.folderPath,
      characterResourceId: body.characterResourceId,
      characterName: body.characterName,
      subfolders: body.subfolders,
    } as PlanRequest;
    const result = assets.plan(project.id, request);
    return { project, result };
  });
};
