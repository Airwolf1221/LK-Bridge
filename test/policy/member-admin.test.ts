/**
 * Member and invite operations at every scope (chunk 6, item 10). With LK_ALLOW_MEMBER_ADMIN=false the three
 * administrative operations are refused with the engine's own `MEMBER_ADMIN_DISABLED` at propose and write scope,
 * never captured as a proposal that could only fail on approval; at read scope the connection's read-only denial
 * comes first. The two reads (listMembers, listInvites) follow the scope table like any read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpParams } from '../../src/jobs/index.js';
import type { Scope } from '../../src/policy/index.js';
import { settle } from '../jobs/helpers.js';
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
        const single = await settle(r.h, r.e, r.e.engine.run(op, params, { origin }));
        const batch = await settle(
          r.h,
          r.e,
          r.e.engine.submit({ kind: 'batch_ops', steps: [{ op, params }], origin }),
        );
        for (const out of [single, batch]) {
          expect(out.value, `${scope} ${op}`).toBeUndefined();
          // Read scope: the connection is read-only. Otherwise the engine's specific refusal, not a proposal.
          expect(code(out.error)).toBe(scope === 'read' ? 'POLICY_DENIED' : 'MEMBER_ADMIN_DISABLED');
        }
        expect(r.policy.commands.listProposals('owner')).toEqual([]);
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
        kind: 'batch_ops',
        steps: [
          { op: 'updateResource', params: { path: { resourceId: 'raaaaaaa' }, body: { name: 'x' } } },
          ['removeMember', { path: { userId: 'user1' } }] as never,
        ].map((s) => (Array.isArray(s) ? { op: s[0] as string, params: s[1] as OpParams } : s)),
        origin,
      }),
    );
    expect(code(out.error)).toBe('MEMBER_ADMIN_DISABLED');
    expect(r.policy.commands.listProposals('owner')).toEqual([]);
  });

  for (const scope of SCOPES) {
    for (const [op, params] of READ_OPS) {
      it(`${op} (a read) is allowed at ${scope} scope`, async () => {
        const { r, origin } = await setup(false, scope);
        const out = await settle(r.h, r.e, r.e.engine.run(op, params, { origin }));
        expect(out.error).toBeUndefined();
        expect((out.value as { status: string }).status).toBe('succeeded');
      });
    }
  }
});

describe('member administration is enabled (LK_ALLOW_MEMBER_ADMIN=true)', () => {
  for (const [op, params] of ADMIN_OPS) {
    it(`${op}: denied at read, proposed at propose, executed at write`, async () => {
      for (const scope of SCOPES) {
        const { r, origin } = await setup(true, scope);
        const out = await settle(r.h, r.e, r.e.engine.run(op, params, { origin }));
        if (scope === 'read') {
          expect(code(out.error)).toBe('POLICY_DENIED');
        } else if (scope === 'propose') {
          expect(out.error).toBeUndefined();
          expect((out.value as { status: string }).status).toBe('proposal_captured');
          expect(r.h.mock.calls.filter((c) => c.method !== 'GET')).toEqual([]);
        } else {
          expect(out.error).toBeUndefined();
          expect(['succeeded', 'queued']).toContain((out.value as { status: string }).status);
        }
        await rig?.close();
        rig = undefined;
      }
    });
  }
});
