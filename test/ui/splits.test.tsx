// @vitest-environment jsdom
/**
 * v3 F3e (ADR 0059): the dashboard's side of a split. On the Proposals page each destination says what leaving it out
 * means, on the item once unticked and again in the confirmation, BEFORE the owner approves (D6). On the job page of a
 * split's phase 1 (approved by the owner) Revert is offered, says that the pages it made go to ONE deletion proposal,
 * and, when nothing had left the source, only proposes deleting them. A stopped phase 1 is named as a split.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, job, renderApp, step, useDom, type Call } from './helpers';

useDom();

const PASSWORD = 'the owner password for the dialog';
const SOURCE = '[BSRC] Zahra al-Rashid - Character Reference';

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

const dest = (key: string, label: string, sections: string) => ({
  id: `dest:${key}`,
  kind: 'split_new_owner',
  group: 'Destinations',
  label,
  page: { id: `pg${key}`, name: `[BSRC] Zahra al-Rashid - ${label}` },
  diff: {
    before: null,
    after: `${label}: the moved blocks`,
    context: `If left out, ${sections} stays in ${SOURCE} (nothing is lost).`,
  },
  dependsOn: [] as string[],
  selected: true,
});

const ITEMS = [
  dest('bio', 'Biography', '“Biography”'),
  dest('looks', 'Physical & Visual Reference', '“Appearance”'),
  {
    id: 'dep:nadirbio',
    kind: 'dependency_remap',
    group: 'Dependencies',
    label: '[BSRC] Nadira al-Khalid - Biography: Dependencies Zahra → Biography',
    page: { id: 'nadirbio', name: '[BSRC] Nadira al-Khalid - Biography' },
    diff: { before: SOURCE, after: '[BSRC] Zahra al-Rashid - Biography' },
    dependsOn: ['dest:bio'],
    selected: true,
  },
];

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop_sp',
  principalId: 'pat_abc',
  principalLabel: 'Claude Code',
  profile: 'Scribe',
  title: 'arkona_split_owner',
  summary: `arkona_split_owner: ${SOURCE} → 2 owners (2 new); the source survives with interface summaries`,
  state: 'pending',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000 * 13,
  decidedAt: null,
  rejectReason: null,
  jobId: null,
  conflict: null,
  error: null,
  opCount: 40,
  requiresCanonicalApproval: true,
  canonical: { reason: 'a split moves established material between owners', changes: [] },
  items: { total: 3, approved: null, omitted: null },
  itemPlan: { items: ITEMS, approved: null, omitted: null },
  ops: [],
  ...over,
});

describe('a split on the Proposals page (D6)', () => {
  it('leaving a destination out says its sections stay in the source, on the item and before confirming', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_sp': { proposal: proposal() },
      'POST /proposals/prop_sp/approve-as-canon': { proposal: proposal({ state: 'executing' }) },
    });
    const user = userEvent.setup();
    renderApp('/ui/proposals?id=prop_sp');
    const items = await screen.findByRole('region', { name: 'Items' });
    // Each destination says what leaving it out means.
    expect(within(items).getAllByTestId('item-context')).toHaveLength(2);
    expect(within(items).queryByTestId('item-left-out')).toBeNull();
    await user.click(within(items).getByRole('checkbox', { name: /Physical & Visual Reference/ }));
    expect(within(items).getByTestId('item-left-out')).toHaveTextContent(
      `If left out, “Appearance” stays in ${SOURCE} (nothing is lost).`,
    );
    await user.click(screen.getByRole('button', { name: 'Approve selected and accept as canon' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('2 of 3 items are approved; 1 are left out');
    expect(dialog).toHaveTextContent('What leaving them out means:');
    expect(dialog).toHaveTextContent(`“Appearance” stays in ${SOURCE}`);
    await user.click(within(dialog).getByRole('button', { name: 'Approve selected and accept as canon' }));
    await waitFor(() => expect(api.find('POST', '/proposals/prop_sp/approve-as-canon')).toHaveLength(1));
    expect(api.find('POST', '/proposals/prop_sp/approve-as-canon')[0]!.body).toEqual({
      confirm: true,
      items: ['dest:bio', 'dep:nadirbio'],
    });
  });
});

describe('a split’s phase 1 on its job page', () => {
  const stopped = job({
    id: 'job_sp',
    kind: 'batch_ops',
    title: `arkona_split_owner: ${SOURCE} → 6 owners`,
    origin: { kind: 'mcp', tool: 'proposal_approval' },
    approvedBy: 'owner',
    status: 'failed',
    finishedAt: Date.now() - 10_000,
  });
  const stop = {
    projectId: 'lkp_baisheng',
    jobId: 'job_sp',
    kind: 'split',
    lastVerifiedStep: 40,
    lastVerifiedLabel: 'the pages’ text',
    stoppedStep: 41,
    stoppedLabel: 'check the destinations before anything leaves the source',
    reason: 'SPLIT_DESTINATIONS_UNVERIFIED',
    status: 'failed',
    stoppedAt: Date.now() - 5000,
    resumes: 0,
    lastResumedAt: null,
    lastResumedBy: null,
  };

  it('names the split where it stopped, and Revert only proposes deleting the pages it made', async () => {
    const gate = needsReauth(() => ({
      revert: {
        status: 'proposed',
        deletionProposalId: 'prop_del',
        targets: [],
        message: 'Nothing of job job_sp had left the source: the pages it made are proposed for deletion.',
      },
    }));
    const api = installApi({
      ...baseRoutes(),
      'GET /jobs/job_sp': {
        job: { ...stopped, steps: [step({ jobId: 'job_sp', status: 'failed', stepNo: 41 })], artifacts: [] },
        stop,
        resume: {
          resumable: true,
          reason: null,
          kind: 'split',
          stop,
          left: [],
          recheck: [1],
          approvedBy: 'owner',
        },
        split: { id: 'sp_1', state: 'stopped', retire: true },
      },
      'GET /jobs/job_sp/revert': {
        preview: {
          jobId: 'job_sp',
          projectId: 'lkp_baisheng',
          eligible: { ok: true },
          ready: 0,
          notReverted: 0,
          targets: [],
          split: { pagesMade: 7 },
        },
      },
      'POST /jobs/job_sp/revert': gate.route,
      'POST /security/reauth': gate.reauth,
    });
    const user = userEvent.setup();
    renderApp('/ui/jobs/job_sp');
    const card = await screen.findByRole('region', { name: 'Stopped part-way' });
    expect(card).toHaveTextContent('This split (phase 1) stopped at step 41');
    // Approved by the owner, and still revertible: it is a split's phase 1.
    await user.click(screen.getByRole('button', { name: 'Revert…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Revert this split?');
    expect(dialog).toHaveTextContent('The 7 pages it made go to ONE deletion proposal');
    await user.click(within(dialog).getByRole('button', { name: 'Propose deleting them' }));
    await reauthenticate(user);
    await screen.findByText(
      'Nothing of job job_sp had left the source: the pages it made are proposed for deletion.',
    );
    expect(api.find('POST', '/jobs/job_sp/revert').at(-1)!.body).toEqual({
      confirm: true,
      confirmPartial: false,
    });
  });

  it('a job that is not a split’s, approved by the owner, offers no Revert', async () => {
    installApi({
      ...baseRoutes(),
      'GET /jobs/job_pk': {
        job: { ...stopped, id: 'job_pk', title: 'arkona_create_character', steps: [], artifacts: [] },
      },
    });
    renderApp('/ui/jobs/job_pk');
    expect((await screen.findAllByText('arkona_create_character')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Revert…' })).toBeNull();
  });
});
