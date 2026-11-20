/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- tool results and the mock's state are JSON */
/**
 * v3 F4c (ADR 0065; design E2, E4, E8): the Narrative Integrity audit (category `narrative`) and the narrative pages'
 * exemptions, against the REAL stack on the mock LegendKeeper: silent on a tree the tools made; every code on a
 * fixture; the mechanical fixes are proposals and never touch the prose; the ordering audit uses the narrative order;
 * the owner rules, the tagging grammar and the lifecycle tools leave narrative pages alone; fiction is never authority.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidebarModel } from '../resources/world.js';
import { approve } from '../packs/world.js';
import { K, N, narrativeWorld, PROJECT, type NarrativeWorld } from './world.js';

let w: NarrativeWorld;
beforeAll(async () => {
  w = await narrativeWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const audits = () => w.stack.runtime.audits;
const findings = (category = 'narrative') =>
  audits().list(PROJECT, { category: [category], acknowledged: 'include', limit: 1000 }).findings;
const codes = () => findings().map((f) => f.code);
const kids = (id: string) => w.repo.children(id);
const named = (parent: string, name: string) => kids(parent).find((r) => r.name === name)!;
const save = (story: string, n: number, title: string, date: string, more: Record<string, unknown> = {}) =>
  w.tool('arkona_chapter_save', {
    story,
    number: n,
    title,
    inWorldDate: date,
    pov: 'Leila Darvish',
    charactersPresent: ['Leila Darvish'],
    locations: [],
    draftStatus: 'Draft',
    markdown: 'Leila Darvish was born in 4A 700, the harbourmaster said. The tide turned.',
    ...more,
  });

describe('the narrative audit on a tree the tools made (E4, E8)', () => {
  it('reports only the AU without its index; its fix is ONE proposal that makes the index tagged Narrative and AU', async () => {
    expect(
      (
        await w.tool('arkona_story_create', {
          continuity: 'Main CANON',
          title: 'Tide Tables',
          acts: ['Ebb', 'Flood'],
        })
      ).status,
    ).toBe('written');
    for (const [n, act] of [
      [1, 1],
      [2, 1],
      [3, 2],
    ] as const) {
      expect(
        (
          await w.tool('arkona_chapter_plan', {
            story: 'Tide Tables',
            number: n,
            act,
            questionGate: 'closed',
          })
        ).status,
      ).toBe('written');
      const b = await save('Tide Tables', n, `Tide ${n}`, `Camue ${n + 1}th, 4A 400`);
      expect(b.status, JSON.stringify(b)).toBe('written');
    }
    await w.snapshot();
    expect(codes()).toEqual(['narrative_au_index_missing']);
    // The ordering audit is silent on Narratives in narrative order (Story Map first, Act 1 then Act 2).
    expect(
      findings('ordering')
        .filter((f) => f.state === 'open')
        .map((f) => f.pageName),
    ).not.toEqual(expect.arrayContaining([expect.stringMatching(/Story Map|Act \d|Chapter \d/)]));
    const f = findings().find((x) => x.code === 'narrative_au_index_missing')!;
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    expect(r.status).toBe('proposal_captured');
    expect(kids(N.narratives).some((x) => x.name === '[INDEX] Moonfall')).toBe(false);
    const done = await approve(w, (r as { proposalId: string }).proposalId);
    expect(done.state).toBe('executed');
    const moon = named(N.narratives, '[INDEX] Moonfall');
    expect(moon.tags).toEqual(['Narrative', 'AU']);
    await w.snapshot();
    expect(codes()).toEqual([]);
  });

  it('narrative pages are not unclassified, follow no owner rule, no tagging grammar and no lifecycle check', () => {
    const narrative = new Set(w.repo.subtree(N.narratives).map((r) => r.id));
    narrative.delete(N.narratives);
    const other = audits()
      .list(PROJECT, { acknowledged: 'include', limit: 5000 })
      .findings.filter(
        (f) =>
          f.category !== 'narrative' && f.pageId !== null && narrative.has(f.pageId) && f.state === 'open',
      );
    expect(other.map((f) => `${f.code} ${f.pageName}`)).toEqual([]);
  });
});

describe('exemptions and authority (E2)', () => {
  it('the lifecycle tools refuse a narrative page with NARRATIVE_NO_LIFECYCLE', async () => {
    const ch = named(
      named(named(N.main, '[INDEX] Tide Tables').id, '[INDEX] Act 1 - Ebb').id,
      'Chapter 1 - Tide 1',
    );
    for (const tool of ['promote_page', 'archive_page', 'move_to_working'])
      expect((await w.tool(tool, { page: ch.id })).error?.code, tool).toBe('NARRATIVE_NO_LIFECYCLE');
  });

  it('the appraisal (owner body rules, completion gate, split triggers) refuses a chapter and skips Narratives', async () => {
    const ch = named(
      named(named(N.main, '[INDEX] Tide Tables').id, '[INDEX] Act 1 - Ebb').id,
      'Chapter 1 - Tide 1',
    );
    expect((await w.tool('arkona_appraise_owner', { page: ch.id })).error?.code).toBe('NARRATIVE_EXEMPT');
    const branch = await w.tool('arkona_appraise_owner', { under: 'Narratives' });
    // At most the Narratives index itself (an ordinary index); never a page under it.
    expect(branch.inspected?.pages ?? 0).toBeLessThanOrEqual(1);
    expect(JSON.stringify(branch)).not.toMatch(/Tide \d|Story Map/);
  });

  it('the retag audit leaves Narratives alone', async () => {
    const b = await w.tool('arkona_retag_audit', { under: 'Narratives', detail: 'full' });
    const pages = (b.pages ?? b.records ?? []) as any[];
    expect(
      pages.every(
        (p) => p.excluded === undefined || p.excluded.code === 'narrative' || p.excluded?.code === 'index',
      ),
    ).toBe(true);
    expect(JSON.stringify(b)).not.toMatch(/"disposition":"correction"/);
  });

  it('never authority: a birth a chapter states is not taken by the facts index, the consistency check or the brief', async () => {
    const asOf = await w.tool('arkona_as_of', { characters: ['Leila Darvish'], date: '4A 700' });
    expect(JSON.stringify(asOf)).not.toMatch(/4A 700, the harbourmaster/);
    expect(asOf.characters[0].born?.value ?? asOf.characters[0].born).not.toMatch(/4A 700/);
    const run = await w.tool('arkona_consistency', { subject: 'Leila Darvish', detail: 'full' });
    expect(JSON.stringify(run)).not.toMatch(/Tide \d|Narratives/);
    const ch = named(
      named(named(N.main, '[INDEX] Tide Tables').id, '[INDEX] Act 1 - Ebb').id,
      'Chapter 1 - Tide 1',
    );
    expect((await w.tool('arkona_brief', { subject: ch.id })).error?.code).toBe('NARRATIVE_NOT_AUTHORITY');
  });

  it('create_resource under Narratives: no prefix, the narrative tags, no status', async () => {
    const story = named(N.main, '[INDEX] Tide Tables');
    const map = named(story.id, 'Story Map');
    const refused = await w.tool('create_resource', {
      name: 'Loose Notes',
      template: 'AI Narrative Chapter Plan',
      parent: map.id,
      status: 'working',
    });
    expect(refused.error.code).toBe('NARRATIVE_NO_LIFECYCLE');
    const b = await w.tool('create_resource', {
      name: 'Life or Chronology Map',
      template: 'AI Narrative Story Map',
      parent: N.main,
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
    const page = named(N.main, 'Life or Chronology Map');
    expect(page.tags).toEqual(['Narrative', 'Chronology Map']);
    // The Chronology Map goes first in its continuity (the narrative order).
    expect(kids(N.main)[0]!.name).toBe('Life or Chronology Map');
  });
});

describe('every code on a fixture; the fixes are proposals and never the prose', () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const r = w.repo;
    const sb = w.sidebars;
    const seed = (key: string, name: string, parentId: string, tags: string[] = []) => {
      ids[key] = r.seed({ name, parentId, tags }).id;
      return ids[key];
    };
    seed('elsewhere', '[INDEX] Elsewhere', N.narratives);
    seed('canon', '[INDEX] CANON Tales', N.main, ['Narrative', 'Story']);
    const bad = seed('bad', '[INDEX] Broken Bell', N.main, ['Narrative', 'Story']);
    seed('act1', '[INDEX] Act 1 - Ringing', bad, ['Narrative', 'Act']);
    seed('act2', '[INDEX] Act 2 - Silence', bad, ['Narrative', 'Act']);
    const map = seed('map', 'Story Map', bad, ['Narrative', 'Story Map']);
    seed('notes', 'Loose Notes', bad, ['Narrative']);
    const am1 = seed('am1', 'Act 1 Map', map, ['Narrative', 'Act Map']);
    seed('am2', 'Act 2 Map', map, ['Narrative', 'Act Map']);
    const c1 = seed('c1', 'Chapter 1 - First', ids.act1!, ['Narrative', 'Chapter']);
    const c1b = seed('c1b', 'Chapter 1 - Twin', ids.act1!); // duplicate number, no tags
    const c3 = seed('c3', 'Chapter 3 - Third', ids.act1!, ['Narrative', 'Chapter']);
    const p3 = seed('p3', 'Chapter 3 Plan', am1, ['Narrative', 'Chapter Plan']);
    const p5 = seed('p5', 'Chapter 5 Plan', am1, ['Narrative', 'Chapter Plan']);
    sb.page(map, [
      SidebarModel.kv(`kv${map}`.slice(0, 8), 'PROPERTIES', [['Story Span', '4A 400 - 4A 401']]),
    ]);
    const chapterRows = (n: string, date: string, more: [string, string][] = []) =>
      [
        ['Chapter Number', n],
        ['In-world Date', date],
        ['Continuity', 'Main CANON'],
        ['Chapter Plan', ''],
        ['POV', 'Link to the POV character'],
        ...more,
      ] as [string, string][];
    sb.page(c1, [
      SidebarModel.kv(
        'kvc10001',
        'PROPERTIES',
        chapterRows('1', 'Camue 9th, 4A 400', [['Act', 'Act 2 - Silence']]),
      ),
    ]);
    sb.page(c1b, [SidebarModel.kv('kvc1b001', 'PROPERTIES', chapterRows('1', 'someday'))]);
    sb.page(c3, [
      SidebarModel.kv('kvc30001', 'PROPERTIES', [
        ['Chapter Number', '4'],
        ['In-world Date', 'Camue 2nd, 4A 399'],
        ['Continuity', 'Moonfall'],
        ['Chapter Plan', ''],
      ]),
    ]);
    sb.page(p3, [
      SidebarModel.kv('kvp30001', 'PROPERTIES', [
        ['Chapter Number', '3'],
        ['Chapter', 'Third'],
        ['Question Gate', 'Open'],
        ['Planning Status', 'Drafted'],
      ]),
    ]);
    sb.page(p5, [
      SidebarModel.kv('kvp50001', 'PROPERTIES', [
        ['Chapter Number', '5'],
        ['Planning Status', 'Drafted'],
      ]),
    ]);
    r.blocks.set(w.mainOf(c1), {
      version: 1,
      blocks: [
        { id: 'c1b1', kind: 'paragraph', content: [{ text: 'It was dark.' }] },
        { id: 'c1b2', kind: 'paragraph', content: [{ text: 'The bell rang.' }] },
      ],
    });
    r.blocks.set(w.mainOf(c3), {
      version: 1,
      blocks: [{ id: 'c3b1', kind: 'paragraph', content: [{ text: 'Camue 2nd, 4A 402' }] }],
    });
    // The Story Map not first: the act indexes were seeded before it.
    w.rebuildTree();
    await w.snapshot();
  }, 120_000);

  it('every code fires', () => {
    const got = new Set(codes());
    for (const c of [
      'narrative_unknown_continuity',
      'narrative_reserved_word',
      'narrative_story_map_missing',
      'narrative_story_map_not_first',
      'narrative_empty_act',
      'narrative_unnamed',
      'narrative_tags',
      'narrative_number_gap',
      'narrative_number_duplicate',
      'narrative_number_mismatch',
      'narrative_chapter_without_plan',
      'narrative_plan_drafted_without_chapter',
      'narrative_link_broken',
      'narrative_gate_open',
      'narrative_wrong_act',
      'narrative_continuity_mismatch',
      'narrative_dateline_mismatch',
      'narrative_date_unreadable',
      'narrative_date_backwards',
      'narrative_date_outside_span',
      'narrative_placeholder',
    ])
      expect(got.has(c as never), c).toBe(true);
  });

  it('the dateline fix is ONE proposal; approved, only the first line changes (the prose untouched)', async () => {
    const f = findings().find((x) => x.code === 'narrative_dateline_mismatch' && x.pageId === ids.c1)!;
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    expect(r.status).toBe('proposal_captured');
    expect((w.repo.blocks.get(w.mainOf(ids.c1!))!.blocks as any[])[0].content[0].text).toBe('It was dark.');
    const done = await approve(w, (r as { proposalId: string }).proposalId);
    expect(done.state).toBe('executed');
    const blocks = w.repo.blocks.get(w.mainOf(ids.c1!))!.blocks as any[];
    expect(blocks.map((b) => b.content.map((x: any) => x.text).join(''))).toEqual([
      'Camue 9th, 4A 400',
      'It was dark.',
      'The bell rang.',
    ]);
  });

  it('the tags, number and Story Map order fixes are proposals; no fix ever carries prose', async () => {
    for (const code of ['narrative_tags', 'narrative_number_mismatch', 'narrative_story_map_not_first']) {
      const f = findings().find((x) => x.code === code && x.state === 'open')!;
      expect(f.fix, code).toBeTruthy();
      const r = await audits().proposeFix('owner', PROJECT, f.id);
      expect(r.status, code).toBe('proposal_captured');
      const p = w.stack.runtime.policy.proposals.get((r as { proposalId: string }).proposalId)!;
      expect(JSON.stringify(p)).not.toMatch(/replaceDocumentBlocks|The bell rang|It was dark/);
    }
    for (const f of findings())
      if (f.fix) expect(['narrative', 'set_facts', 'move_resource']).toContain(f.fix.kind);
  });

  it('a missing Main CANON is reported (and so is a missing Narratives)', async () => {
    w.repo.outside.rename(N.main, '[INDEX] Main Stories');
    w.rebuildTree();
    await w.snapshot();
    expect(codes()).toContain('narrative_main_index_missing');
    w.repo.outside.rename(N.narratives, '[INDEX] Stories');
    w.rebuildTree();
    await w.snapshot();
    expect(codes()).toContain('narrative_root_missing');
    void K;
  }, 120_000);
});
