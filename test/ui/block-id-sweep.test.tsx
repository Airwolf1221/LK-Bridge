// @vitest-environment jsdom
/**
 * v3 F3.5 (ADR 0056): the block-id sweep's card on the Maintenance Jobs page: the six-point approved-automation
 * statement word for word, the sandbox prerequisite, the candidates per project, a stop in red with the journal entry
 * to restore from, the limit, and the dry run (which writes nothing).
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_STATEMENT } from '../../src/blockids/statement';
import { PROJECT_ID, baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const NOW = Date.now();
const ID = 'assign-block-ids-sweep';

const sweepJob = {
  id: ID,
  name: 'Assign block IDs sweep',
  description: 'Gives legacy page documents block ids.',
  implemented: true,
  writes: true,
  enabled: false,
  scope: 'project',
  schedule: { kind: 'daily', time: '05:30' },
  scheduleText: 'Daily at 05:30 (London time)',
  defaultSchedule: { kind: 'daily', time: '05:30' },
  scheduleOverridden: false,
  priority: 'P3',
  running: false,
  lastRun: null,
  nextRunAt: null,
  note: null,
  projects: [],
};

const card = (over: Record<string, unknown> = {}) => ({
  card: {
    jobId: ID,
    statement: AUTOMATION_STATEMENT,
    prerequisite: {
      ok: true,
      reason: null,
      version: '1.0.2',
      pass: { bridgeVersion: '1.0.2', project: 'test', verdict: 'PASS', detail: null, at: NOW - 3_600_000 },
      override: null,
      recent: [],
    },
    maxPerRun: 20,
    stop: null,
    projects: [
      {
        project: 'test',
        projectId: PROJECT_ID,
        snapshot: { id: 'snap1', takenAt: NOW - 7_200_000 },
        candidates: 37,
        remaining: 30,
        unreadable: 0,
        counts: { done: 7, already: 0, moved: 1, unverified: 0, failed: 0, gone: 0, error: 0 },
      },
    ],
    ...over,
  },
});

const routes = (extra: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /maintenance': { jobs: [sweepJob], schedulerEnabled: true, now: NOW },
  [`GET /maintenance/${ID}/card`]: card(),
  ...extra,
});

const section = () =>
  screen.findByRole('region', { name: /Assign block IDs sweep: an approved narrow automation/ });

describe('the block-id sweep card', () => {
  it('shows the six points word for word, the PASS for this version and the candidates per project', async () => {
    installApi(routes());
    renderApp('/ui/maintenance');
    const s = within(await section());
    const points = within(s.getByRole('list', { name: 'Approved-automation statement' })).getAllByRole(
      'listitem',
    );
    expect(points.map((p) => p.textContent)).toEqual(
      AUTOMATION_STATEMENT.map((p) => `${p.title}. ${p.text}`),
    );
    expect(s.getByText('PASS')).toBeInTheDocument();
    const row = within(s.getByRole('table', { name: 'Candidates per project' }));
    expect(row.getByText('37')).toBeInTheDocument();
    expect(row.getByText('30')).toBeInTheDocument();
    expect(s.queryByRole('alert')).toBeNull();
  });

  it('shows a stop in red, with the journal entry to restore from', async () => {
    installApi(
      routes({
        [`GET /maintenance/${ID}/card`]: card({
          stop: {
            projectId: PROJECT_ID,
            project: 'test',
            resourceId: 'page0001',
            documentId: 'doc00001',
            page: 'Old Quay',
            jobId: 'jsweep01',
            journalId: 42,
            reason: 'the document read back differs from its pre-image, block ids aside',
            differences: [{ path: 'blocks[0].content[0].text', expected: 'old', actual: 'new' }],
            at: NOW - 60_000,
            acknowledgedAt: null,
          },
        }),
      }),
    );
    renderApp('/ui/maintenance');
    const alert = within(await screen.findByRole('alert', { name: 'The sweep stopped' }));
    expect(alert.getByText('Stopped: verification failed')).toBeInTheDocument();
    expect(alert.getByText('#42')).toBeInTheDocument();
    expect(alert.getByText(/Restore from journal/)).toBeInTheDocument();
    expect(alert.getByRole('link', { name: 'journal' })).toHaveAttribute(
      'href',
      '/ui/journal?jobId=jsweep01&project=test',
    );
    expect(alert.getByText('blocks[0].content[0].text')).toBeInTheDocument();
  });

  it('the dry run lists the next run’s documents and says nothing was written; the limit is saved', async () => {
    const api = installApi(
      routes({
        [`POST /maintenance/${ID}/dry-run`]: {
          dryRun: {
            project: 'test',
            candidates: 37,
            remaining: 30,
            maxPerRun: 20,
            next: [
              {
                resourceId: 'page0001',
                documentId: 'doc00001',
                page: 'Old Quay',
                path: 'AI REPOSITORY / Old Quay',
                document: 'Main',
                blocks: 12,
                missing: 3,
                duplicates: 0,
                unsupported: 1,
                why: 'candidate',
                retry: false,
              },
            ],
            estimate: {
              reads: 4,
              writes: 1,
              wallClockMs: 2000,
              tightestTier: 'pacing',
              fitsToday: true,
              note: 'About.',
            },
            prerequisite: {
              ok: true,
              reason: null,
              version: '1.0.2',
              pass: null,
              override: null,
              recent: [],
            },
            stopped: false,
          },
        },
        [`PUT /maintenance/${ID}/limit`]: { maxPerRun: 5 },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    const s = within(await section());
    await user.click(s.getByRole('button', { name: /Dry run/ }));
    const dry = within(await screen.findByLabelText('Dry run'));
    expect(dry.getByText('AI REPOSITORY / Old Quay')).toBeInTheDocument();
    expect(dry.getByText(/Nothing was written/)).toBeInTheDocument();
    expect(api.find('POST', `/maintenance/${ID}/dry-run`)).toHaveLength(1);
    const limit = s.getByLabelText('At most');
    await user.clear(limit);
    await user.type(limit, '5');
    await user.click(s.getByRole('button', { name: 'Save' }));
    expect(api.find('PUT', `/maintenance/${ID}/limit`)[0]!.body).toEqual({ maxPerRun: 5 });
  });
});
