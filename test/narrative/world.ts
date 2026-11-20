/**
 * The test world of v3 F4c (ADR 0065; design docs/design/F4c-fiction.md): F4b's world (the REAL server, runtime, MCP
 * transport, policy and engine against the mock LegendKeeper; the Arkona pack attached and approved; the calendar; dated
 * characters: Rashad al-Khalid born Camue 44th, 4A 360; Harun al-Saffar born 4A 300, deceased Camue 3rd, 4A 400; Kamigawa
 * Haru attested 5A 411–5A 931) with the narrative layout as the live repository has it (20 November 2026), never fetched:
 *
 * - **Narratives** and **Continuities** (indexes found by name), Continuities holding one AU, **Moonfall**;
 * - **Main CANON** under Narratives (unless `main: false`), and no Moonfall index yet (E4's finding);
 * - **the four narrative templates**, outside the AI REPOSITORY, found by name: the Story Map and Act Map with the generic
 *   Working sidebar; the Chapter Plan with the design's suggested sidebar (E3) and the Workflow's headings as its body;
 *   the Chapter with its sidebar as made (placeholder text in its fields, a `Working` tag the owner is removing) and an
 *   empty body.
 */
import { SidebarModel } from '../resources/world.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { f4bWorld, K, ownerClient, PROJECT, type F4bWorld } from '../consistency/world.js';

export { K, PROJECT, ownerClient };

export const N = {
  narratives: 'narrati1',
  continuities: 'contnts1',
  moonfall: 'moondef1',
  main: 'maincan1',
} as const;

export const NT = {
  storyMap: 'tplnsm01',
  actMap: 'tplnam01',
  plan: 'tplncp01',
  chapter: 'tplnch01',
} as const;

export const WORKING_SIDEBAR = [
  'Status',
  'Continuity Type',
  'Continuity',
  'Inheritance',
  'Subject',
  'Working Type',
  'Scope',
  'Supersedes',
  'Intended Destination',
];
export const PLAN_SIDEBAR = [
  'Story',
  'Act',
  'Chapter Number',
  'Chapter',
  'Planned Date',
  'POV',
  'Question Gate',
  'Planning Status',
  'Continuity Type',
  'Continuity',
  'Inheritance',
  'Subject',
];
export const CHAPTER_SIDEBAR: [string, string][] = [
  ['Story', 'Link to the story'],
  ['Act', 'Link to the act'],
  ['Chapter Number', ''],
  ['In-world Date', 'Exact or an approximate range'],
  ['Continuity', ''],
  ['POV', 'Link to the POV character'],
  ['Chapter Plan', 'Link to the Chapter Plan'],
  ['Draft Status', ''],
  ['Last Major Revision', ''],
];

const heading = (id: string, text: string) => ({ id, kind: 'heading', level: 2, content: [{ text }] });

export interface NarrativeWorld extends F4bWorld {
  /** Sets the Chapter Plan template's sidebar (to try a template without the Question Gate field). */
  setPlanTemplate(keys: readonly string[]): void;
  /** The tool's answer for a write-scope call (the default token). */
  tool(name: string, args: Record<string, unknown>): Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function narrativeWorld(o: { readonly main?: boolean } = {}): Promise<NarrativeWorld> {
  const w = await f4bWorld({
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: N.narratives, name: '[INDEX] Narratives', parentId: ROOT });
      r.seed({ id: N.continuities, name: '[INDEX] Continuities', parentId: ROOT });
      r.seed({ id: N.moonfall, name: '[BSRC] Moonfall', parentId: N.continuities, tags: ['AU'] });
      if (o.main !== false)
        r.seed({ id: N.main, name: '[INDEX] Main CANON', parentId: N.narratives, tags: ['Narrative'] });
      const tpl = (id: string, name: string, tags: string[] = []) =>
        r.seed({ id, name, parentId: null, props: false, tags });
      tpl(NT.storyMap, '[BSRC] AI Narrative Story Map', ['Working']);
      tpl(NT.actMap, '[BSRC] AI Narrative Act Map', ['Working']);
      tpl(NT.plan, '[BSRC] AI Narrative Chapter Plan', ['Working']);
      tpl(NT.chapter, '[BSRC] AI Narrative Chapter', ['Working']);
    },
  });
  const sb = w.sidebars;
  const blank = (keys: readonly string[]) => keys.map((k) => [k, ''] as [string, string]);
  sb.page(NT.storyMap, [
    SidebarModel.kv('kvnsm001', 'PROPERTIES', [['Status', 'Working'], ...blank(WORKING_SIDEBAR.slice(1))]),
    SidebarModel.links('depnsm01', 'Dependencies', []),
  ]);
  sb.page(NT.actMap, [
    SidebarModel.kv('kvnam001', 'PROPERTIES', [['Status', 'Working'], ...blank(WORKING_SIDEBAR.slice(1))]),
    SidebarModel.links('depnam01', 'Dependencies', []),
  ]);
  const setPlanTemplate = (keys: readonly string[]) =>
    sb.page(NT.plan, [SidebarModel.kv('kvncp001', 'PROPERTIES', blank(keys))]);
  setPlanTemplate(PLAN_SIDEBAR);
  sb.page(NT.chapter, [
    SidebarModel.kv('kvnch001', 'PROPERTIES', CHAPTER_SIDEBAR),
    SidebarModel.links('chpnch01', 'Characters Present', []),
    SidebarModel.links('locnch01', 'Locations', []),
  ]);
  // The plan template's body: the Workflow's chapter-plan headings.
  w.repo.blocks.set(w.mainOf(NT.plan), {
    version: 1,
    blocks: [
      heading('cph1', 'Chapter Purpose'),
      heading('cph2', 'Canon Constraints'),
      heading('cph3', 'Questions'),
      heading('cph4', 'Closing State'),
      heading('cph5', 'Post-Draft Reassessment'),
      heading('cph6', 'Source Boundaries'),
    ],
  });
  w.repo.blocks.set(w.mainOf(NT.chapter), { version: 1, blocks: [] });
  // The templates the registry knows: the world's, and the four narrative ones.
  const listed = [...w.overrides.entries()].find(([re]) => re.source === '\\/templates$');
  const inner = listed?.[1];
  for (const re of [...w.overrides.keys()]) if (re.source === '\\/templates$') w.overrides.delete(re);
  const extra = [
    { id: NT.storyMap, name: '[BSRC] AI Narrative Story Map', parentId: 'templates' },
    { id: NT.actMap, name: '[BSRC] AI Narrative Act Map', parentId: 'templates' },
    { id: NT.plan, name: '[BSRC] AI Narrative Chapter Plan', parentId: 'templates' },
    { id: NT.chapter, name: '[BSRC] AI Narrative Chapter', parentId: 'templates' },
  ];
  w.overrides.set(/\/templates$/, (req: MockRequest): MockResponse | undefined => {
    const r = inner?.(req);
    if (!r || req.method !== 'GET') return r;
    const body = r.body as { data: unknown[] };
    return { ...r, body: { ...body, data: [...body.data, ...extra] } };
  });
  await w.stack.runtime.registry.forProject(PROJECT).commands.refreshTemplates('owner');
  // Pages the tools make without a template (the indexes) get an empty sidebar, as LegendKeeper gives them.
  sb.adoptNewPages = (id) => w.repo.live(id) !== undefined;
  w.rebuildTree();
  const client = await w.stack.connect();
  return Object.assign(w, {
    setPlanTemplate,
    tool: async (name: string, args: Record<string, unknown>) =>
      (await w.stack.call(client, name, args)).body,
  });
}
