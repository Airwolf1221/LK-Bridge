/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H1, H2 and H3) end to end, against the
 * mock LegendKeeper (the retag world, never fetched):
 *
 * - H1: the Tagging Standard's "Approved Supplementary Tags" pinned and parsed as pack data; the seven pages of the live
 *   audit of 23 November 2026 become corrections with exactly the owner's arrays, and one apply writes them; the pinned
 *   section drifting fails closed, as other pins do.
 * - H2: "Keep this tag here" clears an exception and lapses when the array changes; "Allow this tag everywhere" edits only
 *   the list's sentence (dry run first), runs as one revertible job, and the pack offers its new version; agents can
 *   suggest either, never take it.
 * - H3: a page whose tags are only out of order is one correction, in the same batch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from './world.js';
import { PROJECT, retagWorld, type RetagWorld } from './retag-world.js';
import { SEVEN } from './f5a-supplementary-engine.test.js';
import { ROOT } from '../discover/world.js';

vi.setConfig({ testTimeout: 180_000 });

/** The section's sentence, verbatim as the owner gave it (23 November 2026). */
export const SUPPLEMENTARY_TEXT =
  'Under the Exact Tag Grammar’s provision for a deliberately approved exception, the author has approved these existing tags as permitted supplementary tags on any eligible owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework. A permitted supplementary tag is kept, after the grammar’s slots, wherever it appears. It is not a primary category or a specialist function, it is never added to a page by inference or by an audit, and it is never proposed for removal as incidental. Adding a tag to this list, or removing one, is an author decision recorded here.';

const PINNED = [
  'Exact Tag Grammar',
  'Closed Primary Categories and Specialist Functions',
  'Excluded Routine Tags',
  'Approved Supplementary Tags',
];

const DESK = 'f5adesk1';
const KEEP = 'f5akeep1';
const ORDER = 'f5aordr1';
const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
  ['Continuity', 'Main'],
  ['Inheritance', 'None'],
];
const ID = (i: number) => `f5aseve${i}`;

let w: RetagWorld;
let taggingDoc: string;
const rt = () => w.stack.runtime;
const textOf = (b: any) => (b.content as any[]).map((r) => r.text ?? '').join('');
const supplementaryParagraph = () =>
  w.repo.blocks.get(taggingDoc)!.blocks.find((b: any) => b.id === 'f5asupp1') as any;

beforeAll(async () => {
  w = await retagWorld({
    // Seven fixture pages as the live audit found them, a page with an incidental tag, and a page out of order.
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: DESK, name: '[INDEX] F5 Desk', parentId: ROOT });
      SEVEN.forEach((s, i) => {
        r.seed({ id: ID(i), name: s.name, parentId: DESK, tags: [...s.current] });
        for (const [k, v] of CANON_ROWS) r.outside.setRow(ID(i), k, v);
      });
      r.seed({
        id: KEEP,
        name: '[BSRC] Saltglass Accord - Law Reference',
        parentId: DESK,
        tags: ['CANON', 'Law', 'Lore'],
      });
      for (const [k, v] of CANON_ROWS) r.outside.setRow(KEEP, k, v);
      r.seed({
        id: ORDER,
        name: '[BSRC] Tidewall Compact - Polity Reference',
        parentId: DESK,
        tags: ['Polity', 'CANON'],
        referenceType: 'Polity Reference',
      });
      for (const [k, v] of CANON_ROWS) r.outside.setRow(ORDER, k, v);
    },
  });
  // The Tagging Standard as it reads on 23 November 2026: "Approved Supplementary Tags" directly after "Excluded
  // Routine Tags", pinned by the governance source (as the f5a seed pins it on Arkona; the owners world holds it).
  const packs = rt().packs;
  const pack = packs.get('arkona')!;
  const src = pack.governance.find((g) => g.key === 'tagging-standard')!;
  expect(src.sections).toEqual(PINNED);
  taggingDoc = src.documentId;
  const doc = w.repo.blocks.get(taggingDoc)!;
  const at = doc.blocks.findIndex(
    (b: any) => b.kind === 'heading' && textOf(b) === 'Approved Supplementary Tags',
  );
  expect(textOf(doc.blocks[at - 1])).toBe('The rules of Excluded Routine Tags.');
  doc.blocks[at + 1] = { id: 'f5asupp1', kind: 'paragraph', content: [{ text: SUPPLEMENTARY_TEXT }] };
  await packs.commands.approve('owner', 'arkona');
  // The owner's classifications of 22 November 2026.
  SEVEN.forEach((s, i) =>
    rt().retag.classify('owner', PROJECT, {
      pageId: ID(i),
      pageName: s.name,
      primary: s.primary,
      specialist: s.specialist,
      reason: 'classified on 22 November 2026',
    }),
  );
  rt().retag.classify('owner', PROJECT, {
    pageId: KEEP,
    pageName: 'Saltglass Accord',
    primary: 'Law',
    specialist: null,
    reason: 'a law',
  });
  await w.snapshot();
});
afterAll(async () => w?.close());

