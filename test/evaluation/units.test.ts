import { describe, expect, it } from 'vitest';
import { classifyConnection } from '../../src/evaluation/classify.js';
import { compareRuns, type CompareRun } from '../../src/evaluation/compare.js';
import { autoGrade, canonicalTool, type RecordedCall } from '../../src/evaluation/grade.js';
import { buildResultsTable, formatToolSequence } from '../../src/evaluation/table.js';
import { isWriteWithoutBaseVersion } from '../../src/toolcalls/flag.js';
import { summariseArgs } from '../../src/toolcalls/summary.js';

/** v2 E3 (ADR 0045): the Evaluation helper's pure functions, with no database and no server. */

const call = (tool: string, over: Partial<RecordedCall> = {}): RecordedCall => ({
  tool,
  outcome: 'success',
  code: null,
  ...over,
});
const err = (tool: string, code: string): RecordedCall => call(tool, { outcome: 'error', code });

describe('classifyConnection', () => {
  const grant = (over: Record<string, unknown>) => ({
    type: 'grant' as const,
    label: 'Some client',
    redirectUris: [] as string[],
    profileLabel: null,
    ...over,
  });
  it('decides by the redirect host first (the bridge only accepts the hosted callbacks)', () => {
    expect(
      classifyConnection(grant({ redirectUris: ['https://chatgpt.com/connector/oauth/abc_123'] })),
    ).toEqual({ assistant: 'chatgpt', reason: 'redirect host chatgpt.com' });
    expect(
      classifyConnection(grant({ redirectUris: ['https://claude.ai/api/mcp/auth_callback'] })).assistant,
    ).toBe('claude');
    expect(
      classifyConnection(grant({ redirectUris: ['https://claude.com/api/mcp/auth_callback'] })).assistant,
    ).toBe('claude');
    // The host wins over a misleading self-reported name.
    expect(
      classifyConnection(
        grant({
          label: 'Claude helper',
          redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        }),
      ).assistant,
    ).toBe('chatgpt');
  });
  it('falls back to the client name, a token’s name, then the profile’s label', () => {
    expect(classifyConnection(grant({ label: 'ChatGPT' })).assistant).toBe('chatgpt');
    expect(
      classifyConnection(grant({ label: 'Claude Code', redirectUris: ['http://localhost/callback'] }))
        .assistant,
    ).toBe('claude');
    expect(
      classifyConnection({ type: 'pat', label: 'openai evals', redirectUris: [], profileLabel: null }),
    ).toMatchObject({
      assistant: 'chatgpt',
      reason: expect.stringContaining('token name') as string,
    });
    expect(
      classifyConnection({ type: 'pat', label: 'laptop', redirectUris: [], profileLabel: 'Claude' }),
    ).toMatchObject({
      assistant: 'claude',
      reason: expect.stringContaining('profile name') as string,
    });
  });
  it('says no signal, rather than guessing, for a name that is unknown or names both', () => {
    expect(
      classifyConnection({ type: 'pat', label: 'laptop', redirectUris: [], profileLabel: 'test' }),
    ).toEqual({
      assistant: null,
      reason: 'no signal',
    });
    expect(
      classifyConnection({ type: 'pat', label: 'Claude and ChatGPT', redirectUris: [], profileLabel: null })
        .assistant,
    ).toBeNull();
    expect(
      classifyConnection(
        grant({ redirectUris: ['https://chatgpt.com/x', 'https://claude.ai/y'], label: 'Mixed' }),
      ).assistant,
    ).toBeNull();
    expect(
      classifyConnection(grant({ redirectUris: ['https://chatgpt.com.evil.example/x'] })).assistant,
    ).toBeNull();
  });
});

