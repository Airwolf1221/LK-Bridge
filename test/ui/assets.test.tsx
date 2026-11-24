// @vitest-environment jsdom
/**
 * v2 A4, the Asset Tree page: the status and counts, the build's estimate and "Start walking the folders", progress,
 * the last passes, the correction log, browsing the folders, refresh now, and the read-only "Try it" placement panel.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PROJECT_ID, baseRoutes, installApi, projectOf, renderApp, useDom, type Call } from './helpers';

useDom();

const now = Date.now();

const folder = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  name: 'Characters',
  parentId: null,
  depth: 1,
  path: { ids: ['f1'], names: ['Characters'] },
  isHidden: false,
  lastReadAt: now - 60_000,
  lastReadBy: 'build',
  stale: false,
  staleReason: null,
  ...over,
});

const asset = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  name: 'Portrait 001',
  folderId: 'f2',
  type: 'IMAGE',
  url: 'https://assets.legendkeeper.com/i1.webp',
  width: 512,
  height: 768,
  size: null,
  sha256: null,
  isHidden: false,
  createdAt: null,
  lastReadAt: now - 60_000,
  lastReadBy: 'build',
  stale: false,
  staleReason: null,
  ...over,
});

const pass = (over: Record<string, unknown> = {}) => ({
  id: 'ap_1',
  projectId: PROJECT_ID,
  kind: 'build',
  trigger: 'owner',
  status: 'succeeded',
  snapshotAt: now - 3_600_000,
  foldersFound: 18,
  foldersDone: 18,
  foldersFailed: 0,
  listed: 577,
  pages: 22,
  requests: 22,
  verified: 0,
  added: 0,
  removed: 0,
  corrected: 0,
  estimate: null,
  summary: 'Built the asset tree: 18 folders and 559 assets; 22 requests.',
  error: null,
  jobId: 'job_assets',
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
    confirmedAt: now - 600_000,
    confirmedBy: 'refresh',
    staleRows: 0,
    pendingRereads: 0,
  },
  settings: { refreshEnabled: true, charactersRootId: null },
  counts: { folders: 18, assets: 559, byType: { IMAGE: 559 }, maxDepth: 4, stale: 0, withHash: 0 },
  stale: { folders: [], assets: [] },
  activePass: null,
  lastBuild: pass(),
  lastRefresh: pass({
    id: 'ap_2',
    kind: 'refresh',
    summary: 'Refresh: 1 added, 0 removed, 2 corrected; 22 requests.',
  }),
  lastCheck: null,
  recentPasses: [],
  rereads: { inFlight: 0, failed: [] },
  now,
  ...over,
});

const corrections = {
  entries: [
    {
      id: 7,
      at: now - 120_000,
      source: 'refresh',
      passId: 'ap_2',
      itemId: 'f9',
      itemName: 'Maps to get started',
      itemKind: 'folder',
      change: 'updated',
      field: 'name',
      oldValue: 'Maps',
      newValue: 'Maps to get started',
      detail: null,
    },
  ],
  next: null,
};

const children = (c: Call) => {
  const id = new URLSearchParams(c.query).get('id');
  const tree = overview().tree;
  if (id === 'f1') {
    return {
      tree,
      folder: folder(),
      path: [folder()],
      folders: [
        folder({
          id: 'f2',
          name: 'Beastkin',
          parentId: 'f1',
          depth: 2,
          path: { ids: ['f1', 'f2'], names: ['Characters', 'Beastkin'] },
        }),
      ],
      assets: { assets: [asset({ folderId: 'f1' })], total: 120 },
    };
  }
  return {
    tree,
    folder: null,
    path: [],
    folders: [folder(), folder({ id: 'f8', name: 'Maps to get started', stale: true, staleReason: 'x' })],
    assets: { assets: [], total: 0 },
  };
};

describe('Asset Tree page', () => {
  it('shows the status, counts, passes and corrections, and browses the folders', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview(),
      'GET /asset-tree/corrections': corrections,
      'GET /asset-tree/children': children,
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    const status = await screen.findByTestId('assets-status');
    expect(within(status).getByText('Ready')).toBeInTheDocument();
    expect(within(status).getByText(/Last confirmed .* by a refresh/)).toBeInTheDocument();
    const counts = screen.getByTestId('assets-counts');
    expect(within(counts).getAllByText('559')).toHaveLength(2); // assets and images
    expect(within(counts).getByText('18')).toBeInTheDocument();
    expect(within(screen.getByTestId('assets-passes')).getByText(/Refresh: 1 added/)).toBeInTheDocument();
    expect(within(screen.getByTestId('assets-passes')).getByText('Not run yet')).toBeInTheDocument();
    const log = await screen.findByTestId('assets-log');
    expect(await within(log).findByText('name')).toBeInTheDocument();
    expect(within(log).getByText('Maps')).toBeInTheDocument();
    // Every request names the selected project.
    expect(api.find('GET', '/asset-tree').map(projectOf)).toEqual(
      api.find('GET', '/asset-tree').map(() => 'baisheng'),
    );

    const browser = await screen.findByTestId('assets-browser');
    expect(await within(browser).findByText('stale')).toBeInTheDocument();
    await user.click(await within(browser).findByRole('button', { name: 'Characters' }));
    expect(await within(browser).findByRole('button', { name: 'Beastkin' })).toBeInTheDocument();
    expect(within(browser).getByText('Portrait 001')).toBeInTheDocument();
    expect(within(browser).getByText('512 × 768')).toBeInTheDocument();
    expect(within(browser).getByText(/Showing 1 of 120 assets/)).toBeInTheDocument();
    expect(within(browser).getByRole('button', { name: 'Library root' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Asset Tree' }).length).toBeGreaterThan(0);
  });

  it('not built: starts the build; then the estimate is shown, and confirming it starts the walk with progress', async () => {
    let state: 'none' | 'waiting' | 'walking' = 'none';
    const waitingPass = pass({
      status: 'awaiting_confirmation',
      finishedAt: null,
      foldersFound: 3,
      foldersDone: 0,
      requests: 1,
      summary: null,
      estimate: {
        rootFolders: 3,
        rootAssets: 6,
        requestsSoFar: 1,
        minRequestsRemaining: 3,
        likelyRequestsRemaining: 3,
        basis: 'root level only',
        previousFolders: null,
        previousAssets: null,
        wallClockMs: 4_000,
        fitsInDailyBudget: true,
        tightestTier: 'key-min',
        at: now,
      },
    });
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': () =>
        overview({
          tree: {
            ...overview().tree,
            status: state === 'walking' ? 'building' : 'not_built',
            confirmedAt: null,
            confirmedBy: null,
          },
          counts: { folders: 0, assets: 0, byType: {}, maxDepth: 0, stale: 0, withHash: 0 },
          lastBuild: null,
          lastRefresh: null,
          activePass:
            state === 'none'
              ? null
              : state === 'waiting'
                ? waitingPass
                : pass({
                    status: 'walking',
                    foldersFound: 18,
                    foldersDone: 7,
                    listed: 90,
                    pages: 8,
                    requests: 8,
                    finishedAt: null,
                    summary: null,
                  }),
        }),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'POST /asset-tree/build': () => {
        state = 'waiting';
        return { pass: waitingPass };
      },
      'POST /asset-tree/build/confirm': () => {
        state = 'walking';
        return { pass: pass({ status: 'walking' }) };
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    await user.click(await screen.findByRole('button', { name: 'Start the first build…' }));
    await user.click(await screen.findByRole('button', { name: 'List the root level' }));
    await waitFor(() => expect(api.find('POST', '/asset-tree/build')).toHaveLength(1));
    expect(projectOf(api.find('POST', '/asset-tree/build')[0]!)).toBe('baisheng');
    const estimate = await screen.findByTestId('assets-estimate');
    expect(estimate).toHaveTextContent('root level has 3 folders and 6 assets');
    expect(estimate).toHaveTextContent('one request per folder');
    expect(estimate).toHaveTextContent('At least 3 more requests');
    expect(estimate).toHaveTextContent('about 4 s');
    expect(estimate).toHaveTextContent('It fits in what is left of today’s budget.');
    await user.click(within(estimate).getByRole('button', { name: 'Start walking the folders' }));
    await waitFor(() => expect(api.find('POST', '/asset-tree/build/confirm')).toHaveLength(1));
    expect(api.find('POST', '/asset-tree/build/confirm')[0]!.body).toEqual({ confirm: true });
    const progress = await screen.findByTestId('assets-progress');
    expect(await within(progress).findByText(/Listed 7 of 18 folders found so far/)).toBeInTheDocument();
  });

  it('a rebuild’s estimate names the previous inventory; Refresh now runs a refresh', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview({
        activePass: pass({
          status: 'awaiting_confirmation',
          finishedAt: null,
          estimate: {
            rootFolders: 3,
            rootAssets: 6,
            requestsSoFar: 1,
            minRequestsRemaining: 3,
            likelyRequestsRemaining: 23,
            basis: 'the previous inventory',
            previousFolders: 18,
            previousAssets: 559,
            wallClockMs: 20_000,
            fitsInDailyBudget: false,
            tightestTier: null,
            at: now,
          },
        }),
      }),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'GET /asset-tree/children': children,
    });
    renderApp('/ui/assets');
    const estimate = await screen.findByTestId('assets-estimate');
    expect(estimate).toHaveTextContent('going by the previous inventory (18 folders, 559 assets), about 23');
    expect(estimate).toHaveTextContent('does NOT fit');
    expect(api.find('POST', '/asset-tree/refresh')).toHaveLength(0);
  });

  it('Refresh now is offered once the tree is built', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview(),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'GET /asset-tree/children': children,
      'POST /asset-tree/refresh': { started: true },
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    await user.click(await screen.findByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(api.find('POST', '/asset-tree/refresh')).toHaveLength(1));
    expect(projectOf(api.find('POST', '/asset-tree/refresh')[0]!)).toBe('baisheng');
  });

  it('says when the regular refresh is switched off, and lists what could not be confirmed', async () => {
    installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview({
        tree: { ...overview().tree, status: 'stale', reason: '1 row could not be confirmed', staleRows: 1 },
        settings: { refreshEnabled: false, charactersRootId: null },
        stale: {
          folders: [folder({ stale: true, staleReason: 'the refresh could not list it: boom' })],
          assets: [],
        },
        rereads: {
          inFlight: 0,
          failed: [
            {
              id: 3,
              op: 'createAssetFolder',
              jobId: 'job_x',
              assetIds: [],
              attempts: 1,
              lastError: 'boom',
              nextAt: now + 60_000,
              createdAt: now,
            },
          ],
        },
      }),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'GET /asset-tree/children': children,
    });
    renderApp('/ui/assets');
    const status = await screen.findByTestId('assets-status');
    expect(within(status).getAllByText('Stale').length).toBeGreaterThan(0); // the badge, and the count's label
    expect(status).toHaveTextContent('1 row could not be confirmed');
    expect(screen.getByTestId('assets-passes')).toHaveTextContent(
      'it is off now; the nightly check still runs',
    );
    expect(
      within(screen.getByTestId('assets-stale')).getByText('the refresh could not list it: boom'),
    ).toBeInTheDocument();
    const re = screen.getByTestId('assets-rereads');
    expect(re).toHaveTextContent('createAssetFolder');
    expect(re).toHaveTextContent('(its folder)');
  });
});

describe('Try it', () => {
  const okPlan = {
    project: 'baisheng',
    mode: 'character_path',
    character: {
      name: 'Kitsu',
      resourceId: 'p1',
      group: 'Beastkin',
      race: 'Foxians',
      raceSource: 'page_ancestry',
    },
    steps: [
      { name: 'Characters', action: 'reuse', folderId: 'f1', parentFolderId: null, path: ['Characters'] },
      {
        name: 'Beastkin',
        action: 'reuse',
        folderId: 'f2',
        parentFolderId: 'f1',
        path: ['Characters', 'Beastkin'],
      },
      {
        name: 'Kitsu',
        action: 'create',
        folderId: null,
        parentFolderId: 'f2',
        path: ['Characters', 'Beastkin', 'Kitsu'],
      },
      {
        name: 'Art',
        action: 'create',
        folderId: null,
        parentFolderId: null,
        path: ['Characters', 'Beastkin', 'Kitsu', 'Art'],
      },
    ],
    reused: [],
    wouldCreate: [],
    destination: { path: ['Characters', 'Beastkin', 'Kitsu', 'Art'], folderId: null, exists: false },
    notes: ['The folder “Elves” is used for “elves”; names are compared ignoring case.'],
    assetTree: { status: 'ready', reason: null, confirmedAt: now },
  };

  it('shows the plan for a character: what is reused and what would be created, in order', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview(),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'GET /asset-tree/children': children,
      'POST /asset-tree/plan': {
        project: { id: PROJECT_ID, name: 'baisheng' },
        result: { ok: true, plan: okPlan },
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    const panel = await screen.findByTestId('assets-try');
    expect(within(panel).getByRole('button', { name: 'Show the plan' })).toBeDisabled();
    await user.type(within(panel).getByLabelText('Character name'), 'Kitsu');
    await user.type(within(panel).getByLabelText(/Subfolders/), 'Art');
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    const plan = await screen.findByTestId('assets-plan');
    expect(plan).toHaveTextContent('Characters / Beastkin / Kitsu / Art');
    expect(plan).toHaveTextContent('would be created');
    const steps = within(plan).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual([
      expect.stringMatching(/^reuseCharacters/),
      expect.stringMatching(/^reuseBeastkin/),
      expect.stringMatching(/^createKitsu/),
      expect.stringMatching(/^createArt/),
      expect.stringMatching(/compared ignoring case/),
    ]);
    expect(plan).toHaveTextContent('From the character’s page: Beastkin / Foxians.');
    expect(api.find('POST', '/asset-tree/plan')[0]!.body).toEqual({
      characterName: 'Kitsu',
      subfolders: ['Art'],
    });
    expect(projectOf(api.find('POST', '/asset-tree/plan')[0]!)).toBe('baisheng');
  });

  it('plans a literal folder path, one name per line, and by page id', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview(),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'GET /asset-tree/children': children,
      'POST /asset-tree/plan': {
        project: { id: PROJECT_ID, name: 'baisheng' },
        result: { ok: true, plan: okPlan },
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    const panel = await screen.findByTestId('assets-try');
    await user.click(within(panel).getByLabelText('A folder path'));
    await user.type(within(panel).getByLabelText(/Folder path/), 'Maps to get started{enter}Dungeons');
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    await waitFor(() => expect(api.find('POST', '/asset-tree/plan')).toHaveLength(1));
    expect(api.find('POST', '/asset-tree/plan')[0]!.body).toEqual({
      folderPath: ['Maps to get started', 'Dungeons'],
    });
    await user.click(within(panel).getByLabelText('A character, by page id'));
    await user.type(within(panel).getByLabelText('Character page id'), '  h0gczxh7 ');
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    await waitFor(() => expect(api.find('POST', '/asset-tree/plan')).toHaveLength(2));
    expect(api.find('POST', '/asset-tree/plan')[1]!.body).toEqual({ characterResourceId: 'h0gczxh7' });
  });

  it('shows a typed refusal with its details, not a guess', async () => {
    installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview(),
      'GET /asset-tree/corrections': { entries: [], next: null },
      'GET /asset-tree/children': children,
      'POST /asset-tree/plan': {
        project: { id: PROJECT_ID, name: 'baisheng' },
        result: {
          ok: false,
          error: {
            code: 'AMBIGUOUS_FOLDER',
            message: '2 folders are named “Mehrana al-Khalid”. Nothing was guessed.',
            details: { candidates: [{ id: 'a', path: ['Characters', 'Mehrana al-Khalid'] }] },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    const panel = await screen.findByTestId('assets-try');
    await user.type(within(panel).getByLabelText('Character name'), 'Mehrana al-Khalid');
    await user.click(within(panel).getByRole('button', { name: 'Show the plan' }));
    const err = await screen.findByTestId('assets-plan-error');
    expect(err).toHaveTextContent('AMBIGUOUS_FOLDER');
    expect(err).toHaveTextContent('Nothing was guessed.');
    expect(err).toHaveTextContent('"candidates"');
  });
});

describe('Asset Tree page: image archives (v3 F7c, ADR 0075)', () => {
  const archives = {
    project: { id: PROJECT_ID, name: 'baisheng' },
    archives: [
      {
        archive_id: 'arc_AAAAAAAAAAAAAAAA',
        fileName: 'Ishikawa_Rei.zip',
        state: 'open',
        bytes: 45_000_000,
        sha256: 'a'.repeat(64),
        entries: 3,
        counts: { staged: 1, held: 1, refused: 1 },
        serverCopy: true,
        createdAt: new Date(now - 60_000).toISOString(),
        lastActivityAt: new Date(now - 30_000).toISOString(),
        referenced: true,
        principalId: 'pat_x',
        source: 'chatgpt_file',
        rows: [
          {
            entry: 'Rei - Portrait.webp',
            path: 'Rei - Portrait.webp',
            folder: null,
            suggestedOutfit: null,
            size: 1000,
            format: 'webp',
            width: 640,
            height: 960,
            status: 'staged',
            staged_id: 'img_xxxxxxxxxxxx',
          },
          {
            entry: 'Rei - Lingerie 1.webp',
            path: 'Lingerie/Rei - Lingerie 1.webp',
            folder: 'Lingerie',
            suggestedOutfit: 'Lingerie',
            size: 1000,
            status: 'held',
            heldBy: 'storage',
          },
          {
            entry: 'notes.txt',
            path: 'notes.txt',
            folder: null,
            suggestedOutfit: null,
            size: 10,
            status: 'refused',
            reason: 'NOT_AN_IMAGE: not a PNG, JPEG, GIF or WebP image',
          },
        ],
      },
    ],
    limits: {
      holding: { stagedBytes: 1_000_000, capBytes: 5_368_709_120, freeBytes: 5_367_709_120 },
      processing: { converting: 0, waitingInQueue: 0, concurrency: 1 },
      brake: { perHour: 1000 },
    },
    now,
  };

  it('lists the archives with their rows and the three limits; Discard posts after confirming', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /asset-tree': overview(),
      'GET /asset-tree/corrections': corrections,
      'GET /asset-tree/children': children,
      'GET /archives': archives,
      'POST /archives/arc_AAAAAAAAAAAAAAAA/discard': { discarded: 1 },
    });
    const user = userEvent.setup();
    renderApp('/ui/assets');
    const card = await screen.findByTestId('assets-archives');
    expect(await within(card).findByRole('button', { name: 'Ishikawa_Rei.zip' })).toBeInTheDocument();
    expect(within(card).getByText(/Staged 1/)).toBeInTheDocument();
    expect(within(card).getByText(/an art job waits for it/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('archive-limits')).getByText(/1,000 images per connection per hour/),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Ishikawa_Rei.zip' }));
    expect(within(card).getByText('waiting for space')).toBeInTheDocument();
    expect(within(card).getByText(/NOT_AN_IMAGE/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Discard' }));
    await user.click(await screen.findByRole('button', { name: 'Discard the archive' }));
    await waitFor(() => expect(api.find('POST', '/archives/arc_AAAAAAAAAAAAAAAA/discard')).toHaveLength(1));
  });
});
