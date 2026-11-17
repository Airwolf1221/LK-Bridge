/**
 * The test world of the setting packs (v3 F3a, ADR 0050): the images world (the REAL server, runtime, MCP transport,
 * policy and engine; the mock LegendKeeper with the tree, sidebar and asset models; the storage and asset hosts) with
 * Arkona-shaped fixtures built from the shapes quoted in the owner-approved design, never fetched:
 *
 * - the AI templates with Arkona's sidebar rows in template order (AI Character Core and AI Compact Character Reference
 *   with the same seventeen rows; AI General Source, AI Character Art and AI Relationship with the general rows; the
 *   AI Index), each with a body; a template copy keeps its template's body under new block ids, as LegendKeeper's does
 *   (the AI Index's "Subpages" holds a collection block);
 * - Arkona-shaped characters: Mehrana I and Mehrana II al-Khalid (two people sharing the alias "Mehrana al-Khalid"),
 *   Nadira al-Khalid, Kamigawa Miyuki (a Compact Reference with no index), an Archived and an AU character, a Working
 *   character, the Sun Elves with their Core Information page;
 * - the three governance documents on the AI REPOSITORY page, and the Arkona pack attached to the test project with
 *   these templates, its governance pointed at those documents, and approved by the owner.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { imagesWorld, type ImagesWorld } from '../images/world.js';
import { LIFECYCLE, SidebarModel, T } from '../resources/world.js';
import { PROJECT, type ToolCall } from '../tools/helpers.js';

export { LIFECYCLE, T };

/** Arkona's identity rows, in the AI Character Core (and AI Compact Character Reference) template's order. */
export const IDENTITY_KEYS = [
  'Status',
  'Continuity Type',
  'Continuity',
  'Inheritance',
  'Subject',
  'Canonical Display Name',
  'Personal / Given Name',
  'Family / Surname',
  'Naming Culture',
  'Aliases',
  'Reference Type',
  'Scope',
  'Race / Species',
  'Life State',
  'Temporal Scope',
  'Last Major Revision',
  'Supersedes',
];
/** The general rows (AI General Source, AI Character Art, AI Relationship). */
export const GENERAL_KEYS = [
  'Status',
  'Continuity Type',
  'Continuity',
  'Inheritance',
  'Subject',
  'Reference Type',
  'Scope',
  'Last Major Revision',
  'Supersedes',
];

export const TPL = {
  index: T.index,
  core: T.core,
  compact: T.compact,
  general: T.general,
  art: 'tplart01',
  relationship: 'tplrel01',
} as const;

/** The fixture pages' ids. */
export const C = {
  qishen: 'qishen01',
  humans: 'humans01',
  elves: 'elves001',
  sunElves: 'sunelf01',
  sunCore: 'suncore1',
  unknown: 'unknown1',
  mehrana1Index: 'mehr1idx',
  mehrana1: 'mehr1cor',
  mehrana2Index: 'mehr2idx',
  mehrana2: 'mehr2cor',
  nadiraIndex: 'nadiridx',
  nadira: 'nadircor',
  miyuki: 'miyukref',
  archived: 'oldchar1',
  auIndex: 'auidx001',
  au: 'aucore01',
  workingIndex: 'wkidx001',
  working: 'wkcore01',
  draft: 'draftwk1',
} as const;

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

export interface PackWorld extends ImagesWorld {
  /** The governance documents' ids on the AI REPOSITORY page, by key. */
  readonly governanceDocs: Record<'architecture' | 'formatting' | 'tagging', string>;
  /** Changes a governance document as an outside edit (its version moves on). */
  editGovernance(key: 'architecture' | 'formatting' | 'tagging'): void;
  /** Calls a tool with the default (write-scope) connection. */
  call(name: string, args: Record<string, unknown>): Promise<ToolCall>;
}

type Rows = [string, string][];

function identityRows(v: Partial<Record<string, string>>): Rows {
  return IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]);
}

