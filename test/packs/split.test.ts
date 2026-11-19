/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3e (ADR 0059): `arkona_split_owner` (C2) against the mock LegendKeeper (the splits' test world, fixtures built from
 * the owner-approved design's shapes, never fetched):
 *
 * - the checks before anything is proposed: coverage (an unassigned block, a block assigned twice, a section listed
 *   twice: all refused with lists), the visual audit, the relationship audit (a warning), the universal audit (text and
 *   owner required; a restated rule flagged), interface summaries, D5's mapped Dependencies, the identity page;
 * - canonical at every scope (D7);
 * - phase 1 on the character monolith (the source survives): every block verbatim in exactly one destination with its
 *   id, interface summaries with exact links, the new index's routing, the remapped Dependency, universal material
 *   replaced by its application text with the universal owner as a Dependency, Last Major Revision per page, the
 *   verification; no phase 2; the costs, measured;
 * - an index line in an EXISTING character index;
 * - phase 2 on the owner with two domains (the source retired): only once phase 1 has verified, archive_page's own
 *   canonical proposal, never a delete; the existing owner's append;
 * - Revert of phase 1: the content back, the pages it made to ONE deletion proposal.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { C, O, P, PROJECT, S, splitWorld, zahraBody, type SplitWorld } from './split-world.js';
import { ROOT } from '../discover/world.js';
import { statutesSplit, zahraSplit } from './split-inputs.js';
import {
  approveMeasured,
  approveSplit,
  bodyOf,
  ids,
  intercept,
  linksOf,
  mentionsIn,
  named,
  recordOf,
  refusal,
  rowsOf,
  settle,
  split,
  textOf,
  today,
  type Obj,
} from './split-helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ZAHRA = '[BSRC] Zahra al-Rashid - Character Reference';

describe('arkona_split_owner: the checks before anything is proposed', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  const dry = (args: Obj) => split(w, { ...args, dryRun: true });
  const base = zahraSplit();
  const map = base.map as Obj[];

  it('coverage: an unassigned block is refused with the list (nothing written)', async () => {
    const before = w.requests();
    const r = await dry({ ...base, map: map.filter((e) => e.section !== 'Habits') });
    const c = refusal(r, 'SPLIT_COVERAGE');
    expect(c.message).toContain('2 blocks are not assigned');
    expect(c.unassigned).toEqual([
      { block: 'zh5b', section: 'Habits', text: 'Habits' },
      expect.objectContaining({
        block: 'zq2',
        section: 'Habits',
        text: expect.stringContaining('counts her coins'),
      }),
    ]);
    expect(c.twice).toEqual([]);
    expect(w.requests().writes).toBe(before.writes);
  });

  it('coverage: a block assigned twice is refused with the list', async () => {
    const r = await dry({
      ...base,
      map: map.map((e) =>
        e.section === 'Wardrobe'
          ? {
              section: 'Wardrobe',
              blocks: [
                { ids: ['zh6', 'zw1'], to: 'wardrobe', summary: 'What she wears.' },
                {
                  ids: ['zw1', 'zwimg1', 'zw2', 'zwimg2', 'zw3'],
                  to: 'art',
                  summary: 'Her wardrobe images.',
                },
              ],
            }
          : e,
      ),
    });
    const c = refusal(r, 'SPLIT_COVERAGE');
    expect(c.message).toContain('1 block is assigned more than once');
    expect(c.twice).toEqual([
      expect.objectContaining({ block: 'zw1', section: 'Wardrobe', destinations: ['wardrobe', 'art'] }),
    ]);
  });

  it('no duplicated authority: a section listed twice is refused with the list', async () => {
    const r = await dry({
      ...base,
      map: [...map, { section: 'Biography', to: 'looks', summary: 'Again.' }],
    });
    const d = refusal(r, 'SPLIT_DUPLICATED_AUTHORITY');
    expect(d.duplicated).toEqual([{ section: 'Biography', destinations: ['bio', 'looks'] }]);
    // Each of its blocks is then assigned twice, listed too.
    expect(refusal(r, 'SPLIT_COVERAGE').twice.map((x: any) => x.block)).toEqual([
      'zh3',
      'zb2',
      'zb3',
      'zb4',
      'zb5',
      'zb6',
      'zb7',
      'zb8',
      'zb9',
    ]);
  });

  it('the visual audit: images to a page that is not visual are refused', async () => {
    const r = await dry({
      ...base,
      destinations: (base.destinations as Obj[]).filter((d) => d.key !== 'art'),
      map: map.map((e) =>
        e.section === 'Wardrobe' ? { section: 'Wardrobe', to: 'wardrobe', summary: 'What she wears.' } : e,
      ),
    });
    const v = refusal(r, 'SPLIT_VISUAL');
    expect(v.blocks).toEqual([
      { block: 'zwimg1', section: 'Wardrobe', to: 'wardrobe' },
      { block: 'zwimg2', section: 'Wardrobe', to: 'wardrobe' },
    ]);
    expect(v.message).toContain('Art or visual owner');
  });

  it('the relationship audit: a section about one other character not sent to a relationship owner is a warning', async () => {
    const r = await dry({
      ...base,
      destinations: (base.destinations as Obj[]).filter((d) => d.key !== 'rel'),
      map: map.map((e) =>
        e.section === 'Zahra and Nadira al-Khalid'
          ? { section: 'Zahra and Nadira al-Khalid', to: 'bio', summary: 'Her bond with Nadira.' }
          : e,
      ),
      dependencies: [{ page: P.nadiraBio, to: 'bio' }],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status).toBe('dry_run');
    expect(r.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SPLIT_RELATIONSHIP_SECTION',
          section: 'Zahra and Nadira al-Khalid',
          with: 'Nadira al-Khalid',
          to: ['bio'],
        }),
      ]),
    );
  });

  it('universal material: the application text and a current universal owner are required', async () => {
    const dests = (patch: Obj) =>
      (base.destinations as Obj[]).map((d) => (d.key === 'magic' ? { ...d, ...patch } : d));
    const noText = await dry({ ...base, destinations: dests({ text: '' }) });
    expect(refusal(noText, 'SPLIT_UNIVERSAL_TEXT_REQUIRED').message).toContain('application text');
    const notUniversal = await dry({ ...base, destinations: dests({ owner: P.nadiraBio }) });
    expect(refusal(notUniversal, 'SPLIT_UNIVERSAL_OWNER_NOT_UNIVERSAL').message).toContain(
      'not a current universal owner',
    );
    // Restating the rule into a character's owner (no universal assignment) is flagged.
    const migrated = await dry({
      ...base,
      destinations: (base.destinations as Obj[]).filter((d) => d.key !== 'magic'),
      map: map.map((e) =>
        e.section === 'Powers' ? { section: 'Powers', to: 'powers', summary: 'Her sorcery.' } : e,
      ),
    });
    expect(migrated.isError, migrated.text).toBe(false);
    expect(migrated.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SPLIT_UNIVERSAL_CANDIDATE',
          block: 'zw5',
          owner: { id: S.sorcery, name: '[BSRC] Salahad Sorcery - Magic Reference' },
          to: 'powers',
        }),
      ]),
    );
  });

  it('a surviving source keeps an interface summary for each section that leaves it', async () => {
    const r = await dry({
      ...base,
      map: map.map((e) => (e.section === 'Biography' ? { section: 'Biography', to: 'bio' } : e)),
    });
    expect(refusal(r, 'SPLIT_SUMMARY_REQUIRED').missing).toEqual([{ section: 'Biography', to: 'bio' }]);
  });

  it('D5: retiring a source needs every incoming Dependency mapped; an identity page is never retired', async () => {
    const s0 = statutesSplit();
    const r = await dry({ ...s0, dependencies: [{ page: S.ostrandPolity, to: 'law' }] });
    expect(refusal(r, 'SPLIT_DEPENDENCIES_UNMAPPED').unmapped).toEqual([
      { id: S.assizes, name: '[BSRC] Ostrand Assizes - Institution Reference' },
    ]);
    const z = await dry({ ...base, retire: true });
    expect(refusal(z, 'SPLIT_RETIRE_IDENTITY').message).toContain('identity page');
  });

  it('the dry run: the map, each destination an item with what leaving it out means, and the plan’s measured reads', async () => {
    const before = w.requests();
    const n = w.stack.mock.calls.length;
    const r = await dry(base);
    // Every request the call made, but the pack's governance documents (the basis's, read before the plan).
    const planCalls = w.stack.mock.calls.slice(n).filter((c) => !c.path.includes(`/resources/${ROOT}/`));
    expect(r.isError, r.text).toBe(false);
    expect(w.requests().writes).toBe(before.writes);
    const b = r.body;
    expect(b.source).toMatchObject({ id: S.zahra, name: ZAHRA, kind: 'character', identity: true });
    expect(b.phase2).toContain('none: the source survives');
    const list = b.items.list as any[];
    expect(list.map((i) => i.id)).toEqual(
      expect.arrayContaining([
        'dest:bio',
        'dest:looks',
        'dest:art',
        'dest:wardrobe',
        'dest:rel',
        'dest:powers',
        `dep:${P.nadiraBio}`,
      ]),
    );
    expect(list.find((i) => i.id === 'dest:bio').ifLeftOut).toBe(
      `If left out, “Biography” stays in ${ZAHRA} (nothing is lost).`,
    );
    expect(list.find((i) => i.id === 'dest:wardrobe').ifLeftOut).toBe(
      `If left out, “Wardrobe”, “Unresolved Material” stay in ${ZAHRA} (nothing is lost).`,
    );
    expect(list.find((i) => i.id === `dep:${P.nadiraBio}`).dependsOn).toContain('dest:rel');
    // The remapped Dependency, the one left (the source survives), and the chronology row reported.
    expect(b.dependencies.remapped).toEqual([
      {
        page: { id: P.nadiraBio, name: '[BSRC] Nadira al-Khalid - Biography' },
        to: 'rel',
        keepSource: false,
      },
    ]);
    expect(b.dependencies.unmapped.map((x: any) => x.id)).toEqual([O.tarim]);
    expect(b.dependencies.chronologyRows).toEqual([
      expect.objectContaining({ page: expect.objectContaining({ id: P.fourthAge }) }),
    ]);
    // Universal material is not migrated: it is part of the Powers page's item, its application text there.
    expect(b.destinations.find((d: any) => d.key === 'magic')).toMatchObject({
      kind: 'universal',
      universal: { owner: { id: S.sorcery }, in: 'powers' },
    });
    expect(b.interfaceSummaries.map((s: any) => s.section)).toEqual([
      'Biography',
      'Appearance',
      'Wardrobe',
      'Wardrobe',
      'Zahra and Nadira al-Khalid',
      'Powers',
      'Unresolved Material',
      'Unresolved Material',
    ]);
    // The plan's reads, as measured: the source and its document, the templates of the new pages, and the pages whose
    // Dependencies or links it changes (the pack's governance reads are the basis's, before the plan).
    expect(planCalls.map((c) => `${c.method} ${c.path.replace(/^\/api\/v3\/projects\/[^/]+/, '')}`)).toEqual([
      `GET /resources/${S.zahra}/`,
      expect.stringMatching(new RegExp(`^GET /resources/${S.zahra}/docs/[^/]+/blocks/$`)),
      `GET /resources/${S.zahra}/`,
      'GET /resources/tplgen01/',
      'GET /resources/tplart01/',
      'GET /resources/tplrel01/',
      `GET /resources/${C.nadira}/`,
      `GET /resources/${P.nadiraBio}/`,
    ]);
    expect(b.cost.planReads).toBe(planCalls.length);
    expect(b.cost.planReads).toBe(PLAN_READS.zahra);
  });

  it('canonical at every scope: a propose-scope agent’s split is the same canonical proposal', async () => {
    const proposer = w.stack.newToken('split-proposer', 'propose');
    const pc = await w.stack.connect(proposer.token);
    const r = await w.stack.call(pc, 'arkona_split_owner', { project: 'test', ...zahraSplit() });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const p = w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!;
    expect(p.requiresCanonicalApproval).toBe(true);
    expect(p.items?.total).toBeGreaterThanOrEqual(8);
    // The bridge keeps the split's record: proposed, no phase 2 yet.
    const rec = await recordOf(w, String(r.body.proposalId));
    expect(rec).toMatchObject({ state: 'proposed', sourceId: S.zahra, retire: false, phase2: null });
    w.stack.runtime.policy.commands.reject('owner', p.id, 'not now');
  });
});

