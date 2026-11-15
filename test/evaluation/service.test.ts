import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvaluationError } from '../../src/evaluation/index.js';
import { startStack, type Stack } from '../tools/helpers.js';

/**
 * v2 E3 (ADR 0045): the Evaluation helper against the real server and the mock LegendKeeper. Calls are made through real MCP
 * connections, two at once (ChatGPT and Claude), so the windows are checked the way the owner will use them.
 */

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

const ev = () => stack.runtime.evaluation;
const log = () => stack.runtime.toolCalls;

/** Two connections that are told apart by their names, as an OAuth client's name or a token's would be. */
async function twoAssistants(tag: string) {
  const chatgpt = stack.newToken(`ChatGPT ${tag}`, 'propose');
  const claude = stack.newToken(`Claude ${tag}`, 'write');
  return {
    chatgptId: chatgpt.patId,
    claudeId: claude.patId,
    chatgpt: await stack.connect(chatgpt.token),
    claude: await stack.connect(claude.token),
  };
}

const expectError = (f: () => unknown, code: string) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(EvaluationError);
    expect((e as EvaluationError).code).toBe(code);
    return (e as EvaluationError).message;
  }
  throw new Error(`expected ${code}`);
};

describe('the windows', () => {
  it('counts only the chosen assistant’s calls between Start and Done, with both connected and interleaved', async () => {
    const a = await twoAssistants('window');
    // Before Start: not counted.
    await stack.call(a.chatgpt, 'list_projects', {});
    await stack.call(a.claude, 'list_projects', {});
    const run = ev().createRun({ assistant: 'chatgpt', set: 'core' });
    const started = ev().startScenario(run.id, 1);
    const startId = log().lastId();
    expect(started.results.find((r) => r.scenarioId === 1)).toMatchObject({
      state: 'recording',
      startCallId: startId,
      connectionMode: 'auto',
    });
    expect(started.results.find((r) => r.scenarioId === 1)!.principalIds).toContain(a.chatgptId);
    expect(started.results.find((r) => r.scenarioId === 1)!.principalIds).not.toContain(a.claudeId);
    // Interleaved: ChatGPT's search, Claude's two calls, ChatGPT's budget, Claude's search.
    await stack.call(a.chatgpt, 'search', { query: 'foxian' });
    await stack.call(a.claude, 'bridge_budget', {});
    await stack.call(a.claude, 'search', { query: 'foxian' });
    await stack.call(a.chatgpt, 'bridge_budget', {});
    await stack.call(a.claude, 'list_projects', {});
    const mid = ev()
      .getRun(run.id)
      .results.find((r) => r.scenarioId === 1)!;
    expect(mid.live).toEqual({ callCount: 2, tools: ['search', 'bridge_budget'] });
    const done = ev().doneScenario(run.id, 1);
    // After Done: not counted either.
    await stack.call(a.chatgpt, 'search', { query: 'late' });
    const r1 = ev()
      .getRun(run.id)
      .results.find((r) => r.scenarioId === 1)!;
    expect(done.results.find((r) => r.scenarioId === 1)!.calls).toEqual(r1.calls);
    expect(r1.state).toBe('done');
    expect(r1.calls.map((c) => c.tool)).toEqual(['search', 'bridge_budget']);
    expect(r1.endCallId).toBeGreaterThan(r1.startCallId!);
    expect(r1.startedAt).not.toBeNull();
    expect(r1.finishedAt).not.toBeNull();
    // The auto-grade is a hint; the owner's grade is never set for them.
    expect(r1.autoGrade).toMatchObject({ expectedPresent: true, mistakeTools: [], callCount: 2 });
    expect(r1.ownerGrade).toBeNull();
    // The rows themselves are in the log, not copied: the window finds them again.
    expect(
      log()
        .window({ principalIds: r1.principalIds, afterId: r1.startCallId!, upToId: r1.endCallId! })
        .map((x) => x.tool),
    ).toEqual(['search', 'bridge_budget']);
  });

  it('records two assistants’ scenarios at once in two runs, each with only its own calls', async () => {
    const a = await twoAssistants('both');
    const gpt = ev().createRun({ assistant: 'chatgpt', set: 'core' });
    const cl = ev().createRun({ assistant: 'claude', set: 'core' });
    ev().startScenario(gpt.id, 4, [a.chatgptId]);
    ev().startScenario(cl.id, 4, [a.claudeId]);
    await stack.call(a.chatgpt, 'list_projects', {});
    await stack.call(a.claude, 'bridge_budget', {});
    await stack.call(a.chatgpt, 'read_document', { page: 'Nobody', section: 'Biography' });
    await stack.call(a.claude, 'read_document', { page: 'Nobody' });
    ev().doneScenario(cl.id, 4);
    await stack.call(a.chatgpt, 'bridge_budget', {});
    ev().doneScenario(gpt.id, 4);
    const tools = (id: string) =>
      ev()
        .getRun(id)
        .results.find((r) => r.scenarioId === 4)!
        .calls.map((c) => c.tool);
    expect(tools(gpt.id)).toEqual(['list_projects', 'read_document', 'bridge_budget']);
    expect(tools(cl.id)).toEqual(['bridge_budget', 'read_document']);
  });

  it('lets the owner pick the connections by hand, for a run or one scenario, and then ignores the classifier', async () => {
    const a = await twoAssistants('manual');
    const mystery = stack.newToken('mystery laptop', 'write');
    const m = await stack.connect(mystery.token);
    expect(ev().classifyId(mystery.patId).assistant).toBeNull();
    const run = ev().createRun({ assistant: 'claude', set: 'all', principalIds: [mystery.patId] });
    expect(run.principalIds).toEqual([mystery.patId]);
    ev().startScenario(run.id, 2);
    await stack.call(a.claude, 'list_projects', {});
    await stack.call(m, 'bridge_budget', {});
    ev().doneScenario(run.id, 2);
    const r = ev()
      .getRun(run.id)
      .results.find((x) => x.scenarioId === 2)!;
    expect(r.connectionMode).toBe('manual');
    expect(r.calls.map((c) => c.tool)).toEqual(['bridge_budget']);
    // One scenario with another choice.
    ev().startScenario(run.id, 3, [a.claudeId, mystery.patId]);
    await stack.call(a.claude, 'list_tags', {});
    await stack.call(m, 'bridge_budget', {});
    await stack.call(a.chatgpt, 'search', { query: 'x' });
    ev().doneScenario(run.id, 3);
    expect(
      ev()
        .getRun(run.id)
        .results.find((x) => x.scenarioId === 3)!
        .calls.map((c) => c.tool),
    ).toEqual(['list_tags', 'bridge_budget']);
    expectError(() => ev().startScenario(run.id, 4, ['pat_nonexistent']), 'UNKNOWN_CONNECTION');
  });

  it('refuses to Start when no connection is recognised as the assistant, and says to pick one', async () => {
    const fresh = await startStack(); // only the default token, which is neither ChatGPT nor Claude
    try {
      const e = fresh.runtime.evaluation;
      const run = e.createRun({ assistant: 'chatgpt', set: 'core' });
      const message = expectError(() => e.startScenario(run.id, 1), 'NO_CONNECTION');
      expect(message).toMatch(/recognised as ChatGPT/);
      expect(message).toMatch(/Choose the connection/);
      // Choosing it by hand works.
      const pat = fresh.newToken('plain name', 'read');
      expect(e.startScenario(run.id, 1, [pat.patId]).results[0]).toMatchObject({
        state: 'recording',
        connectionMode: 'manual',
      });
    } finally {
      await fresh.close();
    }
  });

  it('includes a connection of the assistant that appears during the scenario, in automatic mode', async () => {
    const run = ev().createRun({ assistant: 'chatgpt', set: 'core' });
    const early = stack.newToken('ChatGPT early', 'propose');
    const earlyClient = await stack.connect(early.token);
    ev().startScenario(run.id, 5);
    // A second ChatGPT connection (a reconnect) and a Claude one appear after Start.
    const late = stack.newToken('ChatGPT late', 'propose');
    const lateClient = await stack.connect(late.token);
    const other = await stack.connect(stack.newToken('Claude late', 'write').token);
    await stack.call(earlyClient, 'list_projects', {});
    await stack.call(lateClient, 'bridge_budget', {});
    await stack.call(other, 'list_tags', {});
    ev().doneScenario(run.id, 5);
    const r = ev()
      .getRun(run.id)
      .results.find((x) => x.scenarioId === 5)!;
    expect(r.principalIds).toEqual(expect.arrayContaining([early.patId, late.patId]));
    expect(r.calls.map((c) => c.tool)).toEqual(['list_projects', 'bridge_budget']);
  });
});

