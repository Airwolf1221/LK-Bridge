/**
 * v3 F3d (renames), ADR 0058: the rename's test world. F3c's appraisal world (the REAL server, runtime, MCP transport,
 * policy and engine against the mock LegendKeeper; the Arkona pack attached and approved; Nadira al-Khalid's set, the
 * mentions and the asset library) with the Universal Chronology added and confirmed (v2 D1's world), and built from the
 * shapes the owner-approved design quotes (never fetched):
 *
 * **The character rename** (Nadira al-Khalid):
 * - her index (with its "How to Use This Index" routing line), her Core, and three `Nadira al-Khalid - …` children (the
 *   Character Art, the Biography, and Archive Notes, whose heading names her);
 * - two relationships, one each way round: `Mehrana I al-Khalid & Nadira al-Khalid - Relationship` (beside her Core) and
 *   `Nadira al-Khalid & Tarek Basri - Relationship` (hosted under Tarek Basri's index);
 * - her art folder with its images (the Forms subfolder included);
 * - two Fourth Arkonan Age chronology rows naming her: one linked by the bridge to its timeline event (named after her),
 *   dated 4A 950, and one dated 4A 890 (before the effective date the tests give);
 * - mention labels: Tarim's mention labelled with her name, one labelled "the archivist", and a plain mention;
 * - restatements in every D1 (a) context on Qasr's page: an ordinary sentence, quotation marks, "formerly",
 *   "previously", "once called", "originally", and under Unresolved Material; one on a Working page and one on an AU
 *   page;
 * - pages that are history (D2): an Archived character, the Legacy Canon Archive and the Design References, each naming
 *   her; and F3c's Fourth Age page, whose table cells name her (not edited: reported).
 *
 * **The culture rename** (Velaran → Velarine): the culture's index and Culture Reference, the pack's token (`Velaran`),
 * and five characters whose Naming Culture is Velaran and who carry its tag.
 */
import { DEFAULT_KCY_STYLE, formatKcy } from '../../src/calendar/index.js';
import { SidebarModel } from '../resources/world.js';
import { ProjectStore } from '../../src/projects/store.js';
import { chronologyWorld, confirmChronology, CAL, type ChronologyWorld } from '../chronology/world.js';
import { appraisalWorld, C, O, P, PROJECT, type AppraisalWorld } from '../appraisal/world.js';
import { IDENTITY_KEYS } from './world.js';

export { C, O, P, PROJECT };

/** The rename fixtures' own ids. */
export const R = {
  archiveNotes: 'nadarchv',
  tarekIndex: 'tarekidx',
  tarekRelationship: 'nadtarek',
  velaranIndex: 'velarix1',
  velaran: 'velarcul',
  characters: ['velchar1', 'velchar2', 'velchar3', 'velchar4', 'velchar5'] as const,
  /** The chronology rows (Fourth Arkonan Age) and the linked event. */
  rowLinked: 'rnadira1',
  rowEarly: 'rnadira2',
  event: 'enadira1',
} as const;

export const VELARAN_NAMES = ['Aren Tal', 'Bria Sel', 'Corin Hale', 'Dessa Morn', 'Eiren Lusk'] as const;

export type RenameWorld = ChronologyWorld &
  AppraisalWorld & {
    /**
     * The `n`-th (0-based) request with this method whose path matches `path` fails once, with 400 VALIDATION_ERROR (a
     * failure that is not retried: the job stops there). Consulted before every other route.
     */
    failNext(method: string, path: RegExp, n?: number): void;
  };

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const t = (text: string) => [{ text }];
const cell = (id: string, content: unknown[]) => ({
  id: `${id}c`,
  kind: 'tableCell',
  children: [{ id: `${id}p`, kind: 'paragraph', content }],
});