/** The plan's reads, measured (pinned: a change is a cost change to state). */
const PLAN_READS = { zahra: 8 };

describe('arkona_split_owner: phase 1 on a character monolith (the source survives)', () => {
  let w: SplitWorld;
  let proposal: any;
  let jobId: string;
  let pages: Record<string, { id: string; name: string }>;
  const cost = { capture: 0, requests: 0, writes: 0 };
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    const before = w.requests();
    const r = await split(w, zahraSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    proposal = r.body;
    cost.capture = w.requests().all - before.all;
    pages = Object.fromEntries(
      (proposal.destinations as any[]).filter((d) => d.page).map((d) => [d.key, d.page]),
    );
    const done = await approveMeasured(w, String(proposal.proposalId));
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    jobId = done.jobId;
    cost.requests = done.cost.requests;
    cost.writes = done.cost.writes;
  });
  afterAll(() => w?.close());

  /** Zahra's body as seeded, block by block. */
  const original = () => {
    const url = (id: string) => `https://assets.test:${w.port}/a/${id}.webp`;
    return new Map((JSON.parse(JSON.stringify(zahraBody(url))) as Obj[]).map((b) => [b.id as string, b]));
  };

  it('was ONE canonical proposal, each destination an item', () => {
    const p = w.stack.runtime.policy.proposals.get(String(proposal.proposalId))!;
    expect(p.requiresCanonicalApproval).toBe(true);
    expect(p.items!.approved).toBe(p.items!.total);
  });

  it('moved every block verbatim, with its id, to exactly one destination', () => {
    const orig = original();
    const where = new Map<string, string[]>();
    for (const [key, pg] of Object.entries(pages))
      for (const b of bodyOf(w, pg.id))
        where.set(b.id as string, [...(where.get(b.id as string) ?? []), key]);
    const expected: Record<string, string[]> = {
      bio: ['zh3', 'zb2', 'zb3', 'zb4', 'zb5', 'zb6', 'zb7', 'zb8', 'zb9'],
      looks: ['zh4', 'za1', 'zaimg1', 'za2', 'zaimg2', 'za3', 'zaimg3', 'za4'],
      wardrobe: ['zh6', 'zw1', 'zu3', 'zu4'],
      art: ['zwimg1', 'zw2', 'zwimg2', 'zw3'],
      rel: ['zh7', 'zr1', 'zr2'],
      powers: ['zh8', 'zw4', 'zw6', 'zu1', 'zu2'],
    };
    for (const [key, list] of Object.entries(expected)) {
      const body = bodyOf(w, pages[key]!.id);
      for (const id of list) {
        expect(where.get(id), `${id} in ${key}`).toEqual([key]);
        // Verbatim: every attribute as it was (an image's address, a mention, the text).
        expect(body.find((b) => b.id === id)).toEqual(orig.get(id));
      }
    }
    // The universal paragraph went nowhere: replaced by the application text.
    expect(where.has('zw5')).toBe(false);
    // What stays is still in the source, as it was.
    const src = bodyOf(w, S.zahra);
    for (const id of ['zh1', 'zp1', 'zh2', 'zi1', 'zh5', 'zq1', 'zh5b', 'zq2', 'zh9', 'zs1', 'zh10', 'zu5'])
      expect(
        src.find((b) => b.id === id),
        id,
      ).toEqual(orig.get(id));
    // Nothing that moved is left in the source.
    for (const list of Object.values(expected)) for (const id of list) expect(ids(src), id).not.toContain(id);
  });

  it('the source keeps a compact interface summary with an exact link where each section was', () => {
    const src = bodyOf(w, S.zahra);
    const at = src.findIndex((b) => b.kind === 'heading' && textOf(b) === 'Biography');
    expect(at).toBeGreaterThan(0);
    expect(textOf(src[at + 1]!)).toBe('Her life is told in full on her Biography page.');
    // A plain mention (never a custom label), in a sentence of its own.
    expect(src[at + 2]!.content).toEqual([
      { text: 'See ' },
      { mention: { resourceId: pages.bio!.id } },
      { text: '.' },
    ]);
    // The section's order is kept: Identity, Biography (summary), Appearance (summary), Personality…
    const headings = src.filter((b) => b.kind === 'heading').map(textOf);
    expect(headings).toEqual([
      'Purpose',
      'Identity',
      'Biography',
      'Appearance',
      'Personality',
      'Habits',
      'Wardrobe',
      'Zahra and Nadira al-Khalid',
      'Powers',
      'Source Boundaries',
      'Unresolved Material',
    ]);
    // Unresolved items that moved are summarised in place; the one that stays is still there.
    const un = src.slice(src.findIndex((b) => textOf(b) === 'Unresolved Material'));
    expect(un.map(textOf)).toEqual([
      'Unresolved Material',
      'Open questions about her powers are on her Powers page.',
      `See @${pages.powers!.id}.`,
      'Open questions about her wardrobe are on her Wardrobe page.',
      `See @${pages.wardrobe!.id}.`,
      'Her exact year of birth.',
    ]);
  });

  it('universal material (D3): the application text in its place, the universal owner a Dependency', () => {
    const powers = bodyOf(w, pages.powers!.id);
    const app = powers.find((b) => textOf(b).startsWith('Zahra draws her fire-binding'));
    expect(app).toBeTruthy();
    expect(powers.some((b) => mentionsIn(b).includes(S.sorcery))).toBe(true);
    expect(linksOf(w, pages.powers!.id)).toContain(S.sorcery);
  });

  it('the new pages: Purpose first, Scope and Reference Type set, in the new index that routes to each', () => {
    for (const key of ['bio', 'looks', 'wardrobe', 'powers']) {
      const body = bodyOf(w, pages[key]!.id);
      expect(textOf(body[0]!), key).toBe('Purpose');
      expect(rowsOf(w, pages[key]!.id).Scope, key).toMatch(/^Zahra al-Rashid: /);
    }
    expect(rowsOf(w, pages.bio!.id)['Reference Type']).toBe('Character Biography');
    expect(rowsOf(w, pages.looks!.id)['Reference Type']).toBe('Character Physical & Visual Reference');
    // Her compact reference had no index of its own: the split made one, holding her set, with a line for each page.
    const index = named(w, '[INDEX] Zahra al-Rashid')!;
    expect(index).toBeTruthy();
    expect(w.repo.live(S.zahra)!.parentId).toBe(index.id);
    for (const key of Object.keys(pages)) expect(w.repo.live(pages[key]!.id)!.parentId, key).toBe(index.id);
    const routed = bodyOf(w, index.id).flatMap(mentionsIn);
    for (const key of Object.keys(pages)) expect(routed, key).toContain(pages[key]!.id);
  });

  it('D5: the page that depended on her relationship now depends on the relationship owner; the other keeps her', () => {
    expect(linksOf(w, P.nadiraBio)).not.toContain(S.zahra);
    expect(linksOf(w, P.nadiraBio)).toContain(pages.rel!.id);
    expect(linksOf(w, O.tarim)).toContain(S.zahra);
  });

  it('Last Major Revision by ADR 0051 per page: the source and the remapped page dated; the new pages dated', () => {
    expect(rowsOf(w, S.zahra)['Last Major Revision']).toBe(today());
    expect(rowsOf(w, P.nadiraBio)['Last Major Revision']).toBe(today());
    for (const key of ['bio', 'looks', 'powers'])
      expect(rowsOf(w, pages[key]!.id)['Last Major Revision'], key).toBe(today());
  });

  it('verified by a direct re-read, and no phase 2 (the source survives)', async () => {
    const steps = w.stack.runtime.engine.stepRecords(PROJECT, jobId)!;
    const last = steps[steps.length - 1]!;
    expect(last.status).toBe('succeeded');
    expect(JSON.stringify(last.result)).toContain('"verified":true');
    const rec = await recordOf(w, jobId, (r) => r.state === 'verified');
    expect(rec.phase2.reason).toContain('the source survives');
    expect(rec.phase2.proposalId).toBeUndefined();
    // Nothing proposes archiving it.
    const archive = w.stack.runtime.policy.proposals
      .list({ project: PROJECT, state: 'pending' })
      .filter((p) => JSON.stringify(p).includes('archive_page'));
    expect(archive).toEqual([]);
    // `report` answers what became of it (free).
    const before = w.requests();
    const r = await split(w, { report: proposal.split });
    expect(r.body).toMatchObject({ split: proposal.split, state: 'verified', retire: false });
    expect(w.requests().all).toBe(before.all);
  });

  it('the costs, measured: the proposal’s capture and the job', () => {
    expect(cost).toEqual(COSTS.zahra);
    // The preview's estimate of the job's writes is the job's writes.
    expect(proposal.cost.job.writes).toBe(cost.writes);
  });

  it('Revert of phase 1: the moved content back in the source; the pages it made to ONE deletion proposal', async () => {
    const orig = original();
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    if (rv.status !== 'submitted') return;
    const job = await settle(w, rv.revertJobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    // The source as it was, block for block; her reference back under Qishen.
    expect(bodyOf(w, S.zahra)).toEqual([...orig.values()]);
    expect(w.repo.live(S.zahra)!.parentId).toBe(C.qishen);
    expect(linksOf(w, P.nadiraBio)).toContain(S.zahra);
    expect(linksOf(w, P.nadiraBio)).not.toContain(pages.rel!.id);
    // The pages it made (and the index) go to ONE deletion proposal, children first.
    const rec = await recordOf(w, jobId, (r) => r.state === 'reverted');
    expect(rec.revert.kept).toEqual([]);
    const index = named(w, '[INDEX] Zahra al-Rashid')!;
    expect(rec.revert.deleted.map((p: any) => p.id).sort()).toEqual(
      [...Object.values(pages).map((p) => p.id), index.id].sort(),
    );
    expect(rec.revert.deleted.at(-1).id).toBe(index.id);
    const del = w.stack.runtime.policy.proposals.get(rec.revert.deletionProposalId)!;
    expect(del.state).toBe('pending');
    expect(del.requiresCanonicalApproval).toBe(true);
    // Nothing is deleted until the owner approves it.
    for (const p of Object.values(pages)) expect(w.repo.live(p.id), p.name).toBeTruthy();
    const d = await approveSplit(w, del.id);
    expect(d.job.status, JSON.stringify(d.job.lastError)).toBe('succeeded');
    for (const p of Object.values(pages)) expect(w.repo.live(p.id), p.name).toBeFalsy();
    expect(w.repo.live(index.id)).toBeFalsy();
    // Reverted once: never again, and never resumed.
    expect(await w.stack.runtime.reverts.revert('owner', PROJECT, jobId)).toMatchObject({
      status: 'refused',
      code: 'ALREADY_REVERTED',
    });
  });
});

