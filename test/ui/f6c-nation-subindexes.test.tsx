// @vitest-environment jsdom
/**
 * v3 F6c (ADR 0080) on the Nation Subindexes page: each nation's child with its matched role, how it matched and the
 * unified name; a collision and content spanning two roles shown; Accept asks for the step-up; Map to a role "for every
 * page with this name" is ONE request to map-all; a decided row offers Undo; a filter goes to the server.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const ROLES = [
  'Government & Administration',
  'Institutions',
  'Historical Events',
  'Military & Technology',
  'Unique Magic & Technologies',
  'Cultures',
  'Settlements & Locations',
  'Religion & Religious Administration',
  'Household & Court',
  'Historical Polities',
];
const nation = {
  id: 'can',
  name: '[INDEX] Kingdom of Cantha',
  displayName: 'Kingdom of Cantha',
  shortName: 'Cantha',
};
const row = (o: Record<string, unknown>) => ({
  nation,
  path: 'AI REPOSITORY / Zarvia / Zarvia Polities / Kingdom of Cantha / x',
  link: '/ui/tree?node=x',
  children: 0,
  classification: 'nav',
  match: null,
  role: null,
  proposedName: null,
  standard: false,
  status: 'unmatched',
  decision: null,
  collision: [],
  spans: null,
  ...o,
});
const ROWS = [
  row({
    id: 'gov',
    name: '[NAV] Government & Institutions',
    displayName: 'Government & Institutions',
    children: 2,
    match: {
      role: 'Government & Administration',
      via: 'variant',
      form: 'bare',
      word: 'Government & Institutions',
    },
    role: 'Government & Administration',
    proposedName: 'Cantha Government & Administration',
    status: 'proposed',
    spans: {
      roles: ['Government & Administration', 'Institutions'],
      pages: [{ id: 'p1', name: '[BSRC] Royal Council - Institution Reference', category: 'Institution' }],
    },
  }),
  row({ id: 'mil', name: '[NAV] Military & Naval Affairs', displayName: 'Military & Naval Affairs' }),
  row({
    id: 'set',
    name: '[NAV] Settlements & Locations',
    displayName: 'Settlements & Locations',
    match: { role: 'Settlements & Locations', via: 'role', form: 'bare', word: 'Settlements & Locations' },
    role: 'Settlements & Locations',
    proposedName: 'Cantha Settlements & Locations',
    status: 'accepted',
    decision: {
      id: 'nsd_1',
      action: 'accept',
      role: 'Settlements & Locations',
      via: 'accept',
      by: 'owner',
      at: 1,
    },
    collision: [{ id: 'set2', name: '[NAV] Cantha Settlements' }],
  }),
];
const response = {
  project: { id: 'test', name: 'test' },
  report: {
    pack: { id: 'arkona', version: 32, approvedVersion: 32 },
    rules: {
      approved: true,
      roles: ROLES,
      variants: [{ variant: 'Government & Institutions', role: ROLES[0] }],
      nationSeeded: true,
    },
    nations: [{ id: 'can', name: '[INDEX] Kingdom of Cantha', shortName: 'Cantha' }],
    rows: ROWS,
    totalRows: 3,
    counts: {
      proposed: 1,
      unmatched: 1,
      accepted: 1,
      mapped: 0,
      specialist: 0,
      not_subindex: 0,
      collision: 1,
    },
  },
  bulkMax: 500,
  acceptable: { count: 1, ids: ['gov'] },
  now: Date.now(),
};

/** ADR 0081: the bridge asks no fresh code for these actions: the route answers at once, and no step-up is sent. */
function answersAtOnce(then: (c: Call) => unknown) {
  return {
    route: then,
    reauth: () => ({
      status: 500,
      body: { error: { code: 'NOT_ASKED', message: 'ADR 0081: no step-up here.' } },
    }),
  };
}
/** ADR 0081: no step-up dialog: the action goes straight on. */
const passwordDialog = async (_user: ReturnType<typeof userEvent.setup>) => {
  await Promise.resolve();
  expect(screen.queryByRole('dialog', { name: 'Confirm it’s you' })).toBeNull();
};
const rowEl = async (id: string) =>
  waitFor(() => {
    const r = document.querySelector<HTMLElement>(`tr[data-row="${id}"]`);
    if (!r) throw new Error('not yet');
    return r;
  });

