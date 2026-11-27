// @vitest-environment jsdom
/**
 * v3 F5a (ADR 0067, H2 and H4) on the Tagging page: an exception's two owner actions ("Keep this tag here", after a
 * confirmation and the step-up; "Allow this tag everywhere", a dry run shown first, then the step-up), agents'
 * suggestions beside them; "Apply all corrections" makes the batches, then "Approve all these batches" (the step-up).
 * Keyboard and screen-reader reachable: every control is a labelled button, select or input.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom, type Call } from './helpers';

useDom();

const POLICY = { packId: 'arkona', version: 17, label: 'v1.8', digest: 'cd'.repeat(32), sources: [] };
const RUN = {
  id: 'rtg_a461df416ac3ce1b',
  policy: POLICY,
  scope: { all: true },
  counts: {
    pages: 1471,
    compliant: 1058,
    correction: 30,
    hold: 10,
    exception: 1,
    lifecycleOnly: 0,
    lifecycleProblems: 0,
    excluded: 372,
  },
  reconciliationId: null,
  actor: 'owner',
  createdAt: Date.now(),
};
const overview = {
  policy: POLICY,
  unavailable: null,
  closedList: [],
  runs: [RUN],
  classifications: [],
  reconciliations: [],
  batches: [],
};
const exception = {
  pageId: 'pgimport1',
  name: '[BSRC] Saltglass Accord - Law Reference',
  disposition: 'exception',
  scope: 'grammar',
  current: ['CANON', 'Law', 'Lore'],
  proposed: ['CANON', 'Law', 'Lore'],
  rationale: [],
  exceptions: [
    {
      tag: 'Lore',
      reason:
        '“Lore” is outside the grammar and not an Excluded Routine Tag: whether it is incidental is the owner’s judgement (kept)',
    },
  ],
  rulings: [],
  suggestions: [
    { id: 1, tag: 'Lore', action: 'allow_everywhere', reason: 'used on many law pages', by: 'claude', at: 1 },
  ],
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

const routes = (over: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /tagging': overview,
  [`GET /tagging/runs/${RUN.id}`]: { run: RUN, total: 0, pages: [] },
  'GET /tagging/exceptions': {
    run: RUN,
    supplementary: ['Cosmology', 'Chronology', 'Setting Framework'],
    exceptions: [exception],
  },
  ...over,
});

/** ADR 0081: no step-up dialog: the action goes straight on. */
const passwordDialog = async (_user: ReturnType<typeof userEvent.setup>) => {
  await Promise.resolve();
  expect(screen.queryByRole('dialog', { name: 'Confirm it’s you' })).toBeNull();
};

