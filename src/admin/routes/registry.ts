/**
 * The type registry and taxonomy on the Repository Mappings page (v2 A3, docs/registry.md). Every change goes through
 * the owner commands (`runtime.registry.forProject(id).commands`), which audit it. The "Try it" routes only read the
 * stored tree: resolve a name, plan a character placement, compute an ordering slot, list siblings out of order.
 * Every route works in the `project` query parameter's project; another project's ids are "not found".
 */
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';
import { confirmBody, csv, idSchema, parseInput, projectParam, type Register } from './util.js';

const kindSchema = z.enum(['index', 'bsrc', 'unclassified']);

export const registerRegistry: Register = (api, ctx) => {
  const projectOf = (req: FastifyRequest) =>
    ctx.project(parseInput(z.object({ project: projectParam }).loose(), req.query).project);
  const forReq = (req: FastifyRequest) => ctx.deps.runtime.registry.forProject(projectOf(req).id);
  const id = z.object({ id: idSchema });

  api.get('/registry', (req) => {
    const r = forReq(req);
    return {
      project: projectOf(req),
      types: r.commands.listTypes('owner'),
      templates: r.commands.templates('owner'),
      seedDefaults: r.commands.seedDefaults(),
      tree: ctx.deps.runtime.tree.meta(r.projectId),
    };
  });

  // ------------------------------------------------------------------------------------------------- types
  api.post('/registry/types', (req, reply) =>
    reply.code(201).send({ type: forReq(req).commands.createType('owner', req.body) }),
  );
  api.get('/registry/types/:id', (req) => ({
    type: forReq(req).commands.getType('owner', parseInput(id, req.params).id),
  }));
  api.put('/registry/types/:id', (req) => ({
    type: forReq(req).commands.updateType('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/registry/types/:id/delete', (req) => {
    parseInput(confirmBody, req.body);
    forReq(req).commands.deleteType('owner', parseInput(id, req.params).id);
    return { ok: true };
  });
  /** Seeds the Character type from the tree and the project's templates (reads them first when never read). */
  api.post('/registry/seed-character', async (req, reply) =>
    reply.code(201).send({ type: await forReq(req).commands.seedCharacterType('owner', req.body ?? {}) }),
  );
  /** Reads the project's templates again (listTemplates through the governor). */
  api.post('/registry/templates/refresh', async (req) => ({
    templates: await forReq(req).commands.refreshTemplates('owner'),
  }));

  // ---------------------------------------------------------------------------------------------- taxonomy
  api.get('/registry/types/:id/taxonomy', (req) =>
    forReq(req).commands.taxonomy('owner', parseInput(id, req.params).id),
  );
  api.post('/registry/types/:id/taxonomy/seed', (req) => {
    parseInput(confirmBody, req.body);
    return { result: forReq(req).commands.seedTaxonomy('owner', parseInput(id, req.params).id) };
  });
  api.post('/registry/types/:id/taxonomy/add-missing', (req) => ({
    result: forReq(req).commands.addMissing('owner', parseInput(id, req.params).id),
  }));
  api.put('/registry/taxonomy/:id', (req) => ({
    entry: forReq(req).commands.updateEntry('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/registry/taxonomy/:id/delete', (req) => {
    parseInput(confirmBody, req.body);
    forReq(req).commands.deleteEntry('owner', parseInput(id, req.params).id);
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------------------- drift
  api.get('/registry/drift', (req) => forReq(req).commands.drift('owner'));
  api.post('/registry/drift/run', (req) => ({ report: forReq(req).commands.runDrift('owner') }));

  // ------------------------------------------------------------------------------- try it (read-only)
  api.get('/registry/try/resolve', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        query: z.string().min(1).max(500),
        under: idSchema.optional(),
        type: z.string().min(1).max(100).optional(),
        kinds: csv.pipe(z.array(kindSchema)).optional(),
      }),
      req.query,
    );
    const scope = q.under ? { under: q.under } : q.type ? { type: q.type } : undefined;
    return { result: forReq(req).resolve(q.query, { scope, kinds: q.kinds }) };
  });
  api.get('/registry/try/placement', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        characterName: z.string().min(1).max(200),
        race: z.string().max(200).optional(),
        kind: z.enum(['core', 'compact']),
        type: z.string().min(1).max(100).optional(),
      }),
      req.query,
    );
    return {
      plan: forReq(req).planCharacterPlacement({
        characterName: q.characterName,
        race: q.race ?? null,
        kind: q.kind,
        type: q.type,
      }),
    };
  });
  api.get('/registry/try/ordering', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        parentId: idSchema,
        name: z.string().min(1).max(500),
        kind: kindSchema,
        excludeId: idSchema.optional(),
      }),
      req.query,
    );
    const r = forReq(req);
    return {
      slot: r.placementFor(q.parentId, q.name, q.kind, q.excludeId ? { excludeId: q.excludeId } : {}),
      outOfOrder: r.outOfOrder(q.parentId),
    };
  });
  api.get('/registry/out-of-order', (req) => {
    const q = parseInput(z.object({ project: projectParam, parentId: idSchema.optional() }), req.query);
    return { parents: forReq(req).outOfOrder(q.parentId) };
  });
};