describe('the Nation Subindexes page', () => {
  it('shows each child with its role, how it matched and the unified name; collisions and spans; a filter', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /nation-subindexes': response });
    const user = userEvent.setup();
    renderApp('/ui/nation-subindexes');
    const gov = await rowEl('gov');
    expect(gov).toHaveTextContent('approved variant');
    expect(gov).toHaveTextContent('Cantha Government & Administration');
    expect(gov.querySelector('[data-spans]')).toHaveTextContent('Royal Council');
    expect((await rowEl('set')).querySelector('[data-collision]')).toHaveTextContent('merge or re-map first');
    expect(within(await rowEl('mil')).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(document.querySelector('[data-rules]')).toHaveTextContent('Household & Court');
    await user.selectOptions(screen.getByLabelText('Status'), 'unmatched');
    await waitFor(() =>
      expect(api.find('GET', '/nation-subindexes').at(-1)!.query).toContain('status=unmatched'),
    );
  });

  it('Accept asks for the step-up and sends the decision', async () => {
    const gate = answersAtOnce(() => ({ decision: { id: 'nsd_2' }, row: {} }));
    const api = installApi({
      ...baseRoutes(),
      'GET /nation-subindexes': response,
      'POST /nation-subindexes/decide': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/nation-subindexes');
    await user.click(within(await rowEl('gov')).getByRole('button', { name: 'Accept' }));
    await passwordDialog(user);
    await waitFor(() =>
      expect(api.find('POST', '/nation-subindexes/decide').at(-1)!.body).toEqual({
        pageId: 'gov',
        confirm: true,
        action: 'accept',
      }),
    );
  });

  it('Map to a role, for every page with this name: ONE request to map-all', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /nation-subindexes': response,
      'POST /nation-subindexes/map-all': () => ({
        mapped: 2,
        skipped: [],
        max: 500,
        decisions: [],
        rows: [],
      }),
    });
    const user = userEvent.setup();
    renderApp('/ui/nation-subindexes');
    const mil = await rowEl('mil');
    await user.click(within(mil).getByRole('button', { name: 'Map to a role' }));
    await user.selectOptions(within(mil).getByLabelText('Role'), 'Military & Technology');
    await user.click(within(mil).getByLabelText(/for every page with this name/));
    await user.click(within(mil).getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Map all' }));
    await waitFor(() => expect(api.find('POST', '/nation-subindexes/map-all')).toHaveLength(1));
    expect(api.find('POST', '/nation-subindexes/map-all')[0]!.body).toEqual({
      pageId: 'mil',
      confirm: true,
      role: 'Military & Technology',
    });
  });

  it('a decided row offers Undo', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /nation-subindexes': response,
      'POST /nation-subindexes/undo': () => ({ undone: {}, row: null }),
    });
    const user = userEvent.setup();
    renderApp('/ui/nation-subindexes');
    await user.click(within(await rowEl('set')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.find('POST', '/nation-subindexes/undo')).toHaveLength(1));
  });

  it('Accept all matched shows the count before confirming, then sends those ids in ONE request', async () => {
    const gate = answersAtOnce(() => ({
      accepted: 1,
      skipped: [],
      remaining: 0,
      max: 500,
      decisions: [],
      rows: [],
    }));
    const api = installApi({
      ...baseRoutes(),
      'GET /nation-subindexes': response,
      'POST /nation-subindexes/accept-all': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/nation-subindexes');
    await user.click(await screen.findByRole('button', { name: 'Accept all matched (1)' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Accept 1 matched row(s)?' });
    expect(dialog).toHaveTextContent('collisions');
    expect(api.find('POST', '/nation-subindexes/accept-all')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Accept 1' }));
    await passwordDialog(user);
    await waitFor(() =>
      expect(api.find('POST', '/nation-subindexes/accept-all').at(-1)!.body).toEqual({
        ids: ['gov'],
        confirm: true,
      }),
    );
  });
});
