/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- tool results and the mock's state are JSON */
/**
 * CR-2026-11-R4, pass 1 (the narrative property): `create_resource`'s narrative mode and the five writing tools as an
 * agent at scope `write` (default rails) would try to turn them on canon: a parent outside Narratives or a look-alike
 * Narratives, a Status or a status tag smuggled in, a look-alike [BSRC] prefix, a canon index or page given as the story,
 * a canon page inside a story (a plan, a renumbered chapter), a chapter moved out of Narratives in the app (a stale tree,
 * and after the plan), and story titles that name an index the bridge depends on. Each test asserts the SAFE behaviour
 * (ADR 0065 E2, E5): a pass means the attempt held, a failure is a bypass. Against the mock LegendKeeper only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFECYCLE } from '../../resources/world.js';
import { O } from '../../packs/f4a-world.js';
import { K, N, narrativeWorld, PROJECT, type NarrativeWorld } from '../../narrative/world.js';
import { agentOf, approveOrdinary, canonSidebar } from './helpers.js';

let w: NarrativeWorld;
let agent: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
const STORY = 'Ember Road';
const ids = {
  story: '',
  map: '',
  canonPlan: 'nacplan6',
  canonChapter: 'nacchap4',
  outsideTwin: 'naotwin2',
};

const kids = (id: string) => w.repo.children(id);
const named = (parent: string, name: string) => kids(parent).find((r) => r.name === name);
const tagsOf = (id: string) => w.repo.live(id)?.tags ?? [];
/** A page's facts as the mock holds them: key → text. */
const facts = (id: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of w.sidebars.pages.get(id)?.props ?? [])
    if (p.kind === 'keyValue')
      for (const r of p.rows ?? [])
        out[r.key] = (r.content as any[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  return out;
};
const save = (n: number, title: string, more: Record<string, unknown> = {}) =>
  w.tool('arkona_chapter_save', {
    story: STORY,
    number: n,
    title,
    inWorldDate: `Camue ${n + 10}th, 4A 400`,
    pov: 'Leila Darvish',
    charactersPresent: ['Leila Darvish'],
    locations: [],
    draftStatus: 'Draft',
    markdown: `Ember ${n} glowed on the road.`,
    ...more,
  });

beforeAll(async () => {
  w = await narrativeWorld();
  agent = await agentOf(w);
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: STORY })).status).toBe(
    'written',
  );
  for (const n of [1, 2, 3]) {
    expect(
      (await w.tool('arkona_chapter_plan', { story: STORY, number: n, questionGate: 'closed' })).status,
    ).toBe('written');
    const b = await save(n, `Ember ${n}`);
    expect(b.status, JSON.stringify(b)).toBe('written');
  }
  ids.story = named(N.main, `[INDEX] ${STORY}`)!.id;
  ids.map = kids(ids.story)[0]!.id;
  // Canon pages an agent then moves INTO the story (NA-01's route, direct at scope write): a canon page named like a
  // plan, and one named like a chapter. And a canon page outside Narratives named like one of the story's chapters.
  w.repo.seed({
    id: ids.canonPlan,
    name: '[BSRC] Chapter 6 Plan',
    parentId: O.salahadPolities,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.repo.seed({
    id: ids.canonChapter,
    name: '[BSRC] Chapter 4 - The Founding',
    parentId: O.salahadPolities,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.repo.seed({
    id: ids.outsideTwin,
    name: '[BSRC] Chapter 2 - Ember 2',
    parentId: O.salahadPolities,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.sidebars.page(ids.canonPlan, canonSidebar(ids.canonPlan, 'The Sixth Accord'));
  w.sidebars.page(ids.canonChapter, canonSidebar(ids.canonChapter, 'The Founding'));
  w.sidebars.page(ids.outsideTwin, canonSidebar(ids.outsideTwin, 'Ember Accord'));
  w.rebuildTree();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('renumbering stays in its story and never touches prose', () => {
  it('NA-24: inserting at 2 renames only the story’s pages: the canon twin outside keeps its name; no chapter’s text changes', async () => {
    const versions = new Map(
      kids(ids.story)
        .filter((r) => /^Chapter \d/.test(r.name))
        .map((r) => [r.id, w.repo.blocks.get(w.mainOf(r.id))?.version]),
    );
    const twinText = JSON.stringify(w.repo.blocks.get(w.mainOf(ids.outsideTwin)));
    const b = await w.tool('arkona_chapter_insert', { story: STORY, at: 2, title: 'Detour' });
    expect(b.status, JSON.stringify(b).slice(0, 300)).toBe('written'); // the renumbering ran
    expect(kids(ids.story).map((r) => r.name)).toContain('Chapter 3 - Ember 2');
    expect(w.repo.live(ids.outsideTwin)!.name).toBe('[BSRC] Chapter 2 - Ember 2');
    expect(JSON.stringify(w.repo.blocks.get(w.mainOf(ids.outsideTwin)))).toBe(twinText);
    for (const [id, v] of versions) expect(w.repo.blocks.get(w.mainOf(id))?.version, id).toBe(v);
  });
});

describe('a chapter moved out of Narratives', () => {
  it('NA-25: a chapter moved out in the app (the tree has not seen it): arkona_chapter_save does not revise a page outside Narratives', async () => {
    const ch = kids(ids.story).find((r) => /^Chapter 1 - /.test(r.name))!;
    w.repo.outside.move(ch.id, O.salahadPolities);
    const doc = w.mainOf(ch.id);
    const version = `v${w.repo.blocks.get(doc)!.version}`;
    const b = await agent('arkona_chapter_save', {
      story: STORY,
      number: 1,
      inWorldDate: 'Camue 11th, 4A 400',
      pov: 'Leila Darvish',
      charactersPresent: ['Leila Darvish'],
      locations: [],
      draftStatus: 'Revised',
      markdown: 'Rewritten where it no longer belongs.',
      baseVersion: version,
    });
    const text = JSON.stringify(w.repo.blocks.get(doc));
    // Put it back for the next test (the owner, in the app).
    w.repo.outside.move(ch.id, ids.story);
    expect(b.status, JSON.stringify(b).slice(0, 400)).not.toBe('written');
    expect(text).not.toMatch(/Rewritten where it no longer belongs/);
  });

  it('NA-26: a renumbering proposed, then a chapter moved out of the story before approval: the approved job renames nothing outside', async () => {
    const { token } = w.stack.newToken('r4-narrative-propose', 'propose');
    const client = await w.stack.connect(token);
    const b = (
      await w.stack.call(client, 'arkona_chapter_insert', { story: STORY, at: 3, title: 'Late Detour' })
    ).body;
    expect(b.status, JSON.stringify(b).slice(0, 300)).toBe('proposal_captured');
    const last = kids(ids.story)
      .filter((r) => /^Chapter \d+ - /.test(r.name) && !r.name.startsWith('['))
      .at(-1)!;
    const before = last.name;
    w.repo.outside.move(last.id, O.salahadPolities);
    const r = await approveOrdinary(w, b.proposalId);
    const after = w.repo.live(last.id)!.name;
    w.repo.outside.move(last.id, ids.story);
    expect(after, `the moved-out chapter (${r.state})`).toBe(before);
  });
});

describe('create_resource’s narrative mode', () => {
  it('NA-16: a narrative template with a parent OUTSIDE Narratives makes no unprefixed page there', async () => {
    const before = kids(O.salahadPolities).length;
    const b = await agent('create_resource', {
      name: 'Chapter 9 - Smuggled',
      template: 'AI Narrative Chapter',
      parent: O.salahadPolities,
    });
    expect(b.status, JSON.stringify(b).slice(0, 400)).not.toBe('written');
    expect(kids(O.salahadPolities).length).toBe(before);
  });

  it('NA-17: a look-alike “Narratіves” index (Cyrillic і) the agent made is not Narratives', async () => {
    const idx = await agent('create_bare_resource', { name: '[INDEX] Narratіves', parent: O.arkonaIndex });
    const id = idx.pages?.[0]?.id as string | undefined;
    if (!id) return;
    const b = await agent('create_resource', {
      name: 'Loose Notes',
      template: 'AI Narrative Chapter Plan',
      parent: id,
    });
    expect(b.status, JSON.stringify(b).slice(0, 400)).not.toBe('written');
    expect(kids(id).some((r) => !r.name.startsWith('['))).toBe(false);
  });

  it('NA-18: a Status given in facts (Archived) is refused under Narratives, as `status` is (no lifecycle)', async () => {
    const b = await agent('create_resource', {
      name: 'Ash Notes',
      template: 'AI Narrative Chapter Plan',
      parent: ids.map,
      facts: { Status: 'Archived' },
    });
    expect(b.status, JSON.stringify(b).slice(0, 500)).not.toBe('written');
  });

  it('NA-19: a status tag (AU in Main CANON; a look-alike СANON) is never set on a narrative page', async () => {
    for (const tag of ['AU', 'СANON']) {
      const name = `Tag Notes ${tag === 'AU' ? 'A' : 'C'}`;
      const b = await agent('create_resource', {
        name,
        template: 'AI Narrative Chapter Plan',
        parent: ids.map,
        tags: [tag],
      });
      const page = named(ids.map, name);
      expect
        .soft(page ? tagsOf(page.id) : [], `${tag}: ${JSON.stringify(b).slice(0, 300)}`)
        .not.toContain(tag);
    }
  });

  it('NA-20: a look-alike [BSRC] prefix (fullwidth ［BSRC］) on a narrative create is never a direct canon-looking page', async () => {
    const b = await agent('create_resource', {
      name: '［BSRC］ Smuggled Notes',
      template: 'AI Narrative Chapter Plan',
      parent: ids.map,
    });
    if (b.status === 'proposal_captured')
      expect(w.stack.runtime.policy.proposals.get(b.proposalId)?.requiresCanonicalApproval).toBe(true);
    else expect(b.status, JSON.stringify(b).slice(0, 400)).not.toBe('written');
  });
});

describe('a narrative page leaving Narratives with what it was given there', () => {
  it('NA-39: a narrative page given Status Archived or a CANON look-alike tag (NA-18, NA-19) does not reach canon carrying it', async () => {
    const carried: string[] = [];
    for (const name of ['Ash Notes', 'Tag Notes C']) {
      const page = named(ids.map, name);
      if (!page) continue; // not made (NA-18 / NA-19 held)
      const b = await agent('move_resource', { page: page.id, to: O.salahadPolities });
      const now = w.repo.live(page.id)!;
      const outside = now.parentId === O.salahadPolities;
      const status = facts(page.id).Status;
      if (outside && (status === 'Archived' || now.tags.some((t) => t !== 'Narrative')))
        carried.push(`${name} (${b.status}): Status ${status ?? '-'}, tags ${now.tags.join(', ')}`);
    }
    expect(carried, JSON.stringify(carried)).toEqual([]);
  });
});

describe('the writing tools given canon', () => {
  it('NA-21: a canon index, or a canon page, as the story: refused', async () => {
    for (const story of [O.salahadPolities, K.harun, '[INDEX] Salahad Polities']) {
      const b = await agent('arkona_chapter_plan', { story, number: 1, title: 'X' });
      expect.soft(b.error?.code, `${story}: ${JSON.stringify(b).slice(0, 300)}`).toBe('STORY_NOT_FOUND');
    }
  });

  it('NA-22: a canon page named “Chapter 6 Plan”, once inside the story, is not updated by arkona_chapter_plan', async () => {
    // The lead (CR-2026-11-R4): the owner files the canon page there in the app. As first written, an agent moved it
    // with the low-level route (NA-02's), which is now a canonical proposal (R4-01); the defence asserted below must
    // hold however canon came to be in the story.
    w.repo.outside.move(ids.canonPlan, ids.map);
    w.rebuildTree(); // as the next tree sweep sees it
    const before = facts(ids.canonPlan).Subject;
    const b = await agent('arkona_chapter_plan', { story: STORY, number: 6, title: 'Renamed Accord' });
    expect.soft(b.status, JSON.stringify(b).slice(0, 500)).not.toBe('written');
    expect.soft(facts(ids.canonPlan).Subject).toBe(before);
  });

  it('NA-23: a canon page named “Chapter 4 - …”, once inside the story, is never renamed out of [BSRC] by a renumbering', async () => {
    // The lead (CR-2026-11-R4): the owner files it in the story in the app (an agent's move_resource is now a canonical
    // proposal, R4-01).
    w.repo.outside.move(ids.canonChapter, ids.story);
    w.rebuildTree();
    const b = await agent('arkona_chapter_insert', { story: STORY, at: 4, title: 'Interlude' });
    const name = w.repo.live(ids.canonChapter)!.name;
    expect(name.startsWith('[BSRC] '), `${name}: ${JSON.stringify(b).slice(0, 500)}`).toBe(true);
    if (b.status === 'proposal_captured')
      expect(w.stack.runtime.policy.proposals.get(b.proposalId)?.requiresCanonicalApproval).toBe(true);
  });
});

describe('story titles that name an index the bridge depends on', () => {
  it('NA-27: a story titled “Working” is refused (a lifecycle index’s name)', async () => {
    const b = await agent('arkona_story_create', { continuity: 'Main CANON', title: 'Working' });
    expect(b.status, JSON.stringify(b).slice(0, 300)).not.toBe('written');
    void LIFECYCLE;
  });

  it('NA-28: a story titled “Narratives” is refused (a second Narratives index switches every narrative rule off)', async () => {
    const b = await agent('arkona_story_create', { continuity: 'Main CANON', title: 'Narratives' });
    const after = await agent('arkona_chapter_plan', { story: STORY, number: 9, title: 'After' });
    expect.soft(b.status, JSON.stringify(b).slice(0, 300)).not.toBe('written');
    expect.soft(after.error?.code, JSON.stringify(after).slice(0, 300)).not.toBe('NARRATIVES_NOT_FOUND');
    void PROJECT;
  });
});
