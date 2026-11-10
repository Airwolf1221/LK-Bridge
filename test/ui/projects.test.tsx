// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON replies and mock data in tests */
/**
 * v2 A1, several projects on the dashboard: the project switcher and what it scopes, the Projects page (flags, status,
 * keys by variable name only, the audited read-only flag), every project's budgets side by side, and the Overview's
 * warning for a project that is not active.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  OTHER_PROJECT_ID,
  PROJECT_ID,
  baseRoutes,
  budgetEvent,
  controls,
  installApi,
  job,
  openStream,
  otherProject,
  project,
  projectOf,
  projectsJson,
  renderApp,
  snapshot,
  useDom,
  type Call,
} from './helpers';

useDom();

const switcher = () => screen.findByLabelText<HTMLSelectElement>('Project');
const nav = () => screen.getByRole('navigation', { name: 'Main' });

function overview(over: Record<string, unknown> = {}) {
  const snap = snapshot();
  return {
    project: { id: PROJECT_ID, name: 'baisheng' },
    projects: [
      { name: 'baisheng', id: PROJECT_ID, status: 'active', reason: null, isDefault: true, readOnly: false },
      {
        name: 'test',
        id: OTHER_PROJECT_ID,
        status: 'active',
        reason: null,
        isDefault: false,
        readOnly: false,
      },
    ],
    health: {
      checkedAt: Date.now(),
      reachable: true,
      projectName: 'Baisheng',
      keyRole: 'ADMIN',
      plan: 'ok',
      note: null,
    },
    controls: controls(),
    activeJobs: { total: 0, running: 0, queued: 0, waiting: 0, paused: 0, uncertain: 0 },
    errorsLastHour: { count: 0, capped: false },
    pendingProposals: 2,
    writes: { state: 'running', perMinute: 12 },
    budget: {
      queues: snap.queues,
      gauges: ['write-min', 'key-min', 'key-hour', 'project-hour'].map(
        (t) => snap.tiers[t as keyof typeof snap.tiers],
      ),
    },
    ...over,
  };
}

/** Each project has its own jobs: the handler answers by the `project` parameter. */
const jobsByProject = (c: Call) => ({
  jobs:
    projectOf(c) === 'test'
      ? [job({ id: 'job_t', projectId: OTHER_PROJECT_ID, title: 'Sandbox clean-up' })]
      : [job()],
  hasMore: false,
});

