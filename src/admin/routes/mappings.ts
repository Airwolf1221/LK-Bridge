/**
 * Repository Mappings page API (chunk 6, docs/mappings.md). Every change goes through the owner commands
 * (`runtime.mappings.forProject(id).commands`), which audit it and emit a `policy` event. The preview only reads.
 * v2 A1: mappings belong to a project; every route works in the `project` query parameter's (default: the default
 * project), and another project's ids are "not found".
 */
import * as z from 'zod';
import { EXPECTED_KINDS, SUGGESTED_TYPES } from '../../mappings/index.js';
import { MAX_IMPORT_BYTES } from '../../mappings/exchange.js';
import type { FastifyRequest } from 'fastify';
import { confirmBody, idSchema, parseInput, projectParam, type Register } from './util.js';

export const registerMappings: Register = (api, ctx) => {
  const projectOf = (req: FastifyRequest) =>
    ctx.project(parseInput(z.object({ project: projectParam }).loose(), req.query).project);
  /** The owner commands of the request's project. */
  const commandsFor = (req: FastifyRequest) =>
    ctx.deps.runtime.mappings.forProject(projectOf(req).id).commands;
  const id = z.object({ id: idSchema });

  api.get('/mappings', (req) => ({
    project: projectOf(req),
    sets: commandsFor(req).listSets('owner'),
    expectedKinds: EXPECTED_KINDS,
    suggestedTypes: SUGGESTED_TYPES,
  }));

  api.post('/mappings/sets', (req, reply) =>
    reply.code(201).send({ set: commandsFor(req).createSet('owner', req.body) }),
  );
  api.get('/mappings/sets/:id', (req) => commandsFor(req).getSet('owner', parseInput(id, req.params).id));
  api.put('/mappings/sets/:id', (req) => ({
    set: commandsFor(req).updateSet('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/mappings/sets/:id/delete', (req) => {
    parseInput(confirmBody, req.body);
    commandsFor(req).deleteSet('owner', parseInput(id, req.params).id);
    return { ok: true };
  });
  api.post('/mappings/sets/:id/activate', (req) => ({
    set: commandsFor(req).activateSet('owner', parseInput(id, req.params).id),
  }));
  api.post('/mappings/sets/:id/deactivate', (req) => ({
    set: commandsFor(req).deactivateSet('owner', parseInput(id, req.params).id),
  }));

  api.post('/mappings/sets/:id/rules', (req, reply) =>
    reply
      .code(201)
      .send({ rule: commandsFor(req).createRule('owner', parseInput(id, req.params).id, req.body) }),
  );
  api.put('/mappings/rules/:id', (req) => ({
    rule: commandsFor(req).updateRule('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/mappings/rules/:id/delete', (req) => {
    commandsFor(req).deleteRule('owner', parseInput(id, req.params).id);
    return { ok: true };
  });

  api.post('/mappings/sets/:id/fields', (req, reply) =>
    reply
      .code(201)
      .send({ field: commandsFor(req).createField('owner', parseInput(id, req.params).id, req.body) }),
  );
  api.put('/mappings/fields/:id', (req) => ({
    field: commandsFor(req).updateField('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/mappings/fields/:id/delete', (req) => {
    commandsFor(req).deleteField('owner', parseInput(id, req.params).id);
    return { ok: true };
  });

  /** The versioned JSON document the import accepts. */
  api.get('/mappings/sets/:id/export', (req) => ({
    document: commandsFor(req).exportSet('owner', parseInput(id, req.params).id),
  }));

  /** `document` is the file's text (or parsed JSON). Always creates a new, inactive set. */
  api.post('/mappings/import', { bodyLimit: MAX_IMPORT_BYTES + 64 * 1024 }, (req, reply) => {
    const b = parseInput(z.object({ document: z.unknown(), name: z.string().max(120).optional() }), req.body);
    return reply.code(201).send(commandsFor(req).importSet('owner', b.document, b.name));
  });

  /** Read-only: reads the resource (and its ancestors) through the governor at P0 and writes nothing. */
  api.get('/mappings/sets/:id/preview', async (req) => {
    const q = parseInput(
      z.object({ resourceId: z.string().trim().min(1).max(256), project: projectParam }),
      req.query,
    );
    return { preview: await commandsFor(req).preview('owner', parseInput(id, req.params).id, q.resourceId) };
  });
};
