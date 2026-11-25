/**
 * The test world of v3 F3b's owner tools (ADR 0052): F3a's pack world (test/packs/world.ts) with fixtures built from the
 * shapes the owner-approved design (docs/design/F3b-owner-tools.md) quotes, never fetched:
 *
 * - the four non-character templates the owner types add (AI Polity and Institution, AI Place and Divine Realm, AI Magic
 *   and Technology, AI Creature and Species) and AI General Source, each with the ten-row sidebar the five share, in
 *   rank order (Status, Continuity Type, Continuity, Inheritance, Subject, Reference Type, Scope, Temporal Scope, Last
 *   Major Revision, Supersedes), then Dependencies, Related Sources and TAGS (`unsupported`), and a body with the
 *   template's own placeholder headings;
 * - Salahad as the design describes it: its eight category indexes (Cultures, Historical Events with Conflicts beneath,
 *   Institutions, Polities, Regions, Settlements & Locations, Unique Magic & Technologies) and its Continent Reference;
 *   in Salahad Polities compact References directly (Sultanate of Tarim, Emirate of Qasr) and nation indexes (Al-Tibr,
 *   holding its Polity Reference and "Living Mercury-Glass - Al-Tibr Defensive Material"; Menkhet with its four
 *   subindexes);
 * - a second continent, Velaria, holding the categories Salahad has not (Religions, Laws, Programmes, Education,
 *   Ceremonies, Conditions) and a nation, Ostrand, with every national category, so every allowed home is tested;
 * - the world level (Arkonan Cultures, Historical Events, Conflicts, Religions), Divine Realm Cultures and a Divine
 *   Realm index;
 * - Races of Arkona (`rraces01`) as design 1.1a describes it: racial group References (Beastkin with Qishen and
 *   Foxians, Elves with Sun Elves, Greenskins, Outsiders, Wyrmkin), ungrouped races (Dwarves, Humans, Sarkaz) and one
 *   subrace (High Humans under Humans); `Setting Framework / Creatures & Conditions / Bestiary`
 *   (`bb9fa6cf7acf8f62565d0d31`);
 * - the governance documents with the pinned sections (Source Formatting's four, the Tagging Standard's two), and the
 *   pack attached with all ten template roles and approved.
 */
import { ROOT } from '../discover/world.js';
import { INDEX_KEYS, LIFECYCLE, SidebarModel, T } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { GENERAL_KEYS, IDENTITY_KEYS, TPL, packWorld, type PackWorld } from './world.js';

export { LIFECYCLE, PROJECT, T, TPL, GENERAL_KEYS, IDENTITY_KEYS };

/** The ten rows the five non-character templates share, in rank order (design section 1). */
export const OWNER_KEYS = [
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
];

export const OTPL = {
  polity: 'tplpoli1',
  place: 'tplplac1',
  magictech: 'tplmagi1',
  creature: 'tplcrea1',
  /** v3 F6b (ADR 0079): "[NAV] AI Navigation", the owner's copy of "[INDEX] AI Index" (by name, never by id). */
  nav: 'tplnav01',
} as const;

/** The fixture pages' ids. */
export const O = {
  continents: 'contin01',
  salahad: 'salahad1',
  salahadReference: 'salahref',
  salahadCultures: 'salcult1',
  salahadEvents: 'salevnt1',
  salahadConflicts: 'salconf1',
  salahadInstitutions: 'salinst1',
  salahadPolities: 'salpoli1',
  salahadRegions: 'salregi1',
  salahadSettlements: 'salsett1',
  salahadMagic: 'salmagi1',
  tarim: 'tarimref',
  qasr: 'qasrref1',
  alTibr: 'altibr01',
  alTibrReference: 'altibref',
  mercuryGlass: 'mercglas',
  menkhet: 'menkhet1',
  menkhetReference: 'menkref1',
  menkhetGovernment: 'menkgov1',
  menkhetInstitutions: 'menkinst',
  menkhetSettlements: 'menksett',
  menkhetMagic: 'menkmagi',
  velaria: 'velaria1',
  velariaPolities: 'velpoli1',
  ostrand: 'ostrand1',
  arkonaIndex: 'arkonaix',
  arkonanCultures: 'arkcult1',
  arkonanEvents: 'arkevnt1',
  arkonanConflicts: 'arkconf1',
  arkonanReligions: 'arkreli1',
  divineRealmCultures: 'divcult1',
  divineRealms: 'divreal1',
  celestineVault: 'celvault',
  framework: 'framewk1',
  creaturesConditions: 'crecond1',
  bestiary: 'bb9fa6cf7acf8f62565d0d31',
  races: 'rraces01',
  beastkinGroup: 'beastgrp',
  qishenCore: 'qishcore',
  foxiansCore: 'foxcore1',
  elvesGroup: 'elvesgrp',
  sunElvesCore: 'sunecore',
  greenskinsGroup: 'greengrp',
  outsidersGroup: 'outsgrp1',
  wyrmkinGroup: 'wyrmgrp1',
  dwarvesCore: 'dwarcore',
  humansCore: 'humacore',
  highHumans: 'highhum1',
  sarkazCore: 'sarkcore',
} as const;

