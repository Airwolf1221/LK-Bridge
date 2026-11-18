/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3d (renames), ADR 0058: `arkona_rename` against the mock LegendKeeper (test/packs/rename-world.ts), never a real
 * one. The character rename (Nadira al-Khalid → Laila al-Khalid): every item kind planned and applied with ids kept,
 * D1 (a)'s ticks, D2's historical pages, the AU label, name parts never inferred, the old name kept as an alias in both
 * places, Last Major Revision by ADR 0051's rule, what is left reported and the follow-up of exactly that, always a
 * canonical proposal at every scope, the in-lock re-check and the costs; the culture rename (Velaran → Velarine): the
 * token map as a new pack version, the job waiting for its approval, the characters' facts and tags.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from './world.js';
import { C, O, P, PROJECT, R, renameWorld, type RenameWorld } from './rename-world.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

type Obj = Record<string, unknown>;

const NEW = 'Laila al-Khalid';
const OLD = 'Nadira al-Khalid';

/** A page's sidebar facts, by key. */
function facts(w: RenameWorld, id: string): Record<string, string> {
  const kv = w.sidebars.pages.get(id)?.props.find((p) => p.kind === 'keyValue');
  if (!kv) return {};
  return Object.fromEntries(
    kv.rows!.map((r) => [
      r.key,
      (r.content as Obj[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join(''),
    ]),
  );
}

/** A block of a page's Main document, by id (anywhere in it). */
function block(w: RenameWorld, pageId: string, blockId: string): Obj {
  const find = (list: Obj[]): Obj | null => {
    for (const b of list) {
      if (b.id === blockId) return b;
      if (Array.isArray(b.children)) {
        const hit = find(b.children as Obj[]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(w.repo.blocks.get(w.mainOf(pageId))!.blocks as Obj[])!;
}
const textOf = (b: Obj) =>
  ((b.content as Obj[] | undefined) ?? [])
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const label = (r.mention as Obj | undefined)?.text;
      return typeof label === 'string' ? label : '';
    })
    .join('');

const items = (body: Obj) =>
  ((body.groups as { group: string; items: Obj[] }[]) ?? []).flatMap((g) =>
    g.items.map((i) => ({ ...i, group: g.group })),
  ) as (Obj & { id: string; ticked: boolean; group: string; why?: string; tags?: string[] })[];

describe('arkona_rename: a character', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('never infers a name part: the old given name is not in the new name, so NAME_PARTS_REQUIRED', async () => {
    const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, dryRun: true });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('NAME_PARTS_REQUIRED');
    expect(r.body.error.message).toContain('Personal / Given Name “Nadira”');
    expect(r.body.error.message).not.toContain('Family');
  });

  it('plans every item kind, with D1 (a)’s ticks, D2’s history, the AU label, and the plan’s cost', async () => {
    const before = w.requests();
    const r = await w.call('arkona_rename', {
      subject: 'Nadira al-Khalid - Biography',
      newName: NEW,
      given: 'Laila',
      effectiveDate: '4A 900',
      dryRun: true,
    });
    const cost = w.requests().all - before.all;
    expect(r.isError).toBeFalsy();
    expect(r.body.status).toBe('dry_run');
    expect(r.body.subject).toMatchObject({ id: C.nadira, kind: 'character' });
    const all = items(r.body);
    const byId = new Map(all.map((i) => [i.id, i]));
    const ids = all.map((i) => i.id);
    // Page names: the index, the Core, the three children, both relationships (one each way round).
    for (const id of [
      C.nadira,
      C.nadiraIndex,
      P.nadiraArt,
      P.nadiraBio,
      R.archiveNotes,
      P.relationship,
      R.tarekRelationship,
    ])
      expect(ids, id).toContain(`name:${id}`);
    expect(byId.get(`name:${R.tarekRelationship}`)!.label).toContain(
      '[BSRC] Laila al-Khalid & Tarek Basri - Relationship',
    );
    expect(byId.get(`name:${P.relationship}`)!.label).toContain(
      '[BSRC] Mehrana I al-Khalid & Laila al-Khalid - Relationship',
    );
    // Identity facts (the given name as supplied, the old name in Aliases), resource aliases on every renamed page.
    const core = byId.get(`facts:${C.nadira}`)!;
    expect(core.label).toContain('Subject');
    expect(core.label).toContain('Personal / Given Name');
    expect(core.label).toContain('Aliases');
    expect(core.label).not.toContain('Family');
    for (const id of [C.nadira, C.nadiraIndex, P.nadiraArt, P.relationship, R.tarekRelationship])
      expect(ids, id).toContain(`aliases:${id}`);
    // A custom label holding the name is an item; a plain mention and another label are not.
    const labels = all.filter((i) => i.group === 'Mention labels');
    expect(labels.map((i) => i.label)).toEqual([
      expect.stringContaining('mention labelled “Nadira al-Khalid”'),
    ]);
    expect(ids.some((i) => i.includes(':tr5:') || i.includes(':tr6:'))).toBe(false);
    // The index's routing line.
    expect(all.filter((i) => i.group === 'Index routing')).toHaveLength(1);
    // Chronology: the linked row with its event, and the row before the effective date unticked.
    expect(byId.get(`chronology:${R.rowLinked}`)).toMatchObject({ ticked: true });
    expect(String(byId.get(`chronology:${R.rowLinked}`)!.label)).toContain(
      'its event “Nadira al-Khalid founds the reading room” renamed with it',
    );
    expect(byId.get(`chronology:${R.rowEarly}`)).toMatchObject({
      ticked: false,
      why: 'the row is dated before the rename’s effective date (4A 900)',
    });
    // Art: the folder and the two images in it (its Forms subfolder included); not the image kept in Mehrana's folder.
    expect(ids).toEqual(expect.arrayContaining(['folder:afnadir1', 'asset:imgpng01', 'asset:imgfull1']));
    expect(ids).not.toContain('asset:imgsktch');
    // D1 (a): an ordinary sentence ticked; each excluded context unticked, saying why.
    const qasr = (b: string) =>
      all.find((i) => i.id.endsWith(`:${b}:0`) && i.group === 'Textual restatements')!;
    expect(qasr('qs4')).toMatchObject({ ticked: true });
    expect(qasr('qs5')).toMatchObject({ ticked: false, why: 'it is inside quotation marks' });
    expect(qasr('qs6')).toMatchObject({ ticked: false, why: 'it follows “formerly” in the same sentence' });
    expect(qasr('qs7')).toMatchObject({ ticked: false, why: 'it follows “previously” in the same sentence' });
    expect(qasr('qs8')).toMatchObject({
      ticked: false,
      why: 'it follows “once called” in the same sentence',
    });
    expect(qasr('qs9')).toMatchObject({ ticked: false, why: 'it follows “originally” in the same sentence' });
    expect(qasr('qs11')).toMatchObject({ ticked: false, why: 'it is under Unresolved Material' });
    // Each restatement is one item with its sentence.
    expect(qasr('qs4').diff).toMatchObject({
      before: 'Nadira al-Khalid catalogued the emirate’s charters in her youth.',
      after: 'Laila al-Khalid catalogued the emirate’s charters in her youth.',
    });
    // A Working page is current (ticked); an AU page is included, labelled AU.
    expect(qasr('hw5')).toMatchObject({ ticked: true });
    expect(qasr('au2')).toMatchObject({ ticked: true, tags: ['AU'] });
    // D2: history is listed, never an item.
    const historical = (r.body.leftAsHistorical as { page: { id: string } }[]).map((h) => h.page.id).sort();
    expect(historical).toEqual([C.archived, P.designPage, P.legacyPage].sort());
    for (const id of historical) expect(all.some((i) => (i.page as Obj | undefined)?.id === id)).toBe(false);
    // A table's cells (F3c's Fourth Age page) are reported, not edited.
    expect(r.body.notPlanned).toEqual([
      expect.objectContaining({ page: expect.objectContaining({ id: P.fourthAge }) }),
    ]);
    // Every item depends on the subject's own name.
    for (const i of all) if (i.id !== `name:${C.nadira}`) expect(i.dependsOn, i.id).toBeTruthy();
    // The cost, measured: the plan's reads (3 of them the pack's governance), no write.
    expect(w.requests().writes - before.writes).toBe(0);
    expect(cost).toBe(22);
    expect(r.body.cost).toMatchObject({ planReads: 19 });
  });

  it('is ONE canonical proposal at every scope; the owner approves its ticks; every item kind is applied', async () => {
    // A propose-scope agent's rename is the same canonical proposal (then rejected: one rename at a time).
    const proposer = w.stack.newToken('rename-proposer', 'propose');
    const pc = await w.stack.connect(proposer.token);
    const p0 = await w.stack.call(pc, 'arkona_rename', { subject: C.nadira, newName: NEW, given: 'Laila' });
    expect(p0.body.status).toBe('proposal_captured');
    const v0 = w.stack.runtime.policy.proposals.get(String(p0.body.proposalId))!;
    expect(v0.requiresCanonicalApproval).toBe(true);
    w.stack.runtime.policy.commands.reject('owner', v0.id, 'one rename at a time');

    const before = w.requests();
    const r = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      effectiveDate: '4A 900',
    });
    expect(r.body.status).toBe('proposal_captured');
    const proposalId = String(r.body.proposalId);
    const p = w.stack.runtime.policy.proposals.get(proposalId)!;
    expect(p.requiresCanonicalApproval).toBe(true);
    expect(p.items).toMatchObject({ total: expect.any(Number) });
    const capture = w.requests().all - before.all;
    const mid = w.requests();
    const done = await approve(w, proposalId);
    expect(done.job?.status).toBe('succeeded');
    const job = { requests: w.requests().all - mid.all, writes: w.requests().writes - mid.writes };

    // Exactly the plan's ticks were approved; the rest is recorded as left out.
    const view = w.stack.runtime.policy.proposals.get(proposalId)!;
    expect(view.items!.omitted).toBe(7);
    expect(view.items!.approved).toBe(view.items!.total - 7);

    // Names, ids kept.
    expect(w.repo.live(C.nadira)!.name).toBe('[BSRC] Laila al-Khalid - Character Core');
    expect(w.repo.live(C.nadiraIndex)!.name).toBe('[INDEX] Laila al-Khalid');
    expect(w.repo.live(R.archiveNotes)!.name).toBe('[BSRC] Laila al-Khalid - Archive Notes');
    expect(w.repo.live(P.relationship)!.name).toBe(
      '[BSRC] Mehrana I al-Khalid & Laila al-Khalid - Relationship',
    );
    expect(w.repo.live(R.tarekRelationship)!.name).toBe(
      '[BSRC] Laila al-Khalid & Tarek Basri - Relationship',
    );
    // The old name kept as an alias: in the Aliases fact and in the pages' search aliases.
    expect(facts(w, C.nadira)).toMatchObject({
      Subject: NEW,
      'Canonical Display Name': NEW,
      'Personal / Given Name': 'Laila',
      'Family / Surname': 'al-Khalid',
      Aliases: OLD,
    });
    expect(w.repo.live(C.nadira)!.aliases).toContain('Nadira al-Khalid - Character Core');
    expect(w.repo.live(C.nadiraIndex)!.aliases).toContain(OLD);
    // The mention label and the routing line; the plain mention and the other label untouched.
    expect((block(w, O.tarim, 'tr4').content as Obj[])[1]).toMatchObject({
      mention: { resourceId: C.nadira, text: NEW },
    });
    expect(textOf(block(w, O.tarim, 'tr5'))).toBe('Later the archivist moved to Menkhet.');
    expect(textOf(block(w, C.nadiraIndex, `${C.nadiraIndex}i1p`))).toBe('Laila al-Khalid - Character Core');
    // Restatements: the ticked one renamed, the unticked ones kept; history untouched.
    expect(textOf(block(w, O.qasr, 'qs4'))).toBe(
      'Laila al-Khalid catalogued the emirate’s charters in her youth.',
    );
    expect(textOf(block(w, O.qasr, 'qs5'))).toContain('“Nadira al-Khalid, keeper of charters”');
    expect(textOf(block(w, O.qasr, 'qs11'))).toContain(OLD);
    expect(textOf(block(w, C.au, 'au2'))).toBe('Kaito met Laila al-Khalid in the sky archive.');
    expect(textOf(block(w, P.hollowWorking, 'hw5'))).toContain(NEW);
    expect(textOf(block(w, C.archived, 'ar2'))).toContain(OLD);
    expect(textOf(block(w, P.legacyPage, 'lg2'))).toContain(OLD);
    expect(textOf(block(w, P.designPage, 'dg2'))).toContain(OLD);
    // The chronology: the linked row and its event in step; the early row as it was.
    const rows = w.rows('Fourth Arkonan Age');
    expect(rows).toContain('Azah 1st, 4A 950 | Laila al-Khalid founds the reading room | 1,251,257');
    expect(rows.some((x) => x.includes('Nadira al-Khalid catalogues the charters'))).toBe(true);
    const age = w.ages['Fourth Arkonan Age']!;
    expect(w.events(age.timeline).find((e) => e.id === R.event)!.name).toBe(
      'Laila al-Khalid founds the reading room',
    );
    // Art: the folder and its images renamed, ids kept.
    expect(w.assets.assets.get('afnadir1')!.name).toBe(NEW);
    expect(w.assets.assets.get('imgpng01')!.name).toBe('Laila al-Khalid - Primary Reference - Portrait.png');
    // Last Major Revision by ADR 0051's rule: Archive Notes' heading changed (set); a page whose only change is its name
    // and name facts has no step at all (Tarek's relationship); one restated name (Qasr) is not a major revision.
    const today = new Date().toISOString().slice(0, 10);
    expect(facts(w, R.archiveNotes)['Last Major Revision']).toBe(today);
    expect(facts(w, R.tarekRelationship)['Last Major Revision']).toBe('2026-11-01');
    expect(facts(w, O.qasr)['Last Major Revision']).not.toBe(today);

    // The rename's record, and what is left: the unticked restatements and row, the table cells; not history, not aliases.
    const rec = w.stack.runtime.renames.byProposal(proposalId)!;
    expect(rec.state).toBe('done');
    const report = (await w.stack.runtime.renames.leftovers(PROJECT, rec.id, { refresh: true }))!;
    const pages = new Set(report.occurrences.map((o) => o.page.id));
    expect(pages.has(O.qasr)).toBe(true);
    expect(pages.has(P.fourthAge)).toBe(true);
    for (const id of [C.archived, P.legacyPage, P.designPage, C.nadira])
      expect(pages.has(id), id).toBe(false);
    expect(report.followUp).toEqual({
      tool: 'arkona_rename',
      args: { subject: C.nadira, newName: NEW, from: OLD },
    });
    expect(report.occurrences[0]!.page.link).toMatch(/^lk:\/\/resources\//);
    // The agent's report (free).
    const before2 = w.requests().all;
    const rep = await w.call('arkona_rename', { report: rec.id });
    expect(rep.body).toMatchObject({ state: 'done', oldName: OLD, newName: NEW });
    expect(w.requests().all).toBe(before2);

    // The costs, measured: the capture, and the approved job (its read-back and change snapshot included).
    expect(capture).toBe(28);
    expect(job).toEqual({ requests: 185, writes: 49 });
  });

  it('plans exactly what is left as a follow-up (from: the old name)', async () => {
    const r = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      from: OLD,
      dryRun: true,
    });
    expect(r.isError).toBeFalsy();
    const all = items(r.body);
    expect(all.some((i) => i.group === 'Page names' || i.group === 'Identity facts')).toBe(false);
    expect(all.map((i) => i.id)).toEqual(
      expect.arrayContaining([`chronology:${R.rowEarly}`, expect.stringMatching(/:qs5:0$/)]),
    );
    expect(all.some((i) => i.id.endsWith(':qs4:0'))).toBe(false);
  });
});

