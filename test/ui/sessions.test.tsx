// @vitest-environment jsdom
/**
 * ADR 0062 on the dashboard: the live stream, refused (its session ended), sends the page to sign-in once instead of
 * reconnecting every three seconds; the step-up dialog asks for the authenticator code only (or the password without
 * one), for any change the bridge answers `REAUTH_REQUIRED`, once for changes refused together, and a wrong code keeps
 * the owner where they are; and the Account page's "Sign out everywhere".
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiConfig } from '../../ui/src/api';
import { ReauthProvider } from '../../ui/src/reauth';
import { StreamProvider, defaultCheckSession, useStream } from '../../ui/src/stream';
import { FakeSource, baseRoutes, factory, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

function Status() {
  return <p>stream: {useStream().status}</p>;
}

describe('the live stream, refused (ADR 0062 decision 6)', () => {
  const mount = (check: () => Promise<boolean>, onUnauth: () => void) => {
    FakeSource.all = [];
    render(
      <StreamProvider createSource={factory} checkSession={check} onUnauthenticated={onUnauth}>
        <Status />
      </StreamProvider>,
    );
    expect(FakeSource.all).toHaveLength(1);
    return FakeSource.all[0]!;
  };

  it('signed out: the sign-in page, once, and no reconnecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const onUnauth = vi.fn();
      const check = vi.fn(() => Promise.resolve(false));
      const source = mount(check, onUnauth);
      await act(async () => {
        source.close(); // the browser gives up on a 401
        source.fail();
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(onUnauth).toHaveBeenCalledTimes(1);
      expect(FakeSource.all).toHaveLength(1);
      expect(screen.getByText('stream: ended')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still signed in (a proxy error, a restart): opened again three seconds later, as before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const onUnauth = vi.fn();
      const check = vi.fn(() => Promise.resolve(true));
      const source = mount(check, onUnauth);
      await act(async () => {
        source.close();
        source.fail();
        await vi.advanceTimersByTimeAsync(2_900);
      });
      expect(FakeSource.all).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(FakeSource.all).toHaveLength(2);
      expect(onUnauth).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the check: signed out only on a 401 of the session route; the bridge unreachable counts as signed in', async () => {
    apiConfig.base = '';
    installApi({
      'GET /session': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } },
    });
    expect(await defaultCheckSession()).toBe(false);
    installApi({ 'GET /session': { authenticated: true } });
    expect(await defaultCheckSession()).toBe(true);
    installApi({ 'GET /session': { status: 502, body: {} } });
    expect(await defaultCheckSession()).toBe(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await defaultCheckSession()).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------- the step-up

const REFUSED = {
  status: 403,
  body: { error: { code: 'REAUTH_REQUIRED', message: 'Confirm it is you first.' } },
};

/** Two settings that need the step-up, and the step-up itself (good for `goodCode` or `goodPassword`). */
function stepUpRoutes(o: { totp: boolean; goodCode?: string; goodPassword?: string }) {
  let stepped = false;
  const setting = () => (stepped ? { settings: {} } : REFUSED);
  return {
    'GET /security': { totp: { enabled: o.totp } },
    'PUT /settings/read-only': setting,
    'PUT /settings/member-admin': setting,
    'POST /security/reauth': (c: Call) => {
      const b = c.body as { totp?: string; password?: string };
      const ok = o.totp ? b.totp === o.goodCode : b.password === o.goodPassword;
      if (!ok)
        return {
          status: 401,
          body: { error: { code: 'REAUTH_FAILED', message: 'Those details were not recognised.' } },
        };
      stepped = true;
      return { until: Date.now() + 600_000 };
    },
  };
}

function TwoChanges({ done }: { done: (r: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        api.put('/settings/read-only', { value: true }).then(
          () => done('read-only saved'),
          (e: unknown) => done(`read-only: ${e instanceof ApiError ? e.code : String(e)}`),
        );
        api.put('/settings/member-admin', { value: false }).then(
          () => done('member-admin saved'),
          (e: unknown) => done(`member-admin: ${e instanceof ApiError ? e.code : String(e)}`),
        );
      }}
    >
      Save both
    </button>
  );
}

