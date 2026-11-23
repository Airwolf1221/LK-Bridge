/**
 * v3 F7 (ADR 0070; design G2, G3, G4): the outfit record's rules on the owner's real layouts (test/f7/fixtures.ts):
 * seeding (never a guess), the near-match test, G4's names and the placement decision.
 */
import { describe, expect, it } from 'vitest';
import { readLayout, seedFromLayout } from '../../src/art/layout.js';
import { fixedName, looseOutfitOf, matchOutfit, nameProblem, nearReason } from '../../src/art/names.js';
import { decidePlacement } from '../../src/art/placement.js';
import { OutfitStore } from '../../src/art/store.js';
import { openDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { library, MEHRANA, mehranaTree, SORAYA, SORAYA_WARDROBE_LOOSE, sorayaTree } from './fixtures.js';

const sorayaLib = library(sorayaTree());
const sorayaLayout = readLayout(sorayaLib, sorayaLib.folderId(`Characters / Humans / Rangawan / ${SORAYA}`))!;
const mehranaLib = library(mehranaTree());
const mehranaLayout = readLayout(
  mehranaLib,
  mehranaLib.folderId(`Characters / Beastkin / Qishen / ${MEHRANA}`),
)!;

describe('G3: seeding from the live layout (never a guess)', () => {
  it('Soraya: five loose single-piece outfits and Jade Moon Kimono’s folder of eight; nothing ambiguous', () => {
    const s = seedFromLayout(sorayaLayout);
    expect(s.ambiguous).toEqual([]);
    expect(s.outfits.map((o) => [o.name, o.pieces.length, o.folderId !== null])).toEqual(
      [...SORAYA_WARDROBE_LOOSE.map((o) => [o, 1, false]), ['Jade Moon Kimono', 8, true]].sort((a, b) =>
        String(a[0]).toLowerCase().localeCompare(String(b[0]).toLowerCase()),
      ),
    );
    expect(sorayaLayout.root).toHaveLength(4);
    expect(sorayaLayout.legacy).toEqual([]);
  });

  it('Mehrana: the loose pieces without a label are single-piece outfits; the four folders of two', () => {
    const s = seedFromLayout(mehranaLayout);
    expect(s.ambiguous).toEqual([]);
    const byName = Object.fromEntries(s.outfits.map((o) => [o.name, [o.pieces.length, o.folderId !== null]]));
    expect(byName).toEqual({
      'Al-Ghalian Uniform': [2, true],
      'Ayullid Harem Attire': [2, true],
      'Maid Uniform': [1, false],
      "Military Attire + Sovereign's Measure": [1, false],
      'Rangawan Archer': [1, false],
      'Rangawan Qipao': [1, false],
      'Sapphire Rose Gown': [2, true],
      'Supreme Imperial Regalia': [1, false],
      'Wedding Dress': [2, true],
    });
  });

  it('anything ambiguous is listed with why, never recorded', () => {
    const lib = library({
      [SORAYA]: {
        Wardrobe: {
          _items: [
            `${SORAYA} - Outfit Reference - Silk Robe`, // a Visual Role where the outfit would be
            'Someone Else - Gown', // another character's name
            SORAYA, // nothing after the name
            `${SORAYA} - Jade Moon Kimono - Detail`, // a loose piece of an outfit that has its folder
            `${SORAYA} - Silk Robe - Outfit Reference - Front`,
          ],
          'Jade Moon Kimono': { _items: [`${SORAYA} - Jade Moon Kimono - Front`], Extra: [] },
        },
        Forms: { 'Primary Appearance': [`${SORAYA} - Old Form`] },
      },
    });
    const layout = readLayout(lib, lib.folderId(SORAYA))!;
    const s = seedFromLayout(layout);
    expect(s.outfits.map((o) => o.name)).toEqual(['Jade Moon Kimono', 'Silk Robe']);
    expect(s.ambiguous.map((a) => a.why)).toEqual([
      'a folder inside an outfit folder',
      '“Outfit Reference” reads as a Visual Role (a label), not an outfit’s name',
      `its name does not start with “${SORAYA} - ”`,
      'its name has no outfit after the character’s',
      'a loose piece of “Jade Moon Kimono”, which also has its folder',
      'a legacy Forms folder holding 1 asset(s): not read as outfits',
    ]);
  });

  it('the store: a seeding waits for review; saving records it; aliases are the owner’s', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const store = new OutfitStore(db, () => 1000);
    const seed = store.createSeed({
      projectId: 'p',
      characterFolderId: 'cf',
      characterName: MEHRANA,
      result: { ...seedFromLayout(mehranaLayout), read: { requests: 7, at: 1000, ok: true } },
      by: 'owner',
    });
    expect(seed.state).toBe('pending');
    expect(store.forCharacter('p', 'cf')).toEqual([]);
    const saved = store.saveSeed('p', seed.id, 'owner');
    expect(saved.outfits).toHaveLength(9);
    expect(() => store.saveSeed('p', seed.id, 'owner')).toThrow(/already saved/);
    const regalia = saved.outfits.find((o) => o.name === 'Supreme Imperial Regalia')!;
    store.addAlias('p', regalia.id, 'Magenta Regalia', 'owner');
    expect(() => store.addAlias('p', saved.outfits[0]!.id, 'magenta  regalia', 'owner')).toThrow(
      /already names/,
    );
    expect(store.removeAlias('p', regalia.id, 'MAGENTA REGALIA').aliases).toEqual([]);
  });
});