/** The costs, measured (pinned: a change is a cost change to state). */
const COSTS = {
  zahra: { capture: 23, requests: 243, writes: 87 },
  statutes: { capture: 12, requests: 84, writes: 22 },
};

describe('arkona_split_owner: phase 2 on an owner with two domains (the source retired)', () => {
  let w: SplitWorld;
  let proposal: any;
  let lawId: string;
  const cost = { capture: 0, requests: 0, writes: 0 };
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    const before = w.requests();
    const r = await split(w, statutesSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    proposal = r.body;
    cost.capture = w.requests().all - before.all;
    lawId = (proposal.destinations as any[]).find((d) => d.key === 'law').page.id;
  });
  afterAll(() => w?.close());

  it('phase 2 waits for phase 1: nothing proposes the archive before it has run and verified', async () => {
    const rec = await recordOf(w, String(proposal.proposalId));
    expect(rec).toMatchObject({ state: 'proposed', retire: true, phase2: null });
    expect(proposal.phase2).toContain('once phase 1 verifies');
    const p = w.stack.runtime.policy.proposals.get(String(proposal.proposalId))!;
    expect(p.requiresCanonicalApproval).toBe(true);
    const riteReads = intercept(
      w,
      'GET',
      new RegExp(`/resources/${S.sunRite}/docs/[^/]+/blocks$`),
      () => undefined,
    );
    const done = await approveMeasured(w, p.id);
    riteReads.off();
    // The existing owner's document: read inside the append's lock, read back after the write, by the destinations
    // check and by the verification (test/packs/split-recovery.test.ts pins one more after a conflict).
    expect(riteReads.count()).toBe(4);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    cost.requests = done.cost.requests;
    cost.writes = done.cost.writes;
  });

  it('phase 1: the new Law owner holds Law and Courts verbatim; the existing Religion owner the faith, under the agent’s heading', () => {
    const law = bodyOf(w, lawId);
    expect(ids(law)).toEqual(expect.arrayContaining(['sh3', 'sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6']));
    expect(w.repo.live(lawId)!.name).toBe('[BSRC] Ostrand Statutes - Law Reference');
    const rite = bodyOf(w, S.sunRite);
    const at = rite.findIndex((b) => textOf(b) === 'Worship under the Statutes');
    expect(at).toBeGreaterThan(0);
    // Before the boundaries, the moved blocks with their ids (the section's own heading too).
    expect(ids(rite.slice(at + 1, at + 8))).toEqual(['sh4', 'sf1', 'sf2', 'sf3', 'sf4', 'sf5', 'sf6']);
    expect(textOf(rite[at + 8]!)).toBe('Source Boundaries');
    // The source keeps what stays; nothing that moved.
    expect(ids(bodyOf(w, S.statutes))).toEqual(['sh1', 'sp1', 'sh2', 'so1', 'sh5', 'ss1', 'sh6', 'su1']);
  });

  it('D5: every page that depended on the source now depends on the new owner it needs', () => {
    for (const id of [S.ostrandPolity, S.assizes]) {
      expect(linksOf(w, id), id).toContain(lawId);
      expect(linksOf(w, id), id).not.toContain(S.statutes);
    }
  });

  it('phase 2 (D2): once phase 1 verified, a SEPARATE canonical archive_page proposal; never a delete', async () => {
    const rec = await recordOf(w, String(proposal.proposalId), (r) => r.state === 'retiring');
    const p2 = w.stack.runtime.policy.proposals.get(rec.phase2.proposalId)!;
    expect(p2.state).toBe('pending');
    expect(p2.requiresCanonicalApproval).toBe(true);
    expect(p2.id).not.toBe(proposal.proposalId);
    const detail = JSON.stringify(w.stack.runtime.policy.proposals.detail(p2.id));
    expect(detail).toContain('archive_page');
    expect(detail).not.toContain('deleteResource');
    // Not archived until the owner approves it.
    expect(w.repo.live(S.statutes)!.name).toBe('[BSRC] Ostrand Statutes and Rites - General Source');
    const done = await approveSplit(w, p2.id);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const after = w.repo.live(S.statutes)!;
    expect(after.name).toMatch(/^\[BARC\] Ostrand Statutes and Rites/);
    expect(after.deletedAt ?? null).toBeNull();
    await recordOf(w, String(proposal.proposalId), (r) => r.state === 'retired');
  });

  it('the costs, measured', () => {
    expect(cost).toEqual(COSTS.statutes);
    expect(proposal.cost.job.writes).toBe(cost.writes);
  });
});

