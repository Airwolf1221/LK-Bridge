// @vitest-environment jsdom
/**
 * v2 D1 (ADR 0038) on the dashboard: the Chronology page. The Settings card reads the chronology and confirms what it
 * found (the writing style editable first), the Chronology check card shows its findings in words, and the Changes card
 * marks a change that stopped part-way resolved, each after a confirmation.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, projectOf, renderApp, useDom, type Call } from './helpers';

useDom();

const style = {
  date: { rangeSeparator: ' - ', yearGrouping: ',' },
  kcy: { grouping: ',', minus: '-', rangeSeparator: ' - ', sameYearRange: 'range' },
};
const config = {
  resourceId: null,
  calendarId: null,
  mainDocumentId: null,
  ages: [],
  style,
  names: {
    resource: 'Universal Chronology',
    mainDocument: 'Main',
    tableSuffix: ' - Table',
    timelineSuffix: ' - Timeline',
    laneName: 'Historical Events',
  },
  columns: {
    event: 'Historical Event',
    date: 'Date',
    kcy: 'KCY',
    age: 'Age',
    count: 'Count',
    table: 'Table',
    timeline: 'Timeline',
  },
  confirmed: false,
  confirmedAt: null,
  problem: null,
};
const find = {
  resource: {
    status: 'found',
    id: 'chron001',
    name: 'Universal Chronology',
    path: 'World / Universal Chronology',
  },
  main: { id: 'main0001', name: 'Main', type: 'page' },
  ages: [
    {
      name: 'Age of Dawn',
      table: { id: 'tabl0001', name: 'Age of Dawn - Table', type: 'page' },
      timeline: { id: 'time0001', name: 'Age of Dawn - Timeline', type: 'time' },
    },
  ],
  problems: [],
};
const view = (over: Record<string, unknown> = {}) => ({
  project: 'baisheng',
  config,
  find,
  ready: {
    ok: false,
    code: 'CHRONOLOGY_NOT_CONFIGURED',
    message: 'The chronology is not confirmed yet; the chronology tools refuse until it is.',
  },
  calendarCached: false,
  ...over,
});
const age = {
  name: 'Age of Dawn',
  eraId: 'era00001',
  tableDocumentId: 'tabl0001',
  timelineDocumentId: 'time0001',
  laneId: 'lane0001',
  laneName: 'Historical Events',
  mainRowId: 'row00001',
};
const proposed = {
  resourceId: 'chron001',
  calendarId: 'cal00001',
  mainDocumentId: 'main0001',
  ages: [age],
  style,
  names: config.names,
  columns: config.columns,
  confirmed: false,
};
const evidence = (value: string | null, seen: Record<string, number>, examples: string[]) => ({
  value,
  seen,
  examples,
});
const lookup = {
  project: 'baisheng',
  ...find,
  requests: 4,
  calendar: {
    id: 'cal00001',
    name: 'Reckoning',
    eras: [{ id: 'era00001', name: 'Age of Dawn', abbr: 'AD' }],
  },
  mainTable: { tableId: 'mt1', rows: [] },
  found: [{ ...age, era: 'Age of Dawn', rows: 12, count: '12', problems: [] }],
  style: {
    date: {
      rangeSeparator: evidence(' - ', { ' - ': 3, '–': 1 }, ['Azah 18th - 20th, 4AD', 'Azah 1st–3rd, 5AD']),
      yearGrouping: evidence(null, {}, []),
    },
    kcy: {
      grouping: evidence(',', { ',': 2 }, ['1,250,308']),
      minus: evidence(null, {}, []),
      rangeSeparator: evidence(' - ', { ' - ': 2 }, ['4 - 5']),
      sameYearRange: evidence('range', { range: 1 }, ['Azah 1st - 3rd, 4AD | 4 - 4']),
    },
    proposed: style,
    conflicts: ['date range separator'],
  },
  proposed,
};

const checkJson = {
  project: { id: 'lkp_baisheng', name: 'baisheng' },
  running: false,
  last: {
    id: 3,
    projectId: 'lkp_baisheng',
    trigger: 'weekly',
    state: 'succeeded',
    requests: 7,
    summary: '2 findings in 1 age',
    findings: [
      {
        kind: 'row_without_event',
        age: 'Age of Dawn',
        message: 'The row “The first fire” has no event.',
        detail: { rowId: 'rowfire1' },
      },
      {
        kind: 'date_mismatch',
        age: 'Age of Dawn',
        message: 'The row “The flood” and its event disagree about the date.',
        detail: { rowId: 'rowflood', eventId: 'evflood1' },
      },
      { kind: 'wrong_uri', age: 'Age of Dawn', message: 'The event “Flood” links elsewhere.' },
    ],
    error: null,
    startedAt: Date.now() - 120_000,
    finishedAt: Date.now() - 60_000,
  },
};

const recordsJson = {
  project: { id: 'lkp_baisheng', name: 'baisheng' },
  total: 2,
  incomplete: 1,
  records: [
    {
      id: 7,
      tool: 'create_timeline_event',
      summary: 'The first fire (Age of Dawn)',
      ages: ['Age of Dawn'],
      state: 'incomplete',
      jobId: 'job_7',
      jobs: ['job_7'],
      principalId: 'pat_abc',
      approver: null,
      proposalId: null,
      writes: ['row.insert', 'event.create', 'count'],
      detail: {},
      createdAt: Date.now() - 30_000,
      completedAt: null,
    },
    {
      id: 6,
      tool: 'delete_timeline_event',
      summary: 'The old flood (Age of Dawn)',
      ages: ['Age of Dawn'],
      state: 'complete',
      jobId: 'job_6',
      jobs: ['job_6'],
      principalId: 'pat_abc',
      approver: 'owner',
      proposalId: 'prop_6',
      writes: ['row.delete', 'event.delete', 'count'],
      detail: {},
      createdAt: Date.now() - 600_000,
      completedAt: Date.now() - 590_000,
    },
  ],
  principals: { pat_abc: { id: 'pat_abc', name: 'Laptop', type: 'pat', removedAt: null } },
};

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /projects/baisheng/chronology': view(),
  'GET /chronology/check': checkJson,
  'GET /chronology/records': recordsJson,
  ...over,
});

describe('the Chronology page', () => {
  it('is in the navigation, after Archive and lifecycle', async () => {
    installApi(routes());
    renderApp('/ui/chronology');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(labels.indexOf('Chronology')).toBe(labels.indexOf('Archive and lifecycle') + 1);
    expect(within(nav).getByRole('link', { name: 'Chronology' })).toHaveAttribute('aria-current', 'page');
  });

  it('reads the chronology, shows what it found, and confirms the settings (style edited first)', async () => {
    const api = installApi(
      routes({
        'POST /projects/baisheng/chronology/lookup': lookup,
        'PUT /projects/baisheng/chronology': view({
          ready: { ok: true },
          config: { ...config, confirmed: true },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const card = (await screen.findByRole('heading', { name: /^Settings/ })).closest('section')!;
    expect(within(card).getByText('not confirmed')).toBeInTheDocument();
    expect(card).toHaveTextContent('CHRONOLOGY_NOT_CONFIGURED');
    expect(card).toHaveTextContent('found: World / Universal Chronology (chron001)');
    expect(within(card).getByRole('table', { name: 'Ages found in the tree' })).toHaveTextContent(
      'Age of Dawn - Timeline',
    );

    await user.click(within(card).getByRole('button', { name: 'Read the chronology' }));
    const found = await within(card).findByRole('region', { name: 'What reading the chronology found' });
    expect(api.find('POST', '/projects/baisheng/chronology/lookup')).toHaveLength(1);
    expect(found).toHaveTextContent('Requests made4');
    expect(found).toHaveTextContent('Reckoning');
    expect(within(found).getByRole('table', { name: 'Ages read' })).toHaveTextContent('Age of Dawn');
    const styleTable = within(found).getByRole('table', { name: 'Writing style' });
    const dateRow = styleTable.querySelector('[data-style="date.rangeSeparator"]')!;
    expect(dateRow).toHaveTextContent('" - ": 3');
    expect(dateRow).toHaveTextContent('Azah 18th - 20th, 4AD');
    expect(found).toHaveTextContent('date range separator');

    // The owner writes a different KCY minus sign before confirming.
    const minus = within(found).getByLabelText('KCY minus sign');
    expect(minus).toHaveValue('-');
    await user.clear(minus);
    await user.type(minus, '−');
    await user.selectOptions(within(found).getByLabelText('KCY of a range inside one year'), 'single');

    await user.click(within(found).getByRole('button', { name: 'Confirm these settings' }));
    const dialog = screen.getByRole('alertdialog');
    expect(api.find('PUT', '/projects/baisheng/chronology')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/chronology')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/chronology')[0]!.body).toEqual({
      confirm: true,
      settings: {
        ...proposed,
        style: {
          date: style.date,
          kcy: { ...style.kcy, minus: '−', sameYearRange: 'single' },
        },
      },
    });
    await waitFor(() => expect(within(card).getByText('confirmed')).toBeInTheDocument());
  });

  it('clears the settings only after a confirmation', async () => {
    const api = installApi(routes({ 'PUT /projects/baisheng/chronology': view() }));
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    await user.click(await screen.findByRole('button', { name: 'Clear the chronology settings' }));
    expect(api.find('PUT', '/projects/baisheng/chronology')).toHaveLength(0);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear the settings' }),
    );
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/chronology')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/chronology')[0]!.body).toEqual({ confirm: true, reset: true });
  });

  it('shows the check’s findings in words, and runs it now for the selected project', async () => {
    const api = installApi(routes({ 'POST /chronology/check': { started: true } }));
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(table).toHaveTextContent('Row without an event');
    expect(table).toHaveTextContent('Event link not to its table');
    expect(table).not.toHaveTextContent('row_without_event');
    expect(projectOf(api.find('GET', '/chronology/check')[0]!)).toBe('baisheng');
    await user.click(screen.getByRole('button', { name: 'Run the check now' }));
    await waitFor(() => expect(api.find('POST', '/chronology/check')).toHaveLength(1));
    expect(api.find('POST', '/chronology/check')[0]!.body).toEqual({ confirm: true, project: 'baisheng' });
  });

  it('offers "Propose a fix" on a row without an event and on a date mismatch only, and makes one proposal for the owner', async () => {
    const api = installApi(
      routes({
        'POST /chronology/propose-fix': { status: 'proposal_captured', proposalId: 'prop_42', summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(table).toHaveTextContent('Row and event disagree about the date');
    // Two fixable findings (a row without an event, a date mismatch); the wrong link has none.
    const buttons = within(table).getAllByRole('button', { name: 'Propose a fix' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Age of Dawn',
      rowId: 'rowflood',
    });
    expect(await screen.findByText(/Proposal prop_42 is waiting on the Proposals page/)).toBeInTheDocument();
    // The proposal is the owner's to approve: the button is gone for that row, not for the other.
    expect(within(table).getAllByRole('button', { name: 'Propose a fix' })).toHaveLength(1);
  });

  it('offers "Propose a fix" on a count mismatch with a Main row (v2 E5 hotfix), and none without one', async () => {
    const findings = [
      {
        kind: 'count_mismatch',
        age: 'Fourth Arkonan Age',
        message: 'The Main table says 337; the table has 336 rows (the timeline 336 events).',
        detail: { main: '337', rows: 336, events: 336 },
      },
      {
        kind: 'count_mismatch',
        age: 'Age of Dawn',
        message: 'The Main table has no row m1 for Age of Dawn.',
        detail: { main: null, rows: 3, events: 3 },
      },
    ];
    const api = installApi(
      routes({
        'GET /chronology/check': { ...checkJson, last: { ...checkJson.last, findings } },
        'POST /chronology/propose-fix': {
          status: 'proposal_captured',
          proposalId: 'prop_43',
          summary: 'Fourth Arkonan Age: Main 337 → 336 (table rows 336; timeline events 336)',
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const buttons = within(table).getAllByRole('button', { name: 'Propose a fix' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      kind: 'count',
    });
    expect(await screen.findByText(/Proposal prop_43 is waiting on the Proposals page/)).toBeInTheDocument();
  });

  it('lists the changes with journal links, and marks an incomplete one resolved', async () => {
    const api = installApi(
      routes({
        'POST /chronology/records/7/resolve': (c: Call) => ({ ok: true, record: { id: 7, body: c.body } }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const row = (await screen.findByText(/The first fire \(Age of Dawn\)/)).closest('tr')!;
    expect(row).toHaveTextContent('Laptop');
    expect(within(row).getByRole('link', { name: 'job_7' })).toHaveAttribute(
      'href',
      expect.stringContaining('/journal?jobId=job_7'),
    );
    const done = screen.getByText(/The old flood/).closest('tr')!;
    expect(within(done).queryByRole('button', { name: 'Mark resolved' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Mark resolved' }));
    const dialog = screen.getByRole('alertdialog');
    expect(api.find('POST', '/chronology/records/7/resolve')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(api.find('POST', '/chronology/records/7/resolve')).toHaveLength(1));
    expect(api.find('POST', '/chronology/records/7/resolve')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
    });
  });
});
