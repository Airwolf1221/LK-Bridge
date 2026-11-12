/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Working sets built one page at a time, and moves within a lifecycle area (v2 C2d.1, ADR 0035 and 0037 notes; the owner's
 * live test of 12 November):
 *
 * - a single Working create (`create_resource`, `create_bare_resource`) goes under `[INDEX] Working` (the default), a
 *   Working character's index, or any `[INDEX]` inside a Working set; never under a `[BWRK]` page, a normal-tree index
 *   or `[INDEX] Archived`;
 * - `move_resource` within the Working area and within the Archived area is an ordinary move (no lifecycle change, no
 *   canonical approval), an archived set's index moving with its pages; into or out of either area, and between them, is
 *   still refused; `unarchive_page` still restores from the lifecycle record after a move within the archive;
 * - the set promotion's dry run lists same-subject Working pages that sit outside the set, and after `move_resource`
 *   brings them in the promotion covers them all;
 * - the owner's scenario end to end against the mock: a Working character, two specialist pages added one at a time, the
 *   whole set promoted in one approval.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts, SidebarModel, T } from '../resources/world.js';
import { fact, kids, seedSet, type SetIds } from './sets.js';
import { accept, L, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const res = (id: string) => w.repo.live(id)!;
const store = () => w.stack.runtime.lifecycle.store;

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

describe('moves within the Working area', () => {
  it('a [BWRK] page moves from [INDEX] Working into a Working set’s index and back, alphabetically, with no approval', async () => {
    const s: SetIds = await seedSet(w, 'working');
    const into = await call('move_resource', { page: L.ferry, to: s.root });
    expect(into.body, into.text).toMatchObject({ status: 'written', verified: true });
    expect(res(L.ferry)).toMatchObject({ parentId: s.root, name: '[BWRK] Sky Ferry' });
    expect(kids(w, s.root)).toEqual([
      `[INDEX] ${s.name} Art`,
      `[BWRK] ${s.name} - Character Core`,
      '[BWRK] Sky Ferry',
    ]);
    // Nothing about its lifecycle changed: prefix, Status and tags.
    expect(fact(w, L.ferry, 'Status')).toBe('Working');
    expect(res(L.ferry).tags).toEqual(['Working']);
    // From one Working set index to another inside it (the nested Art index), and back to [INDEX] Working.
    const nested = await call('move_resource', { page: L.ferry, to: s.art });
    expect(nested.body, nested.text).toMatchObject({ status: 'written', verified: true });
    expect(res(L.ferry).parentId).toBe(s.art);
    const back = await call('move_resource', { page: L.ferry, to: LIFECYCLE.working });
    expect(back.body, back.text).toMatchObject({ status: 'written', verified: true });
    expect(res(L.ferry).parentId).toBe(LIFECYCLE.working);
    expect(fact(w, L.ferry, 'Status')).toBe('Working');
  });

  it('a Working set’s index moves with its pages into another Working set’s index and back', async () => {
    const a = await seedSet(w, 'working');
    const b = await seedSet(w, 'working');
    const r = await call('move_resource', { page: b.root, to: a.art });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(res(b.root).parentId).toBe(a.art);
    expect(res(b.core).parentId).toBe(b.root);
    expect(res(b.core).name).toBe(`[BWRK] ${b.name} - Character Core`);
    const back = await call('move_resource', { page: b.root, to: LIFECYCLE.working });
    expect(back.body, back.text).toMatchObject({ status: 'written', verified: true });
    expect(res(b.root).parentId).toBe(LIFECYCLE.working);
  });

  it('nothing goes under a [BWRK] page; into the normal tree, [INDEX] Archived or an archived index is still refused', async () => {
    const s = await seedSet(w, 'working');
    const before = writes().length;
    const under = await call('move_resource', { page: L.ferry, to: s.core });
    expect(under.body.error.code).toBe('PARENT_NOT_INDEX');
    const out = await call('move_resource', { page: L.ferry, to: 'Kumikas' });
    expect(out.body.error, out.text).toMatchObject({ code: 'POLICY_DENIED' });
    expect(out.body.error.message).toMatch(/moved out of \[INDEX\] Working — use promote_page/);
    const into = await call('move_resource', { page: L.ferry, to: LIFECYCLE.archived });
    expect(into.body.error.message).toMatch(/moved into \[INDEX\] Archived — use archive_page/);
    // An Authoritative page cannot go into the Working area, nor a set’s index (out of the normal tree).
    const canon = await call('move_resource', { page: L.guild, to: s.root });
    expect(canon.body.error.message).toMatch(/moved into \[INDEX\] Working — use move_to_working/);
    const setIn = await call('move_resource', { page: s.root, to: LIFECYCLE.archived });
    expect(setIn.body.error.message).toMatch(/use archive_page/);
    expect(writes().length).toBe(before);
    expect(res(L.ferry).parentId).toBe(LIFECYCLE.working);
  });
});

describe('moves within the Archived area', () => {
  let archivedSet: SetIds;
  let otherSet: SetIds;
  beforeAll(async () => {
    archivedSet = await seedSet(w, 'authoritative');
    otherSet = await seedSet(w, 'authoritative');
    for (const s of [archivedSet, otherSet]) {
      const a = await accept(w, await call('archive_page', { page: s.root, subtree: true }));
      expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    }
  });

  it('a [BARC] page moves into an archived set’s index and back with no approval; unarchive_page still restores it from the record', async () => {
    const a = await accept(w, await call('archive_page', { page: L.harbour }));
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    expect(res(L.harbour)).toMatchObject({ parentId: LIFECYCLE.archived, name: '[BARC] Old Harbour' });
    const into = await call('move_resource', { page: L.harbour, to: archivedSet.root });
    expect(into.body, into.text).toMatchObject({ status: 'written', verified: true });
    expect(into.body.status).not.toBe('proposal_captured');
    expect(res(L.harbour)).toMatchObject({ parentId: archivedSet.root, name: '[BARC] Old Harbour' });
    expect(fact(w, L.harbour, 'Status')).toBe('Archived');
    expect(res(L.harbour).tags).toContain('Archived');
    const nested = await call('move_resource', { page: L.harbour, to: archivedSet.art });
    expect(nested.body, nested.text).toMatchObject({ status: 'written', verified: true });
    const back = await call('move_resource', { page: L.harbour, to: LIFECYCLE.archived });
    expect(back.body, back.text).toMatchObject({ status: 'written', verified: true });
    // Moved inside the archive again, then unarchived: it goes back to where it came from (Locations).
    await call('move_resource', { page: L.harbour, to: archivedSet.art });
    const u = await accept(w, await call('unarchive_page', { page: L.harbour }));
    expect(u.body, u.text).toMatchObject({ status: 'written', verified: true });
    expect(res(L.harbour)).toMatchObject({ parentId: 'locs0001', name: '[BSRC] Old Harbour' });
    expect(fact(w, L.harbour, 'Status')).toBe('Authoritative');
  });

  it('an archived set’s index moves with its pages into another archived set’s index and back; the set still unarchives from its record', async () => {
    const r = await call('move_resource', { page: archivedSet.root, to: otherSet.art });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(res(archivedSet.root).parentId).toBe(otherSet.art);
    expect(res(archivedSet.core).parentId).toBe(archivedSet.root);
    expect(res(archivedSet.core).name).toBe(`[BARC] ${archivedSet.name} - Character Core`);
    expect(store().setsForRoot(PROJECT, archivedSet.root)[0]).toMatchObject({ action: 'archive' });
    const back = await call('move_resource', { page: archivedSet.root, to: LIFECYCLE.archived });
    expect(back.body, back.text).toMatchObject({ status: 'written', verified: true });
    expect(res(archivedSet.root).parentId).toBe(LIFECYCLE.archived);
    // Moved inside the archive once more, then unarchived as a set: back under its original parent.
    await call('move_resource', { page: archivedSet.root, to: otherSet.art });
    const u = await accept(w, await call('unarchive_page', { page: archivedSet.root, subtree: true }));
    expect(u.body, u.text).toMatchObject({ status: 'written', verified: true });
    expect(res(archivedSet.root).parentId).toBe('locs0001');
    expect(res(archivedSet.core).name).toBe(`[BSRC] ${archivedSet.name} - Character Core`);
    expect(fact(w, archivedSet.core, 'Status')).toBe('Authoritative');
  });

  it('unarchiving the outer set refuses a set moved into it, listing its pages; moved out again, it works', async () => {
    const outer = await seedSet(w, 'authoritative');
    const inner = await seedSet(w, 'authoritative');
    for (const s of [outer, inner])
      await accept(w, await call('archive_page', { page: s.root, subtree: true }));
    const moved = await call('move_resource', { page: inner.root, to: outer.art });
    expect(moved.body, moved.text).toMatchObject({ status: 'written', verified: true });
    const refused = await call('unarchive_page', { page: outer.root, subtree: true, dryRun: true });
    expect(refused.body.error, refused.text).toMatchObject({ code: 'SET_NOT_ELIGIBLE' });
    expect(refused.body.error.problems.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([inner.root, inner.core]),
    );
    const out = await call('move_resource', { page: inner.root, to: LIFECYCLE.archived });
    expect(out.body, out.text).toMatchObject({ status: 'written', verified: true });
    const ok = await call('unarchive_page', { page: outer.root, subtree: true, dryRun: true });
    expect(ok.body, ok.text).toMatchObject({ status: 'dry_run', set: { pages: 4 } });
  });

  it('into or out of the archive, and between the two areas, is still refused', async () => {
    const before = writes().length;
    const out = await call('move_resource', { page: otherSet.root, to: 'Kumikas' });
    expect(out.body.error, out.text).toMatchObject({ code: 'POLICY_DENIED' });
    expect(out.body.error.message).toMatch(/use unarchive_page/);
    const across = await call('move_resource', { page: otherSet.root, to: LIFECYCLE.working });
    expect(across.body.error.message).toMatch(/move_to_working/);
    const into = await call('move_resource', { page: L.guild, to: otherSet.art });
    expect(into.body.error.message).toMatch(/use archive_page/);
    const nest = await call('move_resource', { page: otherSet.root, to: otherSet.core });
    expect(nest.body.error.code).toBe('PARENT_NOT_INDEX');
    expect(writes().length).toBe(before);
  });
});

describe('single Working creates under a Working set', () => {
  it('create_resource and create_bare_resource: under a Working character index, alphabetically, one page at a time', async () => {
    const c = await call('create_character', { kind: 'core', name: 'Ilka Thorn', race: 'Moon Elf' });
    expect(c.body, c.text).toMatchObject({ status: 'written', verified: true });
    const [idx, core] = c.body.pages;
    const names = (): string[] => childNames(w, idx.id);
    const art = await call('create_resource', {
      name: 'Ilka Thorn - Character Art',
      template: T.general,
      parent: idx.id,
      facts: { Scope: 'Portraits of Ilka' },
    });
    expect(art.body, art.text).toMatchObject({
      status: 'written',
      verified: true,
      lifecycleStatus: 'working',
    });
    expect(art.body.pages[0]).toMatchObject({
      name: '[BWRK] Ilka Thorn - Character Art',
      parent: { id: idx.id },
      status: 'working',
    });
    expect(facts(w, art.body.pages[0].id)).toContain('Status=Working');
    expect(res(art.body.pages[0].id).tags).toContain('Working');
    // By name, too (the index’s name resolves to the one page).
    const rel = await call('create_bare_resource', {
      name: '[BWRK] Ilka Thorn - Relationship',
      parent: '[INDEX] Ilka Thorn',
    });
    expect(rel.body, rel.text).toMatchObject({ status: 'written', verified: true });
    expect(res(rel.body.pages[0].id)).toMatchObject({
      parentId: idx.id,
      name: '[BWRK] Ilka Thorn - Relationship',
    });
    expect(res(rel.body.pages[0].id).tags).toContain('Working');
    // Alphabetical among the index's children, whatever the order made in.
    expect(names()).toEqual([
      '[BWRK] Ilka Thorn - Character Art',
      '[BWRK] Ilka Thorn - Character Core',
      '[BWRK] Ilka Thorn - Relationship',
    ]);
    expect(res(core.id).parentId).toBe(idx.id);
    // [INDEX] Working itself is unchanged: no parent, or the index by name or id.
    const flat = await call('create_resource', { name: 'Zeppelin Dock', template: T.general });
    expect(res(flat.body.pages[0].id).parentId).toBe(LIFECYCLE.working);
    const named = await call('create_bare_resource', { name: '[BWRK] Aqueduct', parent: LIFECYCLE.working });
    expect(res(named.body.pages[0].id).parentId).toBe(LIFECYCLE.working);
  });

  it('under a nested Working set index (a set kept together), and a batch item follows the same rule', async () => {
    const s = await seedSet(w, 'working');
    const r = await call('create_resource', {
      name: `${s.name} - Sketches`,
      template: T.general,
      parent: s.art,
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(res(r.body.pages[0].id).parentId).toBe(s.art);
    expect(kids(w, s.art)).toEqual([`[BWRK] ${s.name} - Portraits`, `[BWRK] ${s.name} - Sketches`]);
    const bare = await call('create_bare_resource', { name: '[BWRK] Aardvark Notes', parent: s.art });
    expect(bare.body, bare.text).toMatchObject({ status: 'written' });
    expect(kids(w, s.art)[0]).toBe('[BWRK] Aardvark Notes');
    const many = await call('create_many_resources', {
      items: [{ key: 'a', name: '[BWRK] Batch Page', parent: s.art }],
    });
    expect(many.body, many.text).toMatchObject({ status: 'written', verified: true });
    expect(res(many.body.pages[0].id).parentId).toBe(s.art);
  });

  it('refused under a [BWRK] page, a normal-tree index, [INDEX] Archived or an archived set; the allowed parents are named', async () => {
    const s = await seedSet(w, 'working');
    const before = writes().length;
    for (const [tool, args] of [
      ['create_resource', { name: 'X One', template: T.general }],
      ['create_bare_resource', { name: '[BWRK] X Two' }],
    ] as const) {
      for (const parent of [s.core, 'Kumikas', LIFECYCLE.archived, 'locs0001']) {
        const r = await call(tool, { ...args, parent });
        expect(r.body.error, `${tool} under ${parent}: ${r.text}`).toMatchObject({ code: 'WORKING_PARENT' });
      }
    }
    const refused = await call('create_resource', { name: 'X One', template: T.general, parent: s.core });
    expect(refused.body.error.message).toMatch(/nothing goes under a Working page/);
    expect(refused.body.error.message).toContain('[INDEX] Working');
    expect(refused.body.error.allowedParents.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([LIFECYCLE.working, s.root, s.art]),
    );
    expect(writes().length).toBe(before);
    const archived = await seedSet(w, 'authoritative');
    await accept(w, await call('archive_page', { page: archived.root, subtree: true }));
    const before2 = writes().length;
    const inArchive = await call('create_resource', {
      name: 'X Three',
      template: T.general,
      parent: archived.art,
    });
    expect(inArchive.body.error).toMatchObject({ code: 'WORKING_PARENT' });
    const bareArchive = await call('create_bare_resource', { name: '[BWRK] X Four', parent: archived.root });
    expect(bareArchive.body.error).toMatchObject({ code: 'WORKING_PARENT' });
    expect(writes().length).toBe(before2);
    // An Authoritative page still cannot go under a Working set’s index either.
    const auth = await call('create_resource', {
      name: 'X Five',
      template: T.general,
      parent: s.root,
      status: 'authoritative',
    });
    expect(auth.body.error).toMatchObject({ code: 'LIFECYCLE_AREA' });
  });
});

describe('unarchiving a Working page returns it to the Working set it came from', () => {
  it('a Working specialist page archived on its own goes back under its set’s index, not flat under [INDEX] Working', async () => {
    const s = await seedSet(w, 'working');
    const a = await accept(w, await call('archive_page', { page: s.portraits }));
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.portraits).parentId).toBe(LIFECYCLE.archived);
    const u = await accept(w, await call('unarchive_page', { page: s.portraits }));
    expect(u.body, u.text).toMatchObject({ status: 'written', verified: true });
    expect(res(s.portraits)).toMatchObject({ parentId: s.art, name: `[BWRK] ${s.name} - Portraits` });
    expect(fact(w, s.portraits, 'Status')).toBe('Working');
  });
});

describe('promoting a set: Working pages of the same subject outside it', () => {
  it('the dry run lists them and suggests move_resource; after they are moved in, the promotion covers them all', async () => {
    const c = await call('create_character', { kind: 'core', name: 'Outsider Test', race: 'Moon Elf' });
    expect(c.body, c.text).toMatchObject({ status: 'written' });
    const [idx, core] = c.body.pages;
    // Two specialist pages made the old way: flat under [INDEX] Working. Another Working page is unrelated.
    const art = await call('create_resource', { name: 'Outsider Test - Character Art', template: T.general });
    const rel = await call('create_resource', { name: 'Outsider Test - Relationship', template: T.general });
    expect(res(art.body.pages[0].id).parentId).toBe(LIFECYCLE.working);
    const dry = await call('promote_page', {
      page: idx.id,
      subtree: true,
      destination: 'moonelf1',
      dryRun: true,
    });
    expect(dry.body, dry.text).toMatchObject({ status: 'dry_run', set: { pages: 2 } });
    expect(dry.body.outsiders.pages.map((p: { name: string }) => p.name).sort()).toEqual([
      '[BWRK] Outsider Test - Character Art',
      '[BWRK] Outsider Test - Relationship',
    ]);
    expect(dry.body.outsiders.suggestion).toMatch(/move_resource/);
    expect(dry.body.outsiders.suggestion).toContain(idx.id);
    expect(dry.body.flags.join(' ')).toMatch(/2 Working pages of the same subject sit outside this set/);
    // The unrelated Working page (Sky Ferry) is not listed.
    expect(JSON.stringify(dry.body.outsiders)).not.toContain('Sky Ferry');
    // Move them in, as suggested; then the dry run is clean and covers all four pages.
    for (const p of [art.body.pages[0], rel.body.pages[0]]) {
      const m = await call('move_resource', { page: p.id, to: idx.id });
      expect(m.body, m.text).toMatchObject({ status: 'written', verified: true });
    }
    const clean = await call('promote_page', {
      page: idx.id,
      subtree: true,
      destination: 'moonelf1',
      dryRun: true,
    });
    expect(clean.body, clean.text).toMatchObject({ status: 'dry_run', set: { pages: 4 } });
    expect(clean.body.outsiders).toBeUndefined();
    const p = await accept(
      w,
      await call('promote_page', { page: idx.id, subtree: true, destination: 'moonelf1' }),
    );
    expect(p.body, p.text).toMatchObject({ status: 'written', verified: true });
    for (const id of [core.id, art.body.pages[0].id, rel.body.pages[0].id]) {
      expect(res(id).name.startsWith('[BSRC] ')).toBe(true);
      expect(fact(w, id, 'Status')).toBe('Authoritative');
      expect(res(id).parentId).toBe(idx.id);
    }
    expect(res(idx.id).parentId).toBe('moonelf1');
  });
});

/** A Working page of `subject` made the old way: flat under [INDEX] Working, with the lifecycle facts. */
let flatSeq = 0;
async function seedFlat(subject: string, suffix: string): Promise<string> {
  const id = `fo${(++flatSeq).toString().padStart(6, '0')}`;
  w.repo.seed({ id, name: `[BWRK] ${subject} - ${suffix}`, parentId: LIFECYCLE.working, tags: ['Working'] });
  w.sidebars.page(id, [
    SidebarModel.kv(`kv${id.slice(0, 6)}`, 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Working'],
      ['Continuity Type', 'AU'],
      ['Scope', `Scope of ${id}`],
      ['Temporal Scope', 'Fourth Age'],
      ['Last Major Revision', '2026-10-01'],
    ]),
  ]);
  w.repo.blocks.set(w.main(id), {
    version: 2,
    blocks: [{ id: `${id}b1`, kind: 'paragraph', content: [{ text: `Body of ${id}.` }] }],
  });
  await w.stack.runtime.tree.sweep(PROJECT);
  return id;
}