describe('the project switcher', () => {
  it('starts on the default project, scopes the Jobs requests to it, and re-fetches when another is chosen', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /jobs': jobsByProject });
    const user = userEvent.setup();
    renderApp('/ui/jobs');
    await screen.findByRole('row', { name: /Rewrite the Kingdom page/ });
    const select = await switcher();
    expect(select).toHaveValue('baisheng');
    expect(within(select).getByRole('option', { name: 'baisheng (default)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'test' })).toBeInTheDocument();
    expect(screen.getByTestId('page-project')).toHaveTextContent('Project: baisheng');
    // Every request for jobs names the project; none went out before the project was known.
    expect(api.find('GET', '/jobs').length).toBeGreaterThan(0);
    expect(api.find('GET', '/jobs').map(projectOf)).toEqual(api.find('GET', '/jobs').map(() => 'baisheng'));

    const before = api.find('GET', '/jobs').length;
    await user.selectOptions(select, 'test');
    expect(await screen.findByRole('row', { name: /Sandbox clean-up/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Rewrite the Kingdom page/ })).toBeNull();
    expect(api.find('GET', '/jobs').length).toBeGreaterThan(before);
    expect(projectOf(api.find('GET', '/jobs').at(-1)!)).toBe('test');
    expect(screen.getByTestId('page-project')).toHaveTextContent('Project: test');
    expect(window.localStorage.getItem('lkb-project')).toBe('test'); // remembered in this browser
  });

  it('uses the project remembered in this browser', async () => {
    window.localStorage.setItem('lkb-project', 'test');
    const api = installApi({ ...baseRoutes(), 'GET /errors': { groups: [] } });
    renderApp('/ui/errors');
    expect(await screen.findByText('No open errors. Good.')).toBeInTheDocument();
    expect(await switcher()).toHaveValue('test');
    expect(api.find('GET', '/errors').map(projectOf)).toEqual(api.find('GET', '/errors').map(() => 'test'));
    expect(screen.getByTestId('page-project')).toHaveTextContent('Project: test');
  });

  it('falls back to the default project when the remembered one is no longer known', async () => {
    window.localStorage.setItem('lkb-project', 'retired');
    const api = installApi({ ...baseRoutes(), 'GET /errors': { groups: [] } });
    renderApp('/ui/errors');
    await screen.findByText('No open errors. Good.');
    expect(await switcher()).toHaveValue('baisheng');
    expect(projectOf(api.find('GET', '/errors').at(-1)!)).toBe('baisheng');
  });

  it('cannot choose a project whose key has not proved its id yet, and says when the chosen one is stopped', async () => {
    window.localStorage.setItem('lkb-project', 'test');
    installApi({
      ...baseRoutes(),
      'GET /projects': projectsJson([
        project(),
        otherProject({ status: 'stopped', reason: 'LegendKeeper refused the key (401).', keyValid: false }),
        project({
          name: 'arkona',
          id: null,
          isDefault: false,
          registered: false,
          status: 'verifying',
          keyValid: null,
        }),
      ]),
      'GET /errors': { groups: [] },
    });
    renderApp('/ui/errors');
    const select = await switcher();
    expect(within(select).getByRole('option', { name: /^arkona/ })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'test · stopped' })).toBeEnabled();
    expect(
      await screen.findByText('This project is stopped: LegendKeeper refused the key (401).'),
    ).toBeInTheDocument();
  });

  const writersJson = {
    writers: { max: 2, busy: 0, slots: [], waiting: [] },
    locks: [],
    controls: controls(),
    jobs: {},
    writesPerMinute: 0,
    writeMinuteLimit: 120,
    writeSpacingMs: 500,
  };

  it.each([
    ['/ui/errors', 'GET /errors', { groups: [] }],
    ['/ui/journal', 'GET /journal', { entries: [], hasMore: false, nextBefore: null }],
    ['/ui/proposals', 'GET /proposals', { proposals: [], hasMore: false }],
    ['/ui/mappings', 'GET /mappings', { sets: [], expectedKinds: [], suggestedTypes: [] }],
    ['/ui', 'GET /overview', overview()],
    ['/ui/writers', 'GET /writers', writersJson],
  ] as const)('scopes %s to the chosen project', async (path, route, body) => {
    window.localStorage.setItem('lkb-project', 'test');
    const api = installApi({ ...baseRoutes(), [route]: body });
    renderApp(path);
    const routePath = route.slice('GET '.length);
    await waitFor(() => expect(api.find('GET', routePath).length).toBeGreaterThan(0));
    expect(api.find('GET', routePath).map(projectOf)).toEqual(api.find('GET', routePath).map(() => 'test'));
  });

  it('ignores live job events from another project', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /jobs': { jobs: [], hasMore: false } });
    renderApp('/ui/jobs');
    await screen.findByText('Nothing is running or waiting.');
    const stream = await openStream();
    await waitFor(() => expect(api.find('GET', '/jobs').length).toBeGreaterThanOrEqual(2));
    act(() =>
      stream.emit('job', {
        type: 'created',
        job: job({ id: 'elsewhere', projectId: OTHER_PROJECT_ID, title: 'In the sandbox' }),
      }),
    );
    act(() =>
      stream.emit('job', {
        type: 'created',
        job: job({ id: 'here', projectId: PROJECT_ID, title: 'In Baisheng' }),
      }),
    );
    expect(await screen.findByRole('row', { name: /In Baisheng/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /In the sandbox/ })).toBeNull();
  });

  it('counts the chosen project’s pending proposals on the badge, and names the other projects’ pending ones', async () => {
    installApi({ ...baseRoutes(), 'GET /overview': overview() });
    const user = userEvent.setup();
    renderApp('/ui');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await waitFor(() =>
      expect(within(nav()).getByRole('link', { name: /^Proposals/ })).toHaveTextContent('2'),
    );
    expect(screen.getByTestId('pending-elsewhere')).toHaveTextContent('test 5');
    await user.selectOptions(await switcher(), 'test');
    await waitFor(() =>
      expect(within(nav()).getByRole('link', { name: /^Proposals/ })).toHaveTextContent('5'),
    );
    expect(screen.getByTestId('pending-elsewhere')).toHaveTextContent('baisheng 2');
  });
});

