/**
 * RV2-1: `restoreResource` is not judged by the lifecycle guard, so a page deleted from one lifecycle area comes back in
 * another once its parent has moved (a whole set promoted, archived or moved to Working since). ADR 0035 decision 11: a
 * move into, out of or between the lifecycle areas happens only through the four tools; ADR 0036 decision 5: an approval
 * covers only what it listed. Here the set promotion did not list the deleted page, yet the page ends up in canon's tree.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { fact, seedSet } from '../lifecycle/sets.js';
import { accept, lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
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

describe('RV2-1: a restore lands a page across a lifecycle area', () => {
  it('a [BWRK] page deleted from a Working set, restored after the set was promoted, does not land in canon', async () => {
    const s = await seedSet(w, 'working');
    // 1. The agent deletes a Working page of the set (an ordinary write: Working pages are not protected).
    const del = await call('delete_resource', { page: s.portraits, confirm: true });
    expect(del.body, del.text).toMatchObject({ status: 'written' });
    expect(w.repo.live(s.portraits)).toBeUndefined();
    // 2. The owner promotes the set (one canonical approval; the deleted page is not in it).
    const p = await accept(
      w,
      await call('promote_page', { page: s.root, subtree: true, destination: 'locs0001' }),
    );
    expect(p.body, p.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(s.art)!.parentId).toBe(s.root);
    expect(w.repo.live(s.root)!.parentId).toBe('locs0001');
    // 3. The agent restores the deleted Working page: it would come back under the set's Art index, now in canon.
    const back = await call('restore_resource', { page: s.portraits });
    // SAFE: refused (a move out of the Working area only through the lifecycle tools), or at least a canonical proposal.
    const landed = w.repo.live(s.portraits);
    expect(
      landed === undefined || back.body.status === 'proposal_captured',
      `${back.text}\n→ ${landed?.name} under ${landed?.parentId}, Status ${fact(w, s.portraits, 'Status')}`,
    ).toBe(true);
  });

  it('the same through lk_api_write restoreResource (no tool-level check at all)', async () => {
    const s = await seedSet(w, 'working');
    const del = await call('delete_resource', { page: s.portraits, confirm: true });
    expect(del.body, del.text).toMatchObject({ status: 'written' });
    const p = await accept(
      w,
      await call('promote_page', { page: s.root, subtree: true, destination: 'locs0001' }),
    );
    expect(p.body, p.text).toMatchObject({ status: 'written', verified: true });
    const back = await call('lk_api_write', {
      operationId: 'restoreResource',
      params: { path: { resourceId: s.portraits } },
    });
    const landed = w.repo.live(s.portraits);
    expect(
      landed === undefined || back.body.status === 'proposal_captured',
      `${back.text}\n→ ${landed?.name} under ${landed?.parentId}`,
    ).toBe(true);
  });

  it('a page deleted from an Authoritative set comes back inside the archive after the set was archived', async () => {
    const s = await seedSet(w, 'authoritative');
    // An index of the set with no Authoritative page under it: deleting it needs no canonical approval.
    w.repo.seed({ id: 'rv2notes', name: `[INDEX] ${s.name} Notes`, parentId: s.root, tags: ['CANON'] });
    await w.stack.runtime.tree.sweep(PROJECT);
    const del = await call('delete_resource', { page: 'rv2notes', confirm: true });
    expect(del.body, del.text).toMatchObject({ status: 'written' });
    const a = await accept(w, await call('archive_page', { page: s.root, subtree: true }));
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    const back = await call('restore_resource', { page: 'rv2notes' });
    const landed = w.repo.live('rv2notes');
    // SAFE: it must not appear in the Archived area still tagged CANON without archive_page.
    expect(
      landed === undefined || back.body.status === 'proposal_captured',
      `${back.text}\n→ ${landed?.name} under ${landed?.parentId}, tags ${JSON.stringify(landed?.tags)}`,
    ).toBe(true);
  });

  it('agent alone: a [BWRK] page restored after its index was deleted lands at the root, then moves into canon', async () => {
    const s = await seedSet(w, 'working');
    // Delete the Working page, then its (now empty) Working-set index: both ordinary writes at scope write.
    expect((await call('delete_resource', { page: s.portraits, confirm: true })).body.status).toBe('written');
    expect((await call('delete_resource', { page: s.art, confirm: true })).body.status).toBe('written');
    // Restore the page alone: LegendKeeper puts a page whose parent is gone at the root (outside the Working area).
    const back = await call('lk_api_write', {
      operationId: 'restoreResource',
      params: { path: { resourceId: s.portraits } },
    });
    const atRoot = w.repo.live(s.portraits);
    // From the root, a move into the normal tree crosses no index the guard knows of.
    const moved = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: s.portraits }, body: { parentId: 'locs0001' } },
    });
    const landed = w.repo.live(s.portraits);
    // SAFE: a Working page never leaves the Working area except through promote_page or archive_page.
    expect(
      landed === undefined || (landed.parentId !== 'locs0001' && landed.parentId !== null),
      `restore: ${back.text}\n(at ${atRoot?.parentId})\nmove: ${moved.text}\n→ ${landed?.name} under ${landed?.parentId}, Status ${fact(w, s.portraits, 'Status')}`,
    ).toBe(true);
  });
});
