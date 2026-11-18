/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3d amendment (ADR 0058, 18 November 2026), against the mock LegendKeeper (test/packs/rename-world.ts), never a real
 * one:
 *
 * - A: a conflict part-way is rebased (the same change on the fresh content), or its item skipped ("changed meanwhile",
 *   with a before and after excerpt) while the job carries on; a core item that cannot be rebased stops the job, which
 *   Resume continues; three conflicts in a row skip an item; an occurrence that now appears twice is skipped; skipped
 *   items can be proposed again. The extra reads a conflict costs are pinned.
 * - B: the old name's parts on their own are listed for review, never items, with a page of another character sharing
 *   the part flagged.
 * - C: a subject's rename through update_resource (or lk_api_write) is refused with USE_ARKONA_RENAME; plainRename passes
 *   it with its reason; a descriptor-only rename passes.
 * - D: a custom mention label is listed for review and never written; the rename completes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { approve } from './world.js';
import { C, O, P, PROJECT, R, renameWorld, type RenameWorld } from './rename-world.js';
import type { JobOrigin } from '../../src/jobs/types.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

type Obj = Record<string, unknown>;
const NEW = 'Laila al-Khalid';
const OLD = 'Nadira al-Khalid';
const SENTENCE = 'Nadira al-Khalid catalogued the emirate’s charters in her youth.';

const OWNER_ORIGIN = {
  kind: 'ui',
  client: 'owner',
  tool: 'job.resume',
  principal: { principalId: 'system', profile: 'owner', label: 'owner' },
} as unknown as JobOrigin;

/** Runs `fn` on each request matching `method` and `path`, before the mock answers it (first in line). */
function intercept(
  w: RenameWorld,
  method: string,
  path: RegExp,
  fn: (n: number, req: MockRequest) => MockResponse | undefined,
): { count: () => number } {
  let n = 0;
  const hook = (req: MockRequest) => {
    if (req.method !== method || !path.test(req.path.replace(/\/$/, ''))) return undefined;
    return fn(n++, req);
  };
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(/./, hook);
  for (const [re, f] of rest) w.overrides.set(re, f);
  return { count: () => n };
}

/** An edit in the app: a block's text replaced, the document's version moved on. */
function outsideEdit(w: RenameWorld, pageId: string, blockId: string, text: string) {
  const doc = w.repo.blocks.get(w.mainOf(pageId))!;
  const b = (doc.blocks as Obj[]).find((x) => x.id === blockId)!;
  b.content = [{ text }];
  doc.version += 1;
}

const textOf = (w: RenameWorld, pageId: string, blockId: string): string => {
  const block = (w.repo.blocks.get(w.mainOf(pageId))!.blocks as Obj[]).find((x) => x.id === blockId)!;
  return ((block.content as Obj[] | undefined) ?? [])
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const label = (r.mention as Obj | undefined)?.text;
      return typeof label === 'string' ? label : '';
    })
    .join('');
};

async function propose(w: RenameWorld): Promise<string> {
  const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, given: 'Laila' });
  expect(r.body.status, r.text).toBe('proposal_captured');
  return String(r.body.proposalId);
}

async function settle(w: RenameWorld, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
}

const QS4 = /\/blocks\/qs4$/;

