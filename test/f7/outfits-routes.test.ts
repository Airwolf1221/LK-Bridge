/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON replies */
/**
 * v3 F7 (ADR 0070, G3): the outfit record on the dashboard: seeding reads the character's folders LIVE and waits for
 * the owner's review (nothing recorded until Save, with the step-up); ambiguous names are listed, never recorded; the
 * owner's aliases. Mehrana's real layout (test/f7/fixtures.ts) is built in the mock first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { automationWorld, PROJECT, type AutomationWorld } from '../automation/world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';

vi.setConfig({ testTimeout: 180_000 });

const M = 'Mehrana al-Khalid';
let w: AutomationWorld;
let owner: OwnerHttp;
let folder = '';
beforeAll(async () => {
  w = await automationWorld();
  owner = ownerHttp(w);
  const qishen = w.assets.byName('Qishen').find((a) => a.type === 'FOLDER')!.id;
  folder = w.assets.folder(M, qishen);
  w.assets.image(`${M} - Primary Reference`, folder);
  const wardrobe = w.assets.folder('Wardrobe', folder);
  for (const o of ['Maid Uniform', 'Rangawan Archer', 'Supreme Imperial Regalia - Magenta Ayullid Ensemble'])
    w.assets.image(`${M} - ${o}`, wardrobe);
  w.assets.image(`${M} - Outfit Reference - Stray`, wardrobe); // ambiguous: a Visual Role where the outfit would be
  const wedding = w.assets.folder('Wedding Dress', wardrobe);
  w.assets.image(`${M} - Wedding Dress - Front`, wedding);
  w.assets.image(`${M} - Wedding Dress - Back`, wedding);
});
afterAll(async () => w?.close());

describe('G3: seeding and aliases on the dashboard', () => {
  let seedId = '';
  it('Seed reads the folder live (the asset tree had never seen it) and lists, without recording', async () => {
    expect(w.stack.runtime.assets.queries.folder(PROJECT, folder).data).toBeNull();
    const r = await owner.post('/art/outfits/seed', { character: M });
    // Not in the tree yet: the folder is found by name only once read; the owner names it by id then.
    expect(r.status).toBe(404);
    const byId = await owner.post('/art/outfits/seed', { folderId: folder });
    expect(byId.status).toBe(404);
    // The tree learns the folder from its parent's live read (as the art tool does), then the seed reads it live.
    const parent = w.assets.byName('Qishen').find((a) => a.type === 'FOLDER')!.id;
    await w.stack.runtime.assets.refreshFolder(PROJECT, parent, { depth: 1 });
    const ok = await owner.post('/art/outfits/seed', { character: M });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const seed = ok.json.seed;
    seedId = seed.id;
    expect(seed.state).toBe('pending');
    expect(seed.result.outfits.map((o: any) => [o.name, o.pieces.length])).toEqual([
      ['Maid Uniform', 1],
      ['Rangawan Archer', 1],
      ['Supreme Imperial Regalia', 1],
      ['Wedding Dress', 2],
    ]);
    expect(seed.result.ambiguous.map((a: any) => a.name)).toEqual([`${M} - Outfit Reference - Stray`]);
    expect(w.stack.runtime.outfits.forCharacter(PROJECT, folder)).toEqual([]);
  });

  it('Save asks for the step-up, then records; aliases are the owner’s', async () => {
    owner.expire();
    expect((await owner.post(`/art/outfits/seed/${seedId}/save`, {})).status).toBe(403);
    owner.stepUp();
    const saved = await owner.post(`/art/outfits/seed/${seedId}/save`, {});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.outfits).toHaveLength(4);
    const listed = await owner.get(`/art/outfits?folderId=${folder}`);
    expect(listed.json.characters).toEqual([{ characterFolderId: folder, characterName: M, outfits: 4 }]);
    const regalia = listed.json.outfits.find((o: any) => o.name === 'Supreme Imperial Regalia');
    const added = await owner.post(`/art/outfits/${regalia.id}/aliases`, { alias: 'Magenta Regalia' });
    expect(added.json.outfit.aliases).toEqual(['Magenta Regalia']);
    const taken = await owner.post(`/art/outfits/${listed.json.outfits[0].id}/aliases`, {
      alias: 'magenta regalia',
    });
    expect(taken.status).toBe(409);
    const removed = await owner.post(`/art/outfits/${regalia.id}/aliases/remove`, {
      alias: 'Magenta Regalia',
    });
    expect(removed.json.outfit.aliases).toEqual([]);
    expect((await owner.post(`/art/outfits/seed/${seedId}/discard`, {})).status).toBe(409);
  });
});
