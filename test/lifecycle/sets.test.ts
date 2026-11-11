/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Whole-set lifecycle (C2d, ADR 0037; decided by the owner on 11 November 2026) end to end through the REAL server, the
 * official MCP client, the policy layer and the owner's "Approve and accept as canon": `archive_page`,
 * `unarchive_page`, `move_to_working` and `promote_page` with `subtree: true` on a character set of four pages with a
 * nested index. One canonical proposal per set; the layout kept together; index treatment (tag, note, no Status); each
 * content page's own variant; the refusals (over 100 pages; a mixed or inconsistent set, listing pages); related pages
 * without the set's own links; decision 5 (a page added after capture → conflicted); and a single page unarchived from
 * inside an archived set needs `destination`.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { MockRequest } from '../contract/mock-lk.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDate } from '../../src/lifecycle/index.js';
import { PROJECT } from '../tools/helpers.js';
import { facts } from '../resources/world.js';
import { fact, firstText, kids, placedAmong, seedSet, type SetIds } from './sets.js';
import { accept, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const today = isoDate(Date.now());
const store = () => w.stack.runtime.lifecycle.store;
const res = (id: string) => w.repo.live(id)!;
const LIMITS = {
  'key-min': 5000,
  'write-min': 2000,
  'key-hour': 60000,
  'write-hour': 30000,
  'project-hour': 60000,
};

beforeAll(async () => {
  w = await lifecycleWorld({ env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) }, limits: LIMITS });
  client = await w.stack.connect();
});
afterAll(async () => w.close());

const NOTE_AUTH = (date: string, src: string) =>
  `Archived - ${date}. The author retired ${src} and its applications from Main CANON. The text below records the former design for provenance.`;
const NOTE_WORK = (date: string, src: string) =>
  `Archived - ${date}. The author retired ${src}, a Working concept, without adopting it into Main CANON. The text below records the former design for provenance.`;
const NOTE_INDEX = (date: string, src: string) =>
  `Archived - ${date}. The author retired ${src} and the pages beneath it. They are kept for provenance.`;

/** The set's layout: the root's place, and the structure beneath it. */
function layout(s: SetIds) {
  return {
    rootParent: res(s.root).parentId,
    underRoot: kids(w, s.root),
    underArt: kids(w, s.art),
  };
}

