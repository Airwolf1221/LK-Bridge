/**
 * The appraisal's test world (v3 F3c, ADR 0054): F3b's owners world (the REAL server, runtime, MCP transport, policy and
 * engine against the mock LegendKeeper; Salahad, Races of Arkona, the characters of F3a, the Arkona pack attached and
 * approved) with fixtures built from the shapes the owner-approved design quotes, never fetched:
 *
 * - **the Appraisal Desk** (`[INDEX] Appraisal Desk`, with an index scope, Purpose and a Subpages collection): one clean
 *   owner page, and one page per A2 defect, each otherwise exactly the clean page (so each check fires on its own page
 *   and stays silent on the clean one); an index lacking its scope, "why open" text and collection; two pages out of
 *   order (the audits' `out_of_order`, gathered); a page missing a required tag (the audits' tag rule, gathered);
 * - **a character set**, Nadira al-Khalid's: her Core (with the completion gate met), a Character Art page, a Biography
 *   and a joint Relationship, with Related Sources between them (one link not reciprocated); a Core with a large
 *   Biography block and three specialist domains (architectural candidates); a Core whose gate is not met;
 * - **the Fourth Age chronology table** (confirmed as the chronology's table), with a row mentioning Nadira and a row
 *   naming her in plain text; a Salahad page mentioning her (by her name, and by another label) and one restating her;
 * - **Working pages**: one whose Unresolved Material declares a contradiction;
 * - **the asset library**: Nadira's folder (with Forms), Mehrana I's folder, and an Unused folder: an asset named with
 *   a `.png` extension that is a PNG, two images labelled Nadira's Primary Reference, one of Nadira's images kept in
 *   Mehrana's folder, an orphan, and an Art page image block whose asset is gone.
 *
 * `snapshot()` takes a full snapshot (the real snapshot service against the mock) and waits for the audit and the
 * appraisal index its hook starts.
 */
import sharp from 'sharp';
import { ROOT } from '../discover/world.js';
import { buildModels } from '../discover/world.js';
import { SidebarModel } from '../resources/world.js';
import { DEFAULT_SNAPSHOT_SETTINGS } from '../../src/config/index.js';
import { ProjectStore } from '../../src/projects/store.js';
import { C, IDENTITY_KEYS, TPL } from '../packs/world.js';
import { O, OWNER_KEYS, PROJECT, ownersWorld, type OwnersWorld } from '../packs/owners-world.js';
import type { ToolCall } from '../tools/helpers.js';

export { C, O, PROJECT };

/** The fixture pages' ids. */
export const P = {
  desk: 'apdesk01',
  clean: 'apclean1',
  noPurpose: 'apnopurp',
  title: 'aptitle1',
  headingLink: 'aphlink1',
  markdown: 'apmarkd1',
  blanks: 'apblank1',
  dashName: 'apdashnm',
  dashText: 'apdashtx',
  missingField: 'apmissf1',
  extraField: 'apextraf',
  noBoundaries: 'apnobndr',
  workingDep: 'apwrkdep',
  archivedRelated: 'aparcrel',
  emptyRelated: 'apemptyr',
  zebra: 'apzebra1',
  apple: 'apapple1',
  untagged: 'apuntag1',
  bareIndex: 'apbareix',
  tagdef: 'aptagdef',
  // the character set
  nadiraArt: 'nadirart',
  nadiraBio: 'nadirbio',
  relationship: 'nadirrel',
  gapIndex: 'gapidx01',
  gap: 'gapcore1',
  heavyIndex: 'hvyidx01',
  heavy: 'hvycore1',
  // the chronology, the mentions, the Working pages
  chronology: 'chronix1',
  fourthAge: 'age4tab1',
  hollowWorking: 'hollowwk',
  // the non-current areas (D1)
  legacy: 'legacyix',
  legacyPage: 'legacyp1',
  design: 'designix',
  designPage: 'designp1',
} as const;

/** The asset library's ids. */
export const A = {
  characters: 'afchars1',
  beastkin: 'afbeast1',
  qishen: 'afqishe1',
  nadira: 'afnadir1',
  forms: 'afnforms',
  mehrana: 'afmehra1',
  unused: 'afunuse1',
  portraitPng: 'imgpng01',
  fullFigure: 'imgfull1',
  sketch: 'imgsktch',
  orphan: 'imgorph1',
  gone: 'imggone1',
} as const;

