/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 2 on a rename (a canonical proposal made of items). The attempts: a
 * selection that is not closed (the subject's own name left out, or the token left out with its characters kept); the
 * re-place of a page computed for "all renamed at once" kept when a sibling's new name is left out (decision 1.8, "a
 * move only when a page's place among its siblings, all renamed at once, changes"); the reproposal of a canonical
 * rename's left-out items approved with the ordinary Approve.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approve } from '../../packs/world.js';
import { C, P, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { approveItems, itemsOf, proposeRename, rejection, reproposeOrigin } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let open: RenameWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('selective approval of a rename', () => {
  it('AP-15 a selection without the subject’s name, or the token with its characters kept', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const noRoot = plan.items.filter((i) => i.selected && i.id !== `name:${C.nadira}`).map((i) => i.id);
    const e1 = await rejection(() =>
      w.stack.runtime.policy.commands.approveAsCanon('owner', id, { items: noRoot }),
    );
    expect(e1?.code).toBe('SELECTION_NOT_CLOSED');
    expect(w.stack.runtime.policy.proposals.get(id)!.state).toBe('pending');
    const r = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    const cid = String(r.body.proposalId);
    const cplan = itemsOf(w, cid);
    const noToken = cplan.items.filter((i) => i.selected && i.id !== 'token:culture').map((i) => i.id);
    const e2 = await rejection(() =>
      w.stack.runtime.policy.commands.approveAsCanon('owner', cid, { items: noToken }),
    );
    expect(e2?.code).toBe('SELECTION_NOT_CLOSED');
    expect(w.stack.runtime.packs.get('arkona')!.approved?.version).toBe(
      w.stack.runtime.packs.get('arkona')!.version,
    );
    expect(w.repo.live(R.characters[0])!.tags).toContain('Velaran');
  });

  // CR-2026-11-R3 (R3-56): built (docs/reviews/CR-2026-11-R3.md section 7; ADR 0058's second amendment): each re-place move is worked out inside its lock from the renames the owner approved, in sequence, so a name left out is never anchored on as renamed.
  it('AP-16 the Art page’s new name left out: the Core is not placed after a page sorting after it', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const art = `name:${P.nadiraArt}`;
    const drop = new Set([art, `facts:${P.nadiraArt}`, `aliases:${P.nadiraArt}`]);
    const keep = plan.items.filter((i) => i.selected && !drop.has(i.id)).map((i) => i.id);
    const done = await approveItems(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Nadira al-Khalid - Character Art');
    const kids = w.repo.children(C.nadiraIndex);
    const bare = (n: string) => n.replace(/^\[[A-Z]{4,5}\]\s*/, '');
    const at = kids.findIndex((r) => r.id === C.nadira);
    const prev = at > 0 ? bare(kids[at - 1]!.name) : null;
    const core = bare(kids[at]!.name);
    // SAFE: the Core's re-place (planned as "after the Art page, renamed too") is not kept when the Art page keeps its
    // old name: the page now before the Core sorts before it.
    expect(
      prev === null || prev.localeCompare(core) < 0,
      `the Core (${core}) was placed after “${prev}”: ${kids.map((r) => bare(r.name)).join(' | ')}`,
    ).toBe(true);
  });

  // CR-2026-11-R3 (R3-56): built (docs/reviews/CR-2026-11-R3.md section 7; ADR 0058's second amendment): the re-place moves follow the names written, in sequence (src/packs/rename/place.ts), so a whole approval ends in alphabetical order.
  it('AP-19 every name ticked: the set ends in alphabetical order (its re-place moves in sequence)', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const done = await approve(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const names = w.repo.children(C.nadiraIndex).map((r) => r.name.replace(/^\[[A-Z]{4,5}\]\s*/, ''));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('AP-17 a canonical rename’s left-out items, proposed again, still need canonical approval', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const au = plan.items.find((i) => i.id.endsWith(':au2:0'))!;
    const keep = plan.items.filter((i) => i.id !== au.id).map((i) => i.id);
    const done = await approveItems(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id));
    const second = w.stack.runtime.policy.proposals.get(again.proposalId)!;
    expect(
      second.requiresCanonicalApproval,
      'the reproposal of a canonical rename is an ordinary proposal',
    ).toBe(true);
    const e = await rejection(() => w.stack.runtime.policy.commands.approve('owner', again.proposalId));
    expect(e?.code).toBe('CANONICAL_APPROVAL_REQUIRED');
  });
});
