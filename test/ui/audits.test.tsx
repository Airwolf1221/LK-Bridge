// @vitest-environment jsdom
/**
 * v2 E2 (ADR 0044) on the dashboard: the Audits page. The latest run (its snapshot and age, a stale snapshot flagged), the
 * summary by category and severity, the filters, per-page grouping, each finding's evidence, source and link to the page's
 * snapshot history, acknowledging with a reason, "Propose a fix" and "Re-check now", the runs, and the rules editor.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, projectOf, renderApp, useDom, type Call } from './helpers';

useDom();

const NOW = Date.now();
interface AuditRuleLike {
  id: string;
  name: string;
  enabled: boolean;
  selectors: Record<string, string>;
  template: Record<string, unknown>;
}
const finding = (over: Record<string, unknown> = {}) => ({
  id: 1,
  code: 'line_break_paragraph',
  category: 'keep_regions',
  severity: 'warning',
  pageId: 'page0001',
  pageName: '[BSRC] Many Lines',
  pagePath: 'AI REPOSITORY / Many Lines',
  documentId: 'doc00001',
  blockId: 'bp1',
  message: 'A paragraph (bp1) holds \\n inside a text run: “first line”.',
  evidence: { characters: ['\\n'], parts: 3, splittable: true },
  source: {
    kind: 'snapshot',
    snapshotId: 'F1',
    baseSnapshotId: 'F1',
    takenAt: NOW - 3_600_000,
    ageMs: 3_600_000,
  },
  fix: { kind: 'split_paragraph', args: {}, summary: 'Split the paragraph into 3 paragraphs.' },
  state: 'open',
  firstSeenRun: 'run2',
  firstSeenAt: NOW - 1000,
  lastSeenRun: 'run2',
  lastSeenAt: NOW - 1000,
  resolvedRun: null,
  resolvedAt: null,
  acknowledgement: null,
  acknowledgementLapsed: false,
  ...over,
});
const second = finding({
  id: 2,
  code: 'out_of_order',
  category: 'ordering',
  pageId: 'page0002',
  pageName: '[BSRC] Cherry',
  pagePath: 'AI REPOSITORY / Zoo / Cherry',
  documentId: null,
  blockId: null,
  message: '“[BSRC] Cherry” is out of alphabetical order.',
  evidence: { position: 2 },
  fix: { kind: 'move_resource', args: {}, summary: 'Re-place Cherry alphabetically.' },
  firstSeenRun: 'run1',
});
const noFix = finding({
  id: 3,
  code: 'missing_target',
  category: 'references',
  severity: 'error',
  pageId: 'page0003',
  pageName: '[BSRC] Linker',
  pagePath: 'AI REPOSITORY / Linker',
  message: 'Linker links to ghost001: nothing the bridge knows.',
  evidence: { target: 'ghost001', state: 'missing' },
  fix: null,
  firstSeenRun: 'run1',
});

const catalogue = {
  categories: [
    'rules',
    'template',
    'tags',
    'references',
    'unclassified',
    'ordering',
    'taxonomy',
    'facts',
    'lifecycle',
    'keep_regions',
    'chronology',
    'audit',
  ],
  severities: ['error', 'warning', 'info'],
  codes: [
    {
      code: 'line_break_paragraph',
      category: 'keep_regions',
      severity: 'warning',
      title: 'A paragraph holds a line break inside a text run',
      fix: 'split_paragraph',
    },
    {
      code: 'out_of_order',
      category: 'ordering',
      severity: 'warning',
      title: 'A page is out of alphabetical order among its siblings',
      fix: 'move_resource',
    },
    {
      code: 'missing_target',
      category: 'references',
      severity: 'error',
      title: 'A link points at nothing the bridge knows',
    },
  ],
};
const empty = { error: 0, warning: 0, info: 0 };
const run = (over: Record<string, unknown> = {}) => ({
  id: 'run2',
  trigger: 'snapshot',
  state: 'succeeded',
  startedAt: NOW - 60_000,
  finishedAt: NOW - 59_000,
  durationMs: 1234,
  snapshotId: 'F1',
  snapshotTakenAt: NOW - 3_600_000,
  snapshotAgeMs: 3_600_000,
  changeSnapshots: 2,
  newestSnapshotId: 'C2',
  stale: false,
  pages: 1452,
  counts: null,
  summary: '3 open findings (1 new).',
  error: null,
  ...over,
});
const overview = (over: Record<string, unknown> = {}) => ({
  project: { id: 'lkp_baisheng', name: 'baisheng' },
  summary: {
    byCategory: {
      keep_regions: { ...empty, warning: 1 },
      ordering: { ...empty, warning: 1 },
      references: { ...empty, error: 1 },
    },
    open: 3,
    acknowledged: 1,
    gone: 4,
    new: 1,
  },
  latestRun: run(),
  running: null,
  runs: [run(), run({ id: 'run1', trigger: 'manual', durationMs: 900, changeSnapshots: 0 })],
  codes: [],
  catalogue,
  newestFullSnapshot: { id: 'F1', takenAt: NOW - 3_600_000, ageMs: 3_600_000 },
  maxSnapshotAgeHours: 36,
  now: NOW,
  ...over,
});
const findings = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  project: { id: 'lkp_baisheng', name: 'baisheng' },
  findings: rows,
  total: rows.length,
  latestRun: 'run2',
  now: NOW,
  ...extra,
});
const config = {
  project: { id: 'lkp_baisheng', name: 'baisheng' },
  rules: null,
  effectiveRules: [
    {
      id: 'character-core',
      name: 'Character: Character Core',
      enabled: true,
      selectors: { registryType: 'Character', role: 'core' },
      template: { registry: { type: 'Character', role: 'core' } },
    },
  ],
  seeded: true,
  tagSource: null,
  tagSourcePage: null,
  settings: {
    reportUnmatched: true,
    maxSnapshotAgeHours: 36,
    manualOrderIndexes: [],
    knownReferenceTypes: [],
    strictReferenceTypes: false,
  },
  registryTypes: [
    {
      id: 't1',
      singular: 'Character',
      plural: 'Characters',
      roles: ['index', 'core', 'compact'],
      placementKind: 'character',
    },
  ],
  updatedAt: null,
  updatedBy: null,
};

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /audits': overview(),
  'GET /audits/findings': findings([finding(), second, noFix]),
  'GET /audits/config': config,
  'GET /snapshots/pages': { project: 'baisheng', pages: [] },
  ...over,
});

describe('the Audits page', () => {
  it('is in the navigation, under Quality (open on its page)', async () => {
    installApi(routes());
    renderApp('/ui/audits');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Quality' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Audits' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the latest run with its snapshot and age, the summary by category and severity, and the runs', async () => {
    const api = installApi(routes());
    renderApp('/ui/audits');
    const latest = (await screen.findByRole('heading', { name: 'Latest audit' })).closest('section')!;
    expect(latest).toHaveTextContent('F1');
    expect(latest).toHaveTextContent('1 h old when audited');
    expect(latest).toHaveTextContent('plus 2 change snapshots');
    expect(latest).toHaveTextContent('Reads the snapshot store only');
    expect(within(latest).queryByTestId('stale-note')).toBeNull();
    const summary = screen.getByRole('table', { name: 'Findings by category and severity' });
    const row = summary.querySelector('[data-category="references"]')!;
    expect(row).toHaveTextContent('References');
    expect(row.querySelectorAll('td')[1]).toHaveTextContent('1'); // errors
    expect(screen.getByRole('table', { name: 'Audit runs' })).toHaveTextContent('manual');
    expect(projectOf(api.find('GET', '/audits')[0]!)).toBe('baisheng');
  });

  it('flags a stale snapshot', async () => {
    installApi(
      routes({
        'GET /audits': overview({
          latestRun: run({ stale: true, snapshotAgeMs: 4 * 86_400_000 }),
          newestFullSnapshot: { id: 'F1', takenAt: NOW - 4 * 86_400_000, ageMs: 4 * 86_400_000 },
        }),
      }),
    );
    renderApp('/ui/audits');
    expect(await screen.findByTestId('stale-note')).toHaveTextContent('4 days old');
    expect(screen.getAllByText('stale').length).toBeGreaterThan(0);
  });

  it('runs an audit now for the selected project', async () => {
    const api = installApi(routes({ 'POST /audits/run': { started: true } }));
    const user = userEvent.setup();
    renderApp('/ui/audits');
    await user.click(await screen.findByRole('button', { name: 'Run an audit now' }));
    await waitFor(() => expect(api.find('POST', '/audits/run')).toHaveLength(1));
    expect(api.find('POST', '/audits/run')[0]!.body).toEqual({ confirm: true, project: 'baisheng' });
  });

  it('lists findings with severity, new, and the page’s snapshot history; evidence and source open on request', async () => {
    installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const r1 = table.querySelector('[data-finding="1"]')!;
    expect(r1).toHaveTextContent('A paragraph holds a line break inside a text run');
    expect(r1).toHaveTextContent('new'); // first seen in the latest run
    expect(table.querySelector('[data-finding="2"]')).not.toHaveTextContent('new');
    expect(table.querySelector('[data-finding="3"] .badge')).toHaveTextContent('error');
    expect(within(r1 as HTMLElement).getByRole('link', { name: 'history' })).toHaveAttribute(
      'href',
      '/ui/snapshots?page=page0001',
    );
    await user.click(within(r1 as HTMLElement).getByRole('button', { name: 'Evidence' }));
    const ev = table.querySelector('[data-evidence="1"]')!;
    expect(ev).toHaveTextContent('snapshot F1');
    expect(ev).toHaveTextContent('1 h old when audited');
    expect(ev).toHaveTextContent('"splittable": true');
    expect(ev).toHaveTextContent('Split the paragraph into 3 paragraphs.');
  });

  it('filters: the choices go to the bridge as query parameters, and a summary row picks its category', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/audits');
    await screen.findByRole('table', { name: 'Findings' });
    await user.selectOptions(screen.getByLabelText('Severity'), 'error');
    await user.click(screen.getByLabelText('New in the latest audit'));
    await user.selectOptions(screen.getByLabelText('Acknowledged'), 'include');
    await user.selectOptions(screen.getByLabelText('Show'), 'gone');
    await user.type(screen.getByLabelText('Page path'), 'Zoo');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => {
      const q = new URLSearchParams(api.find('GET', '/audits/findings').at(-1)!.query);
      expect(q.get('severity')).toBe('error');
      expect(q.get('new')).toBe('true');
      expect(q.get('acknowledged')).toBe('include');
      expect(q.get('state')).toBe('gone');
      expect(q.get('page')).toBe('Zoo');
      expect(q.get('project')).toBe('baisheng');
    });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(
      within(screen.getByRole('table', { name: 'Findings by category and severity' })).getByRole('button', {
        name: 'Ordering',
      }),
    );
    await waitFor(() =>
      expect(new URLSearchParams(api.find('GET', '/audits/findings').at(-1)!.query).get('category')).toBe(
        'ordering',
      ),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Category').value).toBe('ordering');
  });

  it('groups by page', async () => {
    const api = installApi(
      routes({
        'GET /audits/findings': (c: Call) =>
          findings(
            [
              finding(),
              second,
              finding({
                id: 4,
                code: 'unsupported_blocks',
                category: 'keep_regions',
                severity: 'info',
                blockId: null,
                fix: null,
              }),
            ],
            {
              groups:
                new URLSearchParams(c.query).get('group') === 'page'
                  ? [
                      {
                        pageId: 'page0001',
                        pageName: '[BSRC] Many Lines',
                        pagePath: 'AI REPOSITORY / Many Lines',
                        findings: [1, 4],
                      },
                      {
                        pageId: 'page0002',
                        pageName: '[BSRC] Cherry',
                        pagePath: 'AI REPOSITORY / Zoo / Cherry',
                        findings: [2],
                      },
                    ]
                  : undefined,
            },
          ),
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    await screen.findByRole('table', { name: 'Findings' });
    await user.click(screen.getByLabelText('Group by page'));
    const group = await waitFor(() => {
      const g = document.querySelector('[data-page="page0001"]');
      expect(g).not.toBeNull();
      return g!;
    });
    expect(group).toHaveTextContent('AI REPOSITORY / Many Lines');
    expect(group.querySelectorAll('[data-finding]')).toHaveLength(2);
    expect(new URLSearchParams(api.find('GET', '/audits/findings').at(-1)!.query).get('group')).toBe('page');
  });

  it('acknowledges with a reason (required) and un-acknowledges', async () => {
    const api = installApi(
      routes({
        'POST /audits/findings/3/acknowledge': { finding: noFix },
        'POST /audits/findings/9/unacknowledge': { finding: noFix },
        'GET /audits/findings': findings([
          noFix,
          finding({
            id: 9,
            code: 'out_of_order',
            category: 'ordering',
            acknowledgement: { reason: 'on purpose', by: 'owner', at: NOW },
            fix: null,
          }),
        ]),
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    await user.click(
      within(table.querySelector('[data-finding="3"]') as HTMLElement).getByRole('button', {
        name: 'Acknowledge…',
      }),
    );
    const reason = screen.getByLabelText('Reason');
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    await user.type(reason, 'Scratch link, on purpose.');
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/3/acknowledge')).toHaveLength(1));
    expect(api.find('POST', '/audits/findings/3/acknowledge')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      reason: 'Scratch link, on purpose.',
    });
    // An acknowledged finding says so and offers to undo it.
    const acked = table.querySelector('[data-finding="9"]') as HTMLElement;
    expect(acked).toHaveTextContent('Acknowledged by owner: on purpose');
    await user.click(within(acked).getByRole('button', { name: 'Un-acknowledge' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/9/unacknowledge')).toHaveLength(1));
  });

  it('a lapsed acknowledgement is shown as such', async () => {
    installApi(routes({ 'GET /audits/findings': findings([finding({ acknowledgementLapsed: true })]) }));
    renderApp('/ui/audits');
    expect(await screen.findByText('evidence changed')).toBeInTheDocument();
  });

  it('offers "Apply fix…" only where there is one, confirmed in a dialog, then one job (v3 F12); Re-check now says what it found', async () => {
    const api = installApi(
      routes({
        'POST /audits/findings/1/propose-fix': {
          status: 'job_submitted',
          jobId: 'job_77',
          summary: 'x',
          fix: 'split_paragraph',
        },
        'POST /audits/findings/1/recheck': { status: 'gone', finding: finding({ state: 'gone' }), reads: 2 },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    expect(within(table).getAllByRole('button', { name: 'Apply fix…' })).toHaveLength(2); // finding 3 has none
    const r1 = table.querySelector('[data-finding="1"]') as HTMLElement;
    await user.click(within(r1).getByRole('button', { name: 'Apply fix…' }));
    // The dialog says what it does; nothing is sent until the owner confirms.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('It runs at once as one job');
    expect(api.find('POST', '/audits/findings/1/propose-fix')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Apply fix' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/1/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/audits/findings/1/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
    });
    expect(
      await within(r1).findByText(/Applying: job job_77 \(follow it on the Jobs page\)\./),
    ).toBeInTheDocument();
    await user.click(within(r1).getByRole('button', { name: 'Re-check now' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/1/recheck')).toHaveLength(1));
    expect(await screen.findByText(/Re-checked live: this finding is gone\./)).toBeInTheDocument();
  });

  it('a chronology event in a tie offers “Pair with this row” per candidate, never a delete (v3 F2.1)', async () => {
    const tie = finding({
      id: 5,
      code: 'chronology_event_in_tie',
      category: 'chronology',
      message: 'Fourth Arkonan Age: Event “Mehrana returns…” is in a tie.',
      evidence: { eventId: 'n4nl9rud' },
      fix: {
        kind: 'chronology_pair',
        summary: 'Propose pairing the event with the row you pick.',
        args: {
          age: 'Fourth Arkonan Age',
          eventId: 'n4nl9rud',
          candidates: [
            {
              rowId: 'w26f230j',
              date: 'After … before Selyros 40th, 4A 605',
              words: 'In the final House period…',
            },
            { rowId: 'kvqam7yc', date: 'Before Selyros 40th, 4A 605', words: 'Following Mehrana’s return…' },
          ],
        },
      },
    });
    const api = installApi(
      routes({
        'GET /audits/findings': findings([tie]),
        'POST /audits/findings/5/propose-fix': {
          status: 'job_submitted',
          jobId: 'job_80',
          summary: 'x',
          fix: 'chronology_pair',
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const r = table.querySelector('[data-finding="5"]') as HTMLElement;
    expect(within(r).queryByRole('button', { name: 'Apply fix…' })).toBeNull();
    const choices = within(r).getByTestId('tie-choices');
    expect(within(choices).getAllByRole('button', { name: 'Pair with this row' })).toHaveLength(2);
    const second = choices.querySelector('[data-candidate="kvqam7yc"]') as HTMLElement;
    await user.click(within(second).getByRole('button', { name: 'Pair with this row' }));
    // v3 F12: confirmed first, then one job.
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/5/propose-fix')).toHaveLength(1));
    expect(api.find('POST', '/audits/findings/5/propose-fix')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      rowId: 'kvqam7yc',
    });
    expect(await within(r).findByText(/Applying: job job_80/)).toBeInTheDocument();
  });

  it('a chronology fix refused for a tie shows “Use this event” per candidate and “Make a new event” (v3 F2.1)', async () => {
    const row = finding({
      id: 6,
      code: 'chronology_row_without_event',
      category: 'chronology',
      message: 'Fourth Arkonan Age: Row 9 has no timeline event.',
      evidence: { rowId: 'kvqam7yc' },
      fix: {
        kind: 'chronology_sync',
        summary: 'Propose sync_timeline_event.',
        args: { age: 'Fourth Arkonan Age', rowId: 'kvqam7yc' },
      },
    });
    let posts = 0;
    const api = installApi(
      routes({
        'GET /audits/findings': findings([row]),
        'POST /audits/findings/6/propose-fix': () =>
          ++posts === 1
            ? {
                status: 409,
                body: {
                  error: {
                    code: 'PAIRING_AMBIGUOUS',
                    message:
                      'The row … could be its own: “Mehrana returns…” (Selyros 40th, 4A 605, n4nl9rud).',
                    details: {
                      row: { id: 'kvqam7yc' },
                      candidates: [
                        { id: 'n4nl9rud', name: 'Mehrana returns…', date: 'Selyros 40th, 4A 605' },
                      ],
                    },
                  },
                },
              }
            : {
                status: 'job_submitted',
                jobId: `job_9${posts}`,
                summary: 'x',
                fix: 'chronology_sync',
              },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const r = table.querySelector('[data-finding="6"]') as HTMLElement;
    await user.click(within(r).getByRole('button', { name: 'Apply fix…' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply fix' }));
    const choices = await within(r).findByTestId('tie-choices');
    expect(choices).toHaveTextContent('“Mehrana returns…” (Selyros 40th, 4A 605, n4nl9rud)');
    await user.click(within(choices).getByRole('button', { name: 'Make a new event' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/6/propose-fix')).toHaveLength(2));
    expect(api.find('POST', '/audits/findings/6/propose-fix')[1]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      createNew: true,
    });
  });

  it('the rules editor: seeded defaults, then the owner’s own rules, saved with the tag source and settings', async () => {
    const api = installApi(routes({ 'PUT /audits/config': { ...config, seeded: false } }));
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const card = (await screen.findByRole('heading', { name: 'Rules and settings' })).closest('section')!;
    const seeded = await within(card).findByLabelText(/Use the seeded defaults/);
    expect(seeded).toBeChecked();
    expect(within(card).queryByTestId('rules')).toBeNull();
    await user.click(seeded);
    const rules = within(card).getByTestId('rules');
    expect(rules.querySelector('[data-rule="character-core"]')).not.toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Add a rule' }));
    await user.type(within(card).getByLabelText('Rule 2 id'), 'zoo');
    const fields = rules.querySelectorAll('fieldset')[1]!;
    await user.type(within(fields as HTMLElement).getByLabelText('Ancestor name'), 'Audit Zoo');
    await user.type(within(card).getByLabelText('Rule 2 name'), 'Zoo pages');
    // The template, by name.
    await user.type(within(card).getByLabelText('Rule 2 template name'), 'AI General Source');
    await user.click(within(card).getByLabelText('Report pages no rule matches'));
    await user.click(within(card).getByRole('button', { name: 'Save rules and settings' }));
    await waitFor(() => expect(api.find('PUT', '/audits/config')).toHaveLength(1));
    const body = api.find('PUT', '/audits/config')[0]!.body as { rules: AuditRuleLike[] } & Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      confirm: true,
      project: 'baisheng',
      tagSource: null,
      settings: { reportUnmatched: false, maxSnapshotAgeHours: 36 },
    });
    expect(body.rules).toHaveLength(2);
    expect(body.rules[0]).toMatchObject({
      id: 'character-core',
      template: { registry: { type: 'Character', role: 'core' } },
    });
    expect(body.rules[1]).toMatchObject({
      id: 'zoo',
      name: 'Zoo pages',
      enabled: true,
      selectors: { ancestorName: 'Audit Zoo' },
      template: { templateName: 'AI General Source' },
    });
  });

  it('saving the seeded defaults sends rules: null', async () => {
    const api = installApi(routes({ 'PUT /audits/config': config }));
    const user = userEvent.setup();
    renderApp('/ui/audits');
    await user.click(await screen.findByRole('button', { name: 'Save rules and settings' }));
    await waitFor(() => expect(api.find('PUT', '/audits/config')).toHaveLength(1));
    expect((api.find('PUT', '/audits/config')[0]!.body as { rules: unknown }).rules).toBeNull();
  });

  it('chooses the tag-definition source: a page found by name, then one of its documents', async () => {
    const api = installApi(
      routes({
        'GET /snapshots/pages': {
          project: 'baisheng',
          pages: [{ pageId: 'tagdef01', name: '[BSRC] Tag definitions', lastAt: NOW, deleted: false }],
        },
        'GET /snapshots/pages/tagdef01': { documents: [{ id: 'doc0tag1', name: 'Main' }] },
        'PUT /audits/config': config,
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const card = (await screen.findByRole('heading', { name: 'Rules and settings' })).closest('section')!;
    await within(card).findByLabelText('Find the page');
    expect(card).toHaveTextContent('No tag-definition source');
    await user.type(within(card).getByLabelText('Find the page'), 'Tag');
    await user.click(within(card).getByRole('button', { name: 'Find' }));
    await user.click(await within(card).findByRole('button', { name: '[BSRC] Tag definitions' }));
    // A document must be chosen before saving.
    expect(within(card).getByRole('button', { name: 'Save rules and settings' })).toBeDisabled();
    await user.selectOptions(await within(card).findByLabelText('Document'), 'doc0tag1');
    await user.click(within(card).getByRole('button', { name: 'Save rules and settings' }));
    await waitFor(() => expect(api.find('PUT', '/audits/config')).toHaveLength(1));
    expect(api.find('PUT', '/audits/config')[0]!.body).toMatchObject({
      tagSource: { pageId: 'tagdef01', documentId: 'doc0tag1' },
    });
  });
});
