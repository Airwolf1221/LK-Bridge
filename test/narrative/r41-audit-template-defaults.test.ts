/**
 * R4.1 (ADR 0066 amendment 1, Q2, the owner's): the narrative audit treats a field whose value is IDENTICAL to its
 * template's default as a leftover placeholder (`narrative_placeholder`), alongside the pack's patterns ("Link to …").
 * The template is the page's kind's (Chapter, Chapter Plan, Story Map, Act Map), found by name among the snapshot's
 * templates; the defaults are the owner's real placeholder texts (`CHAPTER_SIDEBAR`). A template's default in Continuity
 * is reported as a placeholder, not as another continuity; a value one character off the default is the page's own; a
 * Status the template gives that names a lifecycle state (Working) is no placeholder (Q1). Against the mock only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidebarModel } from '../resources/world.js';
import {
  CHAPTER_SIDEBAR,
  N,
  narrativeWorld,
  PROJECT,
  WORKING_DEFAULTS,
  type NarrativeWorld,
} from './world.js';

let w: NarrativeWorld;
const STORY = 'Leftover Tides';
const DEFAULT = Object.fromEntries(CHAPTER_SIDEBAR);
const ids = { story: '', map: '', saved: '', app: 'r41aapp1', near: 'r41anear', plan: 'r41aplan' };

const narrative = () =>
  w.stack.runtime.audits
    .list(PROJECT, { category: ['narrative'], acknowledged: 'include', limit: 1000 })
    .findings.filter((f) => f.state === 'open');
const on = (pageId: string, code?: string) =>
  narrative().filter((f) => f.pageId === pageId && (code === undefined || f.code === code));
const fields = (pageId: string) =>
  on(pageId, 'narrative_placeholder')
    .map((f) => String((f.evidence as { field?: unknown }).field))
    .sort();

beforeAll(async () => {
  w = await narrativeWorld();
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: STORY })).status).toBe(
    'written',
  );
  ids.story = w.repo.children(N.main).find((r) => r.name === `[INDEX] ${STORY}`)!.id;
  ids.map = w.repo.children(ids.story)[0]!.id;
  expect(
    (await w.tool('arkona_chapter_plan', { story: STORY, number: 1, questionGate: 'closed' })).status,
  ).toBe('written');
  const saved = await w.tool('arkona_chapter_save', {
    story: STORY,
    number: 1,
    title: 'Low Water',
    inWorldDate: 'Camue 3rd, 4A 400',
    pov: 'Leila Darvish',
    charactersPresent: [],
    locations: [],
    draftStatus: 'Draft',
    markdown: 'The tide went out.',
  });
  expect(saved.status, JSON.stringify(saved)).toBe('written');
  ids.saved = String((saved.chapter as { id: string }).id);
  const r = w.repo;
  // A chapter made in the app from the Chapter template, two fields filled, the rest its template's defaults.
  r.seed({
    id: ids.app,
    name: 'Chapter 2 - Made in the App',
    parentId: ids.story,
    tags: ['Narrative', 'Chapter'],
  });
  w.sidebars.page(ids.app, [
    SidebarModel.kv(
      'kvr41aa1',
      'PROPERTIES',
      CHAPTER_SIDEBAR.map(([k, v]) => [
        k,
        k === 'Chapter Number' ? '2' : k === 'In-world Date' ? 'Camue 9th, 4A 400' : v,
      ]),
    ),
  ]);
  // Values one character off the defaults: the page's own, never a leftover.
  r.seed({
    id: ids.near,
    name: 'Chapter 3 - Its Own Words',
    parentId: ids.story,
    tags: ['Narrative', 'Chapter'],
  });
  w.sidebars.page(ids.near, [
    SidebarModel.kv('kvr41an1', 'PROPERTIES', [
      ['Chapter Number', '3'],
      ['In-world Date', 'Camue 12th, 4A 400'],
      ['Continuity', 'Main CANON'],
      ['Draft Status', 'Draft, Revised, or Final'],
    ]),
  ]);
  // A plan made before R4.1 (or in the app): its Continuity still the template's default.
  r.seed({ id: ids.plan, name: 'Chapter 3 Plan', parentId: ids.map, tags: ['Narrative', 'Chapter Plan'] });
  w.sidebars.page(ids.plan, [
    SidebarModel.kv('kvr41ap1', 'PROPERTIES', [
      ['Chapter Number', '3'],
      ['Question Gate', 'Closed'],
      ['Continuity Type', 'CANON'],
      ['Continuity', WORKING_DEFAULTS.Continuity!],
    ]),
  ]);
  w.rebuildTree();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('the narrative audit: a value identical to its template’s default is a leftover placeholder (R4.1, Q2)', () => {
  it('a chapter made in the app: every field still holding the Chapter template’s default is reported', () => {
    expect(fields(ids.app)).toEqual(
      ['Act', 'Chapter Plan', 'Continuity', 'Draft Status', 'POV', 'Story'].sort(),
    );
    const draft = on(ids.app, 'narrative_placeholder').find(
      (f) => (f.evidence as { field?: unknown }).field === 'Draft Status',
    )!;
    // Not a pattern the pack lists: found by the template's default alone.
    expect(draft.message).toBe(
      `“Chapter 2 - Made in the App”: Draft Status still holds its template’s default “${DEFAULT['Draft Status']}”.`,
    );
    expect(draft.evidence).toMatchObject({ value: DEFAULT['Draft Status'], templateDefault: true });
    // Its Continuity default is a leftover, not another continuity.
    expect(on(ids.app, 'narrative_continuity_mismatch')).toEqual([]);
  });

  it('a value one character off the default is the page’s own', () => {
    expect(fields(ids.near)).toEqual([]);
  });

  it('a plan whose Continuity is its template’s default: a placeholder, not a continuity mismatch', () => {
    expect(fields(ids.plan)).toEqual(['Continuity']);
    expect(on(ids.plan, 'narrative_continuity_mismatch')).toEqual([]);
  });

  it('a chapter the tools wrote: only the field the tool does not write (Act, in a story without acts) is left over', () => {
    expect(fields(ids.saved)).toEqual(['Act']);
  });

  it('the Story Map’s Status Working (the generic sidebar’s, a lifecycle state: Q1) is no placeholder', () => {
    expect(on(ids.map, 'narrative_placeholder')).toEqual([]);
  });
});
