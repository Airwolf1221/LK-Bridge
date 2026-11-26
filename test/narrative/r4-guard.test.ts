/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- tool results and the mock's state are JSON */
/**
 * CR-2026-11-R4 (ADR 0065 amendment 2): the fixes of the narrative review, beyond the reviewer's own tests
 * (test/review/r4-narrative/). Moving a page into or out of Narratives is a proposal at scope propose (canonical when
 * a page of it carries a lifecycle signal), judged again inside the lock (v3 F12, ADR 0081: at scope write it is the
 * agent's direct write, on the owner's Review page with Revert); what still holds when canon sits in a story the
 * OWNER put it in (in the app, the route an agent no longer has): the writing tools leave the story alone, the audit
 * reports the page and its tags fix only adds; the narrative indexes' names; the lifecycle tools' destinations; a
 * narrative chapter restored where it was. Against the mock LegendKeeper only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidebarModel } from '../resources/world.js';
import { O } from '../packs/f4a-world.js';
import { LIFECYCLE } from '../resources/world.js';
import { N, narrativeWorld, PROJECT, type NarrativeWorld } from './world.js';
import { withoutNarratives } from '../../src/narrative/authority.js';

let w: NarrativeWorld;
let agent: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
/** v3 F12 (ADR 0081): an agent at scope propose, where the Narratives guard's proposals are made. */
let proposer: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
const STORY = 'Lantern Road';
const ids = {
  story: '',
  map: '',
  canonPlan: 'r4gplan6',
  canonChapter: 'r4gchap4',
  charters: 'r4gchart',
  chartersPage: 'r4gchpag',
  shelf: 'r4gshelf',
  shelfPage: 'r4gshpag',
  moveIn: 'r4gmovin',
  archived: 'r4garch1',
};

const kids = (id: string) => w.repo.children(id);
const named = (parent: string, name: string) => kids(parent).find((r) => r.name === name);
const parentOf = (id: string) => w.repo.live(id)?.parentId ?? null;
const proposal = (id: string) => w.stack.runtime.policy.proposals.get(id);
const facts = (id: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of w.sidebars.pages.get(id)?.props ?? [])
    if (p.kind === 'keyValue')
      for (const r of p.rows ?? [])
        out[r.key] = (r.content as any[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  return out;
};
const findings = (code: string) =>
  w.stack.runtime.audits
    .list(PROJECT, { category: ['narrative'], acknowledged: 'include', limit: 2000 })
    .findings.filter((f: { code: string; state: string }) => f.code === code && f.state === 'open');

/** An Authoritative page's sidebar as Arkona writes it. */
function canonSidebar(id: string, subject: string) {
  return [
    SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', [
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Subject', subject],
      ['Reference Type', 'Polity Reference'],
    ]),
  ];
}

