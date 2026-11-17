/**
 * CR-2026-11 round 2 (write scope): the other write routes an agent has, with the DEFAULT rails: the per-operation tools
 * (`lk_op_<operationId>`, when MCP_EXPOSE_PER_OP_TOOLS=true) and the high-level delete tools. Every test asserts the
 * SAFE behaviour: a delete the rail names is ONE proposal and nothing is sent.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import { discoverWorld, type DiscoverWorld } from '../../discover/world.js';
import { writeAgent, writeCallsSince, type Agent } from './helpers.js';

let w: DiscoverWorld;
let a: Agent;
const board = {
  version: 1,
  shapes: [{ id: 'shape:1', type: 'geo', parentId: 'page:1', index: 'a1', props: {} }],
};

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    env: {
      MCP_EXPOSE_PER_OP_TOOLS: 'true',
      LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }),
    },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-routes-agent');
  w.overrides.set(
    new RegExp(`/resources/board001/docs/${w.docs.board}/board$`),
    (req: MockRequest): MockResponse | undefined => {
      const view = () => ({
        version: `bv${board.version}`,
        pages: [{ id: 'page:1', name: 'Plot' }],
        shapes: board.shapes,
        bindings: [],
      });
      if (req.method === 'GET') return { status: 200, body: view() };
      if (req.method === 'PUT') {
        board.shapes = (req.body as { shapes: typeof board.shapes }).shapes;
        board.version++;
        return { status: 200, body: view() };
      }
      return undefined;
    },
  );
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const sent = (n: number) => writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`);

describe('per-operation tools', () => {
  it('R1: lk_op_deleteResource is a proposal (deletes rail)', async () => {
    const tools = await a.client.listTools();
    expect(tools.tools.some((t) => t.name === 'lk_op_deleteResource')).toBe(true);
    const n = w.stack.mock.calls.length;
    const r = await call('lk_op_deleteResource', { path: { resourceId: 'loose001' } });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(sent(n)).toEqual([]);
  });

  it('R2: lk_op_replaceBoardContent with no shapes is a proposal (same gap as A1, another route)', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_op_replaceBoardContent', {
      path: { resourceId: 'board001', documentId: w.docs.board },
      body: { shapes: [] },
    });
    expect(
      { status: r.body.status, shapesLeft: board.shapes.length },
      `${r.text}\n${JSON.stringify(sent(n))}`,
    ).toEqual({
      status: 'proposal_captured',
      shapesLeft: 1,
    });
  });
});

describe('high-level delete tools', () => {
  it('R3: delete_document (a board) is a proposal (deletes rail)', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('delete_document', { page: 'board001', document: w.docs.board, confirm: true });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(sent(n)).toEqual([]);
  });
});
