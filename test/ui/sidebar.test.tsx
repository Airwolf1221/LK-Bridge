// @vitest-environment jsdom
/**
 * v3 F3c: the grouped sidebar. Three top links, then expandable groups sorted by name with their pages sorted by label;
 * the current page's group open; the owner's choices remembered per browser; closed groups summing their badges; and
 * every page the router serves reachable from the sidebar or from a parent page.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NAV, ROUTES, SUB_PAGES, TOP_NAV } from '../../ui/src/app';
import { Router } from '../../ui/src/router';
import { groupNav, NAV_STORAGE_KEY, Sidebar, type NavItem } from '../../ui/src/sidebar';
import { baseRoutes, installApi, navLink, renderApp, useDom } from './helpers';

useDom();

/** The owner's layout, as specified. */
const EXPECTED: [string, string[]][] = [
  ['Access & Account', ['Account', 'Clients & Access']],
  ['Assets', ['Asset Tree', 'Staging']],
  ['Backups & Recovery', ['Off-site copy', 'Snapshots']],
  ['Limits', ['Concurrent Writers', 'Request Budgets']],
  ['Monitoring', ['Errors', 'Journal', 'Tool calls']],
  ['Quality', ['Appraisal', 'Audits', 'Evaluation']],
  ['Repository', ['Archive and lifecycle', 'Chronology', 'Repository Tree']],
  ['Setup', ['Maintenance Jobs', 'Packs', 'Projects', 'Repository Mappings', 'Settings']],
];

const main = () => screen.getByRole('navigation', { name: 'Main' });
const group = (name: string) => within(main()).getByRole('button', { name: new RegExp(`^${name}`) });
const linkText = (a: HTMLElement) => a.querySelector('span')?.textContent ?? '';

/** The sidebar as rendered: top links, then each group's name and its links, in DOM order. */
function rendered() {
  const nav = main();
  const top = [...nav.querySelectorAll<HTMLElement>('.nav-top a')].map(linkText);
  const groups = [...nav.querySelectorAll<HTMLElement>('.nav-group')].map(
    (g) =>
      [
        g.querySelector('.nav-group-name')?.textContent ?? '',
        [...g.querySelectorAll<HTMLElement>('a')].map(linkText),
      ] as [string, string[]],
  );
  return { top, groups };
}

function renderSidebar(path: string, items: readonly NavItem[] = NAV, badges: Record<string, number> = {}) {
  window.history.replaceState({}, '', `/ui${path === '/' ? '' : path}`);
  return render(
    <Router>
      <Sidebar top={TOP_NAV} items={items} path={path} badges={badges} />
    </Router>,
  );
}

