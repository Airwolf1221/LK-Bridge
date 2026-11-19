/**
 * CR-2026-11 round 3 (renames): core items stop, ordinary items skip, and what is left is reported (ADR 0058 decision
 * 1.10, amendment A.4 and A.5). Can a job end "succeeded" with a half-renamed identity and not say so? Against the mock
 * LegendKeeper of the rename world only. Every test asserts the SAFE behaviour; a failing test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarModel } from '../../resources/world.js';
import { C, P, PROJECT, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { NEW, OLD, approveAs, dryItems, factsOf, proposeNadira } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/** What the rename reports as left of the old name (the full-text index brought up to date first). */
async function leftovers(w: RenameWorld, proposalId: string) {
  await w.stack.runtime.tree.sweep(PROJECT, 'manual');
  await w.stack.runtime.tree.whenIdle();
  await w.snapshot();
  const rec = w.stack.runtime.renames.byProposal(proposalId)!;
  return (await w.stack.runtime.renames.leftovers(PROJECT, rec.id, { refresh: true }))!;
}

describe('RN core: a page of the set the plan never saw', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-30 a page added to the set while the proposal waits is renamed, or the job’s report lists it', async () => {
    const id = await proposeNadira(w);
    // While the proposal waits, an agent (or the owner) adds a page to her set, named as Arkona names them.
    const added = w.repo.outside.create(`[BSRC] ${OLD} - Wardrobe`, C.nadiraIndex, {
      tags: ['CANON', 'Character'],
    });
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const renamed = w.repo.live(added.id)!.name === `[BSRC] ${NEW} - Wardrobe`;
    const report = await leftovers(w, id);
    const listed = report.occurrences.some((o) => o.page.id === added.id);
    // Safe: no page of her set keeps the old name without the owner being told.
    expect({ renamed, listed, count: report.count, note: report.note }).toSatisfy(
      (x: { renamed: boolean; listed: boolean }) => x.renamed || x.listed,
    );
  });
});

describe('RN core: a page under her index whose name is not “<Old> - …”', () => {
  let w: RenameWorld;
  const LETTERS = 'nadlettr';
  beforeAll(async () => {
    w = await renameWorld();
    w.repo.seed({
      id: LETTERS,
      name: `[BSRC] ${OLD}’s Letters`,
      parentId: C.nadiraIndex,
      referenceType: 'General Source',
      tags: ['CANON', 'Character'],
    });
    await w.stack.runtime.tree.sweep(PROJECT, 'manual');
    await w.stack.runtime.tree.whenIdle();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-31 is planned, listed as not planned, or reported as left: never silently keeps the old name', async () => {
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      dryRun: true,
    });
    expect(dry.isError, dry.text).toBeFalsy();
    const planned = dryItems(dry.body).some((i) => (i.page as { id?: string } | undefined)?.id === LETTERS);
    const notPlanned = JSON.stringify(dry.body.notPlanned ?? []).includes(LETTERS);
    const id = await proposeNadira(w);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const report = await leftovers(w, id);
    const listed = report.occurrences.some((o) => o.page.id === LETTERS);
    expect({ planned, notPlanned, listed, name: w.repo.live(LETTERS)!.name }).toSatisfy(
      (x: { planned: boolean; notPlanned: boolean; listed: boolean }) =>
        x.planned || x.notPlanned || x.listed,
    );
  });
});

describe('RN core: an identity fact the plan never saw', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-32 a fact naming her added to a page of the set meanwhile is listed as left (the job succeeded)', async () => {
    const id = await proposeNadira(w);
    w.sidebars.outside(P.nadiraBio, (sb) => {
      const kv = sb.props.find((p) => p.kind === 'keyValue')!;
      kv.rows!.push({
        id: 'kvbiocdn',
        rank: 'r0000zzzz',
        key: 'Canonical Display Name',
        content: [{ text: OLD }],
      });
    });
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(factsOf(w, P.nadiraBio)['Canonical Display Name']).toBe(OLD);
    const report = await leftovers(w, id);
    expect(
      report.occurrences.some((o) => o.page.id === P.nadiraBio && o.where.includes('Canonical Display Name')),
    ).toBe(true);
  });
});

describe('RN core: an identity fact holding a custom mention label', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
    // The Art page's Subject is a mention of her Core labelled with her name (a custom label: never written, D).
    const sb = w.sidebars.pages.get(P.nadiraArt)!;
    const kv = sb.props.find((p) => p.kind === 'keyValue')!;
    kv.rows!.find((r) => r.key === 'Subject')!.content = [{ mention: { resourceId: C.nadira, text: OLD } }];
    void SidebarModel;
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-33 the job never reports a clean identity while a core fact still shows the old name (it is listed)', async () => {
    const id = await proposeNadira(w);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const report = await leftovers(w, id);
    const review = JSON.stringify(report.reviewOnly ?? {});
    const listed =
      report.occurrences.some((o) => o.page.id === P.nadiraArt && o.where.includes('Subject')) ||
      (review.includes(P.nadiraArt) && review.includes('custom label'));
    expect(listed).toBe(true);
  });
});

describe('RN core: the old name inside the new one (“Nadira al-Khalid” → “Nadira al-Khalid al-Kubra”)', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-26 the report never lists the new name as the old one left behind', async () => {
    const KUBRA = `${OLD} al-Kubra`;
    const r = await w.call('arkona_rename', { subject: C.nadira, newName: KUBRA });
    expect(r.body.status, r.text.slice(0, 300)).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(factsOf(w, C.nadira).Subject).toBe(KUBRA);
    const report = await leftovers(w, id);
    // Her Core is fully renamed (its Aliases fact keeps the old name, which is not a leftover): nothing left there.
    const onCore = report.occurrences.filter((o) => o.page.id === C.nadira);
    expect(
      onCore.map((o) => `${o.where}: ${o.snippet}`),
      `the report says: ${report.note}`,
    ).toEqual([]);
  });
});

describe('RN core: an ordinary item’s page deleted while the proposal waits', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-27 a restatement whose page was deleted meanwhile is skipped; the rest of the rename runs', async () => {
    const id = await proposeNadira(w);
    w.repo.outside.delete(P.hollowWorking);
    const done = await approveAs(w, id);
    const skipped = done.jobId ? w.stack.runtime.engine.skippedItems(PROJECT, done.jobId) : [];
    expect(
      {
        status: done.job?.status,
        core: w.repo.live(C.nadira)!.name,
        skipped: skipped.some((s) => s.item.includes(':hw5:')),
      },
      JSON.stringify(done.job?.lastError ?? null).slice(0, 400),
    ).toEqual({ status: 'succeeded', core: `[BSRC] ${NEW} - Character Core`, skipped: true });
  });
});