describe('arkona_rename: the in-lock re-check', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('writes nothing when the subject was renamed after the plan', async () => {
    const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, given: 'Laila' });
    const proposalId = String(r.body.proposalId);
    w.repo.outside.rename(C.nadira, '[BSRC] Nadira bint Khalid - Character Core');
    const before = w.requests();
    const done = await approve(w, proposalId);
    expect(done.job?.status).toBe('failed');
    expect(done.job?.lastError).toMatchObject({ code: 'SUBJECT_RENAMED' });
    expect(w.requests().writes - before.writes).toBe(0);
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Nadira al-Khalid - Character Art');
  });
});

describe('arkona_rename: a culture', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('changes the token map as a new pack version; the job waits for its approval, then renames the characters', async () => {
    const before = w.requests();
    const dry = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine', dryRun: true });
    const planCost = w.requests().all - before.all;
    expect(dry.isError).toBeFalsy();
    expect(dry.body.subject).toMatchObject({ id: R.velaran, kind: 'culture' });
    const all = items(dry.body);
    const token = all.find((i) => i.id === 'token:culture')!;
    expect(token.label).toContain('a new pack version');
    const chars = all.filter((i) => i.id.startsWith('character:'));
    // The five, and the base fixtures' Working character Tamsin Reed (Naming Culture Velaran, no culture tag).
    expect(chars.map((i) => i.id).sort()).toEqual(
      [...R.characters, C.working].map((id) => `character:${id}`).sort(),
    );
    expect(chars.find((i) => i.id === `character:${C.working}`)!.label).not.toContain('tag');
    for (const c of chars) expect(c.dependsOn).toEqual(['token:culture']);
    expect(planCost).toBe(13);

    const packs = w.stack.runtime.packs;
    const v0 = packs.get('arkona')!.version;
    const r = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    const proposalId = String(r.body.proposalId);
    const mid = w.requests();
    await w.stack.runtime.policy.commands.approveAsCanon('owner', proposalId);
    // A new version holds the new token map; it waits for the owner, and so does the job.
    const pack = packs.get('arkona')!;
    expect(pack.version).toBe(v0 + 1);
    expect(pack.approved?.version).toBe(v0);
    expect(pack.rules.tags.culture).toMatchObject({ Velarine: 'Velarine' });
    expect(pack.rules.tags.culture.Velaran).toBeUndefined();
    const jobId = w.stack.runtime.policy.proposals.get(proposalId)!.jobId!;
    await new Promise((res) => setTimeout(res, 300));
    const waiting = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    expect(waiting.status).toBe('queued');
    expect(w.requests().writes - mid.writes).toBe(0);
    expect(w.stack.runtime.policy.store.listAudit({ action: 'rename.token_version' })).toHaveLength(1);

    // The owner approves the version: the job runs.
    await packs.commands.approve('owner', 'arkona');
    const done = await approve(w as never, proposalId).catch(() => null);
    void done;
    for (let i = 0; i < 500; i++) {
      const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    expect(job.status).toBe('succeeded');
    expect(w.repo.live(R.velaran)!.name).toBe('[BSRC] Velarine - Culture Reference');
    expect(w.repo.live(R.velaranIndex)!.name).toBe('[INDEX] Velarine');
    for (const id of R.characters) {
      expect(facts(w, id)['Naming Culture'], id).toBe('Velarine');
      expect(w.repo.live(id)!.tags, id).toEqual(['CANON', 'Character', 'Human', 'Velarine']);
    }
    expect(facts(w, C.working)['Naming Culture']).toBe('Velarine');
    expect(w.repo.live(C.working)!.tags).toEqual(['Working', 'Character', 'Human']);
    const cost = { requests: w.requests().all - mid.all, writes: w.requests().writes - mid.writes };
    expect(cost).toEqual({ requests: 98, writes: 20 });
  });
});