describe('recording, state and grading', () => {
  it('refuses to Start when recording is off (retention 0), and when a run is finished or busy', async () => {
    const a = await twoAssistants('state');
    const run = ev().createRun({ assistant: 'claude', set: 'core' });
    log().setRetentionDays(0);
    const message = expectError(() => ev().startScenario(run.id, 1), 'RECORDING_OFF');
    expect(message).toMatch(/switched off/);
    expect(message).toMatch(/retention 0/);
    log().setRetentionDays(7);
    ev().startScenario(run.id, 1, [a.claudeId]);
    expectError(() => ev().startScenario(run.id, 1), 'ALREADY_RECORDING');
    expectError(() => ev().startScenario(run.id, 4), 'ALREADY_RECORDING');
    expectError(() => ev().finishRun(run.id), 'ALREADY_RECORDING');
    // Recording switched off while a scenario is recording: Done says so and the scenario stays recording.
    log().setRetentionDays(0);
    expectError(() => ev().doneScenario(run.id, 1), 'RECORDING_OFF');
    log().setRetentionDays(7);
    ev().doneScenario(run.id, 1);
    expectError(() => ev().doneScenario(run.id, 1), 'WRONG_STATE');
    expectError(() => ev().startScenario(run.id, 1), 'WRONG_STATE');
    expectError(() => ev().startScenario(run.id, 12), 'NOT_FOUND'); // not in the core set
    ev().finishRun(run.id);
    expectError(() => ev().startScenario(run.id, 4, [a.claudeId]), 'RUN_FINISHED');
    expect(ev().getRun(run.id)).toMatchObject({ status: 'finished' });
  });

  it('grades as a hint: a mistake tool and an error code show, and nothing sets the owner’s grade', async () => {
    const a = await twoAssistants('grade');
    const run = ev().createRun({ assistant: 'claude', set: 'core' });
    ev().startScenario(run.id, 1, [a.claudeId]);
    await stack.call(a.claude, 'lk_api_read', { operationId: 'listTags', params: { path: {} } });
    await a.claude.callTool({ name: 'search', arguments: { query: 'x', invented: 1, limit: 'many' } });
    ev().doneScenario(run.id, 1);
    const r = ev()
      .getRun(run.id)
      .results.find((x) => x.scenarioId === 1)!;
    expect(r.autoGrade).toMatchObject({
      mistakeTools: ['lk_api_read'],
      expectedPresent: true,
      hint: 'looks_wrong',
    });
    expect(r.autoGrade!.errorCodes).toContainEqual({ code: 'INVALID_ARGUMENTS', count: 1 });
    expect(r.ownerGrade).toBeNull();
    expectError(() => ev().grade(run.id, 4, { grade: 'right' }), 'WRONG_STATE'); // not recorded
    const graded = ev().grade(run.id, 1, { grade: 'partly', note: 'Used the raw API first' });
    expect(graded.results.find((x) => x.scenarioId === 1)).toMatchObject({
      ownerGrade: 'partly',
      note: 'Used the raw API first',
    });
    // A later grade without a note keeps the note; null clears the grade.
    expect(ev().grade(run.id, 1, { grade: 'wrong' }).results[0]).toMatchObject({
      ownerGrade: 'wrong',
      note: 'Used the raw API first',
    });
    expect(ev().grade(run.id, 1, { grade: null }).results[0]!.ownerGrade).toBeNull();
    // Redo drops the result, grade and note.
    ev().grade(run.id, 1, { grade: 'right', note: 'n' });
    const reset = ev()
      .resetScenario(run.id, 1)
      .results.find((x) => x.scenarioId === 1)!;
    expect(reset).toMatchObject({ state: 'pending', ownerGrade: null, note: '', calls: [], autoGrade: null });
  });
});

