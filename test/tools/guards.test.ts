/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { operations } from '../../src/lk/registry.js';
import { LkModel } from '../jobs/lk-model.js';
import { startStack, type Stack } from './helpers.js';

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', { name: 'Root' });
model.seedResource('child', { name: 'Child', parentId: 'res1' });
model.seedResource('doc1', {
  name: 'Doc',
  blocks: [
    { kind: 'paragraph', content: [{ text: 'keep' }] },
    { id: 'unsup1', kind: 'unsupported' },
  ],
});

let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({ respond: model.respond });
  client = await stack.connect();
});
afterAll(() => stack.close());

const wire = () => stack.mock.calls.length;

describe('read / write mismatches spend no budget', () => {
  it('lk_api_read refuses every non-read operation, telling the agent to use lk_api_write', async () => {
    const before = wire();
    for (const op of operations.filter((o) => o.kind !== 'read')) {
      const r = await stack.call(client, 'lk_api_read', { operationId: op.operationId });
      expect(r.isError, op.operationId).toBe(true);
      expect(r.body.error, op.operationId).toMatchObject({
        code: 'WRONG_TOOL_FOR_OPERATION',
        useTool: 'lk_api_write',
      });
      expect(r.body.error.message).toContain('lk_api_write');
    }
    expect(wire()).toBe(before);
  });

  it('lk_api_write refuses every read operation, telling the agent to use lk_api_read', async () => {
    const before = wire();
    for (const op of operations.filter((o) => o.kind === 'read')) {
      const r = await stack.call(client, 'lk_api_write', { operationId: op.operationId });
      expect(r.isError, op.operationId).toBe(true);
      expect(r.body.error, op.operationId).toMatchObject({
        code: 'WRONG_TOOL_FOR_OPERATION',
        useTool: 'lk_api_read',
      });
    }
    expect(wire()).toBe(before);
    expect(stack.runtime.engine.queries.listJobs({}).length).toBe(0);
  });

  it('suggests close names for an unknown operation', async () => {
    const r = await stack.call(client, 'lk_api_read', { operationId: 'getDocumentBlock' });
    expect(r.body.error.code).toBe('UNKNOWN_OPERATION');
    expect(r.body.error.didYouMean).toContain('getDocumentBlocks');
  });

  it('refuses invalid parameters before spending anything', async () => {
    const before = wire();
    const r = await stack.call(client, 'lk_api_read', { operationId: 'getResource', params: { path: {} } });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('INVALID_PARAMS');
    expect(wire()).toBe(before);
  });
});

describe('engine guards through the tools', () => {
  it('refuses a replace that would delete unsupported blocks, and allows it when told to', async () => {
    const params = {
      path: { resourceId: 'doc1', documentId: 'd_doc1' },
      body: { blocks: [{ kind: 'paragraph', content: [{ text: 'new' }] }] },
    };
    const refused = await stack.call(client, 'lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params,
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS', blockIds: ['unsup1'] });
    expect(model.docs.get('d_doc1')!.blocks).toHaveLength(2);
    const allowed = await stack.call(client, 'lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params,
      allowUnsupportedLoss: true,
    });
    expect(allowed.isError, allowed.text).toBe(false);
    expect(model.docs.get('d_doc1')!.blocks).toHaveLength(1);
    // The pre-image is in the journal.
    const j = await stack.call(client, 'bridge_journal_lookup', {
      documentId: 'd_doc1',
      includePreImage: true,
    });
    expect(j.body.count).toBeGreaterThan(0);
    expect(JSON.stringify(j.body.entries[0].preImage)).toContain('unsup1');
  });

  it('needs confirm for a cascading delete', async () => {
    const params = { path: { resourceId: 'res1' }, query: { cascade: true } };
    const refused = await stack.call(client, 'lk_api_write', { operationId: 'deleteResource', params });
    expect(refused.body.error.code).toBe('CASCADE_CONFIRM_REQUIRED');
    expect(model.resources.get('res1')!.deletedAt).toBeUndefined();
    const ok = await stack.call(client, 'lk_api_write', {
      operationId: 'deleteResource',
      params,
      confirm: 'cascade',
    });
    expect(ok.isError, ok.text).toBe(false);
    expect(model.resources.get('res1')!.deletedAt).toBeDefined();
  });

  it('refuses member administration unless enabled', async () => {
    const r = await stack.call(client, 'lk_api_write', {
      operationId: 'inviteMember',
      params: { body: { email: 'a@example.test' } },
    });
    expect(r.body.error.code).toBe('MEMBER_ADMIN_DISABLED');
  });

  it('batch validation refuses the whole batch up front', async () => {
    const before = stack.runtime.engine.queries.listJobs({}).length;
    const r = await stack.call(client, 'lk_api_batch', {
      calls: [
        { operationId: 'createResource', params: { body: { name: 'ok' } } },
        { operationId: 'inviteMember', params: { body: { email: 'a@example.test' } } },
      ],
    });
    expect(r.body.error.code).toBe('MEMBER_ADMIN_DISABLED');
    expect(stack.runtime.engine.queries.listJobs({}).length).toBe(before);
  });

  it('paginate_all refuses an operation that is not a paged read', async () => {
    const r = await stack.call(client, 'lk_api_paginate_all', { operationId: 'getResource' });
    expect(r.body.error.code).toBe('NOT_PAGED');
  });
});

