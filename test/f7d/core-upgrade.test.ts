/**
 * v3 F7d (ADR 0077, A2): F7.1's Core rule in a groups call: a standalone Compact character whose whole art set arrives
 * in one call gets its index, its Core (upgraded in the same package, inside the "Art page" item of a proposal) and its
 * Art page. v3 F12 (ADR 0081): at scope write the package is one direct job; at scope propose it is one proposal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { coreWorld } from '../f7_1/world.js';
import { headingsOf, img, linksOf, pageNamed, stage } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await coreWorld();
});
afterAll(async () => {
  await w?.close();
});

const emineArt = (ids: string[]) => ({
  character: 'Emine al-Noor',
  project: 'test',
  groups: [
    { images: [img(ids[0]!, 'Expression Reference - Smile')] },
    { outfit: 'Courier Coat', images: [img(ids[1]!, 'Outfit Reference - Front')] },
  ],
});

describe('A2: the Core rule applies to a groups call', () => {
  it('at scope propose, one proposal: index, Core upgrade and Art page in "Art page"; design pieces and an outfit after it', async () => {
    const ids = await Promise.all([1, 2].map(() => stage(w)));
    const proposer = w.stack.newToken('art-proposer', 'propose');
    const pc = await w.stack.connect(proposer.token);
    const p = await w.stack.call(pc, 'arkona_add_character_art', emineArt(ids));
    expect(p.body.status, p.text).toBe('proposal_captured');
    const items = w.stack.runtime.policy.proposals.itemsOf(String(p.body.proposalId))!.items;
    expect(items.map((i) => i.id)).toEqual(['art:page', 'art:design', 'art:outfit:courier coat']);
    expect(items[0]!.label).toMatch(/upgraded to its Character Core/);
    w.stack.runtime.policy.commands.reject('owner', String(p.body.proposalId), 'not now');
    expect(pageNamed(w, '[BSRC] Emine al-Noor - Character Core')).toBeUndefined();
  });

  it('at scope write, one direct job: the index, the Core (upgraded) and the Art page with its design pieces and outfit', async () => {
    const ids = await Promise.all([1, 2].map(() => stage(w)));
    const p = await w.call('arkona_add_character_art', emineArt(ids));
    expect(p.body.status, p.text).toBe('written');
    expect(p.body.proposalId).toBeUndefined();
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(p.body.jobId));
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    expect((job?.result as { verified?: boolean }).verified, JSON.stringify(job?.result)).toBe(true);
    const groups = p.body.artGroups as { key: string }[];
    expect(groups.map((g) => g.key)).toEqual(['design', 'outfit:courier coat']);
    const core = pageNamed(w, '[BSRC] Emine al-Noor - Character Core');
    expect(core).toBeDefined();
    const art = pageNamed(w, '[BSRC] Emine al-Noor - Character Art')!;
    expect(headingsOf(w, art.id)).toEqual(expect.arrayContaining(['2:Wardrobe', '3:Courier Coat']));
    expect(linksOf(w, art.id, 'Dependencies')).toEqual([core!.id]);
  });
});
