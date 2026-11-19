/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- introspection of the runtime */
/**
 * CR-2026-11-R3, R3-65 (High; part B addition, the owner's report): the live bridge reached 1.3 GB of memory and 1.2 GB
 * of swap 11 hours after a restart, with no heavy operation run: background maintenance (a change snapshot every few
 * minutes, the scheduled audit, the 05:30 sweep) and ordinary agent MCP traffic. This simulates hours of exactly that in
 * one process: each round a new MCP connection reading as an agent does (the tool list, a search, a page, its text, the
 * tree) and one direct write, whose change snapshot is laid over the appraisal index; the scheduled audit every ten
 * rounds, the tree's sweep every twenty and the block-id sweep once. Measured after a full collection at checkpoints.
 *
 * Found: every LegendKeeper request kept the whole MCP request that made it reachable for 35 seconds after it had ended
 * (its server, its transport and every tool registered on it, about 115 kB each): the LegendKeeper SDK arms a 35-second
 * `AbortSignal.timeout` on every request, and on Node 24 a timer keeps the async context it was made in, which held the
 * governor's call. The heap climbed with the traffic, and stayed up as long as it lasted. Mocks and fixtures only.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CANON_ROWS, PROJECT, r3World, type SeedPage } from '../r3-retag/helpers.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
const PAGES = 120;
const pid = (i: number) => `bg${String(i).padStart(5, '0')}`;

// Every MCP exchange's server-side transport, weakly: which of them are still reachable once their requests have ended.
const exchanges = new Set<WeakRef<object>>();
const proto = WebStandardStreamableHTTPServerTransport.prototype as any;
const handleRequest = proto.handleRequest as (...a: unknown[]) => unknown;
proto.handleRequest = function (this: object, ...a: unknown[]) {
  exchanges.add(new WeakRef(this));
  return handleRequest.apply(this, a);
};
afterAll(() => {
  proto.handleRequest = handleRequest;
});

/** A full collection in a later turn of the event loop (nothing of this turn held), then the heap in MB. */
async function settledHeap(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / MB;
}

/** How many ended exchanges are still reachable (counted after `settledHeap`). */
function reachable(): number {
  let n = 0;
  for (const r of exchanges) if (r.deref()) n++;
  exchanges.clear(); // counted once: the next checkpoint counts the exchanges made since
  return n;
}

const seed = (): SeedPage[] =>
  Array.from({ length: PAGES }, (_, i) => ({
    id: pid(i),
    name: `[BSRC] Tide Ledger ${i} - Polity Reference`,
    tags: ['CANON', 'Polity'],
    rows: CANON_ROWS,
  }));

describe('R3-65: memory over hours of background work and agent traffic', () => {
  it('settles: nothing of an ended request stays reachable, and the heap does not climb', async () => {
    const w = await r3World(seed());
    try {
      for (let i = 0; i < PAGES; i++)
        w.repo.blocks.set(w.mainOf(pid(i)), {
          version: 1,
          blocks: Array.from({ length: 10 }, (_, k) => ({
            id: `${pid(i)}b${k}`,
            kind: 'paragraph',
            content: [{ text: `Ledger ${i}, line ${k}: the tide gate's stores were counted and sealed.` }],
          })),
        });
      await w.snapshot();
      const rt: any = w.stack.runtime;
      const call = (client: Client, name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: { project: 'test', ...args } });
      let n = 0;
      let writeErrors = 0;
      const round = async () => {
        n++;
        const page = pid(n % PAGES);
        const client = new Client({ name: 'r3-memory', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${w.stack.base}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${w.stack.token}` } },
          }),
        );
        try {
          await client.listTools();
          await call(client, 'bridge_info', {});
          await call(client, 'search', { query: 'tide gate stores', content: true });
          await call(client, 'get_resource', { resource: page });
          await call(client, 'read_document', { resource: page });
          await call(client, 'browse_repository_tree', {});
          // One direct write (an agent's ordinary edit): a tag added, and on a later visit taken off again.
          const tag = `Round${n % 2}`;
          const r = await call(client, 'update_resource', {
            page,
            tags: n % 4 < 2 ? { add: [tag] } : { remove: [tag] },
          });
          if (r.isError) writeErrors++;
        } finally {
          await client.close().catch(() => undefined);
        }
        await rt.snapshots.settled();
        if (n % 10 === 0) await rt.audits.run(PROJECT, 'schedule');
        if (n % 20 === 0) await rt.tree.sweep(PROJECT, 'schedule');
        if (n === 30) await rt.maintenance.blockIds.run(PROJECT);
      };
      for (let i = 0; i < 10; i++) await round(); // warm-up
      await settledHeap();
      reachable();
      const points: { round: number; heapMb: number; reachable: number }[] = [];
      for (let c = 0; c < 4; c++) {
        for (let i = 0; i < 20; i++) await round();
        const heapMb = Math.round(await settledHeap());
        points.push({ round: n, heapMb, reachable: reachable() });
      }
      const changes = rt.snapshots.index.db
        .prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE kind = 'change'`)
        .get().n as number;
      const report = JSON.stringify({ points, writeErrors, changes });
      console.info(`[R3-65] ${report}`);
      expect(writeErrors).toBe(0);
      expect(changes).toBeGreaterThanOrEqual(30);
      // SAFE: once a request has ended, nothing of it is reachable (on the reviewed code: every exchange of the last 35
      // seconds, with its server and tools)...
      for (const p of points) expect(p.reachable, report).toBe(0);
      // ...and the heap does not climb with the rounds (60 more of them add less than 8 MB).
      expect(points.at(-1)!.heapMb - points[0]!.heapMb, report).toBeLessThan(8);
    } finally {
      await w.close();
    }
  });
});