describe('saved runs', () => {
  it('round-trips a run, including after the log has been pruned, and keeps the bridge version', async () => {
    const a = await twoAssistants('persist');
    const run = ev().createRun({ assistant: 'chatgpt', set: 'core' });
    expect(run).toMatchObject({
      assistant: 'chatgpt',
      set: 'core',
      status: 'in_progress',
      bridgeVersion: '0.0.0-test',
      progress: { total: 17, done: 0, graded: 0 },
    });
    expect(run.results.map((r) => r.scenarioId)).toEqual([
      1, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 21, 26, 28, 29,
    ]);
    ev().startScenario(run.id, 1, [a.chatgptId]);
    for (const section of ['How to decide', 'Finding and reading', 'x'])
      await stack.call(a.chatgpt, 'get_bridge_guide', { section });
    await stack.call(a.chatgpt, 'search', { query: 'Miyab' });
    await stack.call(a.chatgpt, 'get_resource', { resource: 'Miyabi', live: false });
    ev().doneScenario(run.id, 1);
    ev().grade(run.id, 1, { grade: 'right', note: 'Clean' });
    const before = ev().getRun(run.id);
    const tableBefore = ev().table(run.id);
    // The log forgets everything; the run does not.
    stack.db.prepare('DELETE FROM tool_calls').run();
    expect(log().list().rows).toHaveLength(0);
    const after = ev().getRun(run.id);
    expect(after).toEqual(before);
    expect(after.results[0]!.calls.map((c) => c.tool)).toEqual([
      'get_bridge_guide',
      'get_bridge_guide',
      'get_bridge_guide',
      'search',
      'get_resource',
    ]);
    expect(after.progress).toEqual({ total: 17, done: 1, graded: 1 });
    expect(ev().table(run.id)).toBe(tableBefore);
    // It also appears in the list, newest first.
    expect(ev().listRuns().runs[0]).toMatchObject({ id: run.id, progress: { done: 1 } });
    expect(ev().listRuns()).toMatchObject({ recording: true, retentionDays: 7 });
  });

  it('builds the results table as the owner writes it, from real calls', async () => {
    const a = await twoAssistants('table');
    const run = ev().createRun({ assistant: 'chatgpt', set: 'core' });
    ev().startScenario(run.id, 1, [a.chatgptId]);
    for (let i = 0; i < 3; i++) await stack.call(a.chatgpt, 'get_bridge_guide', { section: 'How to decide' });
    await stack.call(a.chatgpt, 'search', { query: 'Miyab' });
    await stack.call(a.chatgpt, 'get_resource', { resource: 'Miyabi', live: false });
    ev().doneScenario(run.id, 1);
    ev().grade(run.id, 1, { grade: 'right' });
    ev().startScenario(run.id, 4, [a.chatgptId]);
    await stack.call(a.chatgpt, 'list_projects', {});
    ev().doneScenario(run.id, 4);
    // Scenario 5 is never started: it is not in the table.
    const lines = ev().table(run.id).trimEnd().split('\n');
    expect(lines[0]).toBe('| # | Scenario | Assistant | Tools called | Result | Notes |');
    expect(lines[2]).toMatch(
      /^\| 1 \| Partial name \| ChatGPT \| guide ×3, search, get_resource \(live: false\) \| Right \| /,
    );
    // The mock has no repository tree, so the search and the read failed: their code is in the notes.
    expect(lines[2]).toContain('Error codes: TREE_NOT_CONFIGURED ×2');
    expect(lines[3]).toBe('| 4 | One section | ChatGPT | list_projects | not graded |  |');
    expect(lines).toHaveLength(4);
  });

  it('compares two runs', async () => {
    const a = await twoAssistants('compare');
    const make = async (calls: [string, Record<string, unknown>][], grade: 'right' | 'wrong') => {
      const run = ev().createRun({ assistant: 'claude', set: 'core' });
      ev().startScenario(run.id, 4, [a.claudeId]);
      for (const [tool, args] of calls) await a.claude.callTool({ name: tool, arguments: args });
      ev().doneScenario(run.id, 4);
      ev().grade(run.id, 4, { grade });
      return run.id;
    };
    const first = await make(
      [
        ['read_document', { page: 'Nobody', section: 'Biography' }],
        ['search', { query: 'x', invented: true }],
      ],
      'wrong',
    );
    const second = await make([['list_projects', {}]], 'right');
    const c = ev().compare(first, second);
    expect(c.scenarios).toHaveLength(1);
    expect(c.scenarios[0]).toMatchObject({
      scenarioId: 4,
      movement: 'better',
      gradeText: 'Wrong → Right',
      callsA: 2,
      callsB: 1,
      codesGone: expect.arrayContaining(['INVALID_ARGUMENTS']) as string[],
      toolsAdded: [{ tool: 'list_projects', from: 0, to: 1 }],
    });
    expect(c.summary).toContain('INVALID_ARGUMENTS: 1 → 0');
    expectError(() => ev().compare(first, 'evr_missing'), 'NOT_FOUND');
  });

  it('deletes a run with its results, audited', () => {
    const run = ev().createRun({ assistant: 'claude', set: 'core' });
    const before = stack.policy.store.listAudit({ action: 'evaluation.delete_run' }).length;
    ev().deleteRun(run.id);
    expectError(() => ev().getRun(run.id), 'NOT_FOUND');
    expect(
      stack.db.prepare('SELECT COUNT(*) AS n FROM evaluation_results WHERE run_id = ?').get(run.id),
    ).toEqual({
      n: 0,
    });
    const audit = stack.policy.store.listAudit({ action: 'evaluation.delete_run' });
    expect(audit).toHaveLength(before + 1);
    expect(audit[0]).toMatchObject({ actor: 'owner', target: run.id });
  });
});

