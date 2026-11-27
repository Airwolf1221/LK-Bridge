/**
 * The Arkona pack's seed (v3 F3a, ADR 0050; the owner-approved design docs/design/F3-character-pack.md). DATA, offered
 * once: at start the bridge stores it (if the pack is not stored yet) and attaches it to the projects named here. After
 * that the stored copy is the owner's: its token maps are edited on the Packs page, every change is a new version, and
 * nothing is used until the owner approves the version. Derived from Arkona's own governance pages (listed below), never
 * competing with them: a changed source stops tag computation until the owner approves again.
 */
import { packRulesSchema, type HomeRule, type PackRules, type PackSeed } from './types.js';

const STATUS = '$status';

/** v3 F6c (ADR 0080; the owner's ruling of 26 November 2026): the ten nation roles, in this order. */
const NATION_ROLES = [
  'Government & Administration',
  'Institutions',
  'Historical Events',
  'Military & Technology',
  'Unique Magic & Technologies',
  'Cultures',
  'Settlements & Locations',
  'Religion & Religious Administration',
  'Household & Court',
  'Historical Polities',
] as const;
/** v3 F6c: the approved variants, each mapping to a role. */
const NATION_ROLE_VARIANTS: readonly { readonly variant: string; readonly role: string }[] = [
  { variant: 'Government & Institutions', role: 'Government & Administration' },
  { variant: 'Institutions & Education', role: 'Institutions' },
  { variant: 'History & Conflicts', role: 'Historical Events' },
  { variant: 'Settlements & Infrastructure', role: 'Settlements & Locations' },
  { variant: 'Settlements & Historic City-States', role: 'Settlements & Locations' },
  { variant: 'Historical Polities & Integration', role: 'Historical Polities' },
  { variant: 'Founding Polities & Regions', role: 'Historical Polities' },
];

// v3 F3b (ADR 0052): the homes of the owner type table (docs/design/F3b-owner-tools.md, section 1.1), as data.
const continent = (category: string): HomeRule => ({ kind: 'category', level: 'continent', category });
const nationCategory = (category: string): HomeRule => ({ kind: 'category', level: 'nation', category });
const world = (category: string): HomeRule => ({ kind: 'category', level: 'world', category });
const NATION: HomeRule = { kind: 'nation' };
const BESTIARY: HomeRule = { kind: 'index', id: 'bb9fa6cf7acf8f62565d0d31', name: 'Bestiary' };
const MAGIC_AND_TECHNOLOGY: HomeRule[] = [
  continent('Unique Magic & Technologies'),
  nationCategory('Unique Magic & Technologies'),
  NATION,
];
/** Religion, Law, Programme, Education, Ceremony and Condition: the matching category index, or a nation index. */
const primaryOwner = (name: string, category: string, worldToo = false) => ({
  name,
  template: 'general',
  primary: name,
  specialist: [],
  homes: [continent(category), nationCategory(category), ...(worldToo ? [world(category)] : []), NATION],
});

