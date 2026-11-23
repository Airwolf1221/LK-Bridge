/**
 * v3 F5b (ADR 0068): the narrative codes' world. F4c's narrative world (the REAL stack on the mock LegendKeeper, the
 * narrative layout as the live repository has it) with Repository Automation, and one story whose chapters carry each
 * mechanical narrative finding (the narrative audit's own fixture shapes, never fetched): a chapter without its
 * narrative tags, a chapter whose Chapter Number field disagrees with its name, a plan whose Chapter link is missing
 * while its chapter points at it, and a chapter whose first line is not its dateline.
 */
import { SidebarModel } from '../resources/world.js';
import { N, narrativeWorld, PROJECT, type NarrativeWorld } from '../narrative/world.js';
import { withAutomationGovernance, type AutomationWorld } from './world.js';

export { N, PROJECT };

export type NarrativeAutomationWorld = NarrativeWorld &
  Pick<AutomationWorld, 'governanceDoc' | 'governanceBlocks' | 'editAutomationPage'> & {
    readonly ids: Record<string, string>;
  };

export async function narrativeAutomationWorld(): Promise<NarrativeAutomationWorld> {
  const base = await narrativeWorld();
  const w = await withAutomationGovernance(base);
  const r = w.repo;
  const sb = w.sidebars;
  const ids: Record<string, string> = {};
  const seed = (key: string, name: string, parentId: string, tags: string[] = []) => {
    ids[key] = r.seed({ name, parentId, tags }).id;
    return ids[key];
  };
  const story = seed('story', '[INDEX] Tide Bell', N.main, ['Narrative', 'Story']);
  const map = seed('map', 'Story Map', story, ['Narrative', 'Story Map']);
  const act = seed('act', '[INDEX] Act 1 - Ebb', story, ['Narrative', 'Act']);
  const amap = seed('amap', 'Act 1 Map', map, ['Narrative', 'Act Map']);
  const c1 = seed('c1', 'Chapter 1 - Low Water', act, ['Narrative', 'Chapter']);
  const c2 = seed('c2', 'Chapter 2 - Slack', act); // no narrative tags
  const c3 = seed('c3', 'Chapter 3 - Flood', act, ['Narrative', 'Chapter']);
  const p1 = seed('p1', 'Chapter 1 Plan', amap, ['Narrative', 'Chapter Plan']);
  sb.page(map, [SidebarModel.kv('kvatmap1', 'PROPERTIES', [['Story Span', '4A 400 - 4A 401']])]);
  const rows = (n: string, date: string, more: [string, string][] = []) =>
    [
      ['Chapter Number', n],
      ['In-world Date', date],
      ['Continuity', 'Main CANON'],
      ['Act', 'Act 1 - Ebb'],
      ...more,
    ] as [string, string][];
  sb.page(c1, [
    SidebarModel.kv('kvatc101', 'PROPERTIES', rows('1', 'Camue 9th, 4A 400', [['Chapter Plan', '']])),
  ]);
  sb.page(c2, [
    SidebarModel.kv('kvatc201', 'PROPERTIES', rows('2', 'Camue 10th, 4A 400', [['Chapter Plan', '']])),
  ]);
  sb.page(c3, [
    SidebarModel.kv('kvatc301', 'PROPERTIES', rows('5', 'Camue 11th, 4A 400', [['Chapter Plan', '']])),
  ]);
  sb.page(p1, [
    SidebarModel.kv('kvatp101', 'PROPERTIES', [
      ['Chapter Number', '1'],
      ['Chapter', ''],
      ['Question Gate', 'Closed'],
      ['Planning Status', 'Drafted'],
    ]),
  ]);
  r.blocks.set(w.mainOf(c1), {
    version: 1,
    blocks: [
      { id: 'atc1b1', kind: 'paragraph', content: [{ text: 'Camue 9th, 4A 400' }] },
      { id: 'atc1b2', kind: 'paragraph', content: [{ text: 'The water fell away.' }] },
    ],
  });
  r.blocks.set(w.mainOf(c2), {
    version: 1,
    blocks: [
      { id: 'atc2b1', kind: 'paragraph', content: [{ text: 'Camue 10th, 4A 400' }] },
      { id: 'atc2b2', kind: 'paragraph', content: [{ text: 'Nothing moved.' }] },
    ],
  });
  r.blocks.set(w.mainOf(c3), {
    version: 1,
    blocks: [
      { id: 'atc3b1', kind: 'paragraph', content: [{ text: 'It rose.' }] },
      { id: 'atc3b2', kind: 'paragraph', content: [{ text: 'The bell rang twice.' }] },
    ],
  });
  w.rebuildTree();
  await w.snapshot();
  return Object.assign(w, { ids });
}
