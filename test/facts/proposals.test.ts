/**
 * The proposal groundwork for multi-page operations (v2 C2a, PLAN-v2 10.2): a proposal stores a LIST of high-level
 * operations and their expansion; ids the expansion needs are minted at capture and used exactly at approval; every
 * proposal has a page-level summary; the generic verify step records a difference on the job and the proposal. Built
 * with a test operation (C2b's tools will use the same parts) and with set_facts.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isClientId, mintClientId, type JobOrigin, type StepSpec } from '../../src/jobs/index.js';
import { VERIFY_STEP } from '../../src/jobs/internal-steps.js';
import { buildPageSummary } from '../../src/policy/index.js';
import { ROOT } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, type FactsWorld } from './world.js';

let w: FactsWorld;
let proposer: Client;
let origin: JobOrigin;
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string) => {
  for (let i = 0; i < 200 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};

beforeAll(async () => {
  w = await factsWorld();
  const t = w.stack.newToken('groundwork-proposer', 'propose');
  proposer = await w.stack.connect(t.token);
  origin = {
    kind: 'mcp',
    tool: 'test_structure',
    principal: { principalId: t.patId, profile: 'groundwork-proposer', label: 'Groundwork proposer' },
  };
});
afterAll(async () => w.close());

/**
 * The test operation: a new index, a page "under" it, and a link "to" the new page from an existing page, as a
 * multi-page tool will plan it. The ids are minted here, at planning time, which for a proposal IS capture time.
 */
function planStructure(o: { childName?: string; expectName?: string } = {}) {
  const indexId = mintClientId();
  const childId = mintClientId();
  const childName = o.childName ?? '[BSRC] Groundwork Child';
  const related = w.sidebars.items(P.miyabi, 'Related Sources');
  const steps: StepSpec[] = [
    {
      op: 'createResource',
      params: { body: { id: indexId, name: '[INDEX] Groundwork Index', parentId: ROOT } },
    },
    { op: 'createResource', params: { body: { id: childId, name: childName, parentId: indexId } } },
    {
      op: 'updateProperty',
      params: {
        path: { resourceId: P.miyabi, propertyId: 'relmiya1' },
        body: {
          items: [
            ...related.map((i) => ({ id: i.id, rank: i.rank, resourceId: i.resourceId })),
            { resourceId: childId },
          ],
        },
      },
    },
    {
      op: VERIFY_STEP,
      params: {
        body: {
          targets: [
            {
              kind: 'resource',
              label: 'Groundwork Child',
              resourceId: childId,
              fields: { name: o.expectName ?? childName, parentId: indexId },
            },
          ],
        },
      },
    },
  ];
  const operations = [
    {
      tool: 'test_structure',
      page: { id: indexId, name: 'Groundwork Index' },
      isNew: true,
      pageParts: ['created'],
    },
    {
      tool: 'test_structure',
      page: { id: childId, name: 'Groundwork Child' },
      isNew: true,
      pageParts: ['created under Groundwork Index'],
    },
    {
      tool: 'test_structure',
      page: { id: P.miyabi, name: 'Asagiri Miyabi' },
      pageParts: ['sidebar', '1 link added'],
    },
  ];
  return { indexId, childId, steps, operations };
}