describe('archive_page with subtree: an Authoritative character set', () => {
  let s: SetIds;
  beforeAll(async () => {
    s = await seedSet(w, 'authoritative');
  });

  it('a dry run shows the page count, the estimate and every page’s plan; nothing is written or proposed', async () => {
    const before = w.seen.filter((l) => !l.startsWith('GET')).length;
    const r = await call('archive_page', { page: s.root, subtree: true, dryRun: true });
    expect(r.body, r.text).toMatchObject({
      status: 'dry_run',
      subtree: true,
      requiresCanonicalApproval: true,
      set: {
        pages: 4,
        contentPages: 2,
        indexes: 2,
        from: 'authoritative',
        to: 'archived',
        newParent: { id: LIFECYCLE.archived },
      },
      estimate: { pages: 4 },
    });
    expect(r.body.estimate.reads).toBeGreaterThan(0);
    expect(r.body.estimate.writes).toBe(4 + 10 + 4 + 1);
    expect(r.body.estimate.wallClock).toBeDefined();
    const byId = Object.fromEntries(r.body.pages.map((p: { id: string }) => [p.id, p]));
    expect(byId[s.core]).toMatchObject({ role: 'page', newName: `[BARC] ${s.name} - Character Core` });
    expect(byId[s.root]).toMatchObject({
      role: 'index',
      newName: `[INDEX] ${s.name}`,
      move: { under: { id: LIFECYCLE.archived } },
    });
    expect(byId[s.art].move).toMatch(/stays under its parent/);
    expect(byId[s.art].facts).toEqual([]);
    expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(before);
  });

  it('is ONE canonical proposal; accepted as canon, the whole set is archived together', async () => {
    const before = layout(s);
    const r = await call('archive_page', { page: s.root, subtree: true });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    // One proposal for the set, its operation listing every page.
    const p = w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!;
    expect(p.requiresCanonicalApproval).toBe(true);
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });

    // Layout: the root moved as a group under [INDEX] Archived, in alphabetical place; nothing beneath it moved.
    expect(res(s.root).parentId).toBe(LIFECYCLE.archived);
    expect(placedAmong(kids(w, LIFECYCLE.archived), `[INDEX] ${s.name}`)).toBe(true);
    expect(kids(w, s.root)).toEqual([`[INDEX] ${s.name} Art`, `[BARC] ${s.name} - Character Core`]);
    expect(kids(w, s.art)).toEqual([`[BARC] ${s.name} - Portraits`]);
    expect(before.underRoot.length).toBe(2);

    // Indexes: still [INDEX], no Status, facts untouched, the status tag changed, the note first.
    for (const id of [s.root, s.art]) {
      expect(res(id).name.startsWith('[INDEX] ')).toBe(true);
      expect(res(id).tags).toEqual(['Archived']);
      expect(facts(w, id)).toEqual(['Reference Type=Index', `Index Scope=Scope of ${id}`]);
    }
    expect(firstText(w, s.root)).toBe(NOTE_INDEX(today, s.name));
    expect(firstText(w, s.art)).toBe(NOTE_INDEX(today, `${s.name} Art`));

    // Content pages: C2c's treatment, each by its own previous state (Authoritative here).
    for (const [id, display] of [
      [s.core, `${s.name} - Character Core`],
      [s.portraits, `${s.name} - Portraits`],
    ] as const) {
      expect(res(id).name).toBe(`[BARC] ${display}`);
      expect(fact(w, id, 'Status')).toBe('Archived');
      expect(fact(w, id, 'Continuity Type')).toBe('NON-CURRENT');
      expect(fact(w, id, 'Scope')).toBe(`Archived record of the retired Scope of ${id}`);
      expect(fact(w, id, 'Temporal Scope')).toBe(`Former Main CANON. Retired on ${today}.`);
      expect(fact(w, id, 'Last Major Revision')).toBe(today);
      expect(firstText(w, id)).toBe(NOTE_AUTH(today, display));
    }
    expect(res(s.core).tags).toEqual(['hero', 'Archived']);

    // The set record and each page's own record, linked to it.
    const set = store().setsForRoot(PROJECT, s.root)[0]!;
    expect(set).toMatchObject({ action: 'archive', state: 'complete', previousState: 'authoritative' });
    expect(set.pages.map((x) => x.id).sort()).toEqual([...s.all].sort());
    const recs = store().setRecords(PROJECT, set.id);
    expect(recs.map((x) => x.pageId).sort()).toEqual([...s.all].sort());
    expect(recs.every((x) => x.state === 'complete' && x.setId === set.id)).toBe(true);
  });

  it('a single page unarchived from inside the archived set needs `destination` (its previous parent is in the archive)', async () => {
    const r = await call('unarchive_page', { page: s.portraits });
    expect(r.body.error?.code, r.text).toBe('DESTINATION_REQUIRED');
    const inArchive = await call('unarchive_page', { page: s.portraits, destination: s.art });
    expect(inArchive.body.error?.code, inArchive.text).toBe('LIFECYCLE_AREA');
  });

  it('unarchive_page with subtree: every page back to its own previous state, the root back to its previous parent', async () => {
    const r = await call('unarchive_page', { page: s.root, subtree: true });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.relatedPages).toBeUndefined();
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.root).parentId).toBe('locs0001');
    expect(placedAmong(kids(w, 'locs0001'), `[INDEX] ${s.name}`)).toBe(true);
    expect(kids(w, s.root)).toEqual([`[INDEX] ${s.name} Art`, `[BSRC] ${s.name} - Character Core`]);
    expect(kids(w, s.art)).toEqual([`[BSRC] ${s.name} - Portraits`]);
    for (const id of [s.root, s.art]) {
      expect(res(id).tags).toEqual(['CANON']);
      expect(firstText(w, id)).toBe(`Index ${id}.`);
      expect(facts(w, id)).toEqual(['Reference Type=Index', `Index Scope=Scope of ${id}`]);
    }
    for (const id of [s.core, s.portraits]) {
      expect(fact(w, id, 'Status')).toBe('Authoritative');
      expect(fact(w, id, 'Continuity Type')).toBe('CANON');
      expect(fact(w, id, 'Scope')).toBe(`Scope of ${id}`);
      expect(fact(w, id, 'Temporal Scope')).toBe('Fourth Age');
      expect(fact(w, id, 'Last Major Revision')).toBe(today);
      expect(firstText(w, id)).toBe(`Body of ${id}.`);
    }
    expect(res(s.core).tags).toEqual(['hero', 'CANON']);
    expect(store().setsForRoot(PROJECT, s.root)[0]).toMatchObject({ action: 'unarchive', state: 'complete' });
  });

  it('move_to_working with subtree, then archive (Working variant), unarchive, and promote_page with subtree', async () => {
    // move_to_working: the root under [INDEX] Working; [BWRK]; Status Working; the Working tag on every page.
    const m = await accept(w, await call('move_to_working', { page: s.root, subtree: true }));
    expect(m.body, m.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.root).parentId).toBe(LIFECYCLE.working);
    expect(kids(w, s.art)).toEqual([`[BWRK] ${s.name} - Portraits`]);
    for (const id of s.all) expect(res(id).tags.filter((t) => t !== 'hero')).toEqual(['Working']);
    expect(fact(w, s.core, 'Status')).toBe('Working');
    expect(fact(w, s.core, 'Continuity Type')).toBe('CANON');

    // archive a Working set: each content page's note and Temporal Scope by its own previous state (Working).
    const a = await accept(w, await call('archive_page', { page: s.root, subtree: true }));
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.root).parentId).toBe(LIFECYCLE.archived);
    expect(firstText(w, s.core)).toBe(NOTE_WORK(today, `${s.name} - Character Core`));
    expect(fact(w, s.core, 'Temporal Scope')).toBe(`Former Working concept. Retired on ${today}.`);
    expect(firstText(w, s.root)).toBe(NOTE_INDEX(today, s.name));
    for (const id of s.all) expect(res(id).tags.filter((t) => t !== 'hero')).toEqual(['Archived']);

    // unarchive: back to Working, under [INDEX] Working.
    const u = await accept(w, await call('unarchive_page', { page: s.root, subtree: true }));
    expect(u.body, u.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.root).parentId).toBe(LIFECYCLE.working);
    expect(res(s.core).name).toBe(`[BWRK] ${s.name} - Character Core`);
    expect(fact(w, s.core, 'Status')).toBe('Working');
    for (const id of s.all) expect(res(id).tags.filter((t) => t !== 'hero')).toEqual(['Working']);

    // promote: destination required, the remembered location offered.
    const no = await call('promote_page', { page: s.root, subtree: true });
    expect(no.body.error, no.text).toMatchObject({
      code: 'DESTINATION_REQUIRED',
      suggestedDestination: { id: 'locs0001' },
    });
    const p = await accept(
      w,
      await call('promote_page', { page: s.root, subtree: true, destination: 'locs0001' }),
    );
    expect(p.body, p.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.root).parentId).toBe('locs0001');
    expect(kids(w, s.root)).toEqual([`[INDEX] ${s.name} Art`, `[BSRC] ${s.name} - Character Core`]);
    for (const id of [s.core, s.portraits]) {
      expect(fact(w, id, 'Status')).toBe('Authoritative');
      // Continuity Type kept when CANON or AU (CANON here, from before).
      expect(fact(w, id, 'Continuity Type')).toBe('CANON');
      expect(fact(w, id, 'Last Major Revision')).toBe(today);
    }
    for (const id of s.all) expect(res(id).tags.filter((t) => t !== 'hero')).toEqual(['CANON']);
  });
});