const heading = (id: string, level: number, text: string, more: Record<string, unknown> = {}) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
  ...more,
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const blank = (id: string) => ({ id, kind: 'paragraph', content: [] });

/** The clean owner page's body: Purpose first, its sections, Source Boundaries and Unresolved Material. */
export function cleanBody(prefix: string) {
  return [
    heading(`${prefix}h1`, 2, 'Purpose'),
    para(`${prefix}p1`, 'The reference for a coastal polity of eastern Salahad and its harbour law.'),
    heading(`${prefix}h2`, 2, 'Overview'),
    para(`${prefix}p2`, 'A merchant republic that grew around the tide gate and its toll courts.'),
    heading(`${prefix}h3`, 2, 'Source Boundaries'),
    para(`${prefix}p3`, 'This page only.'),
    heading(`${prefix}h4`, 2, 'Unresolved Material'),
    para(`${prefix}p4`, 'None yet.'),
  ];
}

export interface AppraisalWorld extends OwnersWorld {
  /** The Main document id of a seeded page. */
  mainOf(pageId: string): string;
  /** A full snapshot, then the audit and the appraisal index its hook starts. */
  snapshot(): Promise<void>;
  /** Requests the mock LegendKeeper has answered so far, and the writes among them. */
  requests(): { all: number; writes: number };
  /** Calls a tool with a read-scope connection. */
  callRead(name: string, args: Record<string, unknown>): Promise<ToolCall>;
}

