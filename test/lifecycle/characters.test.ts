/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Working characters (v2 C2c, ADR 0035): create_character puts the whole set under [INDEX] Working (a Core with its own
 * [INDEX] {name}, a compact page directly under it); promoting the Core takes the character's index with it to the
 * destination (normally the race index), other pages under the index keeping their state; a compact page goes alone.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childNames, facts } from '../resources/world.js';
import { accept, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });

beforeAll(async () => {
  w = await lifecycleWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('a Working character', () => {
  it('promoting its Core moves its [INDEX] {name} with it; with other pages under the index it is refused (E4) until they move out', async () => {
    const core = await call('create_character', { kind: 'core', name: 'Ren Kai', race: 'Foxian' });
    expect(core.body, core.text).toMatchObject({ status: 'written', verified: true });
    const [idx, page] = core.body.pages;
    expect(idx).toMatchObject({ name: '[INDEX] Ren Kai', parent: { id: LIFECYCLE.working } });
    expect(page).toMatchObject({ name: '[BWRK] Ren Kai - Character Core', parent: { id: idx.id } });
    // A Working page under the character's index (create_many_resources allows a character index directly under
    // [INDEX] Working as a Working item's parent).
    const art = await call('create_many_resources', {
      items: [{ key: 'art', name: '[BWRK] Ren Kai - Art', parent: idx.id }],
    });
    expect(art.body, art.text).toMatchObject({ status: 'written', verified: true });
    // v2 E4 (RV2-2, ADR 0046 decision 2): the Art page would have gone into canon with the index, still Working, on an
    // approval of the Core alone. Refused, naming it and the set route; nothing is proposed.
    const refused = await call('promote_page', { page: page.id, destination: 'Foxians' });
    expect(refused.body.error).toMatchObject({ code: 'SET_HAS_OTHER_PAGES' });
    expect(refused.body.error.message).toMatch(/\[BWRK\] Ren Kai - Art/);
    expect(refused.body.error.message).toMatch(/subtree: true/);
    // Moved out first (an ordinary move within the Working area), the Core is promoted with its index.
    const out = await call('move_resource', { page: art.body.pages[0].id, to: LIFECYCLE.working });
    expect(out.body.status, out.text).toBe('written');
    const r = await call('promote_page', { page: page.id, destination: 'Foxians' });
    expect(r.body, r.text).toMatchObject({
      status: 'proposal_captured',
      characterIndex: { id: idx.id, movesWith: true },
    });
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(idx.id)).toMatchObject({ parentId: 'foxian01' });
    expect(w.repo.live(page.id)).toMatchObject({ name: '[BSRC] Ren Kai - Character Core', parentId: idx.id });
    expect(w.repo.live(art.body.pages[0].id)).toMatchObject({
      name: '[BWRK] Ren Kai - Art',
      parentId: LIFECYCLE.working,
    });
    expect(childNames(w, 'foxian01')).toContain('[INDEX] Ren Kai');
    expect(facts(w, page.id)).toEqual(
      expect.arrayContaining(['Status=Authoritative', 'Race / Species=Foxian']),
    );
  });

  it('a compact Working character goes to its race when promoted', async () => {
    const c = await call('create_character', { kind: 'compact', name: 'Mira Sol', race: 'Human' });
    expect(c.body, c.text).toMatchObject({ status: 'written', verified: true });
    const p = c.body.pages[0];
    expect(p).toMatchObject({
      name: '[BWRK] Mira Sol - Character Reference',
      parent: { id: LIFECYCLE.working },
    });
    const done = await accept(w, await call('promote_page', { page: p.id, destination: 'Humans' }));
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(p.id)).toMatchObject({
      name: '[BSRC] Mira Sol - Character Reference',
      parentId: 'humans01',
    });
  });
});