describe('Projects page', () => {
  const projects = () =>
    projectsJson([
      {
        ...project({
          settings: {
            aiRepositoryRootId: 'r_ai_root',
            templateIds: { characterCore: 't_char' },
          },
        }),
        // Never sent by the bridge; if a payload ever carried one, the page must still not show it.
        apiKey: 'lk_live_SECRET_VALUE_1234',
      },
      otherProject({
        readOnly: true,
        status: 'stopped',
        reason: 'The key belongs to another LegendKeeper project than the one stored.',
        keyValid: false,
        settingsProblem: 'the stored settings are not valid JSON',
      }),
      project({
        name: 'arkona',
        id: 'lkp_arkona',
        displayName: null,
        isDefault: false,
        configured: false,
        status: 'not_configured',
        reason: 'No key is configured for this project.',
        keyVariable: null,
        keyPresent: false,
        keyValid: null,
      }),
    ]);

  it('lists every project with its flags, status and reason, and its key by variable name only', async () => {
    installApi({ ...baseRoutes(), 'GET /projects': projects() });
    renderApp('/ui/projects');
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: /^Projects/ })).toHaveAttribute('aria-current', 'page');
    const row = (name: string) => document.querySelector<HTMLElement>(`tr[data-project="${name}"]`)!;

    const main = row('baisheng');
    expect(main).toHaveTextContent('Baisheng');
    expect(main).toHaveTextContent(PROJECT_ID);
    expect(within(main).getByText('default')).toBeInTheDocument();
    expect(within(main).getByText('active')).toBeInTheDocument();
    expect(within(main).getByText('writes allowed')).toBeInTheDocument();
    expect(within(main).getByText('LK_PROJECT_BAISHENG_API_KEY')).toBeInTheDocument();
    expect(within(main).getByText('valid')).toBeInTheDocument();

    const test = row('test');
    expect(test).toHaveTextContent('Test world');
    expect(within(test).getByText('sandbox')).toBeInTheDocument();
    expect(within(test).getByText('read-only')).toBeInTheDocument();
    expect(within(test).getByText('stopped')).toBeInTheDocument();
    expect(test).toHaveTextContent('The key belongs to another LegendKeeper project than the one stored.');
    expect(within(test).getByText('LK_PROJECT_TEST_API_KEY')).toBeInTheDocument();
    expect(within(test).getByText('refused')).toBeInTheDocument();

    const arkona = row('arkona');
    expect(within(arkona).getByText('no key configured')).toBeInTheDocument(); // the status
    expect(within(arkona).getByText('No key')).toBeInTheDocument(); // the key column
    expect(within(arkona).queryByRole('button', { name: /Check the key/ })).toBeNull();

    // A key value never reaches the page, whatever the payload holds.
    expect(document.body.textContent).not.toContain('lk_live_SECRET_VALUE_1234');
    expect(document.body.innerHTML).not.toContain('lk_live_SECRET_VALUE_1234');
  });

  it('shows each project’s settings, with their labels and any problem reading them', async () => {
    installApi({ ...baseRoutes(), 'GET /projects': projects() });
    renderApp('/ui/projects');
    const main = await screen.findByRole('region', { name: 'Settings of baisheng' });
    expect(within(main).getByText('AI REPOSITORY root')).toBeInTheDocument();
    expect(main).toHaveTextContent('r_ai_root');
    expect(main).toHaveTextContent('characterCore → t_char');
    expect(within(main).getByText('Characters root').closest('div')).toHaveTextContent('not set');
    expect(screen.getByRole('region', { name: 'Settings of test' })).toHaveTextContent(
      'the stored settings are not valid JSON',
    );
    // v2 A2: settings are editable (audited); these keys are not marked editable, so they are only shown.
    expect(screen.getByRole('region', { name: 'Settings' })).toHaveTextContent(/Changes are audited/);
    expect(within(screen.getByRole('region', { name: 'Settings' })).queryByRole('textbox')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Settings' })).queryByRole('button', { name: /^Edit/ }),
    ).toBeNull();
  });

  it('makes a project read-only only after a confirmation, sending { value, confirm: true }', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /projects': projects(),
      'PUT /projects/baisheng/read-only': { project: project({ readOnly: true }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    await user.click(await screen.findByRole('button', { name: 'Make baisheng read-only' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Make baisheng read-only?');
    expect(api.find('PUT', /read-only/)).toHaveLength(0); // asks first
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.find('PUT', /read-only/)).toHaveLength(0); // cancelled: nothing sent

    const loads = api.find('GET', '/projects').length;
    await user.click(screen.getByRole('button', { name: 'Make baisheng read-only' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Make read-only' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/read-only')).toHaveLength(1));
    const put = api.find('PUT', '/projects/baisheng/read-only')[0]!;
    expect(put.body).toEqual({ value: true, confirm: true });
    expect(put.headers['x-csrf-token']).toBe('csrf-token-for-tests');
    expect(await screen.findByText('baisheng is now read-only.')).toBeInTheDocument();
    await waitFor(() => expect(api.find('GET', '/projects').length).toBeGreaterThan(loads)); // reloaded
  });

  it('allows writes to a read-only project again after a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /projects': projects(),
      'PUT /projects/test/read-only': { project: otherProject({ readOnly: false }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    await user.click(await screen.findByRole('button', { name: 'Allow writes to test' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Allow writes to test again?');
    expect(api.find('PUT', /read-only/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Allow writes' }));
    await waitFor(() => expect(api.find('PUT', '/projects/test/read-only')).toHaveLength(1));
    expect(api.find('PUT', '/projects/test/read-only')[0]!.body).toEqual({ value: false, confirm: true });
  });

  it('checks a project’s key again', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /projects': projects(),
      'POST /projects/test/verify': { project: otherProject() },
    });
    const user = userEvent.setup();
    renderApp('/ui/projects');
    await user.click(await screen.findByRole('button', { name: 'Check the key of test again' }));
    await waitFor(() => expect(api.find('POST', '/projects/test/verify')).toHaveLength(1));
    expect(await screen.findByText('test: active.')).toBeInTheDocument();
  });
});

describe('Request Budgets, every project side by side', () => {
  const card = (name: string, used: number, status = 'active') => ({
    project: { id: name === 'baisheng' ? PROJECT_ID : OTHER_PROJECT_ID, name },
    status,
    snapshot: snapshot({ 'write-min': { used } }),
    writesPerMinute: used,
    projectDrift: null,
    samples: { since: 0, until: 1, bucketMs: 10_000, count: 0, points: [] },
  });
  const tierOrder = ['write-min', 'write-hour', 'key-min', 'project-hour', 'upload'];

  it('shows one card per project with its own gauges, and moves each from its own live figures', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /budgets/all': { tierOrder, projects: [card('baisheng', 12), card('test', 33, 'unverified')] },
    });
    renderApp('/ui/budgets?view=all');
    const main = await screen.findByRole('region', { name: 'baisheng' });
    const test = screen.getByRole('region', { name: 'test' });
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'true');
    expect(main).toHaveTextContent('12 / 120');
    expect(within(main).getByText('selected')).toBeInTheDocument();
    expect(within(main).getAllByRole('img', { name: /per cent used/ })).toHaveLength(4); // upload: reactive only
    expect(test).toHaveTextContent('33 / 120');
    expect(within(test).getByText('not verified')).toBeInTheDocument();
    expect(projectOf(api.find('GET', '/budgets/all')[0]!)).toBeNull(); // every project: no project parameter

    const stream = await openStream();
    act(() =>
      stream.emit(
        'budget',
        budgetEvent({
          [OTHER_PROJECT_ID]: { snapshot: snapshot({ 'write-min': { used: 90 } }), writesPerMinute: 90 },
        }),
      ),
    );
    await waitFor(() => expect(screen.getByRole('region', { name: 'test' })).toHaveTextContent('90 / 120'));
    expect(screen.getByRole('region', { name: 'baisheng' })).toHaveTextContent('12 / 120');
  });

  it('switches between the selected project and every project', async () => {
    installApi({
      ...baseRoutes(),
      'GET /budgets': {
        project: { id: PROJECT_ID, name: 'baisheng' },
        snapshot: snapshot(),
        writesPerMinute: 12,
        tierOrder,
        reserveFloors: {
          current: { interactive: 0.1, job: 0.25, maintenance: 0.5 },
          environment: { interactive: 0.1, job: 0.25, maintenance: 0.5 },
          stored: null,
        },
        projectDrift: null,
        samples: { since: 0, until: 1, bucketMs: 10_000, count: 0, points: [] },
      },
      'GET /budgets/all': { tierOrder, projects: [card('baisheng', 12), card('test', 33)] },
    });
    const user = userEvent.setup();
    renderApp('/ui/budgets');
    await screen.findByRole('region', { name: 'Writes per minute' });
    expect(screen.getByTestId('page-project')).toHaveTextContent('Project: baisheng');
    await user.click(screen.getByRole('button', { name: 'All projects' }));
    expect(await screen.findByRole('region', { name: 'test' })).toHaveTextContent('33 / 120');
    await user.click(screen.getByRole('button', { name: 'This project (baisheng)' }));
    expect(await screen.findByRole('region', { name: 'Writes per minute' })).toHaveTextContent('12 / 120');
  });
});

