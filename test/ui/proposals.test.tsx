// @vitest-environment jsdom

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, projectOf, renderApp, useDom } from './helpers';

useDom();

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop_1',
  principalId: 'pat_abc',
  principalLabel: 'Claude Code on a laptop',
  profile: 'Scribe',
  title: 'replaceDocumentBlocks',
  summary: 'Replace the blocks of the Kingdom page',
  state: 'pending',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000 * 13,
  decidedAt: null,
  rejectReason: null,
  jobId: null,
  conflict: null,
  error: null,
  opCount: 1,
  ...over,
});

const blocks = (...texts: string[]) => texts.map((t) => ({ kind: 'paragraph', content: [{ text: t }] }));

const op = (over: Record<string, unknown> = {}) => ({
  index: 0,
  op: 'replaceDocumentBlocks',
  opKind: 'write',
  params: { path: { documentId: 'doc1' }, body: {} },
  targetExists: true,
  version: 'v3',
  preState: null,
  preStateTruncated: false,
  proposed: null,
  changes: [
    {
      path: 'blocks',
      before: blocks('The old opening', 'Kept line'),
      after: blocks('A new opening', 'Kept line', 'An extra line'),
    },
  ],
  unsupportedLoss: [],
  ...over,
});

const detail = (p = proposal(), ops = [op()]) => ({ proposal: { ...p, ops } });

