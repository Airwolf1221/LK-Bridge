/**
 * The live policy gate: the scope matrix generated from the registry, live scope changes, unknown and revoked
 * principals, the system principal, and refused look-alikes of the owner's approval.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import {
  SYSTEM_PRINCIPAL,
  policyOpMeta,
  type JobOrigin,
  type PolicyDecision,
  type Principal,
} from '../../src/jobs/index.js';
import { operations } from '../../src/lk/registry.js';
import type { OperationDef } from '../../src/lk/registry-types.js';
import { issueApprovalToken } from '../../src/policy/approval.js';
import { SCOPES, UPLOAD_OPERATIONS, createPolicy, type Policy, type Scope } from '../../src/policy/index.js';
import { makePat, mcpOriginFor } from './helpers.js';
import { AGENT_REFUSED } from '../../src/review/write-kinds.js';

/** v2 A1: every policy decision is for one project (an approval only covers its own). */
const PROJECT = 'proj_mock';

let db: Db;
let now = Date.UTC(2026, 10, 7, 12);
const clock = () => now;

function rig(allowMemberAdmin = false): Policy {
  return createPolicy({ db, allowMemberAdmin, now: clock });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  now = Date.UTC(2026, 10, 7, 12);
});
afterEach(() => db.close());

const ask = (
  policy: Policy,
  principal: Principal,
  def: OperationDef,
  origin: JobOrigin = mcpOriginFor(principal),
  jobKind: 'single_op' | 'batch_ops' = 'single_op',
  stepIndex?: number,
): PolicyDecision =>
  policy.gate.authorize(
    principal,
    policyOpMeta(def, {}),
    {},
    {
      origin,
      project: PROJECT,
      jobKind,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
    },
  );

/**
 * What the scope table in docs/policy.md says each operation gets from the gate. Member administration is refused for
 * every agent at every scope (v3 F12, ADR 0081: it has no Revert; the owner does it in the LegendKeeper app), whatever
 * LK_ALLOW_MEMBER_ADMIN says, so the setting does not change the gate's answer.
 */
function expected(scope: Scope, def: OperationDef): PolicyDecision['decision'] {
  if (def.kind === 'read') return 'allow';
  if (def.operationId in AGENT_REFUSED) return 'deny';
  // v1: uploads are not proposable (docs/policy.md).
  if (scope === 'propose' && UPLOAD_OPERATIONS.has(def.operationId)) return 'deny';
  return scope === 'write' ? 'allow' : scope === 'propose' ? 'propose' : 'deny';
}

describe('scope matrix (every registry operation × every scope)', () => {
  for (const allowMemberAdmin of [false, true]) {
    it(`matches each operation's kind (LK_ALLOW_MEMBER_ADMIN=${allowMemberAdmin})`, () => {
      const policy = rig(allowMemberAdmin);
      expect(operations).toHaveLength(89);
      let checked = 0;
      for (const scope of SCOPES) {
        const { principal } = makePat(db, policy, `p-${scope}`, scope, clock);
        for (const def of operations) {
          const d = ask(policy, principal, def);
          expect(d.decision, `${scope} ${def.operationId}`).toBe(expected(scope, def));
          checked++;
        }
      }
      expect(checked).toBe(89 * 3);
    });
  }

  it('explains a read-only denial and how the owner can change it', () => {
    const policy = rig();
    const { principal } = makePat(db, policy, 'claude', 'read', clock);
    const d = ask(
      policy,
      principal,
      operations.find((o) => o.operationId === 'updateResource')!,
    );
    expect(d).toEqual({ decision: 'deny', reason: expect.stringContaining('read-only') as unknown });
    expect((d as { reason: string }).reason).toContain('owner can change');
  });
});