describe('archiving and moving to Working a set: Working pages of the same subject outside it (C2d.2)', () => {
  const names = (b: { outsiders?: unknown }): string[] =>
    (b.outsiders as { pages: { name: string }[] }).pages.map((p) => p.name).sort();

  it('archive_page with subtree lists them in the dry run and the proposal, and after they are moved in the archive takes them all', async () => {
    const s = await seedSet(w, 'working');
    const art = await seedFlat(s.name, 'Character Art');
    const rel = await seedFlat(s.name, 'Relationship');
    await seedFlat('Somebody Else', 'Notes'); // an unrelated Working page: never listed
    const dry = await call('archive_page', { page: s.root, subtree: true, dryRun: true });
    expect(dry.body, dry.text).toMatchObject({
      status: 'dry_run',
      set: { pages: 4, from: 'working', to: 'archived' },
    });
    expect(names(dry.body)).toEqual([`[BWRK] ${s.name} - Character Art`, `[BWRK] ${s.name} - Relationship`]);
    expect(dry.body.outsiders.suggestion).toMatch(/move_resource/);
    expect(dry.body.outsiders.suggestion).toMatch(/archiving the set would leave them Working/);
    expect(dry.body.outsiders.suggestion).toMatch(/archive the whole set/);
    expect(dry.body.outsiders.suggestion).toContain(s.root);
    expect(dry.body.flags.join(' ')).toMatch(
      /2 Working pages of the same subject sit outside this set, flat under \[INDEX\] Working, and would stay Working, left behind when the set is archived/,
    );
    expect(JSON.stringify(dry.body.outsiders)).not.toContain('Somebody Else');
    // Move them in, as suggested: the dry run is clean and covers all six pages; the archive takes them all.
    for (const id of [art, rel]) {
      const m = await call('move_resource', { page: id, to: s.root });
      expect(m.body, m.text).toMatchObject({ status: 'written', verified: true });
    }
    const clean = await call('archive_page', { page: s.root, subtree: true, dryRun: true });
    expect(clean.body, clean.text).toMatchObject({ status: 'dry_run', set: { pages: 6 } });
    expect(clean.body.outsiders).toBeUndefined();
    const a = await accept(w, await call('archive_page', { page: s.root, subtree: true }));
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    for (const id of [art, rel, s.core, s.portraits]) {
      expect(res(id).name.startsWith('[BARC] ')).toBe(true);
      expect(res(id).tags).toContain('Archived');
    }
    expect(res(s.root).parentId).toBe(LIFECYCLE.archived);
  });

  it('the proposal carries the same listing and flag, so the owner sees them before approving', async () => {
    const s = await seedSet(w, 'working');
    await seedFlat(s.name, 'Character Art');
    await seedFlat(s.name, 'Relationship');
    const before = writes().length;
    const proposal = await call('archive_page', { page: s.root, subtree: true });
    expect(proposal.body, proposal.text).toMatchObject({ status: 'proposal_captured' });
    expect(names(proposal.body)).toEqual([
      `[BWRK] ${s.name} - Character Art`,
      `[BWRK] ${s.name} - Relationship`,
    ]);
    expect(proposal.body.flags.join(' ')).toMatch(/2 Working pages of the same subject sit outside this set/);
    expect(writes().length).toBe(before); // proposing wrote nothing
    // and what the owner is shown of it (the stored operation, on the dashboard) has them too
    const stored = w.stack.runtime.policy.proposals.detail(proposal.body.proposalId as string)!;
    const op = stored.operations[0] as { lifecycle: { outsiders: { pages: unknown[] }; flags: string[] } };
    expect(op.lifecycle.outsiders.pages).toHaveLength(2);
    expect(op.lifecycle.flags.join(' ')).toMatch(/2 Working pages of the same subject sit outside this set/);
  });

  it('archive_page with subtree on an Authoritative set lists same-subject Working pages too, and says they cannot be moved in', async () => {
    const s = await seedSet(w, 'authoritative');
    const draft = await seedFlat(s.name, 'Draft Notes');
    const dry = await call('archive_page', { page: s.root, subtree: true, dryRun: true });
    expect(dry.body, dry.text).toMatchObject({
      status: 'dry_run',
      set: { from: 'authoritative', to: 'archived' },
    });
    expect(dry.body.outsiders.pages).toEqual([
      { id: draft, name: `[BWRK] ${s.name} - Draft Notes`, subject: s.name },
    ]);
    expect(dry.body.flags.join(' ')).toMatch(/1 Working page of the same subject sit outside this set/);
    // a Working page cannot be moved into an Authoritative set: the advice is to archive each, not to move_resource it in
    expect(dry.body.flags.join(' ')).toContain('cannot be moved into an Authoritative set');
    expect(dry.body.outsiders.suggestion).toMatch(/archive each with archive_page too/);
    const refused = await call('move_resource', { page: draft, to: s.root });
    expect(refused.body.error?.message).toMatch(/use promote_page|moved out of \[INDEX\] Working|lifecycle/);
  });

  it('move_to_working with subtree lists them, with the words for that change, in the dry run and the proposal', async () => {
    const s = await seedSet(w, 'authoritative');
    const draft = await seedFlat(s.name, 'Working Notes');
    const dry = await call('move_to_working', { page: s.root, subtree: true, dryRun: true });
    expect(dry.body, dry.text).toMatchObject({
      status: 'dry_run',
      set: { from: 'authoritative', to: 'working' },
    });
    expect(dry.body.outsiders.pages.map((p: { id: string }) => p.id)).toEqual([draft]);
    expect(dry.body.outsiders.suggestion).toMatch(/not be part of the Working set this makes/);
    expect(dry.body.outsiders.suggestion).toMatch(/Once the set is Working, move each in with move_resource/);
    expect(dry.body.flags.join(' ')).toContain(`apart from the Working set under “[INDEX] ${s.name}”`);
    expect(dry.body.flags.join(' ')).toContain('Once the set is Working, bring them in with move_resource');
    const proposal = await call('move_to_working', { page: s.root, subtree: true });
    expect(proposal.body, proposal.text).toMatchObject({ status: 'proposal_captured' });
    expect(proposal.body.outsiders.pages.map((p: { id: string }) => p.id)).toEqual([draft]);
  });

  it('after move_to_working the outsider can be brought into the set, as the advice says', async () => {
    const s = await seedSet(w, 'authoritative');
    const draft = await seedFlat(s.name, 'Working Notes 2');
    const m = await accept(w, await call('move_to_working', { page: s.root, subtree: true }));
    expect(m.body, m.text).toMatchObject({ status: 'written', verified: true });
    const mv = await call('move_resource', { page: draft, to: s.root });
    expect(mv.body, mv.text).toMatchObject({ status: 'written', verified: true });
    expect(res(draft).parentId).toBe(s.root);
    expect(res(draft).name).toBe(`[BWRK] ${s.name} - Working Notes 2`);
  });

  it('a set with no same-subject Working page outside it lists nothing, and unarchive never does', async () => {
    const s = await seedSet(w, 'authoritative');
    await seedFlat('Someone Unrelated', 'Notes');
    for (const tool of ['archive_page', 'move_to_working'] as const) {
      const dry = await call(tool, { page: s.root, subtree: true, dryRun: true });
      expect(dry.body.status, dry.text).toBe('dry_run');
      expect(dry.body.outsiders, tool).toBeUndefined();
    }
    // A Working page of the set's own subject exists, but unarchive brings pages back from the Archived area only.
    await accept(w, await call('archive_page', { page: s.root, subtree: true }));
    await seedFlat(s.name, 'Late Notes');
    const un = await call('unarchive_page', { page: s.root, subtree: true, dryRun: true });
    expect(un.body.status, un.text).toBe('dry_run');
    expect(un.body.outsiders).toBeUndefined();
  });
});

