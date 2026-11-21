/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * CR-2026-11-R3's four low findings (docs/reviews/CR-2026-11-R3.md section 7), as built after the review: what their own
 * tests (AP-16, AP-19, RN-54, RN-57, RN-62) do not reach. R3-58 on `lk_api_batch` and on a page whose sidebar cannot be
 * read; R3-56 on "Propose these again" of a left-out page name; R3-59 on a name fix run at scope write. Against the
 * mock LegendKeeper only (the R3-59 case on the fix planner alone).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { proposeAppraisalFix, type FixDeps } from '../../../src/appraisal/fixes.js';
import type { AppraisalFinding } from '../../../src/appraisal/types.js';
import { placeInSequence } from '../../../src/packs/rename/place.js';
import { COLLATOR } from '../../../src/registry/ordering.js';
import { C, P, PROJECT, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { approveItems, itemsOf, proposeRename, reproposeOrigin } from '../r3-approval/helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const code = (r: { body: any }) => (r.body.error?.code as string | undefined) ?? null;

describe('R3-58: the steering’s live read on the other low-level routes', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  /** A page the tree's properties pass has not read (its stored sidebar unknown). */
  const unread = (id: string) =>
    w.stack.db
      .prepare('UPDATE tree_nodes SET sidebar = NULL WHERE project_id = ? AND id = ?')
      .run(PROJECT, id);
  const reads = (a: { all: number; writes: number }, b: { all: number; writes: number }) =>
    b.all - b.writes - (a.all - a.writes);

  it('lk_api_batch reads each such page once and refuses a subject’s rename before anything is queued', async () => {
    unread(P.hollowWorking);
    unread(P.untagged);
    const before = w.requests();
    const r = await w.call('lk_api_batch', {
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: P.hollowWorking }, body: { name: '[BWRK] Hollow Hall Draft' } },
        },
        {
          operationId: 'updateResource',
          params: { path: { resourceId: P.hollowWorking }, body: { name: '[BWRK] Hollow Hall Notes' } },
        },
        {
          operationId: 'updateResource',
          params: { path: { resourceId: P.untagged }, body: { name: '[BSRC] Orskhaven - Polity Reference' } },
        },
      ],
    });
    const after = w.requests();
    expect(code(r), r.text.slice(0, 300)).toBe('USE_ARKONA_RENAME');
    expect(r.body.error.callIndex).toBe(2);
    // One read for each page whose answer turned on its sidebar (the Working page once, for two calls); no write.
    expect({ reads: reads(before, after), writes: after.writes - before.writes }).toEqual({
      reads: 2,
      writes: 0,
    });
    expect(w.repo.live(P.hollowWorking)!.name).toBe('[BWRK] Hollow Court Draft');
  });

  it('a page whose sidebar cannot be read is answered as update_resource answers it: nothing is written', async () => {
    unread(P.untagged);
    const page = new RegExp(`/resources/${P.untagged}$`);
    const before = w.requests();
    w.failNext('GET', page);
    const low = await w.call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: P.untagged }, body: { name: '[BSRC] Orskhaven - Polity Reference' } },
    });
    w.failNext('GET', page);
    const high = await w.call('update_resource', { page: P.untagged, name: 'Orskhaven - Polity Reference' });
    expect(low.isError, low.text.slice(0, 300)).toBe(true);
    expect({ code: code(low), lkCode: low.body.error?.lkCode }).toEqual({
      code: code(high),
      lkCode: high.body.error?.lkCode,
    });
    expect(w.requests().writes).toBe(before.writes);
    expect(w.repo.live(P.untagged)!.name).toBe('[BSRC] Orsk Harbour - Polity Reference');
  });
});

