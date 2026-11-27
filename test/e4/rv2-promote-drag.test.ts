/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * RV2-2: single-page `promote_page` of a Working character's Core takes the character's [INDEX] with it (ADR 0035
 * decision 10). Since C2d.1 a Working character's specialist pages are made UNDER that index (one page at a time), so the
 * index's move drags every [BWRK] page beneath it out of the Working area into canon, still Working. The marker declares
 * only the Core and the index; the lifecycle guard judges the index's move and never its descendants; the proposal lists
 * only the index's direct children ("keep their state"), not the pages below them; and nothing checks the index's
 * subtree at approval (ADR 0036 decision 5: an approval covers only what it listed).
 *
 * F12 (ADR 0081): at scope `write` the promote is direct (no proposal, no gap before an approval); the gap between
 * capture and approval exists only for a `propose`-scope connection, so the late-page case is checked there.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { fact, seedSet } from '../lifecycle/sets.js';
import { accept, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';

let w: LifecycleWorld;
let client: Client;
/** F12 (ADR 0081): a propose-scope connection, for the canonical proposal and its approval. */
let proposer: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const propose = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(proposer, tool, { project: 'test', ...args });
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
  proposer = await w.stack.connect(w.stack.newToken('rv2-drag-propose', 'propose').token);
});
afterAll(async () => w.close());

/** Whether a page is inside the Working area (under [INDEX] Working at any depth), from the mock's own parent links. */
function inWorking(id: string): boolean {
  for (
    let p = w.repo.live(id)?.parentId ?? null, i = 0;
    p && i < 20;
    p = w.repo.live(p)?.parentId ?? null, i++
  )
    if (p === LIFECYCLE.working) return true;
  return false;
}

describe('RV2-2: promote_page of one Core drags unlisted Working pages into canon', () => {
  it('a [BWRK] page two levels under the character index is not moved into canon by promoting the Core alone', async () => {
    const s = await seedSet(w, 'working');
    // [INDEX] Kaito / [INDEX] Kaito Art / [BWRK] Kaito - Portraits, and [BWRK] Kaito - Character Core under the root.
    const r = await call('promote_page', { page: s.core, destination: 'locs0001' });
    // E4 fix (ADR 0046 decision 2): refused at once, naming the pages under the index and subtree: true.
    if (r.isError) {
      expect(r.body.error).toMatchObject({ code: 'SET_HAS_OTHER_PAGES' });
      expect(r.body.error.message).toMatch(/Portraits/);
      expect(r.body.error.message).toMatch(/subtree: true/);
      expect(inWorking(s.portraits)).toBe(true);
      return;
    }
    expect(r.body.status, r.text).toBe('proposal_captured');
    const listed = JSON.stringify(r.body);
    const done = await accept(w, r);
    // SAFE: either refused / conflicted, or no Working page left the Working area unlisted.
    const portraitsOut = !inWorking(s.portraits);
    expect(
      !(done.body.status === 'written' && portraitsOut),
      `listed Portraits: ${listed.includes('Portraits')}\n${done.text}\n→ ${w.repo.live(s.portraits)?.name} now under ${w.repo.live(s.portraits)?.parentId} (in canon), Status ${fact(w, s.portraits, 'Status')}`,
    ).toBe(true);
  });

  it('at scope propose, a [BWRK] page added under the character index after the proposal is not dragged into canon by the approval', async () => {
    const s = await seedSet(w, 'working');
    // Only the Core and an empty Art index under the root at capture: move Portraits out first (an ordinary move
    // within the Working area), so the proposal's flag lists only the Art index.
    expect((await call('move_resource', { page: s.portraits, to: LIFECYCLE.working })).body.status).toBe(
      'written',
    );
    // E4: and the empty Art index too, so only the Core is under the character's index at capture.
    expect((await call('move_resource', { page: s.art, to: LIFECYCLE.working })).body.status).toBe('written');
    const r = await propose('promote_page', { page: s.core, destination: 'locs0001' });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    // After capture, before approval: a Working specialist page is made under the character's index (C2d.1).
    w.repo.seed({
      id: 'rv2late1',
      name: `[BWRK] ${s.name} - Late Notes`,
      parentId: s.root,
      tags: ['Working'],
    });
    w.sidebars.page('rv2late1', [
      SidebarModel.kv('kvrv2lat', 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Working'],
      ]),
    ]);
    await w.stack.runtime.tree.sweep(PROJECT);
    const done = await accept(w, r);
    expect(
      !(done.body.status === 'written' && !inWorking('rv2late1')),
      `${done.text}\n→ ${w.repo.live('rv2late1')?.name} now under ${w.repo.live('rv2late1')?.parentId}`,
    ).toBe(true);
  });

  it('at scope write, promoting the Core alone (only it under the index) is direct: written at once, no approval', async () => {
    const s = await seedSet(w, 'working');
    expect((await call('move_resource', { page: s.portraits, to: LIFECYCLE.working })).body.status).toBe(
      'written',
    );
    expect((await call('move_resource', { page: s.art, to: LIFECYCLE.working })).body.status).toBe('written');
    const r = await call('promote_page', { page: s.core, destination: 'locs0001' });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(r.body.requiresCanonicalApproval).toBeUndefined();
    expect(typeof r.body.jobId).toBe('string');
    expect(w.repo.live(s.core)!.name).toBe(`[BSRC] ${s.name} - Character Core`);
    // The index moved with the Core; the pages moved out before it stay in the Working area.
    expect(w.repo.live(s.root)!.parentId).toBe('locs0001');
    expect(inWorking(s.portraits)).toBe(true);
    expect(inWorking(s.art)).toBe(true);
  });
});