describe('Proposals', () => {
  it('lists pending proposals with the proposer’s profile, and tabs with counts', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': {
        proposals: [
          proposal(),
          proposal({ id: 'prop_2', profile: 'ChatGPT', title: 'updateResource', summary: 'Rename a nation' }),
        ],
      },
    });
    renderApp('/ui/proposals');
    const row = await screen.findByRole('row', { name: /Replace the blocks/ });
    expect(within(row).getByText('Scribe')).toBeInTheDocument();
    expect(within(row).getByText('Claude Code on a laptop')).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pending (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conflicted (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
  });

  it('shows a readable diff: block text with additions and removals marked, kept lines unchanged', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(),
    });
    renderApp('/ui/proposals?id=prop_1');
    const diff = await screen.findByRole('group', { name: 'Changes to blocks' });
    const lines = [...diff.querySelectorAll('.diff-line')].map((l) => [
      l.getAttribute('data-kind'),
      l.textContent?.replace(/^[+−\s]+/, '').trim(),
    ]);
    expect(lines).toEqual([
      ['del', '[paragraph] The old opening'],
      ['add', '[paragraph] A new opening'],
      ['same', '[paragraph] Kept line'],
      ['add', '[paragraph] An extra line'],
    ]);
    expect(within(diff).getAllByLabelText('added')).toHaveLength(2);
    expect(within(diff).getAllByLabelText('removed')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Proposal review' })).toHaveTextContent('Proposed by Scribe');
  });

  it('v2 C1: a write_page proposal shows the Markdown diff, keep regions as placeholders, beside the block diff', async () => {
    const pageWrite = {
      ...proposal({
        title: 'write_page',
        summary: 'write_page replace_section “Biography” on “Asagiri Miyabi” (Main)',
      }),
      ops: [op()],
      operationDetail: {
        tool: 'write_page',
        page: { id: 'miyabi01', name: 'Asagiri Miyabi' },
        document: { id: 'doc1', name: 'Main' },
        mode: 'replace_section',
        section: 'Asagiri Miyabi > Biography',
        plannedOn: 'v3',
        counts: { kept: 9, changed: 1, added: 0, removed: 0, regionsKept: 1, regionsDropped: 0 },
        markdown: 'Born at dawn.',
      },
      markdownDiff: {
        added: 1,
        removed: 1,
        hunks: [
          {
            beforeStart: 3,
            beforeLines: 4,
            afterStart: 3,
            afterLines: 4,
            lines: [
              { kind: 'same', text: '## Biography' },
              { kind: 'same', text: '' },
              { kind: 'del', text: 'Born on Kumikas 1st.' },
              { kind: 'add', text: 'Born at dawn.' },
              { kind: 'same', text: '[keep region: infobox infobx01]' },
            ],
          },
        ],
      },
      execution: null,
    };
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': { proposal: pageWrite },
    });
    renderApp('/ui/proposals?id=prop_1');
    const section = await screen.findByRole('region', { name: 'Page write' });
    expect(section).toHaveTextContent(
      'replace_section of “Asagiri Miyabi > Biography” on Asagiri Miyabi (Main)',
    );
    expect(section).toHaveTextContent('1 changed');
    const md = within(section).getByRole('group', { name: 'Markdown changes, part 1' });
    const lines = [...md.querySelectorAll('.diff-line[data-kind]')].map((l) => [
      l.getAttribute('data-kind'),
      l.textContent?.replace(/^[+−\s]+/, '').trim(),
    ]);
    expect(lines).toEqual([
      ['same', '## Biography'],
      ['same', ''],
      ['del', 'Born on Kumikas 1st.'],
      ['add', 'Born at dawn.'],
      ['same', '[keep region: infobox infobx01]'],
    ]);
    // The block-level diff is still there.
    expect(screen.getByRole('group', { name: 'Changes to blocks' })).toBeInTheDocument();
  });

  it('shows property, resource and other changes as before and after fields', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(proposal(), [
        op({
          op: 'updateResource',
          changes: [
            { path: 'name', before: 'Old name', after: 'New name' },
            { path: 'tags', before: ['a'], after: ['a', 'b'] },
          ],
        }),
      ]),
    });
    renderApp('/ui/proposals?id=prop_1');
    const name = (await screen.findByText('name', { selector: 'h4' })).closest('.change') as HTMLElement;
    expect(within(name).getByText('Before').nextElementSibling).toHaveTextContent('Old name');
    expect(within(name).getByText('After').nextElementSibling).toHaveTextContent('New name');
    const tags = screen.getByText('tags', { selector: 'h4' }).closest('.change') as HTMLElement;
    expect(within(tags).getByText('After').nextElementSibling).toHaveTextContent(/"b"/);
  });

  it('warns when an operation would remove unsupported blocks', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(proposal(), [op({ unsupportedLoss: ['blk_x', 'blk_y'] })]),
    });
    renderApp('/ui/proposals?id=prop_1');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /remove 2 blocks the bridge cannot represent \(blk_x, blk_y\)/,
    );
  });

  it('approves after a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(),
      'POST /proposals/prop_1/approve': { proposal: proposal({ state: 'executing' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_1');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/1 operation will be sent to LegendKeeper as Scribe/);
    expect(api.find('POST', '/proposals/prop_1/approve')).toHaveLength(0); // nothing yet
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_1/approve')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_1/approve')[0]!.headers['x-csrf-token']).toBe(
      'csrf-token-for-tests',
    );
    // v2 A1: approved within the project the page shows (the default one here).
    expect(projectOf(api.find('POST', '/proposals/prop_1/approve')[0]!)).toBe('baisheng');
    expect(await screen.findByText('Approved.')).toBeInTheDocument();
  });

  it('does not approve when the confirmation is cancelled', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(),
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_1');
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.find('POST', /approve/)).toHaveLength(0);
  });

  it('rejects with a reason the agent can read', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(),
      'POST /proposals/prop_1/reject': { proposal: proposal({ state: 'rejected' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_1');
    await user.click(await screen.findByRole('button', { name: 'Reject…' }));
    await user.type(screen.getByLabelText(/Reason/), 'Not that page, please');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_1/reject')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_1/reject')[0]!.body).toEqual({
      reason: 'Not that page, please',
    });
  });

  it('rejects without a reason too', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_1': detail(),
      'POST /proposals/prop_1/reject': { proposal: proposal({ state: 'rejected' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_1');
    await user.click(await screen.findByRole('button', { name: 'Reject…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_1/reject')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_1/reject')[0]!.body).toEqual({});
  });

  it('approves and rejects several at once, reporting any that could not be done', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': {
        proposals: [
          proposal(),
          proposal({ id: 'prop_2', summary: 'Second one' }),
          proposal({ id: 'prop_3', summary: 'Third one' }),
        ],
      },
      'POST /proposals/bulk': (c: { body: unknown }) => {
        const b = c.body as { ids: string[]; action: string };
        return {
          results: b.ids.map((id, i) =>
            i === 1
              ? { id, ok: false, state: 'conflicted', error: { code: 'X', message: 'It changed' } }
              : { id, ok: true, state: 'executing' },
          ),
        };
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals');
    const pick = () => screen.getAllByLabelText(/^Select replaceDocumentBlocks/);
    await screen.findAllByLabelText(/^Select replaceDocumentBlocks/);
    await user.click(pick()[0]!);
    await user.click(pick()[1]!);
    expect(screen.getByRole('group', { name: 'Bulk actions' })).toHaveTextContent('2 selected');
    await user.click(screen.getByRole('button', { name: 'Approve selected' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve all' }));
    await waitFor(() => expect(api.find('POST', '/proposals/bulk')).toHaveLength(1));
    expect(api.find('POST', '/proposals/bulk')[0]!.body).toEqual({
      action: 'approve',
      ids: ['prop_1', 'prop_2'],
    });
    expect(await screen.findByText(/1 of 2 could not be approved: It changed/)).toBeInTheDocument();

    await user.click(pick()[0]!); // the first two were cleared by the bulk action: pick the first and third
    await user.click(pick()[1]!);
    await user.click(pick()[2]!);
    await user.type(screen.getByLabelText('Reason'), 'Batch no');
    await user.click(screen.getByRole('button', { name: 'Reject selected' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reject all' }));
    await waitFor(() => expect(api.find('POST', '/proposals/bulk')).toHaveLength(2));
    expect(api.find('POST', '/proposals/bulk')[1]!.body).toMatchObject({
      action: 'reject',
      reason: 'Batch no',
    });
  });

  it('shows which operation changed on a conflicted proposal and offers reject only', async () => {
    const conflicted = proposal({
      state: 'conflicted',
      opCount: 2,
      conflict: {
        index: 1,
        op: 'updateResource',
        reason: 'the target changed after it was proposed',
        capturedVersion: 'v3',
        currentVersion: 'v4',
      },
    });
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [conflicted] },
      'GET /proposals/prop_1': detail(conflicted, [
        op(),
        op({ index: 1, op: 'updateResource', changes: [{ path: 'name', before: 'A', after: 'B' }] }),
      ]),
    });
    renderApp('/ui/proposals?tab=conflicted&id=prop_1');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Operation 2');
    expect(alert).toHaveTextContent('updateResource');
    expect(alert).toHaveTextContent(/captured at v3, now v4/);
    expect(alert).toHaveTextContent(/You can only reject it/);
    expect(screen.getByText('changed since proposed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });

  it('shows decided proposals as history, with the reason for a rejection and no actions', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': {
        proposals: [
          proposal({ state: 'rejected', rejectReason: 'Not that page', decidedAt: Date.now() - 5000 }),
        ],
      },
      'GET /proposals/prop_1': detail(proposal({ state: 'rejected', rejectReason: 'Not that page' })),
    });
    renderApp('/ui/proposals?tab=history&id=prop_1');
    expect(await screen.findByText('Rejected: Not that page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject…' })).toBeNull();
  });
});
