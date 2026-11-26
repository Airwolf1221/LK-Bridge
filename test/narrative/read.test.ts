/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- tool results and the mock's state are JSON */
/**
 * v3 F4c (ADR 0065; design E6, E7): reading a chapter against canon and offering what it invents to the owner, against the
 * REAL stack on the mock LegendKeeper: `arkona_chapter_context` (as-of states, briefs, the chronology window,
 * contradictions, the plan's constraints and gate, the previous chapter's closing state, every part labelled);
 * `arkona_chapter_check` (not yet born, deceased, outside the attested span; present but absent and the reverse; a birth
 * in the prose against canon; a new-lore candidate and none for a sentence's first word; an Archived-only name; an AU
 * chapter); `arkona_promote_from_chapter` (a page, a fact and a text as proposals at propose scope, items, the chapter
 * cited in the note only, a namesake carried; v3 F12, ADR 0081: at write scope the agent's direct writes, on Review). Memory: repeated saves and checks return the heap to its baseline.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { K, N, narrativeWorld, PROJECT, type NarrativeWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

let w: NarrativeWorld;
const story = 'Moon Harbour';
const save = (n: number, title: string, date: string, present: string[], markdown: string) =>
  w.tool('arkona_chapter_save', {
    story,
    number: n,
    title,
    inWorldDate: date,
    pov: present[0],
    charactersPresent: present,
    locations: [],
    draftStatus: 'Draft',
    markdown,
  });

beforeAll(async () => {
  w = await narrativeWorld();
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: story })).status).toBe(
    'written',
  );
  for (const n of [1, 2, 3])
    await w.tool('arkona_chapter_plan', { story, number: n, questionGate: 'closed' });
  const ok = (b: any) => expect(b.status, JSON.stringify(b)).toBe('written');
  ok(
    await save(
      1,
      'Arrival',
      'Camue 3rd, 4A 340',
      ['Harun al-Saffar'],
      'Harun al-Saffar came ashore.\n\n## Nightfall\n\nThe boats were drawn up and the fires lit.',
    ),
  );
  ok(
    await save(
      2,
      'The Tower',
      '4A 350',
      ['Rashad al-Khalid', 'Harun al-Saffar', 'Kamigawa Haru'],
      'Rashad al-Khalid watched the sea. Harun al-Saffar was born in 4A 320, the old men said. ' +
        'Leila Darvish waved from the quay. They climbed to the Glimmerwood Tower at dusk. ' +
        'Lanterns burned below. They said Seren Vale had built it.',
    ),
  );
  ok(
    await save(
      3,
      'Aftermath',
      'Camue 5th, 4A 401',
      ['Harun al-Saffar'],
      'Harun al-Saffar walked the harbour wall.',
    ),
  );
  // The plan's own Canon Constraints and Closing State (written with write_page in real use).
  const map = w.repo.children(w.repo.children(N.main).find((r) => r.name === `[INDEX] ${story}`)!.id)[0]!;
  const plan2 = w.repo.children(map.id).find((r) => r.name === 'Chapter 2 Plan')!;
  w.repo.blocks.set(w.mainOf(plan2.id), {
    version: 5,
    blocks: [
      { id: 'p2h1', kind: 'heading', level: 2, content: [{ text: 'Canon Constraints' }] },
      { id: 'p2p1', kind: 'paragraph', content: [{ text: 'Harun is alive in 4A 350.' }] },
      { id: 'p2h2', kind: 'heading', level: 2, content: [{ text: 'Closing State' }] },
      { id: 'p2p2', kind: 'paragraph', content: [{ text: 'They reach the tower.' }] },
    ],
  });
  w.setBody(K.harun, [
    { id: 'hah1', kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
    { id: 'hap1', kind: 'paragraph', content: [{ text: 'The Core of Harun al-Saffar.' }] },
  ]);
  await w.snapshot();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('arkona_chapter_context (E6.1)', () => {
  it('as of the chapter’s date: as-of states, briefs, the plan’s constraints and gate, the previous chapter’s closing state, each labelled', async () => {
    const b = await w.tool('arkona_chapter_context', { story, number: 2 });
    expect(b.date).toMatchObject({ value: '4A 350', from: 'In-world Date' });
    const chars = b.asOf.characters as any[];
    expect(chars.map((c) => c.character)).toEqual(
      expect.arrayContaining(['Rashad al-Khalid', 'Harun al-Saffar']),
    );
    expect(chars.find((c) => c.character === 'Rashad al-Khalid').elapsedYears).toBe('not yet born');
    expect(b.asOf.evidence).toMatch(/canon/);
    expect(b.briefs.subjects.length).toBeGreaterThanOrEqual(3);
    expect(b.plan).toMatchObject({ questionGate: 'Closed' });
    expect(b.plan.canonConstraints).toMatch(/Harun is alive in 4A 350/);
    expect(b.plan.evidence).toMatch(/narrative \(never canon/);
    expect(b.previous).toMatchObject({ chapter: 'Chapter 1 - Arrival' });
    expect(b.previous.closingState).toMatch(/Nightfall[\s\S]*fires lit/);
    expect(b.cost).toMatch(/free/);
  });
});

describe('arkona_chapter_check (E6.2)', () => {
  it('people: not yet born, outside the attested life; present but absent, and in the prose but not listed', async () => {
    const b = await w.tool('arkona_chapter_check', { story, number: 2 });
    const what = (b.items as any[]).map((i) => `${i.label}: ${i.what}`);
    expect(what).toContain('Contradicts canon: Rashad al-Khalid is not yet born at 4A 350');
    expect(
      what.some((x) => /^Unestablished in canon: Nothing recorded places Kamigawa Haru alive/.test(x)),
    ).toBe(true);
    expect(b.presence).toEqual(
      expect.arrayContaining([
        { issue: 'listed in Characters Present but not in the prose', character: 'Kamigawa Haru' },
        { issue: 'in the prose but not in Characters Present', character: 'Leila Darvish' },
      ]),
    );
  });

  it('a birth written in the prose against canon; a new-lore candidate (never a sentence’s first word); an Archived-only name', async () => {
    const b = await w.tool('arkona_chapter_check', { story, number: 2 });
    const items = b.items as any[];
    expect(items.find((i) => i.kind === 'date')).toMatchObject({
      label: 'Contradicts canon',
      what: expect.stringMatching(/Harun al-Saffar’s birth is 4A 320 in the prose, 4A 300 in canon/),
    });
    const names = items.filter((i) => i.kind === 'name');
    expect(names.find((i) => i.name === 'Glimmerwood Tower')).toMatchObject({
      label: 'Not in canon (candidate)',
    });
    expect(names.some((i) => i.name === 'Lanterns')).toBe(false);
    expect(names.find((i) => i.name === 'Seren Vale')).toMatchObject({ label: 'Unestablished in canon' });
    expect(b.rule).toMatch(/nothing was edited/i);
  });

  it('deceased (recorded) at the chapter’s date', async () => {
    const b = await w.tool('arkona_chapter_check', { story, number: 3 });
    expect((b.items as any[]).map((i) => i.what)).toContain(
      'Harun al-Saffar is recorded deceased by Camue 5th, 4A 401',
    );
  });

  it('ages in the prose, by the pack’s phrasings and by name only, against the elapsed calendar years', async () => {
    await w.tool('arkona_chapter_plan', { story, number: 4, questionGate: 'closed' });
    const s = await save(
      4,
      'Spring',
      '4A 120',
      ['Yasmin al-Naim'],
      'Yasmin al-Naim was 25 years old that spring. Yasmin al-Naim, aged 20, laughed at the gulls. ' +
        'She was 40 in the songs, which no one believed.',
    );
    expect(s.status, JSON.stringify(s)).toBe('written');
    const b = await w.tool('arkona_chapter_check', { story, number: 4 });
    const ages = (b.items as any[]).filter((i) => i.kind === 'age');
    // Born Camue 1st, 4A 100: 19 to 20 calendar years at 4A 120 (a year). 25 contradicts; 20 fits; a pronoun is never read.
    expect(ages).toEqual([
      expect.objectContaining({
        label: 'Contradicts canon',
        what: 'Yasmin al-Naim is 25 in the prose, 19 to 20 calendar years at 4A 120',
      }),
    ]);
  });

  it('an AU chapter is read with the AU’s facts first', async () => {
    const moon = w.repo.seed({
      name: '[INDEX] Moonfall',
      parentId: N.narratives,
      tags: ['Narrative', 'AU'],
    }).id;
    w.rebuildTree();
    expect((await w.tool('arkona_story_create', { continuity: 'Moonfall', title: 'Moon Tide' })).status).toBe(
      'written',
    );
    await w.tool('arkona_chapter_plan', { story: 'Moon Tide', number: 1, questionGate: 'closed' });
    const s = await w.tool('arkona_chapter_save', {
      story: 'Moon Tide',
      number: 1,
      title: 'Early',
      inWorldDate: '4A 120',
      pov: 'Yasmin al-Naim',
      charactersPresent: ['Yasmin al-Naim'],
      locations: [],
      draftStatus: 'Draft',
      markdown: 'Yasmin al-Naim looked out to sea.',
    });
    expect(s.status, JSON.stringify(s)).toBe('written');
    const story2 = w.repo.children(moon).find((r) => r.name === '[INDEX] Moon Tide')!;
    expect(story2.tags).toEqual(['Narrative', 'Story', 'AU']);
    const b = await w.tool('arkona_chapter_check', { story: 'Moon Tide', number: 1 });
    expect(b.continuity).toBe('Moonfall');
    expect(b.notes.join(' ')).toMatch(/AU chapter/);
    // The as-of reading is asked in the AU's continuity (F4b D9: its own facts first, else Main CANON's, inherited).
    const spy = vi.spyOn(w.stack.runtime.consistency, 'asOf');
    await w.tool('arkona_chapter_check', { story: 'Moon Tide', number: 1 });
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({
      continuity: 'Moonfall',
      characters: [expect.any(String)],
    });
    await w.tool('arkona_chapter_check', { story, number: 3 });
    expect(spy.mock.calls.at(-1)?.[0]).not.toHaveProperty('continuity');
    spy.mockRestore();
  });
});

describe('arkona_promote_from_chapter (E7)', () => {
  /** v3 F12 (ADR 0081): the proposals are made at scope propose (at scope write the same call writes directly). */
  const proposeTool = async (name: string, args: Record<string, unknown>) =>
    (
      await w.stack.call(
        await w.stack.connect(w.stack.newToken('read-proposer', 'propose').token),
        name,
        args,
      )
    ).body;

  it('a page, a fact and a text become proposals at propose scope; facts and texts are ONE proposal of items; the chapter is cited in the note only', async () => {
    const b = await proposeTool('arkona_promote_from_chapter', {
      chapter: 'Chapter 2 - The Tower',
      candidates: [
        {
          candidate: 'Glimmerwood Tower',
          as: 'page',
          page: {
            name: 'Glimmerwood Tower',
            template: 'AI General Source',
            parent: 'Appraisal Desk',
            facts: { Scope: 'A harbour tower' },
          },
        },
        { candidate: 'Harun’s work', as: 'fact', target: K.harun, facts: { Scope: 'A harbour builder' } },
        {
          candidate: 'The tower’s builder',
          as: 'text',
          target: K.harun,
          section: 'Purpose',
          markdown: 'He oversaw the harbour works.',
        },
      ],
    });
    expect(b.cite).toBe('introduced in Chapter 2 of “Moon Harbour” (Chapter 2 - The Tower)');
    const page = b.proposals[0];
    expect(page.status, JSON.stringify(page)).toBe('proposal_captured');
    const pp = w.stack.runtime.policy.proposals.get(page.proposalId)!;
    expect(pp.summary).toMatch(/introduced in Chapter 2 of “Moon Harbour”/);
    expect(pp.requiresCanonicalApproval).toBe(true);
    expect(b.edits.status, JSON.stringify(b.edits)).toBe('proposal_captured');
    const ep = w.stack.runtime.policy.proposals.detail(b.edits.proposalId)!;
    expect(
      ep.itemPlan?.items.map((i) => i.kind),
      JSON.stringify(b.edits),
    ).toEqual(['fact', 'text']);
    expect(ep.summary).toMatch(/introduced in Chapter 2/);
    // Never a Dependency or a Related Source: the chapter is in no link written.
    const ops = JSON.stringify([pp, ep]);
    expect(ops).not.toMatch(/Dependencies|Related Sources/);
    // Nothing applied: Harun's Scope is as it was.
    expect(JSON.stringify(w.sidebars.pages.get(K.harun))).not.toMatch(/A harbour builder/);
  });

  it('a new character is a canon proposal (at propose scope) with its namesake warning carried', async () => {
    const b = await proposeTool('arkona_promote_from_chapter', {
      chapter: 'Chapter 2 - The Tower',
      candidates: [
        {
          candidate: 'Hoshizora Tsubame',
          as: 'character',
          character: {
            name: 'Hoshizora Tsubame',
            depth: 'compact',
            identity: {
              givenName: 'Tsubame',
              surname: 'Hoshizora',
              race: 'Human',
              namingCulture: 'Fujimatsuan',
              lifeState: 'Alive at 5A 931',
              temporalScope: '5A 910 - 5A 931',
            },
            pages: [
              {
                role: 'compact',
                scope: 'A shrine dancer',
                markdown:
                  '## Purpose\n\nThe compact reference for Hoshizora Tsubame, a shrine dancer.\n\n## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\nNone yet.\n',
              },
            ],
          },
        },
      ],
    });
    const c = b.proposals[0];
    expect(c.status, JSON.stringify(c)).toBe('proposal_captured');
    expect(JSON.stringify(c.warnings)).toMatch(/NAMESAKE/);
    expect(w.stack.runtime.policy.proposals.get(c.proposalId)!.summary).toMatch(
      /namesake: Tsubame Hoshizora[\s\S]*introduced in Chapter 2/,
    );
  });

  it('at write scope (v3 F12) a page is written directly, on the owner’s Review page; never a Dependency or a Related Source', async () => {
    const b = await w.tool('arkona_promote_from_chapter', {
      chapter: 'Chapter 2 - The Tower',
      candidates: [
        {
          candidate: 'Glimmerwood Quay',
          as: 'page',
          page: { name: 'Glimmerwood Quay', template: 'AI General Source', parent: 'Appraisal Desk' },
        },
      ],
    });
    const page = b.proposals[0];
    expect(page.status, JSON.stringify(page)).toBe('written');
    expect(
      w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === page.jobId),
    ).toBe(true);
    expect(JSON.stringify(b)).not.toMatch(/Dependencies|Related Sources/);
  });
});

describe('memory', () => {
  it('repeated saves and checks return the heap to its baseline', async () => {
    const heap = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const run = async (i: number) => {
      await w.tool('arkona_chapter_save', {
        story,
        number: 3,
        title: 'Aftermath',
        inWorldDate: 'Camue 5th, 4A 401',
        pov: 'Harun al-Saffar',
        charactersPresent: ['Harun al-Saffar'],
        locations: [],
        draftStatus: 'Draft',
        markdown: `Harun al-Saffar walked the harbour wall, ${i} times.`,
        baseVersion: `v${w.repo.blocks.get(w.mainOf(w.repo.children(w.repo.children(N.main).find((r) => r.name === `[INDEX] ${story}`)!.id).find((r) => r.name === 'Chapter 3 - Aftermath')!.id))!.version}`,
      });
      await w.tool('arkona_chapter_check', { story, number: 3 });
    };
    for (let i = 0; i < 3; i++) await run(i);
    const base = heap();
    for (let i = 0; i < 12; i++) await run(i);
    // Within 40 MB of the baseline after twelve more rounds (the stack itself keeps logs and jobs).
    expect(heap() - base).toBeLessThan(40 * 1024 * 1024);
    void PROJECT;
  });
});