const audit = async () => {
  const r = await w.callRead('arkona_retag_audit', { project: 'test', under: DESK, limit: 200 });
  expect(r.isError, r.text).toBe(false);
  return {
    runId: r.body.runId as string,
    pages: new Map<string, any>((r.body.pages as any[]).map((p) => [p.pageId, p])),
  };
};

describe('H1: the pinned section and its list', () => {
  it('the governance check reads the list as the approved version lists it', async () => {
    const g = await rt().packs.governance('arkona');
    expect(g.state).toBe('current');
    expect(g.supplementary).toEqual({
      state: 'same',
      tags: ['Cosmology', 'Chronology', 'Setting Framework'],
    });
    const tagging = g.sources.find((s) => s.key === 'tagging-standard')!;
    expect(tagging.sections?.map((s) => [s.heading, s.state])).toContainEqual([
      'Approved Supplementary Tags',
      'same',
    ]);
  });
});

describe('H1 and H3: the seven pages, and a page only out of order', () => {
  it('all seven are corrections with exactly the owner’s arrays; the order-only page is a correction too', async () => {
    const { runId, pages } = await audit();
    SEVEN.forEach((s, i) => {
      const p = pages.get(ID(i));
      expect(p?.disposition, s.name).toBe('correction');
      expect(p.proposed, s.name).toEqual(s.proposed);
    });
    expect(pages.get(ORDER)).toMatchObject({ disposition: 'correction', proposed: ['CANON', 'Polity'] });
    expect(pages.get(KEEP)).toMatchObject({ disposition: 'exception' });
    // One apply, one proposal, every page an item; the reordering is in the same batch as the rest.
    const ids = [...SEVEN.map((_, i) => ID(i)), ORDER];
    const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages: ids });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const done = await approve(w, r.body.proposalId);
    expect(done.job?.status).toBe('succeeded');
    SEVEN.forEach((s, i) => expect(w.repo.res.get(ID(i))!.tags, s.name).toEqual(s.proposed));
    expect(w.repo.res.get(ORDER)!.tags).toEqual(['CANON', 'Polity']);
    const b = rt().retag.store.batchByProposal(r.body.proposalId)!;
    for (const id of ids)
      expect(b.dispositions![id], id).toMatchObject({ outcome: 'applied', verified: true });
  });
});