describe('read-only mode and budget', () => {
  it('refuses writes while read-only, and bridge_info says so', async () => {
    const ro = await startStack({ respond: model.respond, env: { LK_READ_ONLY: 'true' } });
    try {
      const c = await ro.connect();
      const w = await ro.call(c, 'lk_api_write', {
        operationId: 'createResource',
        params: { body: { name: 'x' } },
      });
      expect(w.body.error.code).toBe('READ_ONLY');
      const info = await ro.call(c, 'bridge_info');
      expect(info.body.readOnly.effective).toBe(true);
      expect(info.body.writes.canWrite).toBe(false);
      const r = await ro.call(c, 'lk_api_read', { operationId: 'listResources' });
      expect(r.isError).toBe(false);
    } finally {
      await ro.close();
    }
  });

  it('a write meeting a long 429 is waiting_budget (not an error), a read gets a typed budget error', async () => {
    stack.mock.inject((c) => c.method === 'POST' && /\/resources\/?$/.test(c.path), {
      kind: 'rate-limit',
      tier: 'write-min',
      retryAfterS: 120,
    });
    const w = await stack.call(client, 'lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: 'late' } },
    });
    expect(w.isError, w.text).toBe(false);
    expect(w.body.status, w.text).toBe('waiting_budget');
    expect(w.body.hint).toMatch(/Never retry/);
    expect(w.footer).toMatch(/blocked/);
    stack.mock.inject((c) => c.method === 'GET' && /\/resources\/?$/.test(c.path), {
      kind: 'rate-limit',
      tier: 'key-min',
      retryAfterS: 120,
    });
    const r = await stack.call(client, 'lk_api_read', { operationId: 'listResources' });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(r.body.error.hint).toMatch(/loop/);
  });
});

describe('the tool list', () => {
  it('every tool carries an access tag consistent with its annotations', () => {
    const tools = stack.runtime.tools;
    expect(tools).toHaveLength(16);
    for (const t of tools) {
      expect(['read', 'write'], t.name).toContain(t.access);
      expect(t.annotations?.readOnlyHint, t.name).toBe(t.access === 'read');
    }
  });

  it('registers 89 more lk_op_* tools only when MCP_EXPOSE_PER_OP_TOOLS=true', async () => {
    const on = await startStack({ respond: model.respond, env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
    try {
      const c = await on.connect();
      const { tools } = await c.listTools();
      expect(tools).toHaveLength(16 + 89);
      const perOp = tools.filter((t) => t.name.startsWith('lk_op_'));
      expect(perOp).toHaveLength(89);
      const by = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(by.lk_op_getResource!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(by.lk_op_deleteResource!.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(by.lk_op_createResource!.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(by.lk_op_updateCalendar!.annotations?.destructiveHint).toBe(true);
      for (const t of on.runtime.tools.filter((x) => x.name.startsWith('lk_op_'))) {
        const op = operations.find((o) => `lk_op_${o.operationId}` === t.name)!;
        expect(t.access, t.name).toBe(op.kind === 'read' ? 'read' : 'write');
      }
      // They work, and use the same engine path.
      const got = await on.call(c, 'lk_op_getResource', { path: { resourceId: 'doc1' } });
      expect(got.body.status, got.text).toBe('succeeded');
      const made = await on.call(c, 'lk_op_createResource', { body: { name: 'via per-op tool' } });
      expect(made.isError, made.text).toBe(false);
      expect(on.runtime.engine.queries.getJob(made.body.jobId)!.origin.tool).toBe('lk_op_createResource');
    } finally {
      await on.close();
    }
  });
});
