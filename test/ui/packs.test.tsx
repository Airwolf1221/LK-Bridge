// @vitest-environment jsdom
/**
 * v3 F3a (ADR 0050): the Packs page. It shows a pack's state (approved, drift), its governance sources and versions, its
 * projects and templates, its rules read-only, and its token maps; "Approve this pack version" and "Save token maps" ask
 * for a confirmation and the password again before anything is sent.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const PASSWORD = 'the owner password for the dialog';

const pack = (over: Record<string, unknown> = {}) => ({
  id: 'arkona',
  name: 'Arkona',
  prefix: 'arkona_',
  rules: ARKONA_PACK.rules,
  version: 2,
  governance: ARKONA_PACK.governance,
  approved: {
    version: 1,
    at: Date.UTC(2026, 10, 16),
    by: 'owner',
    sources: [
      { key: 'character-architecture', version: 'v4' },
      { key: 'source-formatting', version: 'v9' },
      { key: 'tagging-standard', version: 'v18' },
    ],
  },
  drift: null,
  seed: 'arkona-2026-11-16',
  attachments: [
    {
      projectId: 'lkp_arkona',
      projectName: 'arkona',
      served: true,
      templates: {
        core: 'bffw83fb',
        compact: 'exl4dzki',
        art: 'g7gdpoe6',
        relationship: 'krkreawl',
        general: 'ie08m47o',
        index: 'zaomdr49',
      },
      notes: [],
      attachedAt: 1,
      attachedBy: 'seed',
    },
  ],
  tools: ['arkona_create_character'],
  versions: [
    { version: 2, reason: 'token maps edited on the Packs page', approved: null, createdAt: 2 },
    { version: 1, reason: 'seed', approved: {}, createdAt: 1 },
  ],
  ...over,
});

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

describe('the Packs page', () => {
  it('is in the navigation, after Repository Mappings, and shows the pack: state, sources, projects, rules', async () => {
    installApi({ ...baseRoutes(), 'GET /packs': { packs: [pack()] } });
    renderApp('/ui/packs');
    expect(await screen.findByRole('heading', { level: 1, name: 'Packs' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(labels.indexOf('Packs')).toBe(labels.indexOf('Repository Mappings') + 1);
    const card = screen.getByRole('heading', { name: /Arkona/ }).closest('section')!;
    expect(within(card).getByText('rules changed since approval')).toBeInTheDocument();
    expect(within(card).getAllByText('arkona_create_character').length).toBeGreaterThan(0);
    const sources = within(card).getByText('Controlled Native Tagging Standard').closest('tr')!;
    expect(within(sources).getByText('v18')).toBeInTheDocument();
    expect(within(card).getByText(/core: bffw83fb/)).toBeInTheDocument();
    expect(within(card).getByRole('table', { name: 'Character roles' })).toBeInTheDocument();
    expect(within(card).getByText(/token maps edited on the Packs page/)).toBeInTheDocument();
  });

  it('warns about drift, checks the governance on request', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...baseRoutes(),
      'GET /packs': {
        packs: [
          pack({
            version: 1,
            drift: {
              at: 1,
              changed: [
                {
                  key: 'tagging-standard',
                  name: 'Controlled Native Tagging Standard',
                  approved: 'v18',
                  current: 'v19',
                },
              ],
            },
          }),
        ],
      },
      'GET /packs/arkona/governance': {
        governance: {
          state: 'changed',
          message:
            'Arkona’s governance changed since the owner approved the Arkona pack: Controlled Native Tagging Standard.',
          version: 1,
          approvedVersion: 1,
          sources: [
            {
              key: 'tagging-standard',
              name: 'Controlled Native Tagging Standard',
              project: 'arkona',
              resourceId: 'cn8v87hh',
              documentId: 'bfrv43jr',
              approved: 'v18',
              current: 'v19',
              digest: 'x',
              state: 'changed',
            },
          ],
        },
      },
    });
    renderApp('/ui/packs');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /No tags are computed until you check the rules and approve again/,
    );
    await user.click(screen.getByRole('button', { name: 'Check governance now' }));
    expect(await screen.findByText('v19')).toBeInTheDocument();
    expect(api.find('GET', '/packs/arkona/governance')).toHaveLength(1);
  });

  it('approving asks for a confirmation and the password again, then sends confirm: true', async () => {
    const user = userEvent.setup();
    const gate = needsReauth(() => ({
      pack: pack(),
      governance: {
        state: 'current',
        message: 'The pack is approved and its governance sources are as approved.',
        version: 2,
        approvedVersion: 2,
        sources: [],
      },
    }));
    const api = installApi({
      ...baseRoutes(),
      'GET /packs': { packs: [pack()] },
      'POST /packs/arkona/approve': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/packs');
    await user.click(await screen.findByRole('button', { name: 'Approve this pack version' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/version 2/);
    await user.click(within(confirm).getByRole('button', { name: 'Approve this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await user.type(within(dialog).getByLabelText('Password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/Arkona version 2 approved\./);
    expect(api.find('POST', '/packs/arkona/approve').at(-1)!.body).toEqual({ confirm: true });
  });

  it('saves edited token maps after a confirmation (a new version)', async () => {
    const user = userEvent.setup();
    const gate = needsReauth(() => ({ pack: pack({ version: 3 }) }));
    const api = installApi({
      ...baseRoutes(),
      'GET /packs': { packs: [pack()] },
      'PUT /packs/arkona/tokens': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/packs');
    await user.click(await screen.findByRole('button', { name: 'Add race / species token' }));
    const table = screen.getByRole('table', { name: 'Race / Species tokens' });
    const n = within(table).getAllByRole('row').length - 1;
    await user.type(within(table).getByLabelText(`Race / Species value ${n}`), 'Starborn');
    await user.type(within(table).getByLabelText(`Race / Species token ${n}`), 'Starborn');
    await user.click(screen.getByRole('button', { name: 'Save token maps' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save token maps' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await user.type(within(dialog).getByLabelText('Password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/Token maps saved/);
    const sent = api.find('PUT', '/packs/arkona/tokens').at(-1)!.body as {
      race: Record<string, string>;
      confirm: boolean;
    };
    expect(sent.confirm).toBe(true);
    expect(sent.race.Starborn).toBe('Starborn');
    expect(sent.race['Sun Elf']).toBe('Sun Elf');
  });
});