describe('arkona_split_owner: a new page’s line in an EXISTING character index', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    // The first split gives Zahra her index; the second adds a page to it.
    const first = await split(w, zahraSplit());
    expect(first.body.status, first.text).toBe('proposal_captured');
    const done = await approveSplit(w, String(first.body.proposalId));
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('the line is its own item, written in the index’s routing section', async () => {
    const index = named(w, '[INDEX] Zahra al-Rashid')!;
    const r = await split(w, {
      source: S.zahra,
      destinations: [
        {
          key: 'self',
          kind: 'new',
          role: 'specialist',
          title: 'Personality & Lifestyle',
          referenceType: 'Character Personality & Lifestyle Reference',
          scope: 'Zahra al-Rashid: her temperament and habits',
          purpose: 'How Zahra al-Rashid deals with people, and the habits she keeps.',
        },
      ],
      map: [
        { section: 'Purpose', to: 'stays' },
        { section: 'Identity', to: 'stays' },
        { section: 'Biography', to: 'stays' },
        { section: 'Appearance', to: 'stays' },
        // Kept together (Anti-Fragmentation: personality and habits), each with its summary.
        { section: 'Personality', to: 'self', summary: 'Her temperament is on her Personality page.' },
        { section: 'Habits', to: 'self', summary: 'Her habits are on her Personality page.' },
        { section: 'Wardrobe', to: 'stays' },
        { section: 'Zahra and Nadira al-Khalid', to: 'stays' },
        { section: 'Powers', to: 'stays' },
        { section: 'Source Boundaries', to: 'stays' },
        { section: 'Unresolved Material', to: 'stays' },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const page = (r.body.destinations as any[])[0].page;
    const route = (r.body.items.list as any[]).find((i) => i.id.startsWith('route:'));
    expect(route).toMatchObject({ group: 'Index lines', dependsOn: ['dest:self'] });
    expect(r.body.indexEntries).toEqual([
      {
        index: '[INDEX] Zahra al-Rashid',
        line: expect.stringContaining('Zahra al-Rashid - Personality & Lifestyle'),
      },
    ]);
    const done = await approveSplit(w, String(r.body.proposalId));
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    expect(w.repo.live(page.id)!.parentId).toBe(index.id);
    const routed = bodyOf(w, index.id).flatMap(mentionsIn);
    expect(routed).toContain(page.id);
    expect(ids(bodyOf(w, page.id))).toEqual(expect.arrayContaining(['zh5', 'zq1', 'zh5b', 'zq2']));
  });
});
