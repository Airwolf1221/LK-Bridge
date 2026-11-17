/**
 * v3 F3.4 (ADR 0055 decision E): a DIRECT `updateBlock` at scope `write`, with the caller's own If-Match, is measured by
 * ADR 0051's rule like any other edit. It sends only the fields it changes and its If-Match needs no read, so the journal
 * had no "before" and every such edit counted as a major revision. Now the engine reads the block once inside the lock,
 * only when the rule needs a "before" (the page has a Last Major Revision row and the mode is `auto`), and keeps it as
 * the write's journal pre-image: a typo fix is minor, a real rewrite is major, and `skip` makes no read.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { londonDate } from '../../src/jobs/internal-steps.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, RHEASHIRA, type FactsWorld } from '../facts/world.js';

let w: FactsWorld;
let writer: Client;
const LMR_ROW = 'rhea0013';
const OLD = '9 November 2026';
const lmr = () => w.sidebars.rows(RHEASHIRA.page).find((r) => r.key === 'Last Major Revision')!.text;
const today = () => londonDate(Date.now());
const doc = () => w.repo.liveDocs(w.repo.live(RHEASHIRA.page)!)[0]!;
const PARA = 'ubpara02';
const blockReads = () =>
  w.stack.mock.calls.filter((c) => c.method === 'GET' && c.path.includes(`/blocks/${PARA}`)).length;

beforeAll(async () => {
  w = await factsWorld();
  const t = w.stack.newToken('lmr-update-block-write', 'write');
  w.stack.runtime.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
  writer = await w.stack.connect(t.token);
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
    version: 7,
    blocks: [
      {
        id: PARA,
        kind: 'paragraph',
        content: [{ text: 'The envoy reached the Hollow Court at dusk and was received by the regent.' }],
      },
    ],
  });
});

/** One direct updateBlock through lk_api_write, with the caller's own If-Match; returns its job. */
async function updateBlock(text: string, extra: Record<string, unknown> = {}) {
  const r = await w.stack.call(writer, 'lk_api_write', {
    operationId: 'updateBlock',
    params: {
      path: { resourceId: RHEASHIRA.page, documentId: doc().id, blockId: PARA },
      ifMatch: 'v7',
      body: { content: [{ text }] },
    },
    ...extra,
  });
  expect(r.body.status, r.text).toBe('succeeded');
  const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(r.body.jobId))!;
  expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  expect(job.approvedBy).toBeNull();
  return { r, job };
}

const preImageOf = (jobId: string) =>
  w.stack.runtime.engine.queries
    .journalLookup(PROJECT, { jobId, includePreImage: true, limit: 50 })
    .find((e) => e.opId === 'updateBlock') as { preImage?: { content?: { text?: string }[] } } | undefined;

describe('a direct updateBlock at scope write', () => {
  it('a typo fix is not a major revision: the block was read once, kept as its pre-image', async () => {
    const reads = blockReads();
    const { job } = await updateBlock('The envoy reached the Holow Court at dusk and was received by the regent.');
    expect(blockReads()).toBe(reads + 1);
    expect(preImageOf(job.id)?.preImage?.content?.[0]?.text).toContain('Hollow Court');
    expect(JSON.stringify(job.result)).toContain('not a major revision');
    expect(lmr()).toBe(OLD);
  });

  it('a real rewrite is: Last Major Revision is set to today', async () => {
    await updateBlock(
      'Turned away at the Silver Gate, the envoy waited three nights before the regent agreed to an audience.',
    );
    expect(lmr()).toBe(today());
  });

  it('with lastMajorRevision "skip" the rule needs no "before": no read, no pre-image', async () => {
    const reads = blockReads();
    const { job } = await updateBlock('The envoy reached the Hollow Court at dawn.', { lastMajorRevision: 'skip' });
    expect(blockReads()).toBe(reads);
    expect(preImageOf(job.id)?.preImage ?? null).toBeNull();
    expect(lmr()).toBe(OLD);
  });
});
