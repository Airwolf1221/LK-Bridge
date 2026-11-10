// @vitest-environment jsdom
/**
 * v2 C2c (ADR 0035) on the dashboard: the Lifecycle section of the Projects page (what a lookup by name found, confirming
 * the two indexes, audited, after a confirmation), the Canon card's switch for the two recommended rules, a lifecycle
 * tool's proposal in full (move and name, facts, tags, the note's diff, the related pages), and the read-only Archive and
 * lifecycle page with its links to the journal.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const config = {
  workingIndexId: null,
  archiveIndexId: null,
  indexNames: { working: 'Working', archived: 'Archived' },
  status: { authoritative: 'Authoritative', working: 'Working', archived: 'Archived' },
  tags: { canon: 'CANON', working: 'Working', archived: 'Archived' },
  fields: {
    status: 'Status',
    continuityType: 'Continuity Type',
    scope: 'Scope',
    temporalScope: 'Temporal Scope',
    lastMajorRevision: 'Last Major Revision',
  },
  continuityTypes: { canon: 'CANON', au: 'AU', nonCurrent: 'NON-CURRENT' },
  texts: {
    noteFromAuthoritative:
      'Archived - {date}. The author retired {source} and its applications from Main CANON.',
    noteFromWorking: 'Archived - {date}. The author retired {source}, a Working concept.',
    scopePrefix: 'Archived record of the retired',
    temporalFromAuthoritative: 'Former Main CANON. Retired on {date}.',
    temporalFromWorking: 'Former Working concept. Retired on {date}.',
  },
  problem: null,
};
const lifecycle = (over: Record<string, unknown> = {}) => ({
  project: 'baisheng',
  working: {
    status: 'found',
    name: 'Working',
    node: { id: 'working1', name: '[INDEX] Working', path: 'AI REPOSITORY / Working' },
  },
  archived: {
    status: 'found',
    name: 'Archived',
    node: { id: 'archive1', name: '[INDEX] Archived', path: 'AI REPOSITORY / Archived' },
  },
  config,
  confirmed: {
    ok: false,
    code: 'LIFECYCLE_NOT_CONFIGURED',
    message: 'The project’s Working index ([INDEX] Working) is not confirmed yet.',
  },
  ...over,
});
const canon = {
  project: 'baisheng',
  rules: [
    { id: 'status-authoritative', key: 'Status', kind: 'value', values: ['Authoritative'] },
    { id: 'delete-archived', kind: 'deleteKind', kinds: ['barc'] },
    {
      id: 'delete-document-authoritative',
      key: 'Status',
      kind: 'deleteDocument',
      values: ['Authoritative'],
      documentTypes: ['map', 'time', 'board'],
    },
  ],
  defaults: true,
  agentDefaultStatus: 'Working',
  problem: null,
  defaultRules: [],
};

describe('the Lifecycle section of the Projects page', () => {
  it('shows what the lookup by name found, and confirms both indexes after a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /projects/baisheng/canon': canon,
      'GET /projects/test/canon': { ...canon, project: 'test' },
      'GET /projects/baisheng/lifecycle': lifecycle(),
      'GET /projects/test/lifecycle': lifecycle({ project: 'test' }),
      'PUT /projects/baisheng/lifecycle': lifecycle({ confirmed: { ok: true } }),
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    const card = await screen.findByRole('region', { name: 'Lifecycle of baisheng' });
    expect(await within(card).findByText('not confirmed')).toBeInTheDocument();
    expect(card).toHaveTextContent('found: AI REPOSITORY / Working (working1)');
    await user.click(within(card).getByRole('button', { name: 'Confirm these indexes' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('[INDEX] Working is AI REPOSITORY / Working');
    expect(api.find('PUT', '/projects/baisheng/lifecycle')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/lifecycle')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/lifecycle')[0]!.body).toEqual({
      workingIndexId: 'working1',
      archiveIndexId: 'archive1',
      confirm: true,
    });
  });

  it('says when an index is missing or ambiguous, and offers no confirmation', async () => {
    installApi({
      ...baseRoutes(),
      'GET /projects/baisheng/canon': canon,
      'GET /projects/test/canon': { ...canon, project: 'test' },
      'GET /projects/baisheng/lifecycle': lifecycle({
        archived: {
          status: 'ambiguous',
          name: 'Archived',
          candidates: [
            { id: 'a1', name: '[INDEX] Archived', path: 'AI REPOSITORY / Archived' },
            { id: 'a2', name: '[INDEX] Archived', path: 'AI REPOSITORY / Old / Archived' },
          ],
        },
      }),
      'GET /projects/test/lifecycle': lifecycle({
        project: 'test',
        working: { status: 'missing', name: 'Working' },
      }),
    });
    renderApp('/ui/projects');
    const card = await screen.findByRole('region', { name: 'Lifecycle of baisheng' });
    await waitFor(() => expect(card).toHaveTextContent('2 indexes named “Archived”'));
    expect(within(card).queryByRole('button', { name: 'Confirm these indexes' })).toBeNull();
    const test = await screen.findByRole('region', { name: 'Lifecycle of test' });
    await waitFor(() => expect(test).toHaveTextContent('no index named “Working”'));
  });
});

describe('the Canon card: the two recommended rules', () => {
  it('describes them and switches one off, after a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /projects/baisheng/canon': canon,
      'GET /projects/test/canon': { ...canon, project: 'test' },
      'GET /projects/baisheng/lifecycle': lifecycle(),
      'GET /projects/test/lifecycle': lifecycle({ project: 'test' }),
      'PUT /projects/baisheng/canon': canon,
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    const card = await screen.findByRole('region', { name: 'Canon of baisheng' });
    const list = await within(card).findByRole('list', { name: 'Protected facts of baisheng' });
    expect(list).toHaveTextContent(
      'Deleting a [BARC] page (or a subtree holding one) needs canonical approval',
    );
    expect(list).toHaveTextContent('deleting a map, timeline, board of such a page needs canonical approval');
    await user.click(
      within(card).getByRole('button', { name: 'Switch off the rule delete-archived of baisheng' }),
    );
    expect(list).toHaveTextContent('(switched off)');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('2 rules will protect canon (1 switched off)');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/canon')).toHaveLength(1));
    const sent = api.find('PUT', '/projects/baisheng/canon')[0]!.body as {
      rules: { id: string; enabled?: boolean }[];
    };
    expect(sent.rules.find((r) => r.id === 'delete-archived')).toMatchObject({ enabled: false });
  });
});

describe('a lifecycle proposal', () => {
  it('shows the full plan: move and name, facts, tags, the note’s diff and the related pages', async () => {
    const op = {
      tool: 'archive_page',
      page: { id: 'harbour1', name: '[BSRC] Old Harbour' },
      pageParts: ['renamed to [BARC] Old Harbour'],
      lifecycle: {
        page: { id: 'harbour1', name: '[BSRC] Old Harbour' },
        action: 'archive_page',
        newName: '[BARC] Old Harbour',
        newParent: { id: 'archive1', name: '[INDEX] Archived' },
        facts: [{ key: 'Status', before: 'Authoritative', after: 'Archived', change: 'changed' }],
        tags: {
          before: ['CANON', 'port'],
          after: ['port', 'Archived'],
          removed: ['CANON'],
          added: ['Archived'],
        },
        note: {
          action: 'insert',
          blockId: 'b1',
          diff: '+ Archived - 2026-11-10. The author retired Old Harbour …',
        },
      },
      relatedPages: {
        pages: [
          {
            id: 'guild001',
            name: '[BSRC] Harbour Guild',
            path: 'AI REPOSITORY / Locations / Harbour Guild',
            links: ['link collection “Dependencies”'],
          },
        ],
        textSearch: [
          {
            id: 'tides001',
            name: '[BSRC] Tide Tables',
            path: 'AI REPOSITORY / Locations / Tide Tables',
            found: 'found by text search (may be incomplete)',
          },
        ],
        freshness:
          'link index as of 2026-11-10T01:15:00.000Z (the last complete sweep), with the bridge’s own writes since',
        note: 'never edited',
      },
    };
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [] },
      'GET /proposals/prop_l': {
        proposal: {
          id: 'prop_l',
          principalId: 'pat_abc',
          principalLabel: 'Claude',
          profile: 'Scribe',
          title: 'archive_page',
          summary: 'archive_page: [BSRC] Old Harbour → [BARC] Old Harbour',
          state: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
          decidedAt: null,
          rejectReason: null,
          jobId: null,
          conflict: null,
          error: null,
          opCount: 7,
          requiresCanonicalApproval: true,
          canonicalApprovedBy: null,
          canonicalApprovedAt: null,
          pages: [],
          ops: [],
          operations: [op],
          pageSummary: [],
          canonical: { reason: 'archive_page changes a page’s lifecycle state', changes: [] },
        },
      },
    });
    renderApp('/ui/proposals?id=prop_l');
    const plan = await screen.findByRole('region', { name: 'Lifecycle change' });
    expect(plan).toHaveTextContent('[BSRC] Old Harbour becomes [BARC] Old Harbour under [INDEX] Archived');
    expect(within(plan).getByRole('table', { name: 'Lifecycle facts before and after' })).toHaveTextContent(
      'Archived',
    );
    expect(plan).toHaveTextContent('removed CANON');
    expect(within(plan).getByLabelText('The archive note')).toHaveTextContent('+ Archived - 2026-11-10');
    const rel = within(plan).getByRole('group', { name: 'Related pages' });
    expect(rel).toHaveTextContent('Harbour Guild — link collection “Dependencies”');
    expect(rel).toHaveTextContent('found by text search (may be incomplete)');
    expect(rel).toHaveTextContent('link index as of');
  });
});

describe('the Archive and lifecycle page', () => {
  it('lists each change, read-only, with its previous state and links to the journal', async () => {
    installApi({
      ...baseRoutes(),
      'GET /lifecycle/records': {
        project: { id: 'p', name: 'baisheng' },
        total: 1,
        records: [
          {
            id: 1,
            pageId: 'harbour1',
            pageName: '[BSRC] Old Harbour',
            action: 'archive',
            date: '2026-11-10',
            state: 'complete',
            previousState: 'authoritative',
            previousName: '[BSRC] Old Harbour',
            previousParentId: 'locs0001',
            target: { name: '[BARC] Old Harbour', parentId: 'archive1' },
            tagsRemoved: ['CANON'],
            tagsAdded: ['Archived'],
            principalId: 'pat_abc',
            approver: 'owner',
            jobId: 'job_1',
            jobs: ['job_1'],
            proposalId: 'prop_l',
            detail: { verified: true },
            createdAt: Date.now(),
            completedAt: Date.now(),
          },
        ],
        principals: {},
        links: { total: 3, lastSweep: null, running: null },
      },
    });
    renderApp('/ui/lifecycle');
    const row = await screen.findByText('Archived');
    const tr = row.closest('tr')!;
    expect(tr).toHaveTextContent('2026-11-10');
    expect(tr).toHaveTextContent('Authoritative');
    expect(tr).toHaveTextContent('[BARC] Old Harbour');
    expect(within(tr).getByRole('link', { name: 'job_1' })).toHaveAttribute(
      'href',
      expect.stringContaining('/journal?jobId=job_1'),
    );
    expect(screen.getByText(/only the bridge’s own writes are indexed/)).toBeInTheDocument();
    // Read-only: the only button of the page is Refresh.
    const main =
      screen.getByRole('heading', { name: 'Archive and lifecycle' }).closest('main') ?? document.body;
    expect(within(main).queryByRole('button', { name: /archive|unarchive|promote|delete/i })).toBeNull();
  });
});
