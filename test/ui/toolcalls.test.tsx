// @vitest-environment jsdom
/**
 * v2 E3 (ADR 0045) on the dashboard: the Tool calls page. Each call with its connection and profile, tool, a short summary
 * of the arguments (names and sizes), the outcome, the duration and the budget used; the filters go to the bridge as query
 * parameters; the retention is set on the page.
 */
import { screen, waitFor, within } from '@testing-library/react';
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
