/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- tool results and the mock's state are JSON */
/**
 * CR-2026-11-R4, pass 1 (the narrative property): the Narrative Integrity audit's "Propose a fix" and its ordinary
 * approval on canon that sits in Narratives (a [BSRC] page named like a chapter, a CANON-tagged index directly in a
 * continuity) and on prose; and "never authority" (ADR 0065 E2.4): `arkona_chapter_check`'s names, `arkona_brief`, and
 * the facts index with a look-alike second "Narratives" index, or a chapter moved out of Narratives. Each test asserts the
 * SAFE behaviour: a pass means the attempt held, a failure is a bypass. Against the mock LegendKeeper only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarModel } from '../../resources/world.js';
import { O } from '../../packs/f4a-world.js';
import { K, N, narrativeWorld, PROJECT, type NarrativeWorld } from '../../narrative/world.js';
import { agentOf, approveOrdinary, canonSidebar } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

let w: NarrativeWorld;
let agent: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
const STORY = 'Salt Ledger';
const ids = {
  story: '',
  canonChapter: 'nasalt03',
  canonIndex: 'nasaltk1',
  epigraph: 'nasalt04',
  charters: 'nachart1',
  chartersPage: 'nachart2',
};

const audits = () => w.stack.runtime.audits;
const findings = () =>
  audits().list(PROJECT, { category: ['narrative'], acknowledged: 'include', limit: 2000 }).findings;
const kids = (id: string) => w.repo.children(id);
const named = (parent: string, name: string) => kids(parent).find((r) => r.name === name);
const tagsOf = (id: string) => w.repo.live(id)?.tags ?? [];
const proposal = (id: string) => w.stack.runtime.policy.proposals.get(id);
const blockTexts = (id: string): string[] =>
  ((w.repo.blocks.get(w.mainOf(id))?.blocks ?? []) as any[]).map((b) =>
    (b.content ?? []).map((r: any) => r.text ?? r.mention?.text ?? '').join(''),
  );
const save = (n: number, title: string, markdown: string) =>
  w.tool('arkona_chapter_save', {
    story: STORY,
    number: n,
    title,
    inWorldDate: `Camue ${n + 1}th, 4A 400`,
    pov: 'Leila Darvish',
    charactersPresent: ['Leila Darvish'],
    locations: [],
    draftStatus: 'Draft',
    markdown,
  });

beforeAll(async () => {
  w = await narrativeWorld();
  agent = await agentOf(w);
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: STORY })).status).toBe(
    'written',
  );
  for (const n of [1, 2])
    expect(
      (await w.tool('arkona_chapter_plan', { story: STORY, number: n, questionGate: 'closed' })).status,
    ).toBe('written');
  const ok = (b: any) => expect(b.status, JSON.stringify(b)).toBe('written');
  ok(
    await save(1, 'Salt Tide', 'Leila Darvish was born in 4A 700, the harbourmaster said. The tide turned.'),
  );
  ok(await save(2, 'Salt Tower', 'They climbed to the Glimmerwood Tower at dusk. The lamps burned below.'));
  // NA-42 and NA-43's chapters: Harun after his recorded death, Rashad before his recorded birth.
  for (const [n, title, date, who, md] of [
    [5, 'Salt Ghost', 'Camue 5th, 4A 401', 'Harun al-Saffar', 'Harun al-Saffar walked the harbour wall.'],
    [
      6,
      'Salt Child',
      '4A 350',
      'Rashad al-Khalid',
      'Rashad al-Khalid watched the sea from the harbour wall.',
    ],
  ] as const) {
    expect(
      (await w.tool('arkona_chapter_plan', { story: STORY, number: n, questionGate: 'closed' })).status,
    ).toBe('written');
    ok(
      await w.tool('arkona_chapter_save', {
        story: STORY,
        number: n,
        title,
        inWorldDate: date,
        pov: who,
        charactersPresent: [who],
        locations: [],
        draftStatus: 'Draft',
        markdown: md,
      }),
    );
  }
  ids.story = named(N.main, `[INDEX] ${STORY}`)!.id;
  const r = w.repo;
  // Canon in Narratives (as NA-01 and NA-06 put it there directly, or as the owner filed it): a [BSRC] page named like a
  // chapter, and a CANON-tagged index directly in a continuity (a "story" by its place).
  r.seed({
    id: ids.canonChapter,
    name: '[BSRC] Chapter 3 - The Salt Charter',
    parentId: ids.story,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.sidebars.page(ids.canonChapter, canonSidebar(ids.canonChapter, 'The Salt Charter'));
  r.seed({ id: ids.canonIndex, name: '[INDEX] Salt Kings', parentId: N.main, tags: ['CANON', 'Polity'] });
  // A CANON-tagged canon index with its page, still in canon (an agent moves it in NA-41).
  r.seed({
    id: ids.charters,
    name: '[INDEX] Salt Charters',
    parentId: O.salahadPolities,
    tags: ['CANON', 'Polity'],
  });
  r.seed({
    id: ids.chartersPage,
    name: '[BSRC] Charter of Qasr - Polity Reference',
    parentId: ids.charters,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.sidebars.page(ids.chartersPage, canonSidebar(ids.chartersPage, 'Charter of Qasr'));
  // A chapter written by hand that opens with an epigraph (a short line without a full stop), then its prose.
  r.seed({
    id: ids.epigraph,
    name: 'Chapter 4 - Ash Song',
    parentId: ids.story,
    tags: ['Narrative', 'Chapter'],
  });
  w.sidebars.page(ids.epigraph, [
    SidebarModel.kv('kvnasa04', 'PROPERTIES', [
      ['Chapter Number', '4'],
      ['In-world Date', 'Camue 20th, 4A 400'],
      ['Continuity', 'Main CANON'],
    ]),
  ]);
  r.blocks.set(w.mainOf(ids.epigraph), {
    version: 3,
    blocks: [
      { id: 'nasa04b1', kind: 'paragraph', content: [{ text: 'Ash on the water, ash on the wind' }] },
      { id: 'nasa04b2', kind: 'paragraph', content: [{ text: 'The boats came in at dusk.' }] },
    ],
  });
  w.rebuildTree();
  await w.snapshot();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('the narrative audit’s fixes on canon in Narratives', () => {
  it('NA-29: the tags fix on a [BSRC] CANON page named like a chapter never removes CANON by an ordinary approval', async () => {
    const f = findings().find((x) => x.code === 'narrative_tags' && x.pageId === ids.canonChapter);
    expect(f, 'the audit reports the canon page’s narrative tags').toBeTruthy();
    const r = (await audits().proposeFix('owner', PROJECT, f!.id)) as { status: string; proposalId: string };
    expect(r.status).toBe('proposal_captured');
    const p = proposal(r.proposalId)!;
    if (!p.requiresCanonicalApproval) {
      const done = await approveOrdinary(w, r.proposalId);
      expect(tagsOf(ids.canonChapter), `after an ordinary approval (${done.state})`).toContain('CANON');
    }
  });

  it('NA-30: the tags fix on a CANON-tagged index in a continuity never removes CANON by an ordinary approval', async () => {
    const f = findings().find((x) => x.code === 'narrative_tags' && x.pageId === ids.canonIndex);
    expect(f, 'the audit reports the index’s narrative tags').toBeTruthy();
    const r = (await audits().proposeFix('owner', PROJECT, f!.id)) as { status: string; proposalId: string };
    expect(r.status).toBe('proposal_captured');
    const p = proposal(r.proposalId)!;
    if (!p.requiresCanonicalApproval) {
      const done = await approveOrdinary(w, r.proposalId);
      expect(tagsOf(ids.canonIndex), `after an ordinary approval (${done.state})`).toContain('CANON');
    }
  });

  it('NA-41: end to end, a CANON index filed in Main CANON, then the audit’s tags fix approved ordinarily, never removes CANON', async () => {
    // The lead (CR-2026-11-R4): the owner files the index in Main CANON in the app. As first written, an agent moved it
    // (NA-06's route), which is now a canonical proposal (R4-01); the tags fix must keep CANON however it got there.
    w.repo.outside.move(ids.charters, N.main);
    w.rebuildTree();
    await w.snapshot();
    const f = findings().find((x) => x.code === 'narrative_tags' && x.pageId === ids.charters);
    expect(f, 'the audit reports the moved index’s narrative tags').toBeTruthy();
    const r = (await audits().proposeFix('owner', PROJECT, f!.id)) as { status: string; proposalId: string };
    expect(r.status).toBe('proposal_captured');
    if (!proposal(r.proposalId)!.requiresCanonicalApproval) {
      const done = await approveOrdinary(w, r.proposalId);
      expect(tagsOf(ids.charters), `after an ordinary approval (${done.state})`).toContain('CANON');
    }
  });

  it('NA-31: the dateline fix on a chapter that opens with an epigraph keeps the epigraph (“the prose is untouched”)', async () => {
    const f = findings().find((x) => x.code === 'narrative_dateline_mismatch' && x.pageId === ids.epigraph);
    expect(f, 'the audit reports the missing dateline').toBeTruthy();
    expect(f!.fix?.summary).toMatch(/the prose is untouched/);
    const r = (await audits().proposeFix('owner', PROJECT, f!.id)) as { status: string; proposalId: string };
    expect(r.status).toBe('proposal_captured');
    const done = await approveOrdinary(w, r.proposalId);
    expect(done.state).toBe('executed');
    const texts = blockTexts(ids.epigraph);
    expect(texts[0]).toBe('Camue 20th, 4A 400');
    expect(texts, JSON.stringify(texts)).toContain('Ash on the water, ash on the wind');
    expect(texts).toContain('The boats came in at dusk.');
  });
});

describe('never authority (E2.4)', () => {
  it('NA-32: arkona_chapter_check still lists a name the story invents after a narrative page carries that name', async () => {
    const before = await agent('arkona_chapter_check', { story: STORY, number: 2 });
    const candidate = (b: any) =>
      (b.items as any[] | undefined)?.find((i) => i.kind === 'name' && i.name === 'Glimmerwood Tower');
    expect(candidate(before), JSON.stringify(before).slice(0, 600)).toMatchObject({
      label: 'Not in canon (candidate)',
    });
    // The agent makes a narrative page of that name (create_resource under Narratives: direct at scope write).
    const made = await agent('create_resource', {
      name: 'Glimmerwood Tower',
      template: 'AI Narrative Story Map',
      parent: ids.story,
    });
    expect(made.status, JSON.stringify(made).slice(0, 300)).toBe('written');
    const after = await agent('arkona_chapter_check', { story: STORY, number: 2 });
    expect(candidate(after), JSON.stringify(after.items ?? after).slice(0, 600)).toMatchObject({
      label: 'Not in canon (candidate)',
    });
  });

  it('NA-33: arkona_brief on a character the chapters name lists no narrative page', async () => {
    const b = await agent('arkona_brief', { subject: 'Leila Darvish' });
    expect(b.error, JSON.stringify(b).slice(0, 300)).toBeUndefined();
    expect(JSON.stringify(b)).not.toMatch(/Salt Tide|Salt Tower|Salt Ledger|Story Map/);
  });

  it('NA-34 (control): the facts index takes no birth from a chapter', async () => {
    const asOf = await agent('arkona_as_of', { characters: ['Leila Darvish'], date: '4A 700' });
    expect(JSON.stringify(asOf)).not.toMatch(/4A 700, the harbourmaster|Salt Tide/);
    const run = await agent('arkona_consistency', { subject: 'Leila Darvish', detail: 'full' });
    expect(JSON.stringify(run)).not.toMatch(/Salt Tide|Salt Ledger/);
  });

  it('NA-35: an index named “Narratives” with a trailing no-break space (lk_api_write) does not make the facts index read the chapters', async () => {
    const b = await agent('lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: '[INDEX] Narratives\u00a0', parentId: O.arkonaIndex } },
    });
    const id = (b.result?.id as string | undefined) ?? null;
    await w.snapshot();
    // The narrative tools still see one Narratives (the tree's name rule keeps the space).
    const tools = await agent('arkona_chapter_check', { story: STORY, number: 1 });
    const run = await agent('arkona_consistency', { subject: 'Leila Darvish', detail: 'full' });
    const asOf = await agent('arkona_as_of', { characters: ['Leila Darvish'], date: '4A 700' });
    const brief = await agent('arkona_brief', { subject: 'Leila Darvish' });
    // Clean up (the owner, through the bridge), so the last test starts from one Narratives.
    if (id) await w.tool('delete_resource', { page: id, confirm: true });
    expect.soft(b.status, JSON.stringify(b).slice(0, 300)).not.toBe('succeeded');
    expect.soft(tools.error?.code, 'the narrative tools still work').toBeUndefined();
    expect.soft(JSON.stringify(run), 'arkona_consistency').not.toMatch(/Salt Tide|Salt Ledger/);
    expect.soft(JSON.stringify(asOf), 'arkona_as_of').not.toMatch(/4A 700, the harbourmaster|Salt Tide/);
    expect.soft(JSON.stringify(brief), 'arkona_brief (never a source)').not.toMatch(/Salt Tide/);
  });

  it('NA-36: a chapter moved out of Narratives into canon (move_resource) is not a direct write, and never canon evidence', async () => {
    const ch = named(ids.story, 'Chapter 1 - Salt Tide')!;
    const b = await agent('move_resource', { page: ch.id, to: K.leilaIdx });
    expect.soft(b.status, JSON.stringify(b).slice(0, 300)).not.toBe('written');
    if (b.status !== 'written') return;
    await w.snapshot();
    const run = await agent('arkona_consistency', { subject: 'Leila Darvish', detail: 'full' });
    expect.soft(JSON.stringify(run), 'arkona_consistency after the move').not.toMatch(/Salt Tide/);
    const asOf = await agent('arkona_as_of', { characters: ['Leila Darvish'], date: '4A 700' });
    expect
      .soft(JSON.stringify(asOf), 'arkona_as_of after the move')
      .not.toMatch(/Salt Tide|4A 700, the harbourmaster/);
  });

  // Chapters 5 (Harun al-Saffar after his recorded death) and 6 (Rashad al-Khalid before his recorded birth) are saved in
  // beforeAll. Their controls are checked first; then the agent moves both characters' sets (each index with its
  // Character Core) into Main CANON, directly (NA-06's route), and one snapshot later each chapter is checked again.
  const deceased = (b: any) =>
    ((b.items ?? []) as any[]).some((i) => /Harun al-Saffar is recorded deceased/.test(String(i.what)));
  const unborn = (b: any) =>
    ((b.items ?? []) as any[]).some((i) => /Rashad al-Khalid is not yet born/.test(String(i.what)));

  it('NA-42: Harun’s canon set filed in Narratives (his death also in a chronology row) still contradicts a chapter that has him alive after it', async () => {
    const h = await agent('arkona_chapter_check', { story: STORY, number: 5 });
    expect(deceased(h), `control: ${JSON.stringify(h.items).slice(0, 400)}`).toBe(true);
    const r = await agent('arkona_chapter_check', { story: STORY, number: 6 });
    expect(unborn(r), `control: ${JSON.stringify(r.items).slice(0, 400)}`).toBe(true);
    // The lead (CR-2026-11-R4): the owner files both sets in Main CANON in the app. As first written, an agent moved
    // them, which is now a canonical proposal (R4-01); canon must stay evidence however it came to be in Narratives.
    for (const idx of [K.harunIdx, K.rashadIdx]) w.repo.outside.move(idx, N.main);
    w.rebuildTree();
    await w.snapshot();
    const after = await agent('arkona_chapter_check', { story: STORY, number: 5 });
    expect(deceased(after), JSON.stringify(after.items ?? after).slice(0, 600)).toBe(true);
  });

  it('NA-43: Rashad’s canon set (his birth on his Core only) filed in Narratives still contradicts a chapter set before his birth', async () => {
    const after = await agent('arkona_chapter_check', { story: STORY, number: 6 });
    expect.soft(unborn(after), JSON.stringify(after.items ?? after).slice(0, 600)).toBe(true);
    // The lead (CR-2026-11-R4): his name still resolves to canon, never a new-lore candidate.
    const candidate = ((after.items ?? []) as any[]).filter(
      (i) => i.kind === 'name' && /Rashad al-Khalid/.test(String(i.name ?? i.what)),
    );
    expect.soft(candidate, JSON.stringify(candidate)).toEqual([]);
    const asOf = await agent('arkona_as_of', { characters: ['Rashad al-Khalid'], date: '4A 350' });
    expect.soft(JSON.stringify(asOf).slice(0, 1500), 'arkona_as_of').toMatch(/Camue 44th, 4A 360/);
  });
});
