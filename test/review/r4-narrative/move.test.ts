/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- tool results and the mock's state are JSON */
/**
 * CR-2026-11-R4, pass 1 (the narrative property): moving canon INTO Narratives (and narrative pages OUT), by every route
 * an agent at scope `write` has: `move_resource`, `lk_api_write`, `lk_api_batch`, `lk_op_*`,
 * `updateResource` with a parent, a template copy, `create_many_resources`, `restore_resource`, a split, a whole set's
 * lifecycle tool and `promote_page` with a destination in Narratives, renaming the Narratives index, and a second index
 * of that name; and what a canon page that got into Narratives loses (its lifecycle tools, the brief, the appraisal, the
 * lifecycle audit). Each test asserts the SAFE behaviour (ADR 0065 E2; the review's brief: "moving any page into or out
 * of Narratives ... must never change its lifecycle silently"). v3 F12 (ADR 0081): at scope `write` such a move (and a
 * canon page made or restored under a story) is the agent's direct write, never silent: it is on the owner's Review page
 * and Revert puts the page back with its lifecycle; the refusals (a narrative page into Working, a look-alike index, a
 * lifecycle tool on narrative pages) stand. Against the mock LegendKeeper only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFECYCLE } from '../../resources/world.js';
import { O } from '../../packs/f4a-world.js';
import { approve } from '../../packs/world.js';
import {
  M,
  PROJECT,
  canonSidebar,
  moveWorld,
  onReview,
  revertJob,
  settle,
  type MoveWorld,
} from './helpers.js';

let w: MoveWorld;
beforeAll(async () => {
  w = await moveWorld();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

const parentOf = (id: string) => w.repo.live(id)?.parentId ?? null;
/** A move that did not happen directly: proposed (for the owner) or refused, and the page still where it was. */
const notDirect = (b: Record<string, any>, id: string, from: string) => {
  // `written` (the resource tools) and `succeeded` (the low-level tools) are both direct writes.
  expect(['written', 'succeeded'], JSON.stringify(b).slice(0, 600)).not.toContain(b.status);
  expect(parentOf(id)).toBe(from);
};
/** The job a write answered (a direct write's, or a batch's), once it has ended. */
const jobOf = async (b: Record<string, any>): Promise<string> => {
  await settle(w, b);
  expect(typeof b.jobId, JSON.stringify(b).slice(0, 600)).toBe('string');
  return String(b.jobId);
};
/**
 * v3 F12 (ADR 0081): a move at scope `write` that ran directly: the job succeeded, the page is where it was sent, and
 * the job is on the owner's Review page with Revert. Answers the job.
 */
const direct = async (b: Record<string, any>, id: string, to: string): Promise<string> => {
  const jobId = await jobOf(b);
  const job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId);
  expect(job?.status, JSON.stringify(b).slice(0, 600)).toBe('succeeded');
  expect(parentOf(id)).toBe(to);
  expect(onReview(w, jobId), 'on the Review page, with Revert').toBe(true);
  return jobId;
};

