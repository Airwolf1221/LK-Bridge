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

  it('offers "Apply fix…" on a row without an event and on a date mismatch only; confirmed, it runs as one job (v3 F12)', async () => {
    const api = installApi(
      routes({
        'POST /chronology/propose-fix': { status: 'job_submitted', jobId: 'job_42', summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(table).toHaveTextContent('Row and event disagree about the date');
    // Two fixable findings (a row without an event, a date mismatch); the wrong link has none.
    const buttons = within(table).getAllByRole('button', { name: 'Apply fix…' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    // The dialog says what it does; nothing is sent until the owner confirms.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('It runs at once as one job');
    expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(0);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply fix' }));
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Age of Dawn',
      rowId: 'rowflood',
    });
    expect(await screen.findByText(/Applying: job job_42 \(on the Jobs page\)/)).toBeInTheDocument();
    // The fix is under way: the button is gone for that row, not for the other.
    expect(within(table).getAllByRole('button', { name: 'Apply fix…' })).toHaveLength(1);
  });

  it('offers "Apply fix…" on a count mismatch with a Main row (v2 E5 hotfix), and none without one', async () => {
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
          status: 'job_submitted',
          jobId: 'job_43',
          summary: 'Fourth Arkonan Age: Main 337 → 336 (table rows 336; timeline events 336)',
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const buttons = within(table).getAllByRole('button', { name: 'Apply fix…' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply fix' }));
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      kind: 'count',
    });
    expect(await screen.findByText(/Applying: job job_43/)).toBeInTheDocument();
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

describe('the Chronology page, v2 E6 (ADR 0048)', () => {
  const finding = (kind: string, message: string, detail: Record<string, unknown>) => ({
    kind,
    age: 'Fourth Arkonan Age',
    message,
    detail,
  });
  const withFindings = (findings: unknown[], ages: unknown[] = []) => ({
    ...checkJson,
    last: { ...checkJson.last, findings, ages },
  });
  const mark = {
    tableDocumentId: 'tab4a',
    rowId: 'rowkept1',
    age: 'Fourth Arkonan Age',
    textsHash: 'h1',
    texts: {
      description: 'A private matter of the house',
      date: 'c. 4A 640; exact date unresolved',
      kcy: '',
    },
    reason: 'kept in the table only',
    markedBy: 'owner',
    markedAt: Date.now() - 60_000,
  };

  it('an event without a row offers its deletion and shows the nearest rows; confirmed, the job deletes only the event', async () => {
    const api = installApi(
      routes({
        'GET /chronology/check': withFindings([
          finding('event_without_row', 'Event “A superseded telling” (4A 890) has no table row.', {
            eventId: 'eorphan1',
            name: 'A superseded telling',
            date: '4A 890',
            nearest: [
              { rowId: 'r1', date: '4A 881 - 4A 900', words: 'The Quiet Years' },
              { rowId: 'r2', date: 'Kumikas 3rd, 4A 881', words: 'Ashgate falls to the Isar host' },
            ],
          }),
        ]),
        'GET /chronology/table-only': { project: checkJson.project, marks: [] },
        'POST /chronology/propose-fix': { status: 'job_submitted', jobId: 'job_50', summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(within(table).getByTestId('nearest-rows')).toHaveTextContent(
      'Nearest rows: 4A 881 - 4A 900: The Quiet Years; Kumikas 3rd, 4A 881: Ashgate falls to the Isar host',
    );
    await user.click(within(table).getByRole('button', { name: 'Delete the event…' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete the event' }),
    );
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      kind: 'orphan',
      eventId: 'eorphan1',
    });
  });

  it('a fix that turns a range into a single day is not one click: it warns, asks, and says so in the request', async () => {
    const api = installApi(
      routes({
        'GET /chronology/check': withFindings([
          finding('date_mismatch', 'Row 4 and the event “The Heirage” disagree about the date.', {
            rowId: 'rowvote1',
            eventId: 'evheir01',
            rowDate: 'Isar 3rd, 4A 619',
            eventDate: 'Isar 3rd, 4A 619 - Camue 5th, 4A 624',
            pairedBy: 'start',
            shapeChange: 'range → single day',
          }),
        ]),
        'GET /chronology/table-only': { project: checkJson.project, marks: [] },
        'POST /chronology/propose-fix': { status: 'job_submitted', jobId: 'job_51', summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(within(table).getByTestId('shape-change')).toHaveTextContent('range → single day');
    expect(table).toHaveTextContent('Paired by the same start.');
    // Cancelled: nothing is sent.
    await user.click(within(table).getByRole('button', { name: 'Apply fix…' }));
    let dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('range → single day');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(0);
    // Confirmed: the request says the owner confirmed the change of shape.
    await user.click(within(table).getByRole('button', { name: 'Apply fix…' }));
    dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply the change' }));
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      rowId: 'rowvote1',
      confirmShapeChange: true,
    });
  });

  // ---------------------------------------------------------------------------------- v3 F2.1: ties

  it('a fix refused for a tie shows each candidate event with “Use this event”, and one “Make a new event” (v3 F2.1)', async () => {
    let posts = 0;
    const api = installApi(
      routes({
        'GET /chronology/check': withFindings([
          finding(
            'row_without_event',
            'Row 9 (“Before Selyros 40th, 4A 605; exact day unresolved”) has no event.',
            {
              rowId: 'kvqam7yc',
              date: 'Before Selyros 40th, 4A 605; exact day unresolved',
            },
          ),
        ]),
        'GET /chronology/table-only': { project: checkJson.project, marks: [] },
        'POST /chronology/propose-fix': () =>
          ++posts === 1
            ? {
                status: 409,
                body: {
                  error: {
                    code: 'PAIRING_AMBIGUOUS',
                    message:
                      'The row … could be its own: “Mehrana returns…” (Selyros 40th, 4A 605, n4nl9rud); “Another telling” (Selyros 40th, 4A 605, eother01).',
                    details: {
                      row: { id: 'kvqam7yc' },
                      candidates: [
                        { id: 'n4nl9rud', name: 'Mehrana returns…', date: 'Selyros 40th, 4A 605' },
                        { id: 'eother01', name: 'Another telling', date: 'Selyros 40th, 4A 605' },
                      ],
                    },
                  },
                },
              }
            : { status: 'job_submitted', jobId: `job_6${posts}`, summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    await user.click(within(table).getByRole('button', { name: 'Apply fix…' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply fix' }));
    const tie = await within(table).findByTestId('tie-choices');
    expect(tie).toHaveTextContent('“Mehrana returns…” (Selyros 40th, 4A 605, n4nl9rud)');
    expect(within(tie).getAllByRole('button', { name: 'Use this event' })).toHaveLength(2);
    expect(within(tie).getAllByRole('button', { name: 'Make a new event' })).toHaveLength(1);
    // The refusal itself is shown too, with the candidates in its words.
    expect(await screen.findByText(/could be its own: “Mehrana returns…”/)).toBeInTheDocument();
    const second = tie.querySelector('[data-candidate="eother01"]') as HTMLElement;
    await user.click(within(second).getByRole('button', { name: 'Use this event' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(2));
    expect(api.find('POST', '/chronology/propose-fix')[1]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      rowId: 'kvqam7yc',
      eventId: 'eother01',
    });
    expect(await within(table).findByText(/Applying: job job_62/)).toBeInTheDocument();
    expect(within(table).queryByTestId('tie-choices')).toBeNull();
  });

  it('“Make a new event” sends createNew for the row (v3 F2.1)', async () => {
    let posts = 0;
    const api = installApi(
      routes({
        'GET /chronology/check': withFindings([
          finding('row_without_event', 'Row 9 has no event.', {
            rowId: 'kvqam7yc',
            date: 'Before Selyros 40th',
          }),
        ]),
        'GET /chronology/table-only': { project: checkJson.project, marks: [] },
        'POST /chronology/propose-fix': () =>
          ++posts === 1
            ? {
                status: 409,
                body: {
                  error: {
                    code: 'PAIRING_AMBIGUOUS',
                    message: 'tied',
                    details: {
                      row: { id: 'kvqam7yc' },
                      candidates: [{ id: 'n4nl9rud', name: 'M', date: 'D' }],
                    },
                  },
                },
              }
            : { status: 'job_submitted', jobId: 'job_70', summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    await user.click(within(table).getByRole('button', { name: 'Apply fix…' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply fix' }));
    await user.click(await within(table).findByRole('button', { name: 'Make a new event' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(2));
    expect(api.find('POST', '/chronology/propose-fix')[1]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      rowId: 'kvqam7yc',
      createNew: true,
    });
  });

  it('an event in a tie offers “Pair with this row” per candidate and never a delete (v3 F2.1)', async () => {
    const api = installApi(
      routes({
        'GET /chronology/check': withFindings([
          finding('event_in_tie', 'Event “Mehrana returns…” (Selyros 40th, 4A 605) is in a tie: 2 rows …', {
            eventId: 'n4nl9rud',
            name: 'Mehrana returns…',
            date: 'Selyros 40th, 4A 605',
            candidates: [
              {
                rowId: 'w26f230j',
                date: 'After Pardis-an placement and before Selyros 40th, 4A 605',
                words: 'In the final House period…',
              },
              {
                rowId: 'kvqam7yc',
                date: 'Before Selyros 40th, 4A 605',
                words: 'Following Mehrana’s return…',
              },
            ],
          }),
        ]),
        'GET /chronology/table-only': { project: checkJson.project, marks: [] },
        'POST /chronology/propose-fix': { status: 'job_submitted', jobId: 'job_71', summary: 'x' },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(table).toHaveTextContent('Event in a tie');
    expect(within(table).queryByRole('button', { name: 'Delete the event…' })).toBeNull();
    const tie = within(table).getByTestId('tie-choices');
    expect(within(tie).getAllByRole('button', { name: 'Pair with this row' })).toHaveLength(2);
    expect(within(tie).queryByRole('button', { name: 'Make a new event' })).toBeNull();
    const row = tie.querySelector('[data-candidate="kvqam7yc"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Pair with this row' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/chronology/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/chronology/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      rowId: 'kvqam7yc',
      eventId: 'n4nl9rud',
    });
  });

  it('marks a row table-only from its finding, lists the marks, and clears one', async () => {
    const api = installApi(
      routes({
        'GET /chronology/check': withFindings(
          [
            finding(
              'unreadable_date',
              '“Some months after the coronation” cannot be read: a relative offset.',
              {
                rowId: 'rowunrd1',
                date: 'Some months after the coronation; undated',
                code: 'DATE_RELATIVE',
              },
            ),
          ],
          [
            {
              age: 'Fourth Arkonan Age',
              rows: 400,
              events: 390,
              count: '400',
              dates: { qualified: 54, unreadable: 9, tableOnly: 1 },
              tableOnlyLapsed: [{ rowId: 'rowkept1', date: 'c. 4A 640; exact date unresolved' }],
              pairedBy: { 'date+name': 300, link: 6, 'mismatch:start+shape': 1 },
              pairs: [
                { rowId: 'rowheir1', eventId: 'evheir01', by: 'start+shape', mismatch: true, date: 'x' },
              ],
            },
          ],
        ),
        'GET /chronology/table-only': { project: checkJson.project, marks: [mark] },
        'POST /chronology/table-only': { ok: true, mark: null },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/chronology');
    const ages = await screen.findByRole('table', { name: 'Ages' });
    expect(ages).toHaveTextContent('54 qualified (read by their anchor) · 9 unreadable · 1 table-only');
    expect(ages).toHaveTextContent('the bridge’s link: 6');
    expect(ages).toHaveTextContent('date mismatch by the same start and shape: 1');
    expect(ages).toHaveTextContent('1 table-only mark no longer hold');

    const table = screen.getByRole('table', { name: 'Findings' });
    await user.click(within(table).getByRole('button', { name: 'Table-only' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Table-only' }));
    await waitFor(() => expect(api.find('POST', '/chronology/table-only')).toHaveLength(1));
    expect(api.find('POST', '/chronology/table-only')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      rowId: 'rowunrd1',
      tableOnly: true,
    });

    const card = screen.getByRole('heading', { name: /^Table-only rows/ }).closest('section')!;
    const row = card.querySelector('[data-row="rowkept1"]')!;
    expect(row).toHaveTextContent('A private matter of the house');
    expect(row).toHaveTextContent('no longer holds: the row changed');
    await user.click(within(card).getByRole('button', { name: 'Clear the mark' }));
    await waitFor(() => expect(api.find('POST', '/chronology/table-only')).toHaveLength(2));
    expect(api.find('POST', '/chronology/table-only')[1]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      age: 'Fourth Arkonan Age',
      rowId: 'rowkept1',
      tableOnly: false,
    });
  });
});
