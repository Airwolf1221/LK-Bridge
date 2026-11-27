// @vitest-environment jsdom
/**
 * v3 F6d (ADR 0082) on the Templated Names page: the counts at the top, each source with its proposed name, Subject,
 * Reference Type and status with the reason (a collision naming the other page); the status and category filters go to
 * the server; "Keep this name" sends the reason; a kept row offers Undo; no other decision is offered.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const row = (o: Record<string, unknown>) => ({
  rawName: '[BSRC] x',
  displayName: 'x',
  category: 'Polity',
  subject: 'Falkenreich',
  referenceType: 'Polity Reference',
  role: 'Polity',
  proposed: null,
  reason: '',
  ruling: null,
  ...o,
});
const response = {
  project: { id: 'test', name: 'test' },
  statuses: [
    'rename',
    'held_collision',
    'held_no_subject',
    'held_type',
    'templated',
    'exempt_specialist',
    'kept',
  ],
  report: {
    state: 'ready',
    message: null,
    vocabulary: 'published',
    meta: {
      runId: 'aud_1',
      builtAt: 1,
      snapshotId: 'snap_1',
      takenAt: 1,
      excluded: { 'registered character': 4 },
    },
    counts: {
      rename: 1,
      held_collision: 1,
      held_no_subject: 0,
      held_type: 0,
      templated: 0,
      exempt_specialist: 0,
      kept: 1,
    },
    total: 3,
    categories: ['Culture', 'Polity'],
    check: true,
    rows: [
      row({
        pageId: 'falk',
        rawName: '[BSRC] Falkenreich Polity Reference',
        proposed: '[BSRC] Falkenreich - Polity',
        status: 'rename',
        reason: 'rename to “[BSRC] Falkenreich - Polity”',
      }),
      row({
        pageId: 'korr',
        rawName: '[BSRC] Korr Overview',
        subject: 'Korr',
        status: 'held_collision',
        reason: '[BSRC] Korr Polity Reference would be renamed to the same name',
        other: { id: 'korr2', name: '[BSRC] Korr Polity Reference' },
      }),
      row({
        pageId: 'shah',
        rawName: '[BSRC] Shahravi Overview',
        category: 'Culture',
        status: 'kept',
        reason: 'the owner’s ruling “Keep this name”',
        ruling: { reason: 'the owner prefers it', by: 'owner', at: 1 },
      }),
    ],
  },
  now: Date.now(),
};
const rowEl = async (id: string) =>
  waitFor(() => {
    const r = document.querySelector<HTMLElement>(`tr[data-row="${id}"]`);
    if (!r) throw new Error('not yet');
    return r;
  });

describe('the Templated Names page', () => {
  it('shows the counts, each row with its status and reason, and the filters go to the server', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /templated-names': response });
    const user = userEvent.setup();
    renderApp('/ui/templated-names');
    const falk = await rowEl('falk');
    expect(falk).toHaveTextContent('[BSRC] Falkenreich - Polity');
    expect(falk).toHaveTextContent('role word: Polity');
    expect(await rowEl('korr')).toHaveTextContent('with [BSRC] Korr Polity Reference');
    expect(document.querySelector('[data-counts]')).toHaveTextContent('to rename: 1');
    expect(document.querySelector('[data-counts]')).toHaveTextContent('registered character 4');
    // No "Accept": renames are the automation's.
    expect(within(falk).queryByRole('button', { name: 'Accept' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Status'), 'rename');
    await waitFor(() => expect(api.find('GET', '/templated-names').at(-1)!.query).toContain('status=rename'));
    await user.selectOptions(screen.getByLabelText('Primary category'), 'Culture');
    await waitFor(() =>
      expect(api.find('GET', '/templated-names').at(-1)!.query).toContain('category=Culture'),
    );
  });

  it('Keep this name sends the reason; a kept row offers Undo', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /templated-names': response,
      'POST /templated-names/keep': () => ({ ruling: {} }),
      'POST /templated-names/undo': () => ({ removed: true }),
    });
    const user = userEvent.setup();
    renderApp('/ui/templated-names');
    const falk = await rowEl('falk');
    await user.click(within(falk).getByRole('button', { name: 'Keep this name' }));
    await user.type(within(falk).getByLabelText('Why keep this name'), 'a known name');
    await user.click(within(falk).getByRole('button', { name: 'Keep' }));
    await waitFor(() =>
      expect(api.find('POST', '/templated-names/keep').at(-1)!.body).toEqual({
        pageId: 'falk',
        confirm: true,
        reason: 'a known name',
      }),
    );
    await user.click(within(await rowEl('shah')).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(api.find('POST', '/templated-names/undo').at(-1)!.body).toEqual({
        pageId: 'shah',
        confirm: true,
      }),
    );
  });
});
