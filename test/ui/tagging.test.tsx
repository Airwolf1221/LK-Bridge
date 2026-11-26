// @vitest-environment jsdom
/**
 * v3 F3f (ADR 0060) on the dashboard: the Tagging page, in the Repository group. The audit's pages with their arrays,
 * rationale and disposition; picked corrections applied as ONE batch after a confirmation (v3 F12: one job); a hold's owner
 * classification from the closed list, after a confirmation and the password again; the batches and reconciliations.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const POLICY = { packId: 'arkona', version: 7, label: 'v1.8', digest: 'ab'.repeat(32), sources: [] };
const RUN = {
  id: 'rtg_0123456789abcdef',
  policy: POLICY,
  scope: { all: true },
  counts: {
    pages: 4,
    compliant: 1,
    correction: 1,
    hold: 1,
    exception: 1,
    lifecycleOnly: 0,
    lifecycleProblems: 0,
    excluded: 0,
  },
  reconciliationId: null,
  actor: 'owner',
  createdAt: Date.now(),
};
const overview = {
  policy: POLICY,
  unavailable: null,
  closedList: [
    { primary: 'Culture', specialists: ['Language', 'Naming'], kind: 'owner' },
    { primary: 'Polity', specialists: ['Government'], kind: 'owner' },
  ],
  runs: [RUN],
  classifications: [],
  reconciliations: [],
  batches: [
    {
      id: 'rtb_0000000000000001',
      runId: RUN.id,
      reconciliationId: null,
      proposalId: 'prop_x1',
      jobId: 'job_1',
      state: 'done',
      pages: [
        {
          pageId: 'rtorder1',
          name: '[BSRC] Drevin Shore',
          current: ['Polity', 'CANON'],
          proposed: ['CANON', 'Polity'],
        },
      ],
      dispositions: {
        rtorder1: { outcome: 'applied', reason: 'written and read back exactly', verified: true },
      },
      createdAt: Date.now(),
    },
  ],
};
const correction = {
  pageId: 'rtorder1',
  name: '[BSRC] Drevin Shore - Polity Reference',
  disposition: 'correction',
  scope: 'grammar',
  current: ['Polity', 'CANON'],
  proposed: ['CANON', 'Polity'],
  rationale: [
    {
      slot: 'status',
      tag: 'CANON',
      source: 'CANON: Status Authoritative, Continuity Type CANON, Continuity Main',
    },
    { slot: 'primary', tag: 'Polity', source: 'Polity: its current tags (exactly one primary category)' },
  ],
};
const hold = {
  pageId: 'rttwo001',
  name: '[BSRC] Harrow Pact - Reference',
  disposition: 'hold',
  scope: 'grammar',
  current: ['CANON', 'Culture', 'Polity'],
  proposed: ['CANON', 'Culture', 'Polity'],
  rationale: [],
  holds: [
    {
      kind: 'uncertain_category',
      slot: 'primary',
      reason: 'uncertain category; owner classification needed (2 primary categories)',
    },
  ],
  uncertainCategory: true,
  suggestions: [
    {
      id: 1,
      primary: 'Culture',
      specialist: null,
      reason: 'its Scope reads as a culture',
      by: 'claude',
      at: 1,
    },
  ],
  classification: null,
};

/** ADR 0081: the bridge asks no fresh code for these actions: the route answers at once, and no step-up is sent. */
function answersAtOnce(then: (c: Call) => unknown) {
  return {
    route: then,
    reauth: () => ({
      status: 500,
      body: { error: { code: 'NOT_ASKED', message: 'ADR 0081: no step-up here.' } },
    }),
  };
}

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /tagging': overview,
  [`GET /tagging/runs/${RUN.id}`]: { run: RUN, total: 1, pages: [correction] },
  'GET /tagging/holds': { run: RUN, holds: [hold] },
  'POST /tagging/batches': { batch: { id: 'rtb_2' }, proposalId: null, jobId: 'job_new' },
  ...over,
});

describe('the Tagging page', () => {
  it('is in the navigation, under Repository', async () => {
    installApi(routes());
    renderApp('/ui/tagging');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Repository' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Tagging' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText(/pack arkona version 7/)).toBeInTheDocument();
  });

  it('shows each page’s arrays and rationale, and applies the picked corrections as ONE batch after a confirmation (v3 F12: one job)', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('[data-page="rtorder1"]');
      if (!r) throw new Error('not yet');
      return r;
    });
    expect(row).toHaveTextContent('Polity, CANON');
    expect(row).toHaveTextContent('CANON, Polity');
    expect(row).toHaveTextContent('Status Authoritative');
    await user.click(within(row).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply the picked corrections (1)…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/ONE job, at once/);
    expect(api.find('POST', '/tagging/batches')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Apply the batch' }));
    await waitFor(() => expect(api.find('POST', '/tagging/batches')).toHaveLength(1));
    expect(api.find('POST', '/tagging/batches')[0]!.body).toEqual({
      runId: RUN.id,
      pageIds: ['rtorder1'],
      confirm: true,
    });
  });

  it('a hold is classified from the closed list after a confirmation and the password again', async () => {
    const gate = answersAtOnce(() => ({
      classification: { pageId: 'rttwo001', primary: 'Culture', specialist: 'Language' },
    }));
    const api = installApi(
      routes({ 'POST /tagging/classify': gate.route, 'POST /security/reauth': gate.reauth }),
    );
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('tab', { name: 'Holds' }));
    const card = await waitFor(() => {
      const c = document.querySelector<HTMLElement>('[data-hold="rttwo001"]');
      if (!c) throw new Error('not yet');
      return c;
    });
    expect(card).toHaveTextContent('uncertain category; owner classification needed');
    expect(card).toHaveTextContent('Suggested: Culture (claude: its Scope reads as a culture)');
    await user.selectOptions(within(card).getByLabelText(/Category for/), 'Culture');
    await user.selectOptions(within(card).getByLabelText(/Specialist for/), 'Language');
    await user.type(within(card).getByLabelText(/Reason for/), 'a language community');
    await user.click(within(card).getByRole('button', { name: 'Classify' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Classify' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm it’s you' })).toBeNull(); // ADR 0081: no step-up
    await screen.findByText(/Classified: the next audit uses it\./);
    expect(api.find('POST', '/tagging/classify').at(-1)!.body).toEqual({
      pageId: 'rttwo001',
      primary: 'Culture',
      specialist: 'Language',
      reason: 'a language community',
      confirm: true,
    });
  });

  it('lists the batches with each page’s outcome', async () => {
    installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('tab', { name: 'Batches' }));
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('[data-batch="rtb_0000000000000001"]');
      if (!r) throw new Error('not yet');
      return r;
    });
    expect(row).toHaveTextContent('applied');
    expect(row).toHaveTextContent('prop_x1');
  });
});