describe('H4: Apply all corrections', () => {
  it('makes the usual bounded batches (each page an item); v3 F12: each runs at once as one job, every page applied', async () => {
    // Four pages put back out of order by an outside edit; a batch size of 3 for the test.
    const ids = [ID(0), ID(1), ID(2), ID(3)];
    for (const id of ids) {
      const t = w.repo.res.get(id)!.tags;
      w.repo.outside.setTags(id, [...t].reverse());
    }
    w.approveRetag({ routine: [], batchSize: 3 });
    await w.snapshot();
    const { runId } = await audit();
    const chunks = rt().retag.correctionBatches(PROJECT, runId);
    expect(chunks.map((c) => c.length)).toEqual([3, 1]);
    expect(chunks.flat().sort()).toEqual([...ids].sort());
    const jobs: string[] = [];
    for (const c of chunks) {
      const plan = rt().retag.planApply({ projectId: PROJECT, runId, pageIds: c });
      expect(plan.items).toHaveLength(c.length);
      // The owner's confirmed "Apply all corrections" (ADR 0081): no proposal to approve next.
      const sub = await rt().retag.submitApply(plan, {
        projectId: PROJECT,
        origin: { kind: 'ui', client: 'owner', tool: 'tagging.apply_all', ownerConfirmed: true },
        actor: 'owner',
      });
      expect(sub.proposalId).toBeNull();
      expect(sub.jobId).toBeTruthy();
      jobs.push(sub.jobId!);
    }
    for (const id of jobs) {
      const job = await rt().engine.wait(PROJECT, id, 20_000);
      expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    }
    SEVEN.slice(0, 4).forEach((s, i) => expect(w.repo.res.get(ID(i))!.tags, s.name).toEqual(s.proposed));
  });
});

