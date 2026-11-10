/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * create_many_resources (v2 C2b) at its limit, in a world of its own (a fresh budget): 100 nested pages in one
 * createManyResources call, each child in alphabetical order under a parent made in the same call; the verify step
 * checks them from the parent's listing (not one read per page).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { asCanon, childNames, resourcesWorld, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const node = (id: string) => w.stack.runtime.tree.queries.node(PROJECT, id).data;
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('create_many_resources at 100', () => {
  it('100 nested pages in one createManyResources call, each child in alphabetical order under the new parent', async () => {
    const items = [
      { key: 'root', name: '[INDEX] Batch Root', parent: 'Sources' },
      ...Array.from({ length: 99 }, (_, i) => ({
        key: `p${i}`,
        name: `[BSRC] Batch Page ${99 - i}`,
        parent_key: 'root',
        // v2 C2c: Working pages are flat under [INDEX] Working, so nested pages are Authoritative (canon).
        status: 'authoritative',
      })),
    ];
    const before = writes().length;
    const r = await asCanon(w, await call('create_many_resources', { items }));
    expect(r.body, r.text.slice(0, 2000)).toMatchObject({ status: 'written', verified: true });
    const ws = writes().slice(before);
    expect(ws.filter((l) => l === 'POST /resources/batch')).toHaveLength(1);
    const rootId = r.body.pages.find((p: { name: string }) => p.name === '[INDEX] Batch Root').id;
    const kids = childNames(w, rootId);
    expect(kids).toHaveLength(99);
    expect(kids.slice(0, 3)).toEqual(['[BSRC] Batch Page 1', '[BSRC] Batch Page 2', '[BSRC] Batch Page 3']);
    expect(kids.at(-1)).toBe('[BSRC] Batch Page 99');
    expect(node(rootId)).toMatchObject({ parentId: 'srcs0001', kind: 'index' });
    // The verify step checked the 99 pages from the new index's listing (one read), not one read per page.
    const listings = w.seen.filter(
      (l) => l.startsWith('GET /resources?') && l.includes(`parentId=${rootId}`),
    );
    expect(listings.length).toBeLessThanOrEqual(2);
  });
});
