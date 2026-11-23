/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies in tests */
/**
 * v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H4): bulk actions on the Proposals page,
 * through the admin API.
 *
 * - "Reject all conflicted" over 60 proposals across pages (the page shows 50): one confirmation, no step-up; refused
 *   when the set changed since the count the owner confirmed.
 * - The filters (state, tool, principal, age) and the count of everything they match.
 * - "Approve selected" with a rail inside (a delete) asks for the step-up; without one it does not.
 * - A proposal whose job is running is never touched; a partial failure is listed proposal by proposal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LkModel } from '../jobs/lk-model.js';
import { PROJECT, startAdminStack, type AdminStack } from './helpers.js';
import { systemClock } from '../../src/lk/index.js';

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});
model.seedResource('res2', { name: 'Province', blocks: [{ kind: 'paragraph', content: [{ text: 'Hi' }] }] });

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ respond: model.respond });
});
afterAll(() => stack.close());

const engine = () => stack.runtime.engine;
const notSteppedUp = () => stack.services.store.setReauth(stack.services.sessionHash(stack.sessionToken), 0);
const steppedUp = () =>
  stack.services.store.setReauth(
    stack.services.sessionHash(stack.sessionToken),
    Math.floor(Date.now() / 1000),
  );

async function propose(label: string, op: 'write' | 'delete' = 'write', text = 'x'): Promise<string> {
  const profile =
    stack.policy.store.getProfileByLabel(label) ??
    stack.policy.commands.createProfile('owner', { label, kind: 'claude', scope: 'propose' });
  const pat = stack.services.pats.create({ name: `${label}-${Math.random()}`, profileId: profile.id });
  const origin = {
    kind: 'mcp' as const,
    tool: op === 'delete' ? 'delete_resource' : 'lk_api_write',
    principal: { principalId: pat.pat.id, profile: label, label },
  };
  const r =
    op === 'delete'
      ? await engine().run('deleteResource', { path: { resourceId: 'res2' } }, { project: PROJECT, origin })
      : await engine().run(
          'replaceDocumentBlocks',
          {
            path: { resourceId: 'res1', documentId: 'd_res1' },
            body: { blocks: [{ kind: 'paragraph', content: [{ text }] }] },
          },
          { project: PROJECT, origin },
        );
  expect(r.status).toBe('proposal_captured');
  return (r as { proposalId: string }).proposalId;
}

const setState = (ids: readonly string[], state: string) => {
  const upd = stack.db.prepare('UPDATE proposals SET state = ? WHERE id = ?');
  for (const id of ids) upd.run(state, id);
};

describe('H4: Reject all conflicted', () => {
  it('rejects all 60 conflicted proposals across pages, with one confirmation and no step-up', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await propose('Scribe', 'write', `c${i}`));
    setState(ids, 'conflicted');
    const page = await stack.get('/api/admin/proposals?group=conflicted&limit=50');
    expect(page.json.proposals).toHaveLength(50);
    expect(page.json.total).toBe(60);
    notSteppedUp();
    // The set changed since the owner's count: refused, nothing decided.
    const stale = await stack.post('/api/admin/proposals/bulk-matching', {
      action: 'reject',
      filter: { group: 'conflicted' },
      expect: 59,
      confirm: true,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('PROPOSALS_CHANGED');
    const r = await stack.post('/api/admin/proposals/bulk-matching', {
      action: 'reject',
      filter: { group: 'conflicted' },
      expect: 60,
      reason: 'conflicted',
      confirm: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.results).toHaveLength(60);
    expect(r.json.results.every((x: any) => x.ok && x.state === 'rejected')).toBe(true);
    expect((await stack.get('/api/admin/proposals?group=conflicted')).json.total).toBe(0);
    steppedUp();
  });
});

describe('H4: the filters', () => {
  it('state, tool, principal and age, and the count of all they match', async () => {
    const a = await propose('Filterer', 'write', 'f1');
    await propose('Filterer', 'delete');
    const byTool = await stack.get('/api/admin/proposals?group=pending&tool=delete_resource');
    expect(byTool.json.proposals.map((p: any) => p.tool)).toEqual(['delete_resource']);
    const principal = stack.policy.proposals.get(a)!.principalId;
    const byPrincipal = await stack.get(`/api/admin/proposals?group=pending&principalId=${principal}`);
    expect(byPrincipal.json.proposals.map((p: any) => p.id)).toEqual([a]);
    const old = await stack.get('/api/admin/proposals?group=pending&olderThanHours=24');
    expect(old.json.total).toBe(0);
    stack.db.prepare('UPDATE proposals SET created_at = ? WHERE id = ?').run(Date.now() - 48 * 3_600_000, a);
    expect(
      (await stack.get('/api/admin/proposals?group=pending&olderThanHours=24')).json.proposals.map(
        (p: any) => p.id,
      ),
    ).toEqual([a]);
  });
});

describe('H4: Approve selected', () => {
  it('asks for the step-up when any selected proposal triggers a rail (a delete); not otherwise', async () => {
    const plain = await propose('Approver', 'write', 'a1');
    const del = await propose('Approver', 'delete');
    notSteppedUp();
    const guarded = await stack.post('/api/admin/proposals/bulk', { action: 'approve', ids: [plain, del] });
    expect(guarded.status).toBe(403);
    expect(guarded.json.error.code).toBe('REAUTH_REQUIRED');
    expect(stack.policy.proposals.get(plain)!.state).toBe('pending'); // nothing decided
    const ok = await stack.post('/api/admin/proposals/bulk', { action: 'approve', ids: [plain] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.results[0]).toMatchObject({ id: plain, ok: true });
    // Over a filter too: approving everything a filter matches, a delete among them, asks.
    const viaFilter = await stack.post('/api/admin/proposals/bulk-matching', {
      action: 'approve',
      filter: { group: 'pending', tool: 'delete_resource' },
      expect: (await stack.get('/api/admin/proposals?group=pending&tool=delete_resource')).json.total,
      confirm: true,
    });
    expect(viaFilter.status).toBe(403);
    steppedUp();
    // Reject the delete again so later tests start clean.
    await stack.post('/api/admin/proposals/bulk', { action: 'reject', ids: [del] });
  });

  it('never touches a proposal whose job is running, and lists each failure', async () => {
    const running = await propose('Runner', 'write', 'r1');
    const fine = await propose('Runner', 'write', 'r2');
    setState([running], 'executing');
    const r = await stack.post('/api/admin/proposals/bulk', {
      action: 'reject',
      ids: [running, fine, 'prop_missing_one'],
    });
    expect(r.status).toBe(200);
    const by = new Map(r.json.results.map((x: any) => [x.id, x]));
    expect(by.get(running)).toMatchObject({ ok: false, skipped: true, error: { code: 'PROPOSAL_RUNNING' } });
    expect(stack.policy.proposals.get(running)!.state).toBe('executing');
    expect(by.get(fine)).toMatchObject({ ok: true, state: 'rejected' });
    expect(by.get('prop_missing_one')).toMatchObject({ ok: false });
    // Approving it in bulk leaves it alone too.
    const a = await stack.post('/api/admin/proposals/bulk', { action: 'approve', ids: [running] });
    expect(a.json.results[0]).toMatchObject({ ok: false, error: { code: 'PROPOSAL_RUNNING' } });
    setState([running], 'rejected');
  });
});
