/**
 * v3 F3d (ADR 0053): the lifecycle tag leads on a project whose pack says so (`lifecycleTagPosition`, Arkona's), and the
 * lifecycle tools apply the owner's AU ruling (ADR 0052 decision 6) on a project whose pack carries it.
 *
 * - Without an approved pack: ADR 0035 exactly (the tag appended, CANON for an AU page): the other lifecycle tests
 *   cover that, unchanged; one case here pins the AU page.
 * - `lead`: move_to_working removes the status tag (CANON or AU) and puts Working first; archive_page puts Archived first
 *   (from Authoritative or Working); promote_page removes Working and puts the status tag first; unarchive_page puts
 *   what its target needs where Archived was (first). Every other tag keeps its order. Whole sets alike.
 * - AU: promote_page and unarchive_page (to Authoritative) give an AU page `AU`, an ordinary page `CANON`; the guard
 *   treats AU as a status tag (only the lifecycle tools add or remove it).
 * - The pack's position is per project: a project it does not name keeps `append`, with the AU ruling.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { fact, seedSet } from './sets.js';
import { approveTagRules } from '../packs/tag-rules.js';
import { LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const tags = (id: string) => [...w.repo.res.get(id)!.tags];
/** v3 F12 (ADR 0081): at scope write a lifecycle tool is direct: written, as a job on the Review page. */
const done = async (tool: string, args: Record<string, unknown>) => {
  const r = await call(tool, args);
  expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
  return r;
};

let seq = 0;
/**
 * One page with the five lifecycle facts, its tags in this order, and a Main document. Seeded in the model only: the
 * tree learns every page in one sweep (`beforeAll`), since a sweep per page would spend the per-minute read budget.
 */
function page(state: 'authoritative' | 'working', pageTags: string[], continuityType = 'CANON'): string {
  seq++;
  const id = `lead${seq.toString(36).padStart(4, '0')}`;
  const name = `Lead Page ${seq}`;
  w.repo.seed({
    id,
    name: `${state === 'working' ? '[BWRK]' : '[BSRC]'} ${name}`,
    parentId: state === 'working' ? LIFECYCLE.working : 'locs0001',
    tags: pageTags,
  });
  w.sidebars.page(id, [
    SidebarModel.kv(`kv${id.slice(0, 6)}`, 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', state === 'working' ? 'Working' : 'Authoritative'],
      ['Continuity Type', continuityType],
      ['Scope', `Scope of ${name}`],
      ['Temporal Scope', 'Fourth Age'],
      ['Last Major Revision', '2026-10-01'],
    ]),
  ]);
  w.repo.blocks.set(w.main(id), {
    version: 2,
    blocks: [{ id: `${id}b1`, kind: 'paragraph', content: [{ text: `Body of ${name}.` }] }],
  });
  return id;
}

/** The pages the tests use, seeded once (state, tags in order, Continuity Type). */
const SPECS = {
  defaultAu: ['working', ['Working', 'Culture'], 'AU'],
  move: ['authoritative', ['Culture', 'CANON', 'Language'], 'CANON'],
  moveAu: ['authoritative', ['AU', 'Culture'], 'AU'],
  archiveAuth: ['authoritative', ['Magic', 'CANON'], 'CANON'],
  archiveWorking: ['working', ['Working', 'Character', 'Divinity'], 'CANON'],
  promote: ['working', ['Working', 'Culture', 'Language'], 'CANON'],
  promoteAu: ['working', ['Working', 'Culture', 'Language'], 'AU'],
  unarchivePlain: ['authoritative', ['CANON', 'Magic'], 'CANON'],
  unarchiveAu: ['authoritative', ['AU', 'Culture'], 'AU'],
  unarchiveWorking: ['working', ['Working', 'Character'], 'CANON'],
  guardCanon: ['authoritative', ['CANON', 'Culture'], 'CANON'],
  guardAu: ['authoritative', ['AU', 'Culture'], 'AU'],
  appendAu: ['working', ['Working', 'Culture'], 'AU'],
  noRuling: ['working', ['Working', 'Culture'], 'AU'],
} as const;
const P = {} as Record<keyof typeof SPECS, string>;

