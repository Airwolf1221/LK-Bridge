import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './helpers.js';

/**
 * v2 E3 (ADR 0045): the log flags a `write_page` or `set_facts` that edits existing content without `baseVersion` /
 * `baseFactsVersion` (the definition is in src/toolcalls/flag.ts), decided when the call is recorded and stored in
 * `tool_calls.no_base_version`. Real calls through the real server.
 */

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

const log = () => stack.runtime.toolCalls;

describe('writes without a base version, from real calls', () => {
  it('flags write_page and set_facts with no version, and not those that pass it', async () => {
    const t = stack.newToken('flagger', 'write');
    const c = await stack.connect(t.token);
    const page = 'Asagiri Miyabi';
    await c.callTool({ name: 'write_page', arguments: { page, mode: 'append', markdown: 'x' } });
    await c.callTool({
      name: 'write_page',
      arguments: { page, mode: 'append', markdown: 'x', baseVersion: 'v1' },
    });
    await c.callTool({ name: 'set_facts', arguments: { page, facts: { Scope: 'x' } } });
    await c.callTool({
      name: 'set_facts',
      arguments: { page, facts: { Scope: 'x' }, baseFactsVersion: 'fv2_abc' },
    });
    const rows = log().list({ principalId: t.patId }).rows.reverse();
    expect(rows.map((r) => [r.tool, r.noBaseVersion])).toEqual([
      ['write_page', true],
      ['write_page', false],
      ['set_facts', true],
      ['set_facts', false],
    ]);
    // The version itself never reaches the log.
    expect(JSON.stringify(rows)).not.toContain('fv2_abc');
  });

  it('does not flag a dry run, a call the MCP layer refused, or another tool', async () => {
    const t = stack.newToken('not-flagged', 'write');
    const c = await stack.connect(t.token);
    const page = 'Asagiri Miyabi';
    await c.callTool({
      name: 'write_page',
      arguments: { page, mode: 'append', markdown: 'x', dryRun: true },
    });
    await c.callTool({ name: 'set_facts', arguments: { page, facts: { A: 'b' }, dryRun: true } });
    // Invented arguments and a missing mode: refused by the SDK before the tool ran.
    await c.callTool({ name: 'write_page', arguments: { page, markdown: 'x', madeUp: 1 } });
    await c.callTool({ name: 'set_facts', arguments: { page } }); // nothing to change
    await c.callTool({ name: 'update_resource', arguments: { page, name: 'New name' } });
    await stack.call(c, 'search', { query: 'x' });
    const rows = log().list({ principalId: t.patId }).rows;
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.noBaseVersion)).toEqual([]);
    const refused = rows.find((r) => r.tool === 'write_page' && r.code === 'INVALID_ARGUMENTS');
    expect(refused).toBeDefined();

    const reader = await stack.connect(stack.newToken('read-only-flag', 'read').token);
    await reader.callTool({ name: 'set_facts', arguments: { page, facts: { A: 'b' } } });
    expect(log().list({ profile: 'read-only-flag' }).rows[0]).toMatchObject({
      code: 'READ_ONLY_CONNECTION',
      noBaseVersion: false,
    });
  });

  it('is a cheap filter, and the summary counts the flagged calls among those that match', async () => {
    const t = stack.newToken('filter-flag', 'write');
    const c = await stack.connect(t.token);
    await c.callTool({ name: 'write_page', arguments: { page: 'P', mode: 'replace', markdown: 'x' } });
    await c.callTool({
      name: 'write_page',
      arguments: { page: 'P', mode: 'replace', markdown: 'x', baseVersion: 'v' },
    });
    await stack.call(c, 'list_projects', {});
    const flagged = log().list({ principalId: t.patId, noBaseVersion: true });
    expect(flagged.rows.map((r) => r.tool)).toEqual(['write_page']);
    expect(log().summary({ principalId: t.patId })).toEqual({ matching: 3, noBaseVersion: 1 });
    expect(log().summary({ principalId: t.patId, tool: 'list_projects' })).toEqual({
      matching: 1,
      noBaseVersion: 0,
    });
    // The filter on the flag is ignored by the summary (it is the count the page shows next to it).
    expect(log().summary({ principalId: t.patId, noBaseVersion: true })).toEqual({
      matching: 3,
      noBaseVersion: 1,
    });
  });

  it('shows `live` on a call (a boolean is kept), so the evaluation table can say `get_resource (live: false)`', async () => {
    const c = await stack.connect(stack.newToken('live-arg', 'write').token);
    await c.callTool({ name: 'get_resource', arguments: { resource: 'Asagiri Miyabi', live: false } });
    const row = log().list({ profile: 'live-arg' }).rows[0]!;
    expect(row.args).toContainEqual({ name: 'live', type: 'boolean', value: false });
  });
});
