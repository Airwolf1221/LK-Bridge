/**
 * Member and invite operations at every scope (chunk 6, item 10). v3 F12 (ADR 0081, the owner's ruling 8): the three
 * administrative operations are refused for agents by the policy gate at every scope, with LK_ALLOW_MEMBER_ADMIN on or
 * off ("member administration is never done by agents"), never captured as a proposal and never sent; the owner does
 * it in the LegendKeeper app. The two reads (listMembers, listInvites) follow the scope table like any read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpParams } from '../../src/jobs/index.js';
import type { Scope } from '../../src/policy/index.js';
import { PROJECT, settle } from '../jobs/helpers.js';
import { makePat, mcpOriginFor, policyRig, type PolicyRig } from './helpers.js';

let rig: PolicyRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const ADMIN_OPS: readonly [string, OpParams][] = [
  ['inviteMember', { body: { email: 'new@example.test' } }],
  ['removeMember', { path: { userId: 'user1' } }],
  ['revokeInvite', { path: { inviteId: 'inv1' } }],
];
const READ_OPS: readonly [string, OpParams][] = [
  ['listMembers', {}],
  ['listInvites', {}],
];
const SCOPES: readonly Scope[] = ['read', 'propose', 'write'];

const code = (e: unknown) => (e as { code?: string } | undefined)?.code;
const message = (e: unknown) => (e as { message?: string } | undefined)?.message ?? '';
const NEVER_BY_AGENTS = /member administration is never done by agents/;

async function setup(allowMemberAdmin: boolean, scope: Scope) {
  rig = await policyRig({ allowMemberAdmin });
  const agent = makePat(rig.db, rig.policy, `agent-${scope}`, scope, () => rig!.h.clock.now());
  return { r: rig, origin: mcpOriginFor(agent.principal) };
}

describe('member administration is disabled (LK_ALLOW_MEMBER_ADMIN=false)', () => {
  for (const scope of SCOPES) {
    for (const [op, params] of ADMIN_OPS) {
      it(`${op} at ${scope} scope is refused, as one operation and inside a batch`, async () => {
        const { r, origin } = await setup(false, scope);
        const single = await settle(r.h, r.e, r.e.engine.run(op, params, { project: PROJECT, origin }));
        const batch = await settle(
          r.h,
          r.e,
          r.e.engine.submit({ project: PROJECT, kind: 'batch_ops', steps: [{ op, params }], origin }),
        );
        for (const out of [single, batch]) {
          expect(out.value, `${scope} ${op}`).toBeUndefined();
          // Read scope: the connection is read-only. Otherwise the gate's refusal for agents, not a proposal.
          expect(code(out.error)).toBe('POLICY_DENIED');
          if (scope !== 'read') expect(message(out.error)).toMatch(NEVER_BY_AGENTS);
        }
        expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toEqual([]);
        expect(r.h.mock.calls.filter((c) => c.method !== 'GET')).toEqual([]);
      });
    }
  }

  it('a batch that mixes a proposable write with an administrative one is refused whole', async () => {
    const { r, origin } = await setup(false, 'propose');
    r.h.model.seedResource('raaaaaaa');
    const out = await settle(
      r.h,
      r.e,
      r.e.engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        steps: [
          { op: 'updateResource', params: { path: { resourceId: 'raaaaaaa' }, body: { name: 'x' } } },
          ['removeMember', { path: { userId: 'user1' } }] as never,
        ].map((s) => (Array.isArray(s) ? { op: s[0] as string, params: s[1] as OpParams } : s)),
        origin,
      }),
    );
    expect(code(out.error)).toBe('POLICY_DENIED');
    expect(message(out.error)).toMatch(NEVER_BY_AGENTS);
    expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toEqual([]);
  });

  for (const scope of SCOPES) {
    for (const [op, params] of READ_OPS) {
      it(`${op} (a read) is allowed at ${scope} scope`, async () => {
        const { r, origin } = await setup(false, scope);
        const out = await settle(r.h, r.e, r.e.engine.run(op, params, { project: PROJECT, origin }));
        expect(out.error).toBeUndefined();
        expect((out.value as { status: string }).status).toBe('succeeded');
      });
    }
  }
});

describe('member administration is enabled (LK_ALLOW_MEMBER_ADMIN=true)', () => {
  for (const [op, params] of ADMIN_OPS) {
    it(`${op}: still refused for agents at every scope, never proposed or sent`, async () => {
      for (const scope of SCOPES) {
        const { r, origin } = await setup(true, scope);
        const out = await settle(r.h, r.e, r.e.engine.run(op, params, { project: PROJECT, origin }));
        expect(out.value, `${scope} ${op}`).toBeUndefined();
        expect(code(out.error), `${scope} ${op}`).toBe('POLICY_DENIED');
        if (scope !== 'read') expect(message(out.error)).toMatch(NEVER_BY_AGENTS);
        expect(r.policy.commands.listProposals('owner', { project: PROJECT })).toEqual([]);
        expect(r.h.mock.calls.filter((c) => c.method !== 'GET')).toEqual([]);
        await rig?.close();
        rig = undefined;
      }
    });
  }
});
