// @vitest-environment jsdom
/**
 * CR-2026-11 round 4 (sessions), the dashboard's 401 → sign-in path (ADR 0062 decision 7: "A failed step-up keeps the
 * owner where they are ... a wrong code or password with 401 REAUTH_FAILED (and a wrong current password with 401
 * WRONG_PASSWORD) ... Those two codes now stay in the dialog with their message; any other 401 still means signed
 * out"). The attempts: lose the change, or the owner's knowledge of what happened, by a mistyped current password, a
 * rate-limited step-up, a step-up the bridge refuses again after it succeeded, and a 401 of another kind.
 *
 * The real dashboard (`<App>`, jsdom) with a scripted admin API, as test/ui/sessions.test.tsx does. Written for
 * test/review/r4-sessions and kept in test/ui (CR-2026-11-R4, the lead), where the UI tests' TypeScript project and
 * ESLint's include it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiConfig } from '../../ui/src/api';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers.js';

useDom();

function security(over: Record<string, unknown> = {}) {
  return {
    username: 'owner',
    password: { source: 'store', problem: null },
    totp: { enabled: false, source: null, problem: null, recoveryCodesLeft: 0, enrolmentPending: false },
    reauth: { until: null, windowSeconds: 43_200 },
    sessions: { active: 1, thisEndsAt: Date.now() + 30 * 86_400_000 },
    store: { available: true, problem: null, keyId: 'k', stored: 1, unreadable: 0, underPrevious: 0 },
    canManageKeys: true,
    warnings: [],
    keyConflicts: [],
    ...over,
  };
}

const err = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
});

async function changePassword(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('Current password'), 'not the current one');
  await user.type(screen.getByLabelText('New password (at least 12 characters)'), 'a brand new password');
  await user.type(screen.getByLabelText('New password again'), 'a brand new password');
  await user.click(screen.getByRole('button', { name: 'Change password' }));
}

const shown = async (text: string | RegExp): Promise<boolean> => {
  try {
    await screen.findByText(text, undefined, { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
};

describe('a failed check keeps the owner where they are, and says so', () => {
  it('SE-44: a wrong current password (401 WRONG_PASSWORD) on the Account page: not signed out, and the message shown', async () => {
    const user = userEvent.setup();
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    try {
      installApi({
        ...baseRoutes(),
        'GET /security': security(),
        'POST /security/password': err(401, 'WRONG_PASSWORD', 'The current password is not right.'),
      });
      renderApp('/ui/account');
      apiConfig.onUnauthenticated = onUnauth;
      await changePassword(user);
      const messageShown = await shown('The current password is not right.');
      expect({ signedOut: onUnauth.mock.calls.length > 0, messageShown }).toEqual({
        signedOut: false,
        messageShown: true,
      });
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  it('SE-44b (control): the same form shows a refusal that is not a 401 (the set-up finds the message)', async () => {
    const user = userEvent.setup();
    installApi({
      ...baseRoutes(),
      'GET /security': security(),
      'POST /security/password': err(
        400,
        'SAME_PASSWORD',
        'The new password is the same as the current one.',
      ),
    });
    renderApp('/ui/account');
    await changePassword(user);
    expect(await shown('The new password is the same as the current one.')).toBe(true);
  });

  it('SE-45: a step-up refused for too many attempts (429) stays in the dialog with its message; nothing is lost', async () => {
    const user = userEvent.setup();
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    try {
      const calls = installApi({
        ...baseRoutes(),
        'GET /security': security(),
        'POST /security/password': err(403, 'REAUTH_REQUIRED', 'Confirm it is you first.'),
        'POST /security/reauth': err(
          429,
          'RATE_LIMITED',
          'Too many failed attempts. Try again in 15 minute(s).',
        ),
      });
      renderApp('/ui/account');
      apiConfig.onUnauthenticated = onUnauth;
      await changePassword(user);
      const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
      await user.type(within(dialog).getByLabelText('Password'), 'the password');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Too many failed attempts/);
      expect(onUnauth).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Confirm it’s you' })).toBeInTheDocument();
      expect(calls.find('POST', '/security/password')).toHaveLength(1); // waiting for the step-up, not dropped
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  it('SE-46: the API layer: REAUTH_FAILED and WRONG_PASSWORD are not a sign-out; any other 401 is', async () => {
    const onUnauth = vi.fn();
    const original = apiConfig.onUnauthenticated;
    apiConfig.onUnauthenticated = onUnauth;
    apiConfig.base = '';
    try {
      const out: Record<string, boolean> = {};
      for (const [code, body] of [
        ['REAUTH_FAILED', { error: { code: 'REAUTH_FAILED', message: 'x' } }],
        ['WRONG_PASSWORD', { error: { code: 'WRONG_PASSWORD', message: 'x' } }],
        ['UNAUTHENTICATED', { error: { code: 'UNAUTHENTICATED', message: 'x' } }],
        ['OTHER', { error: { code: 'SOMETHING_ELSE', message: 'x' } }],
        ['no body', null],
      ] as const) {
        onUnauth.mockClear();
        installApi({ 'POST /security/reauth': { status: 401, body } });
        await api.post('/security/reauth', { password: 'x' }).catch(() => undefined);
        out[code] = onUnauth.mock.calls.length > 0;
      }
      expect(out).toEqual({
        REAUTH_FAILED: false,
        WRONG_PASSWORD: false,
        UNAUTHENTICATED: true,
        OTHER: true,
        'no body': true,
      });
    } finally {
      apiConfig.onUnauthenticated = original;
    }
  });

  it('SE-47: a change refused again after a good step-up asks once, never loops, and reports the refusal', async () => {
    const original = apiConfig.onUnauthenticated;
    apiConfig.onUnauthenticated = vi.fn();
    apiConfig.base = '';
    let asked = 0;
    const prev = apiConfig.onReauthRequired;
    apiConfig.onReauthRequired = () => {
      asked++;
      return Promise.resolve();
    };
    try {
      const calls = installApi({
        'PUT /clients/default-scope': (_c: Call) => err(403, 'REAUTH_REQUIRED', 'Confirm it is you first.'),
      });
      const e = await api
        .put('/clients/default-scope', { scope: 'write', confirmRaise: true })
        .catch((x: unknown) => x);
      expect(e instanceof ApiError && e.code).toBe('REAUTH_REQUIRED');
      expect(asked).toBe(1);
      expect(calls.find('PUT', '/clients/default-scope')).toHaveLength(2);
      await waitFor(() => expect(apiConfig.onUnauthenticated).not.toHaveBeenCalled());
    } finally {
      apiConfig.onUnauthenticated = original;
      if (prev) apiConfig.onReauthRequired = prev;
      else delete apiConfig.onReauthRequired;
    }
  });
});