describe('G3: the near-match test', () => {
  const near: [string, string][] = [
    ['Imperial Regalia', 'Supreme Imperial Regalia'],
    ['Kimono', 'Jade Moon Kimono'],
    ["Lu'lu'at al-Qamar", 'Luluat al Qamar'],
    ['Moonflower Yukata', 'Moonflower Yukta'],
    ['Sapphire Rose Gown', 'Sapphire Rose Dress'],
    ['Wedding Dress', 'Wedding Dresses'],
  ];
  const far: [string, string][] = [
    ['Maid Uniform', 'Al-Ghalian Uniform'],
    ['Jade Moon Kimono', 'Autumn Blossom Kimono'],
    ['Rangawan Archer', 'Rangawan Qipao'],
    ['Wedding Dress', 'Wedding Gown'],
    ['Shadowed Jade Kimono', 'Sun-Crowned Imperial Kimono'],
  ];
  it.each(near)('“%s” and “%s” are near', (a, b) => {
    expect(nearReason(a, b)).not.toBeNull();
    expect(nearReason(b, a)).not.toBeNull();
  });
  it.each(far)('“%s” and “%s” are not near', (a, b) => {
    expect(nearReason(a, b)).toBeNull();
  });
  it('the same outfit once case and spacing are normalised, by name or alias', () => {
    const outfits = [{ id: '1', name: 'Jade Moon Kimono', aliases: ['Moon Silk'] }];
    expect(matchOutfit('  jade   MOON kimono ', outfits).kind).toBe('same');
    expect(matchOutfit('moon silk', outfits)).toMatchObject({ kind: 'same', via: 'Moon Silk' });
    expect(matchOutfit('Moon Kimono', outfits).kind).toBe('near');
    expect(matchOutfit('Harbour Coat', outfits).kind).toBe('new');
  });
});

