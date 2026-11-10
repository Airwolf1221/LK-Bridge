/**
 * The Repository Tree page API (v2 A2, docs/tree.md): each project's tree status, counts, unclassified and stale
 * nodes, the running build's progress, the last sweep and check, the correction log, and a browsable tree. Owner
 * actions (start, confirm or cancel a build; look for the AI REPOSITORY root) go through `ctx.actions`, which audits
 * them. Nothing here calls LegendKeeper except those actions, through the tree service's governed reads.
 */
import * as z from 'zod';
import { idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const projectQuery = z.object({ project: projectParam });

export const registerTree: Register = (api, ctx) => {
  const { tree } = ctx.deps.runtime;

  api.get('/tree', (req) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    return { project, ...tree.overview(project.id), now: ctx.now() };
  });

  /** One level of the tree for browsing: a node (the root when `id` is omitted), its path and its children. */
  api.get('/tree/children', (req) => {
    const q = parseInput(z.object({ project: projectParam, id: idSchema.optional() }), req.query);
    const project = ctx.project(q.project);
    const meta = tree.meta(project.id);
    const id = q.id ?? meta.rootId;
    if (!id) return { tree: meta, node: null, path: [], children: [] };
    return {
      tree: meta,
      node: tree.queries.node(project.id, id).data,
      path: tree.queries.path(project.id, id).data,
      children: tree.queries.children(project.id, id).data,
    };
  });

  /** The correction log, newest first (`before`: an entry id, for the next page). */
  api.get('/tree/corrections', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        limit: limitSchema(50, 500),
        before: z.coerce.number().int().optional(),
        source: z.enum(['sweep', 'check', 'write', 'build']).optional(),
        pass: idSchema.optional(),
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const entries = tree.store.listLog(project.id, {
      limit: q.limit,
      before: q.before,
      source: q.source,
      passId: q.pass,
    });
    return { entries, next: entries.length === q.limit ? (entries.at(-1)?.id ?? null) : null };
  });

  /** Starts a build: it lists every resource, then waits for the owner to confirm its estimate. */
  api.post('/tree/build', (req, reply) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    return reply.code(202).send({ pass: ctx.actions.treePrepareBuild(project.id) });
  });

  api.post('/tree/build/confirm', (req) => {
    const q = parseInput(projectQuery, req.query);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(q.project);
    return { pass: ctx.actions.treeConfirmBuild(project.id) };
  });

  api.post('/tree/build/cancel', (req) => {
    const q = parseInput(projectQuery, req.query);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(q.project);
    return { pass: ctx.actions.treeCancelBuild(project.id) };
  });

  /** Looks for the AI REPOSITORY root in the background (one listing at P3); the page shows the result. */
  api.post('/tree/suggest-root', (req, reply) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    ctx.actions.treeSuggestRoot(project.id).catch(() => undefined);
    return reply.code(202).send({ started: true });
  });
};