describe('the step-up dialog (ADR 0062 decision 5)', () => {
  it('any change refused asks once for the authenticator code only; a wrong code keeps the owner here; both are sent again', async () => {
    const user = userEvent.setup();
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    apiConfig.onUnauthenticated = onUnauth;
    apiConfig.base = '';
    try {
      const calls = installApi(stepUpRoutes({ totp: true, goodCode: '123456' }));
      const results: string[] = [];
      render(
        <ReauthProvider totp={true}>
          <TwoChanges done={(r) => results.push(r)} />
        </ReauthProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Save both' }));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
      expect(screen.getAllByRole('dialog')).toHaveLength(1); // two refusals, one dialog
      expect(within(dialog).queryByLabelText('Password')).toBeNull();
      expect(dialog).toHaveTextContent(/an authenticator code again\. It lasts ten minutes\./);
      const code = within(dialog).getByLabelText('Authenticator code (or a recovery code)');

      await user.type(code, '000000');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Those details were not recognised.',
      );
      expect(onUnauth).not.toHaveBeenCalled(); // a wrong code is no sign-out
      expect(results).toEqual([]);

      await user.clear(code);
      await user.type(code, '123456');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect([...results].sort()).toEqual(['member-admin saved', 'read-only saved']));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(calls.find('PUT', '/settings/read-only')).toHaveLength(2);
      expect(calls.find('PUT', '/settings/member-admin')).toHaveLength(2);
      expect(calls.find('POST', '/security/reauth').map((c) => c.body)).toEqual([
        { totp: '000000' },
        { totp: '123456' },
      ]);
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  it('without an authenticator it asks for the password; cancelling sends nothing again', async () => {
    const user = userEvent.setup();
    apiConfig.base = '';
    const calls = installApi(stepUpRoutes({ totp: false, goodPassword: 'the owner password' }));
    const results: string[] = [];
    render(
      <ReauthProvider totp={false}>
        <TwoChanges done={(r) => results.push(r)} />
      </ReauthProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Save both' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Authenticator code (or a recovery code)')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect([...results].sort()).toEqual(['member-admin: REAUTH_CANCELLED', 'read-only: REAUTH_CANCELLED']),
    );
    expect(calls.find('PUT', '/settings/read-only')).toHaveLength(1);
    expect(calls.find('POST', '/security/reauth')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------- Sign out everywhere

describe('Sign out everywhere (ADR 0062 decision 4)', () => {
  it('the Account page says how many sessions there are; after a confirm, every one ends and the page goes to sign-in', async () => {
    const user = userEvent.setup();
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    try {
      const calls = installApi({
        ...baseRoutes(),
        'GET /security': {
          username: 'owner',
          password: { source: 'store', problem: null },
          totp: {
            enabled: true,
            source: 'store',
            problem: null,
            recoveryCodesLeft: 9,
            enrolmentPending: false,
          },
          reauth: { until: null, windowSeconds: 600 },
          sessions: { active: 3, thisEndsAt: Date.now() + 30 * 86_400_000 },
          store: { available: true, problem: null, keyId: 'k', stored: 1, unreadable: 0, underPrevious: 0 },
          canManageKeys: true,
          warnings: [],
          keyConflicts: [],
        },
        'POST /security/sessions/revoke-all': { revoked: 3 },
      });
      renderApp('/ui/account');
      apiConfig.onUnauthenticated = onUnauth;
      const card = (await screen.findByRole('heading', { level: 2, name: 'Sessions' })).closest('section')!;
      expect(card).toHaveTextContent('A session lasts 30 days from its last use. 3 are signed in now.');
      expect(card).toHaveTextContent(/This one ends .* unless you use it before then\./);
      await user.click(within(card).getByRole('button', { name: 'Sign out everywhere' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Sign out everywhere?' });
      expect(confirm).toHaveTextContent('Every signed-in dashboard ends, this one included.');
      await user.click(within(confirm).getByRole('button', { name: 'Sign out everywhere' }));
      await waitFor(() => expect(onUnauth).toHaveBeenCalledTimes(1));
      expect(calls.find('POST', '/security/sessions/revoke-all').map((c) => c.body)).toEqual([
        { confirm: true },
      ]);
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });
});
