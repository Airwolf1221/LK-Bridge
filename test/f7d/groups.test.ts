/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * v3 F7d (ADR 0077, A1 to A4): a character's whole art set in one arkona_add_character_art call (`groups`), one
 * proposal with "Art page", "Design pieces" and one item per outfit, one job with one Art-page write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../packs/world.js';
import type { OwnersWorld } from '../packs/owners-world.js';
import { approveItems, f7dWorld, headingsOf, img, pageNamed, PROJECT, stage } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await f7dWorld();
});
afterAll(async () => {
  await w?.close();
});

const call = (args: Record<string, unknown>) =>
  w.call('arkona_add_character_art', { character: 'Nadira al-Khalid', project: 'test', ...args });
const ART = '[BSRC] Nadira al-Khalid - Character Art';

describe('A1–A4: design plus three outfits in one call', () => {
  it('is one proposal with "Art page", "Design pieces" and one item per outfit; approved whole, one job places all', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => stage(w)));
    const groups = [
      { images: [img(ids[0]!, 'Primary Reference - Character Portrait')] },
      { outfit: 'Silk Robe', images: [img(ids[1]!, 'Outfit Reference - Front')] },
      {
        outfit: 'Desert Armour',
        images: [img(ids[2]!, 'Outfit Reference - Front'), img(ids[3]!, 'Outfit Reference - Back')],
      },
      {
        outfit: 'Court Gown',
        images: [img(ids[4]!, 'Outfit Reference - Front'), img(ids[5]!, 'Detail Reference - Sleeve')],
      },
    ];
    const dry = await call({ groups, artPage: { temporalScope: '5A 900 - 5A 931' }, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.groups).toHaveLength(4);
    expect(dry.body.groups.map((g: { folder: string }) => g.folder)).toEqual([
      'the character’s own folder',
      'loose in Wardrobe (its only piece)',
      'a new folder Wardrobe / Desert Armour',
      'a new folder Wardrobe / Court Gown',
    ]);
    expect(dry.body.cost.job.uploads).toBe(6);
    expect(dry.body.cost.job.writes).toBeGreaterThan(6);
    const p = await call({ groups, artPage: { temporalScope: '5A 900 - 5A 931' } });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const items = w.stack.runtime.policy.proposals.itemsOf(String(p.body.proposalId))!;
    expect(items.items.map((i) => i.group)).toEqual([
      'Art page',
      'Design pieces',
      'Outfits',
      'Outfits',
      'Outfits',
    ]);
    expect(items.items.slice(1).every((i) => i.dependsOn.includes('art:page'))).toBe(true);
    const done = await approveItems(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(
      true,
    );
    const page = pageNamed(w, ART)!;
    expect(headingsOf(w, page.id)).toEqual(
      expect.arrayContaining([
        '2:Reference Images',
        '2:Wardrobe',
        '3:Silk Robe',
        '3:Desert Armour',
        '3:Court Gown',
      ]),
    );
    const h = headingsOf(w, page.id);
    expect(h.indexOf('3:Silk Robe')).toBeLessThan(h.indexOf('3:Desert Armour'));
    expect(h.indexOf('3:Desert Armour')).toBeLessThan(h.indexOf('3:Court Gown'));
    const report = (done.job?.result as { artGroups?: { group: string; placed: unknown[] }[] }).artGroups!;
    expect(report.map((g) => [g.group, g.placed.length])).toEqual([
      ['Design pieces', 1],
      ['Outfit Silk Robe', 1],
      ['Outfit Desert Armour', 2],
      ['Outfit Court Gown', 2],
    ]);
    void C;
    void PROJECT;
  });
});

