/**
 * The test world of v3 F4a (ADR 0063): the appraisal world (the REAL server, runtime, MCP transport, policy and engine
 * against the mock LegendKeeper; Salahad, Races of Arkona, the characters of F3a, the Arkona pack attached and approved,
 * the Fourth Age chronology, the non-current areas) with fixtures shaped like the owner's repository check of 19 November
 * 2026, never fetched:
 *
 * - **governance**: Character Architecture calls the old bridge (`write_lk {"job_action":"guide"}`); a Repository
 *   Automation tab whose Startup section names Fiction Writing (the Design References page "Arkona – Fiction Writing
 *   Reference", tagged "Fiction Writing": it resolves), the Moonlit Ledger (nowhere), LK Bootstrap (a near miss for
 *   the root's "AI Bootstrap" tab) and the Tagging Standard (only part of the "Controlled Native Tagging Standard"
 *   tab's name: a near miss too), and whose Diagnostic Workflows name the skills by their old names; a Project
 *   Navigation tab;
 * - **names**: Tsubame Hoshizora (given name first, alias "The Silver Crane", Fujimatsuan) beside Kamigawa Miyuki and
 *   the discover world's Asagiri Miyabi (family name first), Éloïse Ferré (accents), the shared alias "Mehrana
 *   al-Khalid", an AU and a Working character, an Archived one; the Fujimatsuan culture owner under Arkonan Cultures,
 *   with a long naming section;
 * - **a nation with three owners**: Al-Tibr's Polity Reference, its Defensive Material (which depends on a Working page)
 *   and its Glass-Coast Customs (alias "Glass Coast", named by a Fourth Age row); a current page and a Legacy Canon
 *   Archive page that depend on the Polity Reference; a Working page that mentions it.
 *
 * Every fixture is in place before `snapshot()`, which takes a full snapshot and waits for the audit and the appraisal
 * index its hook starts.
 */
import { ROOT, buildModels } from '../discover/world.js';
import { SidebarModel } from '../resources/world.js';
import { P, appraisalWorld, type AppraisalWorld } from '../appraisal/world.js';
import { C, IDENTITY_KEYS } from './world.js';
import { O, OWNER_KEYS, PROJECT } from './owners-world.js';

export { C, O, P, PROJECT };

/** The fixture pages' ids. */
export const F = {
  tsubameIndex: 'tsubaidx',
  tsubame: 'tsubacor',
  eloise: 'eloiseref',
  fujimatsuan: 'fujicult',
  alTibrCustoms: 'altibcus',
  fictionWriting: 'fictwref',
} as const;

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, ...runs: Record<string, unknown>[]) => ({ id, kind: 'paragraph', content: runs });
const t = (text: string) => ({ text });
const code = (text: string) => ({ text, code: true });

export interface F4aWorld extends AppraisalWorld {
  /** The governance tabs this world adds to the AI REPOSITORY root, by key. */
  readonly tabs: { readonly automation: string; readonly navigation: string; readonly bootstrap: string };
  /** The LegendKeeper requests the mock has answered so far. */
  reads(): number;
}