/** Waits until a proposal (and its job) ends. */
async function settled(proposalId: string): Promise<string> {
  const policy = w.stack.runtime.policy;
  for (let i = 0; i < 500; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (['executed', 'failed', 'conflicted'].includes(p.state)) {
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return p.state;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return 'timeout';
}

beforeAll(async () => {
  w = await narrativeWorld();
  const { token } = w.stack.newToken('r4-guard-agent', 'write');
  const client = await w.stack.connect(token);
  agent = async (name, args) => (await w.stack.call(client, name, args)).body;
  const proposing = await w.stack.connect(w.stack.newToken('r4-guard-proposer', 'propose').token);
  proposer = async (name, args) => (await w.stack.call(proposing, name, args)).body;
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: STORY })).status).toBe(
    'written',
  );
  expect(
    (await w.tool('arkona_chapter_plan', { story: STORY, number: 1, questionGate: 'closed' })).status,
  ).toBe('written');
  const saved = await w.tool('arkona_chapter_save', {
    story: STORY,
    number: 1,
    title: 'First Light',
    inWorldDate: 'Camue 11th, 4A 400',
    pov: 'Leila Darvish',
    charactersPresent: ['Leila Darvish'],
    locations: [],
    draftStatus: 'Draft',
    markdown: 'The lanterns were lit along the road.',
  });
  expect(saved.status, JSON.stringify(saved)).toBe('written');
  ids.story = named(N.main, `[INDEX] ${STORY}`)!.id;
  ids.map = kids(ids.story)[0]!.id;
  const r = w.repo;
  for (const [id, name, parent] of [
    [ids.canonPlan, '[BSRC] Chapter 6 Plan', O.salahadPolities],
    [ids.canonChapter, '[BSRC] Chapter 4 - The Founding', O.salahadPolities],
    [ids.shelfPage, '[BSRC] Shelf Accord - Polity Reference', O.salahadPolities],
    [ids.moveIn, '[BSRC] Lantern Accord - Polity Reference', O.salahadPolities],
  ] as const) {
    r.seed({ id, name, parentId: parent, tags: ['CANON', 'Polity'], referenceType: 'Polity Reference' });
    w.sidebars.page(id, canonSidebar(id, name));
  }
  r.seed({
    id: ids.charters,
    name: '[INDEX] Lantern Charters',
    parentId: O.salahadPolities,
    tags: ['CANON', 'Polity'],
  });
  r.seed({
    id: ids.chartersPage,
    name: '[BSRC] Charter of Lanterns - Polity Reference',
    parentId: ids.charters,
    tags: ['CANON', 'Polity'],
    referenceType: 'Polity Reference',
  });
  w.sidebars.page(ids.chartersPage, canonSidebar(ids.chartersPage, 'Charter of Lanterns'));
  r.seed({ id: ids.shelf, name: '[INDEX] Plain Shelf', parentId: O.salahad });
  r.seed({
    id: ids.archived,
    name: '[BARC] Old Lantern Law',
    parentId: LIFECYCLE.archived,
    tags: ['Archived'],
  });
  w.sidebars.page(ids.archived, [
    SidebarModel.kv('kvr4garc', 'PROPERTIES', [
      ['Status', 'Archived'],
      ['Continuity Type', 'NON-CURRENT'],
      ['Scope', 'Archived: old law'],
    ]),
  ]);
  w.rebuildTree();
  await w.snapshot();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('moving into and out of Narratives (F1)', () => {
  it('R4G-01: a narrative chapter moved out to canon is an ORDINARY proposal (no lifecycle signal) that an ordinary approval runs', async () => {
    const ch = named(ids.story, 'Chapter 1 - First Light')!;
    const b = await proposer('move_resource', { page: ch.id, to: O.salahadPolities });
    expect(b.status, JSON.stringify(b).slice(0, 400)).toBe('proposal_captured');
    expect(proposal(b.proposalId)?.requiresCanonicalApproval).toBe(false);
    expect(String(proposal(b.proposalId)?.proposedBecause)).toMatch(/into or out of Narratives/);
    expect(parentOf(ch.id)).toBe(ids.story);
    await w.stack.runtime.policy.commands.approve('owner', b.proposalId);
    expect(await settled(b.proposalId)).toBe('executed');
    expect(parentOf(ch.id)).toBe(O.salahadPolities);
    // Put it back (the owner, in the app), so the story is whole again.
    w.repo.outside.move(ch.id, ids.story);
    w.rebuildTree();
  });

  it('R4G-02: a canon page moved into a story is a CANONICAL proposal naming what loses its lifecycle; only "accept as canon" runs it', async () => {
    const b = await proposer('move_resource', { page: ids.moveIn, to: ids.story });
    expect(b.status, JSON.stringify(b).slice(0, 400)).toBe('proposal_captured');
    const p = proposal(b.proposalId)!;
    expect(p.requiresCanonicalApproval).toBe(true);
    // The agent is told, and the owner's proposal holds, which page loses its lifecycle and why.
    expect(String(b.reason)).toMatch(/Lantern Accord[^;]*loses its lifecycle/);
    expect(String(b.reason)).toMatch(/\[BSRC\] prefix/);
    expect(JSON.stringify(w.stack.runtime.policy.proposals.detail(b.proposalId))).toMatch(
      /loses its lifecycle/,
    );
    // An ordinary approval is not enough.
    await expect(w.stack.runtime.policy.commands.approve('owner', b.proposalId)).rejects.toThrow();
    expect(parentOf(ids.moveIn)).toBe(O.salahadPolities);
  });

  it('R4G-03: inside the lock: an ordinarily approved move whose destination the owner moved into Narratives in the app (the tree has not seen it) is refused', async () => {
    // v3 F12: at scope write a move into Narratives is direct, so the in-lock judgement is met by an ordinary proposal
    // (scope propose): planned as a plain move (the tree has the shelf under Salahad), approved ordinarily.
    const b = await proposer('move_resource', { page: ids.shelfPage, to: ids.shelf });
    expect(b.status, JSON.stringify(b).slice(0, 400)).toBe('proposal_captured');
    expect(proposal(b.proposalId)?.requiresCanonicalApproval).toBe(false);
    // The owner files the plain shelf under Main CANON in the app; the tree still has it under Salahad.
    w.repo.outside.move(ids.shelf, N.main);
    await w.stack.runtime.policy.commands.approve('owner', b.proposalId);
    expect(await settled(b.proposalId)).not.toBe('executed');
    expect(parentOf(ids.shelfPage)).toBe(O.salahadPolities);
    w.repo.outside.move(ids.shelf, O.salahad);
  });

  it('R4G-04: a page created under a story through the low-level tools (no narrative tool declares it) is an ordinary proposal', async () => {
    const before = kids(ids.story).length;
    const b = await proposer('lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: 'Loose Lantern Notes', parentId: ids.story } },
    });
    expect(b.status, JSON.stringify(b).slice(0, 400)).toBe('proposal_captured');
    expect(proposal(b.proposalId)?.requiresCanonicalApproval).toBe(false);
    expect(kids(ids.story).length).toBe(before);
  });

  it('R4G-05: a narrative plan the bridge deleted, restored (low-level restoreResource), comes back to its story directly (it crosses nothing)', async () => {
    const plan = named(ids.map, 'Chapter 1 Plan')!;
    const del = await w.tool('delete_resource', { page: plan.id, confirm: true });
    if (del.status === 'proposal_captured') {
      await w.stack.runtime.policy.commands.approve('owner', del.proposalId as string);
      expect(await settled(del.proposalId as string)).toBe('executed');
    } else expect(del.status, JSON.stringify(del).slice(0, 300)).toBe('written');
    expect(w.repo.live(plan.id)).toBeUndefined();
    // (This world's tree keeps the deleted node, which restore_resource reads as "not deleted": the guard is judged
    // through the low-level route, which every restore meets.)
    const b = await agent('lk_api_write', {
      operationId: 'restoreResource',
      params: { path: { resourceId: plan.id } },
    });
    expect(b.status, JSON.stringify(b).slice(0, 400)).toBe('succeeded');
    expect(parentOf(plan.id)).toBe(ids.map);
    w.rebuildTree();
  });
});