describe('live evaluation', () => {
  const write = () => operations.find((o) => o.operationId === 'replaceDocumentBlocks')!;

  it('a scope change applies to an existing token at once, through the cache', () => {
    const policy = rig();
    const { principal, profileId } = makePat(db, policy, 'claude-code', 'read', clock);
    expect(ask(policy, principal, write()).decision).toBe('deny');
    policy.commands.setScope('owner', profileId, 'propose');
    expect(ask(policy, principal, write()).decision).toBe('propose');
    policy.commands.setScope('owner', profileId, 'write');
    expect(ask(policy, principal, write()).decision).toBe('allow');
    policy.commands.setScope('owner', profileId, 'read');
    expect(ask(policy, principal, write()).decision).toBe('deny');
  });

  it('a change made outside this process is seen within one second', () => {
    const policy = rig();
    const { principal, profileId } = makePat(db, policy, 'p', 'read', clock);
    expect(ask(policy, principal, write()).decision).toBe('deny');
    db.prepare(`UPDATE agent_profiles SET scope = 'write' WHERE id = ?`).run(profileId); // e.g. the PAT CLI
    now += 1000;
    expect(ask(policy, principal, write()).decision).toBe('allow');
  });

  it('a revoked or expired PAT, and an unknown principal, are denied (reads too)', () => {
    const policy = rig();
    const read = operations.find((o) => o.operationId === 'getResource')!;
    const { principal, patId } = makePat(db, policy, 'p', 'write', clock);
    expect(ask(policy, principal, read).decision).toBe('allow');
    expect(policy.commands.revoke('owner', patId)).toBe(true);
    expect(ask(policy, principal, read)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('revoked') as unknown,
    });
    const ghost: Principal = { principalId: 'pat_ghost', profile: 'write-everything', label: 'Ghost' };
    expect(ask(policy, ghost, read)).toMatchObject({ decision: 'deny' });
    const forged: Principal = { principalId: 'owner', profile: 'system', label: 'Owner' };
    expect(ask(policy, forged, write())).toMatchObject({ decision: 'deny' });
    // An expired PAT.
    const exp = makePat(db, policy, 'q', 'write', clock);
    db.prepare('UPDATE auth_pats SET expires_at = ? WHERE id = ?').run(1, exp.patId);
    policy.store.bump();
    expect(ask(policy, exp.principal, read).decision).toBe('deny');
  });

  it('trusts the principal id, not the profile name a caller claims', () => {
    const policy = rig();
    const { principal } = makePat(db, policy, 'reader', 'read', clock);
    makePat(db, policy, 'writer', 'write', clock);
    const claimed = { ...principal, profile: 'writer' };
    expect(ask(policy, claimed, write()).decision).toBe('deny');
  });
});

describe('system principal and approval look-alikes', () => {
  const write = () => operations.find((o) => o.operationId === 'deleteResource')!;

  it('allows the system principal for internal and dashboard work, but never on an MCP origin', () => {
    const policy = rig();
    expect(ask(policy, SYSTEM_PRINCIPAL, write(), { kind: 'ui' }).decision).toBe('allow');
    expect(ask(policy, SYSTEM_PRINCIPAL, write(), { kind: 'system' }).decision).toBe('allow');
    expect(ask(policy, SYSTEM_PRINCIPAL, write(), { kind: 'mcp', tool: 'x' }).decision).toBe('deny');
  });

  it('refuses approvedBy, and approval objects it did not mint, from anyone', () => {
    const policy = rig();
    const { principal } = makePat(db, policy, 'p', 'propose', clock);
    const base = mcpOriginFor(principal);
    expect(ask(policy, principal, write(), { ...base, approvedBy: 'owner' })).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('approvedBy') as unknown,
    });
    for (const approval of [{ proposalId: 'prop_x' }, 'prop_x', JSON.parse('{"proposalId":"prop_x"}')]) {
      expect(ask(policy, principal, write(), { ...base, approval }, 'batch_ops', 0).decision).toBe('deny');
    }
    // Even a real token is refused while its proposal is not awaiting execution, and on a single_op.
    const token = issueApprovalToken(
      'prop_missing',
      principal.principalId,
      PROJECT,
      [{ op: 'deleteResource', paramsHash: 'x' }],
      now,
    );
    expect(ask(policy, principal, write(), { ...base, approval: token }, 'single_op').decision).toBe('deny');
    expect(ask(policy, principal, write(), { ...base, approval: token }, 'batch_ops', 0).decision).toBe(
      'deny',
    );
  });
});