describe('H2: an exception’s owner actions', () => {
  it('shows the supplementary list, the exception and an agent’s suggestion', async () => {
    installApi(routes());
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
    const card = await waitFor(() => {
      const c = document.querySelector<HTMLElement>('[data-exception="pgimport1"]');
      if (!c) throw new Error('not yet');
      return c;
    });
    expect(screen.getByText(/Cosmology, Chronology, Setting Framework/)).toBeInTheDocument();
    expect(card).toHaveTextContent('“Lore” is outside the grammar');
    expect(card).toHaveTextContent('Suggested: allow it everywhere (claude: used on many law pages)');
  });

  it('"Keep this tag here" needs a reason, a confirmation and the step-up', async () => {
    const gate = answersAtOnce(() => ({ ruling: { tag: 'Lore' } }));
    const api = installApi(
      routes({ 'POST /tagging/keep-here': gate.route, 'POST /security/reauth': gate.reauth }),
    );
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
    const keep = await screen.findByRole('button', { name: 'Keep this tag here' });
    expect(keep).toBeDisabled();
    await user.type(
      screen.getByLabelText(/Reason for \[BSRC\] Saltglass Accord/),
      'Lore is right on this page',
    );
    await user.click(keep);
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/If they change, the ruling lapses/);
    await user.click(within(confirm).getByRole('button', { name: 'Keep this tag here' }));
    await passwordDialog(user);
    await screen.findByText(/Kept: the next audit treats it as allowed on this page/);
    expect(api.find('POST', '/tagging/keep-here').at(-1)!.body).toEqual({
      pageId: 'pgimport1',
      tag: 'Lore',
      reason: 'Lore is right on this page',
      confirm: true,
    });
  });

  it('"Allow this tag everywhere" shows the dry run’s sentence before and after, then asks for the step-up', async () => {
    const before =
      'the author has approved these existing tags as permitted supplementary tags on any eligible owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework.';
    const after = before.replace(
      'Chronology and Setting Framework',
      'Chronology, Setting Framework and Lore',
    );
    const gate = answersAtOnce((c) =>
      (c.body as { dryRun?: boolean }).dryRun
        ? {
            dryRun: true,
            before,
            after,
            tags: ['Cosmology', 'Chronology', 'Setting Framework', 'Lore'],
            jobId: null,
          }
        : { dryRun: false, before, after, tags: [], jobId: 'job_1' },
    );
    const api = installApi(
      routes({ 'POST /tagging/allow-everywhere': gate.route, 'POST /security/reauth': gate.reauth }),
    );
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
    await user.click(await screen.findByRole('button', { name: 'Allow this tag everywhere' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(`Before: ${before}`);
    expect(confirm).toHaveTextContent(`After: ${after}`);
    expect(api.find('POST', '/tagging/allow-everywhere')[0]!.body).toEqual({
      tag: 'Lore',
      pageId: 'pgimport1',
      dryRun: true,
    });
    await user.click(within(confirm).getByRole('button', { name: 'Allow this tag everywhere' }));
    await passwordDialog(user);
    await screen.findByText(/approve the pack’s new version on the Packs page/);
    expect(api.find('POST', '/tagging/allow-everywhere').at(-1)!.body).toEqual({
      tag: 'Lore',
      pageId: 'pgimport1',
      confirm: true,
    });
  });
});

describe('H4: Apply all corrections', () => {
  it('v3 F12: confirmed, the batches run at once, each one job; nothing is left to approve', async () => {
    const api = installApi(
      routes({
        'POST /tagging/apply-all': {
          pages: 30,
          batches: [
            { batchId: 'rtb_1', proposalId: null, jobId: 'job_b1', pages: 25 },
            { batchId: 'rtb_2', proposalId: null, jobId: 'job_b2', pages: 5 },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('button', { name: 'Apply all corrections (30)' }));
    const c1 = await screen.findByRole('alertdialog');
    expect(c1).toHaveTextContent(/each one job at once/);
    await user.click(within(c1).getByRole('button', { name: 'Apply the batches' }));
    await screen.findByText('2 batches made: 25, 5 pages.');
    expect(api.find('POST', '/tagging/apply-all')[0]!.body).toEqual({ runId: RUN.id, confirm: true });
    expect(screen.queryByRole('button', { name: /Approve all these batches/ })).toBeNull();
  });

  it('batches answered as proposals: approves all of them together (no fresh code, ADR 0081)', async () => {
    const gate = answersAtOnce(() => ({
      results: [
        { id: 'prop_b1', ok: true, state: 'executing' },
        { id: 'prop_b2', ok: false, state: 'conflicted', error: { message: 'a target changed' } },
      ],
    }));
    const api = installApi(
      routes({
        'POST /tagging/apply-all': {
          pages: 30,
          batches: [
            { proposalId: 'prop_b1', pages: 25 },
            { proposalId: 'prop_b2', pages: 5 },
          ],
        },
        'POST /tagging/approve-batches': gate.route,
        'POST /security/reauth': gate.reauth,
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/tagging');
    await user.click(await screen.findByRole('button', { name: 'Apply all corrections (30)' }));
    const c1 = await screen.findByRole('alertdialog');
    await user.click(within(c1).getByRole('button', { name: 'Apply the batches' }));
    await screen.findByText('2 batches made: 25, 5 pages.');
    expect(api.find('POST', '/tagging/apply-all')[0]!.body).toEqual({ runId: RUN.id, confirm: true });
    await user.click(screen.getByRole('button', { name: 'Approve all these batches (2)' }));
    const c2 = await screen.findByRole('alertdialog');
    await user.click(within(c2).getByRole('button', { name: 'Approve all these batches' }));
    await passwordDialog(user);
    const list = await screen.findByRole('list', { name: 'Batch approvals' });
    expect(list).toHaveTextContent('approved prop_b1');
    expect(list).toHaveTextContent('refused prop_b2: a target changed');
    expect(api.find('POST', '/tagging/approve-batches').at(-1)!.body).toEqual({
      proposalIds: ['prop_b1', 'prop_b2'],
      confirm: true,
    });
  });
});
