/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON replies in tests */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from './helpers.js';

/**
 * v2 E3 (ADR 0045): the Evaluation helper's API and the "write without a base version" filter are the owner's alone:
 * behind the admin session guard like every route (a bearer token does nothing, a missing CSRF token is refused), and no
 * MCP tool lists or names the log or the evaluation.
 */

let stack: AdminStack;
let chatgptId: string;
let claudeId: string;
let patToken: string;

/** Records a call in the tool-call log the way the MCP layer does. */
const record = (
  principalId: string,
  tool: string,
  args: Record<string, unknown>,
  result: { isError?: boolean; text?: string } = {},
) =>
  stack.runtime.toolCalls.begin(tool, args, { principalId, profile: 'p', scope: 'write' })({
    result: {
      ...(result.isError ? { isError: true } : {}),
      content: [
        { type: 'text', text: result.text ?? '{"project":"test","status":"succeeded"}\nbudget (test): x' },
      ],
    },
  });

beforeAll(async () => {
  stack = await startAdminStack();
  const mk = (name: string) => {
    const profile = stack.policy.commands.createProfile('owner', {
      label: name,
      kind: 'other',
      scope: 'write',
    });
    return stack.services.pats.create({ name, profileId: profile.id });
  };
  const chatgpt = mk('ChatGPT');
  const claude = mk('Claude');
  chatgptId = chatgpt.pat.id;
  claudeId = claude.pat.id;
  patToken = claude.token;
});
afterAll(() => stack.close());

const evaluationRoutes = () =>
  stack.routes.filter(
    (r) => r.url.startsWith('/api/admin/evaluation') || r.url.startsWith('/api/admin/tool-calls'),
  );

