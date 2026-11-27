/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return -- tool results and the mock's state are JSON */
/**
 * R4.1 (ADR 0066 amendment 1), end to end on the mock with the templates' real default values (the Chapter template's
 * placeholder texts, `CHAPTER_SIDEBAR`): replacing a field value identical to the page's template default is a first fill,
 * not a change of an existing value; a real existing value is still protected. The page's template: the save's own copy
 * (narrative-f4c N3), or a narrative page's kind (a chapter made in the app); never the tree's record of an older copy. This
 * must not reopen R4-01 (canon moved into Narratives): a page whose Continuity differs from its template default still
 * proposes, inside Narratives or out, and a canon page moved into a story is still the owner's canonical decision (v3
 * F12, ADR 0081: at scope propose; at scope write both are the agent's direct writes, on the owner's Review page).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SidebarModel } from '../resources/world.js';
import { O } from '../packs/f4a-world.js';
import { CHAPTER_SIDEBAR, N, narrativeWorld, NT, PROJECT, type NarrativeWorld } from './world.js';

let w: NarrativeWorld;
/**
 * v3 F12 (ADR 0081): an agent at scope propose. At scope write a protected value's change is the agent's direct write
 * (on the owner's Review page); the protection itself (a canonical proposal, its reason) is seen at scope propose.
 */
let proposeTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
const STORY = 'Placeholder Tides';
const PLACEHOLDER = Object.fromEntries(CHAPTER_SIDEBAR).Continuity!;
const ids = {
  story: '',
  appChapter: 'r41appch',
  ownChapter: 'r41ownch',
  copied: 'r41copy1',
  copiedReal: 'r41copy2',
  coreTpl: 'r41coret',
  stranger: 'r41strng',
  canon: 'r41canon',
  working: 'r41work1',
  workingTpl: 'r41wktpl',
};

const kids = (id: string) => w.repo.children(id);
const facts = (id: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of w.sidebars.pages.get(id)?.props ?? [])
    if (p.kind === 'keyValue')
      for (const r of p.rows ?? [])
        out[r.key] = (r.content as any[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  return out;
};
const chapterRows = (over: Record<string, string>): [string, string][] =>
  CHAPTER_SIDEBAR.map(([k, v]) => [k, over[k] ?? v]);
const proposalsNow = () => w.stack.runtime.policy.proposals.list({ project: PROJECT }).length;

beforeAll(async () => {
  w = await narrativeWorld();
  const proposing = await w.stack.connect(w.stack.newToken('r41-proposer', 'propose').token);
  proposeTool = async (name, args) => (await w.stack.call(proposing, name, args)).body;
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: STORY })).status).toBe(
    'written',
  );
  ids.story = kids(N.main).find((r) => r.name === `[INDEX] ${STORY}`)!.id;
  const r = w.repo;
  // Chapters made in the app from the Chapter template (the bridge never copied them): its placeholder left in one, a
  // real (other) continuity in the other.
  r.seed({
    id: ids.appChapter,
    name: 'Chapter 7 - Made in the App',
    parentId: ids.story,
    tags: ['Narrative', 'Chapter'],
  });
  w.sidebars.page(ids.appChapter, [SidebarModel.kv('kvr41ap1', 'PROPERTIES', chapterRows({}))]);
  r.seed({
    id: ids.ownChapter,
    name: 'Chapter 8 - Its Own Continuity',
    parentId: ids.story,
    tags: ['Narrative', 'Chapter'],
  });
  w.sidebars.page(ids.ownChapter, [
    SidebarModel.kv('kvr41ow1', 'PROPERTIES', chapterRows({ Continuity: 'Moonfall' })),
  ]);
  // Outside Narratives: pages the bridge copied in an earlier job (the tree records it), one from the Chapter template
  // still holding its placeholder, one from a Core-like template whose default is a REAL value (Continuity "Main", as
  // Arkona's fixed facts) holding that value; and a page holding the placeholder's text whose template no one can tell.
  r.seed({ id: ids.coreTpl, name: '[BSRC] Core-like Template', parentId: null, props: false });
  w.sidebars.page(ids.coreTpl, [
    SidebarModel.kv('kvr41ct1', 'PROPERTIES', [
      ['Continuity Type', 'CANON'],
      ['Continuity', 'Main'],
    ]),
  ]);
  for (const [id, cont] of [
    [ids.copied, PLACEHOLDER],
    [ids.copiedReal, 'Main'],
    [ids.stranger, PLACEHOLDER],
  ] as const) {
    r.seed({ id, name: `Template Copy ${id}`, parentId: O.salahadPolities });
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', chapterRows({ Continuity: cont })),
    ]);
  }
  // A canon page (R4-01's subject).
  r.seed({
    id: ids.canon,
    name: '[BSRC] Tidewater Compact - Polity Reference',
    parentId: O.salahadPolities,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.sidebars.page(ids.canon, [
    SidebarModel.kv('kvr41cn1', 'PROPERTIES', [
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Continuity', 'Main'],
    ]),
  ]);
  // The lifecycle: a page copied from a template whose Status default IS a lifecycle state (Working).
  r.seed({ id: ids.workingTpl, name: '[BSRC] Working Note Template', parentId: null, props: false });
  w.sidebars.page(ids.workingTpl, [SidebarModel.kv('kvr41wt1', 'PROPERTIES', [['Status', 'Working']])]);
  r.seed({ id: ids.working, name: 'Working Note', parentId: O.salahadPolities });
  w.sidebars.page(ids.working, [SidebarModel.kv('kvr41wk1', 'PROPERTIES', [['Status', 'Working']])]);
  w.rebuildTree();
  const tree = w.stack.runtime.tree.store;
  tree.setTemplate(PROJECT, ids.copied, NT.chapter);
  tree.setTemplate(PROJECT, ids.copiedReal, ids.coreTpl);
  tree.setTemplate(PROJECT, ids.working, ids.workingTpl);
});

