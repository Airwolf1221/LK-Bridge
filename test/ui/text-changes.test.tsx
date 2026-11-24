// @vitest-environment jsdom
/**
 * Amendment 1 to ADR 0072: a proposal that changes words never hides them. The Proposals page shows every change of
 * words (the proposal's "Words that change", and each item's diff) as the sentence before and after with the replaced
 * words highlighted; the Review page's card shows the words a direct job changed the same way.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const AKARI_BEFORE = "This compact character reference owns Akari's individual identity, voice and history.";
const AKARI_AFTER = "This Character Core owns Akari's individual identity, voice and history.";
const change = {
  page: '[BSRC] Shibukawa Akari - Character Core',
  pageId: 'akaricor',
  blockId: 'ak4',
  what: 'wording',
  before: AKARI_BEFORE,
  after: AKARI_AFTER,
  removed: { start: 5, end: 32 },
  added: { start: 5, end: 19 },
};

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop_cw',
  principalId: 'system',
  principalLabel: 'Audits',
  profile: 'Bridge',
  title: 'core_compact_wording',
  summary: `Replace 1 phrase where Shibukawa Akari's Character Core calls itself compact Text: “${AKARI_BEFORE}” → “${AKARI_AFTER}”`,
  state: 'pending',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000 * 13,
  decidedAt: null,
  rejectReason: null,
  jobId: null,
  conflict: null,
  error: null,
  opCount: 1,
  requiresCanonicalApproval: false,
  operations: [
    {
      tool: 'audits.core_wording',
      page: { id: 'akaricor', name: change.page },
      textChanges: [change],
    },
  ],
  ops: [],
  ...over,
});

describe('the Proposals page', () => {
  it('a core_text proposal: the summary, and “Words that change” with the replaced words highlighted', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [proposal()] },
      'GET /proposals/prop_cw': { proposal: proposal() },
    });
    renderApp('/ui/proposals?id=prop_cw');
    const words = await screen.findByRole('region', { name: 'Words that change' });
    expect(words).toHaveTextContent('Words that change (1)');
    const c = within(words).getByTestId('text-change');
    expect(c).toHaveTextContent(`Before: “${AKARI_BEFORE}”`);
    expect(c).toHaveTextContent(`After: “${AKARI_AFTER}”`);
    expect(within(c).getByTestId('tc-del')).toHaveTextContent(/^compact character reference$/);
    expect(within(c).getByTestId('tc-del').tagName).toBe('DEL');
    expect(within(c).getByTestId('tc-ins')).toHaveTextContent(/^Character Core$/);
    expect(within(c).getByTestId('tc-ins').tagName).toBe('INS');
    expect(screen.getAllByText(new RegExp(`Text: “${AKARI_BEFORE.slice(0, 30)}`)).length).toBeGreaterThan(0);
  });

  it('an item’s diff: a change of words shows its sentences, the replaced words highlighted', async () => {
    const itemised = proposal({
      operations: [],
      items: { total: 1, approved: null, omitted: null },
      itemPlan: {
        items: [
          {
            id: 'existing:akaricor',
            kind: 'page_change',
            group: 'Changes to existing pages',
            label: `${change.page}: 1 phrase calling the identity page compact now says Character Core`,
            page: { id: 'akaricor', name: change.page },
            diff: {
              changes: [
                { what: 'name', before: 'A - Character Reference', after: 'A - Character Core' },
                {
                  what: 'wording',
                  before: AKARI_BEFORE,
                  after: AKARI_AFTER,
                  removed: change.removed,
                  added: change.added,
                },
              ],
            },
            dependsOn: [],
            selected: true,
          },
        ],
        approved: null,
        omitted: null,
      },
    });
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [itemised] },
      'GET /proposals/prop_cw': { proposal: itemised },
    });
    renderApp('/ui/proposals?id=prop_cw');
    const items = await screen.findByRole('region', { name: 'Items' });
    const c = within(items).getByTestId('text-change');
    expect(within(c).getByTestId('tc-del')).toHaveTextContent(/^compact character reference$/);
    expect(within(c).getByTestId('tc-ins')).toHaveTextContent(/^Character Core$/);
    // A change that is not words (a name) is shown as before.
    expect(within(items).getByText('A - Character Reference')).toBeInTheDocument();
  });
});

describe('the Review page', () => {
  it('a direct job’s card lists the words it changed, highlighted', async () => {
    const item = {
      jobId: 'job_direct1',
      projectId: 'lkp_baisheng',
      createdAt: Date.now() - 60_000,
      finishedAt: Date.now() - 59_000,
      status: 'succeeded',
      agent: { principalId: 'pat_claude', name: 'Claude Code (PAT)', profile: 'claude-code' },
      tool: 'arkona_add_character_art',
      summary: 'arkona_add_character_art: extend Tomo Reed (Working)',
      pages: [{ id: 'akaricor', name: change.page }],
      textChanges: [change],
      reviewed: null,
      revert: null,
    };
    installApi({
      ...baseRoutes(),
      'GET /review': {
        items: [item],
        facets: { profiles: ['claude-code'], tools: ['arkona_add_character_art'] },
        counts: { unreviewed: 1, matching: 1 },
      },
      'GET /review/counts': { unreviewed: 1, byProject: { baisheng: 1 } },
    });
    renderApp('/ui/review');
    const words = await screen.findByRole('group', { name: 'Words this job changed' });
    expect(within(words).getByTestId('tc-del')).toHaveTextContent(/^compact character reference$/);
    expect(within(words).getByTestId('tc-ins')).toHaveTextContent(/^Character Core$/);
    expect(words).toHaveTextContent(`After: “${AKARI_AFTER}”`);
  });
});
