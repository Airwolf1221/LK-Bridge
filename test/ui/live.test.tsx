// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON replies and mock data in tests */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiConfig, signInUrl } from '../../ui/src/api';
import {
  FakeSource,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  baseRoutes,
  budgetEvent,
  controls,
  installApi,
  job,
  lastSource,
  openStream,
  renderApp,
  snapshot,
  useDom,
} from './helpers';

useDom();

/** The first `hello` makes the pages reload once; wait for that to land so it cannot overwrite what a test pushes. */
async function settled(
  api: { find: (m: string, p: string) => unknown[] },
  path: string,
  n = 2,
): Promise<void> {
  await waitFor(() => expect(api.find('GET', path).length).toBeGreaterThanOrEqual(n));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const jobsRoutes = (jobs: unknown[]) => ({
  ...baseRoutes(),
  'GET /jobs': { jobs, hasMore: false },
});

describe('a job’s progress updates live from the stream', () => {
  it('moves the progress bar and the current step without asking the API again', async () => {
    const api = installApi(jobsRoutes([job()]));
    renderApp('/ui/jobs');
    const row = await screen.findByRole('row', { name: /Rewrite the Kingdom page/ });
    expect(within(row).getByText('2 / 10 steps')).toBeInTheDocument();
    const stream = await openStream();
    await settled(api, '/jobs');
    const before = api.find('GET', '/jobs').length;

    act(() =>
      stream.emit('job', {
        type: 'updated',
        job: job({ progress: { stepsDone: 7, stepsTotal: 10, stepsFailed: 0 }, currentStep: 8 }),
      }),
    );
    expect(
      within(await screen.findByRole('row', { name: /Rewrite the Kingdom page/ })).getByText('7 / 10 steps'),
    ).toBeInTheDocument();
    expect(screen.getByText('Step 8')).toBeInTheDocument();
    const bar = screen.getByRole('img', { name: '70 per cent complete' });
    expect(bar).toBeInTheDocument();
    expect(api.find('GET', '/jobs').length).toBe(before); // no extra request: it came from the stream
  });

  it('adds a new job at the top, and moves a finished job out of the active list', async () => {
    const api = installApi(jobsRoutes([job()]));
    renderApp('/ui/jobs');
    await screen.findByRole('row', { name: /Rewrite the Kingdom page/ });
    const stream = await openStream();
    await settled(api, '/jobs');
    act(() =>
      stream.emit('job', {
        type: 'created',
        job: job({
          id: 'job_new',
          title: 'Brand new job',
          status: 'queued',
          progress: { stepsDone: 0, stepsTotal: 3, stepsFailed: 0 },
          currentStep: null,
        }),
      }),
    );
    const rows = await screen.findAllByRole('row');
    expect(rows[1]).toHaveTextContent('Brand new job');
    expect(rows[1]).toHaveTextContent('Queued');

    act(() =>
      stream.emit('job', {
        type: 'updated',
        job: job({
          id: 'job_new',
          title: 'Brand new job',
          status: 'succeeded',
          progress: { stepsDone: 3, stepsTotal: 3, stepsFailed: 0 },
        }),
      }),
    );
    await waitFor(() => expect(screen.queryByRole('row', { name: /Brand new job/ })).toBeNull());
    expect(screen.getByRole('row', { name: /Rewrite the Kingdom page/ })).toBeInTheDocument();
  });

  it('respects the filters when a job event arrives', async () => {
    const api = installApi(jobsRoutes([]));
    renderApp('/ui/jobs?origin=ui');
    await screen.findByText('Nothing is running or waiting.');
    const stream = await openStream();
    await settled(api, '/jobs');
    act(() =>
      stream.emit('job', {
        type: 'created',
        job: job({ id: 'mcp_job', title: 'From an agent', origin: { kind: 'mcp' } }),
      }),
    );
    act(() =>
      stream.emit('job', {
        type: 'created',
        job: job({ id: 'ui_job', title: 'From the dashboard', origin: { kind: 'ui' } }),
      }),
    );
    expect(await screen.findByRole('row', { name: /From the dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /From an agent/ })).toBeNull();
  });

  it('updates the job detail page as the job runs', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /jobs/job_1': { job: { ...job(), steps: [], artifacts: [] } },
    });
    renderApp('/ui/jobs/job_1');
    await screen.findByRole('heading', { level: 1, name: 'Rewrite the Kingdom page' });
    expect(screen.getByText('2 / 10 steps')).toBeInTheDocument();
    const stream = await openStream();
    await settled(api, '/jobs/job_1');
    act(() =>
      stream.emit('job', {
        type: 'updated',
        job: job({ status: 'succeeded', progress: { stepsDone: 10, stepsTotal: 10, stepsFailed: 0 } }),
      }),
    );
    expect(await screen.findByText('10 / 10 steps')).toBeInTheDocument();
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0);
  });
});

