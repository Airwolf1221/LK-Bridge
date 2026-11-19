/**
 * v3 F3e (ADR 0059): the splits the tests propose, as an agent would give them (the destination maps).
 */
import { O, OSTRAND, P, S } from './split-world.js';

/** Zahra's monolith split, the source surviving with an interface summary for each section that leaves it. */
export function zahraSplit(more: Record<string, unknown> = {}) {
  return {
    source: S.zahra,
    destinations: [
      {
        key: 'bio',
        kind: 'new',
        role: 'specialist',
        title: 'Biography',
        referenceType: 'Character Biography',
        scope: 'Zahra al-Rashid: her life on the caravan roads',
        purpose: 'The life of Zahra al-Rashid, from her first caravan to the fall of the house.',
      },
      {
        key: 'looks',
        kind: 'new',
        role: 'specialist',
        title: 'Physical & Visual Reference',
        referenceType: 'Character Physical & Visual Reference',
        scope: 'Zahra al-Rashid: how she looks',
        purpose: 'How Zahra al-Rashid looks, with her reference images and what each establishes.',
      },
      {
        key: 'art',
        kind: 'new',
        role: 'art',
        scope: 'Zahra al-Rashid: her wardrobe images',
        purpose: 'The visual references of Zahra al-Rashid’s wardrobe.',
      },
      {
        key: 'wardrobe',
        kind: 'new',
        role: 'specialist',
        title: 'Wardrobe & Personal Presentation',
        referenceType: 'Character Wardrobe & Personal Presentation Reference',
        scope: 'Zahra al-Rashid: what she wears',
        purpose: 'What Zahra al-Rashid wears on the road and at court.',
      },
      {
        key: 'rel',
        kind: 'relationship',
        with: 'Nadira al-Khalid',
        scope: 'Zahra al-Rashid and Nadira al-Khalid: their bond',
        purpose: 'The bond between Zahra al-Rashid and Nadira al-Khalid.',
      },
      {
        key: 'powers',
        kind: 'new',
        role: 'specialist',
        title: 'Powers & Mechanics',
        referenceType: 'Character Powers & Mechanics Reference',
        scope: 'Zahra al-Rashid: her sorcery',
        purpose: 'What Zahra al-Rashid can do with her fire-binding.',
      },
      {
        key: 'magic',
        kind: 'universal',
        owner: S.sorcery,
        text: 'Zahra draws her fire-binding through the focus stone Salahad Sorcery requires of every practitioner.',
      },
    ],
    map: [
      { section: 'Purpose', to: 'stays' },
      { section: 'Identity', to: 'stays' },
      { section: 'Biography', to: 'bio', summary: 'Her life is told in full on her Biography page.' },
      { section: 'Appearance', to: 'looks', summary: 'How she looks, with her reference images.' },
      { section: 'Personality', to: 'stays' },
      { section: 'Habits', to: 'stays' },
      {
        section: 'Wardrobe',
        blocks: [
          { ids: ['zh6', 'zw1'], to: 'wardrobe', summary: 'What she wears, on the road and at court.' },
          { ids: ['zwimg1', 'zw2', 'zwimg2', 'zw3'], to: 'art', summary: 'Her wardrobe images.' },
        ],
      },
      { section: 'Zahra and Nadira al-Khalid', to: 'rel', summary: 'Her bond with Nadira al-Khalid.' },
      {
        section: 'Powers',
        blocks: [
          { ids: ['zh8', 'zw4', 'zw6'], to: 'powers', summary: 'Her fire-binding sorcery.' },
          { ids: ['zw5'], to: 'magic' },
        ],
      },
      { section: 'Source Boundaries', to: 'stays' },
      {
        section: 'Unresolved Material',
        blocks: [
          { ids: ['zh10', 'zu5'], to: 'stays' },
          {
            ids: ['zu1', 'zu2'],
            to: 'powers',
            under: 'Unresolved Material',
            summary: 'Open questions about her powers are on her Powers page.',
          },
          {
            ids: ['zu3', 'zu4'],
            to: 'wardrobe',
            under: 'Unresolved Material',
            summary: 'Open questions about her wardrobe are on her Wardrobe page.',
          },
        ],
      },
    ],
    dependencies: [{ page: P.nadiraBio, to: 'rel' }],
    ...more,
  };
}

/** The Ostrand owner's split: Law to a new Law owner, Faith to the existing Sun Rite; the source retired. */
export function statutesSplit(more: Record<string, unknown> = {}) {
  return {
    source: S.statutes,
    retire: true,
    destinations: [
      {
        key: 'law',
        kind: 'new',
        type: 'Law',
        name: 'Ostrand Statutes',
        referenceType: 'Law Reference',
        home: 'Ostrand Laws',
        scope: 'The statutes and assize courts of Ostrand',
        temporalScope: '4A 100 - 5A 931',
        purpose: 'The statutes of Ostrand and how its assize courts apply them.',
      },
      { key: 'rite', kind: 'existing', page: S.sunRite, under: 'Worship under the Statutes' },
    ],
    map: [
      { section: 'Purpose', to: 'stays' },
      { section: 'Overview', to: 'stays' },
      { section: 'Law and Courts', to: 'law' },
      { section: 'Faith and Worship', to: 'rite' },
      { section: 'Source Boundaries', to: 'stays' },
      { section: 'Unresolved Material', to: 'stays' },
    ],
    dependencies: [
      { page: S.ostrandPolity, to: 'law' },
      { page: S.assizes, to: 'law' },
    ],
    ...more,
  };
}

export { O, OSTRAND };
