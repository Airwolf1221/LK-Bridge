/**
 * v3 F3e (ADR 0059): the splits' test world. F3c's appraisal world (the REAL server, runtime, MCP transport, policy and
 * engine against the mock LegendKeeper; the Arkona pack attached and approved; Nadira al-Khalid's set; Salahad, Ostrand
 * and the race roster) with fixtures built from the shapes the owner-approved design quotes (never fetched):
 *
 * **The character monolith** (`Zahra al-Rashid - Character Reference`, a Compact Character Reference with no index of its
 * own, directly under Qishen): Purpose, Identity, a long Biography, Appearance (three images, each interpreted),
 * Personality, Wardrobe (two images), a long section about her bond with Nadira al-Khalid (one named character, no
 * relationship owner yet), Powers (one paragraph restating Salahad Sorcery's universal rule, mentioning it), Source
 * Boundaries and Unresolved Material (one paragraph per item, across domains). Her Scope names six domains; her
 * Dependencies hold Salahad Sorcery. Two pages depend on her (Nadira's Biography and the Sultanate of Tarim), and a row of
 * the Fourth Age chronology names her.
 *
 * **The owner with two separable domains** (`Ostrand Statutes and Rites - General Source`, in Ostrand's index): Purpose,
 * Overview, a long Law and Courts section and a long Faith and Worship section, Source Boundaries and Unresolved
 * Material. Two pages depend on it (Ostrand's Polity Reference and the Ostrand Assizes); the existing Religion owner
 * `Ostrand Sun Rite - Religion Reference` can take its faith section.
 *
 * **The controls**: a thin character (`Thin Lamp - Character Reference`) that triggers nothing, and a long Biography page
 * in ONE domain (`Nadira al-Khalid - Chronicle`): length alone never counts.
 */
import sharp from 'sharp';
import { SidebarModel } from '../resources/world.js';
import { appraisalWorld, A, C, O, P, PROJECT, type AppraisalWorld } from '../appraisal/world.js';
import { OSTRAND, OWNER_KEYS } from './owners-world.js';
import { IDENTITY_KEYS } from './world.js';

export { A, C, O, P, PROJECT, OSTRAND };

/** The split fixtures' own ids. */
export const S = {
  zahra: 'zahraref',
  thin: 'thinlamp',
  chronicle: 'nadchron',
  sorcery: 'salsorcy',
  statutes: 'oststatr',
  ostrandPolity: 'ostpolrf',
  assizes: 'ostassiz',
  sunRite: 'ostsunrt',
  zahraFolder: 'afzahra1',
  images: ['imgzah01', 'imgzah02', 'imgzah03', 'imgzah04', 'imgzah05'] as const,
} as const;

export type SplitWorld = AppraisalWorld;

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const sentence = (n: number, s: string) => Array.from({ length: n }, () => s).join(' ');