describe('promote_page with subtree: a Working set made Working', () => {
  it('Continuity Type: kept when AU, otherwise CANON; indexes get CANON and no Status', async () => {
    const s = await seedSet(w, 'working');
    const dry = await call('promote_page', {
      page: s.root,
      subtree: true,
      destination: 'locs0001',
      dryRun: true,
    });
    expect(dry.body, dry.text).toMatchObject({
      status: 'dry_run',
      set: { pages: 4, from: 'working', to: 'authoritative' },
    });
    const p = await accept(
      w,
      await call('promote_page', { page: s.root, subtree: true, destination: 'locs0001' }),
    );
    expect(p.body, p.text).toMatchObject({ status: 'written', verified: true });
    expect(fact(w, s.core, 'Continuity Type')).toBe('AU');
    expect(fact(w, s.core, 'Status')).toBe('Authoritative');
    expect(facts(w, s.art)).toEqual(['Reference Type=Index', `Index Scope=Scope of ${s.art}`]);
    expect(res(s.root).tags).toEqual(['CANON']);
  });
});

describe('what a set may hold', () => {
  it('more than 100 pages is refused', async () => {
    w.repo.seed({ id: 'bigroot1', name: '[INDEX] Big Set', parentId: 'locs0001', tags: ['CANON'] });
    for (let i = 0; i < 100; i++)
      w.repo.seed({
        id: `bigp${i.toString().padStart(4, '0')}`,
        name: `[INDEX] Big ${i}`,
        parentId: 'bigroot1',
      });
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await call('archive_page', { page: 'bigroot1', subtree: true, dryRun: true });
    expect(r.body.error, r.text).toMatchObject({ code: 'SET_TOO_LARGE', cap: 100 });
  });

  it('a mixed or inconsistent set is refused, listing each page', async () => {
    const s = await seedSet(w, 'authoritative');
    w.repo.seed({ id: 'mixunc01', name: 'Loose Notes', parentId: s.root });
    w.repo.seed({ id: 'mixwrk01', name: `[BWRK] ${s.name} - Draft`, parentId: s.art });
    // A [BSRC] page whose Status says Working: lifecycle-inconsistent.
    w.sidebars.outside(s.portraits, (sb) => {
      const row = sb.props[0]!.rows!.find((x) => x.key === 'Status')!;
      row.content = [{ text: 'Working' }];
    });
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await call('archive_page', { page: s.root, subtree: true });
    expect(r.body.error?.code, r.text).toBe('SET_NOT_ELIGIBLE');
    const problems = r.body.error.problems as { id: string; problem: string }[];
    expect(problems.find((x) => x.id === 'mixunc01')?.problem).toMatch(/unclassified/);
    expect(problems.find((x) => x.id === 'mixwrk01')?.problem).toMatch(/mixed set/);
    expect(problems.find((x) => x.id === s.portraits)?.problem).toMatch(/inconsistent/);
    expect(res(s.root).parentId).toBe('locs0001');
  });

  it('a lifecycle index inside the set is refused', async () => {
    const r = await call('move_to_working', { page: 'AI REPOSITORY', subtree: true, dryRun: true });
    expect(r.body.error?.code, r.text).toBe('ROOT_PAGE');
    const archive = await call('archive_page', { page: LIFECYCLE.working, subtree: true, dryRun: true });
    expect(archive.body.error?.code, archive.text).toBe('LIFECYCLE_INDEX');
  });
});