/** The national and continental categories of Velaria and Ostrand (by category name → id). */
export const VELARIA = {
  Religions: 'velreli1',
  Laws: 'vellaws1',
  Programmes: 'velprog1',
  Education: 'veleduc1',
  Ceremonies: 'velcere1',
  Conditions: 'velcond1',
} as const;
export const OSTRAND = {
  Cultures: 'ostcult1',
  'Historical Events': 'ostevnt1',
  History: 'osthist1',
  Religions: 'ostreli1',
  Laws: 'ostlaws1',
  Programmes: 'ostprog1',
  Education: 'osteduc1',
  Ceremonies: 'ostcere1',
  Conditions: 'ostcond1',
  'Unique Magic & Technologies': 'ostmagi1',
  Institutions: 'ostinst1',
  'Government & Administration': 'ostgov01',
  'Settlements & Locations': 'ostsett1',
} as const;

/**
 * The pinned sections the owners world's governance documents hold: the six exact headings of Arkona's pages, as the
 * planner read them on 16 November 2026 (ADR 0052 amendment). The seed pins the same.
 */
export const PINNED = {
  formatting: [
    'Page Names and Templates',
    'Nation-Centred Territorial Navigation',
    'Approved Hierarchy and Standardised Navigation',
    'Active Template Suite and Sidebar Collections',
  ],
  // v3 F3f (ADR 0060): the retag tools also pin the Tagging Standard's Excluded Routine Tags.
  tagging: [
    'Exact Tag Grammar',
    'Closed Primary Categories and Specialist Functions',
    'Excluded Routine Tags',
    // v3 F5a (ADR 0067, H1): and the Approved Supplementary Tags (parsed as the pack's list).
    'Approved Supplementary Tags',
  ],
} as const;

/** v3 F5a: the Approved Supplementary Tags section's sentence, verbatim as Arkona's page has it (23 November 2026). */
export const SUPPLEMENTARY_SENTENCE =
  'Under the Exact Tag Grammar’s provision for a deliberately approved exception, the author has approved these existing tags as permitted supplementary tags on any eligible owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework. A permitted supplementary tag is kept, after the grammar’s slots, wherever it appears. It is not a primary category or a specialist function, it is never added to a page by inference or by an audit, and it is never proposed for removal as incidental. Adding a tag to this list, or removing one, is an author decision recorded here.';

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

export interface OwnersWorld extends PackWorld {
  /** Changes one pinned section of a governance document (its version moves on). */
  editSection(doc: 'formatting' | 'tagging', heading: string): void;
  /** Changes a governance document outside its pinned sections (its version moves on). */
  editOutsidePinned(doc: 'formatting' | 'tagging'): void;
}

