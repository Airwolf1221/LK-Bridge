/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F2 (ADR 0049 decision 2): Last Major Revision on every substantial edit, end to end through the real server, the
 * MCP client, the policy layer and the engine, against the facts world's faithful sidebars.
 *
 * - counting edits (write_page, a block edit through lk_api_write, set_facts of a non-housekeeping key) set the page's
 *   row to today in Europe/London, in the same job, after the content write, with their own If-Match: chained on the
 *   row write's version when there is one, else the version one read of the rows gives;
 * - non-counting ones (a tag change, a housekeeping key, a page with no such row, a switched-off category) do not;
 * - already today: nothing is written;
 * - a proposal says so, and is dated the day it is approved;
 * - a failure after the content write is a follow-up (`lmr_failed`), never a rollback.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { londonDate } from '../../src/jobs/internal-steps.js';
import { classifyStep, lmrConfigFrom } from '../../src/lmr/index.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, RHEASHIRA, type FactsWorld } from '../facts/world.js';

let w: FactsWorld;
let writer: Client;
let proposer: Client;
const LMR_ROW = 'rhea0013';
const sb = () => w.sidebars;
const lmr = () =>
  sb()
    .rows(RHEASHIRA.page)
    .find((r) => r.key === 'Last Major Revision')!.text;
let mark = 0;
const since = () =>
  sb()
    .requests.slice(mark)
    .map((r) => ({ ...r, path: r.path.replace(/\/$/, '') }));
const lmrWrites = () => since().filter((r) => r.method !== 'GET' && r.path.includes(`/rows/${LMR_ROW}`));

/** As the tree would know it: the page's PROPERTIES with its rows (the planner reads nothing). */
function treeKnows(pageId: string, props: { id: string; rows: string[] }[]) {
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify(
      props.map((p) => ({
        id: p.id,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: p.rows.map((k) => ({ key: k, text: '' })),
      })),
    ),
    PROJECT,
    pageId,
  );
}

const setLmr = (text: string) => {
  const row = sb()
    .pages.get(RHEASHIRA.page)!
    .props[0]!.rows!.find((r) => r.id === LMR_ROW)!;
  row.content = [{ text }];
};

beforeAll(async () => {
  w = await factsWorld();
  writer = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('lmr-proposer', 'propose').token);
  treeKnows(RHEASHIRA.page, [{ id: RHEASHIRA.property, rows: ['Status', 'Last Major Revision'] }]);
  treeKnows(P.miyabi, [{ id: 'kvmiya01', rows: ['Status', 'Notes'] }]);
});
afterAll(async () => w.close());
beforeEach(() => {
  mark = sb().requests.length;
  setLmr('9 November 2026');
});
afterEach(() => {
  vi.useRealTimers();
  w.stack.runtime.projects.setSetting(PROJECT, 'lmrWritePage', null);
});

const append = (client: Client, page: string, text: string) =>
  w.stack.call(client, 'write_page', { page, mode: 'append', markdown: text });