describe('the sidebar', () => {
  it('shows Overview, Jobs, Proposals and Review, then the groups and their pages in alphabetical order', async () => {
    installApi({ ...baseRoutes(), 'GET /review/counts': { unreviewed: 3, byProject: { test: 3 } } });
    renderApp('/ui/settings');
    await screen.findByRole('navigation', { name: 'Main' });
    const { top, groups } = rendered();
    expect(top).toEqual(['Overview', 'Jobs', 'Proposals', 'Review']);
    expect(groups).toEqual(EXPECTED);
    // Proposals keeps its pending count; v3 F3.4: Review counts the direct writes not reviewed yet.
    await waitFor(() =>
      expect(within(main()).getByRole('link', { name: /^Proposals/ })).toHaveTextContent('2'),
    );
    await waitFor(() => expect(within(main()).getByLabelText('3 unreviewed')).toBeInTheDocument());
  });

  it('sorts by code: a page added to a group lands in its place, and a new group in its own', () => {
    const items: NavItem[] = [
      ...NAV,
      { to: '/backlog', label: 'backlog', group: 'Setup' }, // lower case still sorts as a reader expects
      { to: '/zebra', label: 'Zebra', group: 'Monitoring' },
      { to: '/alpha', label: 'Alpha', group: 'Automation' },
    ];
    renderSidebar('/', items);
    const { groups } = rendered();
    expect(groups.map(([g]) => g)).toEqual([
      'Access & Account',
      'Assets',
      'Automation',
      'Backups & Recovery',
      'Limits',
      'Monitoring',
      'Quality',
      'Repository',
      'Setup',
    ]);
    expect(groups.find(([g]) => g === 'Setup')![1]).toEqual([
      'backlog',
      'Maintenance Jobs',
      'Packs',
      'Projects',
      'Repository Mappings',
      'Settings',
    ]);
    expect(groups.find(([g]) => g === 'Monitoring')![1]).toEqual([
      'Errors',
      'Journal',
      'Tool calls',
      'Zebra',
    ]);
    // The table itself is in any order: shuffling it changes nothing.
    expect(groupNav([...NAV].reverse())).toEqual(groupNav(NAV));
  });

  it('on a first visit, every group is closed except the current page’s', () => {
    renderSidebar('/snapshots');
    for (const [name] of EXPECTED)
      expect(group(name)).toHaveAttribute('aria-expanded', name === 'Backups & Recovery' ? 'true' : 'false');
    expect(within(main()).getByRole('link', { name: 'Snapshots' })).toHaveAttribute('aria-current', 'page');
    expect(within(main()).queryByRole('link', { name: 'Errors' })).toBeNull(); // closed groups hide their links
  });

  it.each([
    ['/chronology/2026-ties', 'Repository', 'Chronology'],
    ['/mappings/set_1', 'Setup', 'Repository Mappings'],
  ])('opens the current page’s group for a sub-path (%s)', (path, name, label) => {
    renderSidebar(path);
    expect(group(name)).toHaveAttribute('aria-expanded', 'true');
    expect(within(main()).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
  });

  it('marks a top page as current on a sub-path (/jobs/abc), with every group closed', async () => {
    installApi({ ...baseRoutes(), 'GET /jobs/abc': { status: 404, body: { error: { code: 'NOT_FOUND' } } } });
    renderApp('/ui/jobs/abc');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(within(main()).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    for (const [name] of EXPECTED) expect(group(name)).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a page’s group when the owner goes to it', async () => {
    const user = userEvent.setup();
    installApi({ ...baseRoutes() });
    renderApp('/ui');
    await screen.findByRole('navigation', { name: 'Main' });
    await user.click(await navLink(user, 'Errors'));
    expect(group('Monitoring')).toHaveAttribute('aria-expanded', 'true');
    expect(within(main()).getByRole('link', { name: 'Errors' })).toHaveAttribute('aria-current', 'page');
  });

  it('remembers the owner’s open and closed choices in this browser', async () => {
    const user = userEvent.setup();
    const first = renderSidebar('/snapshots');
    await user.click(group('Limits'));
    await user.click(group('Backups & Recovery')); // the current page's group can be closed too
    expect(JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY) ?? '{}')).toMatchObject({
      limits: true,
      'backups-recovery': false,
    });
    first.unmount();
    renderSidebar('/');
    expect(group('Limits')).toHaveAttribute('aria-expanded', 'true');
    expect(group('Backups & Recovery')).toHaveAttribute('aria-expanded', 'false');
    expect(group('Setup')).toHaveAttribute('aria-expanded', 'false');
  });

  it('works when localStorage throws: nothing is remembered, nothing breaks', async () => {
    const boom = () => {
      throw new Error('blocked');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    try {
      const user = userEvent.setup();
      renderSidebar('/audits');
      expect(group('Quality')).toHaveAttribute('aria-expanded', 'true');
      await user.click(group('Setup'));
      expect(group('Setup')).toHaveAttribute('aria-expanded', 'true');
      expect(within(main()).getByRole('link', { name: 'Packs' })).toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('ignores a stored value that is not a choice', () => {
    window.localStorage.setItem(NAV_STORAGE_KEY, '["not", "a", "map"]');
    renderSidebar('/');
    for (const [name] of EXPECTED) expect(group(name)).toHaveAttribute('aria-expanded', 'false');
  });

  it('a closed group shows the sum of its pages’ badges; open, the badge is on the pages', async () => {
    const user = userEvent.setup();
    renderSidebar('/', NAV, { '/errors': 3, '/journal': 2, '/proposals': 4 });
    const monitoring = group('Monitoring');
    expect(within(monitoring).getByLabelText('5 pending in Monitoring')).toHaveTextContent('5');
    expect(within(group('Setup')).queryByText(/\d/)).toBeNull();
    expect(within(main()).getByRole('link', { name: /^Proposals/ })).toHaveTextContent('4');
    await user.click(monitoring);
    expect(within(monitoring).queryByLabelText(/pending/)).toBeNull();
    expect(within(main()).getByRole('link', { name: /^Errors/ })).toHaveTextContent('3');
  });

  it('works by keyboard: Enter and Space toggle, aria-expanded and aria-controls follow, Tab goes in visual order', async () => {
    const user = userEvent.setup();
    renderSidebar('/');
    const access = group('Access & Account');
    expect(access.tagName).toBe('BUTTON');
    const listId = access.getAttribute('aria-controls')!;
    expect(document.getElementById(listId)).toHaveAttribute('hidden');

    // Tab order: the four top links, then the first group's button.
    within(main()).getByRole('link', { name: 'Overview' }).focus();
    await user.tab();
    expect(within(main()).getByRole('link', { name: 'Jobs' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(within(main()).getByRole('link', { name: 'Review' })).toHaveFocus();
    await user.tab();
    expect(access).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(access).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(listId)).not.toHaveAttribute('hidden');
    // Into the open group's pages, then on to the next group.
    await user.tab();
    expect(within(main()).getByRole('link', { name: 'Account' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(group('Assets')).toHaveFocus();

    access.focus();
    await user.keyboard(' ');
    expect(access).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(listId)).toHaveAttribute('hidden');
  });
});

describe('every page has a way in', () => {
  const navPaths = new Set([...TOP_NAV, ...NAV].map((n) => n.to));

  it('every route the router serves is in the sidebar, and every sidebar entry has a route', () => {
    for (const r of ROUTES) expect(navPaths, `route ${r.path} has no sidebar entry`).toContain(r.path);
    const routed = new Set(ROUTES.map((r) => r.path));
    for (const p of navPaths) expect(routed, `sidebar entry ${p} has no route`).toContain(p);
  });

  it('every page module is routed from the app or listed as a deliberate sub-page of a sidebar page', () => {
    const dir = join(process.cwd(), 'ui/src/pages');
    const app = readFileSync(join(process.cwd(), 'ui/src/app.tsx'), 'utf8');
    const imported = new Set([...app.matchAll(/from '\.\/pages\/([\w-]+)'/g)].map((m) => m[1]));
    const sub = new Set(SUB_PAGES.map((s) => s.module));
    const modules = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => f.replace(/\.tsx?$/, ''));
    for (const m of modules)
      expect(imported.has(m) || sub.has(m), `ui/src/pages/${m} is neither routed nor a listed sub-page`).toBe(
        true,
      );
    for (const s of SUB_PAGES) {
      expect(modules).toContain(s.module);
      expect(navPaths).toContain(s.parent);
    }
  });

  it('the Evaluation page has its own entry, under Quality, with the helper open', async () => {
    installApi({
      ...baseRoutes(),
      'GET /evaluation/scenarios': { preamble: '', sets: {}, scenarios: [] },
      'GET /evaluation/runs': { runs: [], recording: true, retentionDays: 7 },
    });
    renderApp('/ui/evaluation');
    expect(await screen.findByRole('heading', { level: 1, name: 'Evaluation' })).toBeInTheDocument();
    expect(group('Quality')).toHaveAttribute('aria-expanded', 'true');
    expect(within(main()).getByRole('link', { name: 'Evaluation' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Close the evaluation helper' })).toBeInTheDocument();
  });
});
