// @vitest-environment jsdom
/**
 * v3 F6b (ADR 0079; design T12 step 1) on the Index Classification page: each index with its proposal and the rule that
 * decided it; a filter goes to the server; Approve asks for the step-up; Change offers nav or subject (with the subject's
 * kind); "Approve all as proposed" sends the ids of the whole filter in ONE request, at most the bound; an out-of-scope
 * row offers nothing to decide; the structural lists save as a new pack version.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const row = (o: Record<string, unknown>) => ({
  displayName: String(o.name).replace(/^\[\w+\] /, ''),
  path: `AI REPOSITORY / Characters / ${String(o.name)}`,
  currentRole: 'subject',
  tags: [],
  subject: null,
  scope: 'in',
  area: null,
  decision: null,
  approvedRole: null,
  approvedSubject: null,
  drifted: false,
  matched: [],
  ...o,
});
const ROWS = [
  row({
    id: 'hh',
    name: '[INDEX] High Humans',
    proposed: 'nav',
    rule: 'race',
    why: 'a race (the registry)',
    status: 'proposed',
    tags: ['Species'],
  }),
  row({
    id: 'ms',
    name: '[INDEX] Miyubi Sakura',
    proposed: 'subject',
    subject: 'character',
    rule: 'character',
    why: 'a character index',
    status: 'proposed',
  }),
  row({
    id: 'od',
    name: '[INDEX] Odd Things',
    proposed: 'undecided',
    rule: 'no_rule',
    why: 'no rule settles it',
    status: 'undecided',
  }),
  row({
    id: 'wk',
    name: '[INDEX] Draft Set',
    proposed: 'undecided',
    rule: 'out_of_scope',
    why: 'out of scope',
    status: 'out_of_scope',
    scope: 'out',
    area: 'Working',
  }),
];
const STRUCTURAL = {
  topLevel: ['Characters', 'Arkona'],
  named: ['Arkonan Cultures'],
  continentCategories: ['Polities'],
  continentParents: ['Arkona’s Continents'],
  realmshipParents: ['Lost Realmships'],
  settingFramework: 'Setting Framework',
  settingFrameworkCategories: ['Bestiary'],
  divineRealms: 'Divine Realms',
  divineRealmCategories: ['Upper Realms'],
  nationSubindexes: ['Institutions'],
  cultureCategories: ['Cultures'],
  religionCategories: ['Religions'],
};
const response = {
  project: { id: 'test', name: 'test' },
  report: {
    pack: { id: 'arkona', version: 31, approvedVersion: 31 },
    rules: {
      approved: true,
      tagSection: 'draft',
      orderingInForce: true,
      structural: STRUCTURAL,
      outOfScope: ['Working', 'Archive'],
      templates: { nav: '[NAV] AI Navigation', subject: '[INDEX] AI Index' },
    },
    rows: ROWS,
    totalRows: 4,
    counts: { proposed: 2, undecided: 1, approved: 0, changed: 0, left_undecided: 0, out_of_scope: 1 },
    ruleText: { race: 'a race', character: 'a character', no_rule: 'no rule' },
  },
  approvable: ['hh', 'ms', 'x1', 'x2'],
  bulkMax: 3,
  subjects: ['character', 'polity', 'culture', 'religion', 'place', 'story'],
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

describe('the Index Classification page', () => {
  it('shows each index with its proposal and rule; the rules in force; a filter goes to the server', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /index-classification': response });
    const user = userEvent.setup();
    renderApp('/ui/index-classification');
    const hh = await rowEl('hh');
    expect(hh).toHaveTextContent('[NAV]');
    expect(hh).toHaveTextContent('a race (the registry)');
    expect(document.querySelector('[data-rules]')).toHaveTextContent('in force');
    expect(document.querySelector('[data-rules]')).toHaveTextContent('unpublished');
    expect(api.find('GET', '/index-classification')[0]!.query).toContain('status=proposed');
    await user.selectOptions(screen.getByLabelText('Proposed'), 'nav');
    await waitFor(() =>
      expect(api.find('GET', '/index-classification').at(-1)!.query).toContain('proposed=nav'),
    );
    // An out-of-scope row is reported, never decided.
    const wk = await rowEl('wk');
    expect(wk).toHaveTextContent('reported, never proposed');
    expect(within(wk).queryByRole('button', { name: 'Approve' })).toBeNull();
    // A row no rule settles offers no Approve.
    expect(within(await rowEl('od')).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('Approve asks for the step-up and sends the decision', async () => {
    const gate = answersAtOnce(() => ({ decision: { id: 'icd_1' }, row: {} }));
    const api = installApi({
      ...baseRoutes(),
      'GET /index-classification': response,
      'POST /index-classification/decide': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/index-classification');
    await user.click(within(await rowEl('hh')).getByRole('button', { name: 'Approve' }));
    await passwordDialog(user);
    await screen.findByText('[INDEX] High Humans: approved.');
    expect(api.find('POST', '/index-classification/decide').at(-1)!.body).toEqual({
      pageId: 'hh',
      confirm: true,
      action: 'approve',
    });
  });

  it('Change: nav or subject, with the subject’s kind', async () => {
    const gate = answersAtOnce(() => ({ decision: { id: 'icd_2' }, row: {} }));
    const api = installApi({
      ...baseRoutes(),
      'GET /index-classification': response,
      'POST /index-classification/decide': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/index-classification');
    const od = await rowEl('od');
    await user.click(within(od).getByRole('button', { name: 'Change' }));
    await user.selectOptions(within(od).getByLabelText('Role'), 'subject');
    await user.selectOptions(within(od).getByLabelText('Subject'), 'culture');
    await user.click(within(od).getByRole('button', { name: 'Save' }));
    await passwordDialog(user);
    await waitFor(() =>
      expect(api.find('POST', '/index-classification/decide').at(-1)!.body).toEqual({
        pageId: 'od',
        confirm: true,
        action: 'change',
        role: 'subject',
        subject: 'culture',
      }),
    );
  });

  it('Approve all as proposed: the filter’s ids in ONE request, at most the bound', async () => {
    const gate = answersAtOnce((c) => ({
      approved: (c.body as { ids: string[] }).ids.length,
      skipped: 0,
      remaining: 1,
      max: 3,
      rows: [],
      decisions: [],
      skippedRows: [],
    }));
    const api = installApi({
      ...baseRoutes(),
      'GET /index-classification': response,
      'POST /index-classification/bulk-approve': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/index-classification');
    await user.click(await screen.findByRole('button', { name: 'Approve all as proposed (4)' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Approve the first 3 of 4 proposed rows?');
    await user.click(within(confirm).getByRole('button', { name: 'Approve all' }));
    await passwordDialog(user);
    await waitFor(() => expect(api.find('POST', '/index-classification/bulk-approve')).toHaveLength(1)); // sent once: no step-up
    expect(api.find('POST', '/index-classification/bulk-approve').at(-1)!.body).toEqual({
      ids: ['hh', 'ms', 'x1'],
      confirm: true,
    });
  });

  it('the structural lists save as a new pack version, one name per line', async () => {
    const gate = answersAtOnce(() => ({ changed: true, pack: { id: 'arkona', version: 32 } }));
    const api = installApi({
      ...baseRoutes(),
      'GET /index-classification': response,
      'PUT /index-classification/structural': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/index-classification');
    const box = await screen.findByLabelText('Routing indexes by exact name');
    await user.type(box, '\nLost Realmships');
    await user.click(screen.getByRole('button', { name: 'Save as a new pack version' }));
    await passwordDialog(user);
    await waitFor(() => expect(api.find('PUT', '/index-classification/structural')).toHaveLength(1)); // sent once: no step-up
    const body = api.find('PUT', '/index-classification/structural').at(-1)!.body as {
      structural: { named: string[] };
      outOfScope: string[];
      confirm: boolean;
    };
    expect(body.structural.named).toEqual(['Arkonan Cultures', 'Lost Realmships']);
    expect(body.outOfScope).toEqual(['Working', 'Archive']);
    expect(body.confirm).toBe(true);
  });
});
