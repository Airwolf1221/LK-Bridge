// @vitest-environment jsdom
/**
 * v2 E3 (ADR 0045) on the dashboard: the Evaluation helper on the Tool calls page. Choose an assistant and a set, copy each
 * prompt, Start and Done, the hint (never the grade), the owner's one-click grade and note, the results table to copy,
 * the connection selector, deleting a run, and comparing two runs.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Api, type Call } from './helpers';

useDom();

const NOW = Date.now();

const scenario = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  section: 'A. Finding and reading',
  title: `Scenario title ${id}`,
  shortTitle: `Short ${id}`,
  assistants: ['chatgpt', 'claude'],
  needsApproval: false,
  alwaysProposal: false,
  core: true,
  dependsOn: [],
  freshChat: true,
  prompts: [`Prompt text ${id}.`],
  interlude: null,
  setupNote: null,
  expectedTools: ['search'],
  optionalTools: [],
  mistakeTools: ['lk_api_read'],
  expectedNote: 'search.',
  watchFor: 'lk_api_read.',
  toolCallsNote: 'one row.',
  copy: [`PREAMBLE\n\nPrompt text ${id}.`],
  ...over,
});
const scenarios = {
  preamble: 'PREAMBLE',
  coreIds: [1, 4],
  scenarios: [
    scenario(1),
    scenario(4, {
      needsApproval: true,
      dependsOn: [1],
      setupNote: 'Needs scenario 1.',
      prompts: ['First prompt.', 'Second prompt.'],
      copy: ['PREAMBLE\n\nFirst prompt.', 'Second prompt.'],
      interlude: 'Edit the page in LegendKeeper.',
    }),
    scenario(12, { core: false }),
  ],
};

const result = (id: number, over: Record<string, unknown> = {}) => ({
  scenarioId: id,
  title: `Short ${id}`,
  state: 'pending',
  startedAt: null,
  finishedAt: null,
  startCallId: null,
  endCallId: null,
  principalIds: [],
  connectionMode: 'auto',
  calls: [],
  sequence: 'none',
  autoGrade: null,
  ownerGrade: null,
  note: '',
  ...over,
});
const runOf = (id: string, over: Record<string, unknown> = {}, results = [result(1), result(4)]) => ({
  id,
  createdAt: NOW - 3_600_000,
  assistant: 'chatgpt',
  set: 'core',
  bridgeVersion: '2.0.0',
  status: 'in_progress',
  finishedAt: null as number | null,
  principalIds: null,
  progress: { total: results.length, done: 0, graded: 0 },
  results,
  ...over,
});
const summary = (r: ReturnType<typeof runOf>) => {
  const { principalIds: _p, results: _r, ...rest } = r;
  return rest;
};

const grade = (over: Record<string, unknown> = {}) => ({
  expectedPresent: true,
  missingExpected: [],
  mistakeTools: [],
  errorCodes: [],
  callCount: 2,
  writesWithoutBaseVersion: 0,
  hint: 'looks_right',
  ...over,
});

const connections = {
  connections: [
    {
      id: 'grant_gpt',
      name: 'ChatGPT',
      type: 'grant',
      profile: 'ChatGPT',
      scope: 'propose',
      active: true,
      removed: false,
      lastUsedAt: NOW,
      calls: 4,
      lastCallAt: NOW - 1000,
      assistant: 'chatgpt',
      reason: 'redirect host chatgpt.com',
    },
    {
      id: 'pat_laptop',
      name: 'laptop',
      type: 'pat',
      profile: 'test',
      scope: 'write',
      active: true,
      removed: false,
      lastUsedAt: null,
      calls: 0,
      lastCallAt: null,
      assistant: null,
      reason: 'no signal',
    },
  ],
  recognised: ['grant_gpt'],
};

const response = (run: ReturnType<typeof runOf>) => ({
  run,
  principals: { grant_gpt: { id: 'grant_gpt', name: 'ChatGPT', type: 'grant', removedAt: null } },
});

/** A scripted bridge: a run that moves through Start, Done and a grade as the page presses the buttons. */
function bridge(initial: ReturnType<typeof runOf>) {
  let run = initial;
  const results = () => run.results;
  const set = (id: number, over: Record<string, unknown>) => {
    run = { ...run, results: results().map((r) => (r.scenarioId === id ? { ...r, ...over } : r)) };
    run = {
      ...run,
      progress: {
        total: results().length,
        done: results().filter((r) => r.state === 'done').length,
        graded: results().filter((r) => r.ownerGrade).length,
      },
    };
  };
  const scenarioOf = (c: Call) => Number(/scenarios\/(\d+)/.exec(c.path)![1]);
  return {
    get run() {
      return run;
    },
    routes: {
      'GET /evaluation/scenarios': scenarios,
      'GET /evaluation/runs': () => ({ runs: [summary(run)], recording: true, retentionDays: 7 }),
      'GET /evaluation/connections': connections,
      [`GET /evaluation/runs/${run.id}`]: () => response(run),
      [`GET /evaluation/runs/${run.id}/table`]: () => ({
        markdown:
          run.progress.done === 0
            ? ''
            : '| # | Scenario | Assistant | Tools called | Result | Notes |\n| --: | --- | --- | --- | --- | --- |\n| 1 | Short 1 | ChatGPT | guide ×3, search | Right |  |\n',
      }),
      [`POST /evaluation/runs/${run.id}/scenarios/1/start`]: (c: Call) => {
        set(scenarioOf(c), {
          state: 'recording',
          startCallId: 10,
          principalIds: (c.body as { principalIds?: string[] }).principalIds ?? ['grant_gpt'],
          connectionMode: (c.body as { principalIds?: string[] }).principalIds ? 'manual' : 'auto',
          live: { callCount: 2, tools: ['get_bridge_guide', 'search'] },
        });
        return response(run);
      },
      [`POST /evaluation/runs/${run.id}/scenarios/1/done`]: (c: Call) => {
        set(scenarioOf(c), {
          state: 'done',
          live: undefined,
          finishedAt: NOW,
          endCallId: 14,
          calls: [{ tool: 'search', outcome: 'success', code: null }],
          sequence: 'guide ×3, search',
          autoGrade: grade({ hint: 'looks_right' }),
        });
        return response(run);
      },
      [`PUT /evaluation/runs/${run.id}/scenarios/1/grade`]: (c: Call) => {
        const b = c.body as { grade: string | null; note: string };
        set(scenarioOf(c), { ownerGrade: b.grade, note: b.note });
        return response(run);
      },
      [`POST /evaluation/runs/${run.id}/finish`]: () => {
        run = { ...run, status: 'finished', finishedAt: NOW };
        return response(run);
      },
      [`POST /evaluation/runs/${run.id}/delete`]: { deleted: run.id },
    },
  };
}

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /tool-calls': {
    calls: [],
    principals: {},
    hasMore: false,
    nextBefore: null,
    facets: { tools: [], profiles: [], codes: [], total: 0, oldest: null },
    settings: { retentionDays: 7, maxRetentionDays: 90, recording: true },
  },
  ...over,
});

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  renderApp('/ui/tool-calls');
  await user.click(await screen.findByRole('button', { name: 'Open the evaluation helper' }));
}

