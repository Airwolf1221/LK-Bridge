// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON replies and mock data in tests */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { configView, settingsView } from './settings-fixtures';
import {
  baseRoutes,
  connections,
  controls,
  installApi,
  job,
  profiles,
  projectOf,
  renderApp,
  snapshot,
  step,
  useDom,
} from './helpers';

useDom();

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('navigation', () => {
  it('lists every page', async () => {
    installApi({ ...baseRoutes(), 'GET /overview': overview() });
    renderApp('/ui');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of [
      'Overview',
      'Jobs',
      'Errors',
      'Request Budgets',
      'Concurrent Writers',
      'Proposals',
      'Clients & Access',
      'Journal',
      'Projects',
      'Chronology',
      'Settings',
      'Maintenance Jobs',
      'Repository Mappings',
    ]) {
      expect(
        within(nav).getByRole('link', { name: new RegExp(`^${name}`), hidden: true }),
      ).toBeInTheDocument();
    }
    // The selected (default) project's pending count from the API; it arrives once the project list has loaded.
    await waitFor(() => expect(within(nav).getByRole('link', { name: /^Proposals/ })).toHaveTextContent('2'));
    expect(within(nav).getByRole('link', { name: /^Overview/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Owner dashboard · v9.9.9')).toBeInTheDocument();
  });

  it('says so for an unknown path', async () => {
    installApi(baseRoutes());
    renderApp('/ui/nope');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('cycles the theme and remembers it', async () => {
    installApi({ ...baseRoutes(), 'GET /overview': overview() });
    renderApp('/ui');
    const btn = await screen.findByRole('button', { name: /Theme: system/ });
    btn.click();
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    (await screen.findByRole('button', { name: /Theme: light/ })).click();
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(window.localStorage.getItem('lkb-theme')).toBe('dark');
  });
});

function overview(over: Record<string, unknown> = {}) {
  const snap = snapshot();
  return {
    health: {
      checkedAt: Date.now(),
      reachable: true,
      projectName: 'Baisheng',
      keyRole: 'ADMIN',
      plan: 'ok',
      note: null,
    },
    controls: controls({ readOnly: true }),
    activeJobs: { total: 4, running: 2, queued: 1, waiting: 1, paused: 0, uncertain: 1 },
    errorsLastHour: { count: 3, capped: false },
    pendingProposals: 2,
    writes: { state: 'running', perMinute: 12 },
    project: { id: 'lkp_baisheng', name: 'baisheng' },
    projects: [
      {
        name: 'baisheng',
        id: 'lkp_baisheng',
        status: 'active',
        reason: null,
        isDefault: true,
        readOnly: false,
      },
      { name: 'test', id: 'lkp_test', status: 'active', reason: null, isDefault: false, readOnly: false },
    ],
    budget: {
      queues: snap.queues,
      gauges: ['write-min', 'key-min', 'key-hour', 'project-hour'].map(
        (t) => snap.tiers[t as keyof typeof snap.tiers],
      ),
    },
    ...over,
  };
}

describe('Overview', () => {
  it('shows health, the read-only flag, writes state, headline gauges and the three counts', async () => {
    installApi({ ...baseRoutes(), 'GET /overview': overview() });
    renderApp('/ui');
    expect(await h1('Overview')).toBeInTheDocument();
    const health = screen.getByRole('region', { name: 'Health' });
    expect(within(health).getByText('reachable')).toBeInTheDocument();
    expect(within(health).getByText('ADMIN')).toBeInTheDocument();
    expect(within(health).getByText('paid plan')).toBeInTheDocument();
    expect(within(health).getByText('Project: Baisheng')).toBeInTheDocument();
    const writing = screen.getByRole('region', { name: 'Writing' });
    expect(within(writing).getByText('on: nothing is written')).toBeInTheDocument();
    expect(within(writing).getByText('running')).toBeInTheDocument();
    const activity = screen.getByRole('region', { name: 'Activity' });
    const stat = (name: string) =>
      within(activity).getByRole('link', { name }).closest('.stat') as HTMLElement;
    expect(stat('active jobs')).toHaveTextContent(/^4/);
    expect(stat('errors in the last hour')).toHaveTextContent(/^3/);
    expect(stat('pending proposals')).toHaveTextContent(/^2/);
    expect(within(activity).getByText('1 uncertain')).toBeInTheDocument();
    const budget = screen.getByRole('region', { name: 'Request budget' });
    expect(within(budget).getByText('Writes per minute')).toBeInTheDocument();
    expect(within(budget).getByText('12 / 120')).toBeInTheDocument();
    expect(within(budget).getAllByRole('img', { name: /per cent used/ })).toHaveLength(4);
    // v2 A1: which project this is, and no warning while every project is active.
    expect(screen.getByTestId('page-project')).toHaveTextContent('Project: baisheng');
    expect(screen.queryByRole('region', { name: /need(s)? attention/ })).toBeNull();
  });

  it('flags an unreachable LegendKeeper and an unpaid plan', async () => {
    installApi({
      ...baseRoutes(),
      'GET /overview': overview({
        health: {
          checkedAt: Date.now(),
          reachable: false,
          projectName: null,
          keyRole: 'unknown',
          plan: 'unpaid',
          note: 'LegendKeeper could not be reached.',
        },
        writes: { state: 'paused', perMinute: 0 },
      }),
    });
    renderApp('/ui');
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
    expect(screen.getByText('paid plan needed')).toBeInTheDocument();
    expect(screen.getByText('LegendKeeper could not be reached.')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('shows a plain error with a retry when the API fails', async () => {
    installApi({
      ...baseRoutes(),
      'GET /overview': {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } },
      },
    });
    renderApp('/ui');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on the server.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Jobs', () => {
  const list = [
    job(),
    job({
      id: 'job_2',
      title: 'Needs a look',
      status: 'failed',
      uncertain: true,
      progress: { stepsDone: 3, stepsTotal: 4, stepsFailed: 1 },
      principalId: 'pat_zzz',
      profile: 'ChatGPT',
      origin: { kind: 'mcp', tool: 'lk_api_write' },
    }),
    job({ id: 'job_3', title: 'Waiting job', status: 'waiting_budget', resumeAt: Date.now() + 90_000 }),
  ];
  const routes = () => ({
    ...baseRoutes(),
    'GET /jobs': (c: { query: string }) => ({
      jobs: c.query.includes('view=history') ? [list[1]] : [list[0], list[2]],
      hasMore: false,
    }),
  });

  it('lists active jobs with progress, the current step, origin and principal, and the controls', async () => {
    installApi(routes());
    renderApp('/ui/jobs');
    const row = await screen.findByRole('row', { name: /Rewrite the Kingdom page/ });
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(within(row).getByText('2 / 10 steps')).toBeInTheDocument();
    expect(within(row).getByText('Step 3')).toBeInTheDocument();
    expect(within(row).getByText(/mcp/)).toBeInTheDocument();
    expect(within(row).getByText('Claude Code')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    const waiting = screen.getByRole('row', { name: /Waiting job/ });
    expect(within(waiting).getByText('Waiting for budget')).toBeInTheDocument();
    expect(within(waiting).getByText(/resumes in 1 min/)).toBeInTheDocument();
  });

  it('shows history with the uncertain flag clearly, and no controls on finished jobs', async () => {
    installApi(routes());
    renderApp('/ui/jobs?view=history');
    const row = await screen.findByRole('row', { name: /Needs a look/ });
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(row).getByText('uncertain')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('filters by status, origin, profile and principal through the API', async () => {
    const api = installApi(routes());
    renderApp('/ui/jobs?status=running&origin=mcp&profile=Claude%20Code&principal=pat_abc');
    await screen.findByRole('row', { name: /Rewrite/ });
    const q = new URLSearchParams(api.find('GET', '/jobs').at(-1)!.query);
    expect(q.get('status')).toBe('running');
    expect(q.get('origin')).toBe('mcp');
    expect(q.get('profile')).toBe('Claude Code');
    expect(q.get('principalId')).toBe('pat_abc');
    expect(q.get('view')).toBe('active');
    expect(q.get('project')).toBe('baisheng'); // v2 A1: the selected (here the default) project
  });

  it('shows a job’s detail: steps, attempts, request ids with a copy button, errors, artefacts', async () => {
    installApi({
      ...baseRoutes(),
      'GET /jobs/job_2': {
        job: {
          ...list[1],
          lastError: {
            code: 'VALIDATION_ERROR',
            message: 'The name is not allowed',
            requestId: 'lkb.req-9',
            stepNo: 2,
          },
          steps: [
            step(),
            step({
              stepNo: 2,
              status: 'failed',
              attempts: 3,
              requestIds: ['lkb.req-8', 'lkb.req-9'],
              error: { code: 'VALIDATION_ERROR', message: 'The name is not allowed', requestId: 'lkb.req-9' },
              retry: { allowed: true, ambiguous: false, warning: null },
            }),
          ],
          artifacts: [
            {
              id: 'art_1',
              jobId: 'job_2',
              stepNo: null,
              kind: 'result',
              itemCount: 0,
              bytes: 2048,
              truncated: false,
              truncatedReason: null,
            },
          ],
        },
      },
    });
    renderApp('/ui/jobs/job_2');
    expect(await h1('Needs a look')).toBeInTheDocument();
    expect(screen.getByText(/At least one step may or may not have been applied/)).toBeInTheDocument();
    expect(screen.getAllByText('uncertain').length).toBeGreaterThan(0);
    const failed = screen.getByRole('row', { name: /VALIDATION_ERROR/ });
    expect(within(failed).getByText('3')).toBeInTheDocument();
    expect(within(failed).getAllByRole('button', { name: 'Copy request id' })).toHaveLength(2); // one per request id
    expect(within(failed).getByRole('button', { name: 'Retry step' })).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });
});

describe('Errors', () => {
  const group = {
    fingerprint: 'createResource|VALIDATION_ERROR|name',
    opId: 'createResource',
    code: 'VALIDATION_ERROR',
    path: 'name',
    classification: 'user_fixable',
    count: 14,
    firstSeen: Date.now() - 3_600_000,
    lastSeen: Date.now() - 60_000,
    resolved: false,
    lastMessage: 'The name is not allowed',
    lastRequestId: 'lkb.req-5',
    lastJobId: 'job_9',
  };
  const occurrence = {
    id: 1,
    at: Date.now() - 60_000,
    opId: 'createResource',
    jobId: 'job_9',
    stepNo: 2,
    principalId: 'pat_abc',
    profile: 'Claude Code',
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'The name is not allowed',
    issues: [{ path: 'name', message: 'too long' }],
    requestId: 'lkb.req-5',
    retryable: false,
    classification: 'user_fixable',
    detail: { status: 400, body: { message: 'The name is not allowed', code: 'VALIDATION_ERROR' } },
    resolvedAt: null,
  };

  it('lists groups with count, first and last seen', async () => {
    installApi({ ...baseRoutes(), 'GET /errors': { groups: [group] } });
    renderApp('/ui/errors');
    const row = await screen.findByRole('row', { name: /createResource/ });
    expect(within(row).getByText('VALIDATION_ERROR')).toBeInTheDocument();
    expect(within(row).getByText('user fixable')).toBeInTheDocument();
    expect(within(row).getByText('14')).toBeInTheDocument();
    expect(within(row).getByText('The name is not allowed')).toBeInTheDocument();
  });

  it('shows the full LegendKeeper body, a copy button for the request id, the job link and marks resolved', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /errors/group': { group, occurrences: [occurrence] },
      'POST /errors/resolve': { resolved: 14 },
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp(`/ui/errors?fp=${encodeURIComponent(group.fingerprint)}`);
    expect(await screen.findByText('lkb.req-5')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Job job_9/ })).toHaveAttribute('href', '/ui/jobs/job_9');
    expect(screen.getByText(/step 2/)).toBeInTheDocument();
    expect(screen.getByText('name', { selector: 'span.mono' })).toBeInTheDocument();
    await user.click(screen.getByText('Full LegendKeeper error body'));
    expect(screen.getByLabelText('JSON')).toHaveTextContent('"code": "VALIDATION_ERROR"');
    await user.click(screen.getByRole('button', { name: 'Copy request id' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('lkb.req-5'));
    expect(screen.getByText('Copied')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(api.find('POST', '/errors/resolve')).toHaveLength(1));
    expect(api.find('POST', '/errors/resolve')[0]!.body).toEqual({ fingerprint: group.fingerprint });
    expect(projectOf(api.find('POST', '/errors/resolve')[0]!)).toBe('baisheng'); // resolved within the project
  });
});

describe('Request Budgets', () => {
  const budgets = () => ({
    snapshot: snapshot({
      'project-hour': { drift: { atMs: Date.now(), observedUsed: 2600, modelledUsed: 2000, delta: 600 } },
      'write-min': { blockedUntilMs: Date.now() + 20_000 },
    }),
    writesPerMinute: 12,
    tierOrder: [
      'write-min',
      'write-hour',
      'key-min',
      'key-hour',
      'key-day',
      'project-hour',
      'items-min',
      'items-hour',
      'upload',
    ],
    reserveFloors: {
      current: { interactive: 0.1, job: 0.25, maintenance: 0.5 },
      environment: { interactive: 0.1, job: 0.25, maintenance: 0.5 },
      stored: null,
    },
    projectDrift: { atMs: Date.now(), observedUsed: 2600, modelledUsed: 2000, delta: 600 },
    samples: {
      since: Date.now() - 86_400_000,
      until: Date.now(),
      bucketMs: 300_000,
      count: 3,
      points: [0, 1, 2, 3].map((i) => ({
        at: Date.now() - (4 - i) * 300_000,
        tiers: { 'write-min': { used: i * 10, limit: 120 } },
        queues: {},
      })),
    },
  });

  it('shows one gauge per tier, upload as “reactive only”, sparklines, drift, queue depth and floors', async () => {
    installApi({ ...baseRoutes(), 'GET /budgets': budgets() });
    renderApp('/ui/budgets');
    expect(await h1('Request Budgets')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent('12 / 120');
    expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent(/refused for 20 s/);
    expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent(/resets in/);
    expect(screen.getByRole('region', { name: 'Image uploads' })).toHaveTextContent('reactive only');
    for (const name of [
      'Writes per hour',
      'All requests per minute',
      'All requests per hour',
      'All requests per day',
      'Project, per hour (all keys)',
      'Bulk-create items per minute',
      'Bulk-create items per hour',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(
      screen.getByRole('img', { name: 'Writes per minute: usage over the last 24 hours' }),
    ).toBeInTheDocument();
    const drift = screen.getByRole('region', { name: /observed against modelled/ });
    expect(drift).toHaveTextContent('2,600');
    expect(drift).toHaveTextContent('2,000');
    expect(drift).toHaveTextContent('+600');
    const queues = screen.getByRole('region', { name: 'Waiting for budget' });
    expect(queues).toHaveTextContent('P1 · interactive (agents)');
    expect(within(queues).getByText('14')).toBeInTheDocument();
    expect(screen.getByLabelText('Jobs (P2)')).toHaveValue('25');
  });

  it('E5.5: lists the learned operation limits: group, operations seen, limit, window, remaining, last seen, expiry', async () => {
    const now = Date.now();
    const b = budgets();
    b.snapshot = {
      ...b.snapshot,
      operationTiers: [
        {
          id: 'group:assets',
          group: 'assets',
          ops: ['createAssetFolder', 'createImageUpload'],
          limit: 20,
          windowMs: 60_000,
          used: 7,
          remaining: 13,
          reportedRemaining: 13,
          resetAtMs: now + 30_000,
          firstSeenAtMs: now - 90_000,
          lastSeenAtMs: now - 30_000,
          expiresAtMs: now + 90_000,
          blockedUntilMs: now + 12_000,
          inFlight: 0,
        },
      ],
    } as typeof b.snapshot;
    installApi({ ...baseRoutes(), 'GET /budgets': b });
    renderApp('/ui/budgets');
    const card = await screen.findByRole('region', { name: 'Learned operation limits' });
    const table = within(card).getByRole('table', { name: 'Learned operation limits' });
    const row = within(table).getAllByRole('row')[1]!;
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells[0]).toMatch(/^assets refused for 1[12] s$/);
    expect(cells.slice(1, 5)).toEqual(['createAssetFolder, createImageUpload', '20', 'minute', '13 of 20']);
    expect(cells[5]).toMatch(/^3\d s ago$/);
    expect(cells[6]).toMatch(/^in 1 min [23]\d s$/);
    // The documented write tier is untouched by it.
    expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent('12 / 120');
  });

  it('E5.5: says when no operation limit has been learned', async () => {
    installApi({ ...baseRoutes(), 'GET /budgets': budgets() });
    renderApp('/ui/budgets');
    const card = await screen.findByRole('region', { name: 'Learned operation limits' });
    expect(card).toHaveTextContent('None learned: LegendKeeper has reported only its documented limits.');
  });

  it('edits the reserve floors with a confirmation, and refuses an invalid order', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /budgets': budgets(),
      'PUT /budgets/reserve-floors': { reserveFloors: {} },
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp('/ui/budgets');
    const job = await screen.findByLabelText('Jobs (P2)');
    await user.clear(job);
    await user.type(job, '5'); // below interactive (10): invalid
    expect(screen.getByRole('alert')).toHaveTextContent(/interactive ≤ jobs ≤ maintenance/);
    expect(screen.getByRole('button', { name: 'Save floors' })).toBeDisabled();
    await user.clear(job);
    await user.type(job, '30');
    await user.click(screen.getByRole('button', { name: 'Save floors' }));
    expect(api.find('PUT', '/budgets/reserve-floors')).toHaveLength(0); // asks first
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save floors' }));
    await waitFor(() => expect(api.find('PUT', '/budgets/reserve-floors')).toHaveLength(1));
    expect(api.find('PUT', '/budgets/reserve-floors')[0]!.body).toEqual({
      interactive: 0.1,
      job: 0.3,
      maintenance: 0.5,
      confirm: true,
    });
  });
});

describe('Concurrent Writers', () => {
  const writers = (over: Record<string, unknown> = {}) => ({
    writers: {
      max: 2,
      busy: 1,
      slots: [
        {
          slot: 1,
          state: 'busy',
          jobId: 'job_1',
          stepNo: 4,
          opId: 'replaceDocumentBlocks',
          profile: 'Claude Code',
          principalId: 'pat_abc',
          documentId: 'doc_77',
          since: Date.now() - 5000,
        },
        { slot: 2, state: 'idle' },
      ],
      waiting: [{ jobId: 'job_2', stepNo: 1, opId: 'updateResource' }],
    },
    locks: [
      {
        key: 'doc:doc_77',
        holder: { jobId: 'job_1', stepNo: 4, since: Date.now() - 5000 },
        waiting: [{ jobId: 'job_2', stepNo: 1, since: Date.now() - 2000 }],
      },
    ],
    controls: controls(),
    jobs: {
      job_1: {
        title: 'Rewrite the Kingdom page',
        status: 'running',
        profile: 'Claude Code',
        principalId: 'pat_abc',
      },
      job_2: {
        title: 'Rename the nations',
        status: 'waiting_lock',
        profile: 'ChatGPT',
        principalId: 'pat_x',
      },
    },
    writesPerMinute: 42,
    writeMinuteLimit: 120,
    writeSpacingMs: 500,
    ...over,
  });

  it('shows slot cards (busy with job, op, document, principal; or idle), held locks, wait queues and the rate', async () => {
    installApi({ ...baseRoutes(), 'GET /writers': writers() });
    renderApp('/ui/writers');
    expect(await h1('Concurrent Writers')).toBeInTheDocument();
    const busy = document.querySelector('[data-slot="1"]') as HTMLElement;
    expect(busy).toHaveAttribute('data-state', 'busy');
    expect(within(busy).getByRole('link', { name: 'Rewrite the Kingdom page' })).toBeInTheDocument();
    expect(within(busy).getByText('replaceDocumentBlocks')).toBeInTheDocument();
    expect(within(busy).getByText('doc_77')).toBeInTheDocument();
    expect(within(busy).getByText('Claude Code')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="2"]')).toHaveTextContent('Idle');
    expect(screen.getByText('Slots (1 of 2 busy)')).toBeInTheDocument();
    expect(screen.getByTestId('writes-per-minute')).toHaveTextContent('42');
    const locks = screen.getByRole('region', { name: /Held locks/ });
    expect(locks).toHaveTextContent('doc:doc_77');
    expect(within(locks).getByRole('link', { name: 'Rename the nations' })).toBeInTheDocument();
    expect(within(locks).getByText('Waiting for a lock')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a slot')).toBeInTheDocument();
  });

  it('pauses all writes after a confirmation, and drains', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /writers': writers(),
      'POST /writes/pause': { controls: controls({ writesPaused: true }) },
      'POST /writes/drain': { controls: controls({ draining: true }) },
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp('/ui/writers');
    await user.click(await screen.findByRole('button', { name: 'Pause all writes' }));
    expect(api.find('POST', '/writes/pause')).toHaveLength(0);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pause all writes' }),
    );
    await waitFor(() => expect(api.find('POST', '/writes/pause')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Drain' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start draining' }));
    await waitFor(() => expect(api.find('POST', '/writes/drain')).toHaveLength(1));
  });

  it('offers Resume when writes are paused and Stop draining when draining', async () => {
    installApi({
      ...baseRoutes(),
      'GET /writers': writers({ controls: controls({ writesPaused: true, draining: true }) }),
    });
    renderApp('/ui/writers');
    expect(await screen.findByRole('button', { name: 'Resume writes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop draining' })).toBeInTheDocument();
    expect(screen.getByText('draining')).toBeInTheDocument();
  });
});

describe('Clients & Access', () => {
  it('shows profiles with kind and scope, the default scope, and connections grouped by profile with last use', async () => {
    installApi(baseRoutes());
    renderApp('/ui/clients');
    expect(await h1('Clients & Access')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Default scope for new connections' })).toHaveValue('read');
    const prof = screen.getByRole('region', { name: 'Profiles' });
    const ccRow = within(prof).getByRole('row', { name: /claude-code/ });
    expect(within(ccRow).getByLabelText('Scope for claude-code')).toHaveValue('write');
    expect(ccRow).toHaveTextContent('claude-code');
    const conns = screen.getByRole('region', { name: /Connections, by profile/ });
    const grant = within(conns).getByRole('row', { name: /Claude \(untrusted name\)/ });
    expect(within(grant).getByText('OAuth grant')).toBeInTheDocument();
    expect(within(grant).getByText('2 min ago')).toBeInTheDocument();
    const pat = within(conns).getByRole('row', { name: /Laptop/ });
    expect(within(pat).getByText('Personal access token')).toBeInTheDocument();
    expect(within(pat).getByText('never')).toBeInTheDocument(); // last used
    expect(within(pat).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(connections).toHaveLength(2);
    expect(profiles).toHaveLength(2);
  });
});

describe('Journal', () => {
  const entry = {
    id: 7,
    at: Date.now() - 5000,
    jobId: 'job_1',
    stepNo: 1,
    opId: 'replaceDocumentBlocks',
    principalId: 'pat_abc',
    profile: 'Claude Code',
    approvedBy: 'owner',
    risk: 'destructive',
    targetKind: 'document',
    targetId: 'doc_77',
    resourceId: 'res_1',
    documentId: 'doc_77',
    version: 'v3',
    params: { path: { documentId: 'doc_77' } },
    bytes: 4096,
    outcome: 'applied',
  };
  it('lists entries with principal, profile and approvedBy, searches them, and views the pre-image as formatted JSON (view only)', async () => {
    installApi({
      ...baseRoutes(),
      'GET /journal': {
        entries: [
          entry,
          {
            ...entry,
            id: 8,
            opId: 'deleteResource',
            approvedBy: null,
            documentId: null,
            targetId: 'res_9',
            principalId: 'system',
            profile: 'system',
          },
        ],
        hasMore: false,
        // ADR 0033: a removed connection is named from its tombstone, never shown as a bare id.
        principals: {
          pat_abc: {
            id: 'pat_abc',
            name: 'Laptop (removed 10 Nov 2026)',
            type: 'removed',
            removedAt: Date.UTC(2026, 10, 10),
          },
          system: { id: 'system', name: 'System', type: 'system', removedAt: null },
        },
      },
      'GET /journal/7': {
        entry: {
          ...entry,
          preImage: { blocks: [{ kind: 'paragraph', content: [{ text: 'The old text' }] }] },
        },
      },
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp('/ui/journal');
    const row = await screen.findByRole('row', { name: /replaceDocumentBlocks/ });
    expect(within(row).getByText('Claude Code')).toBeInTheDocument();
    expect(within(row).getByText('Laptop (removed 10 Nov 2026)')).toBeInTheDocument();
    expect(within(row).queryByText('pat_abc')).toBeNull();
    expect(within(row).getByText('owner')).toBeInTheDocument();
    expect(within(row).getByText('applied')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search these results'), 'deleteRes');
    expect(screen.queryByRole('row', { name: /replaceDocumentBlocks/ })).toBeNull();
    expect(screen.getByRole('row', { name: /deleteResource/ })).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Search these results'));
    await user.click(
      within(await screen.findByRole('row', { name: /replaceDocumentBlocks/ })).getByRole('button', {
        name: 'View',
      }),
    );
    const json = await screen
      .findByLabelText('JSON', { selector: 'pre' }, { timeout: 3000 })
      .catch(() => null);
    expect(json ?? screen.getAllByLabelText('JSON')[0]).toHaveTextContent('"text": "The old text"');
    // View only: nothing on the page can change the journal.
    expect(screen.queryByRole('button', { name: /delete|restore|roll ?back|undo/i })).toBeNull();
  });

  it('pages older entries with the before cursor and filters by outcome and destructive writes (chunk 8)', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /journal': (call: { query: string }) => {
        const before = new URLSearchParams(call.query).get('before');
        return before === '500'
          ? {
              entries: [{ ...entry, id: 499, opId: 'insertBlock', risk: 'safe' }],
              hasMore: false,
              nextBefore: null,
            }
          : {
              entries: [{ ...entry, id: 500, opId: 'createResource', risk: 'safe' }],
              hasMore: true,
              nextBefore: 500,
            };
      },
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp('/ui/journal');
    expect(await screen.findByText(/Every write the bridge sends/)).toBeInTheDocument();
    await screen.findByRole('row', { name: /createResource/ });
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await screen.findByRole('row', { name: /insertBlock/ });
    expect(api.find('GET', '/journal').at(-1)?.query).toMatch(/before=500/);
    expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Newest' }));
    await screen.findByRole('row', { name: /createResource/ });
    await user.selectOptions(screen.getByLabelText('Outcome'), 'not_applied');
    await user.selectOptions(screen.getByLabelText('Writes'), 'true');
    const last = api.find('GET', '/journal').at(-1)?.query ?? '';
    expect(last).toMatch(/outcome=not_applied/);
    expect(last).toMatch(/withPreImage=true/);
    expect(last).not.toMatch(/before=/);
  });
});

describe('Settings', () => {
  it('shows every group, the pending-restart ones, and recent audited changes', async () => {
    installApi({
      ...baseRoutes(),
      'GET /settings': { settings: settingsView() },
      'GET /settings/config': configView(),
      'GET /audit': {
        entries: [
          {
            id: 1,
            at: Date.now(),
            actor: 'owner',
            action: 'settings.read_only',
            target: null,
            before: null,
            after: null,
          },
        ],
      },
    });
    renderApp('/ui/settings');
    expect(await h1('Settings')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Read-only mode' })).toHaveTextContent('on now');
    expect(screen.getByRole('region', { name: 'Images and uploads' })).toHaveTextContent('pending restart');
    expect(screen.getByRole('region', { name: 'Tier limit overrides' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent changes' })).toHaveTextContent('settings.read_only');
  });
});

describe('Proposals page, empty states', () => {
  it('says nothing is waiting', async () => {
    installApi({ ...baseRoutes(), 'GET /proposals': { proposals: [], hasMore: false } });
    renderApp('/ui/proposals');
    expect(await screen.findByText('Nothing is waiting for you.')).toBeInTheDocument();
  });
});