describe('decision 5 on a set', () => {
  it('a page added under the set between proposal and approval: conflicted, nothing written', async () => {
    const s = await seedSet(w, 'authoritative');
    const r = await call('archive_page', { page: s.root, subtree: true });
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.repo.seed({ id: 'latecom1', name: `[BSRC] ${s.name} - Late`, parentId: s.art, tags: ['CANON'] });
    const writes = w.seen.filter((l) => !l.startsWith('GET')).length;
    const p = await w.stack.runtime.policy.commands.approveAsCanon('owner', String(r.body.proposalId));
    expect(p.state).toBe('conflicted');
    expect(JSON.stringify(w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!.conflict)).toMatch(
      /1 page\(s\) added/,
    );
    expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(writes);
    expect(res(s.root).parentId).toBe('locs0001');
    expect(res(s.core).name.startsWith('[BSRC] ')).toBe(true);
  });
});

describe('related pages of a set (archive and move to Working)', () => {
  it('every page’s related pages are listed, leaving out the links between pages of the set', async () => {
    const s = await seedSet(w, 'authoritative');
    const lc = w.stack.runtime.lifecycle.store;
    // Inside the set: the Core links to the Portraits; outside: the Harbour Guild links to the Core.
    lc.addLinks(PROJECT, s.core, [{ kind: 'collection', via: 'Dependencies', toId: s.portraits }], 'write');
    lc.addLinks(PROJECT, 'guild001', [{ kind: 'collection', via: 'Dependencies', toId: s.core }], 'write');
    const r = await call('archive_page', { page: s.root, subtree: true, dryRun: true });
    const rel = r.body.relatedPages as {
      pages: { page: { id: string }; pages: { id: string }[] }[];
      excluded: string;
    };
    expect(rel.excluded).toMatch(/left out/);
    const core = rel.pages.find((x) => x.page.id === s.core)!;
    expect(core.pages.map((x) => x.id)).toEqual(['guild001']);
    const port = rel.pages.find((x) => x.page.id === s.portraits);
    expect(port?.pages.map((x) => x.id) ?? []).not.toContain(s.core);
  });
});

describe('decision 5 on a set, inside the lock', () => {
  it('a page added after the approval’s own listing: the job’s first check refuses it, conflicted, nothing written', async () => {
    const s = await seedSet(w, 'authoritative');
    const r = await call('archive_page', { page: s.root, subtree: true });
    const inSet = new Set(s.all);
    let calls = 0;
    const re = /\/resources$/;
    // The approval lists the set (one listing per page); right after it, a page appears under the set.
    w.overrides.set(re, (req: MockRequest) => {
      if (req.method === 'GET' && inSet.has(String(req.query.parentId ?? '')) && ++calls === 5)
        w.repo.seed({ id: 'raceset1', name: `[BSRC] ${s.name} - Racing`, parentId: s.art, tags: ['CANON'] });
      return undefined;
    });
    try {
      const writes = w.seen.filter((l) => !l.startsWith('GET')).length;
      await accept(w, r);
      const pr = w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!;
      expect(pr.state).toBe('conflicted');
      expect(JSON.stringify(pr.conflict)).toMatch(/the set under/);
      expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(writes);
      expect(res(s.root).parentId).toBe('locs0001');
    } finally {
      w.overrides.delete(re);
    }
  });
});