export async function appraisalWorld(
  o: Parameters<typeof ownersWorld>[0] & {
    /**
     * v3 F3f (ADR 0060): keep the seed's retag rules in the approved version (the retag world). Without it, the world
     * approves a version without them, so the tests written before F3f keep testing the tag-definition document's audit
     * path (a project whose pack has no retag rules).
     */
    readonly retag?: boolean;
  } = {},
): Promise<AppraisalWorld> {
  const w = (await ownersWorld({
    ...o,
    tools: {
      ...o.tools,
      snapshots: { ...DEFAULT_SNAPSHOT_SETTINGS, minFreeBytes: 0 },
    },
    seed: (world) => {
      const r = world.repo;
      const page = (id: string, name: string, parentId: string, more: Record<string, unknown> = {}) =>
        r.seed({ id, name, parentId, ...more });
      page(P.desk, '[INDEX] Appraisal Desk', ROOT);
      const owner = (id: string, name: string, more: Record<string, unknown> = {}) =>
        page(id, name, P.desk, {
          referenceType: 'Polity Reference',
          scope: 'A coastal polity',
          tags: ['CANON', 'Polity'],
          ...more,
        });
      owner(P.clean, '[BSRC] Ashqal Republic - Polity Reference');
      owner(P.noPurpose, '[BSRC] Barid League - Polity Reference');
      owner(P.title, '[BSRC] Cadiz Free City - Polity Reference');
      owner(P.headingLink, '[BSRC] Dunmere March - Polity Reference');
      owner(P.markdown, '[BSRC] Eshar Compact - Polity Reference');
      owner(P.blanks, '[BSRC] Faraz Sultanate - Polity Reference');
      owner(P.dashName, '[BSRC] Gata—Lund - Polity Reference');
      owner(P.dashText, '[BSRC] Hollin Shore - Polity Reference');
      owner(P.missingField, '[BSRC] Ilmar Coast - Polity Reference');
      owner(P.extraField, '[BSRC] Jasra Isles - Polity Reference');
      owner(P.noBoundaries, '[BSRC] Kestrel Reach - Polity Reference');
      owner(P.workingDep, '[BSRC] Lumen Strand - Polity Reference');
      owner(P.archivedRelated, '[BSRC] Marrow Bay - Polity Reference');
      owner(P.emptyRelated, '[BSRC] Norrow Cape - Polity Reference');
      // Seeded in this order, so Zebra ranks before Apple: out of alphabetical order (the audit's finding).
      owner(P.zebra, '[BSRC] Zebra Holdfast - Polity Reference');
      owner(P.apple, '[BSRC] Apple Reach - Polity Reference');
      owner(P.untagged, '[BSRC] Orsk Harbour - Polity Reference', { tags: ['CANON'] });
      page(P.bareIndex, '[INDEX] Appraisal Bare Index', P.desk);
      page(P.tagdef, '[BSRC] Appraisal Tag Definitions', ROOT, {
        referenceType: 'General Source',
        tags: ['CANON'],
      });
      // Nadira's set: Art, Biography and a joint Relationship beside her Core.
      page(P.nadiraArt, '[BSRC] Nadira al-Khalid - Character Art', C.nadiraIndex, {
        referenceType: 'Character Art',
        tags: ['CANON', 'Character', 'Character Art'],
      });
      page(P.nadiraBio, '[BSRC] Nadira al-Khalid - Biography', C.nadiraIndex, {
        referenceType: 'Character Biography',
        tags: ['CANON', 'Character', 'Biography'],
      });
      page(P.relationship, '[BSRC] Mehrana I al-Khalid & Nadira al-Khalid - Relationship', C.nadiraIndex, {
        referenceType: 'Joint Character Relationship Reference',
        tags: ['CANON', 'Character', 'Relationship'],
      });
      // A Core whose gate is not met, and a Core holding large specialist blocks.
      page(P.gapIndex, '[INDEX] Gate Warden', C.qishen);
      page(P.gap, '[BSRC] Gate Warden - Character Core', P.gapIndex, {
        referenceType: 'Character Core',
        tags: ['CANON', 'Character', 'Qishen'],
      });
      page(P.heavyIndex, '[INDEX] Heavy Saga', C.qishen);
      page(P.heavy, '[BSRC] Heavy Saga - Character Core', P.heavyIndex, {
        referenceType: 'Character Core',
        tags: ['CANON', 'Character', 'Qishen'],
      });
      // The chronology's Fourth Age table.
      page(P.chronology, '[INDEX] Universal Chronology Desk', ROOT);
      page(P.fourthAge, '[BSRC] Fourth Age - Table', P.chronology, {
        referenceType: 'Chronology Table',
        tags: ['CANON'],
      });
      // The non-current areas: the Legacy Canon Archive and the Design References.
      page(P.legacy, '[INDEX] Legacy Canon Archive', ROOT);
      page(P.legacyPage, '[BSRC] Old Tide Charter', P.legacy, {
        referenceType: 'General Source',
        tags: ['CANON'],
      });
      page(P.design, '[INDEX] Design References', ROOT);
      page(P.designPage, '[BSRC] Tide Gate Concept Notes', P.design, { referenceType: 'General Source' });
      // A Working page that declares a contradiction.
      page(P.hollowWorking, '[BWRK] Hollow Court Draft', 'wkidx001', {
        referenceType: 'General Source',
        tags: ['Working'],
      });
      o.seed?.(world);
    },
  })) as AppraisalWorld;

  const r = w.repo;
  const sb = w.sidebars;
  const mainOf = (id: string) => r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!.id;
  const setBody = (id: string, blocks: unknown[]) => r.blocks.set(mainOf(id), { version: 1, blocks });

  // ---------------------------------------------------------------------------------- the desk's sidebars and bodies
  const ownerRows = (subject: string, more: Partial<Record<string, string>> = {}, keys = OWNER_KEYS) =>
    keys.map((k) => {
      const v: Record<string, string> = {
        Status: 'Authoritative',
        'Continuity Type': 'CANON',
        Continuity: 'Main',
        Inheritance: 'None',
        Subject: subject,
        'Reference Type': 'Polity Reference',
        Scope: 'A coastal polity',
        'Temporal Scope': '4A 100 - 5A 931',
        'Last Major Revision': '2026-11-01',
        Supersedes: 'None',
        ...more,
      };
      return [k, v[k] ?? ''] as [string, string];
    });
  const ownerSidebar = (
    id: string,
    subject: string,
    o2: {
      rows?: [string, string][];
      deps?: string[];
      related?: string[];
    } = {},
  ) =>
    sb.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', o2.rows ?? ownerRows(subject)),
      SidebarModel.links(
        `dp${id}`.slice(0, 8),
        'Dependencies',
        (o2.deps ?? [O.salahadReference]).map((x) => ({ resourceId: x })),
      ),
      SidebarModel.links(
        `rl${id}`.slice(0, 8),
        'Related Sources',
        (o2.related ?? [O.tarim]).map((x) => ({ resourceId: x })),
      ),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const desk: [string, string][] = [
    [P.clean, 'Ashqal Republic'],
    [P.noPurpose, 'Barid League'],
    [P.title, 'Cadiz Free City'],
    [P.headingLink, 'Dunmere March'],
    [P.markdown, 'Eshar Compact'],
    [P.blanks, 'Faraz Sultanate'],
    [P.dashName, 'Gata—Lund'],
    [P.dashText, 'Hollin Shore'],
    [P.noBoundaries, 'Kestrel Reach'],
    [P.zebra, 'Zebra Holdfast'],
    [P.apple, 'Apple Reach'],
    [P.untagged, 'Orsk Harbour'],
  ];
  for (const [id, subject] of desk) {
    ownerSidebar(id, subject);
    setBody(id, cleanBody(id));
  }
  // Each defect, on its own page.
  setBody(P.noPurpose, cleanBody(P.noPurpose).slice(2));
  setBody(P.title, [heading('tt0', 1, 'Cadiz Free City - Polity Reference'), ...cleanBody(P.title)]);
  setBody(P.headingLink, [
    ...cleanBody(P.headingLink).slice(0, 2),
    {
      id: 'hl1',
      kind: 'heading',
      level: 2,
      content: [{ text: 'Relations with ' }, { mention: { resourceId: O.tarim, text: 'Tarim' } }],
    },
    para('hl2', 'Long rivals across the strait.'),
    ...cleanBody(P.headingLink).slice(2),
  ]);
  setBody(P.markdown, [
    ...cleanBody(P.markdown).slice(0, 2),
    para('md1', '**Founded** by the tide guilds in 4A 100.'),
    ...cleanBody(P.markdown).slice(2),
  ]);
  setBody(P.blanks, [
    ...cleanBody(P.blanks).slice(0, 2),
    blank('bl1'),
    blank('bl2'),
    ...cleanBody(P.blanks).slice(2),
  ]);
  setBody(P.dashText, [
    ...cleanBody(P.dashText).slice(0, 2),
    heading('dh1', 2, 'Trade — and Tolls'),
    {
      id: 'dp1',
      kind: 'paragraph',
      content: [
        { text: 'The gate — its keepers say — never closes; ' },
        { text: 'never', bold: true },
        { text: '.' },
      ],
    },
    ...cleanBody(P.dashText).slice(2),
  ]);
  setBody(P.noBoundaries, cleanBody(P.noBoundaries).slice(0, 4));
  ownerSidebar(P.missingField, 'Ilmar Coast', {
    rows: ownerRows('Ilmar Coast').filter(([k]) => k !== 'Temporal Scope'),
  });
  setBody(P.missingField, cleanBody(P.missingField));
  ownerSidebar(P.extraField, 'Jasra Isles', { rows: [...ownerRows('Jasra Isles'), ['Mood', 'Stormy']] });
  setBody(P.extraField, cleanBody(P.extraField));
  ownerSidebar(P.workingDep, 'Lumen Strand', { deps: [C.draft] });
  setBody(P.workingDep, cleanBody(P.workingDep));
  ownerSidebar(P.archivedRelated, 'Marrow Bay', { related: [C.archived] });
  setBody(P.archivedRelated, cleanBody(P.archivedRelated));
  ownerSidebar(P.emptyRelated, 'Norrow Cape', { related: [] });
  setBody(P.emptyRelated, cleanBody(P.emptyRelated));
  // The desk itself: an index with its scope, Purpose and Subpages; the bare index has none of them.
  sb.page(P.desk, [
    SidebarModel.kv('kvapdesk', 'PROPERTIES', [
      ['Reference Type', 'Index'],
      ['Index Scope', 'The appraisal fixtures'],
    ]),
  ]);
  setBody(P.desk, [
    heading('dk1', 2, 'Purpose'),
    para('dk2', 'Routes to the polities the appraisal reads.'),
    heading('dk3', 2, 'Subpages'),
    { id: 'dkcoll', kind: 'resourceCollection', items: [] },
  ]);
  sb.page(P.bareIndex, [
    SidebarModel.kv('kvbareix', 'PROPERTIES', [
      ['Reference Type', 'Index'],
      ['Index Scope', ''],
    ]),
  ]);
  setBody(P.bareIndex, [
    heading('bx1', 2, 'Purpose'),
    heading('bx2', 2, 'Notes'),
    para('bx3', 'Odds and ends.'),
  ]);
  // The tag definitions: every desk page needs the Polity tag.
  sb.page(P.tagdef, [SidebarModel.kv('kvtagdef', 'PROPERTIES', [['Reference Type', 'General Source']])]);
  setBody(P.tagdef, [
    para('td1', 'The tags each rule requires.'),
    {
      id: 'td2',
      kind: 'code',
      language: 'json',
      text: JSON.stringify({
        schema: 1,
        rules: [{ id: 'desk', required_tags: ['Polity'], allowed_tags: ['CANON'] }],
      }),
    },
  ]);

  // ---------------------------------------------------------------------------------- the character set
  const general = (id: string, subject: string, rt: string, related: string[], deps: string[] = []) =>
    sb.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        [
          'Status',
          'Continuity Type',
          'Continuity',
          'Inheritance',
          'Subject',
          'Reference Type',
          'Scope',
          'Last Major Revision',
          'Supersedes',
        ].map(
          (k) =>
            [
              k,
              (
                {
                  Status: 'Authoritative',
                  'Continuity Type': 'CANON',
                  Continuity: 'Main',
                  Inheritance: 'None',
                  Subject: subject,
                  'Reference Type': rt,
                  Scope: `${subject}: ${rt}`,
                  'Last Major Revision': '2026-11-01',
                  Supersedes: 'None',
                } as Record<string, string>
              )[k] ?? '',
            ] as [string, string],
        ),
      ),
      SidebarModel.links(
        `dp${id}`.slice(0, 8),
        'Dependencies',
        deps.map((x) => ({ resourceId: x })),
      ),
      SidebarModel.links(
        `rl${id}`.slice(0, 8),
        'Related Sources',
        related.map((x) => ({ resourceId: x })),
      ),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  // Nadira's Core lists her Art and Biography; the Biography lists the Core back; the Art does not.
  const nadiraCore = sb.pages.get(C.nadira)!;
  const rl = nadiraCore.props.find((p) => p.title === 'Related Sources')!;
  rl.items = [
    { id: 'nrl1', resourceId: P.nadiraArt, rank: 'r00000100' },
    { id: 'nrl2', resourceId: P.nadiraBio, rank: 'r00000200' },
  ];
  setBody(C.nadira, [
    heading('nc1', 2, 'Purpose'),
    para('nc2', 'The identity of Nadira al-Khalid, archivist of the house.'),
    heading('nc3', 2, 'Identity'),
    para('nc4', 'A Qishen archivist of Menkhet.'),
    heading('nc5', 2, 'Source Boundaries'),
    para('nc6', 'Identity only.'),
    heading('nc7', 2, 'Unresolved Material'),
    para('nc8', 'None yet.'),
  ]);
  general(P.nadiraArt, 'Nadira al-Khalid', 'Character Art', []);
  general(P.nadiraBio, 'Nadira al-Khalid', 'Character Biography', [C.nadira]);
  general(
    P.relationship,
    'Mehrana I al-Khalid & Nadira al-Khalid',
    'Joint Character Relationship Reference',
    [C.nadira],
    [C.nadira],
  );
  setBody(P.nadiraBio, [
    heading('nb1', 2, 'Purpose'),
    para('nb2', 'The life of Nadira al-Khalid.'),
    heading('nb3', 2, 'Early Life'),
    para('nb4', 'Raised among the archives of Menkhet.'),
  ]);
  setBody(P.relationship, [
    heading('nr1', 2, 'Purpose'),
    para('nr2', 'The bond between Mehrana I and Nadira.'),
    heading('nr3', 2, 'Source Boundaries'),
    para('nr4', 'This bond only.'),
    heading('nr5', 2, 'Unresolved Material'),
    para('nr6', 'None yet.'),
  ]);
  // The gate not met: Naming Culture blank, Life State an untouched placeholder.
  const gateRows = (subject: string, more: Partial<Record<string, string>>) =>
    IDENTITY_KEYS.map(
      (k) =>
        [
          k,
          (
            {
              Status: 'Authoritative',
              'Continuity Type': 'CANON',
              Continuity: 'Main',
              Inheritance: 'None',
              Subject: subject,
              'Canonical Display Name': subject,
              'Personal / Given Name': subject.split(' ')[0]!,
              'Family / Surname': subject.split(' ')[1] ?? 'Unestablished',
              'Naming Culture': 'Menkheti',
              Aliases: '',
              'Reference Type': 'Character Core',
              Scope: 'A gate warden',
              'Race / Species': 'Qishen',
              'Life State': 'Alive',
              'Temporal Scope': '5A 931',
              'Last Major Revision': '2026-11-01',
              Supersedes: 'None',
              ...more,
            } as Record<string, string>
          )[k] ?? '',
        ] as [string, string],
    );
  for (const [id, subject, more] of [
    [P.gap, 'Gate Warden', { 'Naming Culture': '', 'Life State': 'TBD' }],
    [P.heavy, 'Heavy Saga', {}],
  ] as const)
    sb.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', gateRows(subject, more)),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', [{ resourceId: C.nadira }]),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  setBody(P.gap, [
    heading('gp1', 2, 'Purpose'),
    para('gp2', 'The identity of the gate warden.'),
    heading('gp3', 2, 'Source Boundaries'),
    para('gp4', 'Identity only.'),
    heading('gp5', 2, 'Unresolved Material'),
    para('gp6', 'Naming culture unknown.'),
  ]);
  const long =
    'Heavy Saga sailed the outer reefs for many seasons and kept long logs of every crossing. '.repeat(18);
  setBody(P.heavy, [
    heading('hv1', 2, 'Purpose'),
    para('hv2', 'The identity of Heavy Saga.'),
    heading('hv3', 2, 'Biography'),
    para('hv4', long),
    heading('hv5', 2, 'Powers and Abilities'),
    para('hv6', 'Tide-reading.'),
    heading('hv7', 2, 'Wardrobe'),
    para('hv8', 'A salt-stained coat.'),
    heading('hv9', 2, 'Source Boundaries'),
    para('hv10', 'Identity only.'),
    heading('hv11', 2, 'Unresolved Material'),
    para('hv12', 'None yet.'),
  ]);

  // ---------------------------------------------------------------------------------- mentions and the chronology
  setBody(O.tarim, [
    heading('tr1', 2, 'Purpose'),
    para('tr2', 'The reference for the Sultanate of Tarim.'),
    heading('tr3', 2, 'Archives'),
    {
      id: 'tr4',
      kind: 'paragraph',
      content: [
        { text: 'Its archive was kept by ' },
        { mention: { resourceId: C.nadira, text: 'Nadira al-Khalid' } },
        { text: '.' },
      ],
    },
    {
      id: 'tr5',
      kind: 'paragraph',
      content: [
        { text: 'Later ' },
        { mention: { resourceId: C.nadira, text: 'the archivist' } },
        { text: ' moved to Menkhet.' },
      ],
    },
  ]);
  setBody(O.qasr, [
    heading('qs1', 2, 'Purpose'),
    para('qs2', 'The reference for the Emirate of Qasr.'),
    heading('qs3', 2, 'Scholars'),
    para('qs4', 'Nadira al-Khalid catalogued the emirate’s charters in her youth.'),
  ]);
  setBody(P.fourthAge, [
    heading('fa1', 2, 'Purpose'),
    para('fa2', 'The Fourth Age chronology.'),
    {
      id: 'fatab',
      kind: 'table',
      children: [
        {
          id: 'farow0',
          kind: 'tableRow',
          children: ['Historical Event', 'Date', 'KCY'].map((t, i) => ({
            id: `fah${i}`,
            kind: 'tableHeader',
            children: [para(`fahp${i}`, t)],
          })),
        },
        {
          id: 'farow1',
          kind: 'tableRow',
          children: [
            {
              id: 'fac10',
              kind: 'tableCell',
              children: [
                {
                  id: 'fac10p',
                  kind: 'paragraph',
                  content: [
                    { mention: { resourceId: C.nadira, text: 'Nadira al-Khalid' } },
                    { text: ' founds the archive' },
                  ],
                },
              ],
            },
            { id: 'fac11', kind: 'tableCell', children: [para('fac11p', 'Azah 1st, 4A 900')] },
            { id: 'fac12', kind: 'tableCell', children: [para('fac12p', '1251207')] },
          ],
        },
        {
          id: 'farow2',
          kind: 'tableRow',
          children: [
            {
              id: 'fac20',
              kind: 'tableCell',
              children: [para('fac20p', 'Nadira al-Khalid opens the reading room')],
            },
            { id: 'fac21', kind: 'tableCell', children: [para('fac21p', 'Azah 2nd, 4A 901')] },
            { id: 'fac22', kind: 'tableCell', children: [para('fac22p', '1251208')] },
          ],
        },
      ],
    },
  ]);
  // The non-current areas' pages: both hold the words "tide charter".
  setBody(P.legacyPage, [
    heading('lg1', 2, 'Purpose'),
    para('lg2', 'The superseded tide charter of the old canon.'),
  ]);
  setBody(P.designPage, [
    heading('dg1', 2, 'Purpose'),
    para('dg2', 'Design notes for the tide charter imagery.'),
  ]);
  // The Working page that declares a contradiction.
  sb.page(P.hollowWorking, [
    SidebarModel.kv('kvhollow', 'PROPERTIES', [
      ['Status', 'Working'],
      ['Reference Type', 'General Source'],
      ['Scope', 'A draft about the Hollow Court'],
    ]),
  ]);
  setBody(P.hollowWorking, [
    heading('hw1', 2, 'Purpose'),
    para('hw2', 'Drafting the Hollow Court’s founding.'),
    heading('hw3', 2, 'Unresolved Material'),
    para('hw4', 'This draft contradicts the Salahad chronicle on the founding year.'),
  ]);

  // ---------------------------------------------------------------------------------- the asset library
  const webp = (r0: number, g: number, b: number) =>
    sharp({ create: { width: 8, height: 4, channels: 3, background: { r: r0, g, b } } })
      .webp()
      .toBuffer();
  const png = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png()
    .toBuffer();
  w.assets.assets.clear();
  w.served.clear();
  const folder = (name: string, parent: string | null, id: string) => w.assets.folder(name, parent, id);
  folder('Characters', null, A.characters);
  folder('Beastkin', A.characters, A.beastkin);
  folder('Qishen', A.beastkin, A.qishen);
  folder('Nadira al-Khalid', A.qishen, A.nadira);
  folder('Forms', A.nadira, A.forms);
  folder('Mehrana I al-Khalid', A.qishen, A.mehrana);
  folder('Unused', null, A.unused);
  const url = (id: string) => `https://assets.test:${w.port}/a/${id}.webp`;
  const image = (name: string, folderId: string, bytes: Buffer, id: string) => {
    const aid = w.assets.image(name, folderId, { id, width: 8, height: 4 });
    (w.assets.assets.get(aid) as unknown as Record<string, unknown>).url = url(aid);
    w.served.set(aid, bytes);
    return aid;
  };
  image('Nadira al-Khalid - Primary Reference - Portrait.png', A.nadira, png, A.portraitPng);
  image('Nadira al-Khalid - Primary Reference - Full Figure', A.forms, await webp(20, 60, 140), A.fullFigure);
  image('Nadira al-Khalid - Detail - Sketch', A.mehrana, await webp(180, 30, 30), A.sketch);
  image('Unused Banner', A.unused, await webp(40, 140, 60), A.orphan);
  // The Art page's lost plate: its file is still served (so the snapshot is complete), but no asset of the library is it.
  w.served.set(A.gone, await webp(90, 90, 90));
  w.stack.db.prepare('DELETE FROM asset_items WHERE project_id = ?').run(PROJECT);
  w.stack.db.prepare('DELETE FROM asset_folders WHERE project_id = ?').run(PROJECT);
  setBody(P.nadiraArt, [
    heading('na1', 2, 'Purpose'),
    para('na2', 'The visual references of Nadira al-Khalid.'),
    heading('na3', 2, 'Reference Images'),
    heading('na4', 3, 'Primary Reference - Portrait'),
    { id: 'naimg1', kind: 'image', url: url(A.portraitPng) },
    para('na5', 'Her face and archivist’s veil.'),
    heading('na6', 3, 'Primary Reference - Full Figure'),
    { id: 'naimg2', kind: 'image', url: url(A.fullFigure) },
    para('na7', 'Her full height in the archive robes.'),
    heading('na8', 3, 'Detail - Sketch'),
    { id: 'naimg3', kind: 'image', url: url(A.sketch) },
    heading('na9', 3, 'Detail - Lost Plate'),
    { id: 'naimg4', kind: 'image', url: url(A.gone) },
    para('na10', 'A plate since lost.'),
  ]);
  buildModels(w.stack, w.repo, w.assets);
  // The tree's summary of each page's sidebar, as its build reads it from LegendKeeper (getResource): the Last Major
  // Revision planner finds a page's row there (it reads nothing itself).
  const setSidebar = w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?');
  for (const [id, sbar] of sb.pages)
    setSidebar.run(
      JSON.stringify(
        sbar.props.map((p) => ({
          id: p.id,
          kind: p.kind,
          title: p.title,
          ...(p.rows
            ? {
                rows: p.rows.map((r) => ({
                  key: r.key,
                  text: (r.content as { text?: string }[]).map((x) => x.text ?? '').join(''),
                })),
              }
            : {}),
        })),
      ),
      PROJECT,
      id,
    );

  // ---------------------------------------------------------------------------------- the audits' rule and the chronology
  w.stack.runtime.audits.setConfig('owner', PROJECT, {
    rules: [
      {
        id: 'desk',
        name: 'Appraisal desk polities',
        enabled: true,
        selectors: { ancestorName: 'Appraisal Desk', kind: 'bsrc', referenceType: 'Polity Reference' },
        template: { templateId: TPL.general },
      },
    ],
    tagSource: { pageId: P.tagdef, documentId: mainOf(P.tagdef) },
  });
  // The chronology's table, as stored in the project's settings (the calendar is not read here, so the chronology tools
  // still refuse: the appraisal only needs to know which documents are its tables).
  new ProjectStore(w.stack.db).setSetting(PROJECT, 'chronology', {
    resourceId: P.fourthAge,
    ages: [
      {
        name: 'Fourth Age',
        eraId: 'era4',
        tableDocumentId: mainOf(P.fourthAge),
        timelineDocumentId: 'tl4doc01',
        laneId: 'lane4001',
        laneName: 'Events',
        mainRowId: 'mainrow4',
      },
    ],
  });

  const client = await w.stack.connect();
  if (o.retag !== true) {
    const packs = w.stack.runtime.packs;
    const pack = packs.get('arkona');
    if (pack?.approved && pack.rules.retag) {
      const { retag: _retag, ...rest } = pack.rules;
      const v = packs.store.newVersion('arkona', rest, 'test: a version without retag rules (before F3f)');
      packs.store.approve('arkona', {
        version: v.version,
        at: Date.now(),
        by: 'owner',
        sources: pack.approved.sources,
      });
    }
  }
  const reader = w.stack.newToken('appraisal-reader', 'read');
  const readClient = await w.stack.connect(reader.token);
  void client;
  return Object.assign(w, {
    mainOf,
    async snapshot() {
      await w.stack.runtime.snapshots.full(PROJECT, 'manual');
      await w.stack.runtime.audits.settled();
      await w.stack.runtime.appraisal.index.settled();
    },
    requests() {
      const calls = w.stack.mock.calls;
      return { all: calls.length, writes: calls.filter((c) => c.method !== 'GET').length };
    },
    callRead: (name: string, args: Record<string, unknown>) => w.stack.call(readClient, name, args),
  });
}
