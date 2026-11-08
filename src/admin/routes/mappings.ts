/**
 * Repository Mappings page API (chunk 6, docs/mappings.md). Every change goes through the owner commands
 * (`runtime.mappings.commands`), which audit it and emit a `policy` event. The preview only reads.
 */
import * as z from 'zod';
import { EXPECTED_KINDS, SUGGESTED_TYPES } from '../../mappings/index.js';
import { MAX_IMPORT_BYTES } from '../../mappings/exchange.js';
import { confirmBody, idSchema, parseInput, type Register } from './util.js';

export const registerMappings: Register = (api, ctx) => {
  const cmd = ctx.deps.runtime.mappings.commands;
  const id = z.object({ id: idSchema });

  api.get('/mappings', () => ({
    sets: cmd.listSets('owner'),
    expectedKinds: EXPECTED_KINDS,
    suggestedTypes: SUGGESTED_TYPES,
  }));

  api.post('/mappings/sets', (req, reply) => reply.code(201).send({ set: cmd.createSet('owner', req.body) }));
  api.get('/mappings/sets/:id', (req) => cmd.getSet('owner', parseInput(id, req.params).id));
  api.put('/mappings/sets/:id', (req) => ({
    set: cmd.updateSet('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/mappings/sets/:id/delete', (req) => {
    parseInput(confirmBody, req.body);
    cmd.deleteSet('owner', parseInput(id, req.params).id);
    return { ok: true };
  });
  api.post('/mappings/sets/:id/activate', (req) => ({
    set: cmd.activateSet('owner', parseInput(id, req.params).id),
  }));
  api.post('/mappings/sets/:id/deactivate', (req) => ({
    set: cmd.deactivateSet('owner', parseInput(id, req.params).id),
  }));

  api.post('/mappings/sets/:id/rules', (req, reply) =>
    reply.code(201).send({ rule: cmd.createRule('owner', parseInput(id, req.params).id, req.body) }),
  );
  api.put('/mappings/rules/:id', (req) => ({
    rule: cmd.updateRule('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/mappings/rules/:id/delete', (req) => {
    cmd.deleteRule('owner', parseInput(id, req.params).id);
    return { ok: true };
  });

  api.post('/mappings/sets/:id/fields', (req, reply) =>
    reply.code(201).send({ field: cmd.createField('owner', parseInput(id, req.params).id, req.body) }),
  );
  api.put('/mappings/fields/:id', (req) => ({
    field: cmd.updateField('owner', parseInput(id, req.params).id, req.body),
  }));
  api.post('/mappings/fields/:id/delete', (req) => {
    cmd.deleteField('owner', parseInput(id, req.params).id);
    return { ok: true };
  });

  /** The versioned JSON document the import accepts. */
  api.get('/mappings/sets/:id/export', (req) => ({
    document: cmd.exportSet('owner', parseInput(id, req.params).id),
  }));

  /** `document` is the file's text (or parsed JSON). Always creates a new, inactive set. */
  api.post('/mappings/import', { bodyLimit: MAX_IMPORT_BYTES + 64 * 1024 }, (req, reply) => {
    const b = parseInput(z.object({ document: z.unknown(), name: z.string().max(120).optional() }), req.body);
    return reply.code(201).send(cmd.importSet('owner', b.document, b.name));
  });

  /** Read-only: reads the resource (and its ancestors) through the governor at P0 and writes nothing. */
  api.get('/mappings/sets/:id/preview', async (req) => {
    const q = parseInput(z.object({ resourceId: z.string().trim().min(1).max(256) }), req.query);
    return { preview: await cmd.preview('owner', parseInput(id, req.params).id, q.resourceId) };
  });
};
