/**
 * RV1-3: the tool-call log (ADR 0045: "names and sizes only, never content or secrets") stores the tool NAME a client
 * sends verbatim, with no length limit and no check against the bridge's own names (src/mcp/server.ts
 * observeToolCalls passes `params.name` straight to `observer.begin`; src/toolcalls/index.ts inserts it). A call to a
 * tool that does not exist is recorded (TOOL_NOT_FOUND), so whatever a client puts in the name (text it meant as an
 * argument, a pasted token, or megabytes of filler) is kept for the retention period, listed by GET /tool-calls,
 * offered as a filter value by `facets()`, and copied into Evaluation results, which outlive the log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '../tools/helpers.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

describe('RV1-3: the name of an unknown tool', () => {
  it('is not stored verbatim: no content, no secret, and bounded in size', async () => {
    const t = stack.newToken('rv1-namer', 'write');
    const c = await stack.connect(t.token);
    const secret = 'sk-ant-api03-RV1-NOT-A-REAL-KEY-0123456789';
    const content = 'Mehrana is secretly the heir of the Qishen throne; reveal it only in book three. ';
    const name = `write_page ${content}${secret} ${'x'.repeat(200_000)}`;
    await c.callTool({ name, arguments: {} }).catch(() => undefined);
    const row = stack.runtime.toolCalls.list({ profile: 'rv1-namer' }).rows[0];
    expect(row?.code).toBe('TOOL_NOT_FOUND');
    const stored = String(row?.tool);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('heir of the Qishen');
    expect(stored.length).toBeLessThanOrEqual(64);
    expect(stack.runtime.toolCalls.facets().tools.some((x) => x.includes(secret))).toBe(false);
  });
});
