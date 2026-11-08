// @vitest-environment jsdom

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, openStream, renderApp, useDom } from './helpers';

useDom();

const NOW = Date.now();

const job = (over: Record<string, unknown> = {}) => ({
  id: 'budget-sampler',
  name: 'Budget sampler',
  description: 'Stores one snapshot of the request budgets every 10 seconds.',
  implemented: true,
  writes: false,
  enabled: true,
  schedule: { kind: 'interval', everySeconds: 10 },
  scheduleText: 'Every 10 seconds',
  defaultSchedule: { kind: 'interval', everySeconds: 10 },
  scheduleOverridden: false,
  priority: 'P3',
  running: false,
  lastRun: {
    at: NOW - 4000,
    outcome: 'succeeded',
    durationMs: 12,
    jobId: null,
    detail: 'Stored a budget sample.',
  },
  nextRunAt: NOW + 6000,
  note: null,
  ...over,
});

const placeholder = (id: string, name: string) =>
  job({
    id,
    name,
    description: `Will do ${name}.`,
    implemented: false,
    enabled: false,
    lastRun: null,
    nextRunAt: null,
    note: 'Not implemented yet',
  });

const jobs = () => [
  job(),
  job({
    id: 'journal-prune',
    name: 'Journal prune',
    description: 'Removes old journal entries.',
    schedule: { kind: 'daily', time: '03:30' },
    scheduleText: 'Daily at 03:30 (London time)',
    defaultSchedule: { kind: 'daily', time: '03:30' },
    lastRun: {
      at: NOW - 3_600_000,
      outcome: 'succeeded',
      durationMs: 40,
      jobId: 'jprune1',
      detail: 'Removed 3 journal entries.',
    },
    nextRunAt: NOW + 7_200_000,
  }),
  job({
    id: 'writer',
    name: 'A writing job',
    description: 'Renames things.',
    writes: true,
    lastRun: {
      at: NOW - 60_000,
      outcome: 'skipped',
      durationMs: 0,
      jobId: null,
      detail: 'Skipped: read-only mode is on.',
    },
  }),
  placeholder('assign-block-ids-sweep', 'Assign block IDs sweep'),
  placeholder('tree-snapshot', 'Tree snapshot'),
  placeholder('orphan-and-link-audit', 'Orphan and link audit'),
  placeholder('tag-audit', 'Tag audit'),
];

const routes = (extra: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /maintenance': { jobs: jobs(), schedulerEnabled: true, now: NOW },
  ...extra,
});

const row = (id: string) => document.querySelector<HTMLElement>(`tr[data-job="${id}"]`)!;

