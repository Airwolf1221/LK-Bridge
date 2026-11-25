/**
 * v3 F7d (ADR 0077, A2): F7.1's Core rule in a groups call: a standalone Compact character whose whole art set arrives
 * in one call gets its index, its Core (upgraded in the same proposal, inside the "Art page" item) and its Art page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnersWorld } from '../packs/owners-world.js';
import { coreWorld } from '../f7_1/world.js';
import { approveItems, headingsOf, img, linksOf, pageNamed, stage } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await coreWorld();
});
afterAll(async () => {
  await w?.close();
});

describe('A2: the Core rule applies to a groups call', () => {
  it('one proposal: index, Core upgrade and Art page in "Art page"; design pieces and an outfit after it', async () => {
    const ids = await Promise.all([1, 2].map(() => stage(w)));
    const p = await w.call('arkona_add_character_art', {
      character: 'Emine al-Noor',
      project: 'test',
      groups: [
        { images: [img(ids[0]!, 'Expression Reference - Smile')] },
        { outfit: 'Courier Coat', images: [img(ids[1]!, 'Outfit Reference - Front')] },
      ],
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const items = w.stack.runtime.policy.proposals.itemsOf(String(p.body.proposalId))!.items;
    expect(items.map((i) => i.id)).toEqual(['art:page', 'art:design', 'art:outfit:courier coat']);
    expect(items[0]!.label).toMatch(/upgraded to its Character Core/);
    const done = await approveItems(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(
      true,
    );
    const core = pageNamed(w, '[BSRC] Emine al-Noor - Character Core');
    expect(core).toBeDefined();
    const art = pageNamed(w, '[BSRC] Emine al-Noor - Character Art')!;
    expect(headingsOf(w, art.id)).toEqual(expect.arrayContaining(['2:Wardrobe', '3:Courier Coat']));
    expect(linksOf(w, art.id, 'Dependencies')).toEqual([core!.id]);
  });
});
