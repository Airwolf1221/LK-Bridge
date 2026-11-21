/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), the guarded rails at approval through every approval route (ADR 0062 decision 5):
 * `POST /proposals/:id/approve` (with and without a selection), `/approve-as-canon`, and `/proposals/bulk` ("Approve
 * selected"). The attempts: approve a guarded proposal (a delete, more than 10 pages, an asset delete or move, a restore)
 * by a route, an order of ids or a selection that might be judged on less than the whole proposal; and an operation that
 * deletes but is not in the rails' table (member administration).
 *
 * Modelled: each proposal is captured through the engine as a bridge tool captures one (`internal`, `forceProposal`),
 * as test/auth/sessions-r3.test.ts does. The session has not stepped up. The safe behaviour: 403 REAUTH_REQUIRED and the
 * proposal stays pending.
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
const ASKS = { status: 403, code: 'REAUTH_REQUIRED' };

describe('every approval route judges the whole proposal', () => {
  it('SE-09: "Approve selected" of only the harmless item of a proposal that also deletes still asks', async () => {
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
    expect(refused(r)).toEqual(ASKS);
    expect(state(stack, id)).toBe('pending');
  });

  it('SE-10: bulk approve with the guarded id after an unknown one and a repeated plain one still asks (and both canon routes)', async () => {
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
    expect(refused(r)).toEqual(ASKS);
    expect([state(stack, plain), state(stack, gone)]).toEqual(['pending', 'pending']);
    // "Approve and accept as canon" in bulk, and the single canonical route, judge it the same way.
    const canonBulk = await owner.call('POST', '/api/admin/proposals/bulk', {
      action: 'approve-as-canon',
      ids: [gone],
      confirm: true,
    });
    expect(refused(canonBulk)).toEqual(ASKS);
    const canonOne = await owner.call('POST', `/api/admin/proposals/${gone}/approve-as-canon`, {
      confirm: true,
    });
    expect(refused(canonOne)).toEqual(ASKS);
    expect(state(stack, gone)).toBe('pending');
  });

  it('SE-11: a restore, an asset delete, an asset move and 11 new pages each ask', async () => {
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
    expect(out).toEqual({ restore: ASKS, assetDelete: ASKS, assetMove: ASKS, eleven: ASKS });
  });

  it('SE-12: a proposal that removes a project member (member administration on) asks like any delete', async () => {
    // Member administration is off by default and switching it on asks for the step-up; with it on, `removeMember`
    // removes someone from the LegendKeeper project, which is a removal however the rails' table names it.
    const { stack, owner } = await boot({ LK_ALLOW_MEMBER_ADMIN: 'true' });
    const id = await proposal(stack, 'se12', [
      { op: 'removeMember', params: { path: { userId: 'r4member012' } } },
    ]);
    const r = await owner.call('POST', `/api/admin/proposals/${id}/approve`, {});
    expect(refused(r)).toEqual(ASKS);
    expect(state(stack, id)).toBe('pending');
  });
});
