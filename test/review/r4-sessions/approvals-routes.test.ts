/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), every approval route, as ADR 0081 now has them (the owner, 26 November 2026: "A code
 * at sign-in is enough"): `POST /proposals/:id/approve` (with and without a selection), `/approve-as-canon`, and
 * `/proposals/bulk` ("Approve selected") never ask for a fresh authenticator code, whatever the proposal holds (a
 * delete, more than 10 pages, an asset delete or move, a restore, a member removed). ADR 0062 decision 5 had asked for
 * one of the guarded kinds; the cases are the review's.
 *
 * Modelled: each proposal is captured through the engine as a bridge tool captures one (`internal`, `forceProposal`),
 * as test/auth/sessions-r3.test.ts does. The session has not stepped up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT, startAdminStack, type AdminStack } from '../../admin/helpers.js';
import { notSteppedUp, type Owner } from './helpers.js';

let s: AdminStack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

async function boot(env: Record<string, string> = {}): Promise<{ stack: AdminStack; owner: Owner }> {
  s = await startAdminStack({ env });
  await s.runtime.ready;
  return { stack: s, owner: notSteppedUp(s) };
}

async function proposal(
  stack: AdminStack,
  tag: string,
  steps: unknown[],
  items?: { id: string; kind: string }[],
): Promise<string> {
  const r = (await stack.runtime.engine.submit({
    project: PROJECT,
    kind: 'batch_ops',
    title: `r4 ${tag}`,
    origin: { kind: 'ui', client: 'r4', tool: 'r4_sessions' },
    onError: 'stop',
    internal: true,
    forceProposal: true,
    steps,
    proposal: {
      summary: `r4 ${tag}`,
      ...(items
        ? {
            items: items.map((i) => ({
              id: i.id,
              kind: i.kind,
              group: 'r4',
              label: i.id,
              dependsOn: [],
              selected: true,
            })),
          }
        : {}),
    },
  } as never)) as { proposalId?: string };
  expect(r.proposalId, JSON.stringify(r)).toBeTruthy();
  return r.proposalId!;
}
const state = (stack: AdminStack, id: string) => stack.runtime.policy.proposals.get(id)!.state;
const refused = (r: { status: number; json: any }) => ({
  status: r.status,
  code: (r.json?.error?.code as string | undefined) ?? null,
});
/** ADR 0081: the approval routes never answer REAUTH_REQUIRED. */
const neverAsks = (r: { status: number; json: any }) =>
  expect(refused(r).code, JSON.stringify(r.json)).not.toBe('REAUTH_REQUIRED');

describe('no approval route asks for a fresh code (ADR 0081)', () => {
  it('SE-09: "Approve selected" of only the harmless item of a proposal that also deletes does not ask', async () => {
    const { stack, owner } = await boot();
    const id = await proposal(
      stack,
      'se09',
      [
        { op: 'createResource', params: { body: { name: 'r4 se09 new' } }, items: ['se09:new'] },
        {
          op: 'deleteResource',
          params: { path: { resourceId: 'r4gone00009' } },
          items: ['se09:gone'],
        },
      ],
      [
        { id: 'se09:new', kind: 'new_page' },
        { id: 'se09:gone', kind: 'delete' },
      ],
    );
    const r = await owner.call('POST', `/api/admin/proposals/${id}/approve`, { items: ['se09:new'] });
    neverAsks(r);
    expect(r.status, r.text).toBe(200);
    expect(state(stack, id)).not.toBe('pending');
  });

  it('SE-10: bulk approve of a delete among an unknown id and a repeated plain one does not ask (nor the canon routes)', async () => {
    const { stack, owner } = await boot();
    const plain = await proposal(stack, 'se10 plain', [
      { op: 'createResource', params: { body: { name: 'r4 se10' } } },
    ]);
    const gone = await proposal(stack, 'se10 gone', [
      { op: 'deleteResource', params: { path: { resourceId: 'r4gone00010' } } },
    ]);
    const r = await owner.call('POST', '/api/admin/proposals/bulk', {
      action: 'approve',
      ids: ['prop_does_not_exist', plain, plain, gone],
    });
    neverAsks(r);
    expect(r.status, r.text).toBe(200);
    // "Approve and accept as canon" in bulk, and the single canonical route: no step-up either.
    const canonBulk = await owner.call('POST', '/api/admin/proposals/bulk', {
      action: 'approve-as-canon',
      ids: [gone],
      confirm: true,
    });
    neverAsks(canonBulk);
    const canonOne = await owner.call('POST', `/api/admin/proposals/${gone}/approve-as-canon`, {
      confirm: true,
    });
    neverAsks(canonOne);
  });

  it('SE-11: a restore, an asset delete, an asset move and 11 new pages: none asks', async () => {
    const { stack, owner } = await boot();
    const cases = {
      restore: await proposal(stack, 'se11 restore', [
        { op: 'restoreResource', params: { path: { resourceId: 'r4back00011' } } },
      ]),
      assetDelete: await proposal(stack, 'se11 asset delete', [
        { op: 'deleteAsset', params: { path: { assetId: 'r4asset0011' } } },
      ]),
      assetMove: await proposal(stack, 'se11 asset move', [
        { op: 'updateAsset', params: { path: { assetId: 'r4asset0012' }, body: { folderId: 'r4fold0011' } } },
      ]),
      eleven: await proposal(
        stack,
        'se11 eleven',
        Array.from({ length: 11 }, (_, i) => ({
          op: 'createResource',
          params: { body: { name: `r4 se11 ${i}` } },
        })),
      ),
    };
    const out: Record<string, unknown> = {};
    for (const [k, id] of Object.entries(cases))
      out[k] = refused(await owner.call('POST', `/api/admin/proposals/${id}/approve`, {}));
    const ok = { status: 200, code: null };
    // A restore is a canonical change: it needs "Approve and accept as canon", never a step-up.
    expect(out).toEqual({
      restore: { status: 409, code: 'CANONICAL_APPROVAL_REQUIRED' },
      assetDelete: ok,
      assetMove: ok,
      eleven: ok,
    });
  });

  it('SE-12: a proposal that removes a project member (member administration on) does not ask', async () => {
    // Member administration is off by default; with it on, `removeMember` removes someone from the LegendKeeper
    // project. ADR 0081: approving it needs no fresh code, as any approval.
    const { stack, owner } = await boot({ LK_ALLOW_MEMBER_ADMIN: 'true' });
    const id = await proposal(stack, 'se12', [
      { op: 'removeMember', params: { path: { userId: 'r4member012' } } },
    ]);
    const r = await owner.call('POST', `/api/admin/proposals/${id}/approve`, {});
    neverAsks(r);
    expect(r.status, r.text).toBe(200);
  });
});