describe('Overview, every project’s status', () => {
  it('warns about each project that is not active, with its reason', async () => {
    installApi({
      ...baseRoutes(),
      'GET /overview': overview({
        projects: [
          {
            name: 'baisheng',
            id: PROJECT_ID,
            status: 'active',
            reason: null,
            isDefault: true,
            readOnly: false,
          },
          {
            name: 'test',
            id: OTHER_PROJECT_ID,
            status: 'stopped',
            reason: 'LegendKeeper refused the key (401 UNAUTHORIZED).',
            isDefault: false,
            readOnly: false,
          },
          {
            name: 'arkona',
            id: null,
            status: 'unverified',
            reason: 'LegendKeeper could not be reached; it is checked again shortly.',
            isDefault: false,
            readOnly: false,
          },
        ],
      }),
    });
    renderApp('/ui');
    const panel = await screen.findByRole('region', { name: '2 projects need attention' });
    const item = (name: string) => panel.querySelector<HTMLElement>(`li[data-project="${name}"]`)!;
    expect(within(item('test')).getByText('stopped')).toBeInTheDocument();
    expect(item('test')).toHaveTextContent('LegendKeeper refused the key (401 UNAUTHORIZED).');
    expect(within(item('arkona')).getByText('not verified')).toBeInTheDocument();
    expect(item('arkona')).toHaveTextContent('it is checked again shortly');
    expect(panel.querySelector('li[data-project="baisheng"]')).toBeNull();
    expect(within(panel).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/ui/projects');
  });

  it('says when the project has no budget, and when its own read-only flag is on', async () => {
    installApi({
      ...baseRoutes(),
      'GET /overview': overview({
        budget: null,
        controls: controls({
          readOnly: true,
          project: { id: PROJECT_ID, name: 'baisheng', readOnly: true, available: true },
        }),
      }),
    });
    renderApp('/ui');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.getByRole('region', { name: 'Request budget' })).toHaveTextContent(/No budget to show/);
    const writing = screen.getByRole('region', { name: 'Writing' });
    expect(within(writing).getByText('on: nothing is written')).toBeInTheDocument();
    expect(writing).toHaveTextContent('This project’s own read-only flag is on');
  });
});