export async function ownersWorld(o: Parameters<typeof packWorld>[0] = {}): Promise<OwnersWorld> {
  const w = await packWorld({
    ...o,
    approve: false,
    seed: (world) => {
      const r = world.repo;
      const page = (id: string, name: string, parentId: string, referenceType?: string, scope?: string) =>
        r.seed({
          id,
          name,
          parentId,
          ...(referenceType ? { referenceType } : {}),
          ...(scope ? { scope } : {}),
        });
      // ------------------------------------------------------------------------------------- Salahad
      page(O.continents, '[INDEX] Continents', ROOT);
      page(O.salahad, '[INDEX] Salahad', O.continents);
      page(O.salahadReference, '[BSRC] Salahad - Continent Reference', O.salahad, 'Continent Reference');
      page(O.salahadCultures, '[INDEX] Salahad Cultures', O.salahad);
      page(O.salahadEvents, '[INDEX] Salahad Historical Events', O.salahad);
      page(O.salahadConflicts, '[INDEX] Salahad Conflicts', O.salahadEvents);
      page(O.salahadInstitutions, '[INDEX] Salahad Institutions', O.salahad);
      page(O.salahadPolities, '[INDEX] Salahad Polities', O.salahad);
      page(O.salahadRegions, '[INDEX] Salahad Regions', O.salahad);
      page(O.salahadSettlements, '[INDEX] Salahad Settlements & Locations', O.salahad);
      page(O.salahadMagic, '[INDEX] Salahad Unique Magic & Technologies', O.salahad);
      page(O.alTibr, '[INDEX] Al-Tibr', O.salahadPolities);
      page(O.alTibrReference, '[BSRC] Al-Tibr - Polity Reference', O.alTibr, 'Polity Reference');
      page(
        O.mercuryGlass,
        '[BSRC] Living Mercury-Glass - Al-Tibr Defensive Material',
        O.alTibr,
        'Defensive Material Reference',
      );
      page(O.menkhet, '[INDEX] Menkhet', O.salahadPolities);
      page(O.menkhetReference, '[BSRC] Menkhet - Polity Reference', O.menkhet, 'Polity Reference');
      page(O.menkhetGovernment, '[INDEX] Menkhet Government & Administration', O.menkhet);
      page(O.menkhetInstitutions, '[INDEX] Menkhet Institutions', O.menkhet);
      page(O.menkhetSettlements, '[INDEX] Menkhet Settlements & Locations', O.menkhet);
      page(O.menkhetMagic, '[INDEX] Menkhet Unique Magic & Technologies', O.menkhet);
      page(
        O.tarim,
        '[BSRC] Sultanate of Tarim - Historical Polity Reference',
        O.salahadPolities,
        'Historical Polity Reference',
        'A coastal sultanate of eastern Salahad',
      );
      page(O.qasr, '[BSRC] Emirate of Qasr - Polity Reference', O.salahadPolities, 'Polity Reference');
      // ------------------------------------------------------------------------------------- Velaria, Ostrand
      page(O.velaria, '[INDEX] Velaria', O.continents);
      for (const [c, id] of Object.entries(VELARIA)) page(id, `[INDEX] Velaria ${c}`, O.velaria);
      page(O.velariaPolities, '[INDEX] Velaria Polities', O.velaria);
      page(O.ostrand, '[INDEX] Ostrand', O.velariaPolities);
      for (const [c, id] of Object.entries(OSTRAND)) page(id, `[INDEX] Ostrand ${c}`, O.ostrand);
      // ------------------------------------------------------------------------------------- the world, the realms
      page(O.arkonaIndex, '[INDEX] Arkona', ROOT);
      page(O.arkonanCultures, '[INDEX] Arkonan Cultures', O.arkonaIndex);
      page(O.arkonanEvents, '[INDEX] Arkonan Historical Events', O.arkonaIndex);
      page(O.arkonanConflicts, '[INDEX] Arkonan Conflicts', O.arkonaIndex);
      page(O.arkonanReligions, '[INDEX] Arkonan Religions', O.arkonaIndex);
      page(O.divineRealms, '[INDEX] Divine Realms', ROOT);
      page(O.celestineVault, '[INDEX] Celestine Vault', O.divineRealms);
      page(O.divineRealmCultures, '[INDEX] Divine Realm Cultures', O.divineRealms);
      // ------------------------------------------------------------------------------------- races, the Bestiary
      page(O.framework, '[INDEX] Setting Framework', ROOT);
      page(O.races, '[BSRC] Races of Arkona', O.framework, 'Racial Foundation');
      const group = (id: string, n: string) =>
        page(id, `[BSRC] ${n} - Racial Group Reference`, O.races, 'Racial Group Reference');
      const race = (id: string, n: string, parent: string) =>
        page(id, `[BSRC] ${n} - Core Information`, parent, 'Race Core Reference');
      group(O.beastkinGroup, 'Beastkin');
      race(O.qishenCore, 'Qishen', O.beastkinGroup);
      race(O.foxiansCore, 'Foxians', O.beastkinGroup);
      group(O.elvesGroup, 'Elves');
      race(O.sunElvesCore, 'Sun Elves', O.elvesGroup);
      group(O.greenskinsGroup, 'Greenskins');
      group(O.outsidersGroup, 'Outsiders');
      group(O.wyrmkinGroup, 'Wyrmkin');
      race(O.dwarvesCore, 'Dwarves', O.races);
      race(O.humansCore, 'Humans', O.races);
      page(O.highHumans, '[BSRC] High Humans - Subrace Reference', O.humansCore, 'Subrace Reference');
      race(O.sarkazCore, 'Sarkaz', O.races);
      page(O.creaturesConditions, '[INDEX] Creatures & Conditions', O.framework);
      page(O.bestiary, '[INDEX] Bestiary', O.creaturesConditions);
      // ------------------------------------------------------------------------------------- the four templates
      r.seed({ id: OTPL.polity, name: '[BSRC] AI Polity and Institution', parentId: null, props: false });
      r.seed({ id: OTPL.place, name: '[BSRC] AI Place and Divine Realm', parentId: null, props: false });
      r.seed({ id: OTPL.magictech, name: '[BSRC] AI Magic and Technology', parentId: null, props: false });
      r.seed({ id: OTPL.creature, name: '[BSRC] AI Creature and Species', parentId: null, props: false });
      r.seed({ id: OTPL.nav, name: '[NAV] AI Navigation', parentId: null, props: false });
      o.seed?.(world);
    },
  });

  // ---------------------------------------------------------------------------------- the templates
  const sb = w.sidebars;
  const blank = (keys: string[]) => keys.map((k) => [k, ''] as [string, string]);
  const ownerSidebar = (prefix: string) => [
    SidebarModel.kv(`kv${prefix}`, 'PROPERTIES', blank(OWNER_KEYS)),
    SidebarModel.links(`dp${prefix}`, 'Dependencies', []),
    SidebarModel.links(`rl${prefix}`, 'Related Sources', []),
    { id: `tg${prefix}`, kind: 'unsupported' as const, title: 'TAGS' },
  ];
  sb.page(OTPL.polity, ownerSidebar('tpoli'));
  sb.page(OTPL.place, ownerSidebar('tplac'));
  sb.page(OTPL.magictech, ownerSidebar('tmagi'));
  sb.page(OTPL.creature, ownerSidebar('tcrea'));
  // v3 F6b: the [NAV] template carries the Index template's rows.
  sb.page(OTPL.nav, [SidebarModel.kv('kvtplnav', 'PROPERTIES', blank(INDEX_KEYS))]);
  // AI General Source carries the same ten rows (design section 1).
  sb.page(TPL.general, ownerSidebar('tgen1'));
  const mainOf = (id: string) => w.repo.liveDocs(w.repo.live(id)!).find((d) => d.name === 'Main')!;
  const placeholderBody = (t: string, headings: string[]) => ({
    version: 1,
    blocks: headings.flatMap((h, i) => [
      heading(`${t}h${i}`, 2, h),
      para(`${t}p${i}`, `[Describe the ${h.toLowerCase()}.]`),
    ]),
  });
  w.repo.blocks.set(
    mainOf(OTPL.polity).id,
    placeholderBody(OTPL.polity, [
      'Purpose',
      'Overview',
      'Government',
      'Military',
      'Economy',
      'Source Boundaries',
      'Unresolved Material',
    ]),
  );
  w.repo.blocks.set(
    mainOf(OTPL.place).id,
    placeholderBody(OTPL.place, [
      'Purpose',
      'Geography',
      'Settlements',
      'Source Boundaries',
      'Unresolved Material',
    ]),
  );
  w.repo.blocks.set(
    mainOf(OTPL.magictech).id,
    placeholderBody(OTPL.magictech, [
      'Purpose',
      'Mechanisms',
      'Limits',
      'Source Boundaries',
      'Unresolved Material',
    ]),
  );
  w.repo.blocks.set(
    mainOf(OTPL.creature).id,
    placeholderBody(OTPL.creature, [
      'Purpose',
      'Biology',
      'Behaviour',
      'Source Boundaries',
      'Unresolved Material',
    ]),
  );
  const templates = [
    { id: T.index, name: '[INDEX] AI Index Template' },
    { id: T.core, name: '[BSRC] AI Character Core Template' },
    { id: T.compact, name: '[BSRC] AI Compact Character Reference Template' },
    { id: T.general, name: '[BSRC] AI General Source Template' },
    { id: T.note, name: '[BSRC] AI Note Template' },
    { id: TPL.art, name: '[BSRC] AI Character Art Template' },
    { id: TPL.relationship, name: '[BSRC] AI Relationship Template' },
    { id: OTPL.polity, name: '[BSRC] AI Polity and Institution Template' },
    { id: OTPL.place, name: '[BSRC] AI Place and Divine Realm Template' },
    { id: OTPL.magictech, name: '[BSRC] AI Magic and Technology Template' },
    { id: OTPL.creature, name: '[BSRC] AI Creature and Species Template' },
    { id: OTPL.nav, name: '[NAV] AI Navigation Template' },
  ];
  for (const re of [...w.overrides.keys()]) if (re.source === '\\/templates$') w.overrides.delete(re);
  w.overrides.set(/\/templates$/, (req) =>
    req.method === 'GET'
      ? {
          status: 200,
          body: {
            data: templates.map((t) => ({ ...t, parentId: 'templates' })),
            hasMore: false,
            nextCursor: null,
          },
        }
      : undefined,
  );
  await w.stack.runtime.registry.forProject(PROJECT).commands.refreshTemplates('owner');

  // ---------------------------------------------------------------------------------- governance with pinned sections
  const docs = w.governanceDocs;
  const withSections = (doc: string, title: string, sections: readonly string[]) => {
    w.repo.blocks.set(doc, {
      version: 1,
      blocks: [
        heading(`${doc}h0`, 1, title),
        para(`${doc}p0`, `${title}: the owner's rules.`),
        ...sections.flatMap((s, i) => [
          heading(`${doc}h${i + 1}`, 2, s),
          para(
            `${doc}p${i + 1}`,
            s === 'Approved Supplementary Tags' ? SUPPLEMENTARY_SENTENCE : `The rules of ${s}.`,
          ),
        ]),
      ],
    });
  };
  withSections(docs.formatting, 'Source Formatting', PINNED.formatting);
  withSections(docs.tagging, 'Controlled Native Tagging Standard', PINNED.tagging);
  const packs = w.stack.runtime.packs;
  packs.store.setGovernance('arkona', [
    {
      key: 'character-architecture',
      project: 'test',
      resourceId: ROOT,
      documentId: docs.architecture,
      name: 'Character Architecture',
    },
    {
      key: 'source-formatting',
      project: 'test',
      resourceId: ROOT,
      documentId: docs.formatting,
      name: 'Source Formatting',
      sections: [...PINNED.formatting],
    },
    {
      key: 'tagging-standard',
      project: 'test',
      resourceId: ROOT,
      documentId: docs.tagging,
      name: 'Controlled Native Tagging Standard',
      label: 'v1.8',
      sections: [...PINNED.tagging],
    },
  ]);
  packs.commands.attach('owner', 'arkona', PROJECT, {
    index: TPL.index,
    core: TPL.core,
    compact: TPL.compact,
    general: TPL.general,
    art: TPL.art,
    relationship: TPL.relationship,
    polity: OTPL.polity,
    place: OTPL.place,
    magictech: OTPL.magictech,
    creature: OTPL.creature,
  });
  if (o.approve !== false) await packs.commands.approve('owner', 'arkona');
  const edit = (doc: 'formatting' | 'tagging', at: (blocks: Record<string, unknown>[]) => void) => {
    const b = w.repo.blocks.get(docs[doc])!;
    b.version++;
    const blocks = [...(b.blocks as Record<string, unknown>[])];
    at(blocks);
    b.blocks = blocks;
  };
  return Object.assign(w, {
    editSection(doc: 'formatting' | 'tagging', h: string) {
      edit(doc, (blocks) => {
        const i = blocks.findIndex(
          (x) => x.kind === 'heading' && (x.content as { text: string }[])[0]!.text === h,
        );
        blocks.splice(i + 1, 0, para(`${docs[doc]}e${Date.now()}`, `Amended: ${h}.`));
      });
    },
    editOutsidePinned(doc: 'formatting' | 'tagging') {
      edit(doc, (blocks) => {
        blocks.splice(1, 1, para(`${docs[doc]}o${Date.now()}`, 'The introduction, reworded.'));
      });
    },
  });
}

/** A polity page's text (Purpose first, then sections, then Source Boundaries and Unresolved Material). */
export const ownerText = (purpose: string, more = '') =>
  `## Purpose\n\n${purpose}\n\n${more}## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone yet.\n`;

/** A compact polity package under Salahad Polities (evaluation scenario 35). */
export function compactPolity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Polity',
    name: 'Kingdom of Saba',
    descriptor: 'Historical Polity Reference',
    home: 'Salahad Polities',
    referenceType: 'Historical Polity Reference',
    scope: 'A highland kingdom of southern Salahad',
    temporalScope: '3A 410 - 4A 12',
    markdown: ownerText(
      'The reference for the Kingdom of Saba, a compact polity of southern Salahad.',
      '## Government\n\nA hereditary queenship advised by a council of terrace-holders.\n\n',
    ),
    project: 'test',
    ...over,
  };
}