export async function packWorld(
  o: Parameters<typeof imagesWorld>[0] & {
    readonly approve?: boolean;
    /** v3 F3b: false leaves out Mehrana I and II's shared alias (the evaluation scenarios' world has one Mehrana). */
    readonly mehranaAlias?: boolean;
    /**
     * v3 F3.4 (ADR 0055 decision D): `propose` (the default) switches every write tool to "always propose", as every
     * package and every appraisal fix was before F3.4, so the earlier tests keep testing the proposal path; `seed` keeps
     * the seed's switches (adding art and an appraisal fix follow the agent's scope).
     */
    readonly toolModes?: 'propose' | 'seed';
  } = {},
): Promise<PackWorld> {
  // As the chronology tests do, this world's per-minute limits are raised: its files make many calls in a minute.
  const w = (await imagesWorld({
    ...o,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }), ...(o.env ?? {}) },
    limits: { 'key-min': 5000, 'write-min': 2000, ...(o.limits ?? {}) },
    seed: (world) => {
      const r = world.repo;
      const page = (
        id: string,
        name: string,
        parentId: string,
        more: Parameters<typeof r.seed>[0] extends infer X ? Partial<X> : never = {},
      ) => r.seed({ id, name, parentId, ...more });
      page(C.sunElves, '[INDEX] Sun Elves', C.elves);
      page(C.sunCore, '[BSRC] Sun Elves - Core Information', C.sunElves, { referenceType: 'General Source' });
      page(C.mehrana1Index, '[INDEX] Mehrana I al-Khalid', C.qishen);
      const shared = o.mehranaAlias === false ? [] : ['Mehrana al-Khalid'];
      page(C.mehrana1, '[BSRC] Mehrana I al-Khalid - Character Core', C.mehrana1Index, {
        referenceType: 'Character Core',
        aliases: shared,
        canonical: 'Mehrana I al-Khalid',
        tags: ['CANON', 'Character', 'Qishen'],
      });
      page(C.mehrana2Index, '[INDEX] Mehrana II al-Khalid', C.qishen);
      page(C.mehrana2, '[BSRC] Mehrana II al-Khalid - Character Core', C.mehrana2Index, {
        referenceType: 'Character Core',
        aliases: shared,
        canonical: 'Mehrana II al-Khalid',
        tags: ['CANON', 'Character', 'Qishen'],
      });
      page(C.nadiraIndex, '[INDEX] Nadira al-Khalid', C.qishen);
      page(C.nadira, '[BSRC] Nadira al-Khalid - Character Core', C.nadiraIndex, {
        referenceType: 'Character Core',
        canonical: 'Nadira al-Khalid',
        tags: ['CANON', 'Character', 'Qishen'],
      });
      page(C.miyuki, '[BSRC] Kamigawa Miyuki - Character Reference', C.humans, {
        referenceType: 'Compact Character Reference',
        canonical: 'Kamigawa Miyuki',
        scope: 'Shrine archivist of Fujimatsu',
        tags: ['CANON', 'Character', 'Human', 'Fujimatsuan'],
      });
      page(C.archived, '[BARC] Seren Vale - Character Core', LIFECYCLE.archived, {
        referenceType: 'Character Core',
        canonical: 'Seren Vale',
        tags: ['Archived', 'Character'],
      });
      page(C.auIndex, '[INDEX] Kaito of the Shattered Sky', C.humans);
      page(C.au, '[BSRC] Kaito of the Shattered Sky - Character Core', C.auIndex, {
        referenceType: 'Character Core',
        canonical: 'Kaito of the Shattered Sky',
        tags: ['CANON', 'Character', 'Human'],
      });
      page(C.workingIndex, '[INDEX] Tamsin Reed', LIFECYCLE.working);
      page(C.working, '[BWRK] Tamsin Reed - Character Core', C.workingIndex, {
        referenceType: 'Character Core',
        canonical: 'Tamsin Reed',
        tags: ['Working', 'Character', 'Human'],
      });
      page(C.draft, '[BWRK] Draft Notes', LIFECYCLE.working, { referenceType: 'General Source' });
      for (const [id, race] of [
        [C.mehrana1, 'Qishen'],
        [C.mehrana2, 'Qishen'],
        [C.nadira, 'Qishen'],
        [C.miyuki, 'Human'],
        [C.au, 'Human'],
        [C.working, 'Human'],
      ] as const)
        r.outside.setRow(id, 'Race / Species', race);
      // Kamigawa Miyuki's Reference holds a biography section (the upgrade's overlap warning).
      const miyukiMain = r.liveDocs(r.live(C.miyuki)!).find((d) => d.name === 'Main')!;
      r.blocks.set(miyukiMain.id, {
        version: 2,
        blocks: [
          heading('my1', 2, 'Purpose'),
          para('my2', 'The compact reference for Kamigawa Miyuki.'),
          heading('my3', 2, 'Biography'),
          para('my4', 'Born at the shrine.'),
          heading('my5', 2, 'Source Boundaries'),
          para('my6', 'Identity only.'),
        ],
      });
      // Nadira's and Mehrana I's indexes have routing sections.
      for (const [idx, core, name] of [
        [C.nadiraIndex, C.nadira, 'Nadira al-Khalid'],
        [C.mehrana1Index, C.mehrana1, 'Mehrana I al-Khalid'],
      ] as const) {
        const d = r.liveDocs(r.live(idx)!).find((x) => x.name === 'Main')!;
        r.blocks.set(d.id, {
          version: 1,
          blocks: [
            heading(`${idx}h1`, 2, 'Purpose'),
            para(`${idx}p1`, `Routes to ${name}'s sources.`),
            heading(`${idx}h2`, 2, 'How to Use This Index'),
            {
              id: `${idx}l1`,
              kind: 'bulletList',
              children: [
                {
                  id: `${idx}i1`,
                  kind: 'listItem',
                  children: [
                    {
                      id: `${idx}i1p`,
                      kind: 'paragraph',
                      content: [{ mention: { resourceId: core, text: `${name} - Character Core` } }],
                    },
                  ],
                },
              ],
            },
            heading(`${idx}h3`, 2, 'Index Boundaries'),
            para(`${idx}p3`, 'Routing only.'),
          ],
        });
      }
      // The templates (outside the root) beside the resources world's.
      r.seed({ id: TPL.art, name: '[BSRC] AI Character Art', parentId: null, props: false });
      r.seed({ id: TPL.relationship, name: '[BSRC] AI Relationship', parentId: null, props: false });
      o.seed?.(world);
    },
  })) as PackWorld;

  // ---------------------------------------------------------------------------------- templates: sidebars and bodies
  const sb = w.sidebars;
  const blank = (keys: string[]) => keys.map((k) => [k, ''] as [string, string]);
  const contentSidebar = (prefix: string, keys: string[]) => [
    SidebarModel.kv(`kv${prefix}`, 'PROPERTIES', blank(keys)),
    SidebarModel.links(`dp${prefix}`, 'Dependencies', []),
    SidebarModel.links(`rl${prefix}`, 'Related Sources', []),
    { id: `tg${prefix}`, kind: 'unsupported' as const, title: 'TAGS' },
  ];
  sb.page(TPL.core, contentSidebar('tcore', IDENTITY_KEYS));
  sb.page(TPL.compact, contentSidebar('tcomp', IDENTITY_KEYS));
  sb.page(TPL.general, contentSidebar('tgen0', GENERAL_KEYS));
  sb.page(TPL.art, contentSidebar('tart0', GENERAL_KEYS));
  sb.page(TPL.relationship, contentSidebar('trel0', GENERAL_KEYS));
  sb.page(TPL.index, [SidebarModel.kv('kvtplidx', 'PROPERTIES', blank(['Reference Type', 'Index Scope']))]);
  const mainOf = (id: string) => w.repo.liveDocs(w.repo.live(id)!).find((d) => d.name === 'Main')!;
  w.repo.blocks.set(mainOf(TPL.index).id, {
    version: 1,
    blocks: [
      heading('ti1', 2, 'Purpose'),
      para('ti2', 'Say what this index routes to.'),
      heading('ti3', 2, 'How to Use This Index'),
      para('ti4', 'One line per page.'),
      heading('ti5', 2, 'Subpages'),
      { id: 'ticoll', kind: 'resourceCollection', items: [] },
      heading('ti6', 2, 'Index Boundaries'),
      para('ti7', 'Say what this index does not hold.'),
    ],
  });
  for (const t of [TPL.core, TPL.compact, TPL.general, TPL.art, TPL.relationship]) {
    w.repo.blocks.set(mainOf(t).id, {
      version: 1,
      blocks: [heading(`${t}h`, 2, 'Purpose'), para(`${t}p`, 'Template guidance: replace this text.')],
    });
  }
  // The templates the registry knows (its last read of listTemplates).
  const templates = [
    { id: T.index, name: '[INDEX] AI Index Template' },
    { id: T.core, name: '[BSRC] AI Character Core Template' },
    { id: T.compact, name: '[BSRC] AI Compact Character Reference Template' },
    { id: T.general, name: '[BSRC] AI General Source Template' },
    { id: T.note, name: '[BSRC] AI Note Template' },
    { id: TPL.art, name: '[BSRC] AI Character Art Template' },
    { id: TPL.relationship, name: '[BSRC] AI Relationship Template' },
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
  const reg = w.stack.runtime.registry.forProject(PROJECT);
  await reg.commands.refreshTemplates('owner');

  // A template copy keeps the template's body (LegendKeeper: "documents with their content, under new ids").
  const fromTemplate = [...w.overrides.entries()].find(([re]) => re.source.includes('from-template'));
  if (fromTemplate) {
    const [re, inner] = fromTemplate;
    let n = 0;
    w.overrides.set(re, (req: MockRequest): MockResponse | undefined => {
      const r = inner(req);
      if (!r || r.status !== 201) return r;
      const body = req.body as { templateId: string };
      const copyId = (r.body as { id: string }).id;
      const tdoc = mainOf(body.templateId);
      const t = w.repo.blocks.get(tdoc.id);
      if (t) {
        const fresh = (b: Record<string, unknown>): Record<string, unknown> => ({
          ...structuredClone(b),
          id: `cp${(++n).toString(36).padStart(6, '0')}`,
          ...(Array.isArray(b.children)
            ? { children: (b.children as Record<string, unknown>[]).map(fresh) }
            : {}),
        });
        w.repo.blocks.set(mainOf(copyId).id, {
          version: 1,
          blocks: (t.blocks as Record<string, unknown>[]).map(fresh),
        });
      }
      return r;
    });
  }

  // ---------------------------------------------------------------------------------- the fixtures' sidebars
  const props = (id: string, v: Partial<Record<string, string>>, related: { resourceId: string }[] = []) =>
    sb.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', identityRows(v)),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', related),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const canon = {
    Status: 'Authoritative',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
  };
  props(C.mehrana1, {
    ...canon,
    Subject: 'Mehrana I al-Khalid',
    'Canonical Display Name': 'Mehrana I al-Khalid',
    'Personal / Given Name': 'Mehrana',
    'Family / Surname': 'al-Khalid',
    // Existing gate debt: Naming Culture is blank.
    Aliases: 'Mehrana al-Khalid',
    'Reference Type': 'Character Core',
    Scope: 'Founder of the house',
    'Race / Species': 'Qishen',
    'Life State': 'Deceased',
    'Temporal Scope': '4A 100 - 4A 220',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  props(C.mehrana2, {
    ...canon,
    Subject: 'Mehrana II al-Khalid',
    'Canonical Display Name': 'Mehrana II al-Khalid',
    'Personal / Given Name': 'Mehrana',
    'Family / Surname': 'al-Khalid',
    'Naming Culture': 'Menkheti',
    Aliases: 'Mehrana al-Khalid',
    'Reference Type': 'Character Core',
    Scope: 'Heir of the house',
    'Race / Species': 'Qishen',
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 900 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  props(C.nadira, {
    ...canon,
    Subject: 'Nadira al-Khalid',
    'Canonical Display Name': 'Nadira al-Khalid',
    'Personal / Given Name': 'Nadira',
    'Family / Surname': 'al-Khalid',
    'Naming Culture': 'Menkheti',
    'Reference Type': 'Character Core',
    Scope: 'Archivist',
    'Race / Species': 'Qishen',
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 880 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  props(C.miyuki, {
    ...canon,
    Subject: 'Kamigawa Miyuki',
    'Canonical Display Name': 'Kamigawa Miyuki',
    'Personal / Given Name': 'Miyuki',
    'Family / Surname': 'Kamigawa',
    'Naming Culture': 'Fujimatsuan',
    'Reference Type': 'Compact Character Reference',
    Scope: 'Shrine archivist of Fujimatsu',
    'Race / Species': 'Human',
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 910 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  props(C.archived, {
    Status: 'Archived',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Subject: 'Seren Vale',
    'Reference Type': 'Character Core',
  });
  props(C.au, {
    Status: 'Authoritative',
    'Continuity Type': 'AU',
    Continuity: 'Shattered Sky',
    Inheritance: 'None',
    Subject: 'Kaito of the Shattered Sky',
    'Canonical Display Name': 'Kaito of the Shattered Sky',
    'Personal / Given Name': 'Kaito',
    'Family / Surname': 'Unestablished',
    'Naming Culture': 'Fujimatsuan',
    'Reference Type': 'Character Core',
    Scope: 'A sky-sailor of the alternate continuity',
    'Race / Species': 'Human',
    'Life State': 'Alive',
    'Temporal Scope': '5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  props(C.working, {
    Status: 'Working',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
    Subject: 'Tamsin Reed',
    'Canonical Display Name': 'Tamsin Reed',
    'Personal / Given Name': 'Tamsin',
    'Family / Surname': 'Reed',
    'Naming Culture': 'Velaran',
    'Reference Type': 'Character Core',
    Scope: 'A courier',
    'Race / Species': 'Human',
    'Life State': 'Alive',
    'Temporal Scope': '5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });

  // ---------------------------------------------------------------------------------- governance and the pack
  const docOf = (name: string, text: string) => {
    const d = w.repo.outside.addDocument(ROOT, name);
    w.repo.blocks.set(d.id, { version: 1, blocks: [heading(`${d.id}h`, 1, name), para(`${d.id}p`, text)] });
    return d.id;
  };
  const governanceDocs = {
    architecture: docOf('Character Architecture', 'Start compact; split deliberately.'),
    formatting: docOf('Source Formatting', 'Purpose first; no em dashes.'),
    tagging: docOf('Controlled Native Tagging Standard', 'v1.8: the closed grammar.'),
  };
  const packs = w.stack.runtime.packs;
  packs.ensureSeeded();
  if (o.toolModes !== 'seed')
    packs.commands.setToolModes('owner', 'arkona', {
      arkona_add_character_art: 'propose',
      arkona_appraisal_fix: 'propose',
    });
  packs.store.setGovernance('arkona', [
    {
      key: 'character-architecture',
      project: 'test',
      resourceId: ROOT,
      documentId: governanceDocs.architecture,
      name: 'Character Architecture',
    },
    {
      key: 'source-formatting',
      project: 'test',
      resourceId: ROOT,
      documentId: governanceDocs.formatting,
      name: 'Source Formatting',
    },
    {
      key: 'tagging-standard',
      project: 'test',
      resourceId: ROOT,
      documentId: governanceDocs.tagging,
      name: 'Controlled Native Tagging Standard',
      label: 'v1.8',
    },
  ]);
  packs.commands.attach('owner', 'arkona', PROJECT, {
    index: TPL.index,
    core: TPL.core,
    compact: TPL.compact,
    general: TPL.general,
    art: TPL.art,
    relationship: TPL.relationship,
  });
  if (o.approve !== false) await packs.commands.approve('owner', 'arkona');
  const client = await w.stack.connect();
  return Object.assign(w, {
    governanceDocs,
    editGovernance(k: 'architecture' | 'formatting' | 'tagging') {
      const b = w.repo.blocks.get(governanceDocs[k])!;
      b.version++;
      b.blocks = [...b.blocks, para(`${governanceDocs[k]}x${b.version}`, 'Amended.')];
    },
    call: (name: string, args: Record<string, unknown>) => w.stack.call(client, name, args),
  });
}

/** As the owner does: approve a proposal (accepting it as canon when it is canonical), then wait for its job. */
export async function approve(
  w: PackWorld,
  proposalId: string,
): Promise<{
  state: string;
  jobId: string | null;
  job: ReturnType<PackWorld['stack']['runtime']['engine']['queries']['getJob']>;
}> {
  const policy = w.stack.runtime.policy;
  const p0 = policy.proposals.get(proposalId)!;
  if (p0.requiresCanonicalApproval) await policy.commands.approveAsCanon('owner', proposalId);
  else await policy.commands.approve('owner', proposalId);
  for (let i = 0; i < 500; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (['executed', 'failed', 'conflicted'].includes(p.state)) {
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      return { state: p.state, jobId: p.jobId, job };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not finish');
}

/** A compact background character's package (scenario 1). */
export function compactPackage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Asagiri Ren',
    depth: 'compact',
    identity: {
      givenName: 'Ren',
      surname: 'Asagiri',
      race: 'Foxian',
      namingCulture: 'Fujimatsuan',
      lifeState: 'Alive at 5A 931',
      temporalScope: '5A 900 - 5A 931',
    },
    pages: [
      {
        role: 'compact',
        scope: 'Shrine guard of the Hollow Court',
        markdown:
          '## Purpose\n\nThe compact reference for Asagiri Ren, a shrine guard.\n\n## Identity\n\nA Foxian guard of the Hollow Court shrine.\n\n## Source Boundaries\n\nIdentity and role only.\n\n## Unresolved Material\n\nNone yet.\n',
      },
    ],
    project: 'test',
    ...over,
  };
}
