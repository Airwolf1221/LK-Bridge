// @vitest-environment jsdom
/**
 * v2 E1a (ADR 0042) on the dashboard: the Snapshots page (the store against the disk, findings, runs, the snapshots, a
 * page's history with its diff, "Propose a restore" with a dry run first, a deleted image, the rehearsal, the database
 * copies), the schedule on the Maintenance Jobs page, and a restore proposal on the Proposals page.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, inflightPaths } from '../../ui/src/api';
import { figuresText, rehearsalProgress } from '../../ui/src/pages/snapshots';
import type { RehearsalView } from '../../ui/src/types';
import { baseRoutes, installApi, navLink, projectOf, renderApp, useDom, type Call } from './helpers';

useDom();

const NOW = Date.now();
const GIB = 1024 ** 3;
const SNAP = '20261108T003000Z-full-0123abcd';
const CHANGE = '20261111T101500Z-change-4567cdef';

const snapshotRow = (over: Record<string, unknown> = {}) => ({
  id: SNAP,
  projectId: 'lkp_baisheng',
  kind: 'full',
  state: 'complete',
  takenAt: NOW - 4 * 86_400_000,
  startedAt: NOW - 4 * 86_400_000 - 600_000,
  pages: 1500,
  pieces: 6000,
  logicalBytes: 40 * 1024 ** 2,
  newObjects: 120,
  newBytes: 3 * 1024 ** 2,
  reads: 3300,
  downloads: 12,
  missing: 0,
  trigger: { trigger: 'schedule' },
  summary: '1500 pages',
  damaged: null,
  ...over,
});

const response = (over: Record<string, unknown> = {}) => ({
  project: 'baisheng',
  overview: {
    dir: '/var/lib/lk-bridge/snapshots',
    exists: true,
    store: {
      objects: 9000,
      objectBytes: 900 * 1024 ** 2,
      manifests: 40,
      manifestBytes: 2 * 1024 ** 2,
      bytes: 902 * 1024 ** 2,
    },
    disk: { total: 144 * 1e9, free: 63 * 1e9 },
    minFreeBytes: 10 * GIB,
    headroom: 63 * 1e9 - 10 * GIB,
    logical: { referenced: 12 * GIB, unique: 1 * GIB, uniqueCount: 9000 },
    dedupRatio: 12,
    compressionRatio: 1.2,
    retention: { keepFullDays: 30, keepWeekly: 8, keepDays: 30, softDeleteDays: 30 },
    counts: { full: { count: 1, last: NOW - 4 * 86_400_000 } },
    nextFullEstimate: 2 * GIB,
    runs: [
      {
        id: 'run_00000000000000a1',
        projectId: 'lkp_baisheng',
        kind: 'full',
        state: 'running',
        trigger: 'manual',
        startedAt: NOW - 60_000,
        updatedAt: NOW - 1000,
        finishedAt: null,
        total: 1500,
        done: 300,
        reads: 650,
        downloads: 3,
        newObjects: 10,
        newBytes: 4096,
        estimate: null,
        error: null,
        snapshotId: null,
      },
    ],
    owed: 0,
    findings: [
      {
        id: 1,
        sha256: 'ab'.repeat(32),
        problem: 'corrupt',
        detail: 'hash mismatch',
        snapshots: [SNAP],
        foundAt: NOW - 3_600_000,
      },
    ],
    notices: [],
  },
  snapshots: [
    snapshotRow({
      id: CHANGE,
      kind: 'change',
      pages: 1,
      trigger: { tool: 'write_page' },
      takenAt: NOW - 3_600_000,
    }),
    snapshotRow({ state: 'partial', missing: 1, damaged: 'a stored piece is damaged' }),
  ],
  restores: [],
  rehearsals: [
    {
      id: 'rh_00000000000000b1',
      projectId: 'lkp_test',
      sourceProjectId: 'lkp_baisheng',
      snapshotId: SNAP,
      mode: 'sampled',
      state: 'succeeded',
      keep: true,
      rootId: 'rootxyz1',
      rootName: 'lk-bridge rehearsal 2026-11-11T10:00:00Z',
      rootState: 'kept',
      startedBy: 'owner',
      startedAt: NOW - 7_200_000,
      finishedAt: NOW - 7_000_000,
      estimate: { writes: 400, reads: 300 },
      plan: { pages: [] },
      progress: {},
      result: {
        pagesCompared: 50,
        exact: 49,
        differences: [{ page: 'Old Harbour', piece: 'sidebar', reason: 'Status differs' }],
        cannotRestore: [{ page: 'Atlas', reason: 'an unsupported block (no longer on the page)' }],
        images: { uploaded: 4, of: 4 },
        cost: { writes: 410, reads: 290 },
        ms: 200_000,
      },
      error: null,
    },
  ],
  sandboxes: [{ name: 'test', id: 'lkp_test', active: true }],
  jobs: [
    {
      id: 'snapshot-full',
      name: 'Full snapshot',
      enabled: true,
      scheduleText: 'Daily at 00:30 (London time)',
      nextRunAt: NOW + 86_400_000,
      lastRun: null,
    },
  ],
  backups: {
    dir: '/var/lib/lk-bridge/backups',
    files: [
      { name: 'nightly-20261111T023000Z.db.gz', label: 'nightly', size: 5_000_000, at: NOW - 10 * 3_600_000 },
    ],
  },
  now: NOW,
  ...over,
});

const pageResponse = {
  project: 'baisheng',
  page: { id: 'atlas5np', name: 'Atlas', live: true },
  documents: [{ id: 'docmain1', name: 'Main' }],
  history: {
    count: 1,
    snapshots: [
      {
        snapshot: SNAP,
        takenAt: new Date(NOW - 4 * 86_400_000).toISOString(),
        kind: 'full',
        pieces: [
          { piece: 'settings', change: 'first seen' },
          { piece: 'document Main', documentId: 'docmain1', change: 'first seen' },
        ],
      },
    ],
  },
  restores: [],
};

const plan = {
  page: { id: 'atlas5np', name: 'Atlas' },
  scope: 'document',
  mode: null,
  snapshot: { id: SNAP, takenAt: NOW - 4 * 86_400_000, kind: 'full' },
  summary: 'restore_snapshot: Atlas, document Main, to the full snapshot of 8 November',
  pieces: [{ label: 'document Main', diff: '-Notes rewritten.\n+First notes.' }],
  writes: 1,
  lost: [{ what: 'an unsupported block', where: 'Main', why: 'it is no longer on the page' }],
  kept: [],
  notRestored: [],
  warnings: [],
  idMap: null,
  followUp: null,
  reads: 2,
};

const routes = (extra: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /snapshots': response(),
  'GET /snapshots/pages': {
    project: 'baisheng',
    pages: [{ pageId: 'atlas5np', name: 'Atlas', lastAt: NOW - 3_600_000, deleted: false }],
  },
  'GET /snapshots/pages/atlas5np': pageResponse,
  ...extra,
});

describe('the Snapshots page', () => {
  it('shows the store against the disk, the findings, the runs, the snapshots and the database copies', async () => {
    installApi(routes());
    renderApp('/ui/snapshots');
    expect(await screen.findByTestId('store-size')).toHaveTextContent('9,000 pieces');
    expect(screen.getByTestId('dedup')).toHaveTextContent('12.0×');
    expect(screen.getByTestId('free-space')).toHaveTextContent(
      /58\.7 GB free of 134\.1 GB; the minimum kept free is 10\.0 GB/,
    );
    expect(screen.getByTestId('next-estimate')).toHaveTextContent('fits');
    // A damaged piece is a finding, and its snapshot is partial.
    expect(screen.getByRole('alert', { name: '' })).toBeDefined();
    expect(screen.getByText(/1 stored piece is missing or damaged/)).toBeInTheDocument();
    const list = screen.getByRole('table', { name: 'Snapshots' });
    expect(within(list).getByText(/partial: 1 missing/)).toBeInTheDocument();
    expect(within(list).getByText('(write_page)')).toBeInTheDocument();
    // The run in progress, with its schedule.
    const runs = screen.getByRole('table', { name: 'Runs' });
    expect(within(runs).getByText('300 of 1,500')).toBeInTheDocument();
    // v3 F9 (ADR 0074): the running full snapshot's progress, pages done of the total, on the card.
    expect(screen.getByTestId('full-progress')).toHaveTextContent(
      'Full snapshot running: 300 of 1,500 pages (20%), at P4 (bulk)',
    );
    expect(screen.getByText(/Daily at 00:30/)).toBeInTheDocument();
    // The retention: every full snapshot for 30 days, then one a week for 8 weeks.
    expect(
      screen.getByText(/every full snapshot for 30 days, then one a week \(the latest of each ISO week\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/for 8 weeks; change snapshots for 30 days/)).toBeInTheDocument();
    // The nightly database copy, with its age.
    const copies = screen.getByRole('table', { name: 'Database copies' });
    expect(within(copies).getByText('nightly-20261111T023000Z.db.gz')).toBeInTheDocument();
  });

  it('v3 F9 amendment 1: says what holds the running full snapshot, and since when the daily tier has', async () => {
    const r = response();
    installApi(
      routes({
        'GET /snapshots': {
          ...r,
          overview: {
            ...r.overview,
            bulkWait:
              'bulk waiting: the daily tier is at 85.0% and bulk may use it up to 85% (frees in 4 h 24 min)',
            dayHold: {
              runId: 'run1',
              sinceMs: NOW - 600_000,
              lastSeenMs: NOW,
              holding: true,
              endedAtMs: null,
              text: 'bulk waiting: the daily tier is at 85.0% and bulk may use it up to 85% (frees in 4 h 24 min)',
              freesAtMs: NOW + 15_840_000,
            },
          },
        },
      }),
    );
    renderApp('/ui/snapshots');
    expect(await screen.findByTestId('bulk-wait')).toHaveTextContent(
      'Now bulk waiting: the daily tier is at 85.0% and bulk may use it up to 85% (frees in 4 h 24 min).',
    );
    expect(screen.getByTestId('day-hold')).toHaveTextContent(
      /The full snapshot is held by the daily tier’s floor \(since .*\): bulk waiting: the daily tier is at 85\.0%.*It goes on from the page it reached when the tier frees/,
    );
  });

  it('warns when the next full snapshot does not fit, and when the nightly copy is old', async () => {
    const r = response();
    installApi(
      routes({
        'GET /snapshots': {
          ...r,
          overview: { ...r.overview, headroom: GIB, nextFullEstimate: 2 * GIB },
          backups: {
            dir: '/b',
            files: [
              { name: 'nightly-20261101T023000Z.db.gz', label: 'nightly', size: 1, at: NOW - 3 * 86_400_000 },
            ],
          },
        },
      }),
    );
    renderApp('/ui/snapshots');
    expect(await screen.findByTestId('next-estimate')).toHaveTextContent('does not fit');
    expect(screen.getByText(/The newest nightly copy is .* old/)).toBeInTheDocument();
  });

  it('opens a page’s history from a link on the Audits page (/snapshots?page=<id>)', async () => {
    const api = installApi(routes());
    renderApp('/ui/snapshots?page=atlas5np');
    await waitFor(() => expect(api.find('GET', '/snapshots/pages/atlas5np').length).toBeGreaterThan(0));
    expect(projectOf(api.find('GET', '/snapshots/pages/atlas5np')[0]!)).toBe('baisheng');
  });

  it('takes a full snapshot now, in the selected project', async () => {
    const api = installApi(
      routes({ 'POST /snapshots/full': { status: 202, body: { project: 'baisheng', run: null } } }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    await user.click(await screen.findByRole('button', { name: 'Take a full snapshot now' }));
    await waitFor(() => expect(api.find('POST', '/snapshots/full')).toHaveLength(1));
    expect(projectOf(api.find('POST', '/snapshots/full')[0]!)).toBe('baisheng');
  });

  it('abandons a run after a confirmation', async () => {
    const api = installApi(routes({ 'POST /snapshots/runs/run_00000000000000a1/abandon': { run: null } }));
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    const runs = await screen.findByRole('table', { name: 'Runs' });
    await user.click(within(runs).getByRole('button', { name: 'Abandon' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Abandon' }));
    await waitFor(() =>
      expect(api.find('POST', '/snapshots/runs/run_00000000000000a1/abandon')).toHaveLength(1),
    );
    expect(api.find('POST', '/snapshots/runs/run_00000000000000a1/abandon')[0]!.body).toEqual({
      confirm: true,
    });
  });

  it('a page’s history: its diff with now, then "Propose a restore" (a dry run first, then the proposal)', async () => {
    const restoreBodies: unknown[] = [];
    const api = installApi(
      routes({
        'GET /snapshots/diff': {
          page: 'atlas5np',
          piece: 'document',
          ref: 'docmain1',
          from: SNAP,
          to: 'now',
          identical: false,
          added: 1,
          removed: 1,
          diff: {
            added: 1,
            removed: 1,
            hunks: [
              {
                beforeStart: 1,
                beforeLines: 1,
                afterStart: 1,
                afterLines: 1,
                lines: [
                  { kind: 'del', text: 'First notes.' },
                  { kind: 'add', text: 'Notes rewritten.' },
                ],
              },
            ],
          },
          text: '',
          reads: 2,
        },
        'POST /snapshots/restore': (c: Call) => {
          restoreBodies.push(c.body);
          return (c.body as { dryRun?: boolean }).dryRun
            ? { status: 'dry_run', plan }
            : { status: 'proposal_captured', proposalId: 'prop_rst1', restoreId: 'rst_1', plan };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    await user.click(await screen.findByRole('button', { name: 'Atlas' }));
    const history = await screen.findByRole('table', { name: 'Page history' });
    // The document's diff with now.
    const diffButtons = within(history).getAllByRole('button', { name: 'Diff with now' });
    await user.click(diffButtons[1]!);
    await waitFor(() => expect(api.find('GET', '/snapshots/diff')).toHaveLength(1));
    expect(api.find('GET', '/snapshots/diff')[0]!.query).toContain('ref=docmain1');
    expect(await screen.findByText('Notes rewritten.')).toBeInTheDocument();

    // Propose a restore of the document: the dry run first.
    await user.click(within(history).getByRole('button', { name: 'Propose a restore' }));
    const form = await screen.findByRole('form', { name: `Propose a restore to ${SNAP}` });
    await user.selectOptions(within(form).getByLabelText('What to restore'), 'document');
    await user.click(within(form).getByRole('button', { name: 'Preview' }));
    expect(await within(form).findByText(/Cannot be restored exactly/)).toBeInTheDocument();
    expect(within(form).getByText(/it is no longer on the page/)).toBeInTheDocument();
    expect(restoreBodies[0]).toEqual({
      page: 'atlas5np',
      snapshot: SNAP,
      scope: 'document',
      document: 'docmain1',
      dryRun: true,
    });
    await user.click(within(form).getByRole('button', { name: 'Propose this restore' }));
    expect(await within(form).findByRole('link', { name: 'Open it on the Proposals page' })).toHaveAttribute(
      'href',
      '/ui/proposals?id=prop_rst1',
    );
    expect(restoreBodies[1]).toEqual({
      page: 'atlas5np',
      snapshot: SNAP,
      scope: 'document',
      document: 'docmain1',
    });
  });

  it('a deleted image: the pages that referred to it, and the owner’s tick to update them', async () => {
    const bodies: unknown[] = [];
    installApi(
      routes({
        'POST /snapshots/restore-image': (c: Call) => {
          bodies.push(c.body);
          const refs = [
            {
              pageId: 'atlas5np',
              page: 'Atlas',
              documents: [{ id: 'docmain1', name: 'Main', what: 'image blocks' }],
              byHand: [],
            },
          ];
          const image = { name: 'Weeping Sea', path: ['Characters'], creates: [] };
          return (c.body as { dryRun?: boolean }).dryRun
            ? { status: 'dry_run', old: { name: 'Weeping Sea' }, references: refs, image }
            : {
                status: 'proposal_captured',
                proposalId: 'prop_img1',
                old: {},
                references: refs,
                image: { ...image, stagedId: 'img_1' },
              };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    await user.type(await screen.findByLabelText('The deleted image’s asset id'), 'imgsea01');
    await user.click(screen.getByRole('checkbox', { name: /Also update the pages/ }));
    const card = screen.getByRole('region', { name: 'Restore a deleted image' });
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    expect(await within(card).findByText(/Main \(image blocks\)/)).toBeInTheDocument();
    // v3 F3c (ADR 0051): where it goes back; nothing is sent to LegendKeeper before approval.
    expect(within(card).getByText(/Goes back to/)).toHaveTextContent(
      'Goes back to Characters as “Weeping Sea”. Nothing is sent to LegendKeeper until the proposal is approved',
    );
    await user.click(within(card).getByRole('button', { name: 'Propose it' }));
    expect(
      await within(card).findByRole('link', { name: 'Open it on the Proposals page' }),
    ).toBeInTheDocument();
    expect(bodies).toEqual([
      { snapshot: CHANGE, asset: 'imgsea01', updateReferences: true, dryRun: true },
      { snapshot: CHANGE, asset: 'imgsea01', updateReferences: true },
    ]);
  });

  it('the rehearsal: its estimate first, then started after a confirmation; its results and its kept root', async () => {
    const api = installApi(
      routes({
        'POST /snapshots/rehearsals/plan': {
          plan: {
            source: { projectId: 'lkp_baisheng', snapshotId: SNAP, takenAt: '', kind: 'full' },
            target: { projectId: 'lkp_test', name: 'test' },
            mode: 'sampled',
            pages: Array.from({ length: 50 }, (_, i) => `p${i}`),
            coverage: {},
            images: 4,
            estimate: { reads: 300, writes: 400, uploads: 4, wallClockMs: 600_000, fitsToday: true },
          },
        },
        'POST /snapshots/rehearsals': { status: 202, body: { rehearsal: {} } },
        'POST /snapshots/rehearsals/rh_00000000000000b1/delete-root': { rehearsal: {} },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    const card = await screen.findByRole('region', { name: 'Restore rehearsal' });
    // Only a full snapshot can be rehearsed; the partial one is marked.
    expect(within(card).getByLabelText(`Full snapshot of baisheng`)).toHaveTextContent('partial');
    await user.click(within(card).getByRole('button', { name: 'Estimate' }));
    expect(await within(card).findByLabelText('Rehearsal estimate')).toHaveTextContent('50 pages, 4 images');
    expect(api.find('POST', '/snapshots/rehearsals/plan')[0]!.body).toEqual({
      target: 'test',
      snapshot: SNAP,
      mode: 'sampled',
    });
    await user.click(within(card).getByRole('button', { name: 'Start the rehearsal' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Nothing outside it is written');
    await user.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.find('POST', '/snapshots/rehearsals')).toHaveLength(1));
    expect(api.find('POST', '/snapshots/rehearsals')[0]!.body).toEqual({
      target: 'test',
      snapshot: SNAP,
      mode: 'sampled',
      keep: false,
      confirm: true,
    });

    // The finished one: its results and its kept root.
    const table = within(card).getByRole('table', { name: 'Rehearsals' });
    expect(within(table).getByText(/49 of 50 exact/)).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Details' }));
    expect(within(table).getByText(/Status differs/)).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Delete its root' }));
    const d2 = await screen.findByRole('alertdialog');
    await user.click(within(d2).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(api.find('POST', '/snapshots/rehearsals/rh_00000000000000b1/delete-root')).toHaveLength(1),
    );
  });

  it('E5.4: the rehearsal preselects the newest COMPLETE full snapshot, marks a partial one, and shows what a sample leaves out', async () => {
    const COMPLETE = '20261105T003000Z-full-0fedcba9';
    const NEWER_PARTIAL = '20261114T003000Z-full-0aaaaaaa';
    const api = installApi(
      routes({
        'GET /snapshots': response({
          snapshots: [
            snapshotRow({ id: NEWER_PARTIAL, state: 'partial', missing: 1, takenAt: NOW - 86_400_000 }),
            snapshotRow({ id: SNAP, state: 'partial', missing: 2 }),
            snapshotRow({ id: COMPLETE, state: 'complete', takenAt: NOW - 10 * 86_400_000 }),
          ],
        }),
        'POST /snapshots/rehearsals/plan': {
          plan: {
            source: { projectId: 'lkp_baisheng', snapshotId: COMPLETE, takenAt: '', kind: 'full' },
            target: { projectId: 'lkp_test', name: 'test' },
            mode: 'sampled',
            pages: ['p1', 'p2'],
            coverage: {},
            images: 0,
            cuts: [
              {
                page: 'Chronology',
                document: 'Timeline',
                what: 'events',
                kept: 25,
                of: 730,
                lanes: { kept: 4, of: 9 },
              },
              { page: 'World Map', document: 'Map', what: 'features', kept: 40, of: 310 },
            ],
            estimate: {
              reads: 120,
              writes: 180,
              uploads: 0,
              wallClockMs: 300_000,
              fitsToday: true,
              pacing: { msPerWrite: 1000, msPerRead: 400 },
            },
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    const card = await screen.findByRole('region', { name: 'Restore rehearsal' });
    const picker = within(card).getByLabelText<HTMLSelectElement>('Full snapshot of baisheng');
    expect(picker.value).toBe(COMPLETE);
    const options = within(picker).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringMatching(/\(partial\)$/),
      expect.stringMatching(/\(partial\)$/),
      expect.not.stringMatching(/partial/),
    ]);
    await user.click(within(card).getByRole('button', { name: 'Estimate' }));
    expect(await within(card).findByLabelText('Rehearsal estimate')).toHaveTextContent(
      'Paced at about 1.0 s a write and 0.4 s a read.',
    );
    expect(api.find('POST', '/snapshots/rehearsals/plan')[0]!.body).toMatchObject({ snapshot: COMPLETE });
    const cuts = within(card).getByLabelText('What the sample leaves out');
    expect(cuts).toHaveTextContent('Chronology, Timeline: 25 of 730 events (with the 4 of 9 lanes they use)');
    expect(cuts).toHaveTextContent('World Map, Map: 40 of 310 features');
  });

  it('E5.5: the estimate says which figures it used: the measured write time and the assets group’s learned limit', async () => {
    installApi(
      routes({
        'POST /snapshots/rehearsals/plan': {
          plan: {
            source: { projectId: 'lkp_baisheng', snapshotId: SNAP, takenAt: '', kind: 'full' },
            target: { projectId: 'lkp_test', name: 'test' },
            mode: 'sampled',
            pages: ['p1'],
            coverage: {},
            images: 3,
            estimate: {
              reads: 120,
              writes: 180,
              uploads: 3,
              wallClockMs: 300_000,
              fitsToday: true,
              pacing: { msPerWrite: 1500, msPerRead: 400 },
              figures: {
                perWrite: { ms: 1500, from: 'measured', measuredMs: 1500, samples: 200, spacingMs: 500 },
                limits: [{ tier: 'write-min', limit: 120, windowMs: 60_000, share: 60 }],
                groups: [{ group: 'assets', limit: 20, windowMs: 60_000, steps: 8, ms: 12_000 }],
              },
            },
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    const card = await screen.findByRole('region', { name: 'Restore rehearsal' });
    await user.click(within(card).getByRole('button', { name: 'Estimate' }));
    const figures = await within(card).findByLabelText('Estimate figures');
    expect(figures).toHaveTextContent('a write takes about 1.5 s, the median of the last 200 write steps');
    expect(figures).toHaveTextContent('writes at 120 a minute (this run’s share 60)');
    expect(figures).toHaveTextContent(
      'the assets group’s learned limit of 20 a minute paces its 8 steps (about 12 s)',
    );
  });

  it('E5.5: a running rehearsal shows its stage, writes and reads against the plan, the time and the projected finish', async () => {
    const running = {
      ...response().rehearsals[0]!,
      id: 'rh_00000000000000c2',
      state: 'running',
      rootState: 'kept',
      startedAt: Date.now() - 120_000,
      finishedAt: null,
      result: null,
      estimate: {
        writes: 400,
        reads: 100,
        wallClockMs: 600_000,
        pacing: { msPerWrite: 1000, msPerRead: 1000 },
      },
      progress: { stage: 'content', writes: 200, reads: 0, uploads: 3 },
    };
    installApi(routes({ 'GET /snapshots': response({ rehearsals: [running] }) }));
    renderApp('/ui/snapshots');
    const p = await screen.findByLabelText('Rehearsal progress');
    expect(p).toHaveTextContent('Stage: content');
    expect(p).toHaveTextContent('writes 200 of 400');
    expect(p).toHaveTextContent('reads 0 of 100');
    // (Real time runs on between building the row and rendering it: to the second.)
    expect(p).toHaveTextContent(/2 min 0\d s elapsed \(estimate 10 min 00 s\)/);
    // 200 of 500 units in 2 minutes: 5 minutes in all, so 3 more.
    expect(p).toHaveTextContent(/projected finish .* \(in 3 min 0\d s\)/);
  });

  it('E5.5: the restore plan says how long it should take once approved, and with which figures', async () => {
    const api = installApi(
      routes({
        'POST /snapshots/restore': {
          status: 'dry_run',
          plan: {
            ...plan,
            estimate: {
              reads: 2,
              writes: 1,
              wallClockMs: 2000,
              fitsToday: true,
              pacing: { msPerWrite: 1500, msPerRead: 0 },
              figures: {
                perWrite: { ms: 500, from: 'spacing', measuredMs: 320, samples: 12, spacingMs: 500 },
                limits: [{ tier: 'write-min', limit: 120, windowMs: 60_000, share: 108 }],
                groups: [],
              },
            },
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/snapshots');
    await user.click(await screen.findByRole('button', { name: 'Atlas' }));
    const history = await screen.findByRole('table', { name: 'Page history' });
    await user.click(within(history).getByRole('button', { name: 'Propose a restore' }));
    const form = await screen.findByRole('form', { name: `Propose a restore to ${SNAP}` });
    await user.click(within(form).getByRole('button', { name: 'Preview' }));
    const line = await within(form).findByLabelText('Restore estimate');
    expect(line).toHaveTextContent('Once approved: 1 write and 2 reads, about 2 s.');
    expect(line).toHaveTextContent('Figures used: a write takes at least the 500 ms spacing');
    expect(api.find('POST', '/snapshots/restore')).toHaveLength(1);
    const view = figuresText({
      perWrite: { ms: 500, from: 'spacing', measuredMs: 320, samples: 12, spacingMs: 500 },
      limits: [{ tier: 'write-min', limit: 120, windowMs: 60_000, share: 108 }],
      groups: [],
    });
    expect(view).toBe(
      'Figures used: a write takes at least the 500 ms spacing (the last 12 write steps took a median 0.3 s); writes at 120 a minute (this run’s share 108).',
    );
    expect(figuresText(null)).toBeNull();
  });

  it('E5.5: the projected finish falls back to the estimate before 2% of the work is done', () => {
    const r = {
      startedAt: NOW - 1000,
      estimate: { writes: 400, reads: 100, wallClockMs: 600_000 },
      progress: { writes: 1, reads: 0 },
    } as unknown as RehearsalView;
    const p = rehearsalProgress(r, NOW);
    expect(p).toMatchObject({
      stage: 'starting',
      writes: 1,
      plannedWrites: 400,
      finishAt: NOW - 1000 + 600_000,
    });
    expect(rehearsalProgress({ ...r, estimate: null }, NOW).finishAt).toBeNull();
  });

  it('has no daily changed-pages switch (LegendKeeper’s updatedAt does not track content)', async () => {
    installApi(routes({}));
    renderApp('/ui/snapshots');
    await screen.findByRole('table', { name: 'Runs' });
    expect(screen.queryByRole('checkbox', { name: /changed-pages/i })).toBeNull();
    expect(screen.queryByText(/updatedAt/)).toBeNull();
    expect(screen.queryByText(/daily \(app edits\)/)).toBeNull();
  });
});

describe('the weekly schedule (Maintenance Jobs)', () => {
  it('edits a weekly day and time', async () => {
    const job = {
      id: 'snapshot-full',
      name: 'Full snapshot',
      description: 'Takes a full snapshot.',
      implemented: true,
      writes: false,
      enabled: true,
      schedule: { kind: 'weekly', day: 'sun', time: '00:30' },
      scheduleText: 'Weekly on Sunday at 00:30 (London time)',
      defaultSchedule: { kind: 'weekly', day: 'sun', time: '00:30' },
      scheduleOverridden: false,
      priority: 'P3',
      running: false,
      lastRun: null,
      nextRunAt: NOW + 86_400_000,
      note: null,
    };
    const api = installApi({
      ...baseRoutes(),
      'GET /maintenance': { jobs: [job], schedulerEnabled: true, now: NOW },
      'PUT /maintenance/snapshot-full/schedule': { job },
    });
    const user = userEvent.setup();
    renderApp('/ui/maintenance');
    await user.click(await screen.findByRole('button', { name: 'Edit the schedule of Full snapshot' }));
    const form = await screen.findByRole('form', { name: 'Schedule of Full snapshot' });
    expect(within(form).getByLabelText('Runs')).toHaveValue('weekly');
    expect(within(form).getByLabelText('Day')).toHaveValue('sun');
    await user.selectOptions(within(form).getByLabelText('Day'), 'sat');
    const time = within(form).getByLabelText('Time (London, 24-hour)');
    await user.clear(time);
    await user.type(time, '23:45');
    await user.click(within(form).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', '/maintenance/snapshot-full/schedule')).toHaveLength(1));
    expect(api.find('PUT', '/maintenance/snapshot-full/schedule')[0]!.body).toEqual({
      schedule: { kind: 'weekly', day: 'sat', time: '23:45' },
    });
  });
});

describe('a restore proposal', () => {
  it('shows what comes back, its diff and what cannot be restored', async () => {
    const p = {
      id: 'prop_rst1',
      principalId: 'system',
      principalLabel: null,
      profile: 'Owner',
      title: 'restore',
      summary: 'restore_snapshot: Atlas, document Main',
      state: 'pending',
      createdAt: NOW - 60_000,
      updatedAt: NOW - 60_000,
      expiresAt: NOW + 86_400_000,
      decidedAt: null,
      rejectReason: null,
      jobId: null,
      conflict: null,
      error: null,
      opCount: 1,
      requiresCanonicalApproval: false,
      canonicalApprovedBy: null,
      canonicalApprovedAt: null,
      pages: [],
    };
    const operation = {
      tool: 'restore_snapshot',
      page: { id: 'atlas5np', name: 'Atlas' },
      scope: 'document',
      snapshot: { id: SNAP, takenAt: new Date(NOW - 4 * 86_400_000).toISOString(), kind: 'full' },
      pieces: plan.pieces,
      lost: plan.lost,
      kept: [],
      notRestored: [{ what: 'document Plot', why: 'added since the snapshot' }],
      warnings: [],
    };
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [p] },
      'GET /proposals/prop_rst1': {
        proposal: {
          ...p,
          ops: [],
          operationDetail: operation,
          operations: [operation],
          pageSummary: [],
          markdownDiff: {
            added: 1,
            removed: 1,
            hunks: [
              {
                beforeStart: 1,
                beforeLines: 1,
                afterStart: 1,
                afterLines: 1,
                lines: [
                  { kind: 'del', text: 'Notes rewritten.' },
                  { kind: 'add', text: 'First notes.' },
                ],
              },
            ],
          },
        },
      },
    });
    renderApp('/ui/proposals?id=prop_rst1');
    const card = await screen.findByRole('region', { name: 'Restore from a snapshot' });
    expect(card).toHaveTextContent('Restore the document of Atlas');
    expect(card).toHaveTextContent('to the full snapshot of');
    expect(within(card).getByText('First notes.')).toBeInTheDocument();
    expect(card).toHaveTextContent('Cannot be restored exactly');
    expect(card).toHaveTextContent('document Plot: added since the snapshot');
  });
});

// ------------------------------------------------------------------------- the 25 November 2026 freeze

/**
 * Holds every GET of `path` (after the first `pass` ones) until the test releases it; a held request whose signal is
 * aborted rejects as `fetch` does. Each held request is recorded (`aborted` once its signal fired).
 */