describe('counting edits', () => {
  it('write_page sets the row to today, after the content write, with the rows’ version as If-Match', async () => {
    const r = await append(writer, RHEASHIRA.page, 'A new paragraph about the envoy.');
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(londonDate(Date.now()));
    expect(lmr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const lines = since().map((x) => `${x.method} ${x.path}`);
    const rowsRead = lines.indexOf(`GET /resources/${RHEASHIRA.page}/properties/${RHEASHIRA.property}/rows`);
    expect(rowsRead).toBeGreaterThanOrEqual(0);
    expect(lmrWrites()).toHaveLength(1);
    expect(lmrWrites()[0]!.ifMatch).toBeTruthy();
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(r.body.jobId))!;
    expect(job.status).toBe('succeeded');
    expect(job.result?.followUps).toBeUndefined();
  });

  it('already today: nothing is written', async () => {
    setLmr(londonDate(Date.now()));
    const r = await append(writer, RHEASHIRA.page, 'Another paragraph.');
    expect(r.body.status, r.text).toBe('written');
    expect(lmrWrites()).toEqual([]);
  });

  it('set_facts of a non-housekeeping key chains on its own row write’s version: no extra read', async () => {
    const r = await w.stack.call(writer, 'set_facts', {
      page: RHEASHIRA.page,
      facts: { Scope: 'Moon elf envoy, recalled' },
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(londonDate(Date.now()));
    const rowWrites = since().filter((x) => x.method === 'PATCH');
    expect(rowWrites.map((x) => x.path.split('/').at(-1))).toEqual(['rhea0012', LMR_ROW]);
    // The If-Match of the date's write is the version the Scope write answered.
    expect(rowWrites[1]!.ifMatch).not.toBe(rowWrites[0]!.ifMatch);
    const rowReads = since().filter((x) => x.method === 'GET' && /\/rows$/.test(x.path));
    expect(rowReads).toHaveLength(1); // set_facts' own check in the lock; none for the date
  });

  it('a block edit through lk_api_write counts', async () => {
    const page = w.repo.live(RHEASHIRA.page)!;
    const doc = w.repo.liveDocs(page)[0]!;
    const blocks = await w.stack.call(writer, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: RHEASHIRA.page, documentId: doc.id } },
      detail: 'full',
    });
    const v = String(blocks.body.result?.version ?? '');
    const r = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: RHEASHIRA.page, documentId: doc.id },
        ifMatch: v,
        body: { blocks: [{ id: 'lmrblk01', kind: 'paragraph', content: [{ text: 'Rewritten.' }] }] },
      },
    });
    expect(r.body.status, r.text).toBe('succeeded');
    expect(lmr()).toBe(londonDate(Date.now()));
  });
});

