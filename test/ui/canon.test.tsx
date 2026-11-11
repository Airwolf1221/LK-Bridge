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
    // v2 C2c: the Status of new pages follows the page lifecycle (the Lifecycle section), not a canon setting.
    expect(within(card).queryByRole('textbox', { name: 'Status of pages agents create' })).toBeNull();
    expect(card).toHaveTextContent('follows the page lifecycle');
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

// ------------------------------------------------------------------------------------ bulk: Accept selected as canon

const archiveOp = {
  tool: 'archive_page',
  lifecycle: {
    page: { id: 'harbour1', name: 'Old Harbour' },
    action: 'archive',
    newName: '[BARC] Old Harbour',
    newParent: { id: 'arch0001', name: '[INDEX] Archived' },
    facts: [],
    tags: { before: [], after: [], removed: [], added: [] },
  },
  relatedPages: {
    pages: [
      { id: 'guild001', name: 'Harbour Guild', path: 'Locations / Harbour Guild', links: ['Dependencies'] },
      { id: 'tides001', name: 'Tide Tables', path: 'Locations / Tide Tables', links: ['mention'] },
    ],
    textSearch: [{ id: 'x1', name: 'Log', path: 'Logs / Log', found: 'names Old Harbour' }],
    freshness: 'from the bridge’s own writes',
    note: '',
  },
};

