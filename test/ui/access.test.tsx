// @vitest-environment jsdom

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

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
    await user.click(await screen.findByLabelText('Show low-level tools to claude-code'));
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
    readOnly: { effective: false, override: null, environment: false, appliesAt: 'immediately' },
    exposePerOpTools: {
      running: false,
      stored: null,
      environment: false,
      pendingRestart: false,
      appliesAt: 'restart',
    },
    memberAdmin: {
      running: false,
      stored: null,
      environment: false,
      pendingRestart: false,
      appliesAt: 'restart',
    },
    journalRetention: {
      running: { retentionDays: 30, maxBytes: 2 * 1024 ** 3 },
      stored: null,
      environment: { retentionDays: 30, maxBytes: 2 * 1024 ** 3 },
      pendingRestart: false,
      appliesAt: 'restart',
    },
    tierLimits: {
      running: { 'write-min': 120 },
      stored: null,
      environment: { 'write-min': 120 },
      pendingRestart: false,
      tiers: ['write-min'],
      appliesAt: 'restart',
    },
    writersMax: 2,
  });
  const routes = () => ({
    ...baseRoutes(),
    'GET /settings': { settings: settings() },
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

  it('sends nothing when the owner cancels', async () => {
    const api = installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/settings');
    const card = await screen.findByRole('region', { name: 'Member administration' });
    await user.click(within(card).getByLabelText('Enabled'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/could then remove people from your project/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('asks before saving journal retention and tier limits', async () => {
    const api = installApi({
      ...routes(),
      'PUT /settings/journal-retention': { settings: settings() },
      'PUT /settings/tier-limits': { settings: settings() },
    });
    const user = userEvent.setup();
    renderApp('/ui/settings');
    const journal = await screen.findByRole('region', { name: 'Journal retention' });
    const days = within(journal).getByLabelText('Keep for (days)');
    await user.clear(days);
    await user.type(days, '7');
    await user.click(within(journal).getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/settings/journal-retention')).toHaveLength(1));
    expect(api.find('PUT', '/settings/journal-retention')[0]!.body).toEqual({
      value: { retentionDays: 7, maxBytes: 2 * 1024 ** 3 },
      confirm: true,
    });

    const tiers = screen.getByRole('region', { name: 'Tier limit overrides' });
    await user.type(within(tiers).getByLabelText('Override for write-min'), '60');
    await user.click(within(tiers).getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/settings/tier-limits')).toHaveLength(1));
    expect(api.find('PUT', '/settings/tier-limits')[0]!.body).toEqual({
      value: { 'write-min': 60 },
      confirm: true,
    });
  });
});
