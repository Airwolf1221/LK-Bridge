// @vitest-environment jsdom
/**
 * v3 F4b (ADR 0064, D6) on the dashboard: "Pick the right value" on a consistency finding of the Audits page: both values
 * side by side (the identity page's first), an agent's suggestion shown (never applied), the pick sent with the side
 * chosen after a confirmation, or a typed value; no "Re-check now" on a consistency finding.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const NOW = Date.now();

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

const baseAuditRoutes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /audits': overview(),
  'GET /audits/findings': findings([finding(), second, noFix]),
  'GET /audits/config': config,
  'GET /snapshots/pages': { project: 'baisheng', pages: [] },
  ...over,
});

const consistencyFinding = finding({
  id: 9,
  code: 'consistency_birth',
  category: 'consistency',
  pageId: 'katscor1',
  pageName: '[BSRC] Katsuragi Yamato - Character Core',
  pagePath: 'AI REPOSITORY / Characters / Katsuragi Yamato',
  documentId: null,
  blockId: null,
  message: 'Contradictory: Katsuragi Yamato’s birth is Isar 3rd, 4A 300 on the Core, but 4A 305 on Velara.',
  evidence: { consistencyId: 'cf_65a23aebcd9d27fe7074', subject: 'Katsuragi Yamato', what: 'birth' },
  fix: null,
});
const view = {
  finding: { id: 9, consistencyId: 'cf_65a23aebcd9d27fe7074', message: consistencyFinding.message },
  subject: 'Katsuragi Yamato',
  what: 'birth',
  values: [
    {
      key: 'katscor1::kv:birth.scope:5',
      page: { id: 'katscor1', name: '[BSRC] Katsuragi Yamato - Character Core' },
      lifecycle: 'Authoritative',
      value: 'Isar 3rd, 4A 300',
      precision: 'day',
      source: 'temporalScope',
      section: 'sidebar: PROPERTIES',
      excerpt: 'Temporal Scope: Born Isar 3rd, 4A 300',
    },
    {
      key: 'natnref1:d1:nv3:birth.prose:1',
      page: { id: 'natnref1', name: '[BSRC] Velara - Polity Reference' },
      lifecycle: 'Authoritative',
      value: '4A 305',
      precision: 'year',
      source: 'prose',
      section: 'Purpose',
      excerpt: 'Rita von Katzen was born in 4A 305, in the river quarter.',
    },
  ],
  suggestions: [
    {
      id: 1,
      value: 'Isar 3rd, 4A 300',
      reason: 'The Core is the identity page.',
      principalId: 'claude',
      createdAt: new Date(NOW).toISOString(),
    },
  ],
  picks: [],
  rule: 'The check never decides which value is right.',
};
const routes = (over: Record<string, unknown> = {}) =>
  baseAuditRoutes({
    'GET /audits/findings': findings([consistencyFinding]),
    'GET /audits/findings/9/consistency': view,
    ...over,
  });

describe('Pick the right value (v3 F4b)', () => {
  it('shows both values side by side and the agent’s suggestion; picks a side after a confirmation, then one job (v3 F12)', async () => {
    const api = installApi(
      routes({
        'POST /audits/findings/9/consistency-pick': {
          jobId: 'job_88',
          items: [{ id: 'page:natnref1', label: 'Velara: 4A 305 → Isar 3rd, 4A 300' }],
          untouched: [{ page: 'Core', value: 'Isar 3rd, 4A 300', why: 'the side picked' }],
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const row = table.querySelector('[data-finding="9"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Re-check now' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Apply fix…' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Pick the right value' }));
    const values = await screen.findByRole('table', { name: 'The values side by side' });
    const rows = within(values).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Isar 3rd, 4A 300');
    expect(rows[0]).toHaveTextContent('the identity page’s value');
    expect(rows[1]).toHaveTextContent('4A 305');
    expect(rows[1]).toHaveTextContent('Rita von Katzen was born in 4A 305');
    expect(screen.getByText(/Suggested by agents/)).toBeInTheDocument();
    expect(screen.getByText(/The Core is the identity page/)).toBeInTheDocument();
    await user.click(within(rows[0]!).getByRole('button', { name: 'Pick this value' }));
    await user.click(await screen.findByRole('button', { name: 'Pick and apply' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/9/consistency-pick')).toHaveLength(1));
    // CR-2026-11-R4 (PK-51): the side goes with its value as shown, so the bridge refuses it if it reads otherwise now.
    expect(api.find('POST', '/audits/findings/9/consistency-pick')[0]!.body).toEqual({
      confirm: true,
      project: 'baisheng',
      side: 'katscor1::kv:birth.scope:5',
      shown: 'Isar 3rd, 4A 300',
    });
    // v3 F12 (ADR 0081): the confirmed pick runs at once as one job.
    expect(await screen.findByText('job_88')).toBeInTheDocument();
    expect(screen.getByText(/Applying as job/)).toBeInTheDocument();
  });

  it('sends a typed value', async () => {
    const api = installApi(
      routes({
        'POST /audits/findings/9/consistency-pick': { jobId: 'job_89', items: [], untouched: [] },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/audits');
    const table = await screen.findByRole('table', { name: 'Findings' });
    const row = table.querySelector('[data-finding="9"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Pick the right value' }));
    await user.type(await screen.findByLabelText('Or the right value'), 'Isar 4th, 4A 300');
    await user.click(screen.getByRole('button', { name: 'Apply this value…' }));
    await user.click(await screen.findByRole('button', { name: 'Pick and apply' }));
    await waitFor(() => expect(api.find('POST', '/audits/findings/9/consistency-pick')).toHaveLength(1));
    expect(api.find('POST', '/audits/findings/9/consistency-pick')[0]!.body).toMatchObject({
      value: 'Isar 4th, 4A 300',
    });
  });
});
