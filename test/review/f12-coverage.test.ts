/**
 * v3 F12 (ADR 0081, D2): the Revert coverage test. Every write kind an agent can cause, through the high-level tools,
 * `lk_api_write`, `lk_api_batch` or the `lk_op_*` tools, comes down to the registry's write operations and the bridge's
 * own steps. Each write operation has a Revert path (`REVERT_PATHS`) or is refused for agents with why
 * (`AGENT_REFUSED`); this test fails the moment one has neither (a new LegendKeeper operation included), so nothing is
 * ever written directly with no way back. The generic undo's table (`ENTITY_OPS`) only names operations with a path,
 * each kind it names can be read, and every refused operation is refused by the policy gate at scope `write`.
 */
import { describe, expect, it } from 'vitest';
import { operations } from '../../src/lk/registry.js';
import { BATCH_UPLOAD_STEPS, INTERNAL_STEPS } from '../../src/jobs/internal-steps.js';
import { ENTITIES, ENTITY_OPS } from '../../src/review/entity-undo.js';
import { AGENT_REFUSED, REVERT_PATHS } from '../../src/review/write-kinds.js';
import { createPolicyGate } from '../../src/policy/gate.js';
import { policyOpMeta } from '../../src/jobs/policy.js';
import { requireOperation } from '../../src/lk/registry.js';
import type { PolicyStore } from '../../src/policy/store.js';

const writes = operations.filter((o) => o.kind !== 'read').map((o) => o.operationId);

describe('every write kind an agent can cause has a Revert path, or is refused for agents', () => {
  it('each write operation of the registry is in exactly one of the two tables', () => {
    const missing = writes.filter((op) => !(op in REVERT_PATHS) && !(op in AGENT_REFUSED));
    expect(missing, `write operations with no Revert path and no refusal: ${missing.join(', ')}`).toEqual([]);
    const both = writes.filter((op) => op in REVERT_PATHS && op in AGENT_REFUSED);
    expect(both).toEqual([]);
  });

  it('the tables name only real write operations, each with its path in words', () => {
    for (const op of [...Object.keys(REVERT_PATHS), ...Object.keys(AGENT_REFUSED)]) {
      expect(writes, op).toContain(op);
      expect((REVERT_PATHS[op] ?? AGENT_REFUSED[op])!.length, op).toBeGreaterThan(10);
    }
  });

  it('the generic undo handles only operations with a path, and can read every kind it names', () => {
    for (const [op, e] of Object.entries(ENTITY_OPS)) {
      expect(REVERT_PATHS, op).toHaveProperty(op);
      const def = ENTITIES[e.entity];
      expect(def.get ?? def.list, `${e.entity} has a read`).toBeDefined();
      requireOperation((def.get ?? def.list)!);
      if (e.action === 'create' || e.action === 'restore') expect(def.remove, `${op}: undone by a delete`).toBeDefined();
      if (e.action === 'update') expect(def.update, op).toBe(op);
      if (e.action === 'delete' && e.entity !== 'resource' && e.entity !== 'document' && e.entity !== 'asset')
        expect(def.create, `${op}: undone by making it again`).toBeDefined();
      for (const step of [def.create, def.update, def.remove, def.restore].filter((x): x is string => !!x))
        requireOperation(step);
    }
  });

  it('the bridge’s own steps write nothing to LegendKeeper but an upload, which a placement’s Revert covers', () => {
    // Checks, verifies, records and Last Major Revision decisions: the bridge's own database (a record goes back with the
    // target it records, a chronology change's or a lifecycle change's). The upload's PUT and check: `createImageAsset`.
    expect([...INTERNAL_STEPS].sort()).toEqual(['bridge.expect', 'bridge.lmr', 'bridge.record', 'bridge.verify']);
    expect([...BATCH_UPLOAD_STEPS].sort()).toEqual(['upload_image.put', 'upload_image.verify']);
    expect(REVERT_PATHS.createImageAsset).toMatch(/placement|upload/);
  });

  it('every refused operation is refused by the policy gate for an agent at scope write, naming why', async () => {
    const store = {
      version: 1,
      now: () => 0,
      lookupPrincipal: (id: string) => ({
        principal: { principalId: id, profile: 'agent', label: 'agent' },
        profileId: 'p1',
        scope: 'write' as const,
        showLowLevelTools: false,
        active: true,
      }),
    } as unknown as PolicyStore;
    const gate = createPolicyGate({ store, allowMemberAdmin: true, proposalState: () => undefined });
    const principal = { principalId: 'pat_agent', profile: 'agent', label: 'agent' };
    for (const op of Object.keys(AGENT_REFUSED)) {
      const d = await gate.authorize(principal, policyOpMeta(requireOperation(op), {}), {}, {
        origin: { kind: 'mcp', tool: 'lk_api_write', principal },
        project: 'p',
        jobKind: 'single_op',
      });
      expect(d, op).toMatchObject({ decision: 'deny', reason: expect.stringContaining('member administration') });
    }
    // An ordinary write at scope write: allowed (direct).
    const ok = await gate.authorize(principal, policyOpMeta(requireOperation('deleteResource'), {}), {}, {
      origin: { kind: 'mcp', tool: 'delete_resource', principal },
      project: 'p',
      jobKind: 'single_op',
    });
    expect(ok).toEqual({ decision: 'allow' });
  });
});
