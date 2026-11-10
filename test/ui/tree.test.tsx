// @vitest-environment jsdom
/**
 * v2 A2, the Repository Tree page and the editable project settings: the status and counts, the root suggestion and
 * "Use this root", the build's estimate and "Start reading", progress, the last passes, the unclassified list, the
 * correction log, browsing the tree; and on the Projects page, editing a setting (audited by the bridge).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_ID,
  SETTING_KEYS,
  baseRoutes,
  installApi,
  project,
  projectOf,
  projectsJson,
  renderApp,
  useDom,
  type Call,
} from './helpers';

useDom();

const now = Date.now();

const node = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  rawName: '[INDEX] Characters',
  displayName: 'Characters',
  kind: 'index',
  parentId: 'root0001',
  rank: 'a0',
  depth: 1,
  path: { ids: ['root0001', 'n1'], names: ['AI REPOSITORY', 'Characters'] },
  tags: [],
  aliases: [],
  documents: [{ id: 'd1', name: 'Main', type: 'page' }],
  isHidden: false,
  isLocked: false,
  referenceType: 'Index',
  scope: 'Arkona',
  indexScope: 'Characters',
  canonicalDisplayName: null,
  propertiesFound: true,
  templateId: null,
  lastReadAt: now - 60_000,
  lastReadBy: 'build',
  propertiesPending: false,
  stale: false,
  staleReason: null,
  ...over,
});

const pass = (over: Record<string, unknown> = {}) => ({
  id: 'tp_1',
  projectId: PROJECT_ID,
  kind: 'build',
  trigger: 'owner',
  status: 'succeeded',
  rootId: 'root0001',
  snapshotAt: now - 3_600_000,
  pages: 15,
  listed: 1466,
  subtree: 1453,
  toRead: 1453,
  readOk: 1453,
  readFailed: 0,
  requests: 1468,
  added: 0,
  removed: 0,
  corrected: 0,
  estimate: null,
  summary: 'Built the tree: 1453 nodes, 1453 read with getResource; 1468 requests.',
  error: null,
  jobId: 'job_tree',
  startedAt: now - 3_600_000,
  updatedAt: now - 3_000_000,
  finishedAt: now - 3_000_000,
  ...over,
});

const overview = (over: Record<string, unknown> = {}) => ({
  project: { id: PROJECT_ID, name: 'baisheng' },
  tree: {
    projectId: PROJECT_ID,
    status: 'ready',
    reason: null,
    rootId: 'root0001',
    confirmedAt: now - 600_000,
    confirmedBy: 'sweep',
    staleNodes: 0,
    pendingRereads: 0,
  },
  settings: {
    rootId: 'root0001',
    propertiesName: 'PROPERTIES',
    referenceTypeRow: 'Reference Type',
    scopeRow: 'Scope',
    indexScopeRow: 'Index Scope',
    canonicalNameRow: 'Canonical Display Name',
    sweepEnabled: true,
  },
  counts: {
    total: 1453,
    byKind: { root: 1, index: 376, bsrc: 1074, unclassified: 2 },
    maxDepth: 9,
    stale: 0,
    propertiesPending: 0,
  },
  unclassified: [
    node({ id: 'u1', rawName: 'Loose notes', displayName: 'Loose notes', kind: 'unclassified' }),
  ],
  staleNodes: [],
  activePass: null,
  lastBuild: pass(),
  lastSweep: pass({
    id: 'tp_2',
    kind: 'sweep',
    summary: 'Sweep: 1 added, 0 removed, 2 corrected; 15 requests.',
  }),
  lastCheck: null,
  recentPasses: [],
  rereads: { inFlight: 0, failed: [] },
  suggestion: null,
  suggesting: false,
  now,
  ...over,
});

const corrections = {
  entries: [
    {
      id: 7,
      at: now - 120_000,
      source: 'sweep',
      passId: 'tp_2',
      nodeId: 'n9',
      nodeName: '[BSRC] Asagiri Miyabi',
      change: 'updated',
      field: 'tags',
      oldValue: [],
      newValue: ['canon'],
      detail: null,
    },
  ],
  next: null,
};

const children = (c: Call) => {
  const id = new URLSearchParams(c.query).get('id');
  if (id === 'n1') {
    return {
      tree: overview().tree,
      node: node(),
      path: [
        { id: 'root0001', rawName: 'AI REPOSITORY', displayName: 'AI REPOSITORY', kind: 'root' },
        { id: 'n1', rawName: '[INDEX] Characters', displayName: 'Characters', kind: 'index' },
      ],
      children: [
        node({ id: 'n9', rawName: '[BSRC] Asagiri Miyabi', displayName: 'Asagiri Miyabi', kind: 'bsrc' }),
      ],
    };
  }
  return {
    tree: overview().tree,
    node: node({
      id: 'root0001',
      rawName: 'AI REPOSITORY',
      displayName: 'AI REPOSITORY',
      kind: 'root',
      depth: 0,
    }),
    path: [{ id: 'root0001', rawName: 'AI REPOSITORY', displayName: 'AI REPOSITORY', kind: 'root' }],
    children: [node()],
  };
};

describe('Repository Tree page', () => {
  it('shows the status, counts, passes, unclassified pages and corrections, and browses the tree', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /tree': overview(),
      'GET /tree/corrections': corrections,
      'GET /tree/children': children,
    });
    const user = userEvent.setup();
    renderApp('/ui/tree');
    const status = await screen.findByTestId('tree-status');
    expect(within(status).getByText('Ready')).toBeInTheDocument();
    expect(within(status).getByText(/Last confirmed .* by a sweep/)).toBeInTheDocument();
    const counts = screen.getByTestId('tree-counts');
    expect(within(counts).getByText('1,453')).toBeInTheDocument();
    expect(within(counts).getByText('376')).toBeInTheDocument();
    expect(within(counts).getByText('9')).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-passes')).getByText(/Sweep: 1 added/)).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-passes')).getByText('Not run yet')).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-unclassified')).getByText('Loose notes')).toBeInTheDocument();
    const log = await screen.findByTestId('tree-log');
    expect(await within(log).findByText('tags')).toBeInTheDocument();
    expect(within(log).getByText('["canon"]')).toBeInTheDocument();
    // Every request names the selected project.
    expect(api.find('GET', '/tree').map(projectOf)).toEqual(api.find('GET', '/tree').map(() => 'baisheng'));

    const browser = await screen.findByTestId('tree-browser');
    await user.click(await within(browser).findByRole('button', { name: 'Characters' }));
    expect(await within(browser).findByRole('button', { name: 'Asagiri Miyabi' })).toBeInTheDocument();
    expect(within(screen.getByTestId('tree-node')).getByText('Index')).toBeInTheDocument();
    expect(within(browser).getByRole('button', { name: 'AI REPOSITORY' })).toBeInTheDocument();
  });

  it('opens the browser at a node linked with ?node= (v2 A3: the registry links here)', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /tree': overview(),
      'GET /tree/corrections': corrections,
      'GET /tree/children': children,
    });
    renderApp('/ui/tree?node=chars001');
    await screen.findByTestId('tree-browser');
    await waitFor(() =>
      expect(
        api.find('GET', '/tree/children').some((c) => new URLSearchParams(c.query).get('id') === 'chars001'),
      ).toBe(true),
    );
  });

  it('not configured: offers the suggested root, and sets it with the audited settings route', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /tree': overview({
        tree: {
          ...overview().tree,
          status: 'not_configured',
          rootId: null,
          confirmedAt: null,
          reason: 'No root.',
        },
        suggestion: {
          at: now,
          candidates: [{ id: 'h0gczxh7', name: 'AI REPOSITORY' }],
          suggested: 'h0gczxh7',
          listed: 1466,
          error: null,
        },
        counts: { total: 0, byKind: { root: 0, index: 0, bsrc: 0, unclassified: 0 }, maxDepth: 0, stale: 0 },
      }),
      'PUT /projects/baisheng/settings': { project: project() },
    });
    const user = userEvent.setup();
    renderApp('/ui/tree');
    const card = await screen.findByTestId('tree-root');
    expect(within(card).getByText(/Found exactly one/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Use this root…' }));
    await user.click(await screen.findByRole('button', { name: 'Use this root' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/settings')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/settings')[0]!.body).toEqual({
      key: 'aiRepositoryRootId',
      value: 'h0gczxh7',
    });
    expect(screen.queryByTestId('tree-counts')).toBeNull();
  });

  it('a build waiting for its estimate to be confirmed, then reading with progress', async () => {
    let state: 'waiting' | 'reading' = 'waiting';
    const api = installApi({
      ...baseRoutes(),
      'GET /tree': () =>
        overview({
          tree: {
            ...overview().tree,
            status: state === 'waiting' ? 'not_built' : 'building',
            confirmedAt: null,
          },
          lastBuild: null,
          activePass: pass(
            state === 'waiting'
              ? {
                  status: 'awaiting_confirmation',
                  finishedAt: null,
                  estimate: {
                    listed: 1466,
                    subtree: 1453,
                    reads: 1453,
                    listingRequests: 15,
                    wallClockMs: 590_000,
                    fitsInDailyBudget: true,
                    tightestTier: 'key-min',
                    at: now,
                  },
                }
              : { status: 'reading', readOk: 400, toRead: 1453, finishedAt: null },
          ),
        }),
      'GET /tree/corrections': { entries: [], next: null },
      'POST /tree/build/confirm': () => {
        state = 'reading';
        return { pass: pass({ status: 'reading' }) };
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/tree');
    const estimate = await screen.findByTestId('tree-estimate');
    expect(estimate).toHaveTextContent('1,453 pages are under the root');
    expect(estimate).toHaveTextContent('about 9 min 50 s');
    expect(estimate).toHaveTextContent('It fits in what is left of today’s budget.');
    await user.click(within(estimate).getByRole('button', { name: 'Start reading' }));
    await waitFor(() => expect(api.find('POST', '/tree/build/confirm')).toHaveLength(1));
    expect(api.find('POST', '/tree/build/confirm')[0]!.body).toEqual({ confirm: true });
    expect(projectOf(api.find('POST', '/tree/build/confirm')[0]!)).toBe('baisheng');
    const progress = await screen.findByTestId('tree-progress');
    expect(await within(progress).findByText(/Read 400 of 1,453 pages/)).toBeInTheDocument();
  });
});

describe('Projects page settings (v2 A2)', () => {
  it('edits a project setting and switches the sweep, through the audited route', async () => {
    const keys = [
      ...SETTING_KEYS.map((k) => ({ ...k, editable: k.key !== 'templateIds' })),
      {
        key: 'treePropertiesName',
        label: 'Tree: key-value property',
        kind: 'name',
        default: 'PROPERTIES',
        editable: true,
      },
      {
        key: 'treeSweepEnabled',
        label: 'Tree: hourly structural sweep',
        kind: 'on/off',
        default: true,
        editable: true,
      },
    ];
    const api = installApi({
      ...baseRoutes(),
      'GET /projects': { ...projectsJson([project()]), settingKeys: keys },
      'PUT /projects/baisheng/settings': { project: project() },
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    const box = await screen.findByLabelText('Settings of baisheng');
    expect(within(box).getByText('PROPERTIES')).toBeInTheDocument();
    expect(within(box).getAllByText('(default)').length).toBeGreaterThan(0);
    await user.click(within(box).getByRole('button', { name: 'Edit AI REPOSITORY root of baisheng' }));
    await user.type(within(box).getByLabelText('AI REPOSITORY root of baisheng'), 'h0gczxh7');
    await user.click(within(box).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/settings')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/settings')[0]!.body).toEqual({
      key: 'aiRepositoryRootId',
      value: 'h0gczxh7',
    });
    await user.click(
      within(box).getByRole('button', { name: 'Switch Tree: hourly structural sweep of baisheng' }),
    );
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/settings')).toHaveLength(2));
    expect(api.find('PUT', '/projects/baisheng/settings')[1]!.body).toEqual({
      key: 'treeSweepEnabled',
      value: false,
    });
    // Template ids are not editable here yet.
    expect(within(box).queryByRole('button', { name: /Template ids/ })).toBeNull();
  });
});
