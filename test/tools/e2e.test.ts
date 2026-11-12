/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { LkModel } from '../jobs/lk-model.js';
import { PROJECT, startStack, type Stack } from './helpers.js';
import { systemClock } from '../../src/lk/index.js';

let stack: Stack;
let client: Client;
const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});

beforeAll(async () => {
  stack = await startStack({ respond: model.respond });
  client = await stack.connect();
});
afterAll(() => stack.close());

describe('the MCP surface with the official client', () => {
  it('lists the tools with access-appropriate annotations and the agent instructions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'bridge_budget',
        'bridge_errors_recent',
        'bridge_estimate',
        'bridge_info',
        'bridge_job_cancel',
        'bridge_job_status',
        'bridge_job_wait',
        'bridge_journal_lookup',
        'bridge_proposal_status',
        'bridge_proposals_mine',
        'bridge_result_page',
        // v2 B2: Discover, Read and the guides
        'browse_asset_tree',
        'browse_repository_tree',
        'get_bridge_guide',
        'get_markdown_guide',
        'get_resource',
        'get_resources',
        'list_assets',
        'list_calendars',
        'list_projects', // v2 A1
        'list_tags',
        'list_templates',
        'lk_api_batch',
        // lk_api_describe_operation, lk_api_list_operations and lk_api_paginate_all are low-level tools: hidden for a
        // profile without showLowLevelTools (v2 B2).
        'lk_api_read',
        'lk_api_write',
        'lk_upload_image',
        'read_document',
        'search',
        'set_facts', // v2 C2a
        'write_page', // v2 C1
        // v2 C2b
        'create_bare_resource',
        'create_character',
        'create_document',
        'create_index',
        'create_many_resources',
        'create_resource',
        'delete_document',
        'delete_resource',
        'move_resource',
        'restore_resource',
        'update_document',
        'update_resource',
        // v2 C2c
        'archive_page',
        'move_to_working',
        'promote_page',
        'unarchive_page',
        // v2 D1: the calendar and the timelines
        'calendar_date',
        'create_timeline_event',
        'update_timeline_event',
        'delete_timeline_event',
        'sync_timeline_event',
        'create_timeline_lane',
        // v2 D2: the map-feature tools
        'create_map_feature',
        'update_map_feature',
        'delete_map_feature',
      ].sort(),
    );
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.lk_api_read!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(by.lk_api_write!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(by.lk_upload_image!.annotations?.readOnlyHint).toBe(false);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBeTypeOf('boolean');
      expect(t.description, t.name).toMatch(/Cost|cost|Costs/);
    }
    for (const n of [
      'list_projects',
      'bridge_info',
      'bridge_budget',
      'bridge_estimate',
      'bridge_job_status',
      'bridge_job_wait',
      'bridge_errors_recent',
      'bridge_journal_lookup',
      'bridge_result_page',
      'browse_repository_tree',
      'browse_asset_tree',
      'search',
      'get_resource',
      'get_resources',
      'list_tags',
      'list_templates',
      'list_calendars',
      'list_assets',
      'read_document',
      'get_markdown_guide',
      'get_bridge_guide',
    ]) {
      expect(by[n]!.annotations?.readOnlyHint, n).toBe(true);
    }
    for (const n of ['bridge_job_cancel', 'lk_api_batch', 'lk_api_write', 'lk_upload_image']) {
      expect(by[n]!.annotations?.readOnlyHint, n).toBe(false);
    }
    expect(client.getInstructions()).toMatch(/bridge_estimate/);
    expect(client.getInstructions()).toMatch(/waiting_budget/);
  });

  it('reads through the engine, summarised, with the budget footer', async () => {
    const r = await stack.call(client, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: 'res1', documentId: 'd_res1' } },
    });
    expect(r.isError).toBe(false);
    expect(r.footer).toMatch(/^budget \(test\): writes /); // v2 A1: the footer names the project
    expect(r.body.status).toBe('succeeded');
    expect(r.body.result).toMatchObject({ blockCount: 1, version: 'v1' });
    expect(r.body.result.outline[0]).toMatchObject({ kind: 'paragraph', text: 'Hello' });
    const full = await stack.call(client, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: 'res1', documentId: 'd_res1' } },
      detail: 'full',
    });
    expect(full.body.result.blocks[0].content[0].text).toBe('Hello');
  });

  it('writes with a version and records the MCP tool and principal in the job origin', async () => {
    const w = await stack.call(client, 'lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: {
        path: { resourceId: 'res1', documentId: 'd_res1' },
        ifMatch: 'v1',
        body: { blocks: [{ kind: 'paragraph', content: [{ text: 'Changed' }] }] },
      },
    });
    expect(w.isError, w.text).toBe(false);
    expect(w.body.status).toBe('succeeded');
    const job = stack.runtime.engine.queries.getJob(PROJECT, w.body.jobId)!;
    expect(job.origin.tool).toBe('lk_api_write');
    expect(job.origin.kind).toBe('mcp');
    expect(job.principalId).toMatch(/^pat_/);
    expect(job.profile).toBe('tools-test');
    // A stale version is refused with the current one.
    const stale = await stack.call(client, 'lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: { path: { resourceId: 'res1', documentId: 'd_res1' }, ifMatch: 'v1', body: { blocks: [] } },
    });
    expect(stale.isError).toBe(true);
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 'v2' });
  });

  it('runs a batch job and waits for it', async () => {
    const b = await stack.call(client, 'lk_api_batch', {
      calls: [
        { operationId: 'createResource', params: { body: { name: 'A' } } },
        { operationId: 'createResource', params: { body: { name: 'B' } } },
      ],
    });
    expect(b.isError, b.text).toBe(false);
    expect(b.body).toMatchObject({ status: 'queued', steps: 2 });
    expect(b.body.jobId).toBeTypeOf('string');
    const w = await stack.call(client, 'bridge_job_wait', { jobId: b.body.jobId, seconds: 10 });
    expect(w.body).toMatchObject({ status: 'succeeded', done: true, progress: { stepsDone: 2 } });
    expect(w.footer).toMatch(/^budget \(test\):/);
  });

  it('paginates every page into a handle and pages it', async () => {
    for (let i = 0; i < 7; i++) model.seedResource(`pg${i}`, { name: `Page ${i}` });
    const p = await stack.call(client, 'lk_api_paginate_all', {
      operationId: 'listResources',
      params: { query: { limit: 3 } },
    });
    expect(p.isError, p.text).toBe(false);
    const handle = p.body.handle as string;
    expect(handle).toBeTypeOf('string');
    await stack.call(client, 'bridge_job_wait', { jobId: p.body.jobId });
    const page = await stack.call(client, 'bridge_result_page', { handle, offset: 0, limit: 4 });
    expect(page.body).toMatchObject({ kind: 'items', offset: 0, count: 4, nextOffset: 4 });
    expect(page.body.total).toBeGreaterThanOrEqual(8);
    const rest = await stack.call(client, 'bridge_result_page', { handle, offset: 4, limit: 500 });
    expect(rest.body.nextOffset).toBeNull();
    expect(rest.body.items[0]).toHaveProperty('id');
  });

  it('returns a handle for an oversized result and pages it by characters', async () => {
    const big = Array.from({ length: 900 }, (_, i) => ({
      kind: 'paragraph',
      content: [{ text: `Paragraph number ${i} with some padding text to make it long enough. `.repeat(2) }],
    }));
    model.seedResource('bigres', { name: 'Big', blocks: big });
    const r = await stack.call(client, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: 'bigres', documentId: 'd_bigres' } },
      detail: 'full',
    });
    expect(r.isError).toBe(false);
    expect(r.body.status).toBe('stored');
    expect(r.text.length).toBeLessThan(20_000);
    const handle = r.body.handle as string;
    const first = await stack.call(client, 'bridge_result_page', { handle });
    expect(first.body.kind).toBe('result');
    expect(first.body.text.length).toBeLessThan(31_000);
    expect(first.body.nextOffset).toBeGreaterThan(0);
    let text = first.body.text as string;
    let next = first.body.nextOffset as number | null;
    while (next !== null) {
      const more = await stack.call(client, 'bridge_result_page', { handle, offset: next });
      text += more.body.text as string;
      next = more.body.nextOffset as number | null;
    }
    expect(JSON.parse(text).blocks).toHaveLength(900);
    // The default (summary) answer for the same document stays small and inline.
    const sum = await stack.call(client, 'lk_api_read', {
      operationId: 'getDocumentBlocks',
      params: { path: { resourceId: 'bigres', documentId: 'd_bigres' } },
    });
    expect(sum.body.status).toBe('succeeded');
    expect(sum.body.result.blockCount).toBe(900);
    expect(sum.text.length).toBeLessThan(20_000);
  });

  it('bridge_info, bridge_budget and bridge_estimate answer without writing', async () => {
    const info = await stack.call(client, 'bridge_info');
    expect(info.body).toMatchObject({
      bridge: 'LK-Bridge',
      version: '0.0.0-test',
      project: 'test',
      projectInfo: { id: 'proj_mock', name: 'test', default: true, available: true },
      profile: 'tools-test',
      scope: 'write',
      canWriteAs: 'direct',
    });
    expect(info.body.writes.canWrite).toBe(true);
    expect(info.body.caller.kind).toBe('pat');
    const budget = await stack.call(client, 'bridge_budget');
    expect((budget.body.tiers as { tier: string }[]).map((t) => t.tier)).toContain('write-min');
    const est = await stack.call(client, 'bridge_estimate', { reads: 3500, writes: 800 });
    expect(est.body).toHaveProperty('tightestTier');
    expect(est.body.fitsToday).toBe(true);
  });
});