describe('pages of a set on their own', () => {
  it('archiving one page out of a set keeps C2c’s behaviour (flat, directly under [INDEX] Archived)', async () => {
    const s = await seedSet(w, 'authoritative');
    const done = await accept(w, await call('archive_page', { page: s.portraits }));
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.portraits).parentId).toBe(LIFECYCLE.archived);
    expect(kids(w, s.art)).toEqual([]);
    // The rest of the set is untouched.
    expect(res(s.core).name.startsWith('[BSRC] ')).toBe(true);
  });

  it('pages unarchived on their own are no longer part of the set; one not archived with it is refused', async () => {
    const s = await seedSet(w, 'authoritative');
    expect((await accept(w, await call('archive_page', { page: s.root, subtree: true }))).body.status).toBe(
      'written',
    );
    // One page unarchived alone (it needs a destination outside the archive).
    const one = await accept(w, await call('unarchive_page', { page: s.portraits, destination: 'locs0001' }));
    expect(one.body, one.text).toMatchObject({ status: 'written', verified: true });
    const dry = await call('unarchive_page', { page: s.root, subtree: true, dryRun: true });
    expect(dry.body.set?.pages, dry.text).toBe(3);
    expect(JSON.stringify(dry.body.flags)).toMatch(/no longer under it \(unarchived on their own/);
    // A [BARC] page put under the archived set by hand: not archived with this set, so the set is refused.
    w.repo.seed({ id: 'handbarc', name: `[BARC] ${s.name} - By Hand`, parentId: s.art, tags: ['Archived'] });
    w.sidebars.page('handbarc', []);
    await w.stack.runtime.tree.sweep(PROJECT);
    const r = await call('unarchive_page', { page: s.root, subtree: true, dryRun: true });
    expect(r.body.error?.code, r.text).toBe('SET_NOT_ELIGIBLE');
    expect(r.body.error.problems).toEqual([
      expect.objectContaining({
        id: 'handbarc',
        problem: expect.stringMatching(/not archived with this set/),
      }),
    ]);
  });

  it('move_to_working with subtree lists related pages too, without the set’s own links', async () => {
    const s = await seedSet(w, 'authoritative');
    const lc = w.stack.runtime.lifecycle.store;
    lc.addLinks(PROJECT, s.portraits, [{ kind: 'collection', via: 'Dependencies', toId: s.core }], 'write');
    lc.addLinks(
      PROJECT,
      'tides001',
      [{ kind: 'collection', via: 'Dependencies', toId: s.portraits }],
      'write',
    );
    const r = await call('move_to_working', { page: s.root, subtree: true, dryRun: true });
    const rel = r.body.relatedPages as { pages: { page: { id: string }; pages: { id: string }[] }[] };
    expect(rel.pages.find((x) => x.page.id === s.portraits)!.pages.map((x) => x.id)).toEqual(['tides001']);
    expect(rel.pages.find((x) => x.page.id === s.core)?.pages.map((x) => x.id) ?? []).toEqual([]);
  });
});

describe('costs (measured against the mock)', () => {
  const count = (from: number) => {
    const l = w.seen.slice(from);
    const writes = l.filter((x) => !x.startsWith('GET')).length;
    return { reads: l.length - writes, writes };
  };
  it('archive_page with subtree: a 4-page and a 10-page set, to plan and to run', async () => {
    const out: Record<string, unknown> = {};
    for (const [label, extra] of [
      ['4 pages', 0],
      ['10 pages', 6],
    ] as const) {
      const s = await seedSet(w, 'authoritative', { extra });
      expect(s.all).toHaveLength(4 + extra);
      const a = w.seen.length;
      const r = await call('archive_page', { page: s.root, subtree: true });
      const plan = count(a);
      const b = w.seen.length;
      const done = await accept(w, r);
      expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
      out[label] = { plan, job: count(b) };
    }
    process.stdout.write(`SET COSTS ${JSON.stringify(out)}\n`);
    const ten = out['10 pages'] as { plan: { reads: number }; job: { reads: number; writes: number } };
    // 2 indexes and 8 content pages: 10 renames or retags, 8 × 5 facts, 10 notes, 1 move.
    expect(ten.job.writes).toBe(10 + 40 + 10 + 1);
    expect(ten.plan.reads).toBeLessThan(60);
    expect(ten.job.reads).toBeLessThan(200);
  });
});