describe('the stream connection', () => {
  it('shows whether updates are live, and reloads after a resync but not after a resumed reconnect', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /overview': overviewJson() });
    renderApp('/ui');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.getByRole('status', { name: 'Live updates: Connecting…' })).toBeInTheDocument();
    const stream = await openStream();
    expect(await screen.findByRole('status', { name: 'Live updates: Live' })).toBeInTheDocument();
    await waitFor(() => expect(api.find('GET', '/overview').length).toBe(2)); // initial + the first hello

    act(() => stream.fail());
    expect(await screen.findByRole('status', { name: 'Live updates: Reconnecting…' })).toBeInTheDocument();
    act(() => {
      stream.open();
      stream.emit('hello', { bootId: 'abcd1234', lastId: 5, resumed: true, heartbeatMs: 15_000 });
    });
    expect(await screen.findByRole('status', { name: 'Live updates: Live' })).toBeInTheDocument();
    expect(api.find('GET', '/overview').length).toBe(2); // the bridge replays what was missed: nothing to reload

    act(() => stream.emit('resync', { reason: 'position_unavailable' }));
    await waitFor(() => expect(api.find('GET', '/overview').length).toBe(3)); // too long away: reload what is shown
  });

  it('opens a fresh connection when the stream goes quiet (missed heartbeats)', async () => {
    installApi({ ...baseRoutes(), 'GET /overview': overviewJson() });
    renderApp('/ui');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await waitFor(() => expect(FakeSource.all.length).toBe(1));
    const first = lastSource();
    act(() => {
      first.open();
      first.emit('hello', { bootId: 'abcd1234', lastId: 0, resumed: false, heartbeatMs: 40 });
    });
    // 3 x 40 ms + 1 s of grace, with no heartbeat: the page reconnects by itself.
    await waitFor(() => expect(FakeSource.all.length).toBe(2), { timeout: 3000 });
    expect(first.closed).toBe(true);
  });

  it('sends the page to sign-in when the stream says the session ended, and when any request gets a 401', async () => {
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    apiConfig.onUnauthenticated = onUnauth;
    try {
      installApi({ ...baseRoutes(), 'GET /overview': overviewJson() });
      renderApp('/ui');
      await screen.findByRole('heading', { level: 1, name: 'Overview' });
      apiConfig.onUnauthenticated = onUnauth; // renderApp resets nothing, but be explicit
      const stream = await openStream();
      act(() => stream.emit('unauthenticated', { reason: 'session_ended' }));
      expect(await screen.findByRole('status', { name: 'Live updates: Signed out' })).toBeInTheDocument();
      expect(stream.closed).toBe(true);
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  // ADR 0062: the owner's log showed the stream refused (401) every three seconds for hours, with nothing on the screen.
  it('a stream the bridge refuses, its session ended: the page goes to sign-in instead of reconnecting', async () => {
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    try {
      const api = installApi({
        ...baseRoutes(),
        'GET /overview': overviewJson(),
        'GET /session': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } } },
      });
      renderApp('/ui');
      await screen.findByRole('heading', { level: 1, name: 'Overview' });
      apiConfig.onUnauthenticated = onUnauth;
      await waitFor(() => expect(FakeSource.all.length).toBe(1));
      const stream = lastSource();
      act(() => {
        stream.close(); // the browser gives up on a 401
        stream.fail();
      });
      await waitFor(() => expect(onUnauth).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('status', { name: 'Live updates: Signed out' })).toBeInTheDocument();
      expect(api.find('GET', '/session')).toHaveLength(1);
      expect(FakeSource.all).toHaveLength(1);
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  it('treats a 401 from the API as a signed-out session', async () => {
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    installApi({
      ...baseRoutes(),
      'GET /overview': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } } },
    });
    apiConfig.onUnauthenticated = onUnauth;
    try {
      renderApp('/ui');
      await waitFor(() => expect(onUnauth).toHaveBeenCalled());
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  it('sends a signed-out page to the sign-in page and back to where it was', () => {
    expect(signInUrl('/ui/jobs', '?view=history&status=failed')).toBe(
      '/oauth/login?return_to=%2Fui%2Fjobs%3Fview%3Dhistory%26status%3Dfailed',
    );
  });
});

const overviewJson = () => {
  const snap = snapshot();
  return {
    health: {
      checkedAt: Date.now(),
      reachable: true,
      projectName: 'P',
      keyRole: 'ADMIN',
      plan: 'ok',
      note: null,
    },
    controls: controls(),
    activeJobs: { total: 0, running: 0, queued: 0, waiting: 0, paused: 0, uncertain: 0 },
    errorsLastHour: { count: 0, capped: false },
    pendingProposals: 0,
    writes: { state: 'running', perMinute: 0 },
    budget: {
      queues: snap.queues,
      gauges: ['write-min', 'key-min', 'key-hour', 'project-hour'].map(
        (t) => snap.tiers[t as keyof typeof snap.tiers],
      ),
    },
  };
};

describe('budgets and writers update live', () => {
  it('moves the gauges from budget events', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /budgets': {
        snapshot: snapshot(),
        writesPerMinute: 12,
        tierOrder: ['write-min', 'upload'],
        reserveFloors: {
          current: { interactive: 0.1, job: 0.25, maintenance: 0.5 },
          environment: { interactive: 0.1, job: 0.25, maintenance: 0.5 },
          stored: null,
        },
        projectDrift: null,
        samples: { since: 0, until: 1, bucketMs: 10_000, count: 0, points: [] },
      },
    });
    renderApp('/ui/budgets');
    expect(await screen.findByRole('region', { name: 'Writes per minute' })).toHaveTextContent('12 / 120');
    const stream = await openStream();
    const calls = api.find('GET', '/budgets').length;
    // v2 A1: the event carries every project's budget, by LegendKeeper id. Another project's figures move nothing.
    act(() =>
      stream.emit(
        'budget',
        budgetEvent({
          [OTHER_PROJECT_ID]: { snapshot: snapshot({ 'write-min': { used: 30 } }), writesPerMinute: 30 },
        }),
      ),
    );
    expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent('12 / 120');
    act(() =>
      stream.emit(
        'budget',
        budgetEvent({
          [PROJECT_ID]: { snapshot: snapshot({ 'write-min': { used: 96 } }), writesPerMinute: 96 },
          [OTHER_PROJECT_ID]: { snapshot: snapshot({ 'write-min': { used: 30 } }), writesPerMinute: 30 },
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent('96 / 120'),
    );
    expect(screen.getByRole('region', { name: 'Writes per minute' })).toHaveTextContent('80% used');
    expect(api.find('GET', '/budgets').length).toBe(calls);
  });

  it('changes WRITERS_MAX without a restart: the PUT carries the CSRF token and the slots follow', async () => {
    let max = 2;
    const slots = () => Array.from({ length: max }, (_, i) => ({ slot: i + 1, state: 'idle' }));
    const writers = () => ({
      writers: { max, busy: 0, slots: slots(), waiting: [] },
      locks: [],
      controls: controls({ writersMax: max }),
      jobs: {},
      writesPerMinute: 0,
      writeMinuteLimit: 120,
      writeSpacingMs: 500,
    });
    const api = installApi({
      ...baseRoutes(),
      'GET /writers': writers,
      'PUT /writers/max': (c: { body: unknown }) => {
        max = (c.body as { value: number }).value;
        return { controls: controls({ writersMax: max }) };
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/writers');
    await screen.findByText('Slots (0 of 2 busy)');
    expect(document.querySelectorAll('[data-slot]')).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Writer slots'), '4');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('PUT', '/writers/max')).toHaveLength(1));
    const put = api.find('PUT', '/writers/max')[0]!;
    expect(put.body).toEqual({ value: 4 });
    expect(put.headers['x-csrf-token']).toBe('csrf-token-for-tests');
    await waitFor(() => expect(document.querySelectorAll('[data-slot]')).toHaveLength(4));
    expect(screen.getByText('Slots (0 of 4 busy)')).toBeInTheDocument();
    expect(screen.getByText(/Writer slots set to 4\. In effect now\./)).toBeInTheDocument();
  });

  it('shows a busy slot as soon as the stream says writers changed, and the rate from budget events', async () => {
    let busy = false;
    const api = installApi({
      ...baseRoutes(),
      'GET /writers': () => ({
        writers: {
          max: 2,
          busy: busy ? 1 : 0,
          slots: [
            busy
              ? {
                  slot: 1,
                  state: 'busy',
                  jobId: 'j',
                  stepNo: 1,
                  opId: 'updateResource',
                  profile: 'Claude',
                  since: Date.now(),
                }
              : { slot: 1, state: 'idle' },
            { slot: 2, state: 'idle' },
          ],
          waiting: [],
        },
        locks: [],
        controls: controls(),
        jobs: { j: { title: 'A job', status: 'running', profile: 'Claude', principalId: 'p' } },
        writesPerMinute: 0,
        writeMinuteLimit: 120,
        writeSpacingMs: 500,
      }),
    });
    renderApp('/ui/writers');
    await screen.findByText('Slots (0 of 2 busy)');
    const stream = await openStream();
    busy = true;
    act(() => stream.emit('writers', { max: 2, busy: 1 }));
    await waitFor(() => expect(screen.getByText('Slots (1 of 2 busy)')).toBeInTheDocument(), {
      timeout: 2000,
    });
    // The rate is the selected project's (each project has its own governor), picked from the event by its id.
    act(() =>
      stream.emit(
        'budget',
        budgetEvent({
          [OTHER_PROJECT_ID]: { snapshot: snapshot({ 'write-min': { used: 7 } }), writesPerMinute: 7 },
          [PROJECT_ID]: { snapshot: snapshot({ 'write-min': { used: 61 } }), writesPerMinute: 61 },
        }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('writes-per-minute')).toHaveTextContent('61'));
    expect(api.find('GET', '/writers').length).toBeGreaterThanOrEqual(2);
  });
});