describe('G4: names', () => {
  it('a loose piece without a label is a valid single-piece outfit, never proposed for a rename', () => {
    expect(looseOutfitOf(`${MEHRANA} - Maid Uniform`, MEHRANA)).toEqual({
      outfit: 'Maid Uniform',
      label: '',
    });
    expect(
      nameProblem(`${MEHRANA} - Maid Uniform`, MEHRANA, { outfit: 'Maid Uniform', loose: true }),
    ).toBeNull();
    expect(fixedName(`${MEHRANA} - Maid Uniform`, MEHRANA, { outfit: 'Maid Uniform' })).toBeNull();
    expect(nameProblem(`${MEHRANA} - Primary Reference`, MEHRANA, { outfit: null })).toBeNull();
  });
  it('what breaks G4, and the fixes the bridge can make without guessing', () => {
    expect(nameProblem(`${SORAYA} - Portrait.png`, SORAYA, { outfit: null })).toMatch(/extension/);
    expect(fixedName(`${SORAYA} - Portrait.png`, SORAYA, { outfit: null })).toBe(`${SORAYA} - Portrait`);
    expect(fixedName(`${SORAYA} - Portrait.png (2)`, SORAYA, { outfit: null })).toBe(
      `${SORAYA} - Portrait (2)`,
    );
    expect(nameProblem('Soraya - Portrait', SORAYA, { outfit: null })).toMatch(/full name/);
    expect(fixedName('Soraya - Portrait', SORAYA, { outfit: null })).toBeNull();
    const inFolder = `${SORAYA} - Outfit Reference - Back`;
    expect(nameProblem(inFolder, SORAYA, { outfit: 'Jade Moon Kimono' })).toMatch(/does not name its outfit/);
    expect(fixedName(inFolder, SORAYA, { outfit: 'Jade Moon Kimono' })).toBe(
      `${SORAYA} - Jade Moon Kimono - Outfit Reference - Back`,
    );
  });
});

describe('G2: the placement decision, on the real layouts', () => {
  it('no outfit: a design piece in the character’s own folder', () => {
    expect(
      decidePlacement({ character: MEHRANA, layout: mehranaLayout, records: [], outfit: null, arriving: 3 }),
    ).toMatchObject({ ok: true, kind: 'design', subfolders: [] });
  });
  it('“Imperial Regalia” beside “Supreme Imperial Regalia” is refused, unless newOutfit', () => {
    const r = decidePlacement({
      character: MEHRANA,
      layout: mehranaLayout,
      records: [],
      outfit: 'Imperial Regalia',
      arriving: 1,
    });
    expect(r).toMatchObject({ ok: false, code: 'OUTFIT_NEAR_MATCH' });
    expect(r.ok === false && r.candidates?.map((c) => c.name)).toEqual(['Supreme Imperial Regalia']);
    expect(
      decidePlacement({
        character: MEHRANA,
        layout: mehranaLayout,
        records: [],
        outfit: 'Imperial Regalia',
        newOutfit: true,
        arriving: 1,
      }),
    ).toMatchObject({ ok: true, kind: 'outfit', into: 'wardrobe', subfolders: ['Wardrobe'] });
  });
  it('a second piece of a loose outfit: a new folder, the loose piece moved', () => {
    const r = decidePlacement({
      character: MEHRANA,
      layout: mehranaLayout,
      records: [],
      outfit: 'maid uniform',
      arriving: 1,
    });
    expect(r).toMatchObject({
      ok: true,
      kind: 'outfit',
      into: 'folder',
      subfolders: ['Wardrobe', 'Maid Uniform'],
      folderId: null,
      total: 2,
    });
    expect(r.ok && r.kind === 'outfit' && r.moves.map((m) => m.name)).toEqual([`${MEHRANA} - Maid Uniform`]);
  });
  it('an outfit with its folder takes more there; a new outfit of five goes straight into a new folder', () => {
    expect(
      decidePlacement({
        character: MEHRANA,
        layout: mehranaLayout,
        records: [],
        outfit: 'Wedding Dress',
        arriving: 1,
      }),
    ).toMatchObject({ into: 'folder', subfolders: ['Wardrobe', 'Wedding Dress'], moves: [], total: 3 });
    expect(
      decidePlacement({
        character: SORAYA,
        layout: sorayaLayout,
        records: [],
        outfit: 'Harbour Coat',
        arriving: 5,
      }),
    ).toMatchObject({
      into: 'folder',
      subfolders: ['Wardrobe', 'Harbour Coat'],
      folderId: null,
      moves: [],
      total: 5,
    });
  });
});
