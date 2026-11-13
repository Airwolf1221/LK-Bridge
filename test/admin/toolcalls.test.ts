/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies in tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from './helpers.js';

/** v2 E3 (ADR 0045): the Tool calls page's API is the owner's alone and the log is not an agent tool. */

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack();
  const log = stack.runtime.toolCalls;
  const caller = { principalId: 'pat_example', profile: 'test-profile', scope: 'write' };
  log.begin(
    'search',
    { query: 'foxian', secretLooking: 'hunter2-hunter2' },
    caller,
  )({
    result: {
      content: [{ type: 'text', text: '{"project":"test","status":"succeeded"}\nbudget (test): x' }],
    },
  });
  log.begin(
    'write_page',
    { page: 'Asagiri Miyabi', markdown: 'plot twist' },
    caller,
  )({
    result: {
      isError: true,
      content: [
        { type: 'text', text: '{"error":{"code":"VERSION_CONFLICT","message":"m"}}\nbudget (test): x' },
      ],
    },
  });
});
afterAll(() => stack.close());

describe('GET /api/admin/tool-calls', () => {
  it('lists calls newest first, with filters, facets and the retention', async () => {
    const r = await stack.get('/api/admin/tool-calls');
    expect(r.status).toBe(200);
    expect(r.json.calls.map((c: any) => c.tool)).toEqual(['write_page', 'search']);
    expect(r.json.settings).toMatchObject({ retentionDays: 7, recording: true });
    expect(r.json.facets.tools).toEqual(['search', 'write_page']);
    expect(JSON.stringify(r.json)).not.toMatch(/hunter2|plot twist/);
    const err = await stack.get('/api/admin/tool-calls?outcome=error');
    expect(err.json.calls).toHaveLength(1);
    expect(err.json.calls[0]).toMatchObject({ tool: 'write_page', code: 'VERSION_CONFLICT' });
    const one = await stack.get('/api/admin/tool-calls?tool=search&sinceMinutes=60');
    expect(one.json.calls).toHaveLength(1);
    expect((await stack.get('/api/admin/tool-calls?outcome=nonsense')).status).toBe(400);
  });

  it('sets the retention, audited, and refuses a bad value or a request with no confirmation', async () => {
    const r = await stack.put('/api/admin/tool-calls/retention', { days: 3, confirm: true });
    expect(r.status).toBe(200);
    expect(r.json.settings.retentionDays).toBe(3);
    expect(stack.audit('policy.set_toolcalls_retention')).toHaveLength(1);
    expect((await stack.put('/api/admin/tool-calls/retention', { days: 3 })).status).toBe(400);
    expect((await stack.put('/api/admin/tool-calls/retention', { days: 500, confirm: true })).status).toBe(
      400,
    );
    await stack.put('/api/admin/tool-calls/retention', { days: 7, confirm: true });
  });

  it('is registered, and no MCP tool exposes the log to an agent', () => {
    const urls = stack.routes.map((r) => `${r.method} ${r.url}`);
    expect(urls).toContain('GET /api/admin/tool-calls');
    expect(urls).toContain('PUT /api/admin/tool-calls/retention');
    expect(stack.runtime.tools.map((t) => t.name).filter((n) => /tool_?calls?/i.test(n))).toEqual([]);
  });
});