describe('canon the OWNER put in a story (in the app): the defences behind NA-22, NA-23 and NA-41', () => {
  beforeAll(async () => {
    w.repo.outside.move(ids.canonPlan, ids.map);
    w.repo.outside.move(ids.canonChapter, ids.story);
    w.repo.outside.move(ids.charters, N.main);
    w.rebuildTree();
    await w.snapshot();
  });

  it('R4G-06 (NA-22): arkona_chapter_plan refuses the story while a canon page sits in it; the canon page is untouched', async () => {
    const before = facts(ids.canonPlan).Subject;
    const b = await agent('arkona_chapter_plan', { story: STORY, number: 6, title: 'Renamed Accord' });
    expect(b.error?.code, JSON.stringify(b).slice(0, 400)).toBe('NARRATIVE_LIFECYCLE_PAGE');
    expect(facts(ids.canonPlan).Subject).toBe(before);
  });

  it('R4G-07 (NA-23): arkona_chapter_insert and arkona_chapter_save refuse it too; the canon page keeps [BSRC]', async () => {
    const ins = await agent('arkona_chapter_insert', { story: STORY, at: 1, title: 'Interlude' });
    expect(ins.error?.code, JSON.stringify(ins).slice(0, 400)).toBe('NARRATIVE_LIFECYCLE_PAGE');
    const save = await agent('arkona_chapter_save', {
      story: STORY,
      number: 4,
      title: 'Founding',
      inWorldDate: 'Camue 14th, 4A 400',
      pov: 'Leila Darvish',
      charactersPresent: ['Leila Darvish'],
      locations: [],
      draftStatus: 'Draft',
      markdown: 'A founding.',
    });
    expect(save.error?.code, JSON.stringify(save).slice(0, 400)).toBe('NARRATIVE_LIFECYCLE_PAGE');
    expect(w.repo.live(ids.canonChapter)!.name).toBe('[BSRC] Chapter 4 - The Founding');
  });

  it('R4G-08: the narrative audit reports each page with a lifecycle signal in Narratives (narrative_lifecycle_page, no fix)', () => {
    const got = findings('narrative_lifecycle_page');
    for (const id of [ids.canonPlan, ids.canonChapter, ids.charters, ids.chartersPage])
      expect(
        got.some((f) => f.pageId === id),
        id,
      ).toBe(true);
    expect(got.every((f: { fix?: unknown }) => !f.fix)).toBe(true);
  });

  it('R4G-09 (NA-41): the tags fix on the CANON index the owner filed in Main CANON only ADDS tags; an ordinary approval runs it and CANON stays', async () => {
    const f = findings('narrative_tags').find((x) => x.pageId === ids.charters);
    expect(f, 'the audit reports the index’s narrative tags').toBeTruthy();
    const r = (await w.stack.runtime.audits.proposeFix('owner', PROJECT, f!.id)) as {
      status: string;
      proposalId: string;
    };
    expect(r.status).toBe('proposal_captured');
    expect(proposal(r.proposalId)?.requiresCanonicalApproval).toBe(false);
    await w.stack.runtime.policy.commands.approve('owner', r.proposalId);
    expect(await settled(r.proposalId)).toBe('executed');
    const tags = w.repo.live(ids.charters)!.tags;
    expect(tags).toContain('CANON');
    expect(tags).toContain('Narrative');
    expect(tags).toContain('Polity');
  });
});

