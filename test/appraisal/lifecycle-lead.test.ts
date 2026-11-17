/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c (ADR 0054) with F3d (ADR 0053): on a project whose pack says the lifecycle tag leads, the audits' new
 * "lifecycle tag not leading" finding is gathered by the owner appraisal (A2) like the other audits: never re-checked,
 * never reported twice. Its fix only reorders tags, so it is handed over to the audits' own "Propose a fix" as the tag
 * fixes are; a status tag a reorder cannot remove stays the owner's (a judgement, no fix).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { approveTagRules } from '../packs/tag-rules.js';
import { appraisalWorld, type AppraisalWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

const WORKING_INDEX = 'wkidx001';
/** A Working page whose lifecycle tag is not first: a reorder repairs it. */
const LATE = 'lateldwk';
/** A Working page that leads with its lifecycle tag but still carries a status tag: a reorder cannot remove it. */
const STILL = 'stillcwk';

let w: AppraisalWorld;
beforeAll(async () => {
  w = await appraisalWorld({
    seed: (world) => {
      world.repo.seed({
        id: LATE,
        name: '[BWRK] Reed Market Draft',
        parentId: WORKING_INDEX,
        referenceType: 'General Source',
        tags: ['Polity', 'Working'],
      });
      world.repo.seed({
        id: STILL,
        name: '[BWRK] Salt Toll Draft',
        parentId: WORKING_INDEX,
        referenceType: 'General Source',
        tags: ['Working', 'CANON'],
      });
    },
  });
  // The owner approves a pack version under which the lifecycle tag leads on this project (Arkona's own setting).
  approveTagRules(w.stack.runtime, { lead: true });
  await w.snapshot();
});
afterAll(async () => w?.close());

const appraise = async (page: string) => {
  const r = await w.call('arkona_appraise_owner', { page, limit: 200, detail: 'full', project: 'test' });
  expect(r.isError, r.text).toBe(false);
  return (r.body.findings as any[]).filter((f) => f.details.audit?.code === 'lifecycle_tag_not_leading');
};

it('“lifecycle tag not leading” is gathered once, as a tag finding, with the audit’s reorder-only fix handed over', async () => {
  const found = await appraise(LATE);
  expect(found).toHaveLength(1);
  const f = found[0];
  expect(f).toMatchObject({
    check: 'tag_grammar',
    group: 'required',
    source: { kind: 'audit' },
    followUp: { kind: 'fix', via: 'audit' },
  });
  expect(f.details.audit).toMatchObject({ category: 'lifecycle', severity: 'warning' });
  const before = w.requests();
  const r = await w.call('arkona_appraisal_fix', { findingId: f.id, project: 'test' });
  expect(r.body.status, r.text).toBe('proposal_captured');
  expect(r.body.fix).toBe('audit:reorder_tags');
  expect(w.requests().writes).toBe(before.writes); // a proposal: nothing written before the owner approves
  const ops = w.stack.runtime.policy.proposals
    .detail(r.body.proposalId)!
    .ops.filter((o) => !o.op.startsWith('bridge.'))
    .map((o) => ({ op: o.op, params: o.params as any }));
  expect(ops).toEqual([
    expect.objectContaining({
      op: 'updateResource',
      params: expect.objectContaining({ body: { tags: ['Working', 'Polity'] } }),
    }),
  ]);
});

it('a status tag a reorder cannot remove stays the owner’s: a judgement, with no fix', async () => {
  const found = await appraise(STILL);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ check: 'audit_finding', followUp: { kind: 'judgement' } });
  const r = await w.call('arkona_appraisal_fix', { findingId: found[0].id, project: 'test' });
  expect(r.body.error.code).toBe('NO_FIX');
});