/** Zahra's body, block by block (ids are the tests' handles). */
export function zahraBody(url: (id: string) => string) {
  const bio = (k: number) =>
    para(
      `zb${k}`,
      sentence(
        12,
        `In her ${['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][k - 2]} decade Zahra al-Rashid travelled the caravan roads of Menkhet and kept a careful ledger of every bargain she struck.`,
      ),
    );
  return [
    heading('zh1', 2, 'Purpose'),
    para('zp1', 'The complete reference for Zahra al-Rashid, sorceress of Menkhet.'),
    heading('zh2', 2, 'Identity'),
    para('zi1', 'A Qishen sorceress of Menkhet, born to the al-Rashid house in the reign of Mehrana I.'),
    heading('zh3', 2, 'Biography'),
    bio(2),
    bio(3),
    bio(4),
    bio(5),
    bio(6),
    bio(7),
    bio(8),
    bio(9),
    heading('zh4', 2, 'Appearance'),
    para(
      'za1',
      'Tall and narrow-shouldered, with the grey-gold fur of the eastern Qishen and a scar across one ear.',
    ),
    { id: 'zaimg1', kind: 'image', url: url(S.images[0]) },
    para('za2', 'Her face in profile: the scar, and the amber eyes the archive notes.'),
    { id: 'zaimg2', kind: 'image', url: url(S.images[1]) },
    para('za3', 'Her full height beside the archive door, for scale.'),
    { id: 'zaimg3', kind: 'image', url: url(S.images[2]) },
    para('za4', 'Her hands, ink-stained to the second knuckle.'),
    heading('zh5', 2, 'Personality'),
    para(
      'zq1',
      sentence(
        4,
        'Zahra is patient with ledgers and impatient with people, and she keeps every promise she writes down.',
      ),
    ),
    heading('zh5b', 2, 'Habits'),
    para('zq2', 'She counts her coins twice before sleeping, and never writes in red ink.'),
    heading('zh6', 2, 'Wardrobe'),
    para('zw1', 'She dresses for the road: a sand-coloured coat, a satchel of ledgers, and soft boots.'),
    { id: 'zwimg1', kind: 'image', url: url(S.images[3]) },
    para('zw2', 'The road coat, as she wears it on the caravan routes.'),
    { id: 'zwimg2', kind: 'image', url: url(S.images[4]) },
    para('zw3', 'The court robe she keeps for audiences with the Sultan.'),
    heading('zh7', 2, 'Zahra and Nadira al-Khalid'),
    {
      id: 'zr1',
      kind: 'paragraph',
      content: [
        { text: 'Zahra met ' },
        { mention: { resourceId: C.nadira } },
        {
          text: ` in the archive of Menkhet. ${sentence(
            8,
            'The two women traded ledgers for charters across twenty years, and each kept the other’s secrets long after the house fell.',
          )}`,
        },
      ],
    },
    para(
      'zr2',
      sentence(
        6,
        'Their quarrel over the burnt charter is the only time either of them broke a written promise.',
      ),
    ),
    heading('zh8', 2, 'Powers'),
    para('zw4', 'Zahra binds fire into ink: her ledgers burn anyone who forges an entry.'),
    {
      id: 'zw5',
      kind: 'paragraph',
      content: [
        { text: 'As ' },
        { mention: { resourceId: S.sorcery } },
        {
          text: ' requires of every practitioner, all sorcery is drawn through a focus stone, and the stone cracks when it is overdrawn.',
        },
      ],
    },
    para('zw6', 'Her focus stone is a cracked carnelian set in a ring she never removes.'),
    heading('zh9', 2, 'Source Boundaries'),
    para('zs1', 'This page holds everything recorded about Zahra al-Rashid.'),
    heading('zh10', 2, 'Unresolved Material'),
    para('zu1', 'Whether her fire-binding sorcery powers survive the eclipse.'),
    para('zu2', 'Whether her magic was taught or inborn.'),
    para('zu3', 'The colour of her ceremonial wardrobe at court.'),
    para('zu4', 'Which outfits she wore at the Sultan’s audiences.'),
    para('zu5', 'Her exact year of birth.'),
  ];
}

/** The Ostrand owner's body: two long, separable domains. */
export function statutesBody() {
  return [
    heading('sh1', 2, 'Purpose'),
    para('sp1', 'The reference for the statutes and the rites of Ostrand.'),
    heading('sh2', 2, 'Overview'),
    para('so1', 'Ostrand keeps its laws and its rites in one charter, read aloud at every assize.'),
    heading('sh3', 2, 'Law and Courts'),
    ...Array.from({ length: 6 }, (_, k) =>
      para(
        `sl${k + 1}`,
        sentence(
          12,
          'The assize courts of Ostrand hear every dispute in the open square, and a verdict is binding once three magistrates have sealed it.',
        ),
      ),
    ),
    heading('sh4', 2, 'Faith and Worship'),
    ...Array.from({ length: 6 }, (_, k) =>
      para(
        `sf${k + 1}`,
        sentence(
          12,
          'The temples of the Sun Rite open at dawn, and every household brings a measure of grain to the altar before the first bell.',
        ),
      ),
    ),
    heading('sh5', 2, 'Source Boundaries'),
    para('ss1', 'This page holds the charter as one text.'),
    heading('sh6', 2, 'Unresolved Material'),
    para('su1', 'Whether the assize may overrule a priest.'),
  ];
}

