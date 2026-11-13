// @vitest-environment jsdom
/**
 * v2 E1b (ADR 0043) on the dashboard: the Off-site copy page (the Google Drive card, the keys shown once and confirmed by
 * their last characters, "Copy now", the verify findings, the folder) and the Overview's warning when the backup is
 * broken.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_ID,
  baseRoutes,
  controls,
  installApi,
  renderApp,
  snapshot,
  useDom,
  type Call,
} from './helpers';

useDom();

const NOW = Date.now();
const PASSWORD = 'GENERATEDpasswordAAAAAAAAAAAAAAAAAAAAA-xyz123';
const SALT = 'GENERATEDsaltBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-abc789';

const status = (over: Record<string, unknown> = {}) => ({
  redirectUri: 'https://lk.example.test/admin/drive/callback',
  client: {
    saved: true,
    clientId: 'abc.apps.googleusercontent.com',
    secretHint: 'WXYZ',
    savedAt: NOW - 86_400_000,
  },
  connection: {
    state: 'connected',
    account: { email: 'owner@example.test', name: 'Test Owner' },
    connectedAt: NOW - 86_400_000,
    brokenAt: null,
    brokenReason: null,
    tokenCheckedAt: NOW,
  },
  keys: { set: false, setAt: null, source: null, newFolderOnChange: false },
  settings: {
    folder: 'LK-Bridge backups/lk.example.test',
    copyTime: '04:45',
    deletedRetentionDays: 30,
    bandwidthLimit: '',
    transfers: 4,
    verifyEnabled: true,
    verifyDay: 1,
    verifyTime: '05:30',
    verifySamplePercent: 1,
    verifySampleMin: 50,
    staleAfterDays: 2,
  },
  settingsProblems: [],
  folder: {
    generation: 1,
    path: 'LK-Bridge backups/lk.example.test/copy-1',
    createdAt: NOW,
    firstCopyAt: null,
    lastGoodCopyAt: null,
    adoptedAt: null,
    retiredAt: null,
    retiredReason: null,
    deleteRequestedAt: null,
    deletedAt: null,
  },
  folders: [],
  configured: { ready: false, missing: ['the encryption keys'] },
  health: { state: 'warning', messages: ['Off-site copy: not complete; set up the encryption keys.'] },
  running: null,
  lastCopy: null,
  lastGoodCopy: null,
  nextCopyAt: NOW + 3_600_000,
  nextCopyWithinMs: 900_000,
  verify: { last: null, lastFindings: [], history: [], nextAt: NOW + 10 * 86_400_000 },
  runs: [],
  pending: [],
  now: NOW,
  ...over,
});

describe('the Off-site copy page', () => {
  it('shows the account and the redirect URI, and generated keys once, saved only after their last characters are typed', async () => {
    const user = userEvent.setup();
    let saved = false;
    const api = installApi({
      ...baseRoutes(),
      'GET /offsite': () =>
        saved
          ? status({ keys: { set: true, setAt: NOW, source: 'generated', newFolderOnChange: false } })
          : status(),
      'POST /offsite/keys/generate': {
        confirmId: 'c'.repeat(32),
        password: PASSWORD,
        salt: SALT,
        confirmChars: 6,
        newFolder: false,
        shownOnce: true,
      },
      'POST /offsite/keys/confirm': () => {
        saved = true;
        return { ok: true, newFolder: null };
      },
    });
    renderApp('/ui/offsite');
    const drive = await screen.findByTestId('drive-card');
    expect(drive).toHaveTextContent('Connected');
    expect(drive).toHaveTextContent('owner@example.test');
    expect(drive).toHaveTextContent('https://lk.example.test/admin/drive/callback');
    expect(drive).toHaveTextContent('WXYZ');
    const keys = screen.getByTestId('keys-card');
    await user.click(within(keys).getByRole('button', { name: 'Generate keys' }));
    const shown = await screen.findByTestId('generated');
    expect(shown).toHaveTextContent(PASSWORD);
    expect(shown).toHaveTextContent(SALT);
    expect(shown).toHaveTextContent(/without these, the Drive copy cannot be restored/i);
    await user.type(within(shown).getByLabelText(/Last 6 characters of the password/), PASSWORD.slice(-6));
    await user.type(within(shown).getByLabelText(/Last 6 characters of the salt/), SALT.slice(-6));
    await user.click(within(shown).getByRole('button', { name: /I have saved them/ }));
    await waitFor(() => expect(api.find('POST', '/offsite/keys/confirm')).toHaveLength(1));
    expect((api.find('POST', '/offsite/keys/confirm')[0] as Call).body).toEqual({
      confirmId: 'c'.repeat(32),
      passwordEnd: PASSWORD.slice(-6),
      saltEnd: SALT.slice(-6),
      acknowledgeNewFolder: false,
    });
    // Gone from the page once saved.
    await waitFor(() => expect(screen.queryByTestId('generated')).toBeNull());
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(await screen.findByText('Set')).toBeInTheDocument();
  });

  it('a broken connection is red with "Reconnect"; the last copy, "Copy now" and the verify findings are shown', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...baseRoutes(),
      'GET /offsite': status({
        connection: {
          state: 'broken',
          account: { email: 'owner@example.test', name: 'Test Owner' },
          connectedAt: NOW - 9 * 86_400_000,
          brokenAt: NOW - 3_600_000,
          brokenReason: 'Google refused the saved sign-in (invalid_grant). Reconnect.',
          tokenCheckedAt: NOW,
        },
        keys: { set: true, setAt: NOW - 9 * 86_400_000, source: 'generated', newFolderOnChange: true },
        configured: { ready: true, missing: [] },
        health: { state: 'bad', messages: ['Off-site copy: Google Drive needs reconnecting.'] },
        lastCopy: {
          id: 4,
          kind: 'copy',
          trigger: 'schedule',
          folder: 'x',
          startedAt: NOW - 3_600_000,
          endedAt: NOW - 3_500_000,
          state: 'refused',
          bytes: null,
          files: null,
          errors: null,
          exitCode: null,
          rcloneVersion: '1.76.0',
          message: 'Google refused the saved sign-in (invalid_grant). Reconnect.',
        },
        verify: {
          last: {
            id: 3,
            kind: 'verify',
            trigger: 'schedule',
            folder: 'x',
            startedAt: NOW - 86_400_000,
            endedAt: NOW - 86_000_000,
            state: 'failed',
            bytes: 100,
            files: 51,
            errors: 1,
            exitCode: 0,
            rcloneVersion: '1.76.0',
            message: '1 problem(s) (1 missing)',
            findings: 1,
          },
          lastFindings: [
            { id: 1, kind: 'missing', path: 'store/objects/ab/abc.gz', detail: 'named by a manifest' },
          ],
          history: [],
          nextAt: null,
        },
        folder: {
          ...status().folder,
          firstCopyAt: NOW - 9 * 86_400_000,
          lastGoodCopyAt: NOW - 3 * 86_400_000,
        },
      }),
      'POST /offsite/copy': { ok: true },
    });
    renderApp('/ui/offsite');
    const drive = await screen.findByTestId('drive-card');
    expect(drive).toHaveTextContent('Needs reconnecting');
    expect(within(drive).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByTestId('verify-card')).toHaveTextContent('store/objects/ab/abc.gz');
    expect(screen.getByTestId('copy-card')).toHaveTextContent('Refused');
    await user.click(within(screen.getByTestId('copy-card')).getByRole('button', { name: 'Copy now' }));
    await waitFor(() => expect(api.find('POST', '/offsite/copy')).toHaveLength(1));
    // Changing keys warns first.
    expect(screen.getByTestId('keys-card')).toHaveTextContent(/fresh full upload into a new Drive folder/);
  });

  it('says so when the off-site service has not taken a request for 10 minutes, and lets the owner ask again', async () => {
    installApi({
      ...baseRoutes(),
      'GET /offsite': status({
        keys: { set: true, setAt: NOW, source: 'generated', newFolderOnChange: false },
        configured: { ready: true, missing: [] },
        pending: [{ kind: 'copy', trigger: 'request', at: NOW - 20 * 60_000 }],
      }),
    });
    renderApp('/ui/offsite');
    expect(await screen.findByTestId('stale-request')).toHaveTextContent(/lk-bridge-offsite\.path/);
    expect(within(screen.getByTestId('copy-card')).getByRole('button', { name: 'Copy now' })).toBeEnabled();
  });

  it('the Overview warns when the off-site backup is broken or stale', async () => {
    const snap = snapshot();
    installApi({
      ...baseRoutes(),
      'GET /overview': {
        project: { id: PROJECT_ID, name: 'baisheng' },
        projects: [
          {
            name: 'baisheng',
            id: PROJECT_ID,
            status: 'active',
            reason: null,
            isDefault: true,
            readOnly: false,
          },
        ],
        health: {
          checkedAt: NOW,
          reachable: true,
          projectName: 'Baisheng',
          keyRole: 'ADMIN',
          plan: 'ok',
          note: null,
        },
        controls: controls(),
        activeJobs: { total: 0, running: 0, queued: 0, waiting: 0, paused: 0, uncertain: 0 },
        errorsLastHour: { count: 0, capped: false },
        pendingProposals: 0,
        writes: { state: 'running', perMinute: 0 },
        budget: { queues: snap.queues, gauges: [(snap.tiers as Record<string, unknown>)['write-min']] },
        offsite: {
          state: 'bad',
          messages: ['Off-site copy: the last good copy is 80 hours old (more than 2 days).'],
        },
        security: { totpEnabled: true, canManageKeys: true, storeProblem: null, warnings: [] },
      },
    });
    renderApp('/ui');
    const advice = await screen.findByTestId('offsite-advice');
    expect(advice).toHaveTextContent('The off-site backup needs attention');
    expect(advice).toHaveTextContent('80 hours old');
    expect(within(advice).getByRole('link', { name: /Off-site copy page/ })).toHaveAttribute(
      'href',
      '/ui/offsite',
    );
  });
});