const posts = (api: Api, re: RegExp) => api.find('POST', re);

describe('the Evaluation panel', () => {
  it('stays closed (and asks the bridge for nothing) until it is opened', async () => {
    const api = installApi(routes());
    renderApp('/ui/tool-calls');
    expect(await screen.findByRole('button', { name: 'Open the evaluation helper' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.startsWith('/evaluation'))).toBe(false);
  });

  it('makes a run for the chosen assistant and set', async () => {
    const b = bridge(runOf('evr_1'));
    const api = installApi(
      routes({
        ...b.routes,
        'GET /evaluation/runs': { runs: [], recording: true, retentionDays: 7 },
        'POST /evaluation/runs': (c: Call) =>
          response(runOf('evr_1', { assistant: (c.body as { assistant: string }).assistant })),
      }),
    );
    const user = userEvent.setup();
    await openPanel(user);
    expect(await screen.findByText('No runs yet. Make one above.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Assistant'), 'claude');
    expect(screen.getByLabelText('Scenarios')).toHaveTextContent('Core (2 scenarios)');
    expect(screen.getByLabelText('Scenarios')).toHaveTextContent('All (3 scenarios)');
    await user.selectOptions(screen.getByLabelText('Scenarios'), 'all');
    await user.click(screen.getByRole('button', { name: 'Make the run' }));
    await waitFor(() => expect(posts(api, /^\/evaluation\/runs$/)).toHaveLength(1));
    expect(posts(api, /^\/evaluation\/runs$/)[0]!.body).toEqual({ assistant: 'claude', set: 'all' });
    expect(posts(api, /^\/evaluation\/runs$/)[0]!.headers['x-csrf-token']).toBe('csrf-token-for-tests');
  });

  it('shows each scenario’s prompt with the preamble and a Copy button, and its Start button', async () => {
    const b = bridge(runOf('evr_1'));
    installApi(routes(b.routes));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const one = await screen.findByLabelText('Scenario 1: Scenario title 1');
    expect(within(one).getByText(/PREAMBLE/)).toHaveTextContent('Prompt text 1.');
    expect(within(one).getByText(/with the preamble, in a fresh chat/)).toBeInTheDocument();
    await user.click(within(one).getByRole('button', { name: 'Copy prompt of scenario 1' }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('PREAMBLE\n\nPrompt text 1.'),
    );
    // A scenario of two prompts: one Copy button for each, the interlude between, and the approval badge for ChatGPT.
    const four = screen.getByLabelText('Scenario 4: Scenario title 4');
    expect(within(four).getByText('Prompt 1 of 2, with the preamble, in a fresh chat')).toBeInTheDocument();
    expect(within(four).getByText('Prompt 2 of 2, in the same chat')).toBeInTheDocument();
    expect(within(four).getByText(/Edit the page in LegendKeeper/)).toBeInTheDocument();
    expect(within(four).getByText('needs your approval')).toBeInTheDocument();
    expect(within(four).getByText('Needs scenarios 1 first.')).toBeInTheDocument();
    expect(within(four).getByRole('button', { name: 'Copy prompt 2 of scenario 4' })).toBeInTheDocument();
  });

  it('records with Start and Done, shows the hint without grading, and takes the owner’s one-click grade and note', async () => {
    const b = bridge(runOf('evr_1'));
    const api = installApi(routes(b.routes));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const one = await screen.findByLabelText('Scenario 1: Scenario title 1');
    await user.click(within(one).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posts(api, /scenarios\/1\/start$/)).toHaveLength(1));
    // Automatic connections: no principalIds are sent.
    expect(posts(api, /scenarios\/1\/start$/)[0]!.body).toEqual({});
    expect(await within(one).findByText(/Calls so far: 2/)).toHaveTextContent('get_bridge_guide, search');
    expect(within(one).getByText(/recognised automatically/)).toHaveTextContent('ChatGPT');
    // Another scenario cannot start while this one records.
    expect(
      within(screen.getByLabelText('Scenario 4: Scenario title 4')).getByRole('button', { name: 'Start' }),
    ).toBeDisabled();
    await user.click(within(one).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(posts(api, /scenarios\/1\/done$/)).toHaveLength(1));
    expect(await screen.findByTestId('sequence-1')).toHaveTextContent('guide ×3, search');
    expect(screen.getByTestId('hint-1')).toHaveTextContent('Looks right');
    expect(screen.getByTestId('hint-1')).toHaveTextContent('A hint only');
    expect(screen.getByTestId('hint-1')).toHaveTextContent('Expected tools present.');
    // The hint never sets the owner's grade: nothing is pressed until the owner presses it.
    for (const label of ['Right', 'Partly', 'Wrong'])
      expect(within(one).getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    expect(within(one).getByText('Not graded yet.')).toBeInTheDocument();
    expect(api.find('PUT', /grade$/)).toHaveLength(0);

    await user.type(within(one).getByLabelText('Note (optional)'), 'Read the guide first');
    await user.click(within(one).getByRole('button', { name: 'Partly' }));
    await waitFor(() => expect(api.find('PUT', /scenarios\/1\/grade$/)).toHaveLength(1));
    expect(api.find('PUT', /scenarios\/1\/grade$/)[0]!.body).toEqual({
      grade: 'partly',
      note: 'Read the guide first',
    });
    await waitFor(() =>
      expect(within(one).getByRole('button', { name: 'Partly' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(within(one).getByText('You graded this Partly.')).toBeInTheDocument();
  });

  it('shows the results table and copies it', async () => {
    const done = runOf('evr_1', {}, [
      result(1, {
        state: 'done',
        sequence: 'guide ×3, search',
        autoGrade: grade(),
        ownerGrade: 'right',
        principalIds: ['grant_gpt'],
        finishedAt: NOW,
      }),
      result(4),
    ]);
    const b = bridge({ ...done, progress: { total: 2, done: 1, graded: 1 } });
    installApi(routes(b.routes));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const table = await screen.findByTestId('results-table');
    expect(table).toHaveTextContent('| # | Scenario | Assistant | Tools called | Result | Notes |');
    expect(table).toHaveTextContent('| 1 | Short 1 | ChatGPT | guide ×3, search | Right |');
    await user.click(screen.getByRole('button', { name: 'Copy the results table' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('guide ×3, search'));
  });

  it('lets the owner choose the connections when the bridge cannot tell, and sends only those at Start', async () => {
    const b = bridge(runOf('evr_1'));
    const api = installApi(routes(b.routes));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Recognise ChatGPT automatically/)).toHaveTextContent('(ChatGPT)');
    await user.click(screen.getByLabelText(/Choose the connections myself/));
    await user.click(screen.getByLabelText(/laptop/));
    expect(screen.getByLabelText(/laptop/)).toBeChecked();
    expect(screen.getByLabelText(/ChatGPT.*looks like ChatGPT/)).not.toBeChecked();
    const one = await screen.findByLabelText('Scenario 1: Scenario title 1');
    await user.click(within(one).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posts(api, /scenarios\/1\/start$/)).toHaveLength(1));
    expect(posts(api, /scenarios\/1\/start$/)[0]!.body).toEqual({ principalIds: ['pat_laptop'] });
    expect(await within(one).findByText(/chosen by you/)).toBeInTheDocument();
  });

  it('says why a scenario cannot start when recording is off, and disables Start', async () => {
    const b = bridge(runOf('evr_1'));
    installApi(
      routes({
        ...b.routes,
        'GET /evaluation/runs': () => ({ runs: [summary(b.run)], recording: false, retentionDays: 0 }),
      }),
    );
    const user = userEvent.setup();
    await openPanel(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Recording of tool calls is switched off/);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const one = await screen.findByLabelText('Scenario 1: Scenario title 1');
    expect(within(one).getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('shows the bridge’s message when Start is refused', async () => {
    const b = bridge(runOf('evr_1'));
    installApi(
      routes({
        ...b.routes,
        'POST /evaluation/runs/evr_1/scenarios/1/start': {
          status: 409,
          body: {
            error: {
              code: 'NO_CONNECTION',
              message:
                'No active connection is recognised as ChatGPT. Choose the connection to record yourself.',
            },
          },
        },
      }),
    );
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const one = await screen.findByLabelText('Scenario 1: Scenario title 1');
    await user.click(within(one).getByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/No active connection is recognised as ChatGPT/)).toBeInTheDocument();
  });

  it('deletes a run after a confirmation', async () => {
    const b = bridge(runOf('evr_1'));
    const api = installApi(routes(b.routes));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/cannot be undone/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts(api, /delete$/)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete the run' }),
    );
    await waitFor(() => expect(posts(api, /\/evr_1\/delete$/)).toHaveLength(1));
    expect(posts(api, /\/evr_1\/delete$/)[0]!.body).toEqual({ confirm: true });
  });

  it('compares two runs: grade change, tools, error codes and the summary line', async () => {
    const older = runOf('evr_old', { createdAt: NOW - 86_400_000 });
    const newer = runOf('evr_new');
    const api = installApi(
      routes({
        ...bridge(newer).routes,
        'GET /evaluation/runs': {
          runs: [summary(newer), summary(older)],
          recording: true,
          retentionDays: 7,
        },
        'GET /evaluation/compare': {
          comparison: {
            a: { id: 'evr_old', createdAt: older.createdAt, assistant: 'chatgpt' },
            b: { id: 'evr_new', createdAt: newer.createdAt, assistant: 'chatgpt' },
            commonScenarios: 1,
            errorCodeChanges: [{ code: 'SECTION_NOT_FOUND', from: 6, to: 0 }],
            summary: [
              'SECTION_NOT_FOUND: 6 → 0',
              'Grades: 0 right, 1 partly, 0 wrong, 0 not graded → 1 right, 0 partly, 0 wrong, 0 not graded',
            ],
            scenarios: [
              {
                scenarioId: 4,
                shortTitle: 'One section',
                inA: true,
                inB: true,
                gradeA: 'partly',
                gradeB: 'right',
                movement: 'better',
                gradeText: 'Partly → Right',
                callsA: 7,
                callsB: 1,
                toolsAdded: [],
                toolsRemoved: [{ tool: 'read_document', from: 7, to: 1 }],
                codesAppeared: [],
                codesGone: ['SECTION_NOT_FOUND'],
              },
            ],
          },
        },
      }),
    );
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByRole('button', { name: 'Compare two runs' }));
    const panel = await screen.findByTestId('compare');
    expect(within(panel).getByLabelText('Earlier run')).toHaveValue('evr_old');
    expect(within(panel).getByLabelText('Later run')).toHaveValue('evr_new');
    await user.click(within(panel).getByRole('button', { name: 'Compare' }));
    expect(await within(panel).findByTestId('compare-summary')).toHaveTextContent('SECTION_NOT_FOUND: 6 → 0');
    const row = panel.querySelector('[data-compare="4"]') as HTMLElement;
    expect(row).toHaveTextContent('better');
    expect(row).toHaveTextContent('Partly → Right');
    expect(row).toHaveTextContent('7 → 1 calls');
    expect(row).toHaveTextContent('removed read_document (7 → 1)');
    expect(row).toHaveTextContent('gone SECTION_NOT_FOUND');
    const sent = api.find('GET', '/evaluation/compare')[0]!;
    expect(new URLSearchParams(sent.query).get('a')).toBe('evr_old');
    expect(new URLSearchParams(sent.query).get('b')).toBe('evr_new');
    // The same run on both sides cannot be compared.
    await user.selectOptions(within(panel).getByLabelText('Later run'), 'evr_old');
    expect(within(panel).getByRole('button', { name: 'Compare' })).toBeDisabled();
  });
});