describe('canon moved INTO Narratives', () => {
  it('NA-00 (control): before any move, a canon page has its lifecycle and is authority', async () => {
    const id = M.canon[7];
    const archive = await w.agent('archive_page', { page: id, dryRun: true });
    expect(archive.status, JSON.stringify(archive).slice(0, 400)).toBe('dry_run');
    const brief = await w.agent('arkona_brief', { subject: id });
    expect(brief.error?.code, JSON.stringify(brief).slice(0, 400)).not.toBe('NARRATIVE_NOT_AUTHORITY');
  });

  it('NA-01: move_resource of a [BSRC] CANON page into a story under Main CANON: direct (v3 F12), on Review', async () => {
    const id = M.canon[0];
    const b = await w.agent('move_resource', { page: id, to: M.story });
    await direct(b, id, M.story);
  });

  it('NA-02: lk_api_write moveResource of a [BSRC] page into Main CANON: direct (v3 F12), on Review', async () => {
    const id = M.canon[1];
    const b = await w.agent('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: id }, body: { parentId: M.main } },
    });
    await direct(b, id, M.main);
  });

  it('NA-03: lk_api_batch moveResource of a [BSRC] page into a story: direct (v3 F12), on Review', async () => {
    const id = M.canon[2];
    const b = await w.agent('lk_api_batch', {
      calls: [
        { operationId: 'moveResource', params: { path: { resourceId: id }, body: { parentId: M.story } } },
      ],
    });
    await direct(b, id, M.story);
  });

  it('NA-04: lk_op_moveResource of a [BSRC] page into a story: direct (v3 F12), on Review', async () => {
    const id = M.canon[3];
    const b = await w.agent('lk_op_moveResource', { path: { resourceId: id }, body: { parentId: M.story } });
    await direct(b, id, M.story);
  });

  it('NA-05: updateResource with a new parent (lk_api_write) moves nothing', async () => {
    const id = M.canon[4];
    const b = await w.agent('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: id }, body: { parentId: M.story } },
    });
    await settle(w, b);
    notDirect(b, id, O.salahadPolities);
  });

  it('NA-06: move_resource of a CANON-tagged canon INDEX (with its [BSRC] page) into Main CANON: direct (v3 F12), on Review', async () => {
    const b = await w.agent('move_resource', { page: M.annals, to: M.main });
    await direct(b, M.annals, M.main);
    expect(parentOf(M.annalsPage)).toBe(M.annals);
  });

  it('NA-07: a [BSRC] page an agent moved into Narratives: its Revert gives it its lifecycle tools back (archive_page, move_to_working)', async () => {
    const id = M.canon[5];
    const jobId = await direct(await w.agent('move_resource', { page: id, to: M.story }), id, M.story);
    // Under Narratives it is a narrative page (as canon the owner files there): no lifecycle, never silently: the move
    // is on the owner's Review page.
    const inside = await w.agent('archive_page', { page: id, dryRun: true });
    expect(inside.error?.code, JSON.stringify(inside).slice(0, 300)).toBe('NARRATIVE_NO_LIFECYCLE');
    expect(await revertJob(w, jobId)).toBe('succeeded');
    expect(parentOf(id)).toBe(O.salahadPolities);
    for (const tool of ['archive_page', 'move_to_working']) {
      const b = await w.agent(tool, { page: id, dryRun: true });
      expect(b.error?.code, `${tool}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe('NARRATIVE_NO_LIFECYCLE');
    }
  });

  it('NA-08: a [BSRC] page an agent moved into Narratives: its Revert makes it authority again (arkona_brief, the appraisal)', async () => {
    const id = M.canon[6];
    const jobId = await direct(await w.agent('move_resource', { page: id, to: M.story }), id, M.story);
    expect(await revertJob(w, jobId)).toBe('succeeded');
    expect(parentOf(id)).toBe(O.salahadPolities);
    const brief = await w.agent('arkona_brief', { subject: id });
    expect.soft(brief.error?.code, JSON.stringify(brief).slice(0, 300)).not.toBe('NARRATIVE_NOT_AUTHORITY');
    const appraisal = await w.agent('arkona_appraise_owner', { page: id });
    expect.soft(appraisal.error?.code, JSON.stringify(appraisal).slice(0, 300)).not.toBe('NARRATIVE_EXEMPT');
  });

  it('NA-14: a template copy named by its [BSRC] template, made under a story (lk_api_write), is canon: direct (v3 F12), on Review', async () => {
    const before = w.repo.children(M.story).length;
    const b = await w.agent('lk_api_write', {
      operationId: 'createResourceFromTemplate',
      params: { body: { templateId: 'tplgen01', parentId: M.story } },
    });
    const jobId = await jobOf(b);
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, jobId)?.status).toBe('succeeded');
    expect(w.repo.children(M.story).length).toBe(before + 1);
    expect(onReview(w, jobId)).toBe(true);
  });

  it('NA-15: create_many_resources: an Authoritative item under a story is direct (v3 F12), on Review; a Working one is refused', async () => {
    const before = w.repo.children(M.story).length;
    const auth = await w.agent('create_many_resources', {
      items: [
        {
          key: 'a',
          name: 'Accord of Smoke',
          template: 'AI General Source',
          parent: M.story,
          status: 'authoritative',
        },
      ],
    });
    expect(auth.status, JSON.stringify(auth).slice(0, 400)).toBe('written');
    expect(onReview(w, await jobOf(auth))).toBe(true);
    expect(w.repo.children(M.story).length).toBe(before + 1);
    const wk = await w.agent('create_many_resources', {
      items: [
        { key: 'b', name: 'Smoke Notes', template: 'AI General Source', parent: M.story, status: 'working' },
      ],
    });
    expect(wk.status, JSON.stringify(wk).slice(0, 400)).not.toBe('written');
    expect(w.repo.children(M.story).length).toBe(before + 1);
  });
});

describe('after canon is in Narratives', () => {
  it('NA-37: a canon page an agent moved into Narratives is reported by the audits (its lifecycle ignored there)', async () => {
    // Control: a Status disagreement on a canon page left where it was (M.canon[7]) is reported by the lifecycle audit.
    const moved = M.canon[0]; // NA-01 moved it into the story (v3 F12: directly)
    expect(parentOf(moved)).toBe(M.story);
    for (const id of [moved, M.canon[7]]) {
      const sb = w.sidebars.pages.get(id)!;
      const kv = sb.props.find((p) => p.kind === 'keyValue')!;
      kv.rows = kv.rows!.map((r) => (r.key === 'Status' ? { ...r, content: [{ text: 'Working' }] } : r));
      sb.version++;
    }
    await w.snapshot();
    const open = (id: string, category: string) =>
      w.stack.runtime.audits
        .list(PROJECT, { category: [category], acknowledged: 'include', limit: 5000 })
        .findings.filter(
          (f: { pageId: string | null; state: string }) => f.pageId === id && f.state === 'open',
        )
        .map((f: { code: string }) => f.code);
    expect(open(M.canon[7], 'lifecycle'), 'control: outside Narratives').toContain('lifecycle_inconsistent');
    // SAFE: in Narratives its lifecycle is ignored, never silently: the narrative audit reports the lifecycle signal it
    // carries there (and the move is on the owner's Review page, with Revert, NA-07).
    expect(open(moved, 'narrative'), 'the canon page moved into Narratives').toContain(
      'narrative_lifecycle_page',
    );
  });

  it('NA-38: restore_resource of a [BSRC] page the owner deleted while it was under a story: direct (v3 F12), on Review', async () => {
    const id = M.canon[3]; // NA-04 moved it into the story (v3 F12: directly)
    expect(parentOf(id)).toBe(M.story);
    await w.snapshot();
    // The owner deletes it (the world's own connection is at scope propose: a proposal, accepted).
    const del = await w.call('delete_resource', { page: id, confirm: true });
    expect(del.body.status, JSON.stringify(del.body).slice(0, 300)).toBe('proposal_captured');
    expect((await approve(w, del.body.proposalId as string)).state).toBe('executed');
    expect(w.repo.live(id)).toBeUndefined();
    const b = await w.agent('restore_resource', { page: id });
    expect(b.status, JSON.stringify(b).slice(0, 500)).toBe('written');
    expect(w.repo.live(id)?.parentId).toBe(M.story);
    expect(onReview(w, await jobOf(b))).toBe(true);
  });
});

describe('a split into Narratives', () => {
  it('NA-40: arkona_split_owner never takes a narrative chapter as an existing owner (canon text into fiction)', async () => {
    const b = await w.agent('arkona_split_owner', {
      source: O.alTibrReference,
      destinations: [
        { key: 'fiction', kind: 'existing', page: M.chapter3, under: 'From the Polity Reference' },
      ],
      map: [{ section: 'Purpose', to: 'fiction' }],
      dryRun: true,
    });
    expect(
      ['written', 'succeeded', 'dry_run', 'proposal_captured'],
      JSON.stringify(b).slice(0, 600),
    ).not.toContain(b.status);
    expect(JSON.stringify(b)).toMatch(/SPLIT_DESTINATION_NOT_OWNER/);
  });
});

describe('narrative pages moved OUT of Narratives', () => {
  it('NA-09: move_resource of a narrative chapter out of Narratives into a canon index: direct (v3 F12), on Review', async () => {
    const b = await w.agent('move_resource', { page: M.chapter, to: O.salahadPolities });
    const jobId = await direct(b, M.chapter, O.salahadPolities);
    // Revert puts it back in its story.
    expect(await revertJob(w, jobId)).toBe('succeeded');
    expect(parentOf(M.chapter)).toBe(M.story);
  });

  it('NA-10: move_resource of a narrative chapter into [INDEX] Working is refused (it would gain a lifecycle place)', async () => {
    const b = await w.agent('move_resource', { page: M.chapter2, to: LIFECYCLE.working });
    notDirect(b, M.chapter2, M.story);
  });
});

describe('a narrative page through a whole set’s lifecycle tool', () => {
  it('NA-13: archive_page with subtree on a story index under Narratives is refused (narrative pages have no lifecycle)', async () => {
    const b = await w.agent('archive_page', { page: M.chronicle, subtree: true, dryRun: true });
    expect(b.error?.code, JSON.stringify(b).slice(0, 500)).toBe('NARRATIVE_NO_LIFECYCLE');
  });

  it('NA-44: promote_page with a destination under Narratives is refused (canon made where its lifecycle is ignored)', async () => {
    // A Working page (flat under [INDEX] Working) with its Working sidebar.
    const draft = 'draftwk1';
    const sb = canonSidebar(draft, 'Draft Notes', 'General Source');
    const kv = sb[0] as { rows: { key: string; content: unknown[] }[] };
    kv.rows = kv.rows.map((r) => (r.key === 'Status' ? { ...r, content: [{ text: 'Working' }] } : r));
    w.sidebars.page(draft, sb);
    w.repo.outside.setTags(draft, ['Working']);
    // Control: the same promotion to a canon index is planned (a dry run).
    const control = await w.agent('promote_page', {
      page: draft,
      destination: O.salahadPolities,
      dryRun: true,
    });
    expect(control.status, JSON.stringify(control).slice(0, 500)).toBe('dry_run');
    const b = await w.agent('promote_page', { page: draft, destination: M.story, dryRun: true });
    expect(b.status, JSON.stringify(b).slice(0, 500)).not.toBe('dry_run');
    expect(b.error?.code, JSON.stringify(b).slice(0, 500)).toBeDefined();
  });
});

describe('the Narratives index itself', () => {
  it('NA-11: renaming Narratives away and a canon index to “Narratives” (update_resource) is not direct; canon under it keeps its lifecycle', async () => {
    const away = await w.agent('update_resource', {
      page: M.narratives,
      name: 'Narratives Shelf',
      plainRename: { reason: 'tidying the root' },
    });
    const swap = await w.agent('update_resource', {
      page: M.institutions,
      name: 'Narratives',
      plainRename: { reason: 'tidying the root' },
    });
    const written = [away, swap].filter((b) => b.status === 'written').length;
    // Whatever was written, the canon page under the renamed index must keep its lifecycle.
    const archive = await w.agent('archive_page', { page: M.institutionsPage, dryRun: true });
    // Put the names back through the bridge (the world's own connection), so the tree agrees.
    const reason = { reason: 'putting the test names back' };
    if (swap.status === 'written')
      await w.call('update_resource', {
        page: M.institutions,
        name: 'Ash Institutions',
        plainRename: reason,
      });
    if (away.status === 'written')
      await w.call('update_resource', { page: M.narratives, name: 'Narratives', plainRename: reason });
    expect
      .soft(archive.error?.code, JSON.stringify(archive).slice(0, 300))
      .not.toBe('NARRATIVE_NO_LIFECYCLE');
    expect.soft(written, JSON.stringify([away, swap]).slice(0, 600)).toBe(0);
  });

  it('NA-12: a second index named “Narratives” (create_bare_resource) is refused, as a lifecycle index’s name is', async () => {
    const b = await w.agent('create_bare_resource', {
      name: '[INDEX] Narratives',
      parent: O.arkonaIndex,
    });
    expect(b.status, JSON.stringify(b).slice(0, 400)).not.toBe('written');
  });
});