describe('A2: placement per group on the existing Art page, merged groups, one write', () => {
  it('a move from an existing loose piece, a group into its folder, a new loose outfit; duplicates merged', async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => stage(w)));
    const groups = [
      { outfit: 'Silk Robe', images: [img(ids[0]!, 'Outfit Reference - Back')] },
      { outfit: 'Desert Armour', images: [img(ids[1]!, 'Detail Reference - Gauntlet')] },
      { outfit: 'Sun Veil', images: [img(ids[2]!, 'Outfit Reference - Front')] },
      { outfit: 'silk  robe', images: [img(ids[3]!, 'Detail Reference - Hem')] },
    ];
    const dry = await call({ groups, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(
      dry.body.groups.map((g: { group: string; folder: string; moves: string[] }) => [
        g.group,
        g.folder,
        g.moves,
      ]),
    ).toEqual([
      [
        'Outfit Silk Robe',
        'a new folder Wardrobe / Silk Robe',
        ['Nadira al-Khalid - Silk Robe - Outfit Reference - Front'],
      ],
      ['Outfit Desert Armour', 'its folder Wardrobe / Desert Armour', []],
      ['Outfit Sun Veil', 'loose in Wardrobe (its only piece)', []],
    ]);
    expect(JSON.stringify(dry.body.notes)).toMatch(
      /groups \[0\], \[3\] all name .Silk Robe.: merged into one group \(2 images\)/,
    );
    const p = await call({ groups });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approveItems(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(
      true,
    );
    const page = pageNamed(w, ART)!;
    // ONE write to the Art page (its document), whatever the number of groups.
    const writes = w.stack.runtime.engine.queries
      .journalLookup(PROJECT, { jobId: done.job!.id, limit: 500 })
      .filter((e) => e.opId === 'replaceDocumentBlocks');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.targetId).toBe(
      w.repo.liveDocs(w.repo.res.get(page.id)!).find((d) => d.name === 'Main')!.id,
    );
    const silk = w.assets.byName('Silk Robe').find((a) => a.type === 'FOLDER')!;
    expect(w.assets.byName('Nadira al-Khalid - Silk Robe - Outfit Reference - Front')[0]!.folderId).toBe(
      silk.id,
    );
    expect(w.assets.byName('Nadira al-Khalid - Silk Robe - Detail Reference - Hem')[0]!.folderId).toBe(
      silk.id,
    );
    const armour = w.assets.byName('Desert Armour').find((a) => a.type === 'FOLDER')!;
    expect(
      w.assets.byName('Nadira al-Khalid - Desert Armour - Detail Reference - Gauntlet')[0]!.folderId,
    ).toBe(armour.id);
    const h = headingsOf(w, page.id);
    expect(h.filter((x) => x === '3:Silk Robe')).toHaveLength(1);
    expect(h).toContain('3:Sun Veil');
    const rec = w.stack.runtime.outfits
      .forCharacter(PROJECT, w.assets.byName('Nadira al-Khalid').find((a) => a.type === 'FOLDER')!.id)
      .find((o) => o.name === 'Silk Robe')!;
    expect(rec.pieces).toHaveLength(3);
  });
});

describe('A2: every problem of every group refuses the whole call', () => {
  it('a near miss in one group and a bad name in another: one refusal listing both, nothing proposed', async () => {
    const ids = await Promise.all([1, 2, 3].map(() => stage(w)));
    const r = await call({
      groups: [
        { images: [img(ids[0]!, 'Primary Reference - Side')] },
        { outfit: 'Desert Armor', images: [img(ids[1]!, 'Outfit Reference - Side')] },
        { outfit: 'Wardrobe', images: [img(ids[2]!, 'Outfit Reference - Side')] },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('ART_GROUPS_REFUSED');
    const codes = (r.body.error.problems as { code: string }[]).map((p) => p.code);
    expect(codes).toEqual(['OUTFIT_NEAR_MATCH', 'OUTFIT_NAME_INVALID']);
    expect(r.body.error.message).toMatch(/2 problems/);
  });

  it('the limits (ART_CALL_MAX_GROUPS, ART_CALL_MAX_IMAGES), and one form or the other', async () => {
    const many = await call({
      groups: Array.from({ length: 41 }, (_, i) => ({ outfit: `Outfit ${i}`, images: [] })),
    });
    expect(many.body.error.code).toBe('ART_CALL_TOO_LARGE');
    const big = await call({
      groups: [
        { images: Array.from({ length: 121 }, (_, i) => img(`stg${i}`, `Primary Reference - N${i}`)) },
      ],
    });
    expect(big.body.error.code).toBe('ART_CALL_TOO_LARGE');
    expect(big.body.error.message).toMatch(/ART_CALL_MAX_IMAGES/);
    const mixed = await call({ groups: [{ images: [] }], outfit: 'Silk Robe' });
    expect(mixed.body.error.code).toBe('ART_FORMS_MIXED');
  });
});
