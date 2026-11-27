/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- tool JSON and mock rows */
/**
 * v3 F6d (ADR 0082) end to end, against the mock LegendKeeper (the automation world, never fetched):
 *
 * - the report from the snapshots: every status, the registered character left out, a specialist type exempt, a
 *   collision of two renames, the counts; the role words read from the PUBLISHED vocabulary;
 * - `name_nontemplated`: one finding per rename row, none for held rows;
 * - the code at Propose: ONE proposal with three items (one per page); one approved, two left out (rejected);
 * - the code at Apply: a Working page's rename as ONE job, read back; a mention on another page shows the new name, a
 *   routing line naming the old name follows, other text is listed for review only; an Authoritative page's rename is
 *   the canon guard's canonical proposal (recorded as guarded; nothing forced, the code not paused);
 * - the stale refusal; "Keep this name" lapsing when the Subject changes; Undo.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROOT } from '../discover/world.js';
import { LIFECYCLE } from '../resources/world.js';
import { PINNED } from '../packs/owners-world.js';
import { automationWorld, PROJECT, type AutomationWorld } from '../automation/world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';

vi.setConfig({ testTimeout: 240_000 });

const DESK = 'tndesk01';
const D = {
  falken: 'tnfalk01', // [BSRC] Falkenreich Polity Reference → Falkenreich - Polity
  shahravi: 'tnshah01', // [BSRC] Shahravi Overview → Shahravi - Culture
  valdris: 'tnvald01', // [BSRC] Valdris Polity Notes → Valdris - Polity
  ostmark: 'tnostm01', // [BSRC] Ostmark - Polity: templated already
  noSubject: 'tnnosb01', // [BSRC] Mithral Polity: no Subject (held), filled in later
  emDash: 'tnemds01', // [BSRC] Brann Polity: Subject with an em dash (held)
  charter: 'tnchar01', // [BSRC] Imperial Charter: a specialist type (exempt)
  korrA: 'tnkora01', // [BSRC] Korr Polity Reference → Korr - Polity
  korrB: 'tnkorb01', // [BSRC] Korr Overview → Korr - Polity as well: both held
  hero: 'tnhero01', // [BSRC] Aria - Character Core: a character's page (out of scope)
  mentions: 'tnment01', // [BSRC] Desk Notes: a mention of the Working page, and its old name in prose
  working: 'tnwork01', // [BWRK] Valdris Draft: no Subject at first; later Subject Ostlund → Ostlund - Polity
} as const;
const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
];

let w: AutomationWorld;
let http: OwnerHttp;
const rt = () => w.stack.runtime;
const svc = () => rt().templatedNames;
const a = () => rt().automation;
const live = (id: string) => w.repo.live(id) as any;
const OURS = new Set<string>(Object.values(D));
const findings = () =>
  rt()
    .audits.store.list(PROJECT, { code: ['name_nontemplated'], state: 'open', limit: 5000 })
    .findings.filter((f) => OURS.has(f.pageId ?? ''));
/** A run acting only on this file's pages (the world's own pages have templated-name findings too). */
const runOurs = () => a().run(PROJECT, 'manual', { onlyPages: OURS });
const why = (
  xs: { pageId: string | null; outcome: string; reasonCode: string | null; reason: string | null }[],
) => JSON.stringify(xs.map((x) => [x.pageId, x.outcome, x.reasonCode, x.reason]));
const rowOf = (pageId: string) =>
  svc()
    .report(PROJECT, { page: pageId, limit: 5 })
    .rows.find((r) => r.pageId === pageId)!;
const auditNow = async () => {
  await w.snapshot();
  const r = await rt().audits.run(PROJECT, 'manual');
  expect(r.state, r.summary).toBe('succeeded');
};
const textOf = (b: any): string =>
  ((b.content ?? []) as any[]).map((r) => r.text ?? r.mention?.text ?? r.mention?.name ?? '').join('');

