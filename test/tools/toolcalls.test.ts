/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON rows in tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outcomeOf, summariseArgs } from '../../src/toolcalls/index.js';
import { startStack, type Stack } from './helpers.js';

/** v2 E3 (ADR 0045): the tool-call log records names and sizes of every call, and never content or secrets. */

describe('summariseArgs', () => {
  it('keeps names and sizes, and values only for booleans, numbers and short reference strings', () => {
    const out = summariseArgs({
      page: 'Asagiri Miyabi',
      mode: 'append_to_section',
      section: 'Biography',
      markdown: 'A secret plot twist. '.repeat(50),
      baseVersion: 'v12',
      dryRun: true,
      limit: 5,
      facts: { Scope: 'x', Sister: { markdown: 'y' } },
      resources: ['a', 'b', 'c'],
      data_base64: 'AAAA'.repeat(1000),
      upload_id: 'upl_abc',
      url: 'https://example.test/x?token=abc',
      destination: { for_page: 'Asagiri Miyabi' },
      query: 'q'.repeat(200),
      gone: undefined,
      nothing: null,
    });
    const by = Object.fromEntries(out.map((a) => [a.name, a]));
    expect(by.page).toMatchObject({ type: 'string', value: 'Asagiri Miyabi' });
    expect(by.mode).toMatchObject({ value: 'append_to_section' });
    expect(by.section).toMatchObject({ value: 'Biography' });
    expect(by.dryRun).toMatchObject({ type: 'boolean', value: true });
    expect(by.limit).toMatchObject({ type: 'number', value: 5 });
    expect(by.markdown).toEqual({ name: 'markdown', type: 'string', size: 1050 });
    expect(by.baseVersion).toEqual({ name: 'baseVersion', type: 'string', size: 3 });
    expect(by.facts).toEqual({ name: 'facts', type: 'object', size: 2 });
    expect(by.resources).toEqual({ name: 'resources', type: 'array', size: 3 });
    expect(by.data_base64?.value).toBeUndefined();
    expect(by.upload_id?.value).toBeUndefined();
    expect(by.url?.value).toBeUndefined();
    expect(by.destination).toEqual({ name: 'destination', type: 'object', size: 1 });
    expect(by.query?.value).toBeUndefined(); // over 80 characters: size only
    expect(by.gone).toBeUndefined();
    expect(by.nothing).toEqual({ name: 'nothing', type: 'null' });
    const text = JSON.stringify(out);
    for (const secret of ['plot twist', 'AAAA', 'upl_abc', 'token=abc', 'v12'])
      expect(text).not.toContain(secret);
  });
  it('is empty for no arguments', () => {
    expect(summariseArgs(undefined)).toEqual([]);
    expect(summariseArgs([1, 2])).toEqual([]);
  });
});

describe('outcomeOf', () => {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
  it('reads the status, the error code and the ids from the tool layer’s JSON', () => {
    expect(outcomeOf(text('{"project":"test","status":"succeeded"}\nbudget (test): …'))).toMatchObject({
      outcome: 'success',
      project: 'test',
    });
    expect(
      outcomeOf(
        text('{"project":"test","status":"proposal_captured","proposalId":"prop_1"}\nbudget (test): x'),
      ),
    ).toMatchObject({ outcome: 'proposal', proposalId: 'prop_1' });
    expect(outcomeOf(text('{"project":"test","status":"waiting_budget","jobId":"job_1"}'))).toMatchObject({
      outcome: 'waiting',
      jobId: 'job_1',
    });
    expect(outcomeOf(text('{"status":"queued","jobId":"j"}'))).toMatchObject({ outcome: 'queued' });
    expect(
      outcomeOf(
        text('{"project":"p","error":{"code":"VERSION_CONFLICT","message":"m"}}\nbudget (p): x', true),
      ),
    ).toMatchObject({ outcome: 'error', code: 'VERSION_CONFLICT' });
  });
  it('names the SDK’s and the wrapper’s plain-text refusals', () => {
    expect(outcomeOf(text('Input validation error: Invalid arguments for tool search: x', true)).code).toBe(
      'INVALID_ARGUMENTS',
    );
    expect(
      outcomeOf(text('write_page is not available: this connection is read-only. The owner…', true)).code,
    ).toBe('READ_ONLY_CONNECTION');
    expect(outcomeOf(text('something odd', true)).code).toBe('ERROR');
  });
});

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

const log = () => stack.runtime.toolCalls;

