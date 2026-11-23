// @vitest-environment jsdom
/**
 * v3 F5a (ADR 0067, H4) on the Proposals page: the filters (tool, principal, age) beside the state tabs; select all,
 * then all matching the filter across pages; "Reject all conflicted" with one confirmation; the results listed
 * proposal by proposal, a running one left alone.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const proposal = (i: number, over: Record<string, unknown> = {}) => ({
  id: `prop_${i}`,
  principalId: 'pat_abc',
  principalLabel: 'ChatGPT',
  profile: 'chatgpt',
  title: `Retag page ${i}`,
  summary: `retag ${i}`,
  state: 'pending',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000,
  decidedAt: null,
  rejectReason: null,
  jobId: null,
  conflict: null,
  error: null,
  opCount: 1,
  tool: 'arkona_retag_apply',
  ...over,
});

describe('H4: the Proposals page', () => {
  it('filters by tool, principal and age (sent to the server)', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal(1), proposal(2, { tool: 'write_page' })], total: 2 },
      'GET /proposals/counts': { counts: { pending: 2 }, byProject: {} },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    const form = await screen.findByRole('search', { name: 'Filter proposals' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'write_page' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Tool'), 'write_page');
    await user.selectOptions(within(form).getByLabelText('Age'), '24');
    await waitFor(() => {
      const q = api.find('GET', '/proposals').at(-1)!.query;
      expect(q).toContain('tool=write_page');
      expect(q).toContain('olderThanHours=24');
    });
    await user.selectOptions(within(form).getByLabelText('Proposed by'), 'pat_abc');
    await waitFor(() => expect(api.find('GET', '/proposals').at(-1)!.query).toContain('principalId=pat_abc'));
  });

  it('selects all on the page, then all matching across pages, and rejects them with one confirmation', async () => {
    const shown = Array.from({ length: 3 }, (_, i) => proposal(i));
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: shown, total: 120 },
      'GET /proposals/counts': { counts: { pending: 120 }, byProject: {} },
      'POST /proposals/bulk-matching': (c: Call) => ({
        results: Array.from({ length: (c.body as { expect: number }).expect }, (_, i) => ({
          id: `prop_${i}`,
          ok: i !== 1,
          ...(i === 1 ? { skipped: true, state: 'executing', error: { code: 'PROPOSAL_RUNNING', message: 'its job is running' } } : { state: 'rejected' }),
        })),
      }),
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    await user.click(await screen.findByRole('checkbox', { name: 'Select all pending proposals' }));
    await user.click(screen.getByRole('button', { name: 'Select all 120 matching the filter' }));
    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('120 selected (every proposal matching the filter)');
    await user.click(within(bar).getByRole('button', { name: 'Reject selected' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Reject 120 proposals?');
    await user.click(within(confirm).getByRole('button', { name: 'Reject all' }));
    await waitFor(() => expect(api.find('POST', '/proposals/bulk-matching')).toHaveLength(1));
    expect(api.find('POST', '/proposals/bulk-matching')[0]!.body).toEqual({
      action: 'reject',
      filter: { group: 'pending' },
      expect: 120,
      confirm: true,
    });
    const results = await screen.findByRole('region', { name: 'Bulk results' });
    expect(results).toHaveTextContent('Left alone: its job is running');
  });

  it('"Reject all conflicted" rejects every conflicted proposal across pages after one confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal(1, { state: 'conflicted' })], total: 60 },
      'GET /proposals/counts': { counts: { conflicted: 60 }, byProject: {} },
      'POST /proposals/bulk-matching': { results: [{ id: 'prop_1', ok: true, state: 'rejected' }] },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?tab=conflicted');
    await user.click(await screen.findByRole('button', { name: 'Reject all conflicted (60)' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Reject all conflicted' }));
    await waitFor(() => expect(api.find('POST', '/proposals/bulk-matching')).toHaveLength(1));
    expect(api.find('POST', '/proposals/bulk-matching')[0]!.body).toMatchObject({
      action: 'reject',
      filter: { group: 'conflicted' },
      expect: 60,
      confirm: true,
    });
    // The conflicted tab has checkboxes too, and its bar only rejects.
    await user.click(screen.getByRole('checkbox', { name: 'Select all conflicted proposals' }));
    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    expect(within(bar).queryByRole('button', { name: /Approve selected/ })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Reject selected' })).toBeInTheDocument();
  });
});
