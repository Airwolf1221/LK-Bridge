/**
 * ADR 0057 decision 4 (R2-52): every removal of content through a low-level tool (`lk_api_write`, `lk_api_batch`,
 * `lk_op_*`) is a delete for the deletes rail: with the default rails, an agent at scope `write` gets ONE proposal and
 * nothing is sent. A whole-list write (`replaceDocumentBlocks`, `updateProperty`, `updateBlock`…) is a removal only when
 * it drops an entry LegendKeeper holds now; one that keeps every entry runs directly. The high-level tools' removals
 * (planned, checked and revertible) are not affected.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeAgent, writeCallsSince, type Agent } from './helpers.js';

let w: FactsWorld;
let a: Agent;

beforeAll(async () => {
  w = await factsWorld({
    env: {
      MCP_EXPOSE_PER_OP_TOOLS: 'true',
      LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }),
    },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-removals-agent');
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const sent = (n: number) => writeCallsSince(w, n).map((c) => `${c.method} ${c.path}`);
const blocksOf = async () => {
  const r = await call('lk_api_read', {
    operationId: 'getDocumentBlocks',
    params: { path: { resourceId: 'age40001', documentId: w.docs.ageMain } },
    detail: 'full',
  });
  const v = (r.body.result ?? r.body) as { version?: string; blocks?: { id: string }[] };
  return { version: String(v.version ?? ''), blocks: v.blocks ?? [] };
};

describe('every low-level route', () => {
  it('lk_op_deleteBlock is a proposal; nothing is sent', async () => {
    const { version } = await blocksOf();
    const n = w.stack.mock.calls.length;
    const r = await call('lk_op_deleteBlock', {
      path: { resourceId: 'age40001', documentId: w.docs.ageMain, blockId: 'tbl1' },
      ifMatch: version,
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toBe('proposed because: delete (1 block)');
    expect(sent(n)).toEqual([]);
  });

  it('lk_api_batch with a sidebar row delete is a proposal; nothing is sent', async () => {
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'deletePropertyRow',
          params: { path: { resourceId: P.miyabi, propertyId: 'kvmiya01', rowId: 'kvmiya01r1' } },
        },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause, r.text).toMatch(/delete \(1 sidebar row\)/);
    expect(sent(n)).toEqual([]);
  });

  it('lk_api_write replaceDocumentBlocks leaving a block out is a proposal; nothing is sent', async () => {
    const { version, blocks } = await blocksOf();
    expect(blocks.length).toBeGreaterThan(1);
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: 'age40001', documentId: w.docs.ageMain },
        ifMatch: version,
        body: { blocks: blocks.filter((b) => b.id !== 'tbl1') },
      },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toBe('proposed because: delete (1 document replace that drops blocks)');
    expect(sent(n)).toEqual([]);
  });
});

describe('what is not a removal', () => {
  it('updateProperty adding an item to a link collection (keeping the others) runs directly', async () => {
    const before = await call('lk_api_read', {
      operationId: 'getProperty',
      params: { path: { resourceId: P.miyabi, propertyId: 'depmiya1' } },
      detail: 'full',
    });
    const items = ((before.body.result ?? before.body) as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBe(2);
    const r = await call('lk_api_write', {
      operationId: 'updateProperty',
      params: {
        path: { resourceId: P.miyabi, propertyId: 'depmiya1' },
        body: {
          items: [...items.map((i) => ({ id: i.id, resourceId: i.resourceId })), { resourceId: 'mehran01' }],
        },
      },
    });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    if (typeof r.body.jobId === 'string') {
      const done = await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
      expect(done.status).toBe('succeeded');
    }
  });

  it('with the deletes rail switched off, a low-level block delete runs directly', async () => {
    w.stack.runtime.policy.commands.setRails('owner', a.profileId, { deletes: false });
    try {
      const { version } = await blocksOf();
      const del = await call('lk_api_write', {
        operationId: 'deleteBlock',
        params: {
          path: { resourceId: 'age40001', documentId: w.docs.ageMain, blockId: 'tbl1' },
          ifMatch: version,
        },
      });
      expect(del.body.status, del.text).not.toBe('proposal_captured');
    } finally {
      w.stack.runtime.policy.commands.setRails('owner', a.profileId, { deletes: true });
    }
  });
});
