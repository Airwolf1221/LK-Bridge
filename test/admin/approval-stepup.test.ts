/**
 * CR-2026-11-R4 (ADR 0062 decision 5 and amendment 1; the review's SE-05 to SE-12): approving a proposal asks for the
 * step-up when the rail that made it a proposal (its recorded reason) is the deletes, bulk or assets rail, or cannot be
 * read, and when its operations, judged by the rails' own rules with the proposal's recorded tool, hit a guarded rail:
 * a low-level tool's removals (a block deleted, a list write that drops an entry, read live) count, a high-level tool's
 * do not, and a member removed counts. A session that stepped up within the window is not judged. The proposals here
 * are made by scope, not by a rail, as an agent at scope `propose` makes them (the review's are made by the rails).
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

/** Whether approving asks for the step-up (403 REAUTH_REQUIRED); otherwise the approval's status. */
async function asks(id: string): Promise<boolean | number> {
  setReauth(null);
  const r = await s.post(`/api/admin/proposals/${id}/approve`, {});
  return r.status === 403 && (r.json as { error?: { code?: string } }).error?.code === 'REAUTH_REQUIRED'
    ? true
    : r.status;
}

const pathOf = (p: { resourceId: string; documentId: string }) => ({
  resourceId: p.resourceId,
  documentId: p.documentId,
});

describe("approving a proposal: the rails' rules, with the proposal's own tool and reason", () => {
  it('a block deleted through a low-level tool asks; the same through a high-level tool does not', async () => {
    const del = [{ op: 'deleteBlock', params: { path: { ...pathOf(deletes), blockId: deletes.b2 } } }];
    expect(await asks(await proposal('lowlevel delete', 'lk_op_deleteBlock', del))).toBe(true);
    expect(await asks(await proposal('batch delete', 'lk_api_batch', del))).toBe(true);
    expect(await asks(await proposal('page write', 'write_page', del))).toBe(200);
  });

  it('a low-level list write asks only when it drops an entry held now (read live)', async () => {
    const replace = (blocks: unknown[]) => [
      { op: 'replaceDocumentBlocks', params: { path: pathOf(lists), body: { blocks } } },
    ];
    const dropped = replace([{ id: lists.b1, kind: 'paragraph', content: [{ text: 'First' }] }]);
    const kept = replace([
      { id: lists.b1, kind: 'paragraph', content: [{ text: 'First, edited' }] },
      { id: lists.b2, kind: 'paragraph', content: [{ text: 'Second' }] },
    ]);
    expect(await asks(await proposal('drops', 'lk_api_write', dropped))).toBe(true);
    expect(await asks(await proposal('keeps', 'lk_api_write', kept))).toBe(200);
  });

  it("the recorded reason: the deletes rail's, or one that cannot be read, asks; the renames-and-moves rail's alone does not", async () => {
    const harmless = [{ op: 'createResource', params: { body: { name: 'r4 harmless' } } }];
    for (const [reason, expected] of [
      ['proposed because: delete (1 block)', true],
      ['proposed because: bulk change (14 pages > 10)', true],
      ['proposed because: asset delete', true],
      ['proposed because: the safety rails could not be judged (timeout)', true],
      ['something else', true],
      ['proposed because: rename of a page (“A” → “B”); moves of 2 pages', 200],
    ] as const)
      expect(await asks(await proposal(`reason ${reason}`, 'r4_tool', harmless, reason)), reason).toBe(
        expected,
      );
  });

  it('a member or an invite removed asks; a session stepped up within the window is not judged', async () => {
    const remove = await proposal('member', 'lk_api_write', [
      { op: 'removeMember', params: { path: { userId: 'r4member01' } } },
    ]);
    const invite = await proposal('invite', 'lk_api_write', [
      { op: 'revokeInvite', params: { path: { inviteId: 'r4invite01' } } },
    ]);
    expect([await asks(remove), await asks(invite)]).toEqual([true, true]);
    setReauth(Math.floor(Date.now() / 1000));
    const r = await s.post(`/api/admin/proposals/${remove}/approve`, {});
    expect(r.status, r.text).toBe(200);
  });
});