beforeAll(async () => {
  // Several full snapshots in one file: limits well above the mock's hour (bulk reads keep the night's floor).
  const big = { 'key-min': 100_000, 'key-hour': 1_000_000, 'key-day': 10_000_000, 'project-hour': 1_000_000 };
  w = await automationWorld({
    bulk: 40,
    env: { LK_TIER_LIMITS: JSON.stringify(big) },
    limits: big,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: DESK, name: '[INDEX] Name Desk', parentId: ROOT, tags: ['Polity'] });
      const page = (
        id: string,
        name: string,
        tags: string[],
        referenceType: string,
        subject: string | null,
        parentId: string = DESK,
        rows = CANON_ROWS,
      ) => {
        r.seed({ id, name, parentId, tags, referenceType });
        for (const [k, v] of rows) r.outside.setRow(id, k, v);
        if (subject !== null) r.outside.setRow(id, 'Subject', subject);
      };
      page(
        D.falken,
        '[BSRC] Falkenreich Polity Reference',
        ['CANON', 'Polity'],
        'Polity Reference',
        'Falkenreich',
      );
      page(D.shahravi, '[BSRC] Shahravi Overview', ['CANON', 'Culture'], 'Culture Reference', 'Shahravi');
      page(D.valdris, '[BSRC] Valdris Polity Notes', ['CANON', 'Polity'], 'Polity Reference', 'Valdris');
      page(D.ostmark, '[BSRC] Ostmark – Polity', ['CANON', 'Polity'], 'Polity Reference', 'Ostmark');
      page(D.noSubject, '[BSRC] Mithral Polity', ['CANON', 'Polity'], 'Polity Reference', null);
      page(D.emDash, '[BSRC] Brann Polity', ['CANON', 'Polity'], 'Polity Reference', 'Brann—Holt');
      page(
        D.charter,
        '[BSRC] Imperial Charter',
        ['CANON', 'Polity'],
        'Imperial Charter Reference',
        'Charter',
      );
      page(D.korrA, '[BSRC] Korr Polity Reference', ['CANON', 'Polity'], 'Polity Reference', 'Korr');
      page(D.korrB, '[BSRC] Korr Overview', ['CANON', 'Polity'], 'Polity Reference', 'Korr');
      page(D.hero, '[BSRC] Aria - Character Core', ['CANON', 'Character'], 'Character Core', 'Aria');
      page(D.mentions, '[BSRC] Desk Notes', ['CANON', 'Polity'], 'General Source', null);
      page(
        D.working,
        '[BWRK] Valdris Draft',
        ['Working', 'Polity'],
        'Polity Reference',
        null,
        LIFECYCLE.working,
        [['Status', 'Working']],
      );
      // The desk's routing section names the Working page by its old name; another page mentions it and names it in prose.
      const main = (id: string) => r.live(id)!.docs[0]!;
      r.blocks.set(main(DESK), {
        version: 1,
        blocks: [
          { id: 'tnr00001', kind: 'heading', level: 2, content: [{ text: 'How to Use This Index' }] },
          {
            id: 'tnr00002',
            kind: 'paragraph',
            content: [{ text: 'Valdris Draft: the working polity notes.' }],
          },
        ],
      });
      r.blocks.set(main(D.mentions), {
        version: 1,
        blocks: [
          {
            id: 'tnm00001',
            kind: 'paragraph',
            content: [{ text: 'See ' }, { mention: { resourceId: D.working } }, { text: ' for more.' }],
          },
          {
            id: 'tnm00002',
            kind: 'paragraph',
            content: [{ text: 'The Valdris Draft was begun in the spring.' }],
          },
        ],
      });
    },
  });
  // Source Formatting gains "Sidebar Metadata", and the vocabulary's section is pinned (as F6a's world does).
  const packs = rt().packs;
  const pack = packs.get('arkona')!;
  const src = pack.governance.find((g) => g.key === 'source-formatting')!;
  const doc = w.repo.blocks.get(src.documentId)!;
  doc.blocks.push(
    { id: 'tnsbm001', kind: 'heading', level: 2, content: [{ text: 'Sidebar Metadata' }] },
    { id: 'tnsbm002', kind: 'paragraph', content: [{ text: 'Every page carries PROPERTIES.' }] },
  );
  doc.version++;
  packs.store.setGovernance(
    'arkona',
    pack.governance.map((g) =>
      g.key === 'source-formatting'
        ? { ...g, sections: [...PINNED.formatting, 'Reference Type Vocabulary'] }
        : g,
    ),
  );
  await packs.commands.approve('owner', 'arkona');
  await w.snapshot();
  http = ownerHttp(w);
});
afterAll(async () => w?.close());

