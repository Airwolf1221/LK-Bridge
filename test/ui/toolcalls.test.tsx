// @vitest-environment jsdom
/**
 * v2 E3 (ADR 0045) on the dashboard: the Tool calls page. Each call with its connection and profile, tool, a short summary
 * of the arguments (names and sizes), the outcome, the duration and the budget used; the filters go to the bridge as query
 * parameters; the retention is set on the page.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { argText, budgetText, durationText } from '../../ui/src/pages/toolcalls';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const NOW = Date.now();
const call = (over: Record<string, unknown> = {}) => ({
  id: 2,
  at: NOW - 60_000,
  principalId: 'grant_abc',
  profile: 'ChatGPT',
  scope: 'propose',
  tool: 'write_page',
  project: 'test',
  args: [
    { name: 'page', type: 'string', size: 14, value: 'Asagiri Miyabi' },
    { name: 'markdown', type: 'string', size: 1204 },
    { name: 'dryRun', type: 'boolean', value: false },
  ],
  outcome: 'proposal',
  code: 'proposal_captured',
  jobId: null,
  proposalId: 'prop_1',
  durationMs: 840,
  budgetRequests: 3,
  budgetWrites: 0,
  resultChars: 600,
  ...over,
});
const failed = call({
  id: 1,
  tool: 'search',
  args: [{ name: 'limit', type: 'string', size: 4 }],
  outcome: 'error',
  code: 'INVALID_ARGUMENTS',
  profile: 'Claude',
  scope: 'write',
  proposalId: null,
  budgetRequests: 0,
});
const response = (calls: unknown[], over: Record<string, unknown> = {}) => ({
  calls,
  principals: { grant_abc: { name: 'ChatGPT (grant)', type: 'grant' } },
  hasMore: false,
  nextBefore: null,
  facets: {
    tools: ['search', 'write_page'],
    profiles: ['ChatGPT', 'Claude'],
    codes: ['INVALID_ARGUMENTS'],
    total: 2,
    oldest: NOW - 86_400_000,
  },
  settings: { retentionDays: 7, maxRetentionDays: 90, recording: true },
  ...over,
});
const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /tool-calls': response([call(), failed]),
  ...over,
});

describe('formatting', () => {
  it('shows names and sizes, values only where the log kept them', () => {
    expect(argText({ name: 'page', type: 'string', size: 3, value: 'Ren' })).toBe('page=“Ren”');
    expect(argText({ name: 'markdown', type: 'string', size: 1204 })).toBe('markdown (1204 chars)');
    expect(argText({ name: 'items', type: 'array', size: 12 })).toBe('items (12 items)');
    expect(argText({ name: 'facts', type: 'object', size: 3 })).toBe('facts (3 keys)');
    expect(argText({ name: 'dryRun', type: 'boolean', value: true })).toBe('dryRun=true');
    expect(durationText(840)).toBe('840 ms');
    expect(durationText(2500)).toBe('2.5 s');
    expect(budgetText({ budgetRequests: 3, budgetWrites: 1 })).toBe('3 req (1 w)');
    expect(budgetText({ budgetRequests: null, budgetWrites: null })).toBe('–');
  });
});

describe('the Tool calls page', () => {
  it('is in the navigation, after the Journal', async () => {
    installApi(routes());
    renderApp('/ui/tool-calls');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(labels.indexOf('Tool calls')).toBe(labels.indexOf('Journal') + 1);
  });

  it('lists each call with its connection, profile, tool, arguments, outcome, time and budget', async () => {
    installApi(routes());
    renderApp('/ui/tool-calls');
    const row = (await screen.findByRole('table')).querySelector('[data-call="2"]') as HTMLElement;
    expect(row).toHaveTextContent('ChatGPT (grant)');
    expect(row).toHaveTextContent('propose');
    expect(row).toHaveTextContent('write_page');
    expect(row).toHaveTextContent('page=“Asagiri Miyabi”, markdown (1204 chars), dryRun=false');
    expect(row).toHaveTextContent('Proposal captured');
    expect(row).toHaveTextContent('840 ms');
    expect(row).toHaveTextContent('3 req');
    const bad = screen.getByRole('table').querySelector('[data-call="1"]') as HTMLElement;
    expect(bad).toHaveTextContent('Error');
    expect(bad).toHaveTextContent('INVALID_ARGUMENTS');
  });

  it('sends the filters to the bridge as query parameters', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/tool-calls');
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Tool'), 'search');
    await user.selectOptions(screen.getByLabelText('Outcome'), 'error');
    await waitFor(() => {
      const last = api.find('GET', /^\/tool-calls/).at(-1)!;
      expect(last.path + JSON.stringify(last.query ?? '')).toContain('search');
    });
    const paths = api.calls.filter((c) => c.path.startsWith('/tool-calls')).map((c) => JSON.stringify(c));
    expect(paths.some((p) => p.includes('"outcome":"error"') || p.includes('outcome=error'))).toBe(true);
  });

  it('saves the retention', async () => {
    const api = installApi(routes({ 'PUT /tool-calls/retention': { settings: { retentionDays: 3 } } }));
    const user = userEvent.setup();
    renderApp('/ui/tool-calls');
    const input = await screen.findByLabelText(/Keep for/);
    await user.clear(input);
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/tool-calls/retention')).toHaveLength(1));
    expect(api.find('PUT', '/tool-calls/retention')[0]!.body).toEqual({ days: 3, confirm: true });
  });

  it('keeps an edit made before the retention card’s first effects have run', async () => {
    // CI on a loaded runner (PR #54): the page mounts outside act once the project list has loaded, and the field can be
    // edited in the window between that commit and React's flush of its effects. The card used to copy the saved value
    // into the field in an effect that also ran on mount, so a "3" typed then became "73". The edit is made here from a
    // MutationObserver callback, which runs right after the commit and before that flush, every time.
    installApi(routes());
    let edited = false;
    const watch = new MutationObserver(() => {
      const input = document.getElementById('tc-days');
      if (edited || !(input instanceof HTMLInputElement)) return;
      edited = true;
      fireEvent.change(input, { target: { value: '3' } });
    });
    watch.observe(document.body, { childList: true, subtree: true });
    renderApp('/ui/tool-calls');
    await screen.findByRole('table');
    watch.disconnect();
    expect(edited).toBe(true);
    expect(screen.getByLabelText(/Keep for/)).toHaveValue('3');
  });

  it('says so when recording is off', async () => {
    installApi(
      routes({
        'GET /tool-calls': response([], {
          settings: { retentionDays: 0, maxRetentionDays: 90, recording: false },
        }),
      }),
    );
    renderApp('/ui/tool-calls');
    expect(await screen.findByText(/Recording is switched off/)).toBeInTheDocument();
  });
});

describe('writes without a base version (v2 E3)', () => {
  const flagged = call({
    id: 3,
    tool: 'set_facts',
    args: [
      { name: 'page', type: 'string', size: 14, value: 'Asagiri Miyabi' },
      { name: 'facts', type: 'object', size: 1 },
    ],
    outcome: 'success',
    code: 'succeeded',
    proposalId: null,
    noBaseVersion: true,
  });

  it('badges each such call, and only those', async () => {
    installApi(
      routes({
        'GET /tool-calls': response([flagged, call(), failed], {
          summary: { matching: 3, noBaseVersion: 1 },
        }),
      }),
    );
    renderApp('/ui/tool-calls');
    const table = await screen.findByRole('table');
    const row = table.querySelector('[data-call="3"]') as HTMLElement;
    expect(within(row).getByText('write without a base version')).toBeInTheDocument();
    expect(within(table).getAllByText('write without a base version')).toHaveLength(1);
    expect(screen.getByTestId('nobase-summary')).toHaveTextContent(
      '1 of 3 matching calls is a write without a base version',
    );
  });

  it('says nothing when there are none', async () => {
    installApi(
      routes({ 'GET /tool-calls': response([call()], { summary: { matching: 1, noBaseVersion: 0 } }) }),
    );
    renderApp('/ui/tool-calls');
    await screen.findByRole('table');
    expect(screen.queryByTestId('nobase-summary')).toBeNull();
    expect(screen.queryByText('write without a base version')).toBeNull();
  });

  it('filters on “Writes without a base version”, sending noBaseVersion=true to the bridge', async () => {
    const api = installApi(
      routes({
        'GET /tool-calls': (c: { query: string }) =>
          new URLSearchParams(c.query).get('noBaseVersion') === 'true'
            ? response([flagged], { summary: { matching: 3, noBaseVersion: 1 } })
            : response([flagged, call(), failed], { summary: { matching: 3, noBaseVersion: 1 } }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/tool-calls');
    await screen.findByRole('table');
    expect(new URLSearchParams(api.find('GET', '/tool-calls')[0]!.query).has('noBaseVersion')).toBe(false);
    await user.click(screen.getByLabelText('Writes without a base version'));
    await waitFor(() => {
      const last = api.find('GET', '/tool-calls').at(-1)!;
      expect(new URLSearchParams(last.query).get('noBaseVersion')).toBe('true');
    });
    await waitFor(() => expect(screen.getByRole('table').querySelectorAll('[data-call]')).toHaveLength(1));
  });
});