const rules: PackRules = packRulesSchema.parse({
  schema: 1,
  // v3 F12 (ADR 0081): no switches. Every pack tool follows the agent's scope: direct at `write` (on the owner's Review
  // page, with Revert), a proposal at `propose`. The F3.4 per-tool "always propose" switches (`alwaysPropose`, `tools`)
  // are dropped by this seed's upgrade.
  settings: {},
  tags: {
    authoritative: 'CANON',
    working: 'Working',
    never: ['Unknown', 'Unestablished', 'None'],
    // v3 F3b (ADR 0052): the owner's ruling of 16 November 2026 (design 1.5; `rulings` below).
    au: { continuityType: 'AU', tag: 'AU' },
    // The Controlled Native Tagging Standard's own examples (v1.8). Keys are fact values (compared without case).
    race: {
      Human: 'Human',
      'High Human': 'High Human',
      'High Elf': 'High Elf',
      'Sun Elf': 'Sun Elf',
      'Sky Elf': 'Sky Elf',
      'True Dragon': 'True Dragon',
      Dragonkin: 'Dragonkin',
      Vitra: 'Vitra',
      Foxian: 'Foxian',
      Therian: 'Therian',
      Karu: 'Karu',
      Qishen: 'Qishen',
    },
    culture: {
      Menkheti: 'Menkheti',
      Falkenreicher: 'Falkenreicher',
      Canthan: 'Canthan',
      Velaran: 'Velaran',
      Fujimatsuan: 'Fujimatsuan',
      Draconic: 'Draconic',
      'Draconic (True Dragons)': 'Draconic',
      'Akashan Wishmaker': 'Akashan Wishmaker',
      // The standard's Otheiralth example: a Therian with a Therian naming culture (one tag after deduplication).
      Therian: 'Therian',
    },
    exceptional: ['Kami', 'Heavenly Beast'],
  },
  names: {
    forbiddenWords: ['CANON'],
    datePatterns: [
      '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
      '\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b',
      '\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?,?\\s+\\d{4}\\b',
      '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b',
      '\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\s+\\d{4}\\b',
      '\\b(?:19|20)\\d{2}\\b',
      '\\b(?:AA|\\d{1,2}A)\\s+\\d{1,7}\\b',
    ],
  },
  sidebar: { property: 'PROPERTIES', dependencies: 'Dependencies', related: 'Related Sources' },
  types: [
    {
      name: 'Character',
      tool: 'create_character',
      hook: 'character',
      placement: {
        kind: 'taxonomy',
        registryType: 'Character',
        field: 'race',
        fallbackIndex: 'Undetermined / Unknown',
      },
      roles: [
        {
          role: 'index',
          template: 'index',
          name: '{Name}',
          referenceType: null,
          tags: [],
          facts: 'none',
          body: 'drafted',
          warnMissing: [],
          max: 1,
        },
        {
          role: 'core',
          template: 'core',
          name: '{Name} - Character Core',
          referenceType: 'Character Core',
          tags: [STATUS, 'Character', '$race', '$culture'],
          facts: 'identity',
          body: 'required',
          warnMissing: ['Source Boundaries', 'Unresolved Material'],
          max: 1,
        },
        {
          role: 'compact',
          template: 'compact',
          name: '{Name} - Character Reference',
          referenceType: 'Compact Character Reference',
          tags: [STATUS, 'Character', '$race', '$culture'],
          facts: 'identity',
          body: 'required',
          warnMissing: ['Source Boundaries', 'Unresolved Material'],
          max: 1,
        },
        {
          role: 'art',
          template: 'art',
          name: '{Name} - Character Art',
          referenceType: 'Character Art',
          tags: [STATUS, 'Character', 'Character Art'],
          facts: 'general',
          body: 'required',
          warnMissing: [],
          max: 1,
        },
        {
          role: 'relationship',
          template: 'relationship',
          name: '{A} & {B} - {Label}',
          referenceType: 'Joint Character Relationship Reference',
          tags: [STATUS, 'Character', 'Relationship'],
          facts: 'general',
          body: 'required',
          warnMissing: ['Source Boundaries', 'Unresolved Material'],
          max: 20,
        },
        {
          role: 'specialist',
          template: 'general',
          name: '{Name} - {Title}',
          referenceType: null,
          tags: [STATUS, 'Character', '$specialist'],
          facts: 'general',
          body: 'required',
          warnMissing: [],
          max: 20,
        },
      ],
      identity: [
        { field: 'givenName', key: 'Personal / Given Name', gated: true },
        { field: 'surname', key: 'Family / Surname', gated: true },
        { field: 'race', key: 'Race / Species', gated: true },
        { field: 'namingCulture', key: 'Naming Culture', gated: true },
        { field: 'lifeState', key: 'Life State', gated: true },
        { field: 'temporalScope', key: 'Temporal Scope', gated: true },
        { field: 'subject', key: 'Subject', gated: false },
        { field: 'canonicalDisplayName', key: 'Canonical Display Name', gated: false },
        { field: 'aliases', key: 'Aliases', gated: false },
        { field: 'supersedes', key: 'Supersedes', gated: false },
      ],
      unestablished: 'Unestablished',
      placeholders: [
        'tbd',
        'tbc',
        'todo',
        'n/a',
        'na',
        'unknown',
        '?',
        '??',
        '-',
        '--',
        '…',
        '...',
        'placeholder',
        'fill in',
        'to be decided',
        'to be confirmed',
      ],
      fixedFacts: { 'Continuity Type': 'CANON', Continuity: 'Main', Inheritance: 'None' },
      generalKeys: [
        'Status',
        'Continuity Type',
        'Continuity',
        'Inheritance',
        'Subject',
        'Reference Type',
        'Scope',
        'Last Major Revision',
        'Supersedes',
      ],
      specialistTags: [
        'Biography',
        'Personality',
        'Relationship',
        'Character Art',
        'Visual Reference',
        'Wardrobe',
        'Magic',
        'Equipment',
      ],
      suggestedReferenceTypes: {
        biography: 'Character Biography',
        history: 'Character Biography',
        personality: 'Character Personality & Lifestyle Reference',
        lifestyle: 'Character Personality & Lifestyle Reference',
        ethos: 'Character Personality & Lifestyle Reference',
        conduct: 'Character Personality & Lifestyle Reference',
        physical: 'Character Physical & Visual Reference',
        visual: 'Character Physical & Visual Reference',
        appearance: 'Character Physical & Visual Reference',
        wardrobe: 'Character Wardrobe & Personal Presentation Reference',
        presentation: 'Character Wardrobe & Personal Presentation Reference',
        powers: 'Character Powers & Mechanics Reference',
        mechanics: 'Character Powers & Mechanics Reference',
        abilities: 'Character Powers & Mechanics Reference',
      },
      assets: {
        displayName: '{Subject} - {Label}',
        section: 'Reference Images',
        role: 'art',
      },
      index: {
        role: 'index',
        purpose:
          'Routes to the sources that hold {Name}’s material. This index holds no character material of its own.',
        routing: 'How to Use This Index',
        collection: 'Subpages',
        boundaries: 'Index Boundaries',
        boundariesText:
          'Each page below owns its own domain. This index only routes to them and repeats none of their material.',
      },
      text: {
        firstHeading: 'Purpose',
        unresolved: 'Unresolved Material',
        overload: {
          roles: ['core'],
          domains: {
            Biography: ['biography', 'history', 'early life', 'life story', 'background'],
            Personality: ['personality', 'temperament', 'conduct', 'ethos', 'lifestyle'],
            Powers: ['powers', 'abilities', 'magic', 'mechanics', 'combat'],
            Wardrobe: ['wardrobe', 'outfits', 'clothing', 'presentation'],
            Physical: ['physical', 'appearance'],
          },
          minChars: 1200,
        },
      },
      relationship: { role: 'relationship', subject: '{A} & {B}', defaultLabel: 'Relationship' },
    },
  ],
  // v3 F3b (ADR 0052): every non-character owner, one tool typed by this table (design section 1).
  owners: {
    tool: 'create_owner',
    facts: {
      required: ['Reference Type', 'Scope', 'Temporal Scope'],
      // The ten rows the five non-character templates share, in their rank order (the template gives the order).
      keys: [
        'Status',
        'Continuity Type',
        'Continuity',
        'Inheritance',
        'Subject',
        'Reference Type',
        'Scope',
        'Temporal Scope',
        'Last Major Revision',
        'Supersedes',
      ],
      fixed: { 'Continuity Type': 'CANON', Continuity: 'Main', Inheritance: 'None' },
      supersedes: 'None',
    },
    unestablished: 'Unestablished',
    placeholders: [
      'tbd',
      'tbc',
      'todo',
      'n/a',
      'na',
      'unknown',
      '?',
      '??',
      '-',
      '--',
      '…',
      '...',
      'placeholder',
      'fill in',
      'to be decided',
      'to be confirmed',
    ],
    // Design 1.4: CANON, the primary tag, optionally the specialist. A Working page (the owner, 16 November 2026; ADR
    // 0052 amendment): the lifecycle tag, then the primary, then the specialist if any, as the Tagging Standard keeps
    // "actually meaningful existing subject tags… after the lifecycle marker" and as F3a's Working characters do.
    tags: {
      authoritative: [STATUS, '$primary', '$specialist'],
      working: [STATUS, '$primary', '$specialist'],
    },
    worldPrefix: 'Arkonan',
    nations: 'Polities',
    text: {
      firstHeading: 'Purpose',
      unresolved: 'Unresolved Material',
      warnMissing: ['Source Boundaries', 'Unresolved Material'],
    },
    index: {
      template: 'index',
      purpose: 'Routes to the sources of {Name}. This index holds no material of its own.',
      navigationPurpose:
        'Routes to the characters of {Name}. This index holds no character material of its own.',
      routing: 'How to Use This Index',
      collection: 'Subpages',
      boundaries: 'Index Boundaries',
      boundariesText:
        'Each page below owns its own subject. This index only routes to them and repeats none of their material.',
      emptyRouting: 'Each page made here gets a line in this section.',
    },
    races: { root: { id: 'rraces01', name: 'Races of Arkona' }, navigation: 'Characters' },
    types: [
      {
        name: 'Polity',
        template: 'polity',
        primary: 'Polity',
        specialist: ['Government'],
        homes: [continent('Polities'), NATION],
      },
      {
        name: 'Institution',
        template: 'polity',
        primary: 'Institution',
        specialist: ['Government', 'Religion'],
        homes: [
          continent('Institutions'),
          NATION,
          nationCategory('Institutions'),
          nationCategory('Government & Administration'),
        ],
      },
      {
        name: 'Military',
        template: 'polity',
        primary: 'Military',
        specialist: [],
        homes: [NATION, nationCategory('Institutions')],
        note: 'The owner confirmed (16 November 2026): Military uses AI Polity and Institution.',
      },
      {
        name: 'Culture',
        template: 'general',
        primary: 'Culture',
        specialist: ['Language', 'Naming'],
        homes: [
          continent('Cultures'),
          nationCategory('Cultures'),
          world('Cultures'),
          { kind: 'named', name: 'Divine Realm Cultures' },
        ],
      },
      {
        name: 'Event',
        template: 'general',
        primary: 'Event',
        specialist: ['Conflict'],
        homes: [
          continent('Historical Events'),
          continent('Conflicts'),
          world('Historical Events'),
          world('Conflicts'),
          nationCategory('Historical Events'),
          nationCategory('History'),
        ],
      },
      {
        name: 'Place',
        template: 'place',
        primary: 'Place',
        specialist: ['Continent', 'Region', 'Settlement', 'Divine Realm'],
        homes: [
          continent('Regions'),
          continent('Settlements & Locations'),
          nationCategory('Settlements & Locations'),
          { kind: 'under', parent: 'Divine Realms', label: 'a Divine Realm index' },
        ],
      },
      {
        name: 'Technology',
        template: 'magictech',
        primary: 'Technology',
        specialist: [],
        homes: MAGIC_AND_TECHNOLOGY,
      },
      { name: 'Magic', template: 'magictech', primary: 'Magic', specialist: [], homes: MAGIC_AND_TECHNOLOGY },
      {
        name: 'Material',
        template: 'magictech',
        primary: 'Material',
        specialist: [],
        homes: MAGIC_AND_TECHNOLOGY,
        note: 'The owner confirmed (16 November 2026): Material uses AI Magic and Technology.',
      },
      {
        name: 'Equipment',
        template: 'magictech',
        primary: 'Equipment',
        specialist: ['Sacred Blade'],
        homes: MAGIC_AND_TECHNOLOGY,
        note: 'The owner confirmed (16 November 2026): Equipment uses AI Magic and Technology.',
      },
      {
        name: 'Species',
        template: 'creature',
        primary: 'Species',
        specialist: [],
        homes: [BESTIARY],
        kinds: {
          race: {
            homes: [
              { kind: 'races', as: 'group' },
              { kind: 'races', as: 'root' },
            ],
            name: '{Name} - Core Information',
            referenceType: 'Race Core Reference',
            specialist: null,
            navigation: 'race',
          },
          racialGroup: {
            homes: [{ kind: 'races', as: 'root' }],
            name: '{Name} - Racial Group Reference',
            referenceType: 'Racial Group Reference',
            specialist: 'Racial Group',
            navigation: 'group',
          },
          subrace: {
            homes: [{ kind: 'races', as: 'race' }],
            name: '{Name} - Subrace Reference',
            referenceType: null,
            specialist: null,
            navigation: null,
          },
        },
        note: 'The owner ruled (16 November 2026): a race, racial group or subrace lives on the race roster (Races of Arkona); any other species, and every creature, in the Bestiary.',
      },
      {
        name: 'Creature',
        template: 'creature',
        primary: 'Creature',
        specialist: [],
        homes: [BESTIARY],
      },
      primaryOwner('Religion', 'Religions', true),
      primaryOwner('Law', 'Laws'),
      primaryOwner('Programme', 'Programmes'),
      primaryOwner('Education', 'Education'),
      primaryOwner('Ceremony', 'Ceremonies'),
      primaryOwner('Condition', 'Conditions'),
      {
        name: 'Relationship',
        template: 'general',
        primary: 'Relationship',
        specialist: [],
        homes: [continent('Institutions')],
        note: 'An inter-polity relationship: AI General Source, the approved exception for crown relationships.',
      },
    ],
  },
  // v3 F3d (ADR 0053; the owner's decision of 17 November 2026): on Arkona the lifecycle tag LEADS, as the Controlled
  // Native Tagging Standard v1.8 orders it ("a leading, exact-case native tag Working … Archived"): archive_page writes
  // `Archived, Magic`, not `Magic, Archived`. Every other attached project (the test world) keeps `append` (ADR 0035).
  lifecycleTagPosition: { arkona: 'lead' },
  // v3 F3e (ADR 0059; the owner-approved design docs/design/F3e-splits.md, D4): the measurable Split Triggers of Character
  // Architecture and the split tool's audits. The thresholds are D4's; the words are the triggers' own examples
  // (biography, appearance, personality, relationships, powers, wardrobe, career…) and the Anti-Fragmentation Rule's.
  splits: {
    scopeOverload: { minDomains: 3 },
    retrievalCost: { minWords: 2000, minDomains: 2 },
    assetOwnership: { minImages: 3, sectionWords: ['wardrobe', 'outfit', 'outfits', 'form', 'forms'] },
    sharedOwnership: { minWords: 120 },
    unresolved: { minItems: 2 },
    domains: {
      Biography: ['biography', 'history', 'early life', 'life story', 'background', 'life', 'past'],
      Appearance: [
        'appearance',
        'physical',
        'physique',
        'body',
        'face',
        'features',
        'forms',
        'form',
        'visual',
      ],
      Personality: [
        'personality',
        'temperament',
        'conduct',
        'ethos',
        'lifestyle',
        'habits',
        'mannerisms',
        'beliefs',
      ],
      Relationships: [
        'relationships',
        'relationship',
        'family',
        'bonds',
        'romance',
        'romantic',
        'consorts',
        'allies',
      ],
      Powers: ['powers', 'abilities', 'magic', 'mechanics', 'combat', 'sorcery', 'skills', 'talents'],
      Wardrobe: ['wardrobe', 'outfits', 'outfit', 'clothing', 'attire', 'presentation', 'costume', 'regalia'],
      Career: ['career', 'occupation', 'profession', 'service', 'offices', 'work'],
    },
    ownerDomains: {
      History: ['history', 'historical', 'origins', 'founding', 'chronology'],
      Geography: ['geography', 'territory', 'territories', 'regions', 'lands', 'settlements', 'borders'],
      Government: ['government', 'politics', 'governance', 'rulers', 'administration', 'court'],
      Military: ['military', 'army', 'armies', 'armed forces', 'navy', 'fleet', 'defence', 'warfare'],
      Economy: ['economy', 'trade', 'commerce', 'industry', 'currency', 'wealth'],
      Culture: ['culture', 'society', 'customs', 'traditions', 'language', 'arts'],
      Religion: ['religion', 'faith', 'faiths', 'worship', 'gods', 'deities', 'temples', 'clergy'],
      Law: ['law', 'laws', 'legal', 'courts', 'justice'],
      Magic: ['magic', 'sorcery', 'arcane', 'spells', 'rituals'],
      Technology: ['technology', 'technologies', 'inventions', 'engineering'],
      Education: ['education', 'schools', 'academies', 'learning'],
    },
    stays: [
      'Purpose',
      'Identity',
      'Overview',
      'Summary',
      'Source Boundaries',
      'Unresolved Material',
      'How to Use This Index',
    ],
    together: [
      {
        example: 'personality and habits',
        words: ['personality', 'habits', 'temperament', 'mannerisms', 'lifestyle'],
      },
      {
        example: 'body, face and forms',
        words: ['body', 'face', 'forms', 'form', 'physique', 'appearance', 'physical'],
      },
      {
        example: 'a shared romantic hierarchy',
        words: ['romance', 'romantic', 'consorts', 'consort', 'spouses', 'lovers', 'hierarchy', 'harem'],
      },
    ],
    destinations: {
      Biography: { role: 'specialist', title: 'Biography', referenceType: 'Character Biography' },
      Appearance: {
        role: 'specialist',
        title: 'Physical & Visual Reference',
        referenceType: 'Character Physical & Visual Reference',
      },
      Personality: {
        role: 'specialist',
        title: 'Personality & Lifestyle',
        referenceType: 'Character Personality & Lifestyle Reference',
      },
      Relationships: { role: 'relationship' },
      Powers: {
        role: 'specialist',
        title: 'Powers & Mechanics',
        referenceType: 'Character Powers & Mechanics Reference',
      },
      Wardrobe: {
        role: 'specialist',
        title: 'Wardrobe & Personal Presentation',
        referenceType: 'Character Wardrobe & Personal Presentation Reference',
      },
      Career: { role: 'specialist', title: 'Career', referenceType: 'Character Biography' },
    },
    visual: {
      roles: ['art'],
      referenceTypes: ['Character Art', 'Character Physical & Visual Reference'],
      tags: ['Character Art', 'Visual Reference'],
    },
    universalTypes: [
      'Species',
      'Creature',
      'Culture',
      'Magic',
      'Technology',
      'Material',
      'Equipment',
      'Religion',
      'Law',
      'Condition',
      'Ceremony',
      'Education',
      'Programme',
      'Institution',
      'Military',
      'Polity',
      'Place',
      'Event',
    ],
    questions: [
      {
        trigger: 'Independent Retrieval',
        question:
          'Would anyone open one of these sections on its own, without needing the rest of the page (a reader looking only for the wardrobe, only the powers)?',
      },
      {
        trigger: 'Independent Maintenance',
        question:
          'Is one of these sections revised on its own schedule, or by a different hand, so that keeping it here makes every edit touch the whole page?',
      },
      {
        trigger: 'Downstream Dependency',
        question:
          'Do other pages depend on one section alone (they cite this page only for its powers, its relationship, its biography)?',
      },
    ],
    guardWords: 120,
    // CR-2026-11-R4 (the owner's request; ADR 0066 A): a split's new owners address Source Boundaries and Unresolved
    // Material only where the pack expects them, as the roles' own `warnMissing` already say: a Core, a Compact
    // Reference and a relationship owner both; an Art page and a specialist page neither (they answered "not
    // applicable" every time); any other owner both (`owners.text.warnMissing`). A Reference Type named here wins.
    sections: {
      referenceTypes: {},
      roles: {
        core: ['sourceBoundaries', 'unresolvedMaterial'],
        compact: ['sourceBoundaries', 'unresolvedMaterial'],
        relationship: ['sourceBoundaries', 'unresolvedMaterial'],
        art: [],
        specialist: [],
      },
      ownerTypes: {},
      otherwise: ['sourceBoundaries', 'unresolvedMaterial'],
    },
  },
  // v3 F3f (ADR 0060): the retag audit and apply, a derived translation of the Controlled Native Tagging Standard's
  // classification procedure. Batches of at most 25 pages; the identity tokens on the Core and the Compact Reference;
  // the Excluded Routine Tags the owner lists from the pinned section (none until then: every tag outside the grammar is
  // an owner exception); the areas never retagged by inference.
  retag: {
    batchSize: 25,
    identityReferenceTypes: ['Character Core', 'Compact Character Reference'],
    excludedRoutineTags: [],
    excludedAreas: ['Legacy Canon Archive', 'Design References', 'Repository Governance'],
    // v3 F5a (ADR 0067, H1): the Tagging Standard's "Approved Supplementary Tags" (the author's ruling of 23 November
    // 2026, read by its governing name): permitted wherever they appear, kept after the grammar's slots, never added,
    // never proposed for removal. The list as the section stated it on 23 November 2026; the bridge parses the section
    // at each governance check and offers a new version when it lists others.
    supplementary: {
      source: 'tagging-standard',
      section: 'Approved Supplementary Tags',
      tags: ['Cosmology', 'Chronology', 'Setting Framework'],
    },
  },
  // v3 F4a (ADR 0063): the governance drift audit (the audits' `governance` category), from the owner's repository check
  // of 19 November 2026. The old bridge's call shapes; the equivalence map (each finding suggests its `use` as the
  // replacement, to copy into a write_page edit by hand); the sections where a missing reference is looked for.
  governanceAudit: {
    legacyNames: ['write_lk', 'read_lk', 'job_action'],
    equivalents: [
      { name: 'write_lk', when: { job_action: 'guide' }, use: 'get_bridge_guide' },
      { name: 'format-baisheng-owners', use: 'arkona_appraise_owner' },
      { name: 'audit-baisheng-change-impact', use: 'arkona_change_impact' },
      {
        name: 'audit-baisheng-chronology',
        use: 'the chronology audit',
        note: 'the audits’ chronology findings: audit_findings with category "chronology"',
      },
      { name: 'intake-baisheng-visuals', use: 'arkona_visual_hygiene' },
      {
        name: 'resume-baisheng-workstreams',
        use: 'arkona_working_digest',
        partial: true,
        note: 'it lists Working pages, pending proposals and approved packages not yet promoted; it does not resume a workstream (bridge_job_resume continues one stopped job)',
      },
      // v3 F4c (ADR 0065): the story-planning skill's work is the narrative tools now.
      {
        name: 'plan-baisheng-stories',
        use: 'the narrative tools: arkona_story_create, arkona_chapter_plan, arkona_chapter_context, arkona_chapter_save, arkona_chapter_check and arkona_promote_from_chapter',
        note: 'the Workflow’s working sequence: arkona_chapter_context, the Question Gate, the draft, arkona_chapter_save, arkona_chapter_check, arkona_promote_from_chapter (get_bridge_guide part “Arkona fiction”)',
      },
    ],
    referenceSections: ['Startup', 'Related Guidance', 'Source Boundaries', 'Dependencies'],
    // The owner's review (20 November 2026): resolution is generous before anything is reported, but a name found only
    // as a run inside a longer name is a near miss, never silent (the owner's decision). "Fiction Writing" is
    // the Design References page "Arkona – Fiction Writing Reference" (tagged "Fiction Writing"), never a missing page.
    resolution: {
      // "Arkona" and a dash (any dash, any spacing): "Arkona – Fiction Writing Reference".
      leading: ['Arkona -'],
      generic: ['Reference', 'Standard', 'Workflow', 'Index'],
    },
  },
  // v3 F4a (ADR 0063): the name check. A Naming Culture resolves through the culture map to its owner under Arkonan
  // Cultures; names are matched in both orders, and the presentation standard is pointed to, never applied by guesswork.
  naming: {
    culturesIndex: 'Arkonan Cultures',
    sections: [],
    presentationStandard: 'East Asian Personal Name Presentation Standard',
  },
  // v3 F4b (ADR 0064; the owner-approved design docs/design/F4b-consistency-and-as-of.md): the consistency check and "as
  // of a date". Deliberately narrow (D2: precision over recall): only these phrasings are read, the subject only by a
  // name, alias or Canonical Display Name (never a pronoun), each date through the calendar engine with its precision.
  // New phrasings are added here (a new pack version), never in code. `-f4b1` (ADR 0064 amendment 1, from the first
  // live run): a date is the first date-shaped text of its clause (`scan`), a dateless "Deceased" and "Deceased by" are
  // no death date, a dated Life State's gap, rule A's titles and clause words, and the non-current markers (switched on:
  // the owner's ruling, 20 November 2026).
  consistency: {
    present: '5A 931',
    approxMargin: 5,
    temporalScope: 'Temporal Scope',
    lifeState: 'Life State',
    identityFields: [
      'Race / Species',
      'Naming Culture',
      'Life State',
      'Personal / Given Name',
      'Family / Surname',
    ],
    unestablished: ['Unestablished', 'Unknown', 'Unrecorded'],
    patterns: [
      // Temporal Scope, one `;` clause at a time: "Born Camue 44th, 4A 360; alive and immortal in Fifth-Age present 5A 931",
      // "Born 2A 73,511; attested through 5A 931", "Attested 5A 411–5A 931; birth date unestablished".
      // CR-2026-11-R4 (RC-12; for the next pack version): "born again 4A 300" is no second birth (a return, below).
      {
        id: 'birth.scope',
        source: 'temporalScope',
        kind: 'birth',
        regex: String.raw`^\s*born\s+(?!again\b)(?<date>.+)$`,
        date: 'scan',
      },
      // CR-2026-11-R4 (RC-10): "died by 4A 600", "died no later than 4A 300" are upper bounds, never a death date.
      {
        id: 'death.scope',
        source: 'temporalScope',
        kind: 'death',
        regex: String.raw`^\s*died\b(?![\s,(–—-]*(?:by|before|no\s+later\s+than|not\s+later\s+than|at\s+the\s+latest)\b)\s+(?<date>.+)$`,
        date: 'scan',
      },
      // CR-2026-11-R4 (the owner's request L, characters with more than one life; for the next pack version): one birth
      // and one death per life, and a restoration. Mehrana al-Khalid's Temporal Scope: "First life Camue 1st, 4A 100–Camue
      // 33rd, 4A 325; second life born Camue 1st, 4A 530; recollection 4A 624–Sarias 9th, 4A 645; second-life actual death
      // at midday Zahras 36th, 4A 950; restored to life as a five-Domain innate goddess Camue 1st, 5A 1; alive through 5A
      // 931." The named group `life` is the life's ordinal (`lifeOrdinals`).
      {
        id: 'life.scope.birth',
        source: 'temporalScope',
        kind: 'birth',
        regex: String.raw`^\s*(?<life>first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))[\s-]+life\s+(?:born|begins|began)\b(?:\s+(?:on|in))?\s*(?<date>.*)$`,
        date: 'scan',
      },
      {
        id: 'life.scope.death',
        source: 'temporalScope',
        kind: 'death',
        regex: String.raw`^\s*(?<life>first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))[\s-]+life(?:['’]s)?\s+(?:(?:actual|final)\s+)?(?:death|died|ended|ends)\b(?<date>.*)$`,
        date: 'scan',
      },
      {
        id: 'life.scope.span',
        source: 'temporalScope',
        kind: 'birth',
        regex: String.raw`^\s*(?<life>first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))[\s-]+life\s+(?!(?:born|begins|began|actual|final|death|died|ended|ends)\b)(?:from\s+)?(?<date>.+)$`,
        life: 'span',
      },
      {
        id: 'life.scope.restored',
        source: 'temporalScope',
        kind: 'attested',
        regex: String.raw`^\s*restored\s+to\s+life\b(?<date>.*)$`,
        date: 'scan',
        bound: 'from',
        life: 'restoration',
      },
      // An attested span inside a life (Mehrana al-Khalid's "recollection 4A 624–Sarias 9th, 4A 645"), never a life.
      {
        id: 'attested.scope.recollection',
        source: 'temporalScope',
        kind: 'attested',
        regex: String.raw`^\s*recollection\s+(?<date>.+)$`,
        bound: 'both',
      },
      {
        id: 'birth.scope.gap',
        source: 'temporalScope',
        kind: 'birth',
        regex: String.raw`\bbirth(?:\s+date)?\s+(?:is\s+)?(?:unestablished|unknown|unrecorded)\b`,
        gap: true,
      },
      {
        id: 'death.scope.gap',
        source: 'temporalScope',
        kind: 'death',
        regex: String.raw`\bdeath(?:\s+date)?\s+(?:is\s+)?(?:unestablished|unknown|unrecorded)\b`,
        gap: true,
      },
      {
        id: 'attested.scope.span',
        source: 'temporalScope',
        kind: 'attested',
        regex: String.raw`^\s*attested\s+(?!through\b|until\b|to\b)(?<date>.+)$`,
        bound: 'both',
      },
      {
        id: 'attested.scope.through',
        source: 'temporalScope',
        kind: 'attested',
        regex: String.raw`\battested\s+(?:through|until|to)\s+(?<date>.+)$`,
        bound: 'to',
      },
      {
        id: 'attested.scope.alive',
        source: 'temporalScope',
        kind: 'attested',
        // CR-2026-11-R4 (RC-11): at the clause's start only ("no longer alive in 5A 931" attests nothing).
        regex: String.raw`^\s*(?:still\s+)?(?:alive|active)\b(?<date>.*)$`,
        date: 'scan',
        bound: 'both',
      },
      // v3 F4c (ADR 0065; the owner's F4b decision 6): a Temporal Scope clause that is a bare range of dates, "5A 900 -
      // 5A 931" (Tsubame Hoshizora's), reads as attested bounds. Attested bounds are still never compared (ADR 0064).
      {
        id: 'attested.scope.range',
        source: 'temporalScope',
        kind: 'attested',
        regex: String.raw`^\s*(?<date>(?:c\.\s*)?(?:[a-z]+\s+\d{1,3}(?:st|nd|rd|th),\s*)?\d{1,2}A\s+[\d,]+\s*[-–]\s*(?:[a-z]+\s+\d{1,3}(?:st|nd|rd|th),\s*)?(?:\d{1,2}A\s+)?[\d,]+)\s*$`,
        bound: 'both',
      },
      // ADR 0064 amendment 2 (`-f41`, the owner's check of 20 November 2026): "living at <date>" (Rashad al-Khalid's
      // "living at 5A 931") and "present <date>" (Iuno's "present 5A 931") attest the life THROUGH the date.
      {
        id: 'attested.scope.living',
        source: 'temporalScope',
        kind: 'attested',
        regex: String.raw`^\s*(?:still\s+)?living\s+(?:at|in)\s+(?<date>.+)$`,
        date: 'scan',
        bound: 'to',
      },
      {
        id: 'attested.scope.present',
        source: 'temporalScope',
        kind: 'attested',
        // CR-2026-11-R4 (RC-11): a date directly after "present" ("present status: deceased since 4A 600" is none).
        regex: String.raw`^\s*present\s+(?:(?:at|in)\s+)?(?<date>(?=(?:c\.\s*|approximately\s+)?(?:\p{L}+\s+)?\d).+)$`,
        date: 'scan',
        bound: 'to',
      },
      // v3 F4c (ADR 0065; the owner's guard on the Life State ruling): a return after a recorded death ("Reborn 4A 300",
      // "Returned …", "Reincarnated …": Mehrana al-Khalid's incarnations, Nahla's Sidhe rebirth, Yue Bailu's Kitsune
      // rebirth) is an attested start of life, never a second birth, so never compared; arkona_as_of reads the death as
      // ending at it.
      {
        id: 'attested.scope.return',
        source: 'temporalScope',
        kind: 'attested',
        // CR-2026-11-R4 (RC-12): "born again 4A 300" is a return too.
        regex: String.raw`^\s*(?:reborn|born\s+again|returned|reincarnated|resurrected)\b(?:\s+(?:on|in|at))?\s+(?<date>.+)$`,
        date: 'scan',
        bound: 'from',
        life: 'return',
      },
      // A Life State of "Deceased" with a date. "Deceased" alone is a state (the Life State identity fact), not a date;
      // "Deceased by <date>" is an upper bound on death, never a death date (ADR 0064 amendment 1, D).
      {
        id: 'death.lifestate',
        source: 'lifeState',
        kind: 'death',
        // CR-2026-11-R4 (RC-10): "Deceased (by …)", "Deceased, by …", "no later than", "at the latest by": no death date.
        regex: String.raw`^\s*deceased\b(?![\s,(–—-]*(?:by|before|no\s+later\s+than|not\s+later\s+than|at\s+the\s+latest)\b)(?<date>.*)$`,
        date: 'scan',
      },
      {
        id: 'death.lifestate.gap',
        source: 'lifeState',
        kind: 'death',
        regex: String.raw`\bdeath(?:\s+date)?\s+(?:is\s+)?(?:unestablished|unknown|unrecorded)\b`,
        gap: true,
      },
      // Prose, one sentence at a time: "Yasmin was born on Camue 1st, 4A 100", and a dated line on a nation page:
      // "Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von Katzen is born in…".
      {
        id: 'birth.prose',
        source: 'prose',
        kind: 'birth',
        regex: String.raw`{name}\s*,?\s+(?:was|is)\s+born\s+(?:on|in)\s+(?<date>.+)$`,
        date: 'scan',
      },
      {
        id: 'birth.prose.dated',
        source: 'prose',
        kind: 'birth',
        regex: String.raw`^\s*(?<date>.+?)\s+[-–—]\s+{name}\s*,?\s+(?:was|is)\s+born\b`,
      },
      {
        id: 'death.prose',
        source: 'prose',
        kind: 'death',
        regex: String.raw`{name}\s*,?\s+(?:died|dies|was\s+killed|is\s+killed)\s+(?:on|in)\s+(?<date>.+)$`,
        date: 'scan',
      },
      {
        id: 'death.prose.dated',
        source: 'prose',
        kind: 'death',
        regex: String.raw`^\s*(?<date>.+?)\s+[-–—]\s+{name}\s*,?\s+(?:died|dies|was\s+killed|is\s+killed)\b`,
      },
      // A chronology row: the kind of event and its subject from the Historical Event cell ("…al-Naim, is born in 4A
      // 401"); the date is the row's own Date cell.
      {
        id: 'birth.chronology',
        source: 'chronology',
        kind: 'birth',
        regex: String.raw`{name}\s*,?\s+(?:was|is)\s+born\b`,
      },
      {
        id: 'death.chronology',
        source: 'chronology',
        kind: 'death',
        regex: String.raw`{name}\s*,?\s+(?:died|dies|was\s+killed|is\s+killed)\b`,
      },
    ],
    // Rule A: what may stand before a name governing its verb ("Kaiser Soren von Woerfels dies"), and what starts a
    // clause besides commas, semicolons and a spaced dash.
    titles: [
      'Kaiser',
      'Kaiserin',
      'King',
      'Queen',
      'Emperor',
      'Empress',
      'Prince',
      'Princess',
      'Archduke',
      'Archduchess',
      'Duke',
      'Duchess',
      'Count',
      'Countess',
      'Lord',
      'Lady',
      'Sir',
      'Dame',
    ],
    clauseWords: ['after', 'when', 'before', 'until', 'while'],
    // CR-2026-11-R4 (RC-1; for the next pack version): a name right after a relational particle is a relation of the
    // subject, never the subject ("The daughter of Rashad al-Khalid was born", "Layla bint Rashad al-Khalid was born").
    relational: [
      'of',
      'bint',
      'ibn',
      'bin',
      'ben',
      'bat',
      'née',
      'by',
      'with',
      'for',
      'to',
      'from',
      'and',
      'or',
      'nor',
    ],
    // F: non-current sections and rows inside current pages. Switched on by the owner's ruling (20 November 2026):
    // "Pre-Rewrite" and "Author-Facing" sections and rows are non-current.
    nonCurrent: { markers: ['Pre-Rewrite', 'Author-Facing'], exclude: true },
    // v3 F4c (ADR 0065, design E6): an age in prose, read only by arkona_chapter_check against "as of" the chapter's
    // date: "<Name> is / was <n> (years old)" and "<Name>, aged <n>"; by a name only, never a pronoun.
    ages: [
      { id: 'age.is', regex: String.raw`{name}\s+(?:is|was)\s+(?<age>\d{1,6})(?:\s+years?\s+old)?\b` },
      { id: 'age.aged', regex: String.raw`{name}\s*,\s*aged\s+(?<age>\d{1,6})\b` },
    ],
    // v3 F4c (ADR 0065; the owner's ruling from F4b.1's review): "Deceased by 5A 931" (Jahan-Timur's Life State) is an
    // upper bound on death, read only by arkona_as_of; never a fact, never compared.
    // CR-2026-11-R4 (RC-10; for the next pack version): "Deceased (by 5A 931)", "Deceased, by …", "Deceased – by …",
    // "Deceased no later than …", "Deceased at the latest by …" are the same upper bound.
    deceasedBy: [
      {
        id: 'deceased.by',
        regex: String.raw`^\s*(?:deceased|died)[\s,(–—-]*(?:by|before|no\s+later\s+than|not\s+later\s+than|at\s+the\s+latest(?:\s+by)?)\s+(?<date>.+)$`,
      },
    ],
    // v3 F4c (ADR 0065; the owner's ruling amending D7): a Life State of "Alive" records the character alive at the present
    // (5A 931), so with a recorded birth "as of" reads them alive from it to the present; read by arkona_as_of only.
    aliveValues: ['Alive', 'Living'],
    // ADR 0064 amendment 2 (`-f41`): a Life State whose principal part STARTS with an alive value ("Alive in 5A 931",
    // Katsuragi Yamato's; "Living and immortal at 5A 931", Rashad al-Khalid's) records the character alive; a date
    // there ("in / at <date>") attests the life up to that date rather than the present.
    // CR-2026-11-R4 (RC-13; for the next pack version): "as of", "until", "through" and "last attested" too, read over the
    // whole value ("Alive (last attested 4A 500)").
    aliveAt: [
      { id: 'alive.at', regex: String.raw`\b(?:in|at|as\s+of|until|till|through|thru)\s+(?<date>.+)$` },
      {
        id: 'alive.last',
        regex: String.raw`\blast\s+(?:attested|seen|recorded)(?:\s+(?:in|at|on))?\s+(?<date>.+)$`,
      },
    ],
    // CR-2026-11-R4 (RC-13): a Life State in doubt is no record of the living ("Alive (presumed)", "Alive -
    // unconfirmed", "Alive?"), and only these words may follow the alive value ("Living memory" is none).
    aliveDoubt: [
      'presumed',
      'presumably',
      'unconfirmed',
      'uncertain',
      'unverified',
      'possibly',
      'probably',
      'rumoured',
      'reportedly',
      'believed',
      '?',
    ],
    aliveFollowers: ['and', 'in', 'at', 'as of', 'until', 'till', 'through', 'thru'],
    // CR-2026-11-R4 (the owner's request L): the ordinals of lives ("first life …", "second life born …").
    lifeOrdinals: [
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
      'seventh',
      'eighth',
      'ninth',
      'tenth',
    ],
  },
  // v3 F4c (ADR 0065; the owner-approved design docs/design/F4c-fiction.md, E1 to E9): the layout of Narratives. Every
  // name is found by name (never by id); the templates by name through the template list. The governance it derives
  // from is pinned below (the Workflow's "LegendKeeper Planning and Manuscript Structure", the Fiction Writing
  // Reference's 32B).
  narrative: {
    indexes: { narratives: 'Narratives', continuities: 'Continuities', main: 'Main CANON' },
    reservedWord: 'CANON',
    mainContinuityValues: ['Main CANON', 'Main'],
    continuityType: { main: 'CANON', au: 'AU' },
    names: {
      storyMap: 'Story Map',
      actMap: 'Act {n} Map',
      chapterPlan: 'Chapter {n} Plan',
      act: 'Act {n} - {Title}',
      chapter: 'Chapter {n} - {Title}',
      chronologyMap: ['Life or Chronology Map', 'Chronology Map', 'Life Map'],
    },
    templates: {
      storyMap: '[BSRC] AI Narrative Story Map',
      actMap: '[BSRC] AI Narrative Act Map',
      chapterPlan: '[BSRC] AI Narrative Chapter Plan',
      chapter: '[BSRC] AI Narrative Chapter',
    },
    tags: {
      narrative: 'Narrative',
      au: 'AU',
      flashback: 'Flashback',
      story: 'Story',
      storyMap: 'Story Map',
      act: 'Act',
      actMap: 'Act Map',
      chapterPlan: 'Chapter Plan',
      chapter: 'Chapter',
      chronologyMap: 'Chronology Map',
    },
    fields: {
      story: 'Story',
      act: 'Act',
      chapterNumber: 'Chapter Number',
      actNumber: 'Act Number',
      inWorldDate: 'In-world Date',
      continuity: 'Continuity',
      continuityType: 'Continuity Type',
      pov: 'POV',
      chapterPlan: 'Chapter Plan',
      chapter: 'Chapter',
      draftStatus: 'Draft Status',
      lastMajorRevision: 'Last Major Revision',
      charactersPresent: 'Characters Present',
      locations: 'Locations',
      plannedDate: 'Planned Date',
      questionGate: 'Question Gate',
      planningStatus: 'Planning Status',
      storySpan: 'Story Span',
      actSpan: 'Act Span',
      principalCharacters: 'Principal Characters',
    },
    gate: { open: 'Open', closed: 'Closed' },
    planning: { planned: 'Planned', drafted: 'Drafted', reassessed: 'Reassessed', planning: 'Planning' },
    planSections: { canonConstraints: 'Canon Constraints', closingState: 'Closing State' },
    dateline: { separator: '·' },
    // The Chapter template's field placeholders ("Link to the POV character") and their like.
    placeholders: [
      String.raw`^link(?:s)? to\b.*`,
      String.raw`^(?:enter|add|insert|describe|choose|select|pick|list|name)\s+(?:the|a|an|each|any)\b.*`,
      String.raw`^e\.g\.?\b.*`,
      String.raw`^\[[^\]]*\]$`,
      String.raw`^.*\bexact (?:date )?or (?:an )?approximate\b.*$`,
      String.raw`^(?:tbd|todo|xxx|placeholder)$`,
    ],
    candidateCap: 40,
    notNames: [
      'I',
      "I'm",
      "I'll",
      "I've",
      "I'd",
      'Mr',
      'Mrs',
      'Ms',
      'Sir',
      'Lady',
      'Lord',
      'Master',
      'Mistress',
      'Captain',
      'Mother',
      'Father',
      'Sister',
      'Brother',
      'Grandmother',
      'Grandfather',
      'Aunt',
      'Uncle',
      'God',
      'Gods',
      'Heaven',
      'Hell',
      'Highness',
      'Majesty',
      'Excellency',
      'Grace',
      'OK',
      'Okay',
    ],
  },
  // v3 F5b (ADR 0068, H5): the automation framework's caps (pack data, as the design asks), and where the approvals
  // are recorded: Repository Automation's "Approved Narrow Automations", after the block-id sweep's paragraph.
  // `-f5b1` (ADR 0068 amendment 1, F5b.1): the caps are settings (AUTOMATION_CAP_PER_CODE / _PER_RUN), no longer rules.
  automation: {
    source: 'repository-automation',
    section: 'Approved Narrow Automations',
    sweepMarker: 'Assign Block IDs Sweep',
  },
  // v3 F7b (ADR 0071, D2): where arkona_get_art reads an image's written authority first (the character's Art and
  // Wardrobe pages), and how much of the text under an image it returns.
  artView: {
    ownerPages: {
      referenceTypes: [
        'Character Art',
        'Character Physical & Visual Reference',
        'Character Wardrobe & Personal Presentation Reference',
      ],
      tags: ['Character Art', 'Visual Reference', 'Wardrobe'],
    },
    textChars: 1200,
  },
  // v3 F6a (ADR 0076; design T1, T13): the Reference Type vocabulary, a DRAFT: what the report suggests against until the
  // owner publishes the real one to Source Formatting's "Reference Type Vocabulary" (then that section is the authority
  // and this list is ignored). Each canonical type carries its role word for F6d's templated names; the character types
  // are the pack's own as they stand. The rules' words (synonyms, time words, scope adjectives) are pack data too.
  referenceTypes: {
    source: 'source-formatting',
    section: 'Reference Type Vocabulary',
    under: 'Sidebar Metadata',
    status: 'draft',
    rule: 'A Reference Type names the page’s role, from a closed list per primary category. Time goes in Temporal Scope, geography in placement, and detail in Scope. A specialist source that needs a unique type keeps it only as an approved specialist type listed below. Never invent a Reference Type.',
    // The design's T1 table (the owner, 24 November 2026), in its order; the types the first draft had besides T1's
    // follow them (Character; Military, Education and Ceremony; Magic Reference; Law Reference). Programme Reference is
    // the Programme category's (the owner's ruling of 24 November 2026, correcting T1, which listed it under Technology).
    categories: [
      {
        category: 'Character',
        types: [
          { name: 'Character Core', role: 'Character Core' },
          { name: 'Compact Character Reference', role: 'Character Reference' },
          { name: 'Character Art', role: 'Character Art' },
          { name: 'Joint Character Relationship Reference', role: 'Relationship' },
          { name: 'Character Biography', role: 'Biography' },
          { name: 'Character Personality & Lifestyle Reference', role: 'Personality & Lifestyle' },
          { name: 'Character Physical & Visual Reference', role: 'Physical & Visual Reference' },
          {
            name: 'Character Wardrobe & Personal Presentation Reference',
            role: 'Wardrobe & Personal Presentation',
          },
          { name: 'Character Powers & Mechanics Reference', role: 'Powers & Mechanics' },
        ],
      },
      {
        category: 'Polity',
        types: [
          { name: 'Polity Reference', role: 'Polity' },
          { name: 'Polity Constitution Reference', role: 'Constitution' },
          { name: 'Polity History Reference', role: 'History' },
          { name: 'Polity Directory', role: 'Directory' },
        ],
      },
      {
        category: 'Institution',
        types: [
          { name: 'Institution Reference', role: 'Institution' },
          { name: 'Religious Institution Reference', role: 'Religious Institution' },
          { name: 'Military Institution Reference', role: 'Military Institution' },
        ],
      },
      {
        category: 'Military',
        types: [{ name: 'Military Reference', role: 'Military' }],
      },
      {
        category: 'Culture',
        types: [
          { name: 'Culture Reference', role: 'Culture' },
          { name: 'Culture Foundations Reference', role: 'Culture Foundations' },
          { name: 'Language & Naming Reference', role: 'Language & Naming' },
          { name: 'Lexicon Reference', role: 'Lexicon' },
        ],
      },
      {
        category: 'Religion',
        types: [
          { name: 'Religion Reference', role: 'Religion' },
          { name: 'Religious Practice Reference', role: 'Religious Practice' },
        ],
      },
      {
        category: 'Event',
        types: [
          { name: 'Event Reference', role: 'Event' },
          { name: 'Conflict Reference', role: 'Conflict' },
          { name: 'Period Reference', role: 'Period' },
          { name: 'Chronology Reference', role: 'Chronology' },
        ],
      },
      {
        category: 'Place',
        types: [
          { name: 'World Reference', role: 'World' },
          { name: 'Continent Reference', role: 'Continent' },
          { name: 'Realmship Reference', role: 'Realmship' },
          { name: 'Region Reference', role: 'Region' },
          { name: 'Settlement Reference', role: 'Settlement' },
          { name: 'Place Reference', role: 'Place' },
          { name: 'Divine Realm Reference', role: 'Divine Realm' },
        ],
      },
      {
        category: 'Magic',
        types: [
          { name: 'Magic Foundation Reference', role: 'Magic Foundation' },
          { name: 'Magical Tradition Reference', role: 'Magical Tradition' },
          { name: 'Magic Overview', role: 'Magic Overview' },
          { name: 'Magic Reference', role: 'Magic' },
        ],
      },
      {
        category: 'Technology',
        types: [{ name: 'Technology Reference', role: 'Technology' }],
      },
      // The owner's ruling (24 November 2026): Programme Reference belongs to the Programme primary category.
      { category: 'Programme', types: [{ name: 'Programme Reference', role: 'Programme' }] },
      {
        category: 'Equipment',
        types: [
          { name: 'Equipment Reference', role: 'Equipment' },
          { name: 'Equipment Tradition Reference', role: 'Equipment Tradition' },
        ],
      },
      {
        category: 'Material',
        types: [{ name: 'Material Reference', role: 'Material' }],
      },
      {
        category: 'Law',
        types: [
          { name: 'Foundation Reference', role: 'Foundation' },
          { name: 'Legal Reference', role: 'Legal' },
          { name: 'Agreement Reference', role: 'Agreement' },
          { name: 'Law Reference', role: 'Law' },
        ],
      },
      {
        category: 'Species',
        types: [
          { name: 'Racial Foundation', role: 'Racial Foundation' },
          { name: 'Racial Group Reference', role: 'Racial Group' },
          { name: 'Race Core Reference', role: 'Race' },
          { name: 'Subrace Reference', role: 'Subrace' },
          { name: 'Species Reference', role: 'Species' },
        ],
      },
      {
        category: 'Creature',
        types: [{ name: 'Creature Reference', role: 'Creature' }],
      },
      {
        category: 'Condition',
        types: [{ name: 'Condition Reference', role: 'Condition' }],
      },
      {
        category: 'Relationship',
        types: [
          { name: 'Relationship Reference', role: 'Relationship' },
          { name: 'Political Relationship Reference', role: 'Political Relationship' },
        ],
      },
      {
        category: 'Education',
        types: [{ name: 'Education Reference', role: 'Education' }],
      },
      {
        category: 'Ceremony',
        types: [{ name: 'Ceremony Reference', role: 'Ceremony' }],
      },
    ],
    specialist: [],
    normalise: {
      synonyms: {
        Cultural: 'Culture',
        Religious: 'Religion',
        Legal: 'Law',
        Magical: 'Magic',
        Technological: 'Technology',
        Educational: 'Education',
        Ceremonial: 'Ceremony',
        Institutional: 'Institution',
        Biographical: 'Biography',
        // A scope adjective read as its noun only when nothing else names the role (“Historical Regional Reference”).
        Regional: 'Region',
        Continental: 'Continent',
      },
      timeWords: ['Historical', 'Historic', 'Contemporary', 'Present-Day'],
      scopeWords: [
        'Regional',
        'Shared',
        'National',
        'Cross-National',
        'Cross-Jurisdictional',
        'Civilisation',
        'Civilisational',
        'Civilization',
        'Civilizational',
        'Continental',
        'Local',
        'International',
        'Transnational',
        'Multinational',
        'Supranational',
        'Pan-Continental',
        'Global',
        'General',
        'Overall',
      ],
    },
  },
  rulings: [
    {
      key: 'au-status-tag',
      date: '2026-11-16',
      by: 'owner',
      summary:
        'An AU page carries the status tag AU in place of CANON, and Continuity Type AU stays in its facts; everything after the status tag follows the same grammar. A Working or Archived AU page leads with Working or Archived, so neither CANON nor AU appears on it. For every pack tool. Not yet recorded in the Controlled Native Tagging Standard: when it is, the pack sees governance drift and is approved again.',
    },
    {
      key: 'nav-and-subject-indexes',
      date: '2026-11-25',
      by: 'owner',
      summary:
        'T11 (the F6 taxonomy design, approved with the owner’s amendments T11, T12 and T14): an index that only groups or routes is [NAV] <name> and carries exactly Navigation; an index about one subject (a character, a nation or polity, a continent, a Realmship or a named Divine Realm, a culture or religion family, a story) is [INDEX] <name> and carries its subject’s primary category; neither carries CANON. In every parent: [NAV] first, then [INDEX], then sources, each alphabetical (the narrative number order still applies inside a story). Atomic, predictable structure wins over current names. Not yet recorded in Source Formatting or the Controlled Native Tagging Standard: the owner’s reviewer writes the three sections after deploy.',
    },
    {
      key: 'nation-subindex-roles',
      date: '2026-11-26',
      by: 'owner',
      summary:
        'F6c (the F6 taxonomy design, T3 to T5 as amended, approved 23 November 2026): a nation’s subindexes follow one list of ten roles, in this order: Government & Administration, Institutions, Historical Events, Military & Technology, Unique Magic & Technologies, Cultures, Settlements & Locations, Religion & Religious Administration, Household & Court, Historical Polities. A subindex is named <Nation> <Role>, where <Nation> is the nation’s short name when it has one (Cantha), else the nation index’s display name (Jabal al-Noor Military & Technology); the prefix stays [NAV]. A child whose name matches no role or approved variant is never guessed: it goes to the owner, who maps it, keeps it as a specialist subindex, or rules it not a subindex. Not yet recorded in Source Formatting’s Nation-Centred Territorial Navigation: the owner’s reviewer writes it after deploy.',
    },
    {
      key: 'templated-names',
      date: '2026-11-26',
      by: 'owner',
      summary:
        'F6d (the F6 taxonomy design, T13 as amended by the owner on 26 November 2026): an ordinary source in the AI REPOSITORY is named <Subject> - <Role>: its Subject sidebar value as written, and the role word of its canonical Reference Type in the published Reference Type Vocabulary; the lifecycle prefix ([BSRC], [BWRK], [BARC]) stays. Exempt (the Specialist exemption): a page whose Reference Type is an approved specialist type of the published vocabulary, for any page of its category or for the pages it names, keeps its unique name. A registered character’s pages keep the names the character tools give them. A page with no Subject (or a Subject holding an em dash) is held, never named by guess; a name a sibling already holds, or two renames to one name, is held. The renames run as the automation code name_nontemplated at the mode the owner chooses (Off by default; Propose, then Apply). Not yet recorded in Source Formatting’s Page Names and Templates: the owner’s reviewer writes it after deploy.',
    },
  ],
  // v3 F6b (ADR 0079; design T11, T12): navigation and subject indexes. The tag rule is a draft until the Tagging
  // Standard's "Navigation and Subject Index Tags" section exists (its pin reads unpublished meanwhile, never refusing the
  // approval); the ordering rule applies once this version is approved. The structural lists are the classification
  // report's exact names (the owner edits them on the Index Classification page: a new version).
  indexTaxonomy: {
    source: 'tagging-standard',
    section: 'Navigation and Subject Index Tags',
    status: 'draft',
    ordering: 'nav-index-sources',
    navTag: 'Navigation',
    subjectTags: {
      character: 'Character',
      polity: 'Polity',
      culture: 'Culture',
      religion: 'Religion',
      place: 'Place',
      story: 'Story',
    },
    templates: { nav: '[NAV] AI Navigation', subject: '[INDEX] AI Index' },
    structural: {
      topLevel: [
        'Characters',
        'Arkona',
        'The Elysaria System',
        'Setting Framework',
        'Narratives',
        'Continuities',
        'Design References',
        'Working',
        'Archive',
      ],
      named: [
        'Arkona’s Continents',
        "Arkona's Continents",
        'Arkona’s Realmships',
        "Arkona's Realmships",
        'Lost Realmships',
        'Arkonan Cultures',
        'Arkonan Religions',
        'Religions',
        'Arkonan Historical Events',
        'Historical Events',
        'Arkonan Conflicts',
        'Conflicts',
        'Divine Realms',
        'Divine Realm Cultures',
      ],
      continentCategories: [
        'Polities',
        'Institutions',
        'Cultures',
        'Historical Events',
        'Conflicts',
        'Regions',
        'Settlements & Locations',
        'Unique Magic & Technologies',
        'Religions',
      ],
      continentParents: ['Arkona’s Continents', "Arkona's Continents"],
      realmshipParents: ['Arkona’s Realmships', "Arkona's Realmships", 'Lost Realmships'],
      settingFramework: 'Setting Framework',
      settingFrameworkCategories: [
        'Chronology & Calendar',
        'Cosmology & Metaphysics',
        'Divinity',
        'Void Lords',
        'Bestiary',
        'Conditions',
        'Equipment & Items',
      ],
      divineRealms: 'Divine Realms',
      divineRealmCategories: [
        'Cosmic Realms',
        'Lower Realms',
        'Upper Realms',
        'Ur-Realms',
        'Lunar Realms',
        'Planetary Realms',
      ],
      // v3 F6c (ADR 0080): derived from `nationRoles` and `nationRoleVariants` below (replacing F6b's stopgap list), so
      // F6b's classification and the Nation Subindexes report agree; the owner's mappings are added at run time.
      nationSubindexes: [...NATION_ROLES, ...NATION_ROLE_VARIANTS.map((v) => v.variant)],
      cultureCategories: ['Cultures'],
      religionCategories: ['Religions'],
    },
    outOfScope: ['Working', 'Archive', 'Archived', 'Legacy Canon Archive', 'Design References'],
    // v3 F6c (ADR 0080; the owner's rulings of 26 November 2026): the ten nation roles, in order, and the approved
    // variants of their names. A nation's subindex is `<Nation> <Role>` (the entry's short name, else the display name).
    nationRoles: [...NATION_ROLES],
    nationRoleVariants: NATION_ROLE_VARIANTS.map((v) => ({ ...v })),
    // The territory categories are `structural.continentCategories` (the one source); Conflicts sits in Historical Events.
    categoryParents: { Conflicts: 'Historical Events' },
    // The categories the governance requires of every territory (Source Formatting's "Approved Hierarchy and
    // Standardised Navigation"), in its order; read only by territory_category_missing. Religions is recognised (above)
    // but not required: no live territory has a "<Territory> Religions" index.
    requiredTerritoryCategories: [
      'Cultures',
      'Historical Events',
      'Conflicts',
      'Institutions',
      'Polities',
      'Regions',
      'Settlements & Locations',
      'Unique Magic & Technologies',
    ],
    lostRealmshipParents: ['Lost Realmships'],
  },
  // v3 F6d (ADR 0082; design T13 as amended on 26 November 2026): templated source names, <Subject> - <Role>, the role
  // word read from the published Reference Type Vocabulary (never hard-coded here); the vocabulary's specialist types are
  // exempt. No new section is parsed: Source Formatting's "Page Names and Templates" is pinned, so the reviewer's
  // paragraph shows as governance drift and the owner approves again.
  templatedNames: {
    template: '<Subject> - <Role>',
    subjectRow: 'Subject',
    exempt: 'vocabulary-specialist-types',
    ruling: 'templated-names',
  },
});

