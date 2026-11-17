// @vitest-environment jsdom
/**
 * v3 F3.4 (ADR 0055): the Review page (agents' direct writes at scope write: the queue, an item's diff, Mark reviewed,
 * Mark all reviewed with the count confirmed), Revert (the targets read live shown first; a partial revert needs a
 * deliberate tick; the password again before anything is sent), the safety rails on Clients & Access, the pack tools'
 * switches on the Packs page, and the Overview's count.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { baseRoutes, installApi, profiles, renderApp, useDom, type Call } from './helpers';

useDom();

const PASSWORD = 'the owner password for the dialog';

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

async function reauthenticate(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
  await user.type(within(dialog).getByLabelText('Password'), PASSWORD);
  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
}

const item = (over: Record<string, unknown> = {}) => ({
  jobId: 'job_direct1',
  projectId: 'lkp_baisheng',
  createdAt: Date.now() - 60_000,
  finishedAt: Date.now() - 59_000,
  status: 'succeeded',
  agent: { principalId: 'pat_claude', name: 'Claude Code (PAT)', profile: 'claude-code' },
  tool: 'write_page',
  summary: 'write_page append on “Ashgate” (Main): 1 block added',
  pages: [{ id: 'ashg0001', name: 'Ashgate' }],
  reviewed: null,
  revert: null,
  ...over,
});

const detail = {
  ...item(),
  pageChanges: [
    {
      page: { id: 'ashg0001', name: 'Ashgate' },
      changes: [
        {
          key: 'text:d1',
          kind: 'text',
          what: 'page text',
          steps: [1],
          uncertain: false,
          document: { id: 'd1', name: 'Main' },
          markdownDiff: {
            added: 1,
            removed: 0,
            hunks: [
              {
                beforeStart: 1,
                beforeLines: 1,
                afterStart: 1,
                afterLines: 2,
                lines: [
                  { kind: 'same', text: 'A walled town.' },
                  { kind: 'add', text: 'The gate was rebuilt in stone.' },
                ],
              },
            ],
          },
        },
        {
          key: 'facts:ashg0001',
          kind: 'facts',
          what: 'sidebar facts',
          steps: [3],
          uncertain: false,
          facts: [{ key: 'Scope', before: 'A walled town', after: 'A walled port town' }],
        },
      ],
    },
  ],
  revertable: { ok: true, reason: null },
};

const reviewRoutes = (items = [item()]) => ({
  'GET /review': {
    items,
    facets: { profiles: ['claude-code'], tools: ['write_page'] },
    counts: { unreviewed: items.length, matching: items.length },
  },
  'GET /review/job_direct1': { item: detail },
  'GET /review/counts': { unreviewed: items.length, byProject: { baisheng: items.length } },
});

describe('the Review page', () => {
  it('lists a direct write with its agent, tool, summary and pages; shows its diff; Mark reviewed sends its id', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...baseRoutes(),
      ...reviewRoutes(),
      'POST /review/mark': { marked: ['job_direct1'] },
    });
    renderApp('/ui/review');
    expect(
      await screen.findByText('write_page append on “Ashgate” (Main): 1 block added'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Claude Code \(PAT\) \(claude-code\) · write_page/)).toBeInTheDocument();
    expect(screen.getByText('Pages: Ashgate')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the changes' }));
    expect(await screen.findByText('The gate was rebuilt in stone.')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'A walled port town' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await screen.findByText('Marked reviewed.');
    expect(api.find('POST', '/review/mark').at(-1)!.body).toEqual({ ids: ['job_direct1'] });
  });

  it('“Mark all reviewed” confirms the count and sends it with the filter', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...baseRoutes(),
      ...reviewRoutes([item(), item({ jobId: 'job_direct2' })]),
      'POST /review/mark-all': { marked: ['job_direct1', 'job_direct2'] },
    });
    renderApp('/ui/review');
    await user.click(await screen.findByRole('button', { name: 'Mark all reviewed (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Mark 2 items reviewed?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Mark all reviewed' }));
    await waitFor(() => expect(api.find('POST', '/review/mark-all')).toHaveLength(1));
    expect(api.find('POST', '/review/mark-all')[0]!.body).toEqual({ filter: {}, expect: 2, confirm: true });
  });

  it('Revert shows what would be put back, needs a tick for a partial revert, then the password', async () => {
    const user = userEvent.setup();
    const gate = needsReauth(() => ({ revert: { revertJobId: 'job_revert1', message: 'submitted' } }));
    const api = installApi({
      ...baseRoutes(),
      ...reviewRoutes(),
      'GET /jobs/job_direct1/revert': {
        preview: {
          jobId: 'job_direct1',
          projectId: 'lkp_baisheng',
          eligible: { ok: true },
          ready: 1,
          notReverted: 1,
          targets: [
            {
              key: 'text:d1',
              kind: 'text',
              page: { id: 'ashg0001', name: 'Ashgate' },
              what: 'page text',
              state: 'ready',
              detail: '1 block write',
            },
            {
              key: 'facts:ashg0001',
              kind: 'facts',
              page: { id: 'ashg0001', name: 'Ashgate' },
              what: 'sidebar facts',
              state: 'changed',
              detail: 'the sidebar has changed since the job',
              differences: [
                { path: 'PROPERTIES Scope', expected: 'A walled port town', actual: 'Edited by hand' },
              ],
            },
          ],
        },
      },
      'POST /jobs/job_direct1/revert': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/review');
    await user.click(await screen.findByRole('button', { name: 'Revert…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Revert part of this job?')).toBeInTheDocument();
    expect(within(dialog).getByText('will be put back')).toBeInTheDocument();
    expect(within(dialog).getByText('changed since: not reverted')).toBeInTheDocument();
    expect(within(dialog).getByText(/now Edited by hand/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Revert the rest' });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(go);
    await reauthenticate(user);
    await screen.findByText('Revert submitted.');
    // CR-2026-11-R2 (F6): a partial revert names the targets the owner confirmed (the preview's ready set).
    expect(api.find('POST', '/jobs/job_direct1/revert').at(-1)!.body).toEqual({
      confirm: true,
      confirmPartial: true,
      confirmed: ['text:d1'],
    });
  });

  it('a revert that cannot apply says why and sends nothing', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...baseRoutes(),
      ...reviewRoutes(),
      'GET /jobs/job_direct1/revert': {
        preview: {
          jobId: 'job_direct1',
          projectId: 'lkp_baisheng',
          eligible: { ok: false, code: 'IS_A_REVERT', message: 'A revert is never itself reverted.' },
          ready: 0,
          notReverted: 0,
          targets: [],
        },
      },
    });
    renderApp('/ui/review');
    await user.click(await screen.findByRole('button', { name: 'Revert…' }));
    await screen.findByText('A revert is never itself reverted.');
    expect(api.find('POST', '/jobs/job_direct1/revert')).toEqual([]);
  });
});

describe('the Overview', () => {
  it('shows how many direct writes wait for review, linked to Review', async () => {
    installApi({
      ...baseRoutes(),
      'GET /overview': {
        health: { lk: { ok: true }, keyRole: 'ADMIN', plan: 'ok', checkedAt: Date.now() },
        controls: {
          writesPaused: false,
          draining: false,
          readOnly: false,
          readOnlyOverride: null,
          writersMax: 2,
          allowMemberAdmin: false,
        },
        activeJobs: { total: 0, running: 0, queued: 0, waiting: 0, paused: 0, uncertain: 0 },
        errorsLastHour: { count: 0, capped: false },
        pendingProposals: 0,
        unreviewedDirectWrites: 4,
        writes: { state: 'running', perMinute: 0 },
        budget: null,
      },
    });
    renderApp('/ui/');
    const link = await screen.findByRole('link', { name: 'direct writes to review' });
    expect(link.closest('.stat')).toHaveTextContent('4');
  });
});

describe('Clients & Access: the safety rails', () => {
  it('shows each write profile’s rails (the defaults) and saves a change after the password', async () => {
    const user = userEvent.setup();
    const writer = profiles.find((p) => p.scope === 'write') ?? profiles[0]!;
    const gate = needsReauth((c) => ({
      profile: { ...writer, rails: (c.body as { rails: unknown }).rails },
    }));
    const api = installApi({
      ...baseRoutes(),
      'GET /clients': {
        profiles: [{ ...writer, scope: 'write' }],
        defaultScope: 'read',
        connections: [],
        settings: { autoRemoveDays: 30, staleAfterDays: 14 },
        kinds: ['claude', 'chatgpt', 'claude-code', 'other'],
        scopes: ['read', 'propose', 'write'],
      },
      [`PUT /clients/profiles/${writer.id}/rails`]: gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/clients');
    const deletes = await screen.findByRole('switch', { name: `Always propose: Deletes (${writer.label})` });
    expect(deletes).toBeChecked();
    expect(
      screen.getByRole('switch', { name: `Always propose: Renames and moves of pages (${writer.label})` }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('spinbutton', { name: `Bulk threshold, in pages (${writer.label})` }),
    ).toHaveValue(10);
    await user.click(
      screen.getByRole('switch', { name: `Always propose: Renames and moves of pages (${writer.label})` }),
    );
    await user.click(screen.getByRole('button', { name: `Save rails for ${writer.label}` }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save the rails' }),
    );
    await reauthenticate(user);
    await screen.findByText('Rails saved.');
    expect(api.find('PUT', `/clients/profiles/${writer.id}/rails`).at(-1)!.body).toEqual({
      rails: { deletes: true, bulk: true, bulkPages: 10, renamesMoves: true, assets: true },
      confirm: true,
    });
  });
});

describe('Packs: the tools’ switches', () => {
  it('shows each write tool’s switch and saves a change as a new version after the password', async () => {
    const user = userEvent.setup();
    const pack = {
      id: 'arkona',
      name: 'Arkona',
      prefix: 'arkona_',
      rules: ARKONA_PACK.rules,
      version: 5,
      governance: ARKONA_PACK.governance,
      approved: null,
      drift: null,
      seed: ARKONA_PACK.seed,
      attachments: [],
      tools: ['arkona_create_character', 'arkona_add_character_art'],
      toolModes: [
        { tool: 'arkona_create_character', mode: 'propose', source: 'switch' },
        { tool: 'arkona_add_character_art', mode: 'scope', source: 'switch' },
      ],
      versions: [],
    };
    const gate = needsReauth(() => ({ pack: { ...pack, version: 6 } }));
    const api = installApi({
      ...baseRoutes(),
      'GET /packs': { packs: [pack] },
      'PUT /packs/arkona/tools': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    renderApp('/ui/packs');
    const create = await screen.findByRole('switch', { name: 'Always propose: arkona_create_character' });
    expect(create).toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Always propose: arkona_add_character_art' }),
    ).not.toBeChecked();
    await user.click(create);
    await user.click(screen.getByRole('button', { name: 'Save tool switches' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save as a new version' }),
    );
    await reauthenticate(user);
    await screen.findByText('Saved as a new version: approve it to use it.');
    expect(api.find('PUT', '/packs/arkona/tools').at(-1)!.body).toEqual({
      tools: { arkona_create_character: 'scope' },
      confirm: true,
    });
  });
});
