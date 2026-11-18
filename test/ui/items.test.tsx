// @vitest-environment jsdom
/**
 * v3 F3d (renames), ADR 0058: the dashboard's selective approval (the design's section 2) and Resume (section 3).
 * A proposal made of items shows a tickbox per item, the plan's own ticks first (an unticked one says why); unticking an
 * item that others need leaves them out too, and the page says which BEFORE the owner confirms; the approval sends
 * exactly the closed selection, through the same canonical confirmation as the whole. Once decided, what was left out is
 * listed, with "Propose these again". A job that stopped part-way shows where, and Resume.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, job, renderApp, step, useDom } from './helpers';

useDom();

const item = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'page_name',
  group: 'Page names',
  label,
  dependsOn: [] as string[],
  selected: true,
  ...over,
});

const ITEMS = [
  item('name:core', 'Nadira al-Khalid - Character Core → Laila al-Khalid - Character Core'),
  item('name:art', 'Nadira al-Khalid - Character Art → Laila al-Khalid - Character Art', {
    dependsOn: ['name:core'],
  }),
  item('facts:art', 'Character Art: Subject', {
    kind: 'identity_facts',
    group: 'Identity facts',
    dependsOn: ['name:art'],
    diff: { changes: [{ what: 'Subject', before: 'Nadira al-Khalid', after: 'Laila al-Khalid' }] },
  }),
  item('text:qs5', 'Qasr › Scholars: “The plaque reads “Nadira al-Khalid”.”', {
    kind: 'restatement',
    group: 'Textual restatements',
    dependsOn: ['name:core'],
    selected: false,
    why: 'it is inside quotation marks',
    diff: { before: 'The plaque reads “Nadira al-Khalid”.', after: 'The plaque reads “Laila al-Khalid”.' },
  }),
  item('text:au2', 'Kaito › Purpose: “Kaito met Nadira al-Khalid.”', {
    kind: 'restatement',
    group: 'Textual restatements',
    dependsOn: ['name:core'],
    tags: ['AU'],
  }),
];

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop_rn',
  principalId: 'pat_abc',
  principalLabel: 'Claude Code',
  profile: 'Scribe',
  title: 'arkona_rename',
  summary: 'arkona_rename: “Nadira al-Khalid” → “Laila al-Khalid” (character): 5 items, 4 ticked',
  state: 'pending',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000 * 13,
  decidedAt: null,
  rejectReason: null,
  jobId: null,
  conflict: null,
  error: null,
  opCount: 9,
  requiresCanonicalApproval: true,
  canonical: { reason: 'a rename', changes: [{ text: 'Rename Nadira al-Khalid to Laila al-Khalid' }] },
  items: { total: 5, approved: null, omitted: null },
  itemPlan: { items: ITEMS, approved: null, omitted: null },
  ops: [],
  ...over,
});

describe('Selective approval', () => {
  it('shows the plan’s ticks and why; leaving out an item others need leaves them out too, shown before confirming', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_rn': { proposal: proposal() },
      'POST /proposals/prop_rn/approve-as-canon': { proposal: proposal({ state: 'executing' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_rn');
    const items = await screen.findByRole('region', { name: 'Items' });
    expect(within(items).getByText(/4 of 5/)).toBeInTheDocument();
    const quoted = within(items).getByRole('checkbox', { name: /The plaque reads/ });
    expect(quoted).not.toBeChecked();
    expect(
      within(items).getByText('Unticked by the plan: it is inside quotation marks.'),
    ).toBeInTheDocument();
    expect(within(items).getByText('AU')).toBeInTheDocument();
    // Untick the Art page's new name: its facts need it, so they are left out too, and the page says so now.
    await user.click(within(items).getByRole('checkbox', { name: /Character Art → Laila/ }));
    const left = within(items).getByRole('status');
    expect(left).toHaveTextContent('1 ticked item is left out because it needs an item you unticked');
    expect(left).toHaveTextContent('Character Art: Subject');
    expect(within(items).getByText(/2 of 5/)).toBeInTheDocument();
    // The same canonical confirmation as the whole, with the selection and what is left out.
    await user.click(screen.getByRole('button', { name: 'Approve selected and accept as canon' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('2 of 5 items are approved; 3 are left out');
    expect(dialog).toHaveTextContent('Left out because they need an item you unticked');
    expect(dialog).toHaveTextContent('Character Art: Subject');
    expect(api.find('POST', /approve/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Approve selected and accept as canon' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_rn/approve-as-canon')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_rn/approve-as-canon')[0]!.body).toEqual({
      confirm: true,
      items: ['name:core', 'text:au2'],
    });
  });

  it('lists what was left out once decided, and proposes it again on request', async () => {
    const decided = proposal({
      state: 'executed',
      items: { total: 5, approved: 3, omitted: 2 },
      itemPlan: {
        items: ITEMS,
        approved: ['name:core', 'name:art', 'facts:art'],
        omitted: ['text:qs5', 'text:au2'],
      },
    });
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [decided] },
      'GET /proposals/prop_rn': { proposal: decided },
      'POST /proposals/prop_rn/repropose': { proposalId: 'prop_again', summary: 'again' },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_rn&tab=history');
    const items = await screen.findByRole('region', { name: 'Items' });
    expect(within(items).getByText('3 of 5 approved; 2 left out.')).toBeInTheDocument();
    expect(within(items).getByText('Left out (2)')).toBeInTheDocument();
    await user.click(within(items).getByRole('button', { name: 'Propose these again' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Propose these again' }),
    );
    await waitFor(() => expect(api.find('POST', '/proposals/prop_rn/repropose')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_rn/repropose')[0]!.body).toEqual({ confirm: true });
  });
});

describe('Resume', () => {
  it('shows where a rename stopped, and resumes it after a confirmation', async () => {
    const stopped = job({
      id: 'job_rn',
      title: 'arkona_rename: “Nadira al-Khalid” → “Laila al-Khalid”',
      status: 'failed',
      approvedBy: 'owner',
      lastError: { code: 'LK_ERROR', message: 'model VALIDATION_ERROR', stepNo: 9 },
      finishedAt: Date.now() - 5000,
    });
    const stop = {
      jobId: 'job_rn',
      kind: 'rename',
      lastVerifiedStep: 8,
      lastVerifiedLabel: 'rename the Art page',
      stoppedStep: 9,
      stoppedLabel: 'Qasr › Scholars: 1 occurrence renamed',
      reason: 'model VALIDATION_ERROR',
      status: 'failed',
      stoppedAt: Date.now() - 5000,
      resumes: 0,
      lastResumedAt: null,
      lastResumedBy: null,
    };
    const api = installApi({
      ...baseRoutes(),
      'GET /jobs/job_rn': {
        job: { ...stopped, steps: [step({ jobId: 'job_rn', status: 'failed', stepNo: 9 })], artifacts: [] },
        stop,
        resume: {
          resumable: true,
          reason: null,
          kind: 'rename',
          stop,
          left: [
            { stepNo: 9, op: 'replaceBlock', status: 'failed' },
            { stepNo: 10, op: 'bridge.verify', status: 'pending' },
          ],
          recheck: [1],
          approvedBy: 'owner',
        },
      },
      'POST /jobs/job_rn/resume-stopped': { resume: { status: 'resumed', jobId: 'job_rn' } },
    });
    const user = userEvent.setup();
    renderApp('/ui/jobs/job_rn');
    const card = await screen.findByRole('region', { name: 'Stopped part-way' });
    expect(card).toHaveTextContent('This rename stopped at step 9 (Qasr › Scholars: 1 occurrence renamed)');
    expect(card).toHaveTextContent(
      'Every step up to step 8 (rename the Art page) succeeded and was verified',
    );
    await user.click(within(card).getByRole('button', { name: 'Resume' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('It continues from step 9: 2 steps left');
    expect(dialog).toHaveTextContent('resumes without a new approval');
    await user.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.find('POST', '/jobs/job_rn/resume-stopped')).toHaveLength(1));
    expect(api.find('POST', '/jobs/job_rn/resume-stopped')[0]!.body).toEqual({ confirm: true });
  });
});