describe('the owner’s live scenario (12 November), against the mock', () => {
  it('a Working character, two specialist pages added one at a time, the whole set promoted in one approval', async () => {
    const created = await call('create_character', {
      kind: 'core',
      name: 'Working Test Character 1112',
      race: 'Moon Elf',
    });
    expect(created.body, created.text).toMatchObject({
      status: 'written',
      verified: true,
      lifecycleStatus: 'working',
    });
    const [idx, core] = created.body.pages;
    expect(idx).toMatchObject({
      name: '[INDEX] Working Test Character 1112',
      parent: { id: LIFECYCLE.working },
    });
    expect(core).toMatchObject({
      name: '[BWRK] Working Test Character 1112 - Character Core',
      parent: { id: idx.id },
    });
    // The two specialist pages, one call each, under the character's index (as an agent works).
    const art = await call('create_resource', {
      name: 'Working Test Character 1112 - Character Art',
      template: T.general,
      parent: idx.id,
    });
    expect(art.body, art.text).toMatchObject({ status: 'written', verified: true });
    const rel = await call('create_resource', {
      name: 'Working Test Character 1112 - Relationship',
      template: T.general,
      parent: idx.id,
    });
    expect(rel.body, rel.text).toMatchObject({ status: 'written', verified: true });
    const all = [core.id, art.body.pages[0].id, rel.body.pages[0].id];
    for (const id of all) expect(res(id).parentId).toBe(idx.id);
    // Nothing outside the set: the dry run has no outsiders and covers four pages.
    const dry = await call('promote_page', {
      page: idx.id,
      subtree: true,
      destination: 'moonelf1',
      dryRun: true,
    });
    expect(dry.body, dry.text).toMatchObject({
      status: 'dry_run',
      set: { pages: 4, from: 'working', to: 'authoritative' },
    });
    expect(dry.body.outsiders).toBeUndefined();
    // ONE approval for the whole set.
    const proposal = await call('promote_page', { page: idx.id, subtree: true, destination: 'moonelf1' });
    expect(proposal.body, proposal.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
    });
    const done = await accept(w, proposal);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    // All four land under the race index as [BSRC].
    expect(res(idx.id)).toMatchObject({ parentId: 'moonelf1', name: '[INDEX] Working Test Character 1112' });
    expect(childNames(w, idx.id)).toEqual([
      '[BSRC] Working Test Character 1112 - Character Art',
      '[BSRC] Working Test Character 1112 - Character Core',
      '[BSRC] Working Test Character 1112 - Relationship',
    ]);
    for (const id of all) {
      expect(fact(w, id, 'Status')).toBe('Authoritative');
      expect(res(id).tags).toContain('CANON');
      expect(res(id).tags).not.toContain('Working');
    }
    expect(childNames(w, 'moonelf1')).toContain('[INDEX] Working Test Character 1112');
    expect(childNames(w, LIFECYCLE.working)).not.toContain('[INDEX] Working Test Character 1112');
    expect(store().setsForRoot(PROJECT, idx.id)[0]).toMatchObject({ action: 'promote', state: 'complete' });
  });
});