describe('the vocabulary not published yet', () => {
  it('every row is held_type “the vocabulary is not published”; no finding', async () => {
    await auditNow();
    const r = svc().report(PROJECT, { limit: 500 });
    expect(r.state).toBe('ready');
    expect(r.vocabulary).toBe('draft');
    expect(rowOf(D.falken)).toMatchObject({ status: 'held_type', reason: 'the vocabulary is not published' });
    expect(r.counts.rename).toBe(0);
    expect(findings()).toEqual([]);
  });
});

describe('the vocabulary published (a specialist type with it)', () => {
  beforeAll(async () => {
    const reftypes = rt().referenceTypes;
    await reftypes.prepare(PROJECT);
    reftypes.decide('owner', PROJECT, {
      value: 'Imperial Charter Reference',
      category: 'Polity',
      action: 'specialist',
      scope: 'category',
      reason: 'a charter keeps its name',
    });
    const pub = await reftypes.publish('owner', PROJECT);
    const job = await rt().engine.wait(PROJECT, pub.jobId!, 20_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    await rt().packs.governance('arkona');
    await rt()
      .packs.commands.approve('owner', 'arkona')
      .catch(async () => rt().packs.commands.approve('owner', 'arkona'));
    expect(rt().packs.approvedRules('arkona')!.referenceTypes!.status).toBe('published');
    await auditNow();
  });

  it('each row’s status, from the published role words', () => {
    expect(rowOf(D.falken)).toMatchObject({
      status: 'rename',
      proposed: '[BSRC] Falkenreich - Polity',
      role: 'Polity',
    });
    expect(rowOf(D.shahravi)).toMatchObject({ status: 'rename', proposed: '[BSRC] Shahravi - Culture' });
    expect(rowOf(D.valdris)).toMatchObject({ status: 'rename', proposed: '[BSRC] Valdris - Polity' });
    expect(rowOf(D.ostmark).status).toBe('templated');
    expect(rowOf(D.noSubject).status).toBe('held_no_subject');
    expect(rowOf(D.emDash)).toMatchObject({
      status: 'held_no_subject',
      reason: 'Subject uses an em dash; fix the Subject first',
    });
    expect(rowOf(D.charter).status).toBe('exempt_specialist');
    expect(rowOf(D.korrA)).toMatchObject({ status: 'held_collision', other: { id: D.korrB } });
    expect(rowOf(D.korrB)).toMatchObject({ status: 'held_collision', other: { id: D.korrA } });
    expect(rowOf(D.working).status).toBe('held_no_subject');
    // A registered character's page is out of scope (counted).
    expect(rowOf(D.hero)).toBeUndefined();
    expect(svc().report(PROJECT).meta!.excluded['registered character']).toBeGreaterThan(0);
  });

  it('the counts and filters (the dashboard route)', async () => {
    const r = await http.get(`/templated-names?status=rename&category=Polity`);
    expect(r.status).toBe(200);
    const rows = (r.json.report.rows as any[]).filter((x) => OURS.has(x.pageId as string));
    expect(rows.map((x) => x.pageId).sort()).toEqual([D.falken, D.valdris].sort());
    expect(r.json.report.rows.every((x: any) => x.status === 'rename' && x.category === 'Polity')).toBe(true);
    const all = await http.get(`/templated-names`);
    expect(all.json.report.counts.rename).toBeGreaterThan(r.json.report.counts.rename as number);
    expect(Object.keys(all.json.report.counts as object).sort()).toEqual([
      'exempt_specialist',
      'held_collision',
      'held_no_subject',
      'held_type',
      'kept',
      'rename',
      'templated',
    ]);
  });

  it('name_nontemplated: one finding per rename row, none for the held rows', () => {
    const f = findings();
    expect(f.map((x) => x.pageId).sort()).toEqual([D.falken, D.shahravi, D.valdris].sort());
    expect(f.find((x) => x.pageId === D.falken)!.fix).toMatchObject({
      kind: 'templated_name',
      args: { to: '[BSRC] Falkenreich - Polity', subject: 'Falkenreich', referenceType: 'Polity Reference' },
    });
  });

  it('a stale fix is refused: the Subject changed since the finding', async () => {
    w.repo.outside.setRow(D.valdris, 'Subject', 'Valdrisia');
    const f = findings().find((x) => x.pageId === D.valdris)!;
    await expect(rt().audits.proposeFix('owner', PROJECT, f.id, {})).rejects.toMatchObject({
      code: 'FIX_STALE',
      message: expect.stringContaining('Subject is “Valdrisia” now'),
    });
    w.repo.outside.setRow(D.valdris, 'Subject', 'Valdris');
  });
});

describe('the code at Propose: ONE proposal, an item per page', () => {
  let proposalId: string;
  it('is Off by default; at Propose a run makes one proposal with three items, in the run order', async () => {
    expect(
      a()
        .codes(PROJECT)
        .find((c) => c.code === 'name_nontemplated')!.mode,
    ).toBe('off');
    await a().setMode('owner', PROJECT, 'name_nontemplated', 'propose');
    const run = await runOurs();
    expect(run.state, run.summary ?? '').toBe('succeeded');
    const items = a()
      .store.items(run.id)
      .filter((i) => i.code === 'name_nontemplated');
    expect(items, why(items)).toHaveLength(3);
    expect(
      items.every((i) => i.outcome === 'proposed'),
      why(items),
    ).toBe(true);
    expect(new Set(items.map((i) => i.proposalId)).size).toBe(1);
    // Primary category, then name: Culture (Shahravi) before Polity (Falkenreich, Valdris).
    expect(items.map((i) => i.pageId)).toEqual([D.shahravi, D.falken, D.valdris]);
    proposalId = items[0]!.proposalId!;
    const its = rt().policy.proposals.itemsOf(proposalId)!.items;
    expect(its.map((i) => i.id).sort()).toEqual(
      [`page:${D.falken}`, `page:${D.shahravi}`, `page:${D.valdris}`].sort(),
    );
    expect(a().store.setting(PROJECT, 'name_nontemplated')?.pausedAt ?? null).toBeNull();
  });

  it('one approved, two left out: only that page is renamed', async () => {
    const policy = rt().policy;
    const p = policy.proposals.get(proposalId)!;
    const items = [`page:${D.falken}`];
    if (p.requiresCanonicalApproval) await policy.commands.approveAsCanon('owner', proposalId, { items });
    else await policy.commands.approve('owner', proposalId, { items });
    for (let i = 0; i < 400; i++) {
      const s = policy.proposals.get(proposalId)!;
      if (['executed', 'failed', 'conflicted'].includes(s.state)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const done = policy.proposals.get(proposalId)!;
    expect(done.state).toBe('executed');
    const job = rt().engine.queries.getJob(PROJECT, done.jobId!)!;
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(live(D.falken).name).toBe('[BSRC] Falkenreich - Polity');
    expect(live(D.shahravi).name).toBe('[BSRC] Shahravi Overview');
    expect(live(D.valdris).name).toBe('[BSRC] Valdris Polity Notes');
    // The id, the parent, the tags stay.
    expect(live(D.falken)).toMatchObject({ parentId: DESK, tags: ['CANON', 'Polity'] });
  });

  it('a later run does not propose the left-out pages again (the owner decided them once)', async () => {
    await auditNow();
    const run = await runOurs();
    expect(
      a()
        .store.items(run.id)
        .filter((i) => i.code === 'name_nontemplated'),
    ).toEqual([]);
  });
});

describe('the code at Apply: ONE job per page, read back', () => {
  beforeAll(async () => {
    // The owner fills in the held rows' Subjects.
    w.repo.outside.setRow(D.working, 'Subject', 'Ostlund');
    w.repo.outside.setRow(D.noSubject, 'Subject', 'Mithral');
    await auditNow();
    expect(rowOf(D.working)).toMatchObject({ status: 'rename', proposed: '[BWRK] Ostlund - Polity' });
    expect(rowOf(D.noSubject)).toMatchObject({ status: 'rename', proposed: '[BSRC] Mithral - Polity' });
    await a().setMode('owner', PROJECT, 'name_nontemplated', 'apply');
  });

  it('the Working page is renamed by one job and read back; the Authoritative page is the canon guard’s proposal', async () => {
    const run = await runOurs();
    expect(run.state, run.summary ?? '').toBe('succeeded');
    const items = a()
      .store.items(run.id)
      .filter((i) => i.code === 'name_nontemplated');
    expect(items, why(items)).toHaveLength(2);
    const byPage = new Map(items.map((i) => [i.pageId, i]));
    expect(byPage.get(D.working)).toMatchObject({
      outcome: 'applied',
      reason: 'written, read back and verified',
    });
    expect(live(D.working).name).toBe('[BWRK] Ostlund - Polity');
    const job = rt().engine.queries.getJob(PROJECT, byPage.get(D.working)!.jobId!)!;
    expect(job.principalId).toBe('automation');
    // Nothing forced: the Authoritative page's rename is the canon guard's own canonical proposal.
    expect(byPage.get(D.noSubject)).toMatchObject({ outcome: 'guarded', reasonCode: 'GUARDED' });
    expect(rt().policy.proposals.get(byPage.get(D.noSubject)!.proposalId!)!.requiresCanonicalApproval).toBe(
      true,
    );
    expect(live(D.noSubject).name).toBe('[BSRC] Mithral Polity');
    expect(a().store.setting(PROJECT, 'name_nontemplated')?.pausedAt ?? null).toBeNull();
  });

  it('a mention on another page shows the new name; the routing line follows; prose is left for review', async () => {
    const notes = w.repo.blocks.get(live(D.mentions).docs[0] as string)!.blocks as any[];
    // A plain mention shows the page's name as LegendKeeper answers it (the mock fills it in, as LegendKeeper does).
    (w.repo as any).fillMentions = true;
    const read = await w.callRead('read_document', { project: 'test', resource: D.mentions });
    (w.repo as any).fillMentions = false;
    expect(read.text).toContain('Ostlund - Polity');
    expect(textOf(notes[1])).toBe('The Valdris Draft was begun in the spring.');
    const desk = w.repo.blocks.get(live(DESK).docs[0] as string)!.blocks as any[];
    expect(textOf(desk[1])).toBe('Ostlund - Polity: the working polity notes.');
    // The review list rides with the rename (as arkona_rename reports it).
    const job = rt().engine.queries.getJob(
      PROJECT,
      a()
        .store.codeItems(PROJECT, 'name_nontemplated', 50)
        .find((i) => i.pageId === D.working)!.jobId!,
    )!;
    const rec = rt().renames.forSubject(PROJECT, D.working, 5)[0]!;
    expect(rec).toMatchObject({
      subjectKind: 'page',
      oldName: 'Valdris Draft',
      newName: 'Ostlund - Polity',
      jobId: job.id,
    });
    expect(rec.review!.customLabels.some((o) => o.kind === 'restatement' && o.page.id === D.mentions)).toBe(
      true,
    );
  });
});

describe('Keep this name', () => {
  it('holds while the Subject is unchanged, lapses when it changes; Undo', async () => {
    const k = await http.post('/templated-names/keep', {
      project: 'test',
      pageId: D.shahravi,
      reason: 'the owner prefers it',
      confirm: true,
    });
    expect(k.status, JSON.stringify(k.json)).toBe(200);
    expect(rowOf(D.shahravi).status).toBe('kept');
    expect(findings().some((f) => f.pageId === D.shahravi)).toBe(false);
    await auditNow();
    expect(rowOf(D.shahravi).status).toBe('kept');
    expect(findings().some((f) => f.pageId === D.shahravi)).toBe(false);
    // The Subject changes: the ruling lapses and the page is judged again.
    w.repo.outside.setRow(D.shahravi, 'Subject', 'Shahravi Folk');
    await auditNow();
    expect(rowOf(D.shahravi)).toMatchObject({ status: 'rename', proposed: '[BSRC] Shahravi Folk - Culture' });
    const u = await http.post('/templated-names/undo', {
      project: 'test',
      pageId: D.shahravi,
      confirm: true,
    });
    expect(u.status).toBe(200);
    expect(svc().store.ruling(PROJECT, D.shahravi)).toBeNull();
  });
});