function holdGets(path: string, pass = 0) {
  const inner = globalThis.fetch;
  const held: { release: () => void; aborted: boolean }[] = [];
  let seen = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'https://lk.example.test',
      );
      if (url.pathname !== `/api/admin${path}` || (init?.method ?? 'GET') !== 'GET' || seen++ < pass)
        return inner(input, init);
      return new Promise<Response>((resolve, reject) => {
        const h = { aborted: false, release: () => resolve(inner(input, init)) };
        init?.signal?.addEventListener('abort', () => {
          h.aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        held.push(h);
      });
    }),
  );
  return held;
}

describe('the 25 November 2026 freeze (ADR 0042 amendment 2, ADR 0061 amendment 2)', () => {
  afterEach(() => vi.useRealTimers());

  it('polls with at most one GET /snapshots in flight: a poll while one is pending is skipped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    installApi(routes()); // a full snapshot is running: the page polls every 3 seconds
    const held = holdGets('/snapshots', 1);
    renderApp('/ui/snapshots');
    expect(await screen.findByTestId('store-size')).toBeInTheDocument();
    // The first poll is sent and does not answer (the bridge is busy): five more polls are skipped, not piled up.
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    await waitFor(() => expect(held).toHaveLength(1));
    for (let i = 0; i < 5; i++)
      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
      });
    expect(held).toHaveLength(1);
    expect(inflightPaths().filter((p) => p.startsWith('/snapshots?'))).toHaveLength(1);
    // Once it answers, the next poll is sent.
    await act(async () => {
      held[0]!.release();
      await Promise.resolve();
    });
    await waitFor(() => expect(inflightPaths().filter((p) => p.startsWith('/snapshots?'))).toHaveLength(0));
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    await waitFor(() => expect(held).toHaveLength(2));
    expect(held.filter((h) => h.aborted)).toHaveLength(0);
  });

  it('aborts its requests when the owner navigates away', async () => {
    const user = userEvent.setup();
    installApi({ ...routes(), 'GET /maintenance': { jobs: [], schedulerEnabled: true, now: NOW } });
    const held = holdGets('/snapshots/pages');
    renderApp('/ui/snapshots');
    expect(await screen.findByTestId('store-size')).toBeInTheDocument();
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]!.aborted).toBe(false);
    await user.click(await navLink(user, 'Maintenance Jobs'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Maintenance Jobs' })).toBeInTheDocument();
    await waitFor(() => expect(held[0]!.aborted).toBe(true));
    expect(inflightPaths().filter((p) => p.startsWith('/snapshots'))).toEqual([]);
  });

  it('api.get shares one request per path; it is aborted only once every caller has let go', async () => {
    installApi(routes());
    const held = holdGets('/snapshots/pages');
    const a = new AbortController();
    const b = new AbortController();
    const first = api.get('/snapshots/pages', { signal: a.signal });
    const second = api.get('/snapshots/pages', { signal: b.signal });
    await waitFor(() => expect(held).toHaveLength(1));
    a.abort();
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' });
    expect(held[0]!.aborted).toBe(false);
    held[0]!.release();
    await expect(second).resolves.toMatchObject({ project: 'baisheng' });
    // A caller alone, then gone: the request is aborted.
    const third = api.get('/snapshots/pages', {
      signal: b.signal.aborted ? new AbortController().signal : b.signal,
    });
    await waitFor(() => expect(held).toHaveLength(2));
    const c = new AbortController();
    const fourth = api.get('/snapshots/pages?x=1', { signal: c.signal });
    c.abort();
    await expect(fourth).rejects.toMatchObject({ code: 'ABORTED' });
    held[1]!.release();
    await expect(third).resolves.toMatchObject({ project: 'baisheng' });
  });

  it('the page finder asks for one page of results at a time, filtered by name and branch on the server', async () => {
    const user = userEvent.setup();
    const page = (n: number) => ({
      pageId: `pg${String(n).padStart(6, '0')}`,
      name: `Page ${n}`,
      lastAt: NOW - n * 1000,
      deleted: false,
    });
    const a = installApi(
      routes({
        'GET /snapshots/pages': (c: Call) => {
          const q = new URLSearchParams(c.query);
          const at = q.get('cursor') === 'c2' ? 50 : 0;
          return {
            project: 'baisheng',
            pages: Array.from({ length: q.get('cursor') === 'c2' ? 3 : 50 }, (_, i) => page(at + i)),
            next: q.get('cursor') === 'c2' ? null : 'c2',
            branches: [
              { id: 'brlocs01', name: '[INDEX] Locations', pages: 40 },
              { id: 'brpeop01', name: '[INDEX] People', pages: 13 },
            ],
            index: { indexed: 300, pending: 12, missingPending: 0 },
          };
        },
      }),
    );
    renderApp('/ui/snapshots');
    const list = await screen.findByRole('list', { name: 'Pages in the snapshots' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText(/Indexing older snapshots: 12 still to index/)).toHaveAttribute('role', 'status');
    const query = () => new URLSearchParams(a.find('GET', '/snapshots/pages').at(-1)!.query);
    expect(query().get('limit')).toBe('50');
    expect(query().get('cursor')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(query().get('cursor')).toBe('c2'));
    expect(await screen.findByText('Page 52')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Newer' }));
    await waitFor(() => expect(query().get('cursor')).toBeNull());
    await user.selectOptions(screen.getByLabelText('Branch'), 'brpeop01');
    await waitFor(() => expect(query().get('branch')).toBe('brpeop01'));
    await user.type(screen.getByLabelText('Page name'), 'harbour');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(query().get('q')).toBe('harbour'));
    expect(query().get('branch')).toBe('brpeop01');
    expect(query().get('cursor')).toBeNull();
  });

  it('a page’s history pages back through older snapshots', async () => {
    const user = userEvent.setup();
    const a = installApi(
      routes({
        'GET /snapshots/pages/atlas5np': (c: Call) =>
          new URLSearchParams(c.query).get('cursor') === 'older1'
            ? { ...pageResponse, history: { ...pageResponse.history, count: 51 } }
            : { ...pageResponse, history: { ...pageResponse.history, count: 51, more: 50, next: 'older1' } },
      }),
    );
    renderApp('/ui/snapshots?page=atlas5np');
    expect(await screen.findByRole('table', { name: 'Page history' })).toBeInTheDocument();
    expect(screen.getByText('50 older snapshots not shown.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Older snapshots' }));
    await waitFor(() =>
      expect(
        new URLSearchParams(a.find('GET', '/snapshots/pages/atlas5np').at(-1)!.query).get('cursor'),
      ).toBe('older1'),
    );
    expect(await screen.findByRole('button', { name: 'Newer snapshots' })).toBeInTheDocument();
  });
});