describe('ids minted at capture, used exactly at approval', () => {
  it('a test operation: new index, a child under it and a link to it, approved with exactly the stored ids', async () => {
    const plan = planStructure();
    const r = await w.stack.runtime.engine.submit({
      kind: 'batch_ops',
      project: PROJECT,
      steps: plan.steps,
      origin,
      internal: true,
      proposal: { operations: plan.operations, summary: 'Test structure: an index, a child and a link' },
    });
    expect(r).toMatchObject({ status: 'proposal_captured' });
    const id = (r as { proposalId: string }).proposalId;
    const d = proposals().detail(id)!;
    // The expansion holds the minted ids, so the child "under" the new index and the link "to" the new page are fixed.
    expect((d.ops[0]!.params as { body: { id: string } }).body.id).toBe(plan.indexId);
    expect((d.ops[1]!.params as { body: { parentId: string } }).body.parentId).toBe(plan.indexId);
    expect(JSON.stringify(d.ops[2]!.params)).toContain(plan.childId);
    expect(d.operations).toHaveLength(3);
    expect(d.pageSummary.map((e) => e.label)).toEqual([
      'Groundwork Index (new): created',
      'Groundwork Child (new): created under Groundwork Index',
      'Asagiri Miyabi: sidebar, 1 link added',
    ]);
    expect(proposals().get(id)!.pages).toHaveLength(3);
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id);
    expect(p.state, JSON.stringify(p.error)).toBe('executed');
    expect(w.repo.live(plan.indexId)?.parentId).toBe(ROOT);
    expect(w.repo.live(plan.childId)?.parentId).toBe(plan.indexId);
    expect(w.sidebars.items(P.miyabi, 'Related Sources').map((i) => i.resourceId)).toContain(plan.childId);
    expect(proposals().detail(id)!.execution).toMatchObject({ verified: true });
  });

  it('a create proposed through lk_api_write without an id gets one at capture, kept at approval', async () => {
    const r = await w.stack.call(proposer, 'lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: '[BSRC] Captured Id Page', parentId: ROOT } },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = r.body.proposalId as string;
    const minted = (proposals().detail(id)!.ops[0]!.params as { body: { id: string } }).body.id;
    expect(isClientId(minted)).toBe(true);
    expect(
      proposals()
        .detail(id)!
        .pageSummary.map((e) => e.label),
    ).toEqual(['[BSRC] Captured Id Page (new): created']);
    await w.stack.runtime.policy.commands.approve('owner', id);
    expect((await settle(id)).state).toBe('executed');
    expect(w.repo.live(minted)?.name).toBe('[BSRC] Captured Id Page');
  });
});

describe('generic verification', () => {
  it('records a difference on the job, the proposal and the errors table, and retries nothing', async () => {
    const plan = planStructure({ childName: '[BSRC] Verified Child' });
    // LegendKeeper (the model) stores the child's name differently from what was sent.
    w.repo.nameFilter = (n) => (n === '[BSRC] Verified Child' ? '[BSRC] Verified child (renamed)' : n);
    try {
      const r = await w.stack.runtime.engine.submit({
        kind: 'batch_ops',
        project: PROJECT,
        steps: plan.steps,
        origin,
        internal: true,
        proposal: { operations: plan.operations },
      });
      const id = (r as { proposalId: string }).proposalId;
      await w.stack.runtime.policy.commands.approve('owner', id);
      const p = await settle(id);
      expect(p.state).toBe('executed');
      const d = proposals().detail(id)!;
      expect(d.execution).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
      expect(JSON.stringify(d.execution)).toContain('Verified child (renamed)');
      const job = w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId!)!;
      expect(job.result).toMatchObject({ verified: false });
      const errs = w.stack.runtime.engine.queries.listErrors(PROJECT, { limit: 10 });
      expect(errs.find((e) => e.code === 'VERIFY_MISMATCH' && e.jobId === p.jobId)?.message).toMatch(
        /written but not as planned/,
      );
    } finally {
      w.repo.nameFilter = (n) => n;
    }
  });
});

