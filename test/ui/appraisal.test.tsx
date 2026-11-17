// @vitest-environment jsdom
/**
 * v3 F3c (ADR 0054) on the dashboard: the Appraisal page. In the Quality group; the full-text index (its snapshots,
 * freshness, size and timings); running a tool on a branch; the report in its four groups, each finding with a link to
 * the page in LegendKeeper; "Propose a fix" offered ONLY where the finding has a deterministic repair (never for a
 * judgement); the latest runs.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { lkPageUrl } from '../../ui/src/pages/appraisal';
import { baseRoutes, installApi, projectOf, renderApp, useDom } from './helpers';

useDom();

const NOW = Date.now();

const f = (over: Record<string, unknown> = {}) => ({
  id: 'af_00000000000000000001',
  tool: 'arkona_appraise_owner',
  check: 'em_dash_text',
  group: 'required',
  evidence: 'Confirmed deterministic defect',
  rule: { page: 'Source Formatting', section: 'Page Names and Templates' },
  page: {
    id: 'apdashtx',
    name: '[BSRC] Hollin Shore - Polity Reference',
    path: 'AI REPOSITORY / Appraisal Desk / Hollin Shore',
  },
  message: '2 blocks of the body hold an em dash.',
  details: {},
  followUp: {
    kind: 'fix',
    tool: 'arkona_appraisal_fix',
    args: { findingId: 'af_00000000000000000001' },
    change: 'replace each dash in the headings and prose with an ASCII hyphen',
  },
  source: { kind: 'snapshot', snapshotId: 'F1', takenAt: NOW - 60_000 },
  labels: { lifecycle: 'Authoritative', branch: 'Appraisal Desk' },
  ...over,
});
const judgement = f({
  id: 'af_00000000000000000002',
  check: 'purpose_first',
  message: 'The body begins with “Overview”, not a “Purpose” heading.',
  rule: { page: 'Source Formatting', section: 'Body Structure' },
  page: {
    id: 'apnopurp',
    name: '[BSRC] Barid League - Polity Reference',
    path: 'AI REPOSITORY / Appraisal Desk / Barid League',
  },
  followUp: { kind: 'judgement', tool: 'write_page', decide: 'write a Purpose section first' },
});
const polish = f({
  id: 'af_00000000000000000003',
  check: 'related_empty',
  group: 'polish',
  evidence: 'Potential Maintenance Issue',
  message: 'Related Sources is empty.',
  followUp: { kind: 'judgement', tool: 'set_facts', decide: 'review whether any page relates' },
});
const architectural = f({
  id: 'af_00000000000000000004',
  check: 'scope_overload',
  group: 'architectural',
  evidence: 'Potential Maintenance Issue',
  message: 'The page covers 3 specialist domains.',
  followUp: { kind: 'judgement', tool: 'arkona_create_character', decide: 'whether to split' },
});
const blocked = f({
  id: 'af_00000000000000000005',
  check: 'template_unavailable',
  group: 'blocked',
  evidence: 'Incomplete',
  message: 'The page’s template could not be compared.',
  followUp: { kind: 'none', reason: 'the next full snapshot takes the templates' },
});

const report = {
  tool: 'arkona_appraise_owner',
  runId: 'apr_0123456789abcdef',
  scope: { under: 'apdesk01' },
  createdAt: new Date(NOW).toISOString(),
  source: {
    index: {
      base: { id: 'F1', takenAt: new Date(NOW - 3_600_000).toISOString() },
      newest: { id: 'C2', takenAt: new Date(NOW - 60_000).toISOString() },
      changeSnapshots: 2,
      age: '1 min',
      ageMs: 60_000,
    },
  },
  inspected: { pages: 19 },
  couldNotCheck: ['The base full snapshot holds no templates.'],
  counts: { total: 5, required: 2, polish: 1, architectural: 1, blocked: 1, fixable: 1 },
  findings: [f(), judgement, polish, architectural, blocked],
};

const overview = {
  project: { id: 'lkp_arkona', name: 'arkona' },
  attached: true,
  index: {
    baseSnapshotId: 'F1',
    baseTakenAt: NOW - 3_600_000,
    newestSnapshotId: 'C2',
    newestTakenAt: NOW - 60_000,
    changes: 2,
    pages: 1452,
    units: 61000,
    refs: 9000,
    unreadable: 0,
    builtAt: NOW - 3_500_000,
    buildMs: 4200,
    updatedAt: NOW - 60_000,
    lastUpdateMs: 35,
    sizeBytes: 23_500_000,
    notes: [],
  },
  areas: [
    {
      key: 'legacy',
      label: 'Legacy Canon Archive',
      found: [{ id: 'legacy01', name: '[INDEX] Legacy Canon Archive' }],
    },
    { key: 'design', label: 'Design References', found: [] },
  ],
  runs: [
    {
      id: 'apr_0123456789abcdef',
      tool: 'arkona_appraise_owner',
      scopeKey: '[]',
      scope: { under: 'apdesk01' },
      actor: 'owner',
      startedAt: NOW - 120_000,
      finishedAt: NOW - 119_000,
      durationMs: 950,
      counts: { total: 5 },
      compared: null,
    },
  ],
  now: NOW,
};

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /appraisal': overview,
  'POST /appraisal/run': { report },
  'GET /appraisal/runs/apr_0123456789abcdef': { report },
  'POST /appraisal/findings/af_00000000000000000001/propose-fix': {
    status: 'proposal_captured',
    proposalId: 'prop_abc',
    summary: 'Replace the dash in 2 blocks. Last Major Revision skipped: punctuation, not a major revision',
    fix: 'em_dash_text',
    reads: 1,
  },
  'POST /appraisal/index/rebuild': { index: overview.index, reason: null },
  ...over,
});

describe('the Appraisal page', () => {
  it('is in the navigation, under Quality (open on its page)', async () => {
    installApi(routes());
    renderApp('/ui/appraisal');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Quality' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Appraisal' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the full-text index: its snapshots, freshness, size and timings, and the non-current areas', async () => {
    const api = installApi(routes());
    renderApp('/ui/appraisal');
    const card = (await screen.findByRole('heading', { name: 'Full-text index' })).closest('section')!;
    expect(card).toHaveTextContent('F1');
    expect(card).toHaveTextContent('plus 2 change snapshots');
    expect(card).toHaveTextContent('1,452 pages');
    expect(card).toHaveTextContent('built in');
    expect(card).toHaveTextContent('Legacy Canon Archive ([INDEX] Legacy Canon Archive)');
    expect(card).toHaveTextContent('Design References (not found)');
    expect(projectOf(api.find('GET', '/appraisal')[0]!)).toBe('baisheng');
  });

  it('runs a tool on a branch and shows the report in its four groups, a link to each page in LegendKeeper', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/appraisal');
    await screen.findByRole('heading', { name: 'Run' });
    await user.type(screen.getByLabelText('Page or branch'), 'Appraisal Desk');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(api.find('POST', '/appraisal/run')).toHaveLength(1));
    expect(api.find('POST', '/appraisal/run')[0]!.body).toMatchObject({
      confirm: true,
      tool: 'owner',
      under: 'Appraisal Desk',
    });
    const card = await screen.findByTestId('appraisal-report');
    const groups = [...card.querySelectorAll('[data-group]')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual([
      'Required defects',
      'Optional polish',
      'Architectural candidates',
      'Blocked cases',
    ]);
    expect(within(card).getByTestId('could-not-check')).toHaveTextContent('holds no templates');
    const link = within(card).getAllByRole('link', { name: '[BSRC] Hollin Shore - Polity Reference' })[0]!;
    expect(link).toHaveAttribute('href', lkPageUrl('lkp_arkona', 'apdashtx'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('offers Propose a fix only where the finding has a deterministic repair, and a judgement says what to decide', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/appraisal');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const card = await screen.findByTestId('appraisal-report');
    const row = (id: string) => card.querySelector<HTMLElement>(`[data-finding="${id}"]`)!;
    expect(
      within(row('af_00000000000000000001')).getByRole('button', { name: 'Propose a fix' }),
    ).toBeInTheDocument();
    for (const id of [
      'af_00000000000000000002',
      'af_00000000000000000003',
      'af_00000000000000000004',
      'af_00000000000000000005',
    ])
      expect(within(row(id)).queryByRole('button', { name: 'Propose a fix' })).toBeNull();
    expect(within(row('af_00000000000000000002')).getByTestId('judgement')).toHaveTextContent(
      'Judgement: write a Purpose section first (write_page)',
    );
    expect(card.querySelectorAll('button')).toHaveLength(1);
    // Proposing asks first, then says it is a proposal.
    await user.click(within(row('af_00000000000000000001')).getByRole('button', { name: 'Propose a fix' }));
    await user.click(await screen.findByRole('button', { name: 'Propose the fix' }));
    await waitFor(() =>
      expect(api.find('POST', '/appraisal/findings/af_00000000000000000001/propose-fix')).toHaveLength(1),
    );
    expect(
      await within(row('af_00000000000000000001')).findByText(/Proposed \(prop_abc\)/),
    ).toBeInTheDocument();
  });

  it('lists the latest runs; opening one shows its stored report', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/appraisal');
    const runs = await screen.findByRole('table', { name: 'Latest runs' });
    await user.click(within(runs).getByRole('button', { name: 'Owner appraisal (A2)' }));
    await waitFor(() => expect(api.find('GET', '/appraisal/runs/apr_0123456789abcdef')).toHaveLength(1));
    expect(await screen.findByTestId('appraisal-report')).toHaveTextContent('apr_0123456789abcdef');
  });

  it('says so when the pack is not attached', async () => {
    installApi(routes({ 'GET /appraisal': { ...overview, attached: false } }));
    renderApp('/ui/appraisal');
    expect(await screen.findByTestId('not-attached')).toHaveTextContent('not attached');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });
});
