/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 1.5 (D3: the identity token) with decision 2.5 ("Propose these
 * again"). A culture's rename changes the pack's token map as a NEW pack version; its job is submitted waiting for the
 * owner's approval of that version (`waitFor`), and its check confirms inside the lock that the APPROVED version maps
 * the new value to the new token (PACK_TOKEN_NOT_APPROVED). The attempt: the owner leaves one character out, then,
 * while the approved part waits for the pack version, clicks "Propose these again" and approves that one character. The
 * safe behaviour: the character's Naming Culture and identity tag do not change before the owner approves the pack
 * version that defines them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { PROJECT, itemsOf, reproposeOrigin } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

type Obj = Record<string, unknown>;

let open: RenameWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

function facts(w: RenameWorld, id: string): Record<string, string> {
  const kv = w.sidebars.pages.get(id)?.props.find((p) => p.kind === 'keyValue');
  if (!kv) return {};
  return Object.fromEntries(
    kv.rows!.map((r) => [
      r.key,
      (r.content as Obj[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join(''),
    ]),
  );
}

describe('the identity token’s pack version, and "Propose these again"', () => {
  it('AP-29 a character proposed again while the rename waits for its pack version waits too', async () => {
    const w = (open = await renameWorld());
    const packs = w.stack.runtime.packs;
    const v0 = packs.get('arkona')!.version;
    const r = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    const plan = itemsOf(w, id);
    const last = R.characters[4];
    const left = `character:${last}`;
    expect(plan.items.find((i) => i.id === left)?.dependsOn).toEqual(['token:culture']);
    const keep = plan.items.filter((i) => i.selected && i.id !== left).map((i) => i.id);
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id, { items: keep });
    // The new token map is a pack version waiting for the owner; the approved part waits for it.
    expect(packs.get('arkona')!.version).toBe(v0 + 1);
    expect(packs.get('arkona')!.approved?.version).toBe(v0);
    const jobId = w.stack.runtime.policy.proposals.get(id)!.jobId!;
    await new Promise((res) => setTimeout(res, 300));
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!.status).toBe('queued');
    expect(w.stack.runtime.policy.proposals.get(id)!.state).toBe('executing');

    // CR-2026-11-R3 (R3-14, fixed): "Propose these again" waits until the approved part has run to the end (executed);
    // while it waits for its pack version the left-out character is not proposed (on the reviewed code it was proposed
    // with no dependency on the token, and its approval renamed the character before the pack version was approved).
    await expect(
      w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id)),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // SAFE: the pack version that maps Velarine is still waiting for the owner, so the character is as it was.
    expect(packs.get('arkona')!.approved?.version, 'the owner has not approved the new pack version').toBe(
      v0,
    );
    expect(
      { culture: facts(w, last)['Naming Culture'], tags: w.repo.live(last)!.tags },
      'the character took the new token before its pack version was approved',
    ).toEqual({ culture: 'Velaran', tags: ['CANON', 'Character', 'Human', 'Velaran'] });
  });
});