describe('the log of real calls', () => {
  it('records a call with who made it, its arguments as names and sizes, the outcome, time and budget', async () => {
    const t = stack.newToken('logged-writer', 'write');
    const c = await stack.connect(t.token);
    const before = log().list().rows[0]?.id ?? 0;
    const r = await stack.call(c, 'list_projects', {});
    expect(r.isError).toBe(false);
    const { rows } = log().list({ profile: 'logged-writer' });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeGreaterThan(before);
    expect(row).toMatchObject({
      tool: 'list_projects',
      outcome: 'success',
      scope: 'write',
      profile: 'logged-writer',
      principalId: t.patId,
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.resultChars).toBeGreaterThan(0);
  });

  it('records an assistant inventing arguments, which the SDK refuses before the tool runs', async () => {
    const t = stack.newToken('inventor', 'write');
    const c = await stack.connect(t.token);
    const res = await c.callTool({
      name: 'search',
      arguments: { query: 'foxian', madeUpArgument: 'x'.repeat(10), limit: 'many' },
    });
    expect(res.isError).toBe(true);
    const row = log().list({ profile: 'inventor' }).rows[0]!;
    expect(row).toMatchObject({ tool: 'search', outcome: 'error', code: 'INVALID_ARGUMENTS' });
    expect(row.args.map((a) => a.name).sort()).toEqual(['limit', 'madeUpArgument', 'query']);
  });

  it('records a call to a tool that does not exist', async () => {
    const t = stack.newToken('guesser', 'write');
    const c = await stack.connect(t.token);
    await c.callTool({ name: 'append_to_page', arguments: {} }).catch(() => undefined);
    const row = log().list({ profile: 'guesser' }).rows[0]!;
    expect(row).toMatchObject({ tool: 'append_to_page', outcome: 'error', code: 'TOOL_NOT_FOUND' });
  });

  it('records a write refused for a read-only connection, and a proposal captured at propose scope', async () => {
    const reader = await stack.connect(stack.newToken('reader-x', 'read').token);
    await reader.callTool({ name: 'set_facts', arguments: { page: 'Nobody', facts: { A: 'b' } } });
    expect(log().list({ profile: 'reader-x' }).rows[0]).toMatchObject({
      tool: 'set_facts',
      outcome: 'error',
      code: 'READ_ONLY_CONNECTION',
    });
    const proposer = await stack.connect(stack.newToken('proposer-x', 'propose').token);
    const res = await stack.call(proposer, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'r1' }, body: { name: 'x' } },
    });
    expect(res.body.status).toBe('proposal_captured');
    const row = log().list({ profile: 'proposer-x' }).rows[0]!;
    expect(row).toMatchObject({ outcome: 'proposal', code: 'proposal_captured' });
    expect(row.proposalId).toBe(res.body.proposalId);
    // The body of the write never reaches the log: only the names of the arguments and their sizes.
    expect(JSON.stringify(row.args)).not.toContain('"x"');
  });

  it('filters by tool, outcome, connection and time, and pages', async () => {
    const t = stack.newToken('filter-me', 'write');
    const c = await stack.connect(t.token);
    for (let i = 0; i < 3; i++) await stack.call(c, 'list_projects', {});
    await stack.call(c, 'bridge_budget', {});
    expect(log().list({ principalId: t.patId, tool: 'list_projects' }).rows).toHaveLength(3);
    expect(log().list({ principalId: t.patId, outcome: 'success' }).rows).toHaveLength(4);
    expect(log().list({ principalId: t.patId, outcome: 'not_success' }).rows).toHaveLength(0);
    expect(log().list({ principalId: t.patId, since: Date.now() + 60_000 }).rows).toHaveLength(0);
    const first = log().list({ principalId: t.patId, limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const next = log().list({ principalId: t.patId, limit: 3, before: first.rows.at(-1)!.id });
    expect(next.rows).toHaveLength(1);
    expect(log().facets().tools).toContain('bridge_budget');
  });

  it('measures the request budget a call used (a live read counts)', async () => {
    const c = await stack.connect(stack.newToken('budgeted', 'write').token);
    const res = await stack.call(c, 'lk_api_read', { operationId: 'listTags', params: { path: {} } });
    expect(res.body.status ?? res.body.error?.code).toBeDefined();
    const row = log().list({ profile: 'budgeted' }).rows[0]!;
    expect(row.budgetRequests).not.toBeNull();
    expect(row.budgetRequests!).toBeGreaterThanOrEqual(0);
  });
});

describe('retention', () => {
  it('keeps 7 days by default, removes older rows, and 0 switches recording off', async () => {
    expect(log().retentionDays()).toBe(7);
    const db = stack.db;
    db.prepare(
      `INSERT INTO tool_calls (at, tool, args, outcome, duration_ms) VALUES (?, 'old_tool', '[]', 'success', 1)`,
    ).run(Date.now() - 8 * 86_400_000);
    db.prepare(
      `INSERT INTO tool_calls (at, tool, args, outcome, duration_ms) VALUES (?, 'recent_tool', '[]', 'success', 1)`,
    ).run(Date.now() - 6 * 86_400_000);
    expect(log().prune()).toBe(1);
    expect(log().list({ tool: 'old_tool' }).rows).toHaveLength(0);
    expect(log().list({ tool: 'recent_tool' }).rows).toHaveLength(1);

    const c = await stack.connect(stack.newToken('off-switch', 'write').token);
    log().setRetentionDays(0);
    await stack.call(c, 'list_projects', {});
    expect(log().list().rows).toHaveLength(0); // 0 days: everything removed, nothing recorded
    expect(stack.policy.store.listAudit({ action: 'policy.set_toolcalls_retention' })).toHaveLength(1);
    log().setRetentionDays(14);
    await stack.call(c, 'list_projects', {});
    expect(log().list({ profile: 'off-switch' }).rows).toHaveLength(1);
    expect(() => log().setRetentionDays(1000)).toThrow(RangeError);
    log().setRetentionDays(7);
  });
});