describe('Concurrent Writers, shared by every project', () => {
  it('names each busy slot’s and lock’s project, and links to a job in its own project', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /writers': {
        project: { id: PROJECT_ID, name: 'baisheng' },
        writers: {
          max: 2,
          busy: 1,
          slots: [
            {
              slot: 1,
              state: 'busy',
              projectId: OTHER_PROJECT_ID,
              jobId: 'job_t',
              stepNo: 2,
              opId: 'replaceDocumentBlocks',
              profile: 'Claude Code',
              documentId: 'doc_9',
              since: Date.now() - 1000,
            },
            { slot: 2, state: 'idle' },
          ],
          waiting: [{ projectId: PROJECT_ID, jobId: 'job_1', stepNo: 1, opId: 'updateResource' }],
        },
        locks: [
          {
            key: `${OTHER_PROJECT_ID}:doc:doc_9`,
            holder: { jobId: 'job_t', stepNo: 2, since: Date.now() - 1000 },
            waiting: [],
          },
        ],
        controls: controls(),
        jobs: {
          job_t: {
            title: 'Sandbox clean-up',
            status: 'running',
            profile: 'Claude Code',
            principalId: 'p',
            project: 'test',
          },
          job_1: {
            title: 'Rewrite the Kingdom page',
            status: 'queued',
            profile: 'Claude',
            principalId: 'q',
            project: 'baisheng',
          },
        },
        writesPerMinute: 4,
        writeMinuteLimit: 120,
        writeSpacingMs: 500,
      },
    });
    renderApp('/ui/writers');
    await screen.findByRole('heading', { level: 1, name: 'Concurrent Writers' });
    expect(projectOf(api.find('GET', '/writers')[0]!)).toBe('baisheng'); // the budget figures' project
    const slot = document.querySelector<HTMLElement>('[data-slot="1"]')!;
    expect(slot).toHaveTextContent('Projecttest');
    expect(within(slot).getByRole('link', { name: 'Sandbox clean-up' })).toHaveAttribute(
      'href',
      '/ui/jobs/job_t?project=test',
    );
    expect(screen.getByText(/project baisheng/)).toBeInTheDocument(); // the step waiting for a slot
    const lockRow = within(screen.getByRole('region', { name: /Held locks/ })).getByRole('row', {
      name: /doc:doc_9/,
    });
    expect(lockRow).toHaveTextContent('test');
  });

  it('opens a job of another project in that project', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /jobs/job_t': {
        job: {
          ...job({ id: 'job_t', projectId: OTHER_PROJECT_ID, title: 'Sandbox clean-up' }),
          steps: [],
          artifacts: [],
        },
      },
    });
    renderApp('/ui/jobs/job_t?project=test');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sandbox clean-up' })).toBeInTheDocument();
    expect(projectOf(api.find('GET', '/jobs/job_t')[0]!)).toBe('test');
    expect(screen.getByTestId('page-project')).toHaveTextContent('Project: test');
  });
});