describe('autoGrade', () => {
  const s1 = { expectedTools: ['search'], mistakeTools: ['lk_api_read'] };
  it('looks right with the expected tool, no mistake tool and no error', () => {
    const g = autoGrade(s1, [call('get_bridge_guide'), call('search')]);
    expect(g).toMatchObject({
      expectedPresent: true,
      missingExpected: [],
      mistakeTools: [],
      errorCodes: [],
      callCount: 2,
      hint: 'looks_right',
    });
  });
  it('flags a mistake tool, a missing expected tool, and lists the error codes with their counts', () => {
    expect(autoGrade(s1, [call('search'), call('lk_api_read')])).toMatchObject({
      mistakeTools: ['lk_api_read'],
      hint: 'looks_wrong',
    });
    expect(autoGrade(s1, [call('browse_repository_tree')])).toMatchObject({
      expectedPresent: false,
      missingExpected: ['search'],
      hint: 'looks_wrong',
    });
    const g = autoGrade({ expectedTools: ['read_document'], mistakeTools: [] }, [
      err('read_document', 'SECTION_NOT_FOUND'),
      err('read_document', 'SECTION_NOT_FOUND'),
      err('read_document', 'AMBIGUOUS'),
      call('read_document'),
    ]);
    expect(g.errorCodes).toEqual([
      { code: 'SECTION_NOT_FOUND', count: 2 },
      { code: 'AMBIGUOUS', count: 1 },
    ]);
    expect(g.hint).toBe('check');
  });
  it('says when nothing was recorded, and that no call is right for a scenario that expects none', () => {
    expect(autoGrade(s1, []).hint).toBe('no_calls');
    expect(autoGrade({ expectedTools: [], mistakeTools: ['lk_api_read'] }, []).hint).toBe('looks_right');
    expect(autoGrade({ expectedTools: [], mistakeTools: ['lk_api_read'] }, [call('lk_api_read')]).hint).toBe(
      'looks_wrong',
    );
  });
  it('takes any one of a choice, and counts the old names of merged tools as the new ones', () => {
    const s = { expectedTools: [['get_resource', 'search'], 'set_facts'], mistakeTools: [] };
    expect(autoGrade(s, [call('search'), call('set_facts')]).expectedPresent).toBe(true);
    expect(autoGrade(s, [call('set_facts')]).missingExpected).toEqual(['get_resource or search']);
    expect(canonicalTool('get_resources')).toBe('get_resource');
    expect(canonicalTool('bridge_proposals_mine')).toBe('bridge_proposal_status');
    expect(canonicalTool('bridge_job_wait')).toBe('bridge_job_status');
    expect(canonicalTool('search')).toBe('search');
    expect(
      autoGrade({ expectedTools: ['get_resource'], mistakeTools: [] }, [call('get_resources')]).hint,
    ).toBe('looks_right');
    expect(
      autoGrade({ expectedTools: ['bridge_proposal_status'], mistakeTools: [] }, [
        call('bridge_proposals_mine'),
      ]).expectedPresent,
    ).toBe(true);
    // A mistake tool is matched by its current name too.
    expect(
      autoGrade({ expectedTools: [], mistakeTools: ['get_resource'] }, [call('get_resources')]).mistakeTools,
    ).toEqual(['get_resource']);
  });
  it('counts writes without a base version', () => {
    expect(
      autoGrade({ expectedTools: ['write_page'], mistakeTools: [] }, [call('write_page', { noBase: true })])
        .writesWithoutBaseVersion,
    ).toBe(1);
  });
});

