/**
 * v3 F3d (ADR 0053 part D1): a raw `updateBlock` through the low-level tools is measured by ADR 0051's rule like any
 * other edit. It sends only the fields it changes, so the journal kept no "before" and every such edit counted. Now the
 * proposal's capture keeps the block as it read it as the step's journal pre-image, and the run-time measure judges it:
 * a typo fix or a one-word change is not a major revision; a real rewrite is.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { londonDate } from '../../src/jobs/internal-steps.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, RHEASHIRA, type FactsWorld } from '../facts/world.js';

let w: FactsWorld;
let proposer: Client;
const LMR_ROW = 'rhea0013';
const OLD = '9 November 2026';
const lmr = () => w.sidebars.rows(RHEASHIRA.page).find((r) => r.key === 'Last Major Revision')!.text;
const today = () => londonDate(Date.now());
const doc = () => w.repo.liveDocs(w.repo.live(RHEASHIRA.page)!)[0]!;
const PARA = 'ubpara01';

beforeAll(async () => {
  w = await factsWorld();
  proposer = await w.stack.connect(w.stack.newToken('lmr-update-block', 'propose').token);
  // As the tree would know the page: its PROPERTIES with a Last Major Revision row.
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify([
      {
        id: RHEASHIRA.property,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { key: 'Status', text: '' },
          { key: 'Last Major Revision', text: '' },
        ],
      },
    ]),
    PROJECT,
    RHEASHIRA.page,
  );
});
afterAll(async () => w.close());
beforeEach(() => {
  const row = w.sidebars.pages.get(RHEASHIRA.page)!.props[0]!.rows!.find((r) => r.id === LMR_ROW)!;
  row.content = [{ text: OLD }];
  w.repo.blocks.set(doc().id, {
    version: 3,
    blocks: [
      {
        id: PARA,
        kind: 'paragraph',
        content: [{ text: 'The envoy reached the Hollow Court at dusk and was received by the regent.' }],
      },
    ],
  });
});

/** Proposes one updateBlock of the paragraph through lk_api_write, approves it as the owner and waits for its job. */
async function updateBlock(text: string) {
  const r = await w.stack.call(proposer, 'lk_api_write', {
    operationId: 'updateBlock',
    params: {
      path: { resourceId: RHEASHIRA.page, documentId: doc().id, blockId: PARA },
      ifMatch: 'v3',
      body: { content: [{ text }] },
    },
  });
  expect(r.body.status, r.text).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w.stack.runtime.policy;
  // Measured when it runs: the proposal cannot know the verdict yet.
  expect(pol.proposals.get(id)!.summary).toContain('measured when it runs');
  await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 300 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  const p = pol.proposals.get(id)!;
  expect(p.state).toBe('executed');
  const job = w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId!)!;
  expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  // The block as captured is the journal's pre-image of the write (the rule's "before").
  const entry = w.stack.runtime.engine.queries
    .journalLookup(PROJECT, { jobId: job.id, includePreImage: true, limit: 50 })
    .find((e) => e.opId === 'updateBlock') as { preImage?: { content?: { text?: string }[] } } | undefined;
  expect(entry?.preImage?.content?.[0]?.text).toContain('The envoy reached the Hollow Court');
  return job;
}

describe('updateBlock through lk_api_write, proposed and approved', () => {
  it('a typo fix is not a major revision: Last Major Revision is left', async () => {
    const job = await updateBlock(
      'The envoy reached the Holow Court at dusk and was received by the regent.',
    );
    expect(JSON.stringify(job.result)).toContain('not a major revision');
    expect(lmr()).toBe(OLD);
    expect(
      (w.repo.blocks.get(doc().id)!.blocks[0] as { content: { text: string }[] }).content[0]!.text,
    ).toContain('Holow');
  });

  it('one changed word is not a major revision either (fewer than 8 words)', async () => {
    await updateBlock('The envoy reached the Silver Court at dusk and was received by the regent.');
    expect(lmr()).toBe(OLD);
  });

  it('a real rewrite is: Last Major Revision is set to the day it runs', async () => {
    await updateBlock(
      'Turned away at the Silver Gate, the envoy waited three nights before the regent agreed to an audience.',
    );
    expect(lmr()).toBe(today());
  });
});