describe('H2: "Keep this tag here"', () => {
  it('clears the exception on that page while its array is unchanged; lapses when the array changes', async () => {
    await expect(
      rt().retag.keepHere('pat_agent', PROJECT, { pageId: KEEP, tag: 'Lore', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    const ruling = await rt().retag.keepHere('owner', PROJECT, {
      pageId: KEEP,
      tag: 'Lore',
      reason: 'Lore is right here',
    });
    expect(ruling).toMatchObject({ tag: 'Lore', tags: ['CANON', 'Law', 'Lore'], by: 'owner' });
    expect(ruling.at).toBeGreaterThan(0);
    expect((await audit()).pages.get(KEEP)).toMatchObject({ disposition: 'compliant' });
    // An outside edit of the page's tags: the ruling lapses and the exception is back.
    w.repo.outside.setTags(KEEP, ['Lore', 'CANON', 'Law']);
    await w.snapshot();
    const after = (await audit()).pages.get(KEEP);
    expect(after.disposition).toBe('exception');
    expect(after.exceptions[0].reason).toMatch(/lapsed when the page’s tags changed/);
  });

  it('agents can suggest either ruling, never take it', async () => {
    const r = await w.callRead('arkona_retag_audit', {
      project: 'test',
      suggestRuling: {
        page: KEEP,
        tag: 'Lore',
        action: 'allow_everywhere',
        reason: 'used on many law pages',
      },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.suggestedRuling).toMatchObject({ tag: 'Lore', action: 'allow_everywhere' });
    expect(rt().retag.store.rulingSuggestions(PROJECT, KEEP)).toHaveLength(1);
    expect(rt().retag.store.rulings(PROJECT, KEEP)[0]!.tags).toEqual(['CANON', 'Law', 'Lore']); // unchanged by it
    await expect(rt().retag.allowEverywhere('pat_agent', PROJECT, { tag: 'Lore' })).rejects.toMatchObject({
      code: 'NOT_OWNER',
    });
  });
});

describe('H2: "Allow this tag everywhere"', () => {
  it('a dry run shows the sentence before and after, changes only the list, and writes nothing', async () => {
    const before = w.requests();
    const dry = await rt().retag.allowEverywhere('owner', PROJECT, { tag: 'Lore', dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.before).toBe(SUPPLEMENTARY_TEXT);
    expect(dry.after).toBe(
      SUPPLEMENTARY_TEXT.replace(
        'Cosmology, Chronology and Setting Framework.',
        'Cosmology, Chronology, Setting Framework and Lore.',
      ),
    );
    expect(dry.tags).toEqual(['Cosmology', 'Chronology', 'Setting Framework', 'Lore']);
    expect(w.requests().writes).toBe(before.writes);
    expect(textOf(supplementaryParagraph())).toBe(SUPPLEMENTARY_TEXT);
  });

  it('runs as one job (journalled), and the pack offers the new version; approved, the tag is supplementary everywhere', async () => {
    const out = await rt().retag.allowEverywhere('owner', PROJECT, { tag: 'Lore', pageId: KEEP });
    expect(out.jobId).toBeTruthy();
    const job = await rt().engine.wait(PROJECT, out.jobId!, 20_000);
    expect(job.status).toBe('succeeded');
    expect(textOf(supplementaryParagraph())).toBe(out.after);
    const j = rt().engine.queries.journalLookup(PROJECT, { jobId: out.jobId!, limit: 5 });
    expect(j[0]).toMatchObject({ opId: 'replaceBlock', outcome: 'applied' });
    expect(rt().retag.isSupplementaryEditJob(PROJECT, out.jobId!)).toBe(true);
    // The governance check derives the list and offers a new version (never approved by itself).
    // (the edit's own follow-up check may have offered it already: then this one finds the list the same)
    const g = await rt().packs.governance('arkona');
    expect(['offered', 'same']).toContain(g.supplementary?.state);
    expect(g.supplementary?.tags).toEqual(['Cosmology', 'Chronology', 'Setting Framework', 'Lore']);
    const pack = rt().packs.get('arkona')!;
    expect(pack.version).toBeGreaterThan(pack.approved!.version);
    expect(g.state).toBe('rules_changed');
    expect(pack.rules.retag!.supplementary!.tags).toEqual([
      'Cosmology',
      'Chronology',
      'Setting Framework',
      'Lore',
    ]);
    await expect(
      rt().retag.audit({ projectId: PROJECT, actor: 'owner', scope: { pageId: KEEP } }),
    ).rejects.toMatchObject({ code: 'PACK_NOT_CURRENT' });
    await rt().packs.commands.approve('owner', 'arkona');
    const v = (await audit()).pages.get(KEEP);
    expect(v.disposition).toBe('correction'); // now only out of order (Lore is supplementary, kept last)
    expect(v.proposed).toEqual(['CANON', 'Law', 'Lore']);
  });

  it('can be Reverted (the sentence back as it was)', async () => {
    const edit = rt().retag.store.supplementaryEdits(PROJECT)[0]!;
    const preview = await rt().reverts.preview(PROJECT, edit.jobId!);
    expect(preview.eligible, JSON.stringify(preview)).toEqual({ ok: true });
    const r = await rt().reverts.revert('owner', PROJECT, edit.jobId!);
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    const job = await rt().engine.wait(PROJECT, (r as any).revertJobId, 20_000);
    expect(job.status).toBe('succeeded');
    expect(textOf(supplementaryParagraph())).toBe(SUPPLEMENTARY_TEXT);
  });
});

describe('H1: the pinned section drifting fails closed', () => {
  it('an edit of the section is drift: nothing is computed until the owner approves again', async () => {
    const g0 = await rt().packs.governance('arkona');
    if (g0.state !== 'current') await rt().packs.commands.approve('owner', 'arkona');
    const doc = w.repo.blocks.get(taggingDoc)!;
    doc.version++;
    const p = supplementaryParagraph();
    p.content = [{ text: `${SUPPLEMENTARY_TEXT} Reviewed again.` }];
    const g = await rt().packs.governance('arkona');
    expect(g.state).toBe('changed');
    const tagging = g.sources.find((s) => s.key === 'tagging-standard')!;
    expect(tagging.sections?.find((s) => s.heading === 'Approved Supplementary Tags')?.state).toBe('changed');
    await expect(
      rt().retag.audit({ projectId: PROJECT, actor: 'owner', scope: { pageId: KEEP } }),
    ).rejects.toMatchObject({ code: 'PACK_NOT_CURRENT' });
  });

  it('a section whose sentence can no longer be read refuses the approval', async () => {
    const doc = w.repo.blocks.get(taggingDoc)!;
    doc.version++;
    supplementaryParagraph().content = [{ text: 'The author has approved some tags.' }];
    await expect(rt().packs.commands.approve('owner', 'arkona')).rejects.toMatchObject({
      code: 'GOVERNANCE_SECTION_UNPARSABLE',
    });
  });
});