describe('the results table', () => {
  const row = (over: Record<string, unknown>) => ({
    scenarioId: 1,
    shortTitle: 'Partial name',
    assistant: 'chatgpt' as const,
    calls: [] as RecordedCall[],
    ownerGrade: null,
    note: '',
    ...over,
  });
  it('collapses consecutive repeats to `name ×N` and lists a later repeat again', () => {
    expect(
      formatToolSequence([
        call('get_bridge_guide'),
        call('get_bridge_guide'),
        call('get_bridge_guide'),
        call('search'),
        call('get_resource', { live: false }),
      ]),
    ).toBe('guide ×3, search, get_resource (live: false)');
    expect(
      formatToolSequence([
        call('list_projects'),
        call('search'),
        call('get_bridge_guide'),
        call('search'),
        call('search'),
        call('get_bridge_guide'),
      ]),
    ).toBe('list_projects, search, guide, search ×2, guide');
    expect(formatToolSequence([])).toBe('none');
  });
  it('shows get_bridge_guide as `guide` (the owner’s own table does), and keeps get_markdown_guide', () => {
    expect(formatToolSequence([call('get_bridge_guide'), call('get_markdown_guide')])).toBe(
      'guide, get_markdown_guide',
    );
  });
  it('keeps a different `live` value apart, and shows it only on get_resource', () => {
    expect(
      formatToolSequence([
        call('get_resource', { live: false }),
        call('get_resource', { live: true }),
        call('get_resource'),
      ]),
    ).toBe('get_resource (live: false), get_resource (live: true), get_resource');
  });
  it('reproduces rows of the owner’s table: columns #, Scenario, Assistant, Tools called, Result, Notes', () => {
    const md = buildResultsTable([
      row({
        calls: [
          call('get_bridge_guide'),
          call('get_bridge_guide'),
          call('get_bridge_guide'),
          call('search'),
          call('get_resource', { live: false }),
        ],
        ownerGrade: 'right',
      }),
      row({
        scenarioId: 9,
        shortTitle: 'Ambiguous name',
        assistant: 'claude',
        calls: [
          call('get_resource'),
          err('set_facts', 'AMBIGUOUS'),
          err('set_facts', 'AMBIGUOUS'),
          call('set_facts'),
        ],
        ownerGrade: 'partly',
        note: 'Chose the [INDEX] first',
      }),
      row({ scenarioId: 4, shortTitle: 'One section', calls: [call('read_document')] }),
    ]);
    expect(md.split('\n')).toEqual([
      '| # | Scenario | Assistant | Tools called | Result | Notes |',
      '| --: | --- | --- | --- | --- | --- |',
      '| 1 | Partial name | ChatGPT | guide ×3, search, get_resource (live: false) | Right |  |',
      '| 4 | One section | ChatGPT | read_document | not graded |  |',
      '| 9 | Ambiguous name | Claude | get_resource, set_facts ×3 | Partly | Chose the [INDEX] first · Error codes: AMBIGUOUS ×2 |',
      '',
    ]);
  });
  it('keeps a cell on one line and escapes a pipe, and notes writes without a base version', () => {
    const md = buildResultsTable([
      row({ note: 'a | b\nc', calls: [call('write_page', { noBase: true })], ownerGrade: 'wrong' }),
    ]);
    expect(md).toContain(
      '| 1 | Partial name | ChatGPT | write_page | Wrong | a \\| b c · write without a base version ×1 |',
    );
  });
});

describe('comparing two runs', () => {
  const scenario = (
    id: number,
    calls: RecordedCall[],
    grade: 'right' | 'partly' | 'wrong' | null,
    done = true,
  ) => ({
    scenarioId: id,
    shortTitle: `Scenario ${id}`,
    done,
    calls,
    ownerGrade: grade,
  });
  const run = (id: string, scenarios: ReturnType<typeof scenario>[]): CompareRun => ({
    id,
    createdAt: 1,
    assistant: 'claude',
    scenarios,
  });
  it('shows grade changes, tools added and removed, calls, error codes that appeared or went away, and a summary line', () => {
    const a = run('a', [
      scenario(
        4,
        [
          err('read_document', 'SECTION_NOT_FOUND'),
          err('read_document', 'SECTION_NOT_FOUND'),
          call('read_document'),
        ],
        'partly',
      ),
      scenario(5, [call('get_resources')], 'right'),
      scenario(7, [call('create_resource')], 'right'),
      scenario(8, [call('promote_page')], null, false),
    ]);
    const b = run('b', [
      scenario(4, [call('read_document'), call('read_document')], 'right'),
      scenario(5, [call('get_resource'), err('get_resource', 'AMBIGUOUS')], 'wrong'),
      scenario(7, [call('create_resource')], 'right'),
      scenario(9, [call('set_facts')], 'right'),
    ]);
    const c = compareRuns(a, b);
    const by = (id: number) => c.scenarios.find((s) => s.scenarioId === id)!;
    expect(by(4)).toMatchObject({
      movement: 'better',
      gradeText: 'Partly → Right',
      callsA: 3,
      callsB: 2,
      codesGone: ['SECTION_NOT_FOUND'],
      codesAppeared: [],
      toolsRemoved: [{ tool: 'read_document', from: 3, to: 2 }],
      toolsAdded: [],
    });
    expect(by(5)).toMatchObject({
      movement: 'worse',
      codesAppeared: ['AMBIGUOUS'],
      toolsAdded: [{ tool: 'get_resource', from: 0, to: 2 }],
      toolsRemoved: [{ tool: 'get_resources', from: 1, to: 0 }],
    });
    expect(by(7)).toMatchObject({ movement: 'same', gradeText: 'Right (unchanged)' });
    expect(by(9)).toMatchObject({ movement: 'new', inA: false, inB: true });
    expect(by(8)).toBeUndefined(); // not recorded in either run
    expect(c.commonScenarios).toBe(3);
    expect(c.errorCodeChanges).toEqual([
      { code: 'SECTION_NOT_FOUND', from: 2, to: 0 },
      { code: 'AMBIGUOUS', from: 0, to: 1 },
    ]);
    expect(c.summary).toContain('SECTION_NOT_FOUND: 2 → 0');
    expect(c.summary).toContain('AMBIGUOUS: 0 → 1');
    expect(c.gradeCounts.a).toEqual({ right: 2, partly: 1, wrong: 0, notGraded: 0 });
    expect(c.gradeCounts.b).toEqual({ right: 3, partly: 0, wrong: 1, notGraded: 0 });
  });
});

