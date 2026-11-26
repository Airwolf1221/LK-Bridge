// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * OPS2 on the dashboard: the re-authentication dialog (asked for when the bridge says REAUTH_REQUIRED, then the action
 * runs again), the Account page (the password, the authenticator with a locally drawn QR code, recovery codes shown
 * once), the Projects page's key flows (a write-only key field, a check shown before anything is stored, the reminder to
 * revoke a replaced key, pause and drain before removal), and the Overview's recommendation of the authenticator.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_ID,
  SESSION,
  baseRoutes,
  controls,
  installApi,
  project,
  projectsJson,
  renderApp,
  snapshot,
  useDom,
  type Call,
} from './helpers';

useDom();

const KEY = 'TESTKEY-new-project-0123456789abcdef';
const PASSWORD = 'the owner password for the dialog';

function security(over: Record<string, unknown> = {}) {
  return {
    username: 'owner',
    password: { source: 'store', problem: null },
    totp: { enabled: false, source: null, problem: null, recoveryCodesLeft: 0, enrolmentPending: false },
    reauth: { until: null, windowSeconds: 43_200 },
    store: {
      available: true,
      problem: null,
      keyId: '0123456789abcdef',
      stored: 2,
      unreadable: 0,
      underPrevious: 0,
    },
    canManageKeys: true,
    warnings: [],
    keyConflicts: [],
    ...over,
  };
}

/** A route that first answers REAUTH_REQUIRED, then (after a re-authentication) `then`. */
function needsReauth(then: (c: Call) => unknown) {
  let confirmed = false;
  return {
    route: (c: Call) =>
      confirmed
        ? then(c)
        : {
            status: 403,
            body: { error: { code: 'REAUTH_REQUIRED', message: 'Confirm your password first.' } },
          },
    reauth: () => {
      confirmed = true;
      return { until: Date.now() + 300_000 };
    },
  };
}

describe('ADR 0081: the step-up’s window, as the bridge reports it', () => {
  it('the Account page names the credential changes that ask, and the window in words (12 hours, or as set)', async () => {
    installApi({ ...baseRoutes(), 'GET /security': security() });
    const first = renderApp('/ui/account');
    expect(
      await screen.findByText(
        /Changes to your password, authenticator, keys, tokens and connections ask for your password again, which then lasts 12 hours\. Nothing else does\./,
      ),
    ).toBeInTheDocument();
    first.unmount();
    installApi({
      ...baseRoutes(),
      'GET /security': security({ reauth: { until: null, windowSeconds: 3600 } }),
    });
    renderApp('/ui/account');
    expect(await screen.findByText(/which then lasts 1 hour\./)).toBeInTheDocument();
    expect(screen.queryByText(/10 minutes|ten minutes/)).toBeNull();
  });
});