describe('bulk: Accept selected as canon', () => {
  const facts = proposal({ id: 'prop_c1' });
  const archive = proposal({
    id: 'prop_c2',
    title: 'archive_page on “Old Harbour”',
    summary: 'archive_page on “Old Harbour”',
    pages: ['Old Harbour: renamed to [BARC] Old Harbour, moved to Archived'],
  });
  const deletion = proposal({
    id: 'prop_c3',
    title: 'delete_resource “Tide Tables”',
    summary: 'Delete the page Tide Tables',
    pages: ['Tide Tables: deleted'],
  });
  const ordinary = proposal({
    id: 'prop_o1',
    title: 'replaceDocumentBlocks',
    summary: 'Replace the blocks of the Kingdom page',
    requiresCanonicalApproval: false,
    pages: [],
  });
  const detailOf = (p: ReturnType<typeof proposal>, extra: Record<string, unknown>) => ({
    proposal: { ...p, ops: [], operations: [], pageSummary: [], ...extra },
  });
  const routes = (post?: (c: { body: unknown }) => unknown) => ({
    ...baseRoutes(),
    'GET /proposals': { proposals: [ordinary, facts, archive, deletion] },
    'GET /proposals/prop_c1': detail(),
    'GET /proposals/prop_c2': detailOf(archive, {
      operations: [archiveOp],
      canonical: {
        reason: 'archive_page changes a page’s lifecycle state',
        changes: [{ page: 'Old Harbour', text: 'Archive: “Old Harbour” would become Archived' }],
      },
    }),
    'GET /proposals/prop_c3': detailOf(deletion, {
      canonical: {
        reason: 'deleting an Authoritative page',
        changes: [{ page: 'Tide Tables', text: 'Delete Authoritative page “Tide Tables”' }],
      },
    }),
    ...(post ? { 'POST /proposals/bulk': post } : {}),
  });
  const pick = (name: RegExp) => screen.getByLabelText(name);

  it('shows the canon button only when canonical proposals are selected; Approve counts the ordinary ones', async () => {
    installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    await screen.findByLabelText(/^Select replaceDocumentBlocks/);
    const bar = () => screen.getByRole('group', { name: 'Bulk actions' });

    await user.click(pick(/^Select replaceDocumentBlocks/));
    expect(within(bar()).getByRole('button', { name: 'Approve selected (1)' })).toBeEnabled();
    expect(within(bar()).queryByRole('button', { name: /Accept selected as canon/ })).toBeNull();

    await user.click(pick(/^Select archive_page/));
    await user.click(pick(/^Select set_facts/));
    expect(bar()).toHaveTextContent('3 selected');
    expect(within(bar()).getByRole('button', { name: 'Approve selected (1)' })).toBeEnabled();
    expect(within(bar()).getByRole('button', { name: 'Accept selected as canon (2)' })).toBeEnabled();

    await user.click(pick(/^Select replaceDocumentBlocks/)); // only canonical ones left
    expect(within(bar()).getByRole('button', { name: 'Approve selected (0)' })).toBeDisabled();
    expect(within(bar()).getByRole('button', { name: 'Accept selected as canon (2)' })).toBeEnabled();
  });

  it('Approve selected skips the canonical ones, sends only the ordinary ids, and says so', async () => {
    const api = installApi(
      routes((c) => ({
        results: (c.body as { ids: string[] }).ids.map((id) => ({ id, ok: true, state: 'executing' })),
      })),
    );
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    await screen.findByLabelText(/^Select replaceDocumentBlocks/);
    for (const n of [/^Select replaceDocumentBlocks/, /^Select archive_page/]) await user.click(pick(n));
    await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/1 selected proposal touches protected canon and is skipped here/);
    await user.click(within(dialog).getByRole('button', { name: 'Approve all' }));
    await waitFor(() => expect(api.find('POST', '/proposals/bulk')).toHaveLength(1));
    expect(api.find('POST', '/proposals/bulk')[0]!.body).toEqual({ action: 'approve', ids: ['prop_o1'] });
    // Said in the result: skipped, not a failure.
    const results = await screen.findByRole('region', { name: 'Bulk results' });
    expect(results.querySelector('[data-proposal="prop_o1"]')).toHaveTextContent('Approved');
    const skipped = results.querySelector('[data-proposal="prop_c2"]')!;
    expect(skipped).toHaveAttribute('data-outcome', 'skipped');
    expect(skipped).toHaveTextContent(/Skipped: it changes protected canon/);
    expect(await screen.findByText(/1 approved\. 1 canonical proposal was skipped/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be approved/)).toBeNull();
  });

  it('lists each canonical proposal with its reasons, stays disabled until the box is ticked, and sends the ids it showed', async () => {
    const api = installApi(
      routes(() => ({
        results: [
          { id: 'prop_c2', ok: true, state: 'executing' },
          { id: 'prop_c3', ok: false, state: 'conflicted' },
          {
            id: 'prop_c1',
            ok: false,
            state: 'pending',
            error: { code: 'X', message: 'The project is read-only' },
          },
        ],
      })),
    );
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    await screen.findByLabelText(/^Select replaceDocumentBlocks/);
    await user.click(pick(/^Select archive_page/));
    await user.click(pick(/^Select delete_resource/));
    await user.click(screen.getByRole('button', { name: 'Accept selected as canon (2)' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Accept 2 selected as canon?');
    // Each change: its page-level summary line, its canonical reasons and, for a lifecycle proposal, the related pages.
    const one = dialog.querySelector('[data-proposal="prop_c2"]')!;
    expect(one).toHaveTextContent('Old Harbour: renamed to [BARC] Old Harbour, moved to Archived');
    expect(one).toHaveTextContent('Archive: “Old Harbour” would become Archived');
    expect(one).toHaveTextContent('Related pages: 3');
    const two = dialog.querySelector('[data-proposal="prop_c3"]')!;
    expect(two).toHaveTextContent('Tide Tables: deleted');
    expect(two).toHaveTextContent('Delete Authoritative page “Tide Tables”');
    expect(two).not.toHaveTextContent('Related pages');
    expect(dialog.querySelector('[data-proposal="prop_o1"]')).toBeNull();

    // The button stays disabled until the owner ticks the box.
    const go = within(dialog).getByRole('button', { name: 'Accept 2 as canon' });
    expect(go).toBeDisabled();
    await user.click(go);
    expect(api.find('POST', '/proposals/bulk')).toHaveLength(0);
    // The selection changes behind the dialog: nothing extra is accepted.
    await user.click(pick(/^Select set_facts/));
    await user.click(within(dialog).getByLabelText('I accept these 2 changes as canon'));
    expect(go).toBeEnabled();
    await user.click(go);

    await waitFor(() => expect(api.find('POST', '/proposals/bulk')).toHaveLength(1));
    expect(api.find('POST', '/proposals/bulk')[0]!.body).toEqual({
      action: 'approve-as-canon',
      ids: ['prop_c2', 'prop_c3'],
      confirm: true,
    });
    // Per proposal: accepted, conflicted, refused with the reason.
    const results = await screen.findByRole('region', { name: 'Bulk results' });
    expect(results.querySelector('[data-proposal="prop_c2"]')).toHaveTextContent('Accepted as canon');
    expect(results.querySelector('[data-proposal="prop_c3"]')).toHaveAttribute('data-outcome', 'conflicted');
    expect(results.querySelector('[data-proposal="prop_c1"]')).toHaveTextContent(
      'Refused: The project is read-only',
    );
  });

  it('leaves out a proposal that is no longer waiting when the confirmation reads it, and sends only what it showed', async () => {
    const api = installApi({
      ...routes(() => ({ results: [{ id: 'prop_c2', ok: true, state: 'executing' }] })),
      // Decided elsewhere (for example rejected on another tab) since the list was loaded.
      'GET /proposals/prop_c3': detailOf({ ...deletion, state: 'rejected' }, {}),
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    await screen.findByLabelText(/^Select replaceDocumentBlocks/);
    await user.click(pick(/^Select archive_page/));
    await user.click(pick(/^Select delete_resource/));
    await user.click(screen.getByRole('button', { name: 'Accept selected as canon (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Accept 1 selected as canon?');
    expect(dialog).toHaveTextContent('1 selected proposal is no longer waiting for canonical approval');
    expect(dialog.querySelector('[data-proposal="prop_c3"]')).toBeNull();
    await user.click(within(dialog).getByLabelText('I accept this change as canon'));
    await user.click(within(dialog).getByRole('button', { name: 'Accept 1 as canon' }));
    await waitFor(() => expect(api.find('POST', '/proposals/bulk')).toHaveLength(1));
    expect(api.find('POST', '/proposals/bulk')[0]!.body).toMatchObject({ ids: ['prop_c2'] });
  });

  it('cancelling the confirmation sends nothing and keeps the selection', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    await screen.findByLabelText(/^Select replaceDocumentBlocks/);
    await user.click(pick(/^Select archive_page/));
    await user.click(screen.getByRole('button', { name: 'Accept selected as canon (1)' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.find('POST', '/proposals/bulk')).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Bulk actions' })).toHaveTextContent('1 selected');
  });
});
