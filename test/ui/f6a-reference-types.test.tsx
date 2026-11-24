// @vitest-environment jsdom
/**
 * v3 F6a (ADR 0076; design T2) on the Reference Types page: a filter goes to the server; Accept asks for a confirmation
 * and the step-up; Edit offers the category's canonical values in a picker (and a new value with its role word);
 * Publish vocabulary shows the section's exact text first (a preview, no step-up), then asks for the step-up.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const PASSWORD = 'the owner password for the dialog';
const CATEGORIES = [
  {
    category: 'Culture',
    types: [
      { name: 'Culture Reference', role: 'Culture' },
      { name: 'Language & Naming Reference', role: 'Language & Naming' },
    ],
  },
  { category: 'Polity', types: [{ name: 'Polity Reference', role: 'Polity' }] },
];
const page = (id: string, name: string) => ({
  id,
  name,
  path: `AI REPOSITORY / ${name}`,
  category: 'Culture',
  lifecycle: 'Authoritative',
  coverage: 'ok',
  readAt: new Date().toISOString(),
});
const ROWS = [
  {
    value: 'Historical Cultural Reference',
    category: 'Culture',
    count: 2,
    status: 'open',
    pages: [
      page('c1', '[BSRC] Menkheti - Culture Reference'),
      page('c2', '[BSRC] Velaran - Culture Reference'),
    ],
    suggestion: {
      value: 'Culture Reference',
      kind: 'suggested',
      reason: 'Culture Reference reads as Culture Reference; “Historical” is time: Temporal Scope carries it',
      moved: { time: ['Historical'], scope: [] },
      synonyms: ['Cultural → Culture'],
      candidates: [],
    },
    decision: null,
    conflict: null,
  },
  {
    value: 'Culture & Naming Reference',
    category: 'Culture',
    count: 1,
    status: 'open',
    pages: [page('c3', '[BSRC] Fujimatsu Names - Reference')],
    suggestion: {
      value: null,
      kind: 'none',
      reason: 'no confident suggestion: no type of Culture matches',
      moved: { time: [], scope: [] },
      synonyms: [],
      candidates: [{ name: 'Language & Naming Reference', category: 'Culture', role: 'Language & Naming' }],
    },
    decision: null,
    conflict: null,
  },
];
const response = {
  project: { id: 'test', name: 'test' },
  report: {
    pack: { id: 'arkona', version: 30, approvedVersion: 30 },
    vocabulary: { status: 'draft', approved: true },
    rows: ROWS,
    totalRows: 2,
    coverage: {
      pages: 40,
      ok: 38,
      stale: 1,
      missing: 1,
      withoutReferenceType: 2,
      oldestRead: new Date().toISOString(),
      unread: [{ id: 'u1', name: '[BSRC] Unread Page', path: 'x' }],
      tree: { status: 'ready', confirmedAt: new Date().toISOString() },
    },
    excluded: { Working: 3, 'Legacy Canon Archive': 5 },
  },
  vocabulary: {
    status: 'draft',
    approved: true,
    rule: 'A Reference Type names the page’s role, from a closed list per primary category.',
    categories: CATEGORIES,
    specialist: [],
    pending: [],
  },
  conflicts: [],
  decisions: [],
  publications: [],
  now: Date.now(),
};

function needsReauth(then: (c: Call) => unknown) {
  let confirmed = false;
  return {
    route: (c: Call) =>
      confirmed || (c.body as { dryRun?: boolean } | undefined)?.dryRun === true
        ? then(c)
        : {
            status: 403,
            body: { error: { code: 'REAUTH_REQUIRED', message: 'Confirm your password first.' } },
          },
    reauth: () => {
      confirmed = true;
      return { until: Date.now() + 600_000 };
    },
  };
}

const passwordDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  const dialog = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
  await user.type(within(dialog).getByLabelText('Password'), PASSWORD);
  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
};

const rowEl = async (value: string) =>
  waitFor(() => {
    const r = document.querySelector<HTMLElement>(`tr[data-value="${value}"]`);
    if (!r) throw new Error('not yet');
    return r;
  });

describe('the Reference Types page', () => {
  it('shows each value with its suggestion and the coverage; a filter goes to the server', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /reference-types': response });
    const user = userEvent.setup();
    renderApp('/ui/reference-types');
    const row = await rowEl('Historical Cultural Reference');
    expect(row).toHaveTextContent('Culture Reference');
    expect(row).toHaveTextContent('Temporal Scope');
    expect(document.querySelector('[data-coverage]')).toHaveTextContent('1 never read');
    expect(document.querySelector('[data-coverage]')).toHaveTextContent('Working 3');
    expect(api.find('GET', '/reference-types')[0]!.query).toContain('status=open');
    await user.selectOptions(screen.getByLabelText('Category'), 'Polity');
    await waitFor(() =>
      expect(api.find('GET', '/reference-types').at(-1)!.query).toContain('category=Polity'),
    );
  });

  it('Accept: a confirmation, then the step-up', async () => {
    const gate = needsReauth(() => ({ decision: { id: 'rtd_1' } }));
    const api = installApi({
      ...baseRoutes(),
      'GET /reference-types': response,
      'POST /reference-types/decide': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/reference-types');
    const row = await rowEl('Historical Cultural Reference');
    await user.click(within(row).getByRole('button', { name: 'Accept' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Map “Historical Cultural Reference” to “Culture Reference”?');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await passwordDialog(user);
    await screen.findByText('Mapped to Culture Reference.');
    expect(api.find('POST', '/reference-types/decide').at(-1)!.body).toEqual({
      value: 'Historical Cultural Reference',
      category: 'Culture',
      action: 'accept',
      confirm: true,
    });
  });

  it('Edit: the picker offers the category’s canonical values, or a new one with its role word', async () => {
    const gate = needsReauth(() => ({ decision: { id: 'rtd_2' } }));
    const api = installApi({
      ...baseRoutes(),
      'GET /reference-types': response,
      'POST /reference-types/decide': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/reference-types');
    const row = await rowEl('Culture & Naming Reference');
    expect(within(row).getByRole('button', { name: 'Accept' })).toBeDisabled();
    await user.click(within(row).getByRole('button', { name: 'Edit…' }));
    const picker = within(row).getByLabelText('Map Culture & Naming Reference to');
    const options = within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Choose a Culture type…',
      'Culture Reference (Culture)',
      'Language & Naming Reference (Language & Naming)',
      'A new canonical value…',
    ]);
    await user.selectOptions(picker, 'Language & Naming Reference');
    await user.click(within(row).getByRole('button', { name: 'Map' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Confirm' }));
    await passwordDialog(user);
    await screen.findByText('Mapped to Language & Naming Reference.');
    expect(api.find('POST', '/reference-types/decide').at(-1)!.body).toEqual({
      value: 'Culture & Naming Reference',
      category: 'Culture',
      action: 'edit',
      target: 'Language & Naming Reference',
      confirm: true,
    });
  });

  it('Publish vocabulary: the exact section text first, then the step-up', async () => {
    const lines = [
      'Reference Type Vocabulary',
      'A Reference Type names the page’s role, from a closed list per primary category.',
      'Culture: Culture Reference (Culture); Language & Naming Reference (Language & Naming).',
    ];
    const gate = needsReauth((c) =>
      (c.body as { dryRun?: boolean }).dryRun
        ? {
            dryRun: true,
            lines,
            replaced: false,
            confirmation:
              'This writes the section … The governance page changes, so the Packs page will ask you to approve the Arkona pack again.',
            decisions: 0,
            page: { id: 'g1', name: 'Source Formatting' },
            jobId: null,
          }
        : { dryRun: false, lines, replaced: false, jobId: 'job_9' },
    );
    const api = installApi({
      ...baseRoutes(),
      'GET /reference-types': response,
      'POST /reference-types/publish': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/reference-types');
    await user.click(await screen.findByRole('button', { name: 'Publish vocabulary…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('approve the Arkona pack again');
    expect(confirm.querySelector('[data-preview]')).toHaveTextContent(
      'Culture: Culture Reference (Culture); Language & Naming Reference (Language & Naming).',
    );
    expect(api.find('POST', '/reference-types/publish')[0]!.body).toEqual({ dryRun: true });
    await user.click(within(confirm).getByRole('button', { name: 'Publish vocabulary' }));
    await passwordDialog(user);
    await screen.findByText('Published: approve the pack again on the Packs page.');
    expect(api.find('POST', '/reference-types/publish').at(-1)!.body).toEqual({ confirm: true });
  });
});