describe('ADR 0058 amendment A: a conflict part-way', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('an outside write before a restatement (LegendKeeper answers 412): rebased on the fresh content and applied', async () => {
    const id = await propose(w);
    // Another block of Qasr's document is edited in the app just as the restatement is sent: LegendKeeper refuses it.
    const put = intercept(w, 'PUT', QS4, (n) => {
      if (n === 0) outsideEdit(w, O.qasr, 'qs2', 'The reference for the Emirate of Qasr, revised.');
      return undefined;
    });
    const get = intercept(w, 'GET', QS4, () => undefined);
    const done = await approve(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(textOf(w, O.qasr, 'qs4')).toBe(SENTENCE.replace(OLD, NEW));
    expect(textOf(w, O.qasr, 'qs2')).toBe('The reference for the Emirate of Qasr, revised.');
    // The cost of rebasing a refused send: the write sent twice, and ONE extra read (the re-read after the 412).
    expect(put.count()).toBe(2);
    expect(get.count()).toBe(2);
    const step = done.job!.steps.find(
      (s) => s.opId === 'replaceBlock' && (s.params as { path?: Obj }).path?.blockId === 'qs4',
    )!;
    expect(step.resultSummary).toMatchObject({ rebased: { conflicts: 1 } });
    expect(w.stack.runtime.engine.skippedItems(PROJECT, done.jobId!)).toEqual([]);
  });

  it('an outside write seen before sending: rebased with no extra read', async () => {
    const w2 = await renameWorld();
    try {
      const id = await propose(w2);
      // The edit lands between the job's check and the restatement's own read inside its lock.
      const get = intercept(w2, 'GET', QS4, (n) => {
        if (n === 0) outsideEdit(w2, O.qasr, 'qs2', 'The reference for the Emirate of Qasr, revised.');
        return undefined;
      });
      const put = intercept(w2, 'PUT', QS4, () => undefined);
      const done = await approve(w2, id);
      expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
      expect(textOf(w2, O.qasr, 'qs4')).toBe(SENTENCE.replace(OLD, NEW));
      expect(textOf(w2, O.qasr, 'qs2')).toBe('The reference for the Emirate of Qasr, revised.');
      // The bridge saw the new version on the read the write makes anyway: no extra read, one send.
      expect(get.count()).toBe(1);
      expect(put.count()).toBe(1);
    } finally {
      await w2.close();
    }
  });
});

describe('ADR 0058 amendment A: an item whose exact text changed', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  let proposalId = '';
  let jobId = '';
  const item = () =>
    w.stack.runtime.policy.proposals.itemsOf(proposalId)!.items.find((i) => i.id.endsWith(':qs4:0'))!.id;

  it('is skipped (changed meanwhile, with a before and after excerpt) and the job continues', async () => {
    proposalId = await propose(w);
    const edited = 'Nadira al-Khalid catalogued every charter of the emirate.';
    intercept(w, 'GET', QS4, (n) => {
      if (n === 0) outsideEdit(w, O.qasr, 'qs4', edited);
      return undefined;
    });
    const put = intercept(w, 'PUT', QS4, () => undefined);
    const done = await approve(w, proposalId);
    jobId = done.jobId!;
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    // Never overwritten; the rest of the rename applied.
    expect(put.count()).toBe(0);
    expect(textOf(w, O.qasr, 'qs4')).toBe(edited);
    expect(w.repo.live(C.nadira)!.name).toBe('[BSRC] Laila al-Khalid - Character Core');
    expect(textOf(w, P.hollowWorking, 'hw5')).toContain(NEW);
    const skipped = w.stack.runtime.engine.skippedItems(PROJECT, jobId);
    expect(skipped).toEqual([
      expect.objectContaining({ item: item(), reason: 'changed meanwhile', before: SENTENCE, after: edited }),
    ]);
    // The proposal's detail and the rename's report list it.
    const detail = w.stack.runtime.policy.proposals.detail(proposalId)!;
    expect(detail.itemPlan?.skipped).toEqual(skipped);
    const rec = w.stack.runtime.renames.byProposal(proposalId)!;
    const report = (await w.stack.runtime.renames.leftovers(PROJECT, rec.id, { refresh: true }))!;
    expect(report.skipped).toMatchObject({ count: 1, items: [expect.objectContaining({ item: item() })] });
    expect(report.skipped!.note).toContain('Propose these again');
  });

  it('skipped items are proposable again (with those left out)', async () => {
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', proposalId, {
      kind: 'ui',
      client: 'owner',
      tool: 'proposal.repropose',
      detail: `repropose:${proposalId}`,
    } as never);
    const second = String((again as { proposalId: string }).proposalId);
    const ids = w.stack.runtime.policy.proposals.itemsOf(second)!.items.map((i) => i.id);
    expect(ids).toContain(item());
    const omitted = w.stack.runtime.policy.proposals.itemsOf(proposalId)!.omitted!;
    for (const o of omitted) expect(ids).toContain(o);
    expect(ids).toHaveLength(omitted.length + 1);
    const audit = w.stack.runtime.policy.store
      .listAudit({ action: 'proposal.repropose' })
      .find((a) => a.target === proposalId)!;
    expect(audit.after).toMatchObject({ proposalId: second, skipped: [item()] });
  });
});