export async function splitWorld(o: Parameters<typeof appraisalWorld>[0] = {}): Promise<SplitWorld> {
  const w = await appraisalWorld({
    ...o,
    seed: (world) => {
      const r = world.repo;
      r.seed({
        id: S.zahra,
        name: '[BSRC] Zahra al-Rashid - Character Reference',
        parentId: C.qishen,
        referenceType: 'Compact Character Reference',
        canonical: 'Zahra al-Rashid',
        tags: ['CANON', 'Character', 'Qishen', 'Menkheti'],
      });
      r.seed({
        id: S.thin,
        name: '[BSRC] Thin Lamp - Character Reference',
        parentId: C.qishen,
        referenceType: 'Compact Character Reference',
        canonical: 'Thin Lamp',
        tags: ['CANON', 'Character', 'Qishen', 'Menkheti'],
      });
      r.seed({
        id: S.chronicle,
        name: '[BSRC] Nadira al-Khalid - Chronicle',
        parentId: C.nadiraIndex,
        referenceType: 'Character Biography',
        tags: ['CANON', 'Character', 'Biography'],
      });
      r.seed({
        id: S.sorcery,
        name: '[BSRC] Salahad Sorcery - Magic Reference',
        parentId: O.salahadMagic,
        referenceType: 'Magic Reference',
        tags: ['CANON', 'Magic'],
      });
      r.seed({
        id: S.statutes,
        name: '[BSRC] Ostrand Statutes and Rites - General Source',
        parentId: O.ostrand,
        referenceType: 'General Source',
        tags: ['CANON', 'Law'],
      });
      r.seed({
        id: S.ostrandPolity,
        name: '[BSRC] Ostrand - Polity Reference',
        parentId: O.ostrand,
        referenceType: 'Polity Reference',
        tags: ['CANON', 'Polity'],
      });
      r.seed({
        id: S.assizes,
        name: '[BSRC] Ostrand Assizes - Institution Reference',
        parentId: OSTRAND.Institutions,
        referenceType: 'Institution Reference',
        tags: ['CANON', 'Institution'],
      });
      r.seed({
        id: S.sunRite,
        name: '[BSRC] Ostrand Sun Rite - Religion Reference',
        parentId: OSTRAND.Religions,
        referenceType: 'Religion Reference',
        tags: ['CANON', 'Religion'],
      });
      o.seed?.(world);
    },
  });
  const r = w.repo;
  const sb = w.sidebars;
  const setBody = (id: string, blocks: unknown[]) => r.blocks.set(w.mainOf(id), { version: 1, blocks });
  const url = (id: string) => `https://assets.test:${w.port}/a/${id}.webp`;

  // ---------------------------------------------------------------------------------- the images Zahra's page shows
  w.assets.folder('Zahra al-Rashid', A.qishen, S.zahraFolder);
  const colours: [number, number, number][] = [
    [200, 160, 60],
    [190, 150, 50],
    [180, 140, 40],
    [120, 100, 80],
    [110, 90, 70],
  ];
  for (const [i, id] of S.images.entries()) {
    const [red, g, b] = colours[i]!;
    const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: red, g, b } } })
      .webp()
      .toBuffer();
    const aid = w.assets.image(`Zahra al-Rashid - Reference ${i + 1}`, S.zahraFolder, {
      id,
      width: 8,
      height: 4,
    });
    (w.assets.assets.get(aid) as unknown as Record<string, unknown>).url = url(aid);
    w.served.set(aid, bytes);
  }

  // ---------------------------------------------------------------------------------- sidebars
  const identity = (subject: string, more: Partial<Record<string, string>>) =>
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
              'Family / Surname': subject.split(' ').slice(1).join(' ') || 'Unestablished',
              'Naming Culture': 'Menkheti',
              Aliases: '',
              'Reference Type': 'Compact Character Reference',
              Scope: subject,
              'Race / Species': 'Qishen',
              'Life State': 'Alive at 5A 931',
              'Temporal Scope': '5A 880 - 5A 931',
              'Last Major Revision': '2026-11-01',
              Supersedes: 'None',
              ...more,
            } as Record<string, string>
          )[k] ?? '',
        ] as [string, string],
    );
  const page = (id: string, rows: [string, string][], deps: string[] = [], related: string[] = []) =>
    sb.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', rows),
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
  const owner = (subject: string, rt: string, scope: string): [string, string][] =>
    OWNER_KEYS.map((k) => [
      k,
      (
        {
          Status: 'Authoritative',
          'Continuity Type': 'CANON',
          Continuity: 'Main',
          Inheritance: 'None',
          Subject: subject,
          'Reference Type': rt,
          Scope: scope,
          'Temporal Scope': '4A 100 - 5A 931',
          'Last Major Revision': '2026-11-01',
          Supersedes: 'None',
        } as Record<string, string>
      )[k] ?? '',
    ]);
  page(
    S.zahra,
    identity('Zahra al-Rashid', {
      Scope: 'Zahra al-Rashid: identity, biography, appearance, personality, powers and wardrobe',
    }),
    [S.sorcery],
  );
  page(S.thin, identity('Thin Lamp', { Scope: 'Thin Lamp: identity' }));
  page(
    S.chronicle,
    owner('Nadira al-Khalid', 'Character Biography', 'Nadira al-Khalid: her life').filter(
      ([k]) => k !== 'Temporal Scope',
    ),
  );
  page(S.sorcery, owner('Salahad Sorcery', 'Magic Reference', 'Sorcery as practised across Salahad'));
  page(
    S.statutes,
    owner('Ostrand Statutes and Rites', 'General Source', 'The statutes and the rites of Ostrand'),
  );
  page(S.ostrandPolity, owner('Ostrand', 'Polity Reference', 'The polity of Ostrand'), [S.statutes]);
  page(S.assizes, owner('Ostrand Assizes', 'Institution Reference', 'The assize courts of Ostrand'), [
    S.statutes,
  ]);
  page(S.sunRite, owner('Ostrand Sun Rite', 'Religion Reference', 'The Sun Rite of Ostrand'));
  // Two pages depend on Zahra: Nadira's Biography and the Sultanate of Tarim.
  for (const id of [P.nadiraBio, O.tarim]) {
    const cur = sb.pages.get(id);
    const dp = cur?.props.find((p) => p.title === 'Dependencies');
    if (dp)
      dp.items = [...(dp.items ?? []), { id: `dz${id}`.slice(0, 8), resourceId: S.zahra, rank: 'r00000900' }];
    else
      page(
        id,
        owner(id === O.tarim ? 'Sultanate of Tarim' : 'Nadira al-Khalid', 'General Source', 'A page'),
        [S.zahra],
      );
  }

  // ---------------------------------------------------------------------------------- bodies
  setBody(S.zahra, zahraBody(url));
  setBody(S.thin, [
    heading('th1', 2, 'Purpose'),
    para('th2', 'The reference for Thin Lamp, a lamplighter of Menkhet.'),
    heading('th3', 2, 'Identity'),
    para('th4', 'A Qishen lamplighter.'),
    heading('th5', 2, 'Source Boundaries'),
    para('th6', 'Identity only.'),
    heading('th7', 2, 'Unresolved Material'),
    para('th8', 'None yet.'),
  ]);
  setBody(S.chronicle, [
    heading('nc1', 2, 'Purpose'),
    para('nc2', 'The long chronicle of Nadira al-Khalid’s life.'),
    heading('nc3', 2, 'Early Life'),
    ...Array.from({ length: 14 }, (_, k) =>
      para(
        `ncl${k + 1}`,
        sentence(
          10,
          'Nadira copied charters by lamplight in the lower archive, and every copy she made was checked twice by the elder scribes.',
        ),
      ),
    ),
  ]);
  setBody(S.sorcery, [
    heading('so1', 2, 'Purpose'),
    para('so2', 'The rule of sorcery as practised across Salahad.'),
    heading('so3', 2, 'The Focus Stone'),
    para('so4', 'All sorcery is drawn through a focus stone, and the stone cracks when it is overdrawn.'),
  ]);
  setBody(S.statutes, statutesBody());
  for (const [id, text] of [
    [S.ostrandPolity, 'The polity of Ostrand.'],
    [S.assizes, 'The assize courts of Ostrand.'],
  ] as const)
    setBody(id, [heading(`${id}h`, 2, 'Purpose'), para(`${id}p`, text)]);
  setBody(S.sunRite, [
    heading('rt1', 2, 'Purpose'),
    para('rt2', 'The Sun Rite of Ostrand.'),
    heading('rt3', 2, 'Observances'),
    para('rt4', 'Dawn offerings of grain.'),
    heading('rt5', 2, 'Source Boundaries'),
    para('rt6', 'This rite only.'),
    heading('rt7', 2, 'Unresolved Material'),
    para('rt8', 'None yet.'),
  ]);

  // A row of the Fourth Age chronology names Zahra (plain text).
  const fa = r.blocks.get(w.mainOf(P.fourthAge)) as { version: number; blocks: Record<string, unknown>[] };
  const table = fa.blocks.find((b) => b.id === 'fatab') as { children: unknown[] };
  table.children.push({
    id: 'farow3',
    kind: 'tableRow',
    children: [
      {
        id: 'fac30',
        kind: 'tableCell',
        children: [para('fac30p', 'Zahra al-Rashid burns the forged ledger')],
      },
      { id: 'fac31', kind: 'tableCell', children: [para('fac31p', 'Azah 3rd, 4A 902')] },
      { id: 'fac32', kind: 'tableCell', children: [para('fac32p', '1251209')] },
    ],
  });

  // The tree's summary of each page's sidebar (the Last Major Revision planner reads it there).
  const setSidebar = w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?');
  for (const id of [
    S.zahra,
    S.thin,
    S.chronicle,
    S.sorcery,
    S.statutes,
    S.ostrandPolity,
    S.assizes,
    S.sunRite,
    P.nadiraBio,
    O.tarim,
  ]) {
    const sbar = sb.pages.get(id);
    if (!sbar) continue;
    setSidebar.run(
      JSON.stringify(
        sbar.props.map((p) => ({
          id: p.id,
          kind: p.kind,
          title: p.title,
          ...(p.rows
            ? {
                rows: p.rows.map((x) => ({
                  key: x.key,
                  text: (x.content as { text?: string }[]).map((c) => c.text ?? '').join(''),
                })),
              }
            : {}),
        })),
      ),
      PROJECT,
      id,
    );
  }
  return w;
}
