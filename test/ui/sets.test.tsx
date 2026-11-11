// @vitest-environment jsdom
/**
 * C2d (ADR 0037) on the dashboard: a whole-set lifecycle proposal in full: the set summary (root, pages, states, where
 * the root goes, the estimate), every page with its own plan (indexes marked as having no Status), and the related pages
 * of each page (links inside the set left out); and the lifecycle settings' new index note text.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const op = {
  tool: 'archive_page',
  subtree: true,
  page: { id: 'k001root', name: '[INDEX] Kaito Ren' },
  pageParts: ['whole set of 3 pages'],
  lifecycle: {
    action: 'archive_page',
    subtree: true,
    set: {
      root: { id: 'k001root', name: '[INDEX] Kaito Ren', path: 'AI REPOSITORY / Locations / Kaito Ren' },
      pages: 3,
      contentPages: 2,
      indexes: 1,
      from: 'authoritative',
      to: 'archived',
      newParent: { id: 'archive1', name: '[INDEX] Archived' },
      layout: 'the set stays together: its root moves as a group, the structure beneath it is unchanged',
    },
    pages: [
      {
        id: 'k001root',
        name: '[INDEX] Kaito Ren',
        role: 'index',
        newName: '[INDEX] Kaito Ren',
        move: { under: { id: 'archive1', name: '[INDEX] Archived' } },
        facts: [],
        tags: { before: ['CANON'], after: ['Archived'] },
        note: {
          action: 'insert',
          blockId: 'b1',
          diff: '+ Archived - 2026-11-11. The author retired Kaito Ren and the pages beneath it. They are kept for provenance.',
        },
      },
      {
        id: 'k001core',
        name: '[BSRC] Kaito Ren - Character Core',
        role: 'page',
        from: 'authoritative',
        newName: '[BARC] Kaito Ren - Character Core',
        move: 'stays under its parent (moves with the set)',
        facts: [{ key: 'Status', before: 'Authoritative', after: 'Archived', change: 'changed' }],
        tags: { before: ['CANON'], after: ['Archived'] },
      },
    ],
    estimate: { pages: 3, reads: 40, writes: 19, wallClock: '12 s', fitsToday: true },
  },
  relatedPages: {
    pages: [
      {
        page: { id: 'k001core', name: '[BSRC] Kaito Ren - Character Core' },
        pages: [
          {
            id: 'guild001',
            name: '[BSRC] Harbour Guild',
            path: 'AI REPOSITORY / Locations / Harbour Guild',
            links: ['link collection “Dependencies”'],
          },
        ],
        textSearch: [],
      },
    ],
    freshness: 'link index as of 2026-11-11T01:15:00.000Z',
    excluded: 'links between pages of the set are left out',
  },
};

describe('a whole-set lifecycle proposal', () => {
  it('shows the set summary, every page’s own plan and the related pages per page', async () => {
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [] },
      'GET /proposals/prop_s': {
        proposal: {
          id: 'prop_s',
          principalId: 'pat_abc',
          principalLabel: 'Claude',
          profile: 'Scribe',
          title: 'archive_page',
          summary: 'archive_page (whole set, 3 pages): [INDEX] Kaito Ren → under [INDEX] Archived',
          state: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
          decidedAt: null,
          rejectReason: null,
          jobId: null,
          conflict: null,
          error: null,
          opCount: 19,
          requiresCanonicalApproval: true,
          canonicalApprovedBy: null,
          canonicalApprovedAt: null,
          pages: [],
          ops: [],
          operations: [op],
          pageSummary: [],
          canonical: { reason: 'archive_page changes the lifecycle state of a whole set', changes: [] },
        },
      },
    });
    renderApp('/ui/proposals?id=prop_s');
    const plan = await screen.findByRole('region', { name: 'Whole-set lifecycle change' });
    expect(plan).toHaveTextContent('of the whole set under [INDEX] Kaito Ren');
    expect(plan).toHaveTextContent('3 pages (2 content, 1 index), authoritative → archived');
    expect(plan).toHaveTextContent('about 40 reads and 19 writes, 12 s');
    const table = within(plan).getByRole('table', { name: 'Every page of the set' });
    expect(table).toHaveTextContent('[INDEX] Kaito Ren (index: no Status)');
    expect(table).toHaveTextContent('moves under [INDEX] Archived');
    expect(table).toHaveTextContent('[BARC] Kaito Ren - Character Core');
    expect(table).toHaveTextContent('stays under its parent');
    expect(table).toHaveTextContent('They are kept for provenance.');
    const rel = within(plan).getByRole('group', { name: 'Related pages' });
    expect(rel).toHaveTextContent('Harbour Guild — link collection “Dependencies”');
    expect(rel).toHaveTextContent('links inside the set left out');
  });
});
