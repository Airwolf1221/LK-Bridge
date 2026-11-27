// @vitest-environment jsdom

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, connections, installApi, renderApp, useDom } from './helpers';
import { configView, settingsView } from './settings-fixtures';

useDom();

describe('scopes', () => {
  it('asks before raising a profile’s scope, and sends the confirmation with the change', async () => {
    const api = installApi({ ...baseRoutes(), 'PUT /clients/profiles/prof_claude/scope': { profile: {} } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.selectOptions(await screen.findByLabelText('Scope for Claude'), 'write');
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Raise “Claude” to “write”?');
    expect(dialog).toHaveTextContent(/every connection that uses it/);
    expect(api.find('PUT', /scope/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Raise to write' }));
    await waitFor(() => expect(api.find('PUT', '/clients/profiles/prof_claude/scope')).toHaveLength(1));
    expect(api.find('PUT', '/clients/profiles/prof_claude/scope')[0]!.body).toEqual({
      scope: 'write',
      confirmRaise: true,
    });
  });

  it('does nothing when the raise is cancelled', async () => {
    const api = installApi(baseRoutes());
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.selectOptions(await screen.findByLabelText('Scope for Claude'), 'propose');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.find('PUT', /scope/)).toHaveLength(0);
  });

  it('lowers a scope without a confirmation', async () => {
    const api = installApi({ ...baseRoutes(), 'PUT /clients/profiles/prof_cc/scope': { profile: {} } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.selectOptions(await screen.findByLabelText('Scope for claude-code'), 'read');
    await waitFor(() => expect(api.find('PUT', '/clients/profiles/prof_cc/scope')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.find('PUT', '/clients/profiles/prof_cc/scope')[0]!.body).toEqual({
      scope: 'read',
      confirmRaise: false,
    });
  });

  it('shows or hides the low-level tools per profile, without a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'PUT /clients/profiles/prof_cc/low-level-tools': { profile: {} },
    });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.click(await screen.findByLabelText('Show low-level and rarely used tools to claude-code'));
    await waitFor(() => expect(api.find('PUT', '/clients/profiles/prof_cc/low-level-tools')).toHaveLength(1));
    expect(api.find('PUT', '/clients/profiles/prof_cc/low-level-tools')[0]!.body).toEqual({ show: true });
  });

  it('confirms raising the default scope for new connections', async () => {
    const api = installApi({ ...baseRoutes(), 'PUT /clients/default-scope': { defaultScope: 'propose' } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Default scope for new connections' }),
      'propose',
    );
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Raise to propose' }),
    );
    await waitFor(() => expect(api.find('PUT', '/clients/default-scope')).toHaveLength(1));
    expect(api.find('PUT', '/clients/default-scope')[0]!.body).toEqual({
      scope: 'propose',
      confirmRaise: true,
    });
  });

  it('creates a profile', async () => {
    const api = installApi({ ...baseRoutes(), 'POST /clients/profiles': { profile: {} } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.type(await screen.findByLabelText('Label'), 'My new agent');
    await user.selectOptions(screen.getByLabelText('Kind'), 'chatgpt');
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    await waitFor(() => expect(api.find('POST', '/clients/profiles')).toHaveLength(1));
    expect(api.find('POST', '/clients/profiles')[0]!.body).toEqual({
      label: 'My new agent',
      kind: 'chatgpt',
    });
  });
});

describe('connections', () => {
  it('revokes after a confirmation', async () => {
    const api = installApi({ ...baseRoutes(), 'POST /clients/connections/pat_1/revoke': { revoked: true } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    const row = await screen.findByRole('row', { name: /Laptop/ });
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Laptop');
    expect(api.find('POST', /revoke/)).toHaveLength(0);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.find('POST', '/clients/connections/pat_1/revoke')).toHaveLength(1));
  });

  it('moves a connection to another profile', async () => {
    const api = installApi({ ...baseRoutes(), 'PUT /clients/connections/pat_1/profile': { connection: {} } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.selectOptions(await screen.findByLabelText('Profile for Laptop'), 'prof_claude');
    await waitFor(() => expect(api.find('PUT', '/clients/connections/pat_1/profile')).toHaveLength(1));
    expect(api.find('PUT', '/clients/connections/pat_1/profile')[0]!.body).toEqual({
      profileId: 'prof_claude',
    });
  });
});

describe('personal access tokens', () => {
  const TOKEN = 'lkb_pat_SECRETSECRETSECRETSECRETSECRETSECRETSECRET';

  it('shows a new token once, with a copy button, and never again', async () => {
    const api = installApi({
      ...baseRoutes(),
      'POST /clients/pats': {
        token: TOKEN,
        pat: { id: 'pat_new', name: 'Claude Code on my laptop' },
        shownOnce: true,
      },
    });
    const user = userEvent.setup();
    const view = renderApp('/ui/clients');
    await user.type(await screen.findByLabelText('Name'), 'Claude Code on my laptop');
    await user.selectOptions(screen.getByLabelText('Profile', { selector: '#pat-profile' }), 'prof_cc');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.find('POST', '/clients/pats')).toHaveLength(1));
    expect(api.find('POST', '/clients/pats')[0]!.body).toEqual({
      name: 'Claude Code on my laptop',
      profileId: 'prof_cc',
      expiresInDays: 90,
    });
    expect(api.find('POST', '/clients/pats')[0]!.headers['x-csrf-token']).toBe('csrf-token-for-tests');

    // Shown once, with a warning and a copy button.
    expect(await screen.findByTestId('pat-token')).toHaveTextContent(TOKEN);
    expect(screen.getByText(/shown once and cannot be recovered/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(TOKEN));
    // The Claude Code command is offered, and shown with a placeholder rather than the secret.
    expect(
      screen.getByText(/claude mcp add --transport http lk-bridge https:\/\/lk\.example\.test\/mcp/),
    ).not.toHaveTextContent(TOKEN);

    // Dismissed: gone from the page, and nothing asks the API for it again.
    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByTestId('pat-token')).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    const callsAfter = api.calls.length;
    view.unmount();
    renderApp('/ui/clients');
    await screen.findByRole('heading', { level: 1, name: 'Clients & Access' });
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(api.calls.slice(callsAfter).every((c) => c.method === 'GET')).toBe(true);
    // And nothing in the browser's storage kept it.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN);
  });

  it('needs a name and a sensible expiry before it will create anything', async () => {
    const api = installApi(baseRoutes());
    const user = userEvent.setup();
    renderApp('/ui/clients');
    const create = await screen.findByRole('button', { name: 'Create token' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'x');
    expect(create).toBeEnabled();
    await user.clear(screen.getByLabelText('Expires after (days)'));
    await user.type(screen.getByLabelText('Expires after (days)'), '0');
    expect(create).toBeDisabled();
    expect(api.find('POST', '/clients/pats')).toHaveLength(0);
  });

  it('shows an API refusal as a message instead of a token', async () => {
    installApi({
      ...baseRoutes(),
      'POST /clients/pats': {
        status: 404,
        body: { error: { code: 'PROFILE_NOT_FOUND', message: 'No profile prof_cc' } },
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.type(await screen.findByLabelText('Name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('No profile prof_cc')).toBeInTheDocument();
    expect(screen.queryByTestId('pat-token')).toBeNull();
  });
});

describe('settings ask for confirmation', () => {
  const settings = () => ({
    ...settingsView(),
    readOnly: { effective: false, override: null, environment: false, appliesAt: 'immediately' },
  });
  const routes = () => ({
    ...baseRoutes(),
    'GET /settings': { settings: settings() },
    'GET /settings/config': configView(),
    'GET /audit': { entries: [] },
  });

  it('changes read-only mode only after the owner confirms, and sends confirm: true', async () => {
    const api = installApi({ ...routes(), 'PUT /settings/read-only': { settings: settings() } });
    const user = userEvent.setup();
    renderApp('/ui/settings');
    const card = await screen.findByRole('region', { name: 'Read-only mode' });
    await user.click(within(card).getByLabelText('On: refuse every write'));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Every write will be refused straight away.');
    expect(api.find('PUT', '/settings/read-only')).toHaveLength(0);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/settings/read-only')).toHaveLength(1));
    expect(api.find('PUT', '/settings/read-only')[0]!.body).toEqual({ value: true, confirm: true });
  });

  it('sends nothing when the owner cancels (v3 F8: a registry setting’s edit)', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/settings');
    const row = await screen.findByRole('group', { name: 'Most frames in an animation' });
    await user.click(within(row).getByRole('button', { name: 'Edit Most frames in an animation' }));
    const input = within(row).getByLabelText('New value (frames)');
    await user.clear(input);
    await user.type(input, '50');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Set IMAGE_MAX_FRAMES to 50 frames. Applies at once');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('asks before saving a registry setting and the tier limits', async () => {
    const api = installApi({
      ...routes(),
      'PUT /settings/config/IMAGE_MAX_FRAMES': { entry: {} },
      'PUT /settings/tier-limits': { settings: settings() },
    });
    const user = userEvent.setup();
    renderApp('/ui/settings');
    const row = await screen.findByRole('group', { name: 'Most frames in an animation' });
    await user.click(within(row).getByRole('button', { name: 'Edit Most frames in an animation' }));
    const input = within(row).getByLabelText('New value (frames)');
    await user.clear(input);
    await user.type(input, '7');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(api.find('PUT', '/settings/config/IMAGE_MAX_FRAMES')).toHaveLength(0);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/settings/config/IMAGE_MAX_FRAMES')).toHaveLength(1));
    expect(api.find('PUT', '/settings/config/IMAGE_MAX_FRAMES')[0]!.body).toEqual({
      amount: 7,
      unit: 'frames',
      confirm: true,
    });

    const tiers = screen.getByRole('region', { name: 'Tier limit overrides' });
    await user.type(within(tiers).getByLabelText('Override for write-min'), '60');
    await user.click(within(tiers).getByRole('button', { name: 'Save tier limits' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/settings/tier-limits')).toHaveLength(1));
    expect(api.find('PUT', '/settings/tier-limits')[0]!.body).toEqual({
      value: { 'write-min': 60 },
      confirm: true,
    });
  });
});

describe('old connections (ADR 0033)', () => {
  const DAY = 86_400_000;
  const dead = {
    id: 'pat_dead',
    type: 'pat',
    label: 'Claude Code (PC)',
    clientId: null,
    profileId: 'prof_cc',
    profile: 'claude-code',
    scope: 'write',
    createdAt: Date.now() - 20 * DAY,
    lastUsedAt: null,
    expiresAt: Date.now() + 340 * DAY, // next year or later: the year is shown
    revokedAt: Date.now() - 2 * DAY,
    active: false,
    stale: false,
  };
  const expired = {
    ...dead,
    id: 'grant_old',
    type: 'grant',
    label: 'ChatGPT',
    profileId: 'prof_claude',
    profile: 'Claude',
    revokedAt: null,
    expiresAt: Date.now() - DAY,
    createdAt: Date.now() - 91 * DAY,
  };
  const stale = {
    ...connections[0]!,
    id: 'grant_stale',
    label: 'Old Claude',
    stale: true,
    lastUsedAt: Date.now() - 20 * DAY,
  };
  const withOld = () => ({
    ...baseRoutes(),
    'GET /clients': {
      ...(baseRoutes()['GET /clients'] as object),
      connections: [...connections, dead, expired, stale],
    },
  });

  it('a revoked or expired row has Remove (no confirmation) where an active one has Revoke; active rows cannot be removed', async () => {
    const api = installApi({ ...withOld(), 'POST /clients/connections/pat_dead/remove': { removed: {} } });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    const row = await screen.findByRole('row', { name: /Claude Code \(PC\)/ });
    expect(within(row).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(within(row).getByText('revoked')).toBeInTheDocument();
    expect(within(row).getByText(/\d{4}/)).toBeInTheDocument(); // the expiry carries its year
    const live = screen.getByRole('row', { name: /Laptop/ });
    expect(within(live).queryByRole('button', { name: 'Remove' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(api.find('POST', '/clients/connections/pat_dead/remove')).toHaveLength(1));
  });

  it('"Remove all revoked and expired (N)" shows only when N > 0, and confirms with the rows listed', async () => {
    installApi(baseRoutes());
    const first = renderApp('/ui/clients');
    await screen.findByRole('row', { name: /Laptop/ });
    expect(screen.queryByRole('button', { name: /Remove all revoked and expired/ })).toBeNull();
    first.unmount();
    const api = installApi({
      ...withOld(),
      'POST /clients/connections/remove-inactive': { removed: 2, ids: ['pat_dead', 'grant_old'] },
    });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.click(await screen.findByRole('button', { name: 'Remove all revoked and expired (2)' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Claude Code (PC)');
    expect(dialog).toHaveTextContent('ChatGPT');
    expect(api.find('POST', /remove-inactive/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove 2' }));
    await waitFor(() => expect(api.find('POST', '/clients/connections/remove-inactive')).toHaveLength(1));
  });

  it('saves the automatic removal days and the stale threshold; 0 = never', async () => {
    const api = installApi({
      ...baseRoutes(),
      'PUT /clients/settings/auto-remove-days': { autoRemoveDays: 0 },
      'PUT /clients/settings/stale-after-days': { staleAfterDays: 7 },
    });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    const auto = await screen.findByLabelText('Remove revoked and expired connections automatically after');
    expect(auto).toHaveValue(30);
    await user.clear(auto);
    await user.type(auto, '0');
    await user.click(within(auto.closest('.row') as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/clients/settings/auto-remove-days')).toHaveLength(1));
    expect(api.find('PUT', '/clients/settings/auto-remove-days')[0]!.body).toEqual({ days: 0 });
    const stale = screen.getByLabelText('Mark a connection stale after');
    await user.clear(stale);
    await user.type(stale, '7');
    await user.click(within(stale.closest('.row') as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/clients/settings/stale-after-days')).toHaveLength(1));
    expect(api.find('PUT', '/clients/settings/stale-after-days')[0]!.body).toEqual({ days: 7 });
  });

  it('a stale connection gets a badge; its profile gets "Revoke stale (N)", confirmed with the list', async () => {
    const api = installApi({
      ...withOld(),
      'POST /clients/connections/revoke-stale': { revoked: 1, ids: ['grant_stale'] },
    });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    const row = await screen.findByRole('row', { name: /Old Claude/ });
    expect(within(row).getByText('stale')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Laptop/ })).queryByText('stale')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revoke stale (1)' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Old Claude');
    expect(api.find('POST', /revoke-stale/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke 1' }));
    await waitFor(() => expect(api.find('POST', '/clients/connections/revoke-stale')).toHaveLength(1));
    expect(api.find('POST', '/clients/connections/revoke-stale')[0]!.body).toEqual({
      profileId: 'prof_claude',
    });
  });

  it('says that claude.ai caches the tool list, beside the low-level tools checkbox', async () => {
    installApi(baseRoutes());
    renderApp('/ui/clients');
    const box = await screen.findByLabelText('Show low-level and rarely used tools to claude-code');
    const hint = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(hint).toHaveTextContent(/claude\.ai keeps its own copy of a connector’s tool list/);
    expect(hint).toHaveTextContent(/disconnected and reconnected in claude\.ai’s settings/);
    expect(hint).toHaveTextContent(
      /New chats alone were not enough \(observed on 10 November 2026; not a guarantee\)/,
    );
    expect(hint).toHaveTextContent(/ChatGPT, use Plugins, then the bridge, then Refresh/);
  });
});

describe('CR-2026-11-R2 (R2-50), ADR 0081: a scope change asks for the password when the bridge says so', () => {
  it('a scope raise refused with REAUTH_REQUIRED opens the password dialog and is sent again', async () => {
    let confirmed = false;
    const api = installApi({
      ...baseRoutes(),
      'PUT /clients/profiles/prof_claude/scope': () =>
        confirmed
          ? { profile: {} }
          : {
              status: 403,
              body: { error: { code: 'REAUTH_REQUIRED', message: 'Confirm your password first.' } },
            },
      'POST /security/reauth': () => {
        confirmed = true;
        return { until: Date.now() + 300_000 };
      },
    });
    const user = userEvent.setup();
    renderApp('/ui/clients');
    await user.selectOptions(await screen.findByLabelText('Scope for Claude'), 'write');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Raise to write' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await user.type(within(dialog).getByLabelText('Password'), 'the owner password');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.find('PUT', '/clients/profiles/prof_claude/scope')).toHaveLength(2));
    expect(api.find('POST', '/security/reauth')).toHaveLength(1);
    expect(api.find('PUT', '/clients/profiles/prof_claude/scope')[1]!.body).toEqual({
      scope: 'write',
      confirmRaise: true,
    });
  });
});
