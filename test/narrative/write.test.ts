/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- tool results and the mock's state are JSON */
/**
 * v3 F4c (ADR 0065; design E1, E2, E5): the narrative writing tools against the REAL stack on the mock LegendKeeper:
 * the layout (with and without acts; the Story Map first; Act 10 after Act 9; plans under maps), no prefix and the
 * narrative tags, saving (new, revised in place, the dateline, the date, a taken number, the Drafting Gate), and
 * renumbering (insert at 2 of 6, the bulk rail, prose untouched, the event loop).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loopYields } from '../../src/mcp/tools/narrative-support.js';
import { K, N, narrativeWorld, PLAN_SIDEBAR, PROJECT, type NarrativeWorld } from './world.js';

let w: NarrativeWorld;
beforeAll(async () => {
  w = await narrativeWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const kids = (id: string) => w.repo.children(id);
const named = (parent: string, name: string) => kids(parent).find((r) => r.name === name)!;
/** A page's facts as the mock holds them: key → text (a mention by its page id, `@id`). */
const facts = (id: string): Record<string, string> => {
  const sb = w.sidebars.pages.get(id);
  const out: Record<string, string> = {};
  for (const p of sb?.props ?? [])
    if (p.kind === 'keyValue')
      for (const r of p.rows ?? [])
        out[r.key] = (r.content as any[])
          .map((c) =>
            typeof c.text === 'string' && !c.mention ? c.text : c.mention ? `@${c.mention.resourceId}` : '',
          )
          .join('');
  return out;
};
const items = (id: string, title: string): string[] =>
  (w.sidebars.pages.get(id)?.props.find((p) => p.title === title)?.items ?? []).map((i: any) => i.resourceId);
const bodyText = (id: string): string[] =>
  (w.repo.blocks.get(w.mainOf(id))?.blocks as any[]).map((b) =>
    (b.content ?? []).map((r: any) => r.text ?? r.mention?.text ?? '').join(''),
  );

const prose = 'Leila crossed the harbour at dusk.\n\nThe lamps were already lit along the Glass Coast.';