describe('non-counting edits', () => {
  it('a housekeeping key alone (Status) does not set it', async () => {
    const r = await w.stack.call(writer, 'set_facts', {
      page: RHEASHIRA.page,
      facts: { Supersedes: 'Old Rhea' },
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmrWrites()).toEqual([]);
    expect(lmr()).toBe('9 November 2026');
  });

  it('a tag change does not set it', async () => {
    const r = await w.stack.call(writer, 'update_resource', { page: RHEASHIRA.page, tags_add: ['envoy'] });
    expect(r.isError, r.text).toBe(false);
    expect(lmrWrites()).toEqual([]);
  });

  it('a page whose sidebar has no such row is skipped silently: no extra request', async () => {
    const r = await append(writer, P.miyabi, 'A paragraph for Miyabi.');
    expect(r.body.status, r.text).toBe('written');
    expect(since().filter((x) => /\/rows/.test(x.path))).toEqual([]);
  });

  it('a category switched off on the project does not set it', async () => {
    w.stack.runtime.projects.setSetting(PROJECT, 'lmrWritePage', false);
    const r = await append(writer, RHEASHIRA.page, 'Off this time.');
    expect(r.body.status, r.text).toBe('written');
    expect(lmrWrites()).toEqual([]);
  });
});

describe('proposals and failures', () => {
  it('a failure after the content write is a follow-up: the edit stays written, the job succeeds', async () => {
    w.stack.mock.inject((x) => x.method === 'PATCH' && x.path.includes(`/rows/${LMR_ROW}`), {
      kind: 'status',
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    const r = await append(writer, RHEASHIRA.page, 'Written even though the date is not.');
    expect(r.body.status, r.text).toBe('written');
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(r.body.jobId))!;
    expect(job.status).toBe('succeeded');
    expect(job.result?.followUps).toEqual([
      expect.objectContaining({ kind: 'lmr_failed', pageId: RHEASHIRA.page }),
    ]);
    expect(lmr()).toBe('9 November 2026');
    const doc = w.repo.liveDocs(w.repo.live(RHEASHIRA.page)!)[0]!;
    expect(JSON.stringify(w.repo.blocks.get(doc.id))).toContain('Written even though the date is not.');
  });

  // Last in the file: it moves the clock forward (the governor's windows must never see time go backwards).
  it('a proposal says so, and is dated the day it is approved', async () => {
    const r = await append(proposer, RHEASHIRA.page, 'Proposed paragraph.');
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    const pol = w.stack.runtime.policy;
    expect(pol.proposals.get(id)!.summary).toContain('+ Last Major Revision → date of approval');
    expect(lmrWrites()).toEqual([]);
    // Approved three days later: the date is the approval's.
    const later = Date.now() + 3 * 86_400_000;
    vi.useFakeTimers({ toFake: ['Date'], now: later });
    await pol.commands.approve('owner', id);
    for (let i = 0; i < 300 && pol.proposals.get(id)!.state !== 'executed'; i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(pol.proposals.get(id)!.state).toBe('executed');
    expect(lmr()).toBe(londonDate(later));
  });
});

describe('what counts (classification)', () => {
  const at = { path: { resourceId: 'page0001', documentId: 'doc00001' } };
  it('names each category', () => {
    expect(classifyStep('replaceDocumentBlocks', at, { tool: 'write_page' }, 'write_page')!.category).toBe(
      'writePage',
    );
    expect(classifyStep('updateBlock', at, undefined, 'lk_api_write')!.category).toBe('blockEdits');
    expect(
      classifyStep('insertBlock', at, { tool: 'create_timeline_event' }, 'create_timeline_event')!.category,
    ).toBe('chronologyTable');
    expect(
      classifyStep('updateBlock', at, { tool: 'chronology_count_fix' }, 'chronology_propose_fix')!.category,
    ).toBe('chronologyTable');
    expect(classifyStep('replaceDocumentBlocks', at, { tool: 'restore_snapshot' }, undefined)!.category).toBe(
      'restore',
    );
    expect(classifyStep('insertBlock', at, { tool: 'audits.split_paragraph' }, undefined)!.category).toBe(
      'auditSplit',
    );
    expect(
      classifyStep('insertBlock', at, { tool: 'arkona_create_outfit', pack: 'arkona' }, undefined)!.category,
    ).toBe('packTools');
    expect(
      classifyStep('updatePropertyRow', at, { tool: 'set_facts', factKey: 'Scope' }, 'set_facts'),
    ).toMatchObject({ category: 'facts', factKey: 'Scope' });
    expect(classifyStep('updatePropertyRow', at, undefined, 'lk_api_write')).toBeNull();
    expect(classifyStep('updateResource', at, undefined, 'update_resource')!.category).toBe('namesTagsMoves');
    expect(classifyStep('moveResource', at, undefined, 'move_resource')!.category).toBe('namesTagsMoves');
    expect(classifyStep('updateProperty', at, { tool: 'set_facts' }, 'set_facts')!.category).toBe(
      'linkCollections',
    );
    expect(classifyStep('createEvent', at, { tool: 'create_timeline_event' }, undefined)!.category).toBe(
      'timelineMap',
    );
    expect(classifyStep('createFeature', at, undefined, 'create_map_feature')!.category).toBe('timelineMap');
    expect(classifyStep('getDocumentBlocks', at, undefined, 'write_page')).toBeNull();
  });

  it('the defaults: text and facts count; names, links, timelines, maps and the audit split do not', () => {
    const c = lmrConfigFrom({});
    expect(c.categories).toEqual({
      writePage: true,
      blockEdits: true,
      chronologyTable: true,
      restore: true,
      packTools: true,
      facts: true,
      namesTagsMoves: false,
      linkCollections: false,
      timelineMap: false,
      auditSplit: false,
    });
    expect(c.housekeeping).toEqual(['Last Major Revision', 'Reference Type', 'Supersedes', 'Status']);
    expect(lmrConfigFrom({ lmrHousekeepingKeys: 'Status; Notes ;' }).housekeeping).toEqual([
      'Status',
      'Notes',
    ]);
  });
});