describe('template defaults are not existing values (R4.1)', () => {
  it('narrative-f4c N3: a new chapter fills its template’s placeholders directly, no proposal', async () => {
    await w.tool('arkona_chapter_plan', { story: STORY, number: 1, questionGate: 'closed' });
    const before = proposalsNow();
    const b = await w.tool('arkona_chapter_save', {
      story: STORY,
      number: 1,
      title: 'Low Water',
      inWorldDate: 'Camue 3rd, 4A 400',
      pov: 'Leila Darvish',
      charactersPresent: [],
      locations: [],
      draftStatus: 'Draft',
      markdown: 'The tide went out further than anyone remembered.',
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(b.requiresCanonicalApproval).toBeUndefined();
    expect(proposalsNow()).toBe(before);
    const ch = String(b.chapter.id);
    expect(facts(ch)).toMatchObject({
      Continuity: 'Main CANON',
      'Chapter Number': '1',
      'Draft Status': 'Draft',
    });
  });

  it('a chapter made in the app (its template known by its kind): its placeholder is filled directly', async () => {
    const b = await w.tool('set_facts', { page: ids.appChapter, facts: { Continuity: 'Main CANON' } });
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(facts(ids.appChapter).Continuity).toBe('Main CANON');
  });

  it('outside Narratives, a page the bridge copied in an earlier job keeps its value protected, even a template’s default', async () => {
    // Chosen (ADR 0066 amendment 1): the tree's record of an older copy is not used. A default may be a real value: a
    // Core-like template's Continuity "Main" would otherwise leave every such page's Continuity unprotected.
    for (const [page, from] of [
      [ids.copied, PLACEHOLDER],
      [ids.copiedReal, 'Main'],
    ] as const) {
      const b = await proposeTool('set_facts', { page, facts: { Continuity: 'AU-1' } });
      expect(b.status, `${page}: ${JSON.stringify(b)}`).toBe('proposal_captured');
      expect(b.requiresCanonicalApproval).toBe(true);
      expect(b.reason).toContain(`Continuity would change from “${from}” to “AU-1”`);
    }
  });

  it('R4-01 is not reopened: a Continuity that differs from its template default still proposes, in Narratives or out', async () => {
    for (const [page, from] of [
      [ids.ownChapter, 'Moonfall'], // a chapter in Narratives
      [ids.copiedReal, 'Main'], // a page the bridge copied, outside Narratives
      [ids.appChapter, 'Main CANON'], // the app-made chapter just filled: its value is its own now
    ] as const) {
      const b = await proposeTool('set_facts', { page, facts: { Continuity: 'Elsewhere' } });
      expect(b.status, `${page}: ${JSON.stringify(b)}`).toBe('proposal_captured');
      expect(b.requiresCanonicalApproval).toBe(true);
      expect(b.reason).toContain(`Continuity would change from “${from}” to “Elsewhere”`);
    }
    // The placeholder's text on a page whose template the bridge cannot tell is protected as before.
    const s = await proposeTool('set_facts', { page: ids.stranger, facts: { Continuity: 'Main' } });
    expect(s.status, JSON.stringify(s)).toBe('proposal_captured');
    expect(s.reason).toContain(`Continuity would change from “${PLACEHOLDER}” to “Main”`);
    // Canon moved into a story is still the owner's canonical decision (R4-01), and its Continuity still protected.
    const mv = await proposeTool('move_resource', { page: ids.canon, to: ids.story });
    expect(mv.status, JSON.stringify(mv)).toBe('proposal_captured');
    expect(mv.requiresCanonicalApproval).toBe(true);
    const cf = await proposeTool('set_facts', { page: ids.canon, facts: { Continuity: 'Main CANON' } });
    expect(cf.status, JSON.stringify(cf)).toBe('proposal_captured');
    expect(cf.reason).toContain('Continuity would change from “Main” to “Main CANON”');
  });

  it('the lifecycle guard alike: a placeholder Status is filled freely; a template’s lifecycle state stays the lifecycle tools’', async () => {
    // A placeholder is no lifecycle state, so its replacement is a first fill (the Status row the narrative tools
    // leave alone on the Chapter template's copies has none: Draft Status is another field).
    const p = await w.tool('set_facts', { page: ids.stranger, facts: { 'Draft Status': 'Revised' } });
    expect(p.status, JSON.stringify(p)).toBe('written');
    // A template default that IS a lifecycle state (Working) was judged as the page's state when it was copied: taking
    // it away is refused, naming the lifecycle tools, as for any Working page.
    const r = await w.tool('set_facts', { page: ids.working, facts: { Status: 'Draft' } });
    expect(JSON.stringify(r)).toMatch(/promote_page|archive_page/);
    expect(facts(ids.working).Status).toBe('Working');
  });
});