/** The project's pack, approved as a new version: where the lifecycle tag goes here, and the AU ruling. */
const packSays = (o: { lead: boolean; au?: boolean }) => approveTagRules(w.stack.runtime, o);

// Room for the whole file within a minute (sets and sweeps read a lot), as the set tests have.
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
  for (const [k, [state, t, ct]] of Object.entries(SPECS))
    P[k as keyof typeof SPECS] = page(state, [...t], ct);
  await w.stack.runtime.tree.sweep(PROJECT);
});
afterAll(async () => w.close());

describe('no approved pack: ADR 0035 exactly', () => {
  it('the rules are the defaults, and an AU page is promoted with CANON, appended', async () => {
    expect(w.stack.runtime.packs.lifecycleRules(PROJECT)).toMatchObject({ position: 'append', au: null });
    const id = P.defaultAu;
    await done('promote_page', { page: id, destination: 'locs0001' });
    expect(tags(id)).toEqual(['Culture', 'CANON']);
  });
});

describe('a project whose pack says the lifecycle tag leads (Arkona’s rule)', () => {
  beforeAll(() => packSays({ lead: true }));

  it('the rules come from the approved pack version: lead, with the AU ruling', () => {
    expect(w.stack.runtime.packs.lifecycleRules(PROJECT)).toMatchObject({
      position: 'lead',
      au: { continuityType: 'AU', tag: 'AU' },
      source: { pack: 'arkona' },
    });
  });

  it('move_to_working: CANON removed, Working first, every other tag in its order', async () => {
    const id = P.move;
    const r = await done('move_to_working', { page: id });
    expect(r.body.tags).toMatchObject({ after: ['Working', 'Culture', 'Language'] });
    expect(tags(id)).toEqual(['Working', 'Culture', 'Language']);
  });

  it('move_to_working of an AU page: its AU status tag gives way to Working', async () => {
    const id = P.moveAu;
    await done('move_to_working', { page: id });
    expect(tags(id)).toEqual(['Working', 'Culture']);
  });

  it('archive_page from Authoritative: Archived first (“Archived, Magic”)', async () => {
    const id = P.archiveAuth;
    await done('archive_page', { page: id });
    expect(tags(id)).toEqual(['Archived', 'Magic']);
  });

  it('archive_page from Working: Archived first, the subject tags after it', async () => {
    const id = P.archiveWorking;
    await done('archive_page', { page: id });
    expect(tags(id)).toEqual(['Archived', 'Character', 'Divinity']);
  });

  it('promote_page of an ordinary page: Working removed, CANON first', async () => {
    const id = P.promote;
    const r = await call('promote_page', { page: id, destination: 'locs0001', dryRun: true });
    expect(r.body.tags, r.text).toMatchObject({ after: ['CANON', 'Culture', 'Language'], added: ['CANON'] });
    await done('promote_page', { page: id, destination: 'locs0001' });
    expect(tags(id)).toEqual(['CANON', 'Culture', 'Language']);
    expect(fact(w, id, 'Continuity Type')).toBe('CANON');
  });

  it('promote_page of an AU page: AU first (not CANON), its Continuity Type AU kept', async () => {
    const id = P.promoteAu;
    await done('promote_page', { page: id, destination: 'locs0001' });
    expect(tags(id)).toEqual(['AU', 'Culture', 'Language']);
    expect(fact(w, id, 'Continuity Type')).toBe('AU');
  });

  it('unarchive_page: Archived is replaced where it stands by the status tag of its Continuity Type', async () => {
    const plain = P.unarchivePlain;
    await done('archive_page', { page: plain });
    expect(tags(plain)).toEqual(['Archived', 'Magic']);
    await done('unarchive_page', { page: plain });
    expect(tags(plain)).toEqual(['CANON', 'Magic']);

    const au = P.unarchiveAu;
    await done('archive_page', { page: au });
    expect(tags(au)).toEqual(['Archived', 'Culture']);
    await done('unarchive_page', { page: au });
    expect(tags(au)).toEqual(['AU', 'Culture']);
    expect(fact(w, au, 'Continuity Type')).toBe('AU');
  });

  it('unarchive_page of a formerly Working page: Working first', async () => {
    const id = P.unarchiveWorking;
    await done('archive_page', { page: id });
    await done('unarchive_page', { page: id });
    expect(tags(id)).toEqual(['Working', 'Character']);
  });

  it('whole sets: archive puts Archived first on every page and index; promote puts the status tag first', async () => {
    const s = await seedSet(w, 'working'); // its content pages are AU (Continuity Type AU)
    await done('archive_page', { page: s.root, subtree: true });
    expect(tags(s.core)).toEqual(['Archived', 'hero']);
    expect(tags(s.root)).toEqual(['Archived']);
    await done('unarchive_page', { page: s.root, subtree: true });
    expect(tags(s.core)).toEqual(['Working', 'hero']);
    await done('promote_page', { page: s.root, subtree: true, destination: 'locs0001' });
    // An AU content page carries AU; an index has no Continuity Type, so CANON.
    expect(tags(s.core)).toEqual(['AU', 'hero']);
    expect(tags(s.portraits)).toEqual(['AU']);
    expect(tags(s.root)).toEqual(['CANON']);
  });

  it('the guard: AU is a status tag now, added or removed only by the lifecycle tools', async () => {
    const id = P.guardCanon;
    const add = await call('update_resource', { page: id, tags: { add: ['AU'] } });
    expect(add.isError, add.text).toBe(true);
    expect(add.text).toMatch(/status tag AU/);
    const au = P.guardAu;
    const remove = await call('update_resource', { page: au, tags: { remove: ['AU'] } });
    expect(remove.isError, remove.text).toBe(true);
    expect(remove.text).toMatch(/status tag AU/);
    // Any other tag stays free.
    const free = await call('update_resource', { page: au, tags: { add: ['Language'] } });
    expect(free.isError, free.text).toBe(false);
    expect(tags(au)).toEqual(['AU', 'Culture', 'Language']);
  });
});

