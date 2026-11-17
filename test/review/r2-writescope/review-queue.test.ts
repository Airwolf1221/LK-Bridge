/**
 * CR-2026-11 round 2 (write scope): the Review queue (ADR 0055 decision A). "When a job is created whose principal is an
 * agent … that was not approved by the owner, and that writes, it is recorded … The page lists the items newest first,
 * with the agent, the tool, a summary in the words a proposal would have used (the tool's own summary, else the job's
 * title) and the pages touched."
 *
 * Every test asserts the SAFE behaviour: what the owner reads on the Review page describes what the job did, in the
 * bridge's words, not words the agent chose.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import { factsWorld, type FactsWorld } from '../../facts/world.js';
import { proposalSummary } from '../../../src/policy/proposals.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeAgent, type Agent } from './helpers.js';

let w: FactsWorld;
let a: Agent;
const board = {
  version: 1,
  shapes: [{ id: 'shape:1', type: 'geo', parentId: 'page:1', index: 'a1', props: {} }],
};

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  a = await writeAgent(w, 'r2-review-agent');
  w.overrides.set(
    new RegExp(`/resources/board001/docs/${w.docs.board}/board$`),
    (req: MockRequest): MockResponse | undefined => {
      const view = () => ({
        version: `bv${board.version}`,
        pages: [{ id: 'page:1', name: 'Plot' }],
        shapes: board.shapes,
        bindings: [],
      });
      if (req.method === 'GET') return { status: 200, body: view() };
      if (req.method === 'PUT') {
        board.shapes = (req.body as { shapes: typeof board.shapes }).shapes;
        board.version++;
        return { status: 200, body: view() };
      }
      return undefined;
    },
  );
}, 60_000);
afterAll(async () => w?.close());

describe('what the Review page says about a direct low-level batch', () => {
  it('E1: the summary is the bridge’s description of the operations, not the title the agent chose', async () => {
    const spoof = 'write_page append on “Ashgate”: fixed a typo';
    const r = await w.stack.call(a.client, 'lk_api_batch', {
      title: spoof,
      calls: [
        {
          operationId: 'replaceBoardContent',
          params: { path: { resourceId: 'board001', documentId: w.docs.board }, body: { shapes: [] } },
        },
      ],
    });
    // (A1 shows this runs directly; here only what the owner reads about it matters.)
    expect(typeof r.body.jobId, r.text).toBe('string');
    await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 20_000);
    const item = w.stack.runtime.review.list(PROJECT).find((i) => i.jobId === r.body.jobId);
    expect(item, 'the direct write is listed').toBeDefined();
    // The words a proposal of the same batch would have used (the proposal service's own summary of the operations).
    const asProposal = proposalSummary([
      { op: 'replaceBoardContent', params: { path: { resourceId: 'board001', documentId: w.docs.board! } } },
    ]);
    expect(
      { summary: item!.summary, mentionsTheOperation: item!.summary.includes('replaceBoardContent') },
      `a proposal would have said: ${asProposal}`,
    ).toEqual({ summary: expect.not.stringContaining('fixed a typo'), mentionsTheOperation: true });
  });
});