describe('set_facts proposals', () => {
  it('keeps the operation list, a page-level summary and the facts table; approval runs the check, chain and verify', async () => {
    const r = await w.stack.call(proposer, 'set_facts', {
      page: P.mehrana,
      facts: { Scope: 'Qishen scholar of the Archive', Notes: null, Mood: 'Stern' },
      links: { Dependencies: { add: ['Asagiri Kaede'] } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured' });
    expect(r.body.requiresCanonicalApproval).toBeUndefined();
    const id = r.body.proposalId as string;
    const d = proposals().detail(id)!;
    expect(d.pageSummary.map((e) => e.label)).toEqual([
      'Mehrana al-Khalid: sidebar, 1 fact changed, 1 fact added, 1 fact removed, 1 link added',
    ]);
    const op = d.operations[0] as { tool: string; facts: unknown[]; links: { added: { name: string }[] }[] };
    expect(op.tool).toBe('set_facts');
    expect(op.facts).toEqual(
      expect.arrayContaining([
        { key: 'Scope', before: 'Qishen scholar', after: 'Qishen scholar of the Archive', change: 'changed' },
        { key: 'Notes', before: 'Loose', after: null, change: 'removed' },
        { key: 'Mood', before: null, after: 'Stern', change: 'added' },
      ]),
    );
    expect(op.links[0]!.added.map((l) => l.name)).toEqual(['Asagiri Kaede']);
    expect(d.ops.map((o) => o.op)).toEqual([
      'bridge.expect',
      'updatePropertyRow',
      'createPropertyRow',
      'deletePropertyRow',
      'updateProperty',
      'bridge.verify',
    ]);
    // An agent sees its own proposal's pages and whether it needs canonical approval.
    const status = await w.stack.call(proposer, 'bridge_proposal_status', { proposalId: id });
    expect(status.body).toMatchObject({ requiresCanonicalApproval: false, pages: [d.pageSummary[0]!.label] });
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id);
    expect(p.state, JSON.stringify(p.error)).toBe('executed');
    expect(proposals().detail(id)!.execution).toMatchObject({ verified: true });
    expect(w.sidebars.rows(P.mehrana).map((x) => x.key)).toContain('Mood');
    expect(w.sidebars.items(P.mehrana, 'Dependencies').map((i) => i.resourceId)).toEqual(['kaede001']);
  });

  it('a sidebar changed after capture makes the approval conflicted; nothing is written', async () => {
    const r = await w.stack.call(proposer, 'set_facts', { page: P.mehrana, facts: { Mood: 'Calm' } });
    const id = r.body.proposalId as string;
    w.sidebars.outside(P.mehrana, (s) => {
      s.props[0]!.rows!.find((x) => x.key === 'Scope')!.content = [{ text: 'Changed in the app' }];
    });
    const before = w.sidebars.requests.filter((x) => x.method !== 'GET').length;
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id);
    expect(p.state).toBe('conflicted');
    expect(w.sidebars.requests.filter((x) => x.method !== 'GET').length).toBe(before);
  });
});

describe('the page-level summary of any proposal', () => {
  it('groups low-level operations by page, in plain words', () => {
    const names: Record<string, string> = {
      miyabi01: 'Asagiri Miyabi - Character Core',
      kaede001: 'Asagiri Kaede',
    };
    const s = buildPageSummary(
      [
        {
          op: 'updatePropertyRow',
          params: { path: { resourceId: 'miyabi01', propertyId: 'p', rowId: 'a' } },
        },
        {
          op: 'updatePropertyRow',
          params: { path: { resourceId: 'miyabi01', propertyId: 'p', rowId: 'b' } },
        },
        {
          op: 'deletePropertyRow',
          params: { path: { resourceId: 'miyabi01', propertyId: 'p', rowId: 'c' } },
        },
        { op: 'replaceDocumentBlocks', params: { path: { resourceId: 'kaede001', documentId: 'd' } } },
        { op: 'createResource', params: { body: { id: 'newpage1', name: 'New Page' } } },
        { op: 'createAssetFolder', params: { body: { name: 'x' } } },
      ],
      undefined,
      (id) => names[id] ?? null,
    );
    expect(s.map((e) => e.label)).toEqual([
      'Asagiri Miyabi - Character Core: sidebar, 2 facts changed, 1 fact removed',
      'Asagiri Kaede: text changed',
      'New Page (new): created',
      'Project: createAssetFolder',
    ]);
  });
});