describe('the re-authentication dialog', () => {
  it('appears when the bridge asks, sends the password once, then runs the action again', async () => {
    const user = userEvent.setup();
    const gate = needsReauth(() => ({ otherSessionsSignedOut: 2 }));
    const api = installApi({
      ...baseRoutes(),
      'GET /security': security(),
      'POST /security/password': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/account');
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), 'old password long');
    await user.type(screen.getByLabelText('New password (at least 12 characters)'), 'a brand new password');
    await user.type(screen.getByLabelText('New password again'), 'a brand new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await user.type(within(dialog).getByLabelText('Password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/Password changed\. 2 other sessions were signed out\./);
    expect(api.find('POST', '/security/password')).toHaveLength(2);
    expect(api.find('POST', '/security/reauth')[0]!.body).toEqual({ password: PASSWORD });
    // The password went only to the re-authentication.
    for (const c of api.calls.filter((x) => x.path !== '/security/reauth'))
      expect(JSON.stringify(c.body ?? {})).not.toContain(PASSWORD);
  });

  it('asks for a code too when the authenticator is on; cancelling runs nothing and shows no error', async () => {
    const user = userEvent.setup();
    const gate = needsReauth(() => ({ ok: true }));
    const api = installApi({
      ...baseRoutes(),
      'GET /security': security({
        totp: {
          enabled: true,
          source: 'store',
          problem: null,
          recoveryCodesLeft: 9,
          enrolmentPending: false,
        },
      }),
      'POST /security/recovery-codes': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/account', { ...SESSION, totpEnabled: true });
    await user.click(await screen.findByRole('button', { name: 'New recovery codes…' }));
    await user.click(await screen.findByRole('button', { name: 'Make new codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    expect(within(dialog).getByLabelText('Authenticator code (or a recovery code)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm it’s you' })).toBeNull());
    expect(api.find('POST', '/security/reauth')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Cancelled\./);
  });
});

describe('the authenticator app', () => {
  it('draws the QR code locally, shows the secret, confirms with a code and shows the recovery codes once', async () => {
    const user = userEvent.setup();
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBBB-CCCCC-DDDDD`);
    let enabled = false;
    const api = installApi({
      ...baseRoutes(),
      'GET /security': () =>
        security({
          totp: {
            enabled,
            source: enabled ? 'store' : null,
            problem: null,
            recoveryCodesLeft: enabled ? 10 : 0,
            enrolmentPending: false,
          },
        }),
      'POST /security/totp/enrol': {
        secret,
        otpauthUri: `otpauth://totp/LK-Bridge%3Aowner?secret=${secret}&issuer=LK-Bridge&algorithm=SHA1&digits=6&period=30`,
        shownOnce: true,
      },
      'POST /security/totp/confirm': () => {
        enabled = true;
        return { recoveryCodes: codes, shownOnce: true };
      },
    });
    renderApp('/ui/account');
    expect(await screen.findByRole('heading', { name: 'Turn on the authenticator app' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up the authenticator…' }));
    const qr = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(Number(qr.getAttribute('data-modules'))).toBeGreaterThanOrEqual(33); // version 4 or more for this URI
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    // Drawn here: no image, no request anywhere for it.
    expect(document.querySelector('img')).toBeNull();
    expect(api.calls.every((c) => !/qr|chart/i.test(c.path))).toBe(true);
    expect(screen.getByText(secret)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Switch it on' }));
    const shown = await screen.findByTestId('recovery-codes');
    for (const c of codes) expect(shown).toHaveTextContent(c);
    expect(api.find('POST', '/security/totp/confirm')[0]!.body).toEqual({ code: '123456' });
    // The secret is gone from the page once the enrolment is done; the codes go when the owner says so.
    expect(document.body.textContent).not.toContain(secret);
    await user.click(screen.getByRole('button', { name: 'I have saved them' }));
    await waitFor(() => expect(screen.queryByTestId('recovery-codes')).toBeNull());
    expect(document.body.textContent).not.toContain(codes[0]);
    expect(await screen.findByText('on')).toBeInTheDocument();
  });

  it('the Overview recommends it strongly while it is off', async () => {
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
          {
            name: 'old',
            id: 'lkp_old',
            status: 'archived',
            reason: 'Removed',
            isDefault: false,
            readOnly: true,
          },
        ],
        health: {
          checkedAt: Date.now(),
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
        budget: { queues: snap.queues, gauges: [snap.tiers['write-min']] },
        security: {
          totpEnabled: false,
          canManageKeys: true,
          storeProblem: null,
          warnings: ['alpha: LK_PROJECT_ALPHA_API_KEY in the env file is not the key in use'],
        },
      },
    });
    renderApp('/ui');
    const advice = await screen.findByTestId('totp-advice');
    expect(advice).toHaveTextContent('Turn on the authenticator app');
    expect(within(advice).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/ui/account');
    expect(
      screen.getByText(/LK_PROJECT_ALPHA_API_KEY in the env file is not the key in use/),
    ).toBeInTheDocument();
    // A removed project is not something that "needs attention".
    expect(screen.queryByRole('heading', { name: /needs? attention/ })).toBeNull();
  });
});

describe('managing keys on the Projects page', () => {
  it('adds a project: the key goes once into a write-only field, the check is shown, the confirmation carries no key', async () => {
    const user = userEvent.setup();
    const gate = needsReauth(() => ({
      checkId: 'chk_1',
      kind: 'add',
      name: 'gamma',
      lkProjectId: 'lkp_gamma',
      lkProjectName: 'Project gamma',
      role: 'ADMIN',
      keyHint: KEY.slice(-4),
      expiresAt: Date.now() + 300_000,
    }));
    const api = installApi({
      ...baseRoutes(),
      'GET /projects': { ...projectsJson(), canManageKeys: true },
      'GET /security': security(),
      'POST /security/reauth': gate.reauth,
      'POST /projects/check': gate.route,
      'POST /projects/confirm': {
        project: project({ name: 'gamma', id: 'lkp_gamma', keySource: 'store', keyHint: KEY.slice(-4) }),
        reminder: null,
      },
    });
    renderApp('/ui/projects');
    await user.click(await screen.findByRole('button', { name: 'Add a project…' }));
    await user.type(screen.getByLabelText('Name on this bridge'), 'gamma');
    const keyField = screen.getByLabelText('API key');
    expect(keyField).toHaveAttribute('type', 'password');
    expect(keyField).toHaveAttribute('autocomplete', 'off');
    await user.type(keyField, KEY);
    await user.click(screen.getByRole('button', { name: 'Check the key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await user.type(within(dialog).getByLabelText('Password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const check = await screen.findByTestId('key-check');
    expect(check).toHaveTextContent('Project gamma');
    expect(check).toHaveTextContent('lkp_gamma');
    expect(check).toHaveTextContent('ADMIN');
    expect(check).toHaveTextContent(`ends ${KEY.slice(-4)}`);
    expect(document.body.innerHTML).not.toContain(KEY);
    await user.click(within(check).getByRole('button', { name: 'Add the project' }));
    await screen.findByText('gamma was added and is served now.');
    expect(api.find('POST', '/projects/check')[1]!.body).toEqual({ name: 'gamma', apiKey: KEY });
    expect(api.find('POST', '/projects/confirm')[0]!.body).toEqual({ checkId: 'chk_1', confirm: true });
    for (const c of api.calls.filter((x) => x.path !== '/projects/check'))
      expect(JSON.stringify(c.body ?? {})).not.toContain(KEY);
  });

  it('a replaced key ends with the reminder to revoke the old one; a refused key says why', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    installApi({
      ...baseRoutes(),
      'GET /projects': { ...projectsJson(), canManageKeys: true },
      'GET /security': security(),
      'POST /projects/baisheng/key/check': () =>
        ++attempt === 1
          ? {
              status: 409,
              body: {
                error: {
                  code: 'KEY_WRONG_PROJECT',
                  message: 'This key belongs to LegendKeeper project lkp_other, not to "baisheng".',
                },
              },
            }
          : {
              checkId: 'chk_2',
              kind: 'replace',
              name: 'baisheng',
              lkProjectId: 'lkp_baisheng',
              lkProjectName: 'Baisheng',
              role: 'ADMIN',
              keyHint: 'cdef',
              expiresAt: Date.now() + 300_000,
            },
      'POST /projects/confirm': {
        project: project({ keySource: 'store', keyHint: 'cdef' }),
        reminder: 'Now revoke the old key (ending wxyz) in LegendKeeper.',
      },
    });
    renderApp('/ui/projects');
    await user.click(await screen.findByRole('button', { name: 'Replace the key of baisheng' }));
    const field = screen.getByLabelText('New API key for baisheng');
    await user.type(field, KEY);
    await user.click(screen.getByRole('button', { name: 'Check the key' }));
    expect(await screen.findByText(/This key belongs to LegendKeeper project lkp_other/)).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('New API key for baisheng').value).toBe('');
    await user.type(screen.getByLabelText('New API key for baisheng'), KEY);
    await user.click(screen.getByRole('button', { name: 'Check the key' }));
    await user.click(await screen.findByRole('button', { name: 'Use this key' }));
    expect(
      await screen.findByText(/Now revoke the old key \(ending wxyz\) in LegendKeeper/),
    ).toBeInTheDocument();
  });

  it('removal with work pending offers “pause and drain” instead', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...baseRoutes(),
      'GET /projects': {
        ...projectsJson([
          project({ pending: { jobs: 2, proposals: 1 }, keySource: 'store', keyHint: 'abcd' }),
        ]),
        canManageKeys: true,
      },
      'PUT /projects/baisheng/draining': {
        project: project({ draining: true }),
        pending: { jobs: 2, proposals: 1 },
      },
    });
    renderApp('/ui/projects');
    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    const tr = await waitFor(() => document.querySelector<HTMLElement>('tr[data-project="baisheng"]')!);
    expect(tr).toHaveTextContent('Encrypted store · ends abcd');
    await user.click(within(tr).getByRole('button', { name: 'Remove baisheng' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Pause and drain baisheng first?' });
    expect(dialog).toHaveTextContent('2 unfinished job(s) and 1 open proposal(s)');
    await user.click(within(dialog).getByRole('button', { name: 'Pause and drain' }));
    await waitFor(() => expect(api.find('PUT', '/projects/baisheng/draining')).toHaveLength(1));
    expect(api.find('PUT', '/projects/baisheng/draining')[0]!.body).toEqual({ value: true });
    expect(api.find('POST', '/projects/baisheng/remove')).toHaveLength(0);
  });
});