describe('ADR 0058 amendment A: an ambiguous occurrence, and three conflicts in a row', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('an occurrence that now appears twice in its paragraph is skipped (which one is meant cannot be told)', async () => {
    const id = await propose(w);
    intercept(w, 'GET', QS4, (n) => {
      if (n === 0) outsideEdit(w, O.qasr, 'qs4', `${SENTENCE} ${SENTENCE}`);
      return undefined;
    });
    const done = await approve(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(textOf(w, O.qasr, 'qs4')).toBe(`${SENTENCE} ${SENTENCE}`);
    expect(w.stack.runtime.engine.skippedItems(PROJECT, done.jobId!)).toEqual([
      expect.objectContaining({
        reason: 'the sentence now appears more than once, so which occurrence is meant cannot be told',
        before: SENTENCE,
      }),
    ]);
  });

  it('three conflicts in a row on one item: skipped after the third, the job carries on', async () => {
    const w2 = await renameWorld();
    try {
      const id = await propose(w2);
      const put = intercept(w2, 'PUT', QS4, (n) => {
        outsideEdit(w2, O.qasr, 'qs2', `The reference for the Emirate of Qasr, revision ${n + 1}.`);
        return undefined;
      });
      const done = await approve(w2, id);
      expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
      expect(put.count()).toBe(3);
      expect(textOf(w2, O.qasr, 'qs4')).toBe(SENTENCE);
      expect(w2.stack.runtime.engine.skippedItems(PROJECT, done.jobId!)).toEqual([
        expect.objectContaining({ reason: 'conflicted 3 times in a row (another writer kept changing it)' }),
      ]);
      expect(w2.repo.live(C.nadira)!.name).toBe('[BSRC] Laila al-Khalid - Character Core');
    } finally {
      await w2.close();
    }
  });
});

describe('ADR 0058 amendment A: a core item that cannot be rebased', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('stops the job (a half-renamed identity is worse than a stopped one); Resume continues it', async () => {
    const id = await propose(w);
    const original = w.repo.live(P.nadiraArt)!.name;
    // Someone renames a page of her set in the app between the job's check and that page's own rename (the page is read
    // at approval, by the job's check, then by its rename's own read inside its lock).
    intercept(w, 'GET', new RegExp(`/resources/${P.nadiraArt}$`), (n) => {
      if (n === 2) w.repo.outside.rename(P.nadiraArt, '[BSRC] Nadira al-Khalid - Portraits');
      return undefined;
    });
    const done = await approve(w, id);
    expect(done.job?.status).toBe('failed');
    // It stopped at that page's rename (its rebaser: the name changed meanwhile, and a page name is core).
    const stopped = done.job!.steps.find((s) => s.status === 'failed')!;
    expect(stopped.opId).toBe('updateResource');
    expect(stopped.error).toMatchObject({ code: 'VERSION_CONFLICT', reason: 'changed_since_planned' });
    expect(JSON.stringify(stopped.error)).toContain('the page was renamed');
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Nadira al-Khalid - Portraits');
    expect(w.stack.runtime.engine.skippedItems(PROJECT, done.jobId!)).toEqual([]);
    const view = w.stack.runtime.resume.view(PROJECT, done.jobId!);
    expect(view.resumable).toBe(true);
    // The owner puts the name back, then resumes: the job continues from where it stopped.
    w.repo.outside.rename(P.nadiraArt, original);
    const out = await w.stack.runtime.resume.resume(PROJECT, done.jobId!, { kind: 'owner' }, OWNER_ORIGIN);
    expect(out.status).toBe('resumed');
    const job = await settle(w, done.jobId!);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Laila al-Khalid - Character Art');
    expect(w.repo.live(C.nadira)!.name).toBe('[BSRC] Laila al-Khalid - Character Core');
  });
});