describe('classifying real connections', () => {
  it('reads an OAuth grant’s client name and redirect URIs, and a removed connection’s tombstone', () => {
    const profile = stack.policy.commands.createProfile('owner', {
      label: 'eval-grants',
      kind: 'other',
      scope: 'read',
    });
    const insertClient = (id: string, name: string, uris: string[]) =>
      stack.db
        .prepare(
          `INSERT INTO auth_clients (client_id, kind, client_name, redirect_uris, grant_types, response_types,
             token_endpoint_auth_method, metadata, created_at, updated_at) VALUES (?, 'dcr', ?, ?, '[]', '[]', 'none', '{}', 1, 1)`,
        )
        .run(id, name, JSON.stringify(uris));
    const insertGrant = (grant: string, client: string) =>
      stack.db
        .prepare(
          `INSERT INTO auth_token_families (family_id, client_id, scope, resource, created_at, expires_at, profile_id)
           VALUES (?, ?, 'mcp', 'https://x/mcp', 1, 9999999999, ?)`,
        )
        .run(grant, client, profile.id);
    insertClient('c_gpt', 'My connector', ['https://chatgpt.com/connector/oauth/zzz']);
    insertClient('c_cl', 'Anything', ['https://claude.ai/api/mcp/auth_callback']);
    insertClient('c_none', 'Custom client', ['http://localhost/callback']);
    insertGrant('grant_gpt', 'c_gpt');
    insertGrant('grant_cl', 'c_cl');
    insertGrant('grant_none', 'c_none');
    expect(ev().classifyId('grant_gpt')).toEqual({
      assistant: 'chatgpt',
      reason: 'redirect host chatgpt.com',
    });
    expect(ev().classifyId('grant_cl').assistant).toBe('claude');
    expect(ev().classifyId('grant_none').assistant).toBeNull();
    expect(ev().classifyId('pat_unknown')).toEqual({ assistant: null, reason: 'no signal' });
    const listed = ev().connections();
    expect(listed.find((c) => c.id === 'grant_gpt')).toMatchObject({
      assistant: 'chatgpt',
      active: true,
      type: 'grant',
    });
    expect(listed.find((c) => c.id === 'grant_none')).toMatchObject({ assistant: null });
  });

  it('lists a removed connection that still has calls in the log', async () => {
    const t = stack.newToken('ChatGPT to remove', 'read');
    const c = await stack.connect(t.token);
    await stack.call(c, 'list_projects', {});
    stack.policy.store.insertTombstone({
      id: t.patId,
      type: 'pat',
      label: 'ChatGPT to remove',
      clientId: null,
      profileId: t.profileId,
      profileLabel: 'ChatGPT to remove',
      createdAt: 1,
      revokedAt: 2,
      expiresAt: null,
      removedAt: 3,
      removedBy: 'owner',
    });
    stack.db.prepare('DELETE FROM auth_pats WHERE id = ?').run(t.patId);
    const found = ev()
      .connections()
      .find((x) => x.id === t.patId);
    expect(found).toMatchObject({ removed: true, active: false, assistant: 'chatgpt', calls: 1 });
  });
});