describe('the Maintenance Jobs page', () => {
  it('shows the registry: name, status, schedule, class, last run with a link to its job, and next run', async () => {
    installApi(routes());
    renderApp('/ui/maintenance');
    expect(await screen.findByRole('heading', { level: 1, name: 'Maintenance Jobs' })).toBeInTheDocument();
    await screen.findByText('Budget sampler');
    const sampler = within(row('budget-sampler'));
    expect(sampler.getByText('Enabled')).toBeInTheDocument();
    expect(sampler.getByText('Every 10 seconds')).toBeInTheDocument();
    expect(sampler.getByText('P3')).toBeInTheDocument();
    expect(sampler.getByText('succeeded')).toBeInTheDocument();
    expect(sampler.getByText(/in \d+ s/)).toBeInTheDocument();
    const prune = within(row('journal-prune'));
    expect(prune.getByText('Daily at 03:30 (London time)')).toBeInTheDocument();
    expect(prune.getByRole('link', { name: 'job' })).toHaveAttribute('href', '/ui/jobs/jprune1');
    // A skipped run says why.
    expect(within(row('writer')).getByText('skipped')).toBeInTheDocument();
    expect(within(row('writer')).getByText('Skipped: read-only mode is on.')).toBeInTheDocument();
    expect(within(row('writer')).getByText('Writes to LegendKeeper.')).toBeInTheDocument();
  });

  it('lists the four placeholders as not implemented, with disabled toggles that say so', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('Budget sampler');
    for (const [id, name] of [
      ['assign-block-ids-sweep', 'Assign block IDs sweep'],
      ['tree-snapshot', 'Tree snapshot'],
      ['orphan-and-link-audit', 'Orphan and link audit'],
      ['tag-audit', 'Tag audit'],
    ] as const) {
      const r = within(row(id));
      expect(r.getByText('Not implemented')).toBeInTheDocument();
      expect(r.getByText('Not implemented yet')).toBeInTheDocument();
      const toggle = r.getByRole('switch', { name: `Enable ${name}` });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAccessibleDescription('Not implemented yet');
      expect(r.getByRole('button', { name: `Run ${name} now` })).toBeDisabled();
      expect(r.getByRole('button', { name: `Edit the schedule of ${name}` })).toBeDisabled();
      await user.click(toggle);
    }
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('toggles an implemented job off and on', async () => {
    const api = installApi(
      routes({
        'POST /maintenance/budget-sampler/disable': { job: job({ enabled: false }) },
        'POST /maintenance/budget-sampler/enable': { job: job() },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('Budget sampler');
    const toggle = within(row('budget-sampler')).getByRole('switch', { name: 'Enable Budget sampler' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(api.find('POST', '/maintenance/budget-sampler/disable')).toHaveLength(1));
    expect(api.find('POST', '/maintenance/budget-sampler/disable')[0]!.headers['x-csrf-token']).toBe(
      'csrf-token-for-tests',
    );
  });

  it('runs a job now', async () => {
    const api = installApi(
      routes({
        'POST /maintenance/journal-prune/run': { status: 202, body: { job: job({ running: true }) } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('Journal prune');
    await user.click(within(row('journal-prune')).getByRole('button', { name: 'Run Journal prune now' }));
    await waitFor(() => expect(api.find('POST', '/maintenance/journal-prune/run')).toHaveLength(1));
    expect(await screen.findByText('Journal prune started.')).toBeInTheDocument();
  });

  it('edits a schedule: an interval with a unit, or a daily London time, and can restore the default', async () => {
    const api = installApi(
      routes({
        'PUT /maintenance/budget-sampler/schedule': { job: job() },
        'PUT /maintenance/journal-prune/schedule': { job: job() },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('Budget sampler');
    await user.click(
      within(row('budget-sampler')).getByRole('button', { name: 'Edit the schedule of Budget sampler' }),
    );
    const form = await screen.findByRole('form', { name: 'Schedule of Budget sampler' });
    const every = within(form).getByLabelText('Every');
    await user.clear(every);
    await user.type(every, '2');
    await user.selectOptions(within(form).getByLabelText('Unit'), 'minutes');
    await user.click(within(form).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', '/maintenance/budget-sampler/schedule')).toHaveLength(1));
    expect(api.find('PUT', '/maintenance/budget-sampler/schedule')[0]!.body).toEqual({
      schedule: { kind: 'interval', everySeconds: 120 },
    });

    await user.click(
      within(row('journal-prune')).getByRole('button', { name: 'Edit the schedule of Journal prune' }),
    );
    const daily = await screen.findByRole('form', { name: 'Schedule of Journal prune' });
    expect(within(daily).getByLabelText('Runs')).toHaveValue('daily');
    const time = within(daily).getByLabelText('Time (London, 24-hour)');
    expect(time).toHaveValue('03:30');
    await user.clear(time);
    await user.type(time, '04:15');
    await user.click(within(daily).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', '/maintenance/journal-prune/schedule')).toHaveLength(1));
    expect(api.find('PUT', '/maintenance/journal-prune/schedule')[0]!.body).toEqual({
      schedule: { kind: 'daily', time: '04:15' },
    });
  });

  it('will not submit an interval below 10 seconds', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('Budget sampler');
    await user.click(
      within(row('budget-sampler')).getByRole('button', { name: 'Edit the schedule of Budget sampler' }),
    );
    const form = await screen.findByRole('form', { name: 'Schedule of Budget sampler' });
    const every = within(form).getByLabelText('Every');
    await user.clear(every);
    await user.type(every, '5');
    expect(within(form).getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    expect(within(form).getByRole('alert')).toHaveTextContent(/between 10 seconds and 31 days/);
    expect(api.find('PUT', /schedule/)).toHaveLength(0);
  });

  it('restores the default schedule', async () => {
    const api = installApi(
      routes({
        'GET /maintenance': {
          jobs: [
            job({
              scheduleOverridden: true,
              schedule: { kind: 'interval', everySeconds: 60 },
              scheduleText: 'Every minute',
            }),
          ],
          schedulerEnabled: true,
          now: NOW,
        },
        'PUT /maintenance/budget-sampler/schedule': { job: job() },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('edited');
    await user.click(screen.getByRole('button', { name: 'Edit the schedule of Budget sampler' }));
    await user.click(await screen.findByRole('button', { name: 'Use the default' }));
    await waitFor(() => expect(api.find('PUT', '/maintenance/budget-sampler/schedule')).toHaveLength(1));
    expect(api.find('PUT', '/maintenance/budget-sampler/schedule')[0]!.body).toEqual({ schedule: null });
  });

  it('shows a job’s recent runs, with links to their jobs', async () => {
    installApi(
      routes({
        'GET /maintenance/journal-prune': {
          job: {
            ...jobs()[1],
            history: [
              {
                id: 2,
                trigger: 'catch-up',
                startedAt: NOW - 1000,
                outcome: 'succeeded',
                durationMs: 5,
                engineJobId: 'jx1',
                detail: 'Removed 0 journal entries.',
              },
              {
                id: 1,
                trigger: 'schedule',
                startedAt: NOW - 86_400_000,
                outcome: 'skipped',
                durationMs: 0,
                engineJobId: null,
                detail: 'Skipped: writes are paused.',
              },
            ],
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await screen.findByText('Journal prune');
    await user.click(
      within(row('journal-prune')).getByRole('button', { name: 'Show the history of Journal prune' }),
    );
    const history = await screen.findByLabelText('History of Journal prune');
    expect(within(history).getByText('Skipped: writes are paused.')).toBeInTheDocument();
    expect(within(history).getByRole('link', { name: 'job' })).toHaveAttribute('href', '/ui/jobs/jx1');
    expect(within(history).getByText(/catch-up/)).toBeInTheDocument();
  });

  it('says when the scheduler is switched off', async () => {
    installApi(routes({ 'GET /maintenance': { jobs: jobs(), schedulerEnabled: false, now: NOW } }));
    renderApp('/ui/maintenance');
    expect(await screen.findByText(/scheduler is switched off/)).toBeInTheDocument();
  });

  it('reloads when the owner changes something elsewhere (a policy event on the live stream)', async () => {
    let enabled = true;
    const api = installApi(
      routes({ 'GET /maintenance': () => ({ jobs: [job({ enabled })], schedulerEnabled: true, now: NOW }) }),
    );
    renderApp('/ui/maintenance');
    const sampler = () => screen.findByRole('switch', { name: 'Enable Budget sampler' });
    expect(await sampler()).toBeChecked();
    const source = await openStream();
    enabled = false;
    const before = api.find('GET', '/maintenance').length;
    source.emit('policy', { action: 'maintenance.disable', actor: 'owner', target: 'budget-sampler' });
    await waitFor(() => expect(api.find('GET', '/maintenance').length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enable Budget sampler' })).not.toBeChecked(),
    );
  });

  it('shows an error with a retry when the page cannot load', async () => {
    installApi({
      ...baseRoutes(),
      'GET /maintenance': {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } },
      },
    });
    renderApp('/ui/maintenance');
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });
});
