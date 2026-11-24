// @vitest-environment jsdom
/**
 * v3 F8 (ADR 0073): the Settings page shows every setting by group (value in its display unit, source, range, how it
 * applies), edits and resets through the registry's routes, searches labels and keys, shows bootstrap settings
 * read-only and secrets as set or not set, and offers "Restart the bridge" with the pending count.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

import { MB, configView, settingsView } from './settings-fixtures';

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /settings': { settings: settingsView() },
  'GET /settings/config': configView(),
  'GET /audit': {
    entries: [
      {
        id: 7,
        at: Date.now(),
        actor: 'owner',
        action: 'settings.config',
        target: 'UPLOAD_MAX_BYTES',
        before: { value: 10 * MB, source: 'default' },
        after: { value: 20 * MB, source: 'dashboard', applies: 'next_start' },
      },
    ],
  },
  ...over,
});

const row = (label: string) => screen.getByRole('group', { name: label });

describe('the Settings page (v3 F8)', () => {
  it('shows each group with value, unit, source, range and how it applies; bootstrap read-only; secrets set or not', async () => {
    installApi(routes());
    renderApp('/ui/settings');
    const images = await screen.findByRole('region', { name: 'Images and uploads' });
    const upload = within(images).getByRole('group', { name: 'Largest image upload' });
    expect(upload).toHaveTextContent('20 MB');
    expect(upload).toHaveTextContent('saved here');
    expect(upload).toHaveTextContent('pending restart');
    expect(upload).toHaveTextContent('Range: 0.000977 to 100 MB');
    expect(upload).toHaveTextContent('Applies at the next restart');
    expect(upload).toHaveTextContent('Running now: 10 MB');
    expect(row('Most frames in an animation')).toHaveTextContent('environment');
    expect(row('Most frames in an animation')).toHaveTextContent('Applies at once');
    // Bootstrap: its value, read-only, and why.
    const db = row('Database file');
    expect(db).toHaveTextContent('/var/lib/lk-bridge/bridge.db');
    expect(db).toHaveTextContent('Change on the server: the env file, via env-sync.');
    expect(db).toHaveTextContent('Read before the database opens.');
    expect(within(db).queryByRole('button', { name: /Edit/ })).toBeNull();
    // A secret: its name and "set", never a value; where it is managed.
    const secret = row('Session secret');
    expect(secret).toHaveTextContent('set');
    expect(secret).toHaveTextContent('Secret: never shown here.');
    expect(within(secret).getByRole('link', { name: 'the env file, via env-sync' })).toBeInTheDocument();
    // Per project: a link to the Projects page.
    expect(
      within(row('Images: days an unplaced staged image is kept')).getByRole('link', {
        name: 'the Projects page',
      }),
    ).toBeInTheDocument();
    // The pending count with the restart button; Recent changes with old and new values.
    const restart = screen.getByRole('region', { name: 'Restart the bridge' });
    expect(restart).toHaveTextContent('1 setting pending a restart');
    const changes = screen.getByRole('region', { name: 'Recent changes' });
    expect(changes).toHaveTextContent('settings.config');
    expect(changes).toHaveTextContent('10485760 (default)');
    expect(changes).toHaveTextContent('20971520 (dashboard)');
    // The tier limit table sits with its setting.
    expect(screen.getByRole('region', { name: 'Tier limit overrides' })).toBeInTheDocument();
  });

  it('edits in the display unit (confirmed) and resets a saved value', async () => {
    const api = installApi(
      routes({
        'PUT /settings/config/IMAGE_MAX_FRAMES': { entry: {} },
        'POST /settings/config/UPLOAD_MAX_BYTES/reset': { entry: {} },
        'PUT /settings/config/UPLOAD_MAX_BYTES': { entry: {} },
      }),
    );
    renderApp('/ui/settings');
    await screen.findByRole('region', { name: 'Images and uploads' });
    const user = userEvent.setup();
    await user.click(
      within(row('Largest image upload')).getByRole('button', { name: 'Edit Largest image upload' }),
    );
    const input = within(row('Largest image upload')).getByLabelText('New value (MB)');
    await user.clear(input);
    await user.type(input, '200');
    expect(within(row('Largest image upload')).getByRole('alert')).toHaveTextContent('Within');
    await user.clear(input);
    await user.type(input, '25.5');
    await user.click(within(row('Largest image upload')).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Change “Largest image upload”?' });
    expect(dialog).toHaveTextContent('Set UPLOAD_MAX_BYTES to 25.5 MB. Applies at the next restart');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/settings/config/UPLOAD_MAX_BYTES')).toHaveLength(1));
    expect(api.find('PUT', '/settings/config/UPLOAD_MAX_BYTES')[0]!.body).toEqual({
      amount: 25.5,
      unit: 'MB',
      confirm: true,
    });
    // Reset: only for a value saved here.
    expect(within(row('Most frames in an animation')).queryByRole('button', { name: /Reset/ })).toBeNull();
    await user.click(
      within(row('Largest image upload')).getByRole('button', { name: 'Reset Largest image upload' }),
    );
    const reset = await screen.findByRole('alertdialog', { name: 'Reset “Largest image upload”?' });
    expect(reset).toHaveTextContent('Back to the default: 10 MB.');
    await user.click(within(reset).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(api.find('POST', '/settings/config/UPLOAD_MAX_BYTES/reset')).toHaveLength(1));
    expect(api.find('POST', '/settings/config/UPLOAD_MAX_BYTES/reset')[0]!.body).toEqual({ confirm: true });
  });

  it('searches labels and keys', async () => {
    installApi(routes());
    renderApp('/ui/settings');
    await screen.findByRole('region', { name: 'Images and uploads' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search settings'), 'frames');
    expect(screen.getByRole('group', { name: 'Most frames in an animation' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Largest image upload' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Server (bootstrap)' })).toBeNull();
    await user.clear(screen.getByLabelText('Search settings'));
    await user.type(screen.getByLabelText('Search settings'), 'db_path');
    expect(screen.getByRole('group', { name: 'Database file' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Most frames in an animation' })).toBeNull();
    await user.clear(screen.getByLabelText('Search settings'));
    await user.type(screen.getByLabelText('Search settings'), 'zzz');
    expect(screen.getByText('No setting matches “zzz”.')).toBeInTheDocument();
  });

  it('restarts after a confirmation; outside systemd the button is disabled and says why', async () => {
    const api = installApi(routes({ 'POST /bridge/restart': { status: 202, body: { restarting: true } } }));
    renderApp('/ui/settings');
    const card = await screen.findByRole('region', { name: 'Restart the bridge' });
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: 'Restart the bridge' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restart the bridge?' });
    expect(dialog).toHaveTextContent('The pending setting applies when it is back.');
    await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(api.find('POST', '/bridge/restart')).toHaveLength(1));
  });

  it('the button is disabled outside systemd, with the reason', async () => {
    installApi(
      routes({
        'GET /settings/config': configView({
          pendingRestart: 0,
          restart: {
            available: false,
            reason: 'The bridge is not running under systemd (its environment has no INVOCATION_ID).',
            last: { requestedAt: Date.now() - 60_000, by: 'owner', backAt: Date.now() - 50_000 },
            inProgress: false,
          },
        }),
      }),
    );
    renderApp('/ui/settings');
    const card = await screen.findByRole('region', { name: 'Restart the bridge' });
    expect(within(card).getByRole('button', { name: 'Restart the bridge' })).toBeDisabled();
    expect(card).toHaveTextContent('not running under systemd');
    expect(card).toHaveTextContent('0 settings pending a restart');
    expect(card).toHaveTextContent('Last restarted at the owner’s request');
  });
});