export async function renameWorld(): Promise<RenameWorld> {
  const w = (await chronologyWorld({
    base: (o) => appraisalWorld(o as Parameters<typeof appraisalWorld>[0]),
    confirm: false,
    seed: (world) => {
      const r = world.repo;
      r.seed({
        id: R.archiveNotes,
        name: '[BSRC] Nadira al-Khalid - Archive Notes',
        parentId: C.nadiraIndex,
        referenceType: 'General Source',
        tags: ['CANON', 'Character'],
      });
      r.seed({ id: R.tarekIndex, name: '[INDEX] Tarek Basri', parentId: C.qishen });
      r.seed({
        id: R.tarekRelationship,
        name: '[BSRC] Nadira al-Khalid & Tarek Basri - Relationship',
        parentId: R.tarekIndex,
        referenceType: 'Joint Character Relationship Reference',
        tags: ['CANON', 'Character', 'Relationship'],
      });
      r.seed({ id: R.velaranIndex, name: '[INDEX] Velaran', parentId: O.arkonanCultures });
      r.seed({
        id: R.velaran,
        name: '[BSRC] Velaran - Culture Reference',
        parentId: R.velaranIndex,
        referenceType: 'Culture Reference',
        tags: ['CANON', 'Culture'],
      });
      R.characters.forEach((id, i) =>
        r.seed({
          id,
          name: `[BSRC] ${VELARAN_NAMES[i]} - Character Reference`,
          parentId: C.humans,
          referenceType: 'Compact Character Reference',
          canonical: VELARAN_NAMES[i]!,
          tags: ['CANON', 'Character', 'Human', 'Velaran'],
        }),
      );
    },
  })) as RenameWorld;
  // The appraisal world's own chronology setting (its Fourth Age page) gives way to the Universal Chronology.
  new ProjectStore(w.stack.db).setSetting(PROJECT, 'chronology', {});
  await confirmChronology(w);

  const sb = w.sidebars;
  const setBody = (id: string, blocks: unknown[]) => w.repo.blocks.set(w.mainOf(id), { version: 1, blocks });
  const general = (id: string, rows: [string, string][], related: string[] = []) =>
    sb.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', rows),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(
        `rl${id}`.slice(0, 8),
        'Related Sources',
        related.map((x) => ({ resourceId: x })),
      ),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const canonRows = (subject: string, rt: string): [string, string][] => [
    ['Status', 'Authoritative'],
    ['Continuity Type', 'CANON'],
    ['Continuity', 'Main'],
    ['Inheritance', 'None'],
    ['Subject', subject],
    ['Reference Type', rt],
    ['Scope', `${subject}: ${rt}`],
    ['Last Major Revision', '2026-11-01'],
    ['Supersedes', 'None'],
  ];

  // ---------------------------------------------------------------------------------- Nadira's set
  general(R.archiveNotes, canonRows('Nadira al-Khalid', 'General Source'), [C.nadira]);
  setBody(R.archiveNotes, [
    heading('an1', 2, 'Purpose'),
    para('an2', 'Notes on the archive.'),
    heading('an3', 2, 'Nadira al-Khalid’s Methods'),
    para('an4', 'Every charter is copied twice.'),
  ]);
  general(
    R.tarekRelationship,
    canonRows('Nadira al-Khalid & Tarek Basri', 'Joint Character Relationship Reference'),
    [C.nadira],
  );
  setBody(R.tarekRelationship, [
    heading('tk1', 2, 'Purpose'),
    para('tk2', 'The bond between Nadira and Tarek Basri.'),
  ]);

  // ---------------------------------------------------------------------------------- mentions and restatements
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
    {
      id: 'tr6',
      kind: 'paragraph',
      content: [{ text: 'See ' }, { mention: { resourceId: C.nadira } }, { text: ' for her identity.' }],
    },
  ]);
  setBody(O.qasr, [
    heading('qs1', 2, 'Purpose'),
    para('qs2', 'The reference for the Emirate of Qasr.'),
    heading('qs3', 2, 'Scholars'),
    para('qs4', 'Nadira al-Khalid catalogued the emirate’s charters in her youth.'),
    para('qs5', 'The plaque reads “Nadira al-Khalid, keeper of charters”.'),
    para('qs6', 'The hall’s keeper, formerly Nadira al-Khalid of Tarim, kept the seals.'),
    para('qs7', 'Previously the clerk Nadira al-Khalid signed every copy.'),
    para('qs8', 'The east room was once called Nadira al-Khalid Hall by the clerks.'),
    para('qs9', 'Originally Nadira al-Khalid kept only the charters.'),
    heading('qs10', 2, 'Unresolved Material'),
    para('qs11', 'Whether Nadira al-Khalid wrote the second charter is unsettled.'),
  ]);
  setBody(P.hollowWorking, [
    heading('hw1', 2, 'Purpose'),
    para('hw2', 'Drafting the Hollow Court’s founding.'),
    para('hw5', 'Nadira al-Khalid may have copied the founding charter.'),
    heading('hw3', 2, 'Unresolved Material'),
    para('hw4', 'This draft contradicts the Salahad chronicle on the founding year.'),
  ]);
  setBody(C.au, [
    heading('au1', 2, 'Purpose'),
    para('au2', 'Kaito met Nadira al-Khalid in the sky archive.'),
  ]);
  // History (D2): never edited.
  setBody(C.archived, [heading('ar1', 2, 'Purpose'), para('ar2', 'Seren Vale studied under Nadira al-Khalid.')]);
  setBody(P.legacyPage, [
    heading('lg1', 2, 'Purpose'),
    para('lg2', 'The superseded tide charter of the old canon, kept by Nadira al-Khalid.'),
  ]);
  setBody(P.designPage, [
    heading('dg1', 2, 'Purpose'),
    para('dg2', 'Design notes for Nadira al-Khalid’s archive imagery.'),
  ]);

  // ---------------------------------------------------------------------------------- the chronology rows
  const age = w.ages['Fourth Arkonan Age']!;
  const doc = w.repo.blocks.get(age.table)!;
  const table = (doc.blocks as Record<string, unknown>[]).find((b) => b.kind === 'table')!;
  const rows = table.children as Record<string, unknown>[];
  const row = (id: string, description: string, date: string) => {
    const p = CAL.parser.parse(date);
    return {
      id,
      kind: 'tableRow',
      children: [
        cell(`${id}a`, t(description)),
        cell(`${id}b`, t(date)),
        cell(`${id}c`, t(formatKcy(p.kcy, DEFAULT_KCY_STYLE))),
      ],
    };
  };
  rows.push(row(R.rowEarly, 'Nadira al-Khalid catalogues the charters', '4A 890'));
  rows.push(row(R.rowLinked, 'Nadira al-Khalid founds the reading room', 'Azah 1st, 4A 950'));
  doc.version += 1;
  const start = CAL.parser.parse('Azah 1st, 4A 950');
  w.liveEvents(age.timeline).push({
    id: R.event,
    laneId: age.lane,
    type: 'event',
    rank: 'z1',
    name: 'Nadira al-Khalid founds the reading room',
    start: start.start,
    detail: start.detail,
    uri: `lk://resources/chrono01/docs/${age.table}`,
  });
  w.stack.runtime.chronology.store.link(PROJECT, {
    tableDocumentId: age.table,
    rowId: R.rowLinked,
    timelineDocumentId: age.timeline,
    eventId: R.event,
    age: age.name,
    nameTail: '',
  });

  // ---------------------------------------------------------------------------------- the culture and its characters
  sb.page(R.velaranIndex, [
    SidebarModel.kv('kvvelix1', 'PROPERTIES', [
      ['Reference Type', 'Index'],
      ['Index Scope', 'The Velaran culture'],
    ]),
  ]);
  setBody(R.velaranIndex, [heading('vx1', 2, 'Purpose'), para('vx2', 'Routes to the Velaran culture.')]);
  general(R.velaran, canonRows('Velaran', 'Culture Reference'));
  setBody(R.velaran, [
    heading('vc1', 2, 'Purpose'),
    para('vc2', 'The reference for the Velaran culture of the river towns.'),
  ]);
  R.characters.forEach((id, i) => {
    const name = VELARAN_NAMES[i]!;
    const [given, family] = name.split(' ') as [string, string];
    const v: Record<string, string> = {
      Status: 'Authoritative',
      'Continuity Type': 'CANON',
      Continuity: 'Main',
      Inheritance: 'None',
      Subject: name,
      'Canonical Display Name': name,
      'Personal / Given Name': given,
      'Family / Surname': family,
      'Naming Culture': 'Velaran',
      'Reference Type': 'Compact Character Reference',
      Scope: 'A river-town merchant',
      'Race / Species': 'Human',
      'Life State': 'Alive',
      'Temporal Scope': '5A 931',
      'Last Major Revision': '2026-11-01',
      Supersedes: 'None',
    };
    general(
      id,
      IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
    );
    setBody(id, [heading(`${id}h`, 2, 'Purpose'), para(`${id}p`, `The compact reference for ${name}.`)]);
  });

  // Every page's sidebar summary in the tree (as its build reads it): the rename reads the pages live anyway.
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
  w.failNext = (method, path, n = 0) => {
    let seen = 0;
    let fired = false;
    const fn = (req: { method: string; path: string }) => {
      if (fired || req.method !== method || !path.test(req.path.replace(/\/$/, ''))) return undefined;
      if (seen++ !== n) return undefined;
      fired = true;
      return {
        status: 400,
        body: { message: 'model VALIDATION_ERROR (injected)', code: 'VALIDATION_ERROR', requestId: 'model-injected' },
      };
    };
    const rest = [...w.overrides.entries()];
    w.overrides.clear();
    w.overrides.set(/./, fn);
    for (const [re, f] of rest) w.overrides.set(re, f);
  };
  // The full-text index (A1): a full snapshot of everything above.
  await w.snapshot();
  return w;
}
