import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, kvText, P, type FactsWorld } from './world.js';
import type { Client } from '@modelcontextprotocol/client';

let w: FactsWorld;
let client: Client;
beforeAll(async () => {
  w = await factsWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('smoke', () => {
  it('changes a fact', async () => {
    const r = await w.stack.call(client, 'set_facts', { page: P.miyabi, facts: { Notes: 'Second notes' } });
    console.log(JSON.stringify(r.body, null, 1), r.footer);
    console.log(w.sidebars.requests.map((x) => `${x.method} ${x.path} ${x.ifMatch ?? ''}`));
    expect(kvText(w.sidebars.rows(P.miyabi))).toContain('Notes=Second notes');
  });
});