describe('R3-56: the re-placing moves in sequence (src/packs/rename/place.ts)', () => {
  type Page = { id: string; name: string; kind: 'bsrc' };
  /** The parent's order after each rename and its move, as LegendKeeper makes them (beside the anchor named). */
  const run = (start: Page[], renames: { id: string; to: string }[]) => {
    const placed = placeInSequence(
      start,
      renames.map((r) => ({ ...r, item: `name:${r.id}` })),
    );
    const list = start.map((p) => ({ ...p }));
    let moves = 0;
    for (const r of renames) {
      const at = list.findIndex((p) => p.id === r.id);
      const page = { ...list[at]!, name: r.to };
      list[at] = page;
      const pl = placed.get(r.id)!;
      if (!pl.moves) continue;
      moves++;
      list.splice(at, 1);
      const anchor = list.findIndex((p) => p.id === (pl.slot.after ?? pl.slot.before));
      list.splice(pl.slot.after ? anchor + 1 : anchor, 0, page);
    }
    return { names: list.map((p) => p.name), moves };
  };
  const inOrder = (names: string[]) =>
    names.every((n, i) => i === 0 || COLLATOR.compare(names[i - 1]!, n) <= 0);

  it('a set already in order, renamed whole, moves none of its pages', () => {
    const start = ['Nadira - Art', 'Nadira - Biography', 'Nadira - Core'].map((name, i) => ({
      id: `p${i}`,
      name,
      kind: 'bsrc' as const,
    }));
    const r = run(
      start,
      start.map((p) => ({ id: p.id, to: p.name.replace('Nadira', 'Laila') })),
    );
    expect(r).toEqual({ names: ['Laila - Art', 'Laila - Biography', 'Laila - Core'], moves: 0 });
  });

  it('never beside a sibling still to be renamed: the parent ends in order (2,000 seeded cases)', () => {
    let seed = 20261121;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const word = () =>
      Array.from({ length: 3 }, () => String.fromCharCode(97 + rand(6))).join('') + rand(1000);
    for (let t = 0; t < 2000; t++) {
      const n = 2 + rand(7);
      const pages: Page[] = Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        name: word(),
        kind: 'bsrc',
      }));
      const renamedIds = pages.filter(() => rand(3) > 0).map((p) => p.id);
      if (renamedIds.length === 0) renamedIds.push(pages[0]!.id);
      // The pages the rename does not touch stand in order among themselves; the rest anywhere.
      const fixed = pages
        .filter((p) => !renamedIds.includes(p.id))
        .sort((a, b) => COLLATOR.compare(a.name, b.name));
      const order = [...pages].sort(() => rand(3) - 1);
      let k = 0;
      const start = order.map((p) => (renamedIds.includes(p.id) ? p : fixed[k++]!));
      const renames = [...renamedIds].sort(() => rand(3) - 1).map((id) => ({ id, to: word() }));
      const r = run(start, renames);
      expect(inOrder(r.names), `case ${t}: ${JSON.stringify({ start, renames, end: r.names })}`).toBe(true);
    }
  });
});

describe('R3-56: "Propose these again" of a page name the owner left out', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('the re-proposed page is placed among the names the approved part wrote: the set ends in order', async () => {
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const art = [`name:${P.nadiraArt}`, `facts:${P.nadiraArt}`, `aliases:${P.nadiraArt}`];
    const keep = plan.items.filter((i) => i.selected && !art.includes(i.id)).map((i) => i.id);
    const first = await approveItems(w, id, keep);
    expect(first.job?.status, JSON.stringify(first.job?.lastError)).toBe('succeeded');
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id));
    const present = itemsOf(w, again.proposalId).items.map((i) => i.id);
    const second = await approveItems(
      w,
      again.proposalId,
      art.filter((x) => present.includes(x)),
    );
    expect(second.job?.status, JSON.stringify(second.job?.lastError)).toBe('succeeded');
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Laila al-Khalid - Character Art');
    const names = w.repo.children(C.nadiraIndex).map((r) => r.name.replace(/^\[[A-Z]{4,5}\]\s*/, ''));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('R3-59: the em-dash name fix run as a job (the pack’s switch: follow the agent’s scope)', () => {
  const finding = {
    id: 'af_00000000000000000001',
    tool: 'arkona_appraise_owner',
    check: 'em_dash_name',
    page: { id: 'apdashnm', name: '[BSRC] Gata—Lund - Polity Reference' },
    followUp: {
      kind: 'fix',
      tool: 'arkona_appraisal_fix',
      args: { findingId: 'af_00000000000000000001' },
      change: '',
    },
    fix: { kind: 'em_dash_name', args: {} },
  } as unknown as AppraisalFinding;
  const run = async (subject: boolean) => {
    const sent: Record<string, unknown>[] = [];
    const deps: FixDeps = {
      projectId: PROJECT,
      read: () =>
        Promise.resolve({
          id: 'apdashnm',
          name: '[BSRC] Gata—Lund - Polity Reference',
          tags: ['CANON', 'Polity'],
          parentId: null,
          properties: [],
        }),
      submit: (req) => {
        sent.push(req);
        return Promise.resolve({ jobId: 'job_r359', status: 'queued' });
      },
      origin: { kind: 'mcp', tool: 'arkona_appraisal_fix' },
      forceProposal: false,
      node: () => null,
      children: () => [],
      assetsIn: () => [],
      propertiesName: 'PROPERTIES',
      subjectRename: () => subject,
    };
    const r = await proposeAppraisalFix(deps, finding);
    const req = sent[0] as {
      title: string;
      steps: { op: string; journalOperation?: Record<string, unknown> }[];
    };
    return {
      r,
      title: req.title,
      journal: req.steps.find((s) => s.op === 'updateResource')!.journalOperation,
    };
  };

  it('a subject’s name fix carries its plain-rename reason in the job’s title and the journal entry', async () => {
    const { r, title, journal } = await run(true);
    expect(r.status).toBe('submitted');
    expect(title).toMatch(/\(plain rename: the dash replaced in this page’s name only; .*“Gata—Lund”/);
    expect(String(journal?.plainRename)).toContain('arkona_rename renames a subject everywhere');
  });

  it('a name fix that changes no subject’s name says nothing of a plain rename', async () => {
    const { title, journal } = await run(false);
    expect(title).not.toMatch(/plain rename/);
    expect(journal?.plainRename).toBeUndefined();
  });
});
