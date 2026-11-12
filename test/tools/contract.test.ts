import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operations } from '../../src/lk/registry.js';
import { startStack, type Stack } from './helpers.js';
import { exampleInput, routeFor, specRespond } from './spec-mock.js';

/**
 * Chunk 3 criterion: every one of the 89 operations has a passing contract test through lk_api_read or
 * lk_api_write. The mock LK answers each request from the OpenAPI spec's response schemas (spec-mock.ts); the
 * stateful model of chunk 2 is used for the flow tests in e2e.test.ts and guards.test.ts.
 */
let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({ respond: specRespond(), env: { LK_ALLOW_MEMBER_ADMIN: 'true' } });
  client = await stack.connect();
});
afterAll(() => stack.close());

describe('all registry operations through lk_api_read / lk_api_write', () => {
  it('covers exactly the 89 operations', () => {
    expect(operations).toHaveLength(89);
  });

  it.each(operations.map((o) => [o.operationId, o] as const))('%s', async (_id, op) => {
    const params = exampleInput(op);
    const before = stack.mock.calls.length;
    const tool = op.kind === 'read' ? 'lk_api_read' : 'lk_api_write';
    const args: Record<string, unknown> = { operationId: op.operationId, params };
    // The only operation whose example needs an extra confirmation is a cascading delete; the example has none.
    // v2 D3 (ADR 0041): a delete keeps the asset's bytes first, and the spec's example asset has no file on an asset
    // host, so it would be refused; the owner allows this one delete (test/images/kept.test.ts covers the keeping).
    if (op.operationId === 'deleteAsset') {
      const assetId = (params as { path?: { assetId?: string } }).path?.assetId ?? '';
      stack.runtime.images.store.grantOverride(
        stack.runtime.projects.defaultProject().id!,
        assetId,
        'owner',
        60_000,
      );
    }
    const r = await stack.call(client, tool, args);
    expect(r.isError, r.text.slice(0, 600)).toBe(false);
    expect(r.footer).toMatch(/^budget \(test\): /); // v2 A1: the footer names the project
    expect(['succeeded', 'queued']).toContain(r.body.status);
    // LK saw the operation's own request (method and route), however many reads the engine made around it.
    const seen = stack.mock.calls
      .slice(before)
      .map((c) => routeFor(c.method, c.path.replace(/^\/api\/v3/, '')));
    // routes in the spec table carry the /api/v3 prefix
    const hit = stack.mock.calls
      .slice(before)
      .some((c) => routeFor(c.method, c.path)?.operationId === op.operationId);
    expect(hit, `${op.operationId} reached LK (saw ${seen.map((s) => s?.operationId).join(', ')})`).toBe(
      true,
    );
  });
});