describe('the narrative indexes and the lifecycle tools (F4, F7)', () => {
  it('R4G-10: no page is given a narrative index’s name, in any spelling (low-level create, update_resource)', async () => {
    const c1 = await agent('lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: '[INDEX] Ｃontinuities', parentId: O.arkonaIndex } },
    });
    expect(c1.status, JSON.stringify(c1).slice(0, 300)).not.toBe('succeeded');
    const c2 = await agent('create_bare_resource', { name: '[INDEX] main canon', parent: O.arkonaIndex });
    expect(c2.status, JSON.stringify(c2).slice(0, 300)).not.toBe('written');
    const rn = await agent('update_resource', {
      page: ids.shelf,
      name: 'Continuities',
      plainRename: { reason: 'testing the narrative names' },
    });
    expect(rn.status, JSON.stringify(rn).slice(0, 300)).not.toBe('written');
    expect(w.repo.live(ids.shelf)!.name).toBe('[INDEX] Plain Shelf');
  });

  it('R4G-11: a story titled as a narrative index is refused before anything is planned (NARRATIVE_INDEX_NAME)', async () => {
    const b = await agent('arkona_story_create', { continuity: 'Main CANON', title: 'Continuities' });
    expect(b.error?.code, JSON.stringify(b).slice(0, 300)).toBe('NARRATIVE_INDEX_NAME');
  });

  it('R4G-12: unarchive_page with a destination inside Narratives is refused (NARRATIVE_NO_LIFECYCLE)', async () => {
    const b = await agent('unarchive_page', {
      page: ids.archived,
      previousState: 'authoritative',
      restore: { continuityType: 'CANON', scope: 'Old lantern law', temporalScope: '4A 300' },
      destination: N.main,
      dryRun: true,
    });
    expect(b.error?.code, JSON.stringify(b).slice(0, 400)).toBe('NARRATIVE_NO_LIFECYCLE');
  });
});

describe('the facts index leaves out every candidate Narratives (F4, fail closed for authority)', () => {
  const page = (id: string, parentId: string | null, displayName: string, kind = 'page') =>
    [id, { id, parentId, displayName, kind }] as const;
  const pages = new Map(
    [
      page('root', null, 'AI REPOSITORY', 'root'),
      page('narr1', 'root', 'Narratives', 'index'),
      page('narr2', 'root', 'Narratives', 'index'),
      page('ch1', 'narr1', 'Chapter 1 - A'),
      page('ch2', 'narr2', 'Chapter 1 - B'),
      page('canon', 'root', 'Polity Reference'),
    ].map(([k, v]) => [k, v as any]),
  );

  it('R4G-13: by the tree’s ids (the narrative tools’ resolution): one root, or every candidate when ambiguous', () => {
    expect([...withoutNarratives(pages, { name: 'Narratives', roots: ['narr1'] }).keys()].sort()).toEqual(
      ['canon', 'ch2', 'narr1', 'narr2', 'root'].sort(),
    );
    expect(
      [...withoutNarratives(pages, { name: 'Narratives', roots: ['narr1', 'narr2'] }).keys()].sort(),
    ).toEqual(['canon', 'narr1', 'narr2', 'root'].sort());
    // The tree cannot answer: the overlay's names, every candidate left out (before, two left none out).
    expect([...withoutNarratives(pages, { name: 'Narratives', roots: null }).keys()].sort()).toEqual(
      ['canon', 'narr1', 'narr2', 'root'].sort(),
    );
  });
});
