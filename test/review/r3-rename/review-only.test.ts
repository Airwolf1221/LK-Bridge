/**
 * CR-2026-11 round 3 (renames): the review-only list (ADR 0058 amendment B): the old given name, family name and aliases
 * on their own are "never items, never selectable", the bridge "never acts on them". Can any item, a rebase, "Propose
 * these again" or the follow-up (`from`) write one? Against the mock LegendKeeper of the rename world only. Every test
 * asserts the SAFE behaviour; a failing test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarModel } from '../../resources/world.js';
import { C, P, PROJECT, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import {
  NEW,
  OLD,
  approveAs,
  closedSelection,
  dryItems,
  itemsOf,
  outsideEdit,
  textOf,
  type Obj,
} from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const para = (id: string, text: string): Obj => ({ id, kind: 'paragraph', content: [{ text }] });

describe('RN review only: the follow-up (from) of a name part', () => {
  let w: RenameWorld;
  const SAMI_INDEX = 'samiidx1';
  const SAMI_CORE = 'samicor1';
  let reviewSentences: string[] = [];
  beforeAll(async () => {
    w = await renameWorld();
    // Another Nadira: a character of her own, whose page names her by her given name.
    w.repo.seed({ id: SAMI_INDEX, name: '[INDEX] Nadira bint Sami', parentId: C.qishen });
    w.repo.seed({
      id: SAMI_CORE,
      name: '[BSRC] Nadira bint Sami - Character Core',
      parentId: SAMI_INDEX,
      referenceType: 'Character Core',
      tags: ['CANON', 'Character', 'Qishen'],
    });
    w.sidebars.page(SAMI_CORE, [
      SidebarModel.kv('kvsamic1', 'PROPERTIES', [
        ['Status', 'Authoritative'],
        ['Subject', 'Nadira bint Sami'],
        ['Canonical Display Name', 'Nadira bint Sami'],
        ['Personal / Given Name', 'Nadira'],
        ['Reference Type', 'Character Core'],
        ['Last Major Revision', '2026-11-01'],
      ]),
      { id: 'tgsamic1', kind: 'unsupported' as const, title: 'TAGS' },
    ]);
    w.repo.blocks.set(w.mainOf(SAMI_CORE), {
      version: 1,
      blocks: [
        { id: 'sm1', kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
        para('sm2', 'Nadira bint Sami tends the archive gardens.'),
      ],
    });
    await w.stack.runtime.tree.sweep(PROJECT, 'manual');
    await w.stack.runtime.tree.whenIdle();
    await w.snapshot();
    // The rename, with name parts (so "Nadira" is review only); the owner leaves the Working page's sentence out.
    const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, given: 'Laila' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    const items = itemsOf(w, id);
    const keep = closedSelection(
      items,
      items.filter((i) => i.selected && !i.id.includes(':hw5:')).map((i) => i.id),
    );
    const done = await approveAs(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    await w.snapshot();
    const rec = w.stack.runtime.renames.byProposal(id)!;
    const report = (await w.stack.runtime.renames.leftovers(PROJECT, rec.id, { refresh: true }))!;
    reviewSentences = (report.reviewOnly?.occurrences ?? [])
      .filter((o) => o.kind === 'name part')
      .map((o) => o.sentence);
  });
  afterAll(() => w?.close());

  it('RN-40 a follow-up from the old given name never ticks an edit of a review-only occurrence', async () => {
    expect(reviewSentences).toEqual(
      expect.arrayContaining([
        'The bond between Nadira and Tarek Basri.',
        'Nadira bint Sami tends the archive gardens.',
      ]),
    );
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      from: 'Nadira',
      dryRun: true,
    });
    const ticked = dry.isError ? [] : dryItems(dry.body).filter((i) => i.ticked);
    const writesPart = ticked.filter((i) =>
      reviewSentences.some((s) =>
        JSON.stringify(i.diff ?? i.label).includes(s.replace(/\s+/g, ' ').slice(0, 30)),
      ),
    );
    // Safe: refused, or nothing review-only ticked (the owner picks specific occurrences).
    expect(writesPart.map((i) => ({ id: i.id, label: i.label }))).toEqual([]);
  });

  it('RN-40b approved with its ticks, the follow-up never writes “Laila al-Khalid al-Khalid” nor renames Nadira bint Sami', async () => {
    const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, from: 'Nadira' });
    if (r.body.status !== 'proposal_captured') return; // refused: held
    const done = await approveAs(w, String(r.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect({
      hw5: textOf(w, P.hollowWorking, 'hw5'),
      sami: textOf(w, SAMI_CORE, 'sm2'),
      tarek: textOf(w, R.tarekRelationship, 'tk2'),
    }).toEqual({
      hw5: `${OLD} may have copied the founding charter.`,
      sami: 'Nadira bint Sami tends the archive gardens.',
      tarek: 'The bond between Nadira and Tarek Basri.',
    });
  });
});

describe('RN review only: a follow-up from a name the subject never had', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-41 a follow-up is refused unless `from` is a former name of the subject (its aliases or its renames)', async () => {
    // Mehrana I al-Khalid was never called Nadira al-Khalid.
    const r = await w.call('arkona_rename', {
      subject: C.mehrana1,
      newName: 'Mehrana I al-Khalid',
      from: OLD,
      dryRun: true,
    });
    const ticked = r.isError ? [] : dryItems(r.body).filter((i) => i.ticked);
    expect(
      { isError: r.isError === true, ticked: ticked.length, sample: ticked.slice(0, 2).map((i) => i.label) },
      r.text.slice(0, 400),
    ).toMatchObject({ isError: true });
  });
});

describe('RN review only: "Propose these again" and rebases', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-42 Propose these again (left out and skipped) never proposes a review-only occurrence', async () => {
    const r = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: 'Laila al-Rashid',
      given: 'Laila',
      family: 'al-Rashid',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    // The owner leaves out the Qasr restatement; the Working page's sentence is edited meanwhile (skipped).
    const items = itemsOf(w, id);
    const keep = closedSelection(
      items,
      items.filter((i) => i.selected && !i.id.includes(':qs4:')).map((i) => i.id),
    );
    outsideEdit(w, P.hollowWorking, 'hw5', `${OLD} may have copied the second charter.`);
    const done = await approveAs(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, {
      kind: 'ui',
      client: 'owner',
      tool: 'proposal.repropose',
      detail: `repropose:${id}`,
    } as never);
    const second = itemsOf(w, String(again.proposalId));
    expect(second.some((i) => i.id.includes(':hw5:'))).toBe(true);
    expect(second.some((i) => i.id.includes(':qs4:'))).toBe(true);
    // No item of the new proposal edits "Nadira" or "al-Khalid" on its own (the review-only parts).
    for (const i of second) {
      const d = JSON.stringify(i.diff ?? {});
      expect(d.includes('The bond between Nadira and') || d.includes('Mehrana I and Nadira.'), i.id).toBe(
        false,
      );
    }
    expect(textOf(w, R.tarekRelationship, 'tk2')).toBe('The bond between Nadira and Tarek Basri.');
    expect(textOf(w, P.relationship, 'nr2')).toBe('The bond between Mehrana I and Nadira.');
  });
});