describe('arkona_story_create (E1, E5)', () => {
  it('a story with acts: Story Map first, acts in number order (Act 10 after Act 9), Act Maps under the Story Map; tags; no prefix on pages', async () => {
    const b = await w.tool('arkona_story_create', {
      continuity: 'Main CANON',
      title: 'The Glass Coast',
      acts: Array.from({ length: 10 }, (_, i) => `Part ${i + 1}`),
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    const story = named(N.main, '[INDEX] The Glass Coast');
    expect(story.tags).toEqual(['Narrative', 'Story']);
    const names = kids(story.id).map((r) => r.name);
    expect(names[0]).toBe('Story Map');
    expect(names.slice(1)).toEqual(
      Array.from({ length: 10 }, (_, i) => `[INDEX] Act ${i + 1} - Part ${i + 1}`),
    );
    const map = kids(story.id)[0]!;
    expect(map.tags).toEqual(['Narrative', 'Story Map']);
    expect(kids(map.id).map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => `Act ${i + 1} Map`));
    expect(kids(map.id)[0]!.tags).toEqual(['Narrative', 'Act Map']);
    // The template's Working tag and Status are not a lifecycle here: no [BWRK], no Working tag.
    expect(map.name.startsWith('[')).toBe(false);
    expect(facts(map.id)['Continuity Type']).toBe('CANON');
    expect(facts(map.id).Continuity).toBe('Main CANON');
    // The Act Map's sidebar (the generic Working one) has no Story or Act Number: they are skipped, never invented.
    expect(b.fieldsNotOnTemplate).toEqual(expect.arrayContaining(['Planning Status', 'Story', 'Act Number']));
    expect(facts(kids(map.id)[0]!.id)).not.toHaveProperty('Story');
  });

  it('a story without acts: only its Story Map', async () => {
    const b = await w.tool('arkona_story_create', { continuity: 'Main CANON', title: 'Harbour Lights' });
    expect(b.status, JSON.stringify(b)).toBe('written');
    const story = named(N.main, '[INDEX] Harbour Lights');
    expect(kids(story.id).map((r) => r.name)).toEqual(['Story Map']);
  });

  it('refuses an AU without its index (E4), an unknown continuity, a story that exists, CANON in a title, and a field the template lacks', async () => {
    expect((await w.tool('arkona_story_create', { continuity: 'Moonfall', title: 'X' })).error.code).toBe(
      'CONTINUITY_INDEX_MISSING',
    );
    expect((await w.tool('arkona_story_create', { continuity: 'Nowhere', title: 'X' })).error.code).toBe(
      'UNKNOWN_CONTINUITY',
    );
    expect(
      (await w.tool('arkona_story_create', { continuity: 'Main CANON', title: 'Harbour Lights' })).error.code,
    ).toBe('STORY_EXISTS');
    expect(
      (await w.tool('arkona_story_create', { continuity: 'Main CANON', title: 'The CANON Tale' })).error.code,
    ).toBe('RESERVED_WORD');
    const span = await w.tool('arkona_story_create', {
      continuity: 'Main CANON',
      title: 'Spanned',
      span: '4A 640 - 4A 650',
    });
    expect(span.error.code).toBe('TEMPLATE_MISMATCH');
    expect(span.error.missing).toEqual(['Story Span']);
  });

  it('at scope propose it is a proposal; nothing is written', async () => {
    const { token } = w.stack.newToken('narrative-propose', 'propose');
    const client = await w.stack.connect(token);
    const b = (
      await w.stack.call(client, 'arkona_story_create', { continuity: 'Main CANON', title: 'Proposed Tale' })
    ).body;
    expect(b.status).toBe('proposal_captured');
    expect(kids(N.main).some((r) => r.name === '[INDEX] Proposed Tale')).toBe(false);
  });
});

describe('arkona_chapter_plan and arkona_chapter_save (E5)', () => {
  it('a plan under the Story Map of a story without acts: its fields, Question Gate Open', async () => {
    const b = await w.tool('arkona_chapter_plan', {
      story: 'Harbour Lights',
      number: 1,
      title: 'Dusk',
      plannedDate: 'Camue 3rd, 4A 400',
      pov: 'Leila Darvish',
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    const story = named(N.main, '[INDEX] Harbour Lights');
    const plan = named(kids(story.id)[0]!.id, 'Chapter 1 Plan');
    expect(plan.tags).toEqual(['Narrative', 'Chapter Plan']);
    expect(facts(plan.id)).toMatchObject({
      'Chapter Number': '1',
      'Question Gate': 'Open',
      'Planning Status': 'Planned',
      'Planned Date': 'Camue 3rd, 4A 400',
      POV: `@${K.leila}`,
      Story: `@${story.id}`,
      Subject: 'Dusk',
    });
    expect(
      (
        await w.tool('arkona_chapter_plan', {
          story: 'Harbour Lights',
          number: 2,
          plannedDate: 'Camue 51st, 4A 400',
        })
      ).error.code,
    ).toBe('DATE_UNREADABLE');
  });

  it('refuses the chapter while its plan’s Question Gate is Open; overrideGate lets it through with the reason on the Review page', async () => {
    const save = {
      story: 'Harbour Lights',
      number: 1,
      title: 'Dusk',
      inWorldDate: 'Camue 3rd, 4A 400',
      place: 'the Glass Coast',
      pov: 'Leila Darvish',
      charactersPresent: ['Leila Darvish', 'Harun al-Saffar'],
      locations: [],
      draftStatus: 'Draft',
      markdown: prose,
    };
    const refused = await w.tool('arkona_chapter_save', save);
    expect(refused.error.code).toBe('QUESTION_GATE_OPEN');
    const b = await w.tool('arkona_chapter_save', {
      ...save,
      overrideGate: { reason: 'the owner answered in chat' },
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(b.gate.overridden).toBe('the owner answered in chat');
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, b.jobId)!;
    expect(job.title).toMatch(/Question Gate overridden: the owner answered in chat/);
  });

  it('a new chapter: under the story, tagged, its dateline first (written from In-world Date), its fields, linked both ways with its plan, read back word for word', () => {
    const story = named(N.main, '[INDEX] Harbour Lights');
    const ch = named(story.id, 'Chapter 1 - Dusk');
    expect(ch.tags).toEqual(['Narrative', 'Chapter']);
    expect(bodyText(ch.id)).toEqual([
      'Camue 3rd, 4A 400 · the Glass Coast',
      'Leila crossed the harbour at dusk.',
      'The lamps were already lit along the Glass Coast.',
    ]);
    const plan = named(kids(story.id)[0]!.id, 'Chapter 1 Plan');
    expect(facts(ch.id)).toMatchObject({
      'Chapter Number': '1',
      'In-world Date': 'Camue 3rd, 4A 400',
      'Chapter Plan': `@${plan.id}`,
      'Draft Status': 'Draft',
      POV: `@${K.leila}`,
      Continuity: 'Main CANON',
    });
    expect(items(ch.id, 'Characters Present')).toEqual([K.leila, K.harun]);
    expect(facts(plan.id)).toMatchObject({ Chapter: `@${ch.id}`, 'Planning Status': 'Drafted' });
    // The placeholder text of fields the tool does not write is left for the audit to report (E8).
    expect(facts(ch.id).Act).toBe('Link to the act');
  });

  it('reads back word for word', async () => {
    await w.tool('arkona_chapter_plan', { story: 'Harbour Lights', number: 2, questionGate: 'closed' });
    const b = await w.tool('arkona_chapter_save', {
      story: 'Harbour Lights',
      number: 2,
      title: 'Night',
      // The agent's own dateline first: it is replaced by the one written from In-world Date.
      markdown: `*Camue 1st, 4A 300 · Somewhere else*\n\n${prose}`,
      inWorldDate: 'c. 4A 401-402',
      pov: 'Leila Darvish',
      charactersPresent: ['Leila Darvish'],
      locations: [],
      draftStatus: 'Draft',
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(b.readBack).toMatchObject({ matches: true });
    expect(b.replacedDateline).toBe('*Camue 1st, 4A 300 · Somewhere else*');
    const ch = named(named(N.main, '[INDEX] Harbour Lights').id, 'Chapter 2 - Night');
    expect(bodyText(ch.id)[0]).toBe('c. 4A 401-402');
    expect(bodyText(ch.id)).not.toContain('Camue 1st, 4A 300 · Somewhere else');
  });

  it('refuses an unreadable date and a taken number; revises in place with baseVersion (same page, same document)', async () => {
    const base = {
      story: 'Harbour Lights',
      number: 2,
      pov: 'Leila Darvish',
      charactersPresent: ['Leila Darvish'],
      locations: [],
      draftStatus: 'Draft',
      markdown: prose,
    };
    const bad = await w.tool('arkona_chapter_save', { ...base, inWorldDate: 'the second spring' });
    expect(bad.error.code).toBe('DATE_UNREADABLE');
    expect(bad.error.message).toMatch(/c\. 4A 640-645/);
    expect(
      (await w.tool('arkona_chapter_save', { ...base, inWorldDate: 'Camue 4th, 4A 400' })).error.code,
    ).toBe('NUMBER_TAKEN');
    const story = named(N.main, '[INDEX] Harbour Lights');
    const ch = named(story.id, 'Chapter 2 - Night');
    const doc = w.mainOf(ch.id);
    const version = `v${w.repo.blocks.get(doc)!.version}`;
    const pagesBefore = kids(story.id).length;
    const b = await w.tool('arkona_chapter_save', {
      ...base,
      inWorldDate: 'Camue 4th, 4A 400',
      draftStatus: 'Revised',
      markdown: 'The night was long.',
      baseVersion: version,
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(b.chapter).toMatchObject({ id: ch.id, documentId: doc, revised: true });
    expect(b.readBack).toMatchObject({ matches: true });
    expect(kids(story.id).length).toBe(pagesBefore);
    expect(bodyText(ch.id)).toEqual(['Camue 4th, 4A 400', 'The night was long.']);
    expect(facts(ch.id)).toMatchObject({ 'In-world Date': 'Camue 4th, 4A 400', 'Draft Status': 'Revised' });
    // A stale base is refused, nothing written.
    const stale = await w.tool('arkona_chapter_save', {
      ...base,
      inWorldDate: 'Camue 4th, 4A 400',
      markdown: 'Again.',
      baseVersion: version,
    });
    expect(stale.error.code).toBe('VERSION_CONFLICT');
  });

  it('a plan template without a Question Gate field: the gate is not enforced, and the result says so', async () => {
    w.setPlanTemplate(PLAN_SIDEBAR.filter((k) => k !== 'Question Gate'));
    try {
      await w.tool('arkona_chapter_plan', { story: 'Harbour Lights', number: 3 });
      const b = await w.tool('arkona_chapter_save', {
        story: 'Harbour Lights',
        number: 3,
        title: 'Dawn',
        inWorldDate: 'Camue 5th, 4A 400',
        pov: 'Leila Darvish',
        charactersPresent: ['Leila Darvish'],
        locations: [],
        draftStatus: 'Draft',
        markdown: prose,
      });
      expect(b.status, JSON.stringify(b)).toBe('written');
      expect(b.gate).toMatchObject({ enforced: false });
      expect(b.gate.note).toMatch(/not enforced/);
    } finally {
      w.setPlanTemplate(PLAN_SIDEBAR);
    }
  });

  it('in a story with acts, refuses an act that does not hold the number’s position', async () => {
    await w.tool('arkona_chapter_plan', {
      story: 'The Glass Coast',
      number: 1,
      act: 1,
      questionGate: 'closed',
    });
    const ok = await w.tool('arkona_chapter_save', {
      story: 'The Glass Coast',
      number: 1,
      act: 1,
      title: 'Arrival',
      inWorldDate: 'Camue 3rd, 4A 400',
      pov: 'Leila Darvish',
      charactersPresent: ['Leila Darvish'],
      locations: [],
      draftStatus: 'Draft',
      markdown: prose,
    });
    expect(ok.status, JSON.stringify(ok)).toBe('written');
    const story = named(N.main, '[INDEX] The Glass Coast');
    expect(kids(named(story.id, '[INDEX] Act 1 - Part 1').id).map((r) => r.name)).toEqual([
      'Chapter 1 - Arrival',
    ]);
    await w.tool('arkona_chapter_plan', {
      story: 'The Glass Coast',
      number: 2,
      act: 3,
      questionGate: 'closed',
    });
    const bad = await w.tool('arkona_chapter_save', {
      story: 'The Glass Coast',
      number: 1,
      act: 2,
      title: 'X',
      inWorldDate: 'Camue 3rd, 4A 400',
      pov: 'Leila Darvish',
      charactersPresent: [],
      locations: [],
      draftStatus: 'Draft',
      markdown: prose,
    });
    expect(bad.error.code).toBe('NUMBER_TAKEN');
    const pos = await w.tool('arkona_chapter_plan', { story: 'The Glass Coast', number: 3, act: 1 });
    expect(pos.error.code).toBe('ACT_POSITION');
  });
});

describe('renumbering (E5.4)', () => {
  const story = 'Six Lanterns';
  const sixChapters = async () => {
    await w.tool('arkona_story_create', { continuity: 'Main CANON', title: story });
    for (let n = 1; n <= 6; n++) {
      await w.tool('arkona_chapter_plan', { story, number: n, questionGate: 'closed' });
      const b = await w.tool('arkona_chapter_save', {
        story,
        number: n,
        title: `Lantern ${n}`,
        inWorldDate: `Camue ${n + 10}th, 4A 400`,
        pov: 'Leila Darvish',
        charactersPresent: ['Leila Darvish'],
        locations: [],
        draftStatus: 'Draft',
        markdown: `Lantern ${n} burned.`,
      });
      expect(b.status, JSON.stringify(b)).toBe('written');
    }
  };

  it('inserting at 2 of 6 renumbers 2 to 6 (names and Chapter Number fields, plans too); links keep pointing; prose untouched; the loop yields', async () => {
    await sixChapters();
    const idx = named(N.main, `[INDEX] ${story}`);
    const map = kids(idx.id)[0]!;
    const before = new Map(
      kids(idx.id)
        .filter((r) => r.name.startsWith('Chapter'))
        .map((r) => [r.id, w.repo.blocks.get(w.mainOf(r.id))!.version]),
    );
    const yields = loopYields.count;
    const b = await w.tool('arkona_chapter_insert', { story, at: 2, title: 'The Missing Lantern' });
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(loopYields.count).toBeGreaterThan(yields);
    expect(kids(idx.id).map((r) => r.name)).toEqual([
      'Story Map',
      'Chapter 1 - Lantern 1',
      ...[2, 3, 4, 5, 6].map((n) => `Chapter ${n + 1} - Lantern ${n}`),
    ]);
    expect(kids(map.id).map((r) => r.name)).toEqual([
      'Chapter 1 Plan',
      'Chapter 2 Plan',
      ...[3, 4, 5, 6, 7].map((n) => `Chapter ${n} Plan`),
    ]);
    const ch7 = named(idx.id, 'Chapter 7 - Lantern 6');
    expect(facts(ch7.id)['Chapter Number']).toBe('7');
    const plan7 = named(map.id, 'Chapter 7 Plan');
    expect(facts(plan7.id)).toMatchObject({ 'Chapter Number': '7', Chapter: `@${ch7.id}` });
    expect(facts(ch7.id)['Chapter Plan']).toBe(`@${plan7.id}`);
    // The new plan holds 2, its gate Open; prose never changed.
    expect(facts(named(map.id, 'Chapter 2 Plan').id)).toMatchObject({
      'Chapter Number': '2',
      'Question Gate': 'Open',
      Subject: 'The Missing Lantern',
    });
    for (const [id, v] of before) expect(w.repo.blocks.get(w.mainOf(id))!.version).toBe(v);
    expect(bodyText(ch7.id)).toEqual(['Camue 16th, 4A 400', 'Lantern 6 burned.']);
  });

  it('more than 10 pages through the bulk rail (a write token with the default rails) is ONE proposal of items', async () => {
    const { token } = w.stack.newToken('narrative-rails', 'write');
    const client = await w.stack.connect(token);
    const b = (await w.stack.call(client, 'arkona_chapter_insert', { story, at: 1, title: 'Prologue' })).body;
    expect(b.status, JSON.stringify(b)).toBe('proposal_captured');
    expect(b.proposedBecause ?? b.railReason ?? JSON.stringify(b)).toMatch(/bulk/);
    const p = w.stack.runtime.policy.proposals.detail(b.proposalId)!;
    // Every chapter and plan renumbered (6 + 7) and the new plan, one item each.
    expect(p.itemPlan?.items.length).toBe(14);
    expect(
      named(N.main, `[INDEX] ${story}`) &&
        kids(named(N.main, `[INDEX] ${story}`).id).some((r) => r.name === 'Chapter 1 - Prologue'),
    ).toBe(false);
  });

  it('moves a chapter: 7 to 2, the ones between (and the new plan at 2) move up, its plan with it, placed by number', async () => {
    const b = await w.tool('arkona_chapter_move', { story, from: 7, to: 2 });
    expect(b.status, JSON.stringify(b)).toBe('written');
    const idx = named(N.main, `[INDEX] ${story}`);
    expect(kids(idx.id).map((r) => r.name)).toEqual([
      'Story Map',
      'Chapter 1 - Lantern 1',
      'Chapter 2 - Lantern 6',
      ...[2, 3, 4, 5].map((n) => `Chapter ${n + 2} - Lantern ${n}`),
    ]);
    const map = kids(idx.id)[0]!;
    expect(kids(map.id).map((r) => r.name)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `Chapter ${n} Plan`));
    expect(facts(named(map.id, 'Chapter 3 Plan').id).Subject).toBe('The Missing Lantern');
    const ch2 = named(idx.id, 'Chapter 2 - Lantern 6');
    expect(facts(named(map.id, 'Chapter 2 Plan').id).Chapter).toBe(`@${ch2.id}`);
  });
});