export async function f4aWorld(o: Parameters<typeof appraisalWorld>[0] = {}): Promise<F4aWorld> {
  const w = await appraisalWorld({
    ...o,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: F.tsubameIndex, name: '[INDEX] Tsubame Hoshizora', parentId: C.humans });
      r.seed({
        id: F.tsubame,
        name: '[BSRC] Tsubame Hoshizora - Character Core',
        parentId: F.tsubameIndex,
        referenceType: 'Character Core',
        canonical: 'Tsubame Hoshizora',
        aliases: ['The Silver Crane'],
        tags: ['CANON', 'Character', 'Human', 'Fujimatsuan'],
      });
      r.seed({
        id: F.eloise,
        name: '[BSRC] Éloïse Ferré - Character Reference',
        parentId: C.humans,
        referenceType: 'Compact Character Reference',
        canonical: 'Éloïse Ferré',
        tags: ['CANON', 'Character', 'Human', 'Velaran'],
      });
      r.seed({
        id: F.fujimatsuan,
        name: '[BSRC] Fujimatsuan - Culture Reference',
        parentId: O.arkonanCultures,
        referenceType: 'Culture Reference',
        scope: 'The culture of Fujimatsu',
        tags: ['CANON', 'Culture'],
      });
      r.seed({
        id: F.alTibrCustoms,
        name: '[BSRC] Al-Tibr - Glass-Coast Customs',
        parentId: O.alTibr,
        referenceType: 'Culture Reference',
        scope: 'The customs of the Al-Tibr coast',
        aliases: ['Glass Coast'],
        tags: ['CANON', 'Culture'],
      });
      // The owner's Fiction Writing guidance, in the Design References (as Arkona has it: an en dash, and its tag).
      r.seed({
        id: F.fictionWriting,
        name: '[BSRC] Arkona – Fiction Writing Reference',
        parentId: P.design,
        tags: ['Fiction Writing'],
      });
      o.seed?.(world);
    },
  });
  const r = w.repo;
  const sb = w.sidebars;
  const setBody = (id: string, blocks: unknown[]) => r.blocks.set(w.mainOf(id), { version: 1, blocks });

  // ---------------------------------------------------------------------------------- the characters' identities
  const identity = (id: string, v: Partial<Record<string, string>>) =>
    sb.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const canon = {
    Status: 'Authoritative',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
  };
  identity(F.tsubame, {
    ...canon,
    Subject: 'Tsubame Hoshizora',
    'Canonical Display Name': 'Tsubame Hoshizora',
    'Personal / Given Name': 'Tsubame',
    'Family / Surname': 'Hoshizora',
    'Naming Culture': 'Fujimatsuan',
    Aliases: 'The Silver Crane',
    'Reference Type': 'Character Core',
    Scope: 'A crane-dancer of the court',
    'Race / Species': 'Human',
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 900 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  identity(F.eloise, {
    ...canon,
    Subject: 'Éloïse Ferré',
    'Canonical Display Name': 'Éloïse Ferré',
    'Personal / Given Name': 'Éloïse',
    'Family / Surname': 'Ferré',
    'Naming Culture': 'Velaran',
    'Reference Type': 'Compact Character Reference',
    Scope: 'A Velaran envoy',
    'Race / Species': 'Human',
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 920 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });

  // ---------------------------------------------------------------------------------- owners: a culture, a nation
  const owner = (
    id: string,
    subject: string,
    referenceType: string,
    scope: string,
    links: { deps?: string[]; related?: string[] } = {},
  ) =>
    sb.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        OWNER_KEYS.map(
          (k) =>
            [
              k,
              (
                {
                  ...canon,
                  Subject: subject,
                  'Reference Type': referenceType,
                  Scope: scope,
                  'Temporal Scope': '4A 100 - 5A 931',
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
        (links.deps ?? []).map((x) => ({ resourceId: x })),
      ),
      SidebarModel.links(
        `rl${id}`.slice(0, 8),
        'Related Sources',
        (links.related ?? []).map((x) => ({ resourceId: x })),
      ),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  owner(F.fujimatsuan, 'Fujimatsuan', 'Culture Reference', 'The culture of Fujimatsu');
  const naming =
    'A Fujimatsuan name is given family name first: the house name, then the personal name. Personal names are chosen at the first shrine visit and recorded in the house register. '.repeat(
      18,
    );
  setBody(F.fujimatsuan, [
    heading('fj1', 2, 'Purpose'),
    para('fj2', t('The reference for the Fujimatsuan culture.')),
    heading('fj3', 2, 'Naming Conventions'),
    para('fj4', t(naming)),
    heading('fj5', 3, 'Given Names'),
    para('fj6', t('Given names are two syllables, rarely three.')),
    heading('fj7', 2, 'Customs'),
    para('fj8', t('Tea at the turning of the tide.')),
    heading('fj9', 2, 'Source Boundaries'),
    para('fj10', t('This culture only.')),
    heading('fj11', 2, 'Unresolved Material'),
    para('fj12', t('The northern dialect’s names.')),
  ]);
  // Al-Tibr: three owners; its Defensive Material depends on a Working page.
  owner(O.alTibrReference, 'Al-Tibr', 'Polity Reference', 'The merchant sultanate of the glass coast', {
    deps: [O.salahadReference],
    related: [O.qasr, P.legacyPage],
  });
  owner(
    O.mercuryGlass,
    'Living Mercury-Glass',
    'Defensive Material Reference',
    'The living glass of Al-Tibr',
    {
      deps: [O.alTibrReference, C.draft],
    },
  );
  owner(F.alTibrCustoms, 'Al-Tibr', 'Culture Reference', 'The customs of the Al-Tibr coast');
  for (const [id, purpose] of [
    [O.alTibrReference, 'The reference for the Sultanate of Al-Tibr.'],
    [O.mercuryGlass, 'The living mercury-glass that guards Al-Tibr.'],
    [F.alTibrCustoms, 'The customs of the Al-Tibr coast.'],
  ] as const)
    setBody(id, [
      heading(`${id}h1`, 2, 'Purpose'),
      para(`${id}p1`, t(purpose)),
      heading(`${id}h2`, 2, 'Source Boundaries'),
      para(`${id}p2`, t(`Only ${purpose.toLowerCase()}`)),
      heading(`${id}h3`, 2, 'Unresolved Material'),
      para(`${id}p3`, t('The founding year is disputed.')),
    ]);
  // A current page and a Legacy Canon Archive page depend on Al-Tibr's Polity Reference.
  owner(P.apple, 'Apple Reach', 'Polity Reference', 'A coastal polity', {
    deps: [O.salahadReference, O.alTibrReference],
    related: [O.tarim],
  });
  owner(P.legacyPage, 'Old Tide Charter', 'General Source', 'The superseded tide charter', {
    deps: [O.alTibrReference],
  });
  // A Working page mentions it.
  setBody(C.draft, [
    heading('dr1', 2, 'Purpose'),
    para(
      'dr2',
      t('Draft notes on '),
      { mention: { resourceId: O.alTibrReference, text: 'Al-Tibr' } },
      t('.'),
    ),
  ]);
  // The Fourth Age names the customs by their alias. Its header row as LegendKeeper has it: table cells (the block model
  // has no header-cell kind), which the chronology's own reader requires.
  const fourth = r.blocks.get(w.mainOf(P.fourthAge))!;
  const table = (fourth.blocks as Record<string, unknown>[]).find((b) => b.kind === 'table')!;
  const header = (table.children as Record<string, unknown>[])[0]!;
  header.children = (header.children as Record<string, unknown>[]).map((c) => ({ ...c, kind: 'tableCell' }));
  (table.children as unknown[]).push({
    id: 'farow3',
    kind: 'tableRow',
    children: [
      {
        id: 'fac30',
        kind: 'tableCell',
        children: [para('fac30p', t('The Glass Coast seals the tide charter'))],
      },
      { id: 'fac31', kind: 'tableCell', children: [para('fac31p', t('Azah 3rd, 4A 902'))] },
      { id: 'fac32', kind: 'tableCell', children: [para('fac32p', t('1251209'))] },
    ],
  });
  // …and the polity in the possessive, the same day.
  (table.children as unknown[]).push({
    id: 'farow4',
    kind: 'tableRow',
    children: [
      {
        id: 'fac40',
        kind: 'tableCell',
        children: [para('fac40p', t('Al-Tibr’s fleet escorts the charter home'))],
      },
      { id: 'fac41', kind: 'tableCell', children: [para('fac41p', t('Azah 3rd, 4A 902'))] },
      { id: 'fac42', kind: 'tableCell', children: [para('fac42p', t('1251209'))] },
    ],
  });

  // ---------------------------------------------------------------------------------- governance (the root's tabs)
  const docs = w.governanceDocs;
  r.blocks.set(docs.architecture, {
    version: r.blocks.get(docs.architecture)!.version + 1,
    blocks: [
      heading('ca1', 1, 'Character Architecture'),
      heading('ca2', 2, 'Character Naming-Culture Verification & Identity Revision'),
      para('ca3', t('Before any intake, call '), code('write_lk {"job_action":"guide"}'), t(' and read it.')),
      heading('ca4', 2, 'Required Naming-Culture Question and Temporal Metadata Completion'),
      para('ca5', t('Ask the owner, then use '), code('arkona_create_character'), t('.')),
    ],
  });
  const tab = (name: string, blocks: unknown[]) => {
    const d = r.outside.addDocument(ROOT, name);
    r.blocks.set(d.id, { version: 1, blocks });
    return d.id;
  };
  const automation = tab('Repository Automation', [
    heading('ra1', 1, 'Repository Automation'),
    heading('ra2', 2, 'Startup and Current Evidence'),
    para('ra3', t('Read Project Navigation and the Controlled Native Tagging Standard.')),
    para('ra4', t('Read Fiction Writing before any prose task.')),
    para('ra4a', t('Read the Moonlit Ledger before a chronology task.')),
    para('ra4b', t('Then open LK Bootstrap.')),
    para('ra4c', t('Check the Tagging Standard before any retagging.')),
    heading('ra5', 2, 'Diagnostic Workflows'),
    para('ra6', t('Owners: run '), code('format-baisheng-owners'), t('.')),
    para('ra7', t('Impact: '), code('audit-baisheng-change-impact'), t('.')),
    para('ra8', t('Visuals: '), code('intake-baisheng-visuals'), t('.')),
    para('ra9', t('Stories: '), code('plan-baisheng-stories'), t('.')),
  ]);
  const navigation = tab('Project Navigation', [
    heading('pn1', 1, 'Project Navigation'),
    heading('pn2', 2, 'Startup'),
    para('pn3', t('Read Character Architecture, then Source Formatting.')),
    para('pn4', t('Use '), code('get_bridge_guide'), t(' first.')),
  ]);
  const bootstrap = tab('AI Bootstrap', [
    heading('ab1', 1, 'AI Bootstrap'),
    para('ab2', t('Start every session from the AI REPOSITORY root.')),
  ]);

  // ---------------------------------------------------------------------------------- the tree, then the pack again
  buildModels(w.stack, r, w.assets);
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
  // Character Architecture changed (its version moved on): the owner approves the pack again, as after any edit.
  await w.stack.runtime.packs.commands.approve('owner', 'arkona');
  return Object.assign(w, {
    tabs: { automation, navigation, bootstrap },
    reads: () => w.stack.mock.calls.length,
  });
}