describe('owner only', () => {
  it('registers the documented routes', () => {
    const urls = evaluationRoutes().map((r) => `${r.method} ${r.url}`);
    for (const expected of [
      'GET /api/admin/evaluation/scenarios',
      'GET /api/admin/evaluation/connections',
      'GET /api/admin/evaluation/runs',
      'POST /api/admin/evaluation/runs',
      'GET /api/admin/evaluation/runs/:id',
      'POST /api/admin/evaluation/runs/:id/delete',
      'POST /api/admin/evaluation/runs/:id/finish',
      'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/start',
      'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/done',
      'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/reset',
      'PUT /api/admin/evaluation/runs/:id/scenarios/:scenario/grade',
      'GET /api/admin/evaluation/runs/:id/table',
      'GET /api/admin/evaluation/compare',
    ])
      expect(urls, expected).toContain(expected);
  });

  const concrete = (url: string) => url.replace(':id', 'x').replace(':scenario', '1');

  it('answers 401 to a request with no session, and to a bearer token (a personal access token) that works at /mcp', async () => {
    for (const r of evaluationRoutes()) {
      const bare = await stack.call(r.method, concrete(r.url), { cookie: null, csrf: null, origin: null });
      expect(bare.status, `${r.method} ${r.url}`).toBe(401);
      expect(bare.headers.get('www-authenticate')).toBeNull();
      const bearer = await stack.call(r.method, concrete(r.url), {
        cookie: null,
        authorization: `Bearer ${patToken}`,
      });
      expect(bearer.status, `bearer ${r.method} ${r.url}`).toBe(401);
      expect(bearer.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('refuses a state-changing request without the CSRF token or from a foreign Origin, and changes nothing', async () => {
    const before = (await stack.get('/api/admin/evaluation/runs')).json.runs.length;
    for (const r of evaluationRoutes().filter((x) => x.method !== 'GET')) {
      const noCsrf = await stack.call(r.method, concrete(r.url), { csrf: null, body: {} });
      expect(noCsrf.status, `${r.method} ${r.url}`).toBe(403);
      expect(noCsrf.json.error.code).toBe('BAD_CSRF');
      const foreign = await stack.call(r.method, concrete(r.url), {
        origin: 'https://evil.example',
        body: {},
      });
      expect(foreign.status).toBe(403);
      expect(foreign.json.error.code).toBe('BAD_ORIGIN');
    }
    expect((await stack.get('/api/admin/evaluation/runs')).json.runs).toHaveLength(before);
  });

  it('is not an agent tool: no MCP tool, description or instruction names the log or the evaluation', () => {
    const tools = stack.runtime.tools;
    expect(tools.map((t) => t.name).filter((n) => /tool_?calls?|evaluat/i.test(n))).toEqual([]);
    const text = [...tools.map((t) => t.description), stack.runtime.instructions].join('\n');
    expect(text).not.toMatch(
      /tool[- ]calls? (log|page)|evaluation (helper|panel|run)|\/evaluation\b|scenarios\.json/i,
    );
    // The guides agents read do not mention them either.
    for (const file of ['bridge-guide.md', 'markdown.md']) {
      const guide = readFileSync(new URL(`../../docs/${file}`, import.meta.url), 'utf8');
      expect(guide, file).not.toMatch(/tool[- ]calls? (log|page)|evaluation (helper|panel)|scenarios\.json/i);
    }
  });
});

describe('the Evaluation API', () => {
  it('serves the scenarios with the preamble and what to copy', async () => {
    const r = await stack.get('/api/admin/evaluation/scenarios');
    expect(r.status).toBe(200);
    expect(r.json.scenarios).toHaveLength(30);
    expect(r.json.coreIds).toHaveLength(17);
    expect(r.json.scenarios[0].copy[0]).toBe(`${r.json.preamble}\n\n${r.json.scenarios[0].prompts[0]}`);
  });

  it('lists the connections with what the classifier made of each, and which it recognises for an assistant', async () => {
    const r = await stack.get('/api/admin/evaluation/connections?assistant=chatgpt');
    expect(r.status).toBe(200);
    expect(r.json.connections.find((c: any) => c.id === chatgptId)).toMatchObject({ assistant: 'chatgpt' });
    expect(r.json.connections.find((c: any) => c.id === claudeId)).toMatchObject({ assistant: 'claude' });
    expect(r.json.recognised).toEqual([chatgptId]);
    expect((await stack.get('/api/admin/evaluation/connections?assistant=gemini')).status).toBe(400);
  });

  it('runs a scenario end to end: create, start, calls from two assistants, done, grade, table, finish, compare, delete', async () => {
    const created = await stack.post('/api/admin/evaluation/runs', { assistant: 'claude', set: 'core' });
    expect(created.status).toBe(200);
    const run = created.json.run;
    expect(run).toMatchObject({
      assistant: 'claude',
      set: 'core',
      status: 'in_progress',
      bridgeVersion: '0.0.0-test',
    });
    const base = `/api/admin/evaluation/runs/${run.id}`;

    record(claudeId, 'list_projects', {}); // before Start
    const started = await stack.post(`${base}/scenarios/1/start`, {});
    expect(started.status).toBe(200);
    expect(started.json.run.results[0]).toMatchObject({
      scenarioId: 1,
      state: 'recording',
      principalIds: [claudeId],
    });
    expect(started.json.principals[claudeId]).toMatchObject({ name: 'Claude' });
    record(chatgptId, 'search', { query: 'a' });
    record(claudeId, 'search', { query: 'Miyab' });
    record(claudeId, 'get_resource', { resource: 'Miyabi', live: false });
    record(chatgptId, 'bridge_budget', {});
    const done = await stack.post(`${base}/scenarios/1/done`, {});
    expect(done.status).toBe(200);
    record(claudeId, 'search', { query: 'after' });
    const r1 = (await stack.get(base)).json.run.results[0];
    expect(r1.calls.map((c: any) => c.tool)).toEqual(['search', 'get_resource']);
    expect(r1.autoGrade).toMatchObject({ hint: 'looks_right' });
    expect(r1.ownerGrade).toBeNull();

    const graded = await stack.put(`${base}/scenarios/1/grade`, { grade: 'right', note: 'Clean | tidy' });
    expect(graded.json.run.results[0]).toMatchObject({ ownerGrade: 'right', note: 'Clean | tidy' });
    expect((await stack.put(`${base}/scenarios/1/grade`, { grade: 'excellent' })).status).toBe(400);
    expect((await stack.put(`${base}/scenarios/4/grade`, { grade: 'right' })).status).toBe(409);

    const table = await stack.get(`${base}/table`);
    expect(table.json.markdown.split('\n')[2]).toBe(
      '| 1 | Partial name | Claude | search, get_resource (live: false) | Right | Clean \\| tidy |',
    );

    expect((await stack.post(`${base}/finish`, {})).json.run).toMatchObject({ status: 'finished' });
    expect((await stack.post(`${base}/scenarios/4/start`, {})).status).toBe(409);

    const second = (await stack.post('/api/admin/evaluation/runs', { assistant: 'claude', set: 'core' })).json
      .run;
    await stack.post(`/api/admin/evaluation/runs/${second.id}/scenarios/1/start`, {});
    record(claudeId, 'search', { query: 'Miyab' });
    await stack.post(`/api/admin/evaluation/runs/${second.id}/scenarios/1/done`, {});
    const cmp = await stack.get(`/api/admin/evaluation/compare?a=${run.id}&b=${second.id}`);
    expect(cmp.status).toBe(200);
    expect(cmp.json.comparison.scenarios[0]).toMatchObject({
      scenarioId: 1,
      callsA: 2,
      callsB: 1,
      toolsRemoved: [{ tool: 'get_resource', from: 1, to: 0 }],
    });
    expect((await stack.get('/api/admin/evaluation/compare?a=evr_none&b=evr_none2')).status).toBe(404);
    expect((await stack.get('/api/admin/evaluation/compare?a=only')).status).toBe(400);

    // Delete needs the confirmation, removes the run, and is audited.
    expect((await stack.post(`${base}/delete`, {})).status).toBe(400);
    const del = await stack.post(`${base}/delete`, { confirm: true });
    expect(del.status).toBe(200);
    expect((await stack.get(base)).status).toBe(404);
    expect(stack.audit('evaluation.delete_run')).toHaveLength(1);
    expect(stack.audit('evaluation.delete_run')[0]).toMatchObject({ target: run.id });
    const list = await stack.get('/api/admin/evaluation/runs');
    expect(list.json).toMatchObject({ recording: true, retentionDays: 7 });
    expect(list.json.runs.map((x: any) => x.id)).toContain(second.id);
    expect(list.json.runs.map((x: any) => x.id)).not.toContain(run.id);
  });

  it('refuses to start when recording is off, with a clear message', async () => {
    const run = (await stack.post('/api/admin/evaluation/runs', { assistant: 'chatgpt', set: 'all' })).json
      .run;
    expect((await stack.put('/api/admin/tool-calls/retention', { days: 0, confirm: true })).status).toBe(200);
    const r = await stack.post(`/api/admin/evaluation/runs/${run.id}/scenarios/1/start`, {});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('RECORDING_OFF');
    expect(r.json.error.message).toMatch(/switched off/);
    expect((await stack.get('/api/admin/evaluation/runs')).json.recording).toBe(false);
    await stack.put('/api/admin/tool-calls/retention', { days: 7, confirm: true });
  });

  it('answers a bad request with 400 and an unknown run with 404', async () => {
    expect(
      (await stack.post('/api/admin/evaluation/runs', { assistant: 'gemini', set: 'core' })).status,
    ).toBe(400);
    expect(
      (await stack.post('/api/admin/evaluation/runs', { assistant: 'claude', set: 'some' })).status,
    ).toBe(400);
    expect(
      (
        await stack.post('/api/admin/evaluation/runs', {
          assistant: 'claude',
          set: 'core',
          principalIds: ['pat_nope'],
        })
      ).status,
    ).toBe(400);
    expect((await stack.get('/api/admin/evaluation/runs/evr_missing')).status).toBe(404);
    expect((await stack.post('/api/admin/evaluation/runs/evr_missing/scenarios/1/start', {})).status).toBe(
      404,
    );
  });
});

describe('the Tool calls API: writes without a base version', () => {
  it('filters on it, flags each row, and counts the flagged calls in a summary', async () => {
    record(claudeId, 'write_page', { page: 'Asagiri Miyabi', mode: 'append', markdown: 'x' });
    record(claudeId, 'write_page', {
      page: 'Asagiri Miyabi',
      mode: 'append',
      markdown: 'x',
      baseVersion: 'v1',
    });
    record(claudeId, 'write_page', { page: 'Asagiri Miyabi', mode: 'append', markdown: 'x', dryRun: true });
    record(claudeId, 'set_facts', { page: 'Asagiri Miyabi', facts: { Scope: 'x' } });
    const all = (await stack.get('/api/admin/tool-calls?limit=500')).json;
    const flagged = all.calls.filter((c: any) => c.noBaseVersion);
    expect(flagged.map((c: any) => c.tool).sort()).toEqual(['set_facts', 'write_page']);
    expect(all.summary.noBaseVersion).toBe(2);
    const only = (await stack.get('/api/admin/tool-calls?noBaseVersion=true')).json;
    expect(only.calls.every((c: any) => c.noBaseVersion === true)).toBe(true);
    expect(only.calls).toHaveLength(2);
    expect(only.summary.noBaseVersion).toBe(2); // the count ignores the flag filter itself
    expect((await stack.get('/api/admin/tool-calls?noBaseVersion=maybe')).status).toBe(400);
    const none = (await stack.get('/api/admin/tool-calls?noBaseVersion=true&tool=search')).json;
    expect(none.calls).toEqual([]);
  });
});
