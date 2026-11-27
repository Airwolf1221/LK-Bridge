/**
 * ADR 0081 (the owner, 26 November 2026: "A code at sign-in is enough"): approving a proposal never asks for a fresh
 * authenticator code, whatever it does and however it came to be proposed. The cases are those CR-2026-11-R4 made ask
 * (ADR 0062 decision 5 and amendment 1; the review's SE-05 to SE-12): a block deleted through a low-level tool, a list
 * write that drops an entry (read live), a recorded reason naming the deletes, bulk or assets rail (or one that cannot
 * be read), a member or an invite removed, more than 10 pages; each is approved here by a session signed in but not
 * stepped up, through every approval route (one, "Approve selected" in bulk, and a decision over a filter). The
 * session's other checks (Origin, CSRF) are unchanged and tested elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { PROJECT, startAdminStack, type AdminStack } from './helpers.js';

const model = new LkModel(() => systemClock.now());
/** A page of two blocks, `<id>b1` and `<id>b2` (each case has its own: an approved job changes its page). */
const seed = (id: string) => ({
  ...model.seedResource(id, {
    name: `R4 ${id}`,
    blocks: [
      { id: `${id}b1`, kind: 'paragraph', content: [{ text: 'First' }] },
      { id: `${id}b2`, kind: 'paragraph', content: [{ text: 'Second' }] },
    ] as never,
  }),
  b1: `${id}b1`,
  b2: `${id}b2`,
});
const deletes = seed('r4pagea');
const lists = seed('r4pageb');
const viaBatch = seed('r4pagec');

let s: AdminStack;
beforeAll(async () => {
  s = await startAdminStack({ respond: model.respond, env: { LK_ALLOW_MEMBER_ADMIN: 'true' } });
  await s.runtime.ready;
});
afterAll(async () => s?.close());

const setReauth = (at: number | null) =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(at, s.services.sessionHash(s.sessionToken));

/** A pending proposal of `steps`, captured with the origin's `tool` (and, optionally, a recorded rail's reason). */
async function proposal(tag: string, tool: string, steps: unknown[], reason?: string): Promise<string> {
  const r = (await s.runtime.engine.submit({
    project: PROJECT,
    kind: 'batch_ops',
    title: `r4 ${tag}`,
    origin: { kind: 'ui', client: 'r4', tool },
    onError: 'stop',
    internal: true,
    forceProposal: true,
    steps,
    ...(reason ? { proposedBecause: { reason, hits: [] } } : {}),
    proposal: { summary: `r4 ${tag}` },
  } as never)) as { proposalId?: string };
  expect(r.proposalId, JSON.stringify(r)).toBeTruthy();
  return r.proposalId!;
}

const code = (r: { json: unknown }) => (r.json as { error?: { code?: string } } | undefined)?.error?.code;

/** Approves without a step-up; returns the status, or `'asked'` when the bridge asked for one (never, now). */
async function approve(id: string): Promise<number | 'asked'> {
  setReauth(null);
  const r = await s.post(`/api/admin/proposals/${id}/approve`, {});
  return code(r) === 'REAUTH_REQUIRED' ? 'asked' : r.status;
}

const state = (id: string) => s.runtime.policy.proposals.get(id)!.state;

const pathOf = (p: { resourceId: string; documentId: string }) => ({
  resourceId: p.resourceId,
  documentId: p.documentId,
});

describe('approving a proposal never asks for a fresh code (ADR 0081)', () => {
  it('a block deleted through a low-level tool, and through lk_api_batch', async () => {
    const del = (p: typeof deletes) => [
      { op: 'deleteBlock', params: { path: { ...pathOf(p), blockId: p.b2 } } },
    ];
    expect(await approve(await proposal('lowlevel delete', 'lk_op_deleteBlock', del(deletes)))).toBe(200);
    expect(await approve(await proposal('batch delete', 'lk_api_batch', del(viaBatch)))).toBe(200);
  });

  it('a low-level list write that drops an entry', async () => {
    const dropped = [
      {
        op: 'replaceDocumentBlocks',
        params: {
          path: pathOf(lists),
          body: { blocks: [{ id: lists.b1, kind: 'paragraph', content: [{ text: 'First' }] }] },
        },
      },
    ];
    expect(await approve(await proposal('drops', 'lk_api_write', dropped))).toBe(200);
  });

  it("whatever the recorded reason: the deletes, bulk or assets rail's, or one that cannot be read", async () => {
    const harmless = [{ op: 'createResource', params: { body: { name: 'r4 harmless' } } }];
    for (const reason of [
      'proposed because: delete (1 block)',
      'proposed because: bulk change (14 pages > 10)',
      'proposed because: asset delete',
      'proposed because: the safety rails could not be judged (timeout)',
      'something else',
      'proposed because: rename of a page (“A” → “B”); moves of 2 pages',
    ])
      expect(await approve(await proposal(`reason ${reason}`, 'r4_tool', harmless, reason)), reason).toBe(
        200,
      );
  });

  it('a member or an invite removed', async () => {
    const remove = await proposal('member', 'lk_api_write', [
      { op: 'removeMember', params: { path: { userId: 'r4member01' } } },
    ]);
    const invite = await proposal('invite', 'lk_api_write', [
      { op: 'revokeInvite', params: { path: { inviteId: 'r4invite01' } } },
    ]);
    expect([await approve(remove), await approve(invite)]).toEqual([200, 200]);
  });

  it('"Approve selected" in bulk and a decision over a filter, of a delete and of more than 10 pages', async () => {
    const pageDelete = (id: string) => [{ op: 'deleteResource', params: { path: { resourceId: id } } }];
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      op: 'createResource',
      params: { body: { name: `r4 eleven ${i}` } },
    }));
    const a = await proposal('bulk delete', 'r4_tool', pageDelete('r4gone00001'));
    const b = await proposal('bulk eleven', 'r4_tool', eleven);
    setReauth(null);
    const bulk = await s.post('/api/admin/proposals/bulk', { action: 'approve', ids: [a, b] });
    expect([bulk.status, code(bulk)], bulk.text).toEqual([200, undefined]);
    expect([state(a), state(b)].every((x) => x !== 'pending')).toBe(true);

    const c = await proposal('matching delete', 'r4_matching_tool', pageDelete('r4gone00002'));
    const matching = await s.post('/api/admin/proposals/bulk-matching', {
      action: 'approve',
      filter: { state: 'pending', tool: 'r4_matching_tool' },
      expect: 1,
      confirm: true,
    });
    expect([matching.status, code(matching)], matching.text).toEqual([200, undefined]);
    expect(state(c)).not.toBe('pending');
    // Nothing stepped the session up meanwhile.
    expect(s.services.owner.peekSession(s.sessionToken)?.reauthAt ?? null).toBeNull();
  });
});