describe('a project the pack does not name keeps append, with the AU ruling', () => {
  beforeAll(() => packSays({ lead: false }));

  it('promote_page of an AU page: AU, appended; archive_page: Archived appended', async () => {
    expect(w.stack.runtime.packs.lifecycleRules(PROJECT)).toMatchObject({ position: 'append' });
    const id = P.appendAu;
    await done('promote_page', { page: id, destination: 'locs0001' });
    expect(tags(id)).toEqual(['Culture', 'AU']);
    await done('archive_page', { page: id });
    expect(tags(id)).toEqual(['Culture', 'Archived']);
  });

  it('a pack without the AU ruling: CANON, as before', async () => {
    packSays({ lead: false, au: false });
    expect(w.stack.runtime.packs.lifecycleRules(PROJECT)).toMatchObject({ position: 'append', au: null });
    const id = P.noRuling;
    await done('promote_page', { page: id, destination: 'locs0001' });
    expect(tags(id)).toEqual(['Culture', 'CANON']);
  });

  it('a newer version waiting for approval does not apply: the approved one does', () => {
    const packs = w.stack.runtime.packs;
    const pack = packs.get('arkona')!;
    packs.store.newVersion(
      'arkona',
      { ...pack.rules, lifecycleTagPosition: { test: 'lead' } },
      'test: waiting',
    );
    expect(packs.lifecycleRules(PROJECT)).toMatchObject({ position: 'append' });
  });
});