describe('arkona_rename: a race', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('renames its pages, its taxonomy entry and its token with every character; its art folder is kept', async () => {
    const dry = await w.call('arkona_rename', { subject: O.qishenCore, newName: 'Qishani', dryRun: true });
    expect(dry.isError, dry.text).toBeFalsy();
    expect(dry.body.subject).toMatchObject({ id: O.qishenCore, kind: 'race' });
    const all = items(dry.body);
    const ids = all.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([`name:${O.qishenCore}`, `name:${C.qishen}`, 'token:race']));
    const taxonomy = all.find((i) => i.id.startsWith('taxonomy:'))!;
    expect(taxonomy.dependsOn).toEqual([`name:${C.qishen}`]);
    expect(String(taxonomy.label)).toContain('its asset folder “Qishen” kept');
    expect(ids).toContain(`character:${C.nadira}`);

    const r = await w.call('arkona_rename', { subject: O.qishenCore, newName: 'Qishani' });
    const proposalId = String(r.body.proposalId);
    await w.stack.runtime.policy.commands.approveAsCanon('owner', proposalId);
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    const jobId = w.stack.runtime.policy.proposals.get(proposalId)!.jobId!;
    for (let i = 0; i < 500; i++) {
      const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.repo.live(O.qishenCore)!.name).toBe('[BSRC] Qishani - Core Information');
    expect(w.repo.live(C.qishen)!.name).toBe('[INDEX] Qishani');
    const entry = w.stack.runtime.registry.forProject(PROJECT).store.entryBySource(C.qishen)!;
    expect(entry.plural).toBe('Qishani');
    expect(entry.aliases).toContain('Qishen');
    expect(entry.assetFolder).toBe('Qishen');
    expect(w.assets.assets.get('afqishe1')!.name).toBe('Qishen');
    expect(facts(w, C.nadira)['Race / Species']).toBe('Qishani');
    expect(w.repo.live(C.nadira)!.tags).toEqual(['CANON', 'Character', 'Qishani']);
    expect(w.stack.runtime.packs.get('arkona')!.rules.tags.race).toMatchObject({ Qishani: 'Qishani' });
  });
});