describe('ADR 0058 amendments B and D: review only', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('lists the old name’s parts on their own, never as items, and flags a page of another character with the part', async () => {
    const r = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: 'Laila al-Rashid',
      given: 'Laila',
      family: 'al-Rashid',
      dryRun: true,
    });
    expect(r.isError, r.text).toBeFalsy();
    const review = r.body.reviewOnly as {
      parts: { part: string; kind: string }[];
      occurrences: Obj[];
      count: number;
      more: number;
      note: string;
    };
    expect(review.parts).toEqual([
      { part: 'Nadira', kind: 'given name' },
      { part: 'al-Khalid', kind: 'family name' },
    ]);
    expect(review.note).toContain('bring them to the owner');
    expect(r.body.message).toContain('Bring the');
    const parts = review.occurrences.filter((o) => o.kind === 'name part');
    // "The bond between Nadira and Tarek Basri." (her own relationship page) and "… Mehrana I and Nadira." are there.
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          part: 'Nadira',
          sentence: 'The bond between Nadira and Tarek Basri.',
        }),
        expect.objectContaining({ part: 'Nadira', sentence: 'The bond between Mehrana I and Nadira.' }),
      ]),
    );
    // Never inside the full old name.
    for (const o of parts) expect(String(o.sentence).includes(OLD) && o.part === 'Nadira').toBe(false);
    // "al-Khalid" on Mehrana I al-Khalid's own pages: another character sharing the part, flagged.
    const shared = parts.filter((o) => o.part === 'al-Khalid' && typeof o.sharedWith === 'string');
    expect(shared.length).toBeGreaterThan(0);
    expect(shared[0]!.sharedWith).toBe("this page is in Mehrana I al-Khalid's set");
    // Never items: no item names a review-only occurrence's block, and nothing in it is selectable.
    const items = ((r.body.groups as { items: Obj[] }[]) ?? []).flatMap((g) => g.items);
    for (const o of review.occurrences) expect(o.ticked).toBeUndefined();
    expect(items.some((i) => String(i.label).includes('The bond between Nadira and Tarek Basri'))).toBe(
      false,
    );
    expect(review.count).toBe(review.occurrences.length + review.more);
  });

  it('a custom label is listed for review and never written; the rename with one completes', async () => {
    const id = await propose(w);
    const put = intercept(w, 'PUT', /\/blocks\/tr4$/, () => undefined);
    const done = await approve(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(put.count()).toBe(0);
    expect(textOf(w, O.tarim, 'tr4')).toBe(`Its archive was kept by ${OLD}.`);
    const rec = w.stack.runtime.renames.byProposal(id)!;
    const report = (await w.stack.runtime.renames.leftovers(PROJECT, rec.id, { refresh: true }))!;
    expect(report.reviewOnly!.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'custom label',
          page: expect.objectContaining({ id: O.tarim }),
          note: 'custom label: change it in the app if wanted',
        }),
      ]),
    );
  });
});

