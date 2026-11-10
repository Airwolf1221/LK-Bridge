// @vitest-environment jsdom
/**
 * v2 C2a (ADR 0032) on the dashboard: a proposal that touches protected canon (its banner, "Approve and accept as
 * canon", the ordinary Approve disabled, Reject as normal), the page-level summary shown first, set_facts' facts table
 * and links, and the Canon card on the Projects page (audited, with a confirmation).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop_c',
  principalId: 'pat_abc',
  principalLabel: 'Claude on the web',
  profile: 'Scribe',
  title: 'set_facts on “Asagiri Miyabi”',
  summary: 'set_facts on “Asagiri Miyabi”: 1 fact changed, 1 link added',
  state: 'pending',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000,
  decidedAt: null,
  rejectReason: null,
  jobId: null,
  conflict: null,
  error: null,
  opCount: 5,
  requiresCanonicalApproval: true,
  canonicalApprovedBy: null,
  canonicalApprovedAt: null,
  pages: ['Asagiri Miyabi: sidebar, 1 fact changed, 1 link added'],
  ...over,
});

const factsOp = {
  tool: 'set_facts',
  page: { id: 'miyabi01', name: 'Asagiri Miyabi' },
  property: 'PROPERTIES',
  pageParts: ['sidebar', '1 fact changed', '1 link added'],
  facts: [
    { key: 'Status', before: 'Working', after: 'Authoritative', change: 'changed' },
    { key: 'Mood', before: null, after: 'Calm', change: 'added' },
  ],
  links: [
    {
      title: 'Dependencies',
      added: [{ name: 'Fourth Age - Table', document: 'Main' }],
      removed: [],
      alreadyLinked: [{ name: 'Asagiri Kaede' }],
      notLinked: [],
      filtered: true,
    },
  ],
};

const detail = (over: Record<string, unknown> = {}) => ({
  proposal: {
    ...proposal(over),
    ops: [],
    operationDetail: factsOp,
    operations: [factsOp],
    pageSummary: [
      {
        resourceId: 'miyabi01',
        page: 'Asagiri Miyabi',
        isNew: false,
        parts: ['sidebar', '1 fact changed', '1 link added'],
        label: 'Asagiri Miyabi: sidebar, 1 fact changed, 1 link added',
      },
    ],
    canonical: {
      reason: 'this makes a protected canonical change',
      changes: [{ page: 'Asagiri Miyabi', text: 'Status would be set to Authoritative (it is “Working”)' }],
    },
  },
});

describe('a proposal that touches protected canon', () => {
  it('shows the pages first, a banner listing the protected changes, the facts table and links', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_c': detail(),
    });
    renderApp('/ui/proposals?id=prop_c');
    const pages = await screen.findByRole('region', { name: 'Pages affected' });
    expect(pages).toHaveTextContent('Asagiri Miyabi: sidebar, 1 fact changed, 1 link added');
    const banner = screen.getByRole('alert', { name: 'Protected canon' });
    expect(banner).toHaveTextContent('This changes protected canon.');
    expect(banner).toHaveTextContent('Status would be set to Authoritative');
    const table = screen.getByRole('table', { name: 'Facts before and after' });
    const status = within(table).getByText('Status').closest('tr')!;
    expect(status).toHaveTextContent('Working');
    expect(status).toHaveTextContent('Authoritative');
    expect(within(table).getByText('Mood').closest('tr')).toHaveTextContent('added');
    const links = screen.getByRole('group', { name: 'Links: Dependencies' });
    expect(links).toHaveTextContent('Added: Fourth Age - Table / Main');
    expect(links).toHaveTextContent('Already linked: Asagiri Kaede');
    // The list marks it too.
    expect(screen.getByText('canon')).toBeInTheDocument();
    // The page-level summary comes before the facts and operations.
    expect(pages.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('disables the ordinary Approve; "Approve and accept as canon" asks, then posts { confirm: true }', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_c': detail(),
      'POST /proposals/prop_c/approve-as-canon': { proposal: proposal({ state: 'executing' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_c');
    expect(await screen.findByRole('button', { name: /^Approve$/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Approve and accept as canon' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/protected canon/);
    expect(dialog).toHaveTextContent('Status would be set to Authoritative');
    expect(api.find('POST', /approve/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Approve and accept as canon' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_c/approve-as-canon')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_c/approve-as-canon')[0]!.body).toEqual({ confirm: true });
    expect(api.find('POST', '/proposals/prop_c/approve')).toHaveLength(0);
  });

  it('Reject works as normal', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_c': detail(),
      'POST /proposals/prop_c/reject': { proposal: proposal({ state: 'rejected' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_c');
    await user.click(await screen.findByRole('button', { name: 'Reject…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_c/reject')).toHaveLength(1));
  });

  it('after approval, says who accepted it as canon', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [] },
      'GET /proposals/prop_c': detail({
        state: 'executed',
        canonicalApprovedBy: 'owner',
        canonicalApprovedAt: Date.now(),
      }),
    });
    renderApp('/ui/proposals?id=prop_c');
    expect(await screen.findByRole('alert', { name: 'Protected canon' })).toHaveTextContent(
      'Accepted as canon by owner',
    );
    expect(screen.queryByRole('button', { name: 'Approve and accept as canon' })).toBeNull();
  });
});

describe('the Canon card on the Projects page', () => {
  const canon = {
    project: 'baisheng',
    rules: [
      { id: 'status-authoritative', key: 'Status', kind: 'value', values: ['Authoritative'] },
      { id: 'continuity', key: 'Continuity', kind: 'change' },
    ],
    defaults: true,
    agentDefaultStatus: 'Working',
    problem: null,
    defaultRules: [],
  };
  it('lists the protected facts and saves a change only after a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /projects/baisheng/canon': canon,
      'GET /projects/test/canon': { ...canon, project: 'test' },
      'PUT /projects/baisheng/canon': { ...canon, rules: [canon.rules[0]], defaults: false },
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    const card = await screen.findByRole('region', { name: 'Canon of baisheng' });
    const list = await within(card).findByRole('list', { name: 'Protected facts of baisheng' });
    expect(list).toHaveTextContent('Status = Authoritative');
    expect(list).toHaveTextContent('Continuity: changing an existing value needs canonical approval');
    expect(within(card).getByRole('textbox', { name: 'Status of pages agents create' })).toHaveValue(
      'Working',
    );
    await user.click(within(card).getByRole('button', { name: 'Remove the rule Continuity of baisheng' }));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('1 rule will protect canon');
    expect(api.find('PUT', '/projects/baisheng/canon')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/canon')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/canon')[0]!.body).toEqual({
      rules: [canon.rules[0]],
      confirm: true,
    });
  });
});