export const ARKONA_PACK: PackSeed = Object.freeze({
  id: 'arkona',
  name: 'Arkona',
  prefix: 'arkona_',
  // v3 F3b (ADR 0052): the owner tools' seed. A pack stored from F3a's or F3b's seed is offered these rules as a new
  // version. `-f3b1` (ADR 0052 amendment, 16 November 2026): the pinned headings exactly as the pages have them, and a
  // Working owner keeps its specialist tag. `-f3d` (ADR 0053, 17 November 2026; session F3.3): the lifecycle tag leads on
  // Arkona. `-f3-4` (ADR 0055, 17 November 2026; session F3.4): the per-tool "always propose" switches. `-f3e` (ADR 0059,
  // 18 November 2026; session F3e): the split appraisal's triggers and the split tool's audits (`splits`, D4). `-f3f`
  // (ADR 0060, 19 November 2026; session F3f): the retag rules (`retag`), the retag apply's switch, and the Tagging
  // Standard's "Excluded Routine Tags" pinned. `-f4a` (ADR 0063, 19 November 2026; session F4a): the governance drift
  // audit's equivalence map and sections (`governanceAudit`) and the name check's culture index (`naming`). `-f4b` (ADR
  // 0064, 20 November 2026; session F4b): the consistency check's phrasings, the present day and the "c." margin
  // (`consistency`). `-f4b1` (ADR 0064 amendment 1, 20 November 2026; from the first live run): dates scanned in their
  // clause, rule A's titles and clause words, a dateless "Deceased" and "Deceased by" never a death date, and the
  // non-current markers, switched on. `-f4c` (ADR 0065, 20 November 2026; session F4c, on top of F4b.1's rules): the
  // narrative layout (`narrative`), the narrative tools' switches, plan-baisheng-stories in the equivalence map, the two
  // fiction Design References pinned (found by their names), and in `consistency` the age phrasings (`ages`), the
  // bare-range attested phrasing and "Deceased by <date>" as an as-of-only upper bound (`deceasedBy`). `-f41` (ADR 0064
  // amendment 2 and ADR 0065 amendment 1, 20 November 2026; session F4.1, from the owner's check of the live tools): a
  // Life State STARTING with "Alive" or "Living" (`aliveValues`, with a date read by `aliveAt`), and the Temporal Scope
  // phrasings "living at <date>" and "present <date>". `-r4` (CR-2026-11-R4, 21 November 2026; the fourth review and the
  // owner's requests): which kinds of new owner of a split address Source Boundaries and Unresolved Material
  // (`splits.sections`), and the consistency phrasings this review's fixes and the owner's lives (L) add. `-f5a` (ADR
  // 0067, 23 November 2026; session F5a): the Tagging Standard's "Approved Supplementary Tags" pinned, and its list as
  // pack data (`retag.supplementary`).
  // `-f5b` (ADR 0068, 23 November 2026; session F5b): the automation framework's caps (`automation`) and Repository
  // Automation as a governance source, its "Default Boundary", "Approved Narrow Automations" and "Source Boundaries"
  // pinned.
  // `-f5c` (ADR 0069, 23 November 2026; session F5c): `arkona_identity_reconcile`'s switch (follows the agent's scope).
  // `-f7b` (ADR 0071, 23 November 2026; session F7b): `artView`, where `arkona_get_art` reads an image's authority.
  // `-f6a` (ADR 0076, 24 November 2026; session F6a): the Reference Type vocabulary (`referenceTypes`, a draft) and
  // Source Formatting's "Reference Type Vocabulary" pinned (not there until the owner publishes it: shown as
  // unpublished, never refusing the approval while the vocabulary is a draft).
  // `-f6b` (ADR 0079, 25 November 2026; session F6b): navigation and subject indexes (`indexTaxonomy`: T11's ordering and
  // tag rule, a draft until published, and the classification report's structural lists), and the Tagging Standard's
  // "Navigation and Subject Index Tags" pinned (unpublished until the owner's reviewer writes it).
  // `-f6c` (ADR 0080, 27 November 2026; session F6c): the nation roles and their approved variants
  // (`indexTaxonomy.nationRoles`, `nationRoleVariants`), the nation subindex words derived from them for F6b's
  // classifier, the territory categories' nesting (Conflicts in Historical Events), the Lost Realmships, and the ruling
  // `nation-subindex-roles`. No new pinned section: Source Formatting's "Nation-Centred Territorial Navigation" is pinned
  // already, so the reviewer's paragraph shows as governance drift and the owner approves again.
  // `-f5b1` (ADR 0068 amendment 2, 28 November 2026; session F5b.1): the automation caps leave the rules (they are
  // settings, AUTOMATION_CAP_PER_CODE / _PER_RUN).
  // `-f12` (ADR 0081, 28 November 2026; session F12, after F5b.1): the per-tool "always propose" switches dropped
  // (`settings` is empty); every pack tool follows the agent's scope. Nothing else changed.
  // `-f6d` (ADR 0082, 29 November 2026; session F6d, after F12): templated source names (`templatedNames`: the template
  // <Subject> - <Role>, the Subject row, the vocabulary's specialist types exempt) and the ruling `templated-names`. No
  // new pinned section: Source Formatting's "Page Names and Templates" is pinned already, so the reviewer's paragraph
  // shows as governance drift and the owner approves again.
  seed: 'arkona-2026-11-29-f6d',
  supersedes: [
    'arkona-2026-11-28-f12',
    'arkona-2026-11-28-f5b1',
    'arkona-2026-11-26-f12', // F12's seed before F5b.1 merged (never released)
    'arkona-2026-11-27-f6c',
    'arkona-2026-11-25-f6b',
    'arkona-2026-11-24-f6a',
    'arkona-2026-11-23-f7b',
    'arkona-2026-11-23-f5c',
    'arkona-2026-11-23-f5b',
    'arkona-2026-11-23-f5a',
    'arkona-2026-11-21-r4',
    'arkona-2026-11-20-f41',
    'arkona-2026-11-20-f4c',
    'arkona-2026-11-20-f4b1',
    'arkona-2026-11-20-f4b',
    'arkona-2026-11-19-f4a',
    'arkona-2026-11-19-f3f',
    'arkona-2026-11-18-f3e',
    'arkona-2026-11-16',
    'arkona-2026-11-16-f3b',
    'arkona-2026-11-16-f3b1',
    'arkona-2026-11-17-f3d',
    'arkona-2026-11-17-f3-4',
  ],
  rules,
  governance: [
    {
      key: 'character-architecture',
      project: 'arkona',
      resourceId: 'cn8v87hh',
      documentId: 'p5rcvxze',
      name: 'Character Architecture',
    },
    {
      key: 'source-formatting',
      project: 'arkona',
      resourceId: 'cn8v87hh',
      documentId: 'l41y28c8',
      name: 'Source Formatting',
      // v3 F3b: the sections the owner tools are derived from (design, header), by their exact headings as the page
      // has them (read 16 November 2026; ADR 0052 amendment). Matched whole, never by prefix.
      sections: [
        'Page Names and Templates',
        'Nation-Centred Territorial Navigation',
        'Approved Hierarchy and Standardised Navigation',
        'Active Template Suite and Sidebar Collections',
        // v3 F6a (ADR 0076): the Reference Type vocabulary, once the owner publishes it under "Sidebar Metadata".
        'Reference Type Vocabulary',
      ],
    },
    {
      key: 'tagging-standard',
      project: 'arkona',
      resourceId: 'cn8v87hh',
      documentId: 'bfrv43jr',
      name: 'Controlled Native Tagging Standard',
      label: 'v1.8',
      // v3 F3f (ADR 0060): the retag tools also read the Excluded Routine Tags (the derived list is `retag`).
      // v3 F5a (ADR 0067, H1): and the Approved Supplementary Tags (`retag.supplementary`, parsed from it).
      sections: [
        'Exact Tag Grammar',
        'Closed Primary Categories and Specialist Functions',
        'Excluded Routine Tags',
        'Approved Supplementary Tags',
        // v3 F6b (ADR 0079): the index tag rule, once the owner's reviewer writes it (unpublished until then).
        'Navigation and Subject Index Tags',
      ],
    },
    // v3 F5b (ADR 0068, H5): Repository Automation (the governance root's tab xd9gzkel, read live by the owner on 19
    // November 2026): the automation framework records each code the owner switches on in "Approved Narrow
    // Automations", after the block-id sweep's paragraph; its Default Boundary and Source Boundaries are the rules it
    // keeps. A change of the page outside the bridge's own paragraphs is drift: no automation runs until the pack is
    // approved again.
    {
      key: 'repository-automation',
      project: 'arkona',
      resourceId: 'cn8v87hh',
      documentId: 'xd9gzkel',
      name: 'Repository Automation',
      sections: ['Default Boundary', 'Approved Narrow Automations', 'Source Boundaries'],
    },
    // v3 F4c (ADR 0065, design E9): the fiction Design References, found by their page names (any dash): the narrative
    // layout and tools are derived from these two sections.
    {
      key: 'narrative-workflow',
      project: 'arkona',
      resourceId: '',
      documentId: '',
      page: 'Arkona - Narrative Story Planning & Drafting Workflow',
      name: 'Narrative Story Planning & Drafting Workflow',
      sections: ['LegendKeeper Planning and Manuscript Structure'],
    },
    {
      key: 'fiction-writing',
      project: 'arkona',
      resourceId: '',
      documentId: '',
      page: 'Arkona - Fiction Writing Reference',
      name: 'Fiction Writing Reference',
      sections: ['32B. Durable Chapter Persistence in LegendKeeper'],
    },
  ],
  // v3 F3b: the four templates the owner types add, by name (their ids are worked out in each project, Arkona included).
  templateNames: {
    polity: 'AI Polity and Institution',
    place: 'AI Place and Divine Realm',
    magictech: 'AI Magic and Technology',
    creature: 'AI Creature and Species',
  },
  projects: [
    {
      name: 'arkona',
      templates: {
        core: 'bffw83fb',
        compact: 'exl4dzki',
        art: 'g7gdpoe6',
        relationship: 'krkreawl',
        general: 'ie08m47o',
        index: 'zaomdr49',
      },
    },
    { name: 'test' },
  ],
  home: 'arkona',
});

/** The seeds the bridge knows (one pack in F3a). */
export const PACK_SEEDS: readonly PackSeed[] = [ARKONA_PACK];