describe('ADR 0058 amendment C: steering a subject’s rename to arkona_rename', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('update_resource refuses a subject’s rename with USE_ARKONA_RENAME and the hint', async () => {
    const before = w.requests().writes;
    const r = await w.call('update_resource', { page: P.nadiraBio, name: 'Laila al-Khalid - Biography' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('USE_ARKONA_RENAME');
    expect(r.body.error.hint).toContain('arkona_rename');
    expect(r.body.error.hint).toContain('everywhere it is referred to');
    expect(r.body.error.message).toContain('a page of a character’s set');
    // An owner page (a Subject fact), and the low-level route, are refused the same way.
    const owner = await w.call('update_resource', { page: R.velaran, name: 'Velarine - Culture Reference' });
    expect(owner.body.error?.code).toBe('USE_ARKONA_RENAME');
    expect(owner.body.error.message).toContain('a page with a Subject fact');
    // A page that is no subject (Qasr here has neither a Subject fact nor an owner's tag) is renamed as before.
    const plain = await w.call('update_resource', {
      page: O.qasr,
      name: 'Emirate of Qasrin - Polity Reference',
    });
    expect(plain.body.error, plain.text).toBeUndefined();
    const low = await w.call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: P.nadiraBio }, body: { name: '[BSRC] Laila al-Khalid - Biography' } },
    });
    expect(low.body.error?.code).toBe('USE_ARKONA_RENAME');
    const batch = await w.call('lk_api_batch', {
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: P.nadiraBio }, body: { name: '[BSRC] Laila al-Khalid - Biography' } },
        },
      ],
    });
    expect(batch.body.error?.code).toBe('USE_ARKONA_RENAME');
    expect(w.requests().writes).toBe(before);
  });

  it('renaming only the descriptor (after " - ") is never refused', async () => {
    // An Authoritative page's rename is the owner's canonical proposal (ADR 0057 decision 5), never refused here.
    const r = await w.call('update_resource', { page: P.nadiraBio, name: 'Nadira al-Khalid - Life' });
    expect(r.body.error, r.text).toBeUndefined();
    expect(r.body.status).toBe('proposal_captured');
    expect(r.body.changes.name).toEqual({
      before: '[BSRC] Nadira al-Khalid - Biography',
      after: '[BSRC] Nadira al-Khalid - Life',
    });
  });

  it('plainRename lets a subject’s rename through, and its reason is shown with the proposal', async () => {
    const reason = 'fixing a typo in this one page only';
    const r = await w.call('update_resource', {
      page: P.nadiraBio,
      name: 'Nadira al-Khalidh - Biography',
      plainRename: { reason },
    });
    expect(r.body.error, r.text).toBeUndefined();
    expect(r.body.status).toBe('proposal_captured');
    expect(r.body.plainRename).toBe(reason);
    const p = w.stack.runtime.policy.proposals.detail(String(r.body.proposalId))!;
    expect(p.summary).toContain(`(plain rename: ${reason})`);
    expect(JSON.stringify(p.operations)).toContain(reason);
    // At scope write, on a Working character's page (not canon), it runs; the reason is the job's title (the Review
    // page's summary) and is in its journal entry. Without plainRename the same rename is refused.
    const writer = w.stack.newToken('plain-writer', 'write');
    const wc = await w.stack.connect(writer.token);
    const refused = await w.stack.call(wc, 'update_resource', {
      page: C.working,
      name: 'Tamsin Reid - Character Core',
    });
    expect(refused.body.error?.code).toBe('USE_ARKONA_RENAME');
    const run = await w.stack.call(wc, 'update_resource', {
      page: C.working,
      name: 'Tamsin Reid - Character Core',
      plainRename: { reason },
    });
    expect(run.body.status, run.text).toBe('written');
    expect(w.repo.live(C.working)!.name).toBe('[BWRK] Tamsin Reid - Character Core');
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(run.body.jobId))!;
    expect(job.title).toContain(`(plain rename: ${reason})`);
    const entries = w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId: job.id });
    expect(entries.some((e) => (e.operation as Obj | null)?.plainRename === reason)).toBe(true);
  });
});