describe('writes without a base version (the definition)', () => {
  const args = (o: Record<string, unknown>) => summariseArgs(o);
  const flagged = (
    tool: string,
    a: Record<string, unknown>,
    code: string | null = null,
    outcome = 'success',
  ) => isWriteWithoutBaseVersion(tool, args(a), code, outcome);
  it('flags a write_page without baseVersion, in every mode, and not one with it', () => {
    for (const mode of ['append', 'prepend', 'replace', 'replace_section', 'append_to_section'])
      expect(flagged('write_page', { page: 'P', mode, markdown: 'x' }), mode).toBe(true);
    expect(flagged('write_page', { page: 'P', mode: 'append', markdown: 'x', baseVersion: 'v1' })).toBe(
      false,
    );
    expect(flagged('write_page', { page: 'P', mode: 'append', markdown: 'x', baseVersion: null })).toBe(true);
    expect(flagged('write_page', { page: 'P', mode: 'append', markdown: 'x', baseVersion: '' })).toBe(true);
  });
  it('does not count a dry run (it writes nothing), but a `dryRun: false` is a real write', () => {
    expect(flagged('write_page', { page: 'P', mode: 'append', markdown: 'x', dryRun: true })).toBe(false);
    expect(flagged('write_page', { page: 'P', mode: 'append', markdown: 'x', dryRun: false })).toBe(true);
    expect(flagged('set_facts', { page: 'P', facts: { A: 'b' }, dryRun: true })).toBe(false);
  });
  it('flags set_facts that changes facts or links without baseFactsVersion', () => {
    expect(flagged('set_facts', { page: 'P', facts: { A: 'b' } })).toBe(true);
    expect(flagged('set_facts', { page: 'P', links: { Dependencies: { add: ['X'] } } })).toBe(true);
    expect(flagged('set_facts', { page: 'P', facts: { A: 'b' }, baseFactsVersion: 'fv2_x' })).toBe(false);
    expect(flagged('set_facts', { page: 'P', facts: { A: 'b' }, baseVersion: 'x' })).toBe(true); // the wrong argument
    expect(flagged('set_facts', { page: 'P' })).toBe(false); // nothing to change
    expect(flagged('set_facts', { page: 'P', facts: {} })).toBe(false);
  });
  it('is only for those two tools, and not for a call the MCP layer refused before the tool ran', () => {
    expect(flagged('create_resource', { name: 'x' })).toBe(false);
    expect(flagged('update_resource', { page: 'P', name: 'x' })).toBe(false);
    for (const code of ['INVALID_ARGUMENTS', 'READ_ONLY_CONNECTION', 'MISSING_SCOPE', 'TOOL_NOT_FOUND'])
      expect(flagged('write_page', { page: 'P', mode: 'append', markdown: 'x' }, code, 'error'), code).toBe(
        false,
      );
    // A refusal by the tool itself (it ran) still skipped the version.
    expect(
      flagged('write_page', { page: 'P', mode: 'append', markdown: 'x' }, 'PAGE_NOT_FOUND', 'error'),
    ).toBe(true);
  });
});
